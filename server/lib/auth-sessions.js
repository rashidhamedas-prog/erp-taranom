'use strict';

const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('./security');

const SECRET = getJwtSecret();
const ISSUER = 'erp-taranom';
const STAFF_AUDIENCE = 'erp-staff';
const PRE_2FA_AUDIENCE = 'erp-pre-2fa';
const B2B_AUDIENCE = 'erp-b2b';
const STAFF_TTL_SEC = 30 * 24 * 60 * 60;
const B2B_TTL_SEC = 7 * 24 * 60 * 60;
const CHALLENGE_TTL_SEC = 5 * 60;
const CLEANUP_INTERVAL_SEC = 6 * 60 * 60;
const REVOKED_RETENTION_SEC = 24 * 60 * 60;
const USED_CHALLENGE_RETENTION_SEC = 60 * 60;
const RATE_LIMIT_RETENTION_SEC = 2 * 24 * 60 * 60;

let store;
let lastCleanupAt = 0;

function currentCompanyId() {
  if (process.env.SYNC_ROLE === 'device') return 0;
  try {
    const company = require('./company-workspace').getActiveCompany();
    const id = Number(company && company.id);
    return Number.isSafeInteger(id) && id > 0 ? id : 1;
  } catch {
    return 1;
  }
}

function ensureStoreColumn(db, table, column, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name));
  if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function storePath() {
  if (process.env.AUTH_SESSION_DB_PATH) return path.resolve(process.env.AUTH_SESSION_DB_PATH);
  const businessDb = process.env.DB_PATH || path.join(__dirname, '..', 'crm.db');
  if (process.env.SYNC_ROLE === 'device') {
    // Multiple embedded instances may live beside each other in tests or on a
    // shared workstation. A device session registry must never rotate another
    // device's local web slot merely because both DB files share a directory.
    return path.resolve(businessDb) + '.auth-sessions.db';
  }
  return path.join(path.dirname(path.resolve(businessDb)), 'auth-sessions.db');
}

function getStore() {
  if (store && store.open) return store;
  store = new Database(storePath(), { timeout: 5000 });
  store.pragma('journal_mode = WAL');
  store.pragma('synchronous = FULL');
  store.exec(`
    CREATE TABLE IF NOT EXISTS staff_sessions (
      sid_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL DEFAULT 1,
      device_slot TEXT NOT NULL,
      fingerprint_hash TEXT NOT NULL,
      device_name TEXT,
      device_kind TEXT,
      auth_epoch INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_staff_sessions_user ON staff_sessions(user_id, revoked_at, expires_at);
    CREATE INDEX IF NOT EXISTS idx_staff_sessions_slot ON staff_sessions(user_id, device_slot, revoked_at);

    CREATE TABLE IF NOT EXISTS login_challenges (
      jti_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL DEFAULT 1,
      auth_epoch INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_login_challenge_user ON login_challenges(user_id, expires_at);

    CREATE TABLE IF NOT EXISTS b2b_sessions (
      sid_hash TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL DEFAULT 1,
      auth_epoch INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_b2b_sessions_account ON b2b_sessions(account_id, revoked_at, expires_at);

    CREATE TABLE IF NOT EXISTS auth_rate_limits (
      action TEXT NOT NULL,
      subject_hash TEXT NOT NULL,
      window_started INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      blocked_until INTEGER,
      PRIMARY KEY(action, subject_hash)
    );
  `);
  ensureStoreColumn(store, 'staff_sessions', 'company_id', 'INTEGER NOT NULL DEFAULT 1');
  ensureStoreColumn(store, 'login_challenges', 'company_id', 'INTEGER NOT NULL DEFAULT 1');
  ensureStoreColumn(store, 'b2b_sessions', 'company_id', 'INTEGER NOT NULL DEFAULT 1');
  cleanupRows(store, nowSec());
  lastCleanupAt = nowSec();
  return store;
}

function nowSec() { return Math.floor(Date.now() / 1000); }

function cleanupRows(db, now) {
  return db.transaction(() => {
    const staff = db.prepare(`
      DELETE FROM staff_sessions
      WHERE expires_at<=? OR (revoked_at IS NOT NULL AND revoked_at<=?)
    `).run(now, now - REVOKED_RETENTION_SEC).changes;
    const b2b = db.prepare(`
      DELETE FROM b2b_sessions
      WHERE expires_at<=? OR (revoked_at IS NOT NULL AND revoked_at<=?)
    `).run(now, now - REVOKED_RETENTION_SEC).changes;
    const challenges = db.prepare(`
      DELETE FROM login_challenges
      WHERE expires_at<=? OR (used_at IS NOT NULL AND used_at<=?)
    `).run(now, now - USED_CHALLENGE_RETENTION_SEC).changes;
    const rateLimits = db.prepare(`
      DELETE FROM auth_rate_limits
      WHERE window_started<=? AND COALESCE(blocked_until,0)<=?
    `).run(now - RATE_LIMIT_RETENTION_SEC, now).changes;
    return { staff, b2b, challenges, rateLimits };
  })();
}

function cleanupAuthSessionStore(options = {}) {
  const now = Number.isInteger(options.now) ? options.now : nowSec();
  if (!options.force && now - lastCleanupAt < CLEANUP_INTERVAL_SEC) {
    return { skipped: true, staff: 0, b2b: 0, challenges: 0, rateLimits: 0 };
  }
  const result = cleanupRows(getStore(), now);
  lastCleanupAt = now;
  return { skipped: false, ...result };
}

function maybeCleanup() {
  cleanupAuthSessionStore();
}

function randomOpaque() { return crypto.randomBytes(32).toString('base64url'); }
function opaqueHash(value) {
  return crypto.createHmac('sha256', SECRET).update(String(value || '')).digest('hex');
}
function fingerprintHash(value) { return opaqueHash('fingerprint:' + String(value || '')); }

function deviceSlotOf(kind) {
  const value = String(kind || 'web').toLowerCase();
  if (/android|ios|mobile/.test(value)) return 'mobile';
  if (/desktop|windows|electron|win/.test(value)) return 'desktop';
  return 'web';
}

function normalizeDeviceMeta(input = {}) {
  const kind = String(input.device_kind || 'web').slice(0, 32);
  const fingerprint = String(input.device_fingerprint || '').slice(0, 200);
  return {
    fingerprint: fingerprint || `anonymous-${deviceSlotOf(kind)}`,
    name: String(input.device_name || kind || 'web').slice(0, 120),
    kind,
    slot: deviceSlotOf(kind),
    force: !!input.force_logout_other,
  };
}

function activeStaffSession(userId, slot) {
  const now = nowSec();
  return getStore().prepare(`
    SELECT * FROM staff_sessions
    WHERE user_id=? AND company_id=? AND device_slot=? AND revoked_at IS NULL AND expires_at>?
    ORDER BY created_at DESC LIMIT 1
  `).get(Number(userId), currentCompanyId(), slot, now);
}

function assertStaffSlotAvailable(userId, meta) {
  const device = normalizeDeviceMeta(meta);
  const existing = activeStaffSession(userId, device.slot);
  if (existing && existing.fingerprint_hash !== fingerprintHash(device.fingerprint) && !device.force) {
    const error = new Error('DEVICE_SESSION_ACTIVE');
    error.code = 'DEVICE_SESSION_ACTIVE';
    error.existing = existing;
    error.device = device;
    throw error;
  }
  return device;
}

function mirrorStaffSession(db, sidHash, user, device, expiresAt) {
  try {
    // UNIQUE(user_id, device_slot) — must delete by that key, not company_id alone,
    // or a stale company_id (e.g. DEFAULT 1 vs device sentinel) leaves the row and INSERT 500s.
    db.prepare('DELETE FROM user_device_sessions WHERE user_id=? AND device_slot=?')
      .run(user.id, device.slot);
    db.prepare(`
      INSERT INTO user_device_sessions
        (user_id,device_slot,device_fingerprint,device_name,device_kind,last_seen,session_id,expires_at,auth_epoch,company_id,revoked_at)
      VALUES (?,?,?,?,?,strftime('%s','now'),?,?,?,?,NULL)
    `).run(user.id, device.slot, fingerprintHash(device.fingerprint), device.name, device.kind,
      sidHash, expiresAt, Number(user.auth_epoch || 0), currentCompanyId());
  } catch (error) {
    // A session that cannot be represented for admin revocation is unsafe.
    error.code = error.code || 'E_SESSION_MIRROR';
    throw error;
  }
}

function issueStaffSession(db, user, input = {}) {
  maybeCleanup();
  const device = assertStaffSlotAvailable(user.id, input);
  const now = nowSec();
  const expiresAt = now + STAFF_TTL_SEC;
  const sid = randomOpaque();
  const sidHash = opaqueHash(sid);
  const fph = fingerprintHash(device.fingerprint);
  const companyId = currentCompanyId();

  const tx = getStore().transaction(() => {
    getStore().prepare(`
      UPDATE staff_sessions SET revoked_at=?
      WHERE user_id=? AND company_id=? AND device_slot=? AND revoked_at IS NULL
    `).run(now, user.id, companyId, device.slot);
    getStore().prepare(`
      INSERT INTO staff_sessions
        (sid_hash,user_id,company_id,device_slot,fingerprint_hash,device_name,device_kind,auth_epoch,expires_at,created_at,last_seen)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(sidHash, user.id, companyId, device.slot, fph, device.name, device.kind,
      Number(user.auth_epoch || 0), expiresAt, now, now);
  });
  tx();
  try {
    mirrorStaffSession(db, sidHash, user, device, expiresAt);
  } catch (error) {
    getStore().prepare('UPDATE staff_sessions SET revoked_at=? WHERE sid_hash=?').run(now, sidHash);
    throw error;
  }

  const token = jwt.sign({
    id: user.id,
    username: user.username,
    role: user.role,
    name: user.name,
    phone: user.phone || '',
    ae: Number(user.auth_epoch || 0),
    cid: companyId,
    sid,
    dslot: device.slot,
  }, SECRET, { issuer: ISSUER, audience: STAFF_AUDIENCE, expiresIn: STAFF_TTL_SEC });
  return { token, device, expiresAt, sidHash };
}

function verifyStaffToken(token) {
  return jwt.verify(token, SECRET, { issuer: ISSUER, audience: STAFF_AUDIENCE });
}

function validateStaffSession(payload) {
  if (!payload || !payload.sid || !payload.id) return null;
  const now = nowSec();
  const companyId = currentCompanyId();
  const row = getStore().prepare(`
    SELECT * FROM staff_sessions
    WHERE sid_hash=? AND user_id=? AND company_id=? AND revoked_at IS NULL AND expires_at>?
  `).get(opaqueHash(payload.sid), Number(payload.id), companyId, now);
  if (!row || Number(payload.cid) !== companyId
      || Number(row.auth_epoch) !== Number(payload.ae || 0)) return null;
  if (now - Number(row.last_seen || 0) >= 60) {
    getStore().prepare('UPDATE staff_sessions SET last_seen=? WHERE sid_hash=?').run(now, row.sid_hash);
  }
  return row;
}

function revokeStaffSessionByHash(sidHash) {
  if (!sidHash) return 0;
  return getStore().prepare('UPDATE staff_sessions SET revoked_at=? WHERE sid_hash=? AND revoked_at IS NULL')
    .run(nowSec(), String(sidHash)).changes;
}

function revokeCurrentStaffSession(payload) {
  if (!payload || !payload.sid) return 0;
  return revokeStaffSessionByHash(opaqueHash(payload.sid));
}

function revokeAllStaffSessions(userId) {
  return getStore().prepare(`
    UPDATE staff_sessions SET revoked_at=?
    WHERE user_id=? AND company_id=? AND revoked_at IS NULL
  `).run(nowSec(), Number(userId), currentCompanyId()).changes;
}

function createLoginChallenge(user, input = {}) {
  maybeCleanup();
  const device = assertStaffSlotAvailable(user.id, input);
  const now = nowSec();
  const jti = randomOpaque();
  const companyId = currentCompanyId();
  getStore().prepare(`
    INSERT INTO login_challenges (jti_hash,user_id,company_id,auth_epoch,attempts,expires_at,created_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(opaqueHash(jti), user.id, companyId, Number(user.auth_epoch || 0), 0, now + CHALLENGE_TTL_SEC, now);
  const preToken = jwt.sign({
    id: user.id,
    scope: 'pre-2fa',
    ae: Number(user.auth_epoch || 0),
    cid: companyId,
    jti,
    dfp: device.fingerprint,
    dn: device.name,
    dk: device.kind,
    dslot: device.slot,
    force: device.force,
  }, SECRET, { issuer: ISSUER, audience: PRE_2FA_AUDIENCE, expiresIn: CHALLENGE_TTL_SEC });
  return { preToken, device };
}

function verifyLoginChallengeToken(token) {
  const payload = jwt.verify(token, SECRET, { issuer: ISSUER, audience: PRE_2FA_AUDIENCE });
  if (payload.scope !== 'pre-2fa' || !payload.jti) throw new Error('invalid login challenge');
  const companyId = currentCompanyId();
  const row = getStore().prepare(`
    SELECT * FROM login_challenges
    WHERE jti_hash=? AND user_id=? AND company_id=? AND used_at IS NULL AND expires_at>?
  `).get(opaqueHash(payload.jti), Number(payload.id), companyId, nowSec());
  if (!row || Number(payload.cid) !== companyId || row.attempts >= 5
      || Number(row.auth_epoch) !== Number(payload.ae || 0)) {
    throw new Error('invalid login challenge');
  }
  return { payload, row };
}

function failLoginChallenge(payload) {
  const now = nowSec();
  const companyId = currentCompanyId();
  if (Number(payload.cid) !== companyId) return 0;
  const result = getStore().prepare(`
    UPDATE login_challenges
    SET attempts=attempts+1,
        used_at=CASE WHEN attempts+1>=5 THEN ? ELSE used_at END
    WHERE jti_hash=? AND user_id=? AND company_id=? AND used_at IS NULL AND expires_at>?
  `).run(now, opaqueHash(payload.jti), Number(payload.id), companyId, now);
  return result.changes;
}

function consumeLoginChallenge(payload) {
  const now = nowSec();
  const companyId = currentCompanyId();
  if (Number(payload.cid) !== companyId) return false;
  return getStore().prepare(`
    UPDATE login_challenges SET used_at=?
    WHERE jti_hash=? AND user_id=? AND company_id=? AND used_at IS NULL AND expires_at>? AND attempts<5
  `).run(now, opaqueHash(payload.jti), Number(payload.id), companyId, now).changes === 1;
}

function challengeDevice(payload) {
  return normalizeDeviceMeta({
    device_fingerprint: payload.dfp,
    device_name: payload.dn,
    device_kind: payload.dk,
    force_logout_other: payload.force,
  });
}

function issueB2BSession(account) {
  maybeCleanup();
  const now = nowSec();
  const expiresAt = now + B2B_TTL_SEC;
  const sid = randomOpaque();
  const sidHash = opaqueHash(sid);
  const companyId = currentCompanyId();
  getStore().prepare(`
    INSERT INTO b2b_sessions
      (sid_hash,account_id,customer_id,company_id,auth_epoch,expires_at,created_at,last_seen)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(sidHash, account.id, account.customer_id, companyId, Number(account.auth_epoch || 0), expiresAt, now, now);
  return jwt.sign({
    id: account.customer_id,
    aid: account.id,
    scope: 'b2b',
    ae: Number(account.auth_epoch || 0),
    cid: companyId,
    sid,
  }, SECRET, { issuer: ISSUER, audience: B2B_AUDIENCE, expiresIn: B2B_TTL_SEC });
}

function verifyB2BToken(token) {
  return jwt.verify(token, SECRET, { issuer: ISSUER, audience: B2B_AUDIENCE });
}

function validateB2BSession(payload) {
  if (!payload || !payload.sid || !payload.aid) return null;
  const now = nowSec();
  const companyId = currentCompanyId();
  const row = getStore().prepare(`
    SELECT * FROM b2b_sessions
    WHERE sid_hash=? AND account_id=? AND customer_id=? AND company_id=?
      AND revoked_at IS NULL AND expires_at>?
  `).get(opaqueHash(payload.sid), Number(payload.aid), Number(payload.id), companyId, now);
  if (!row || Number(payload.cid) !== companyId
      || Number(row.auth_epoch) !== Number(payload.ae || 0)) return null;
  if (now - Number(row.last_seen || 0) >= 60) {
    getStore().prepare('UPDATE b2b_sessions SET last_seen=? WHERE sid_hash=?').run(now, row.sid_hash);
  }
  return row;
}

function revokeAllB2BSessions(accountId) {
  return getStore().prepare(`
    UPDATE b2b_sessions SET revoked_at=?
    WHERE account_id=? AND company_id=? AND revoked_at IS NULL
  `).run(nowSec(), Number(accountId), currentCompanyId()).changes;
}

function revokeCurrentB2BSession(payload) {
  if (!payload || !payload.sid || !payload.aid) return 0;
  const companyId = currentCompanyId();
  if (payload.cid != null && Number(payload.cid) !== companyId) return 0;
  return getStore().prepare(`
    UPDATE b2b_sessions SET revoked_at=?
    WHERE sid_hash=? AND account_id=? AND company_id=? AND revoked_at IS NULL
  `).run(nowSec(), opaqueHash(payload.sid), Number(payload.aid), companyId).changes;
}

function revokeAllAuthSessions() {
  const now = nowSec();
  return getStore().transaction(() => {
    const staff = getStore().prepare('UPDATE staff_sessions SET revoked_at=? WHERE revoked_at IS NULL').run(now).changes;
    const b2b = getStore().prepare('UPDATE b2b_sessions SET revoked_at=? WHERE revoked_at IS NULL').run(now).changes;
    const challenges = getStore().prepare('DELETE FROM login_challenges').run().changes;
    return { staff, b2b, challenges };
  })();
}

function consumeRateLimit(action, subject, options = {}) {
  maybeCleanup();
  const max = Math.max(1, Number(options.max || 5));
  const windowSec = Math.max(1, Number(options.windowSec || 900));
  const blockSec = Math.max(windowSec, Number(options.blockSec || windowSec));
  const now = nowSec();
  const subjectHash = opaqueHash(`rate:${action}:${String(subject || '')}`);
  return getStore().transaction(() => {
    const row = getStore().prepare(
      'SELECT * FROM auth_rate_limits WHERE action=? AND subject_hash=?'
    ).get(String(action), subjectHash);
    if (row && Number(row.blocked_until || 0) > now) {
      return { allowed: false, retryAfter: Number(row.blocked_until) - now, attempts: Number(row.attempts || 0) };
    }
    if (!row || now - Number(row.window_started || 0) >= windowSec) {
      getStore().prepare(`
        INSERT INTO auth_rate_limits (action,subject_hash,window_started,attempts,blocked_until)
        VALUES (?,?,?,1,NULL)
        ON CONFLICT(action,subject_hash) DO UPDATE SET
          window_started=excluded.window_started,attempts=1,blocked_until=NULL
      `).run(String(action), subjectHash, now);
      return { allowed: true, retryAfter: 0, attempts: 1 };
    }
    const attempts = Number(row.attempts || 0) + 1;
    const blockedUntil = attempts > max ? now + blockSec : null;
    getStore().prepare(`
      UPDATE auth_rate_limits SET attempts=?, blocked_until=?
      WHERE action=? AND subject_hash=?
    `).run(attempts, blockedUntil, String(action), subjectHash);
    return {
      allowed: attempts <= max,
      retryAfter: blockedUntil ? blockSec : 0,
      attempts,
    };
  })();
}

function rateLimitStatus(action, subject) {
  const now = nowSec();
  const subjectHash = opaqueHash(`rate:${action}:${String(subject || '')}`);
  const row = getStore().prepare(
    'SELECT blocked_until FROM auth_rate_limits WHERE action=? AND subject_hash=?'
  ).get(String(action), subjectHash);
  const blockedUntil = Number(row && row.blocked_until || 0);
  return {
    allowed: blockedUntil <= now,
    retryAfter: blockedUntil > now ? blockedUntil - now : 0,
  };
}

function clearRateLimit(action, subject) {
  const subjectHash = opaqueHash(`rate:${action}:${String(subject || '')}`);
  return getStore().prepare('DELETE FROM auth_rate_limits WHERE action=? AND subject_hash=?')
    .run(String(action), subjectHash).changes;
}

function closeSessionStore() {
  if (store && store.open) store.close();
  store = null;
  lastCleanupAt = 0;
}

module.exports = {
  SECRET,
  ISSUER,
  STAFF_AUDIENCE,
  PRE_2FA_AUDIENCE,
  B2B_AUDIENCE,
  normalizeDeviceMeta,
  assertStaffSlotAvailable,
  issueStaffSession,
  verifyStaffToken,
  validateStaffSession,
  revokeStaffSessionByHash,
  revokeCurrentStaffSession,
  revokeAllStaffSessions,
  createLoginChallenge,
  verifyLoginChallengeToken,
  failLoginChallenge,
  consumeLoginChallenge,
  challengeDevice,
  issueB2BSession,
  verifyB2BToken,
  validateB2BSession,
  revokeAllB2BSessions,
  revokeCurrentB2BSession,
  revokeAllAuthSessions,
  consumeRateLimit,
  rateLimitStatus,
  clearRateLimit,
  cleanupAuthSessionStore,
  opaqueHash,
  currentCompanyId,
  closeSessionStore,
};
