// Device-side sync client (SYNC_ROLE=device only).
//
// Each sync cycle: probe central → PUSH pending outbox ops (in order) →
// clean up confirmed ops' local provisional rows → PULL incremental changes
// and apply them. Locally-created rows live in this device's reserved id
// range (see tables.js), so pulled central rows can never collide with rows
// whose ops haven't been confirmed yet.
const crypto = require('crypto');
const {
  createDeviceHeaders,
  generateReplaySigningKeyPair,
  signReplayEnvelope,
  sha256Buffer,
} = require('./device-auth');
const { selectClientRelayField } = require('./multipart-policy');
const fs = require('fs');
const path = require('path');
const { getDB, getDBPath, seedProvisionalSequences } = require('../db');
const { SYNCABLE_TABLES, FK_COLUMNS, isProvisionalId } = require('./tables');
const { pullMissingFiles, countMissingFiles, listMissingFiles } = require('./files');
const { readManifest, buildUpdateResponse } = require('../lib/app-update');
const { getSecret, setSecret } = require('./secure-kv');

const state = {
  online: false,
  syncing: false,
  lastSyncAt: null,
  lastError: null,
  // Bumps whenever a sync cycle changes local data (id remap, pulled rows,
  // pulled deletes). The frontend polls this and refreshes its on-screen
  // data/caches when it changes — otherwise a background sync would leave the
  // browser showing stale ids (delete → 404) or already-deleted rows.
  dataVersion: 0
};

/** Canonical production central (Iran). Legacy German IP must never be used. */
const CANONICAL_CENTRAL_URL = 'https://erptaranom.com';
/** Remote fallbacks — HTTPS only (P0-S1). Loopback HTTP remains allowed for local tests. */
const FALLBACK_CENTRAL_URLS = [
  'https://erptaranom.com',
];
const LEGACY_CENTRAL_HOSTS = [
  '45.90.98.99',
  'http://45.90.98.99',
  'http://45.90.98.99:3000',
  'https://45.90.98.99',
  'https://45.90.98.99:3000',
  // retired canonical (domain cutover to erptaranom.com): stored central_url is migrated
  'http://erp.poshaktaranom.com',
  'https://erp.poshaktaranom.com'
];

let initialSyncPromise = null;

function kvGet(db, key) {
  const r = db.prepare('SELECT value FROM sync_local_kv WHERE key=?').get(key);
  return r ? r.value : null;
}
function kvSet(db, key, value) {
  db.prepare('INSERT INTO sync_local_kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
}
function kvDel(db, key) {
  db.prepare('DELETE FROM sync_local_kv WHERE key=?').run(key);
}

function normalizeCentralUrl(url) {
  if (!url || typeof url !== 'string') return '';
  let u = url.trim().replace(/\/$/, '');
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/$/, '');
}

function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

/** Reject remote HTTP; allow loopback HTTP for device/local harnesses. */
function assertCentralUrlAllowed(url) {
  const u = normalizeCentralUrl(url);
  if (!u) return '';
  let parsed;
  try { parsed = new URL(u); } catch {
    throw Object.assign(new Error('آدرس سرور مرکزی نامعتبر است'), { code: 'E_SYNC_BAD_URL' });
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    throw Object.assign(
      new Error('اتصال ریموت فقط با HTTPS مجاز است — HTTP برای سرور غیرمحلی پذیرفته نمی‌شود'),
      { code: 'E_SYNC_HTTPS_REQUIRED' }
    );
  }
  return u;
}

/** Upgrade stored remote http://… → https://… (idempotent). */
function upgradeHttpCentralUrl(url) {
  const u = normalizeCentralUrl(url);
  if (!u) return u;
  try {
    const parsed = new URL(u);
    if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
      parsed.protocol = 'https:';
      return parsed.toString().replace(/\/$/, '');
    }
  } catch { /* keep */ }
  return u;
}

function isLegacyCentralUrl(url) {
  if (!url) return false;
  const u = normalizeCentralUrl(url).toLowerCase();
  return LEGACY_CENTRAL_HOSTS.some(h => u === h || u.startsWith(h + '/') || u.includes('://45.90.98.99'));
}

/** Rewrite stored German/legacy central URL → Iran canonical. Idempotent. */
function migrateLegacyCentralUrl(db) {
  const cur = kvGet(db, 'central_url');
  if (!cur) return false;
  if (isLegacyCentralUrl(cur)) {
    kvSet(db, 'central_url', CANONICAL_CENTRAL_URL);
    state.lastError = null;
    console.warn(`[sync] migrated legacy central_url ${cur} → ${CANONICAL_CENTRAL_URL}`);
    return true;
  }
  const upgraded = upgradeHttpCentralUrl(cur);
  if (upgraded && upgraded !== cur) {
    try {
      assertCentralUrlAllowed(upgraded);
      kvSet(db, 'central_url', upgraded);
      console.warn(`[sync] upgraded central_url ${cur} → ${upgraded}`);
      return true;
    } catch (e) {
      console.warn(`[sync] cannot upgrade insecure central_url ${cur}:`, e.message);
      kvSet(db, 'central_url', CANONICAL_CENTRAL_URL);
      return true;
    }
  }
  return false;
}

function getConfig(db) {
  migrateLegacyCentralUrl(db);
  return {
    centralUrl: kvGet(db, 'central_url'),
    deviceId: parseInt(kvGet(db, 'device_id')) || null,
    deviceToken: getSecret(db, 'device_token'),
    lastPullSeq: parseInt(kvGet(db, 'last_pull_seq'))
  };
}

function isPaired(db) {
  const c = getConfig(db);
  return !!(c.centralUrl && c.deviceId && c.deviceToken);
}

function deviceHeaders(cfg) {
  return { ...createDeviceHeaders(cfg), 'Content-Type': 'application/json' };
}

function maskSensitive(value) {
  return String(value || '')
    .replace(/(Device\s+\d+:)[a-f0-9]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|device_token)=)[^&\s]+/gi, '$1[REDACTED]');
}

function networkErrorMessage(err, context) {
  const msg = maskSensitive(err && err.message || err || '');
  const name = err && err.name;
  if (name === 'AbortError' || /aborted|timeout/i.test(msg)) {
    return `${context}: زمان انتظار تمام شد — اینترنت را بررسی کنید و دوباره تلاش کنید`;
  }
  if (/ENOTFOUND|getaddrinfo|DNS/i.test(msg)) {
    return `${context}: دامنه سرور پیدا نشد — DNS/اینترنت را بررسی کنید`;
  }
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|network/i.test(msg)) {
    return `${context}: ارتباط با سرور برقرار نشد`;
  }
  if (/certificate|SSL|TLS|UNABLE_TO_VERIFY/i.test(msg)) {
    console.error('[sync-security] TLS certificate validation failed');
    return `${context}: خطای گواهی SSL — فقط HTTPS معتبر است؛ از https://erptaranom.com استفاده کنید`;
  }
  return msg ? `${context}: ${msg}` : context;
}

async function fetchWithTimeout(url, options, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function probe(centralUrl) {
  try {
    const r = await fetchWithTimeout(
      centralUrl.replace(/\/$/, '') + '/api/system/time',
      {},
      8000
    );
    return r.ok;
  } catch { return false; }
}

/** Try preferred URL then HTTPS canonical fallbacks; return first reachable base. */
async function resolveReachableCentralUrl(preferred) {
  let base = normalizeCentralUrl(preferred) || CANONICAL_CENTRAL_URL;
  if (isLegacyCentralUrl(base)) base = CANONICAL_CENTRAL_URL;
  try { base = assertCentralUrlAllowed(upgradeHttpCentralUrl(base)); } catch { base = CANONICAL_CENTRAL_URL; }
  const candidates = [base];
  for (const u of FALLBACK_CENTRAL_URLS) {
    if (!candidates.includes(u)) candidates.push(u);
  }
  for (const u of candidates) {
    try {
      assertCentralUrlAllowed(u);
    } catch {
      continue; // skip remote HTTP candidates
    }
    if (await probe(u)) return u;
  }
  return null;
}

function countLocalUsers(db) {
  try { return db.prepare('SELECT COUNT(*) c FROM users WHERE active=1').get().c; }
  catch { return 0; }
}

/** Paired but unusable: no users, or credentials without a successful first pull. */
function pairingHealth(db) {
  if (!isPaired(db)) {
    return { broken: false, reason: null, users: countLocalUsers(db), initial_sync_done: false };
  }
  const users = countLocalUsers(db);
  let initialDone = kvGet(db, 'initial_sync_done') === '1';
  // Legacy pairings (before this flag): a non-negative pull cursor means first sync finished.
  // Skip while a pull is in flight — last_pull_seq advances page-by-page.
  if (!initialDone && !state.syncing && !initialSyncPromise) {
    const lastPull = parseInt(kvGet(db, 'last_pull_seq'));
    if (Number.isInteger(lastPull) && lastPull >= 0 && users > 0) {
      kvSet(db, 'initial_sync_done', '1');
      initialDone = true;
    }
  }
  if (users === 0) {
    return { broken: true, reason: 'no_users', users: 0, initial_sync_done: initialDone };
  }
  if (!initialDone && !state.syncing && !initialSyncPromise) {
    return { broken: true, reason: 'initial_sync_incomplete', users, initial_sync_done: false };
  }
  return { broken: false, reason: null, users, initial_sync_done: initialDone };
}

/**
 * After device credentials are saved: pull all rows, drop placeholder admin,
 * pull files.
 *
 * A failed first pull (network down, auth rejected, bootstrap error) is a
 * TRANSIENT condition: pairing credentials, every sync_outbox row and every
 * local business row stay untouched so the next sync cycle simply retries.
 * Wiping local state is only ever an explicit, authorized operator action
 * (prepareFactoryReset → commitFactoryReset) — never a side effect of failure.
 */
async function runInitialSyncAfterPair() {
  const db = getDB();
  if (!isPaired(db)) return { ok: false, error: 'دستگاه متصل نیست' };
  if (state.syncing) return { ok: false, error: 'همگام‌سازی در حال اجراست' };
  const cfg = getConfig(db);
  state.syncing = true;
  state.lastError = null;
  try {
    state.online = await probe(cfg.centralUrl);
    if (!state.online) {
      const reached = await resolveReachableCentralUrl(cfg.centralUrl);
      if (reached) {
        kvSet(db, 'central_url', reached);
        cfg.centralUrl = reached;
        state.online = true;
      } else {
        throw new Error('سرور مرکزی در دسترس نیست — اینترنت را بررسی کنید');
      }
    }
    const pulledUserIds = await pullAll(db, cfg);
    await pullMissingFiles(db, cfg).catch(e => console.error('initial file sync:', e.message));
    if (!pulledUserIds.size) {
      throw new Error('هیچ کاربری از سرور مرکزی دریافت نشد — نام کاربری/رمز مدیر را بررسی کنید یا دوباره وصل شوید');
    }
    const ids = [...pulledUserIds];
    db.prepare(`DELETE FROM users WHERE id NOT IN (${ids.map(() => '?').join(',')})`).run(...ids);
    kvSet(db, 'initial_sync_done', '1');
    state.lastSyncAt = Math.floor(Date.now() / 1000);
    state.lastError = null;
    state.dataVersion++;
    return { ok: true, users: pulledUserIds.size };
  } catch (e) {
    const msg = networkErrorMessage(e, 'همگام‌سازی اولیه ناموفق');
    state.lastError = msg;
    console.error('[sync] initial pull after pair failed — pairing and local work kept, will retry:', msg);
    // Never resetPairing() here: that would destroy unpushed outbox ops and
    // local rows because of a transient failure. Credentials stay so syncNow()
    // / the client loop can retry; the operator decides about any reset.
    return {
      ok: false,
      error: msg,
      retryable: true,
      rolled_back: false,
      pending: pendingCount(db),
    };
  } finally {
    state.syncing = false;
  }
}

function startInitialSyncAfterPair() {
  if (initialSyncPromise) return initialSyncPromise;
  initialSyncPromise = runInitialSyncAfterPair().finally(() => {
    initialSyncPromise = null;
  });
  return initialSyncPromise;
}

// ---- Pairing ----
/**
 * Pre-v509 builds seeded the system walk-in customer (+ its party) at boot on
 * devices too. It carries no business data; on an unpaired device it only
 * squats a low id that the initial pull must own. Any document on it = real data.
 */
function systemWalkinSeed(db) {
  let biz;
  try { biz = require('../lib/store-quick-sale').WALKIN_BIZ; } catch (_) { return null; }
  const c = db.prepare('SELECT id, party_id FROM customers WHERE biz=?').all(biz);
  if (c.length !== 1) return null;
  const used = (sql) => { try { return !!db.prepare(sql).get(c[0].id); } catch (_) { return false; } };
  if (used('SELECT 1 FROM invoices WHERE cust_id=? LIMIT 1')
    || used('SELECT 1 FROM customer_ledger WHERE customer_id=? LIMIT 1')
    || used('SELECT 1 FROM settlements WHERE customer_id=? LIMIT 1')) return null;
  return c[0];
}

function dropSystemWalkinSeed(db, seed) {
  db.transaction(() => {
    db.prepare('DELETE FROM customers WHERE id=?').run(seed.id);
    if (seed.party_id) {
      db.prepare("DELETE FROM parties WHERE id=? AND legacy_table='customers' AND legacy_id=?")
        .run(seed.party_id, seed.id);
    }
    db.prepare("DELETE FROM settings WHERE key='store_walkin_customer_id'").run();
  })();
}

async function pair(centralUrl, username, password, deviceName) {
  const db = getDB();
  if (isPaired(db)) {
    const health = pairingHealth(db);
    if (health.broken) {
      throw new Error('اتصال قبلی خراب است — از صفحه ورود «قطع اتصال و اتصال مجدد» را بزنید، سپس دوباره وصل کنید');
    }
    throw new Error('این دستگاه قبلاً متصل شده است — از پنل همگام‌سازی «قطع اتصال و اتصال مجدد» را بزنید');
  }
  let preferred;
  try {
    preferred = assertCentralUrlAllowed(upgradeHttpCentralUrl(centralUrl));
  } catch (e) {
    throw new Error(e.message || 'آدرس سرور مرکزی نامعتبر است');
  }
  if (!preferred) throw new Error('آدرس سرور مرکزی نامعتبر است');
  if (isLegacyCentralUrl(preferred)) {
    console.warn(`[sync] rejecting legacy central URL ${preferred}, using canonical`);
    preferred = CANONICAL_CENTRAL_URL;
  }

  // Pairing requires a fresh (empty) local database — pre-pairing business
  // rows would occupy the low id range and collide with pulled central rows.
  const walkinSeed = systemWalkinSeed(db);
  const custCount = db.prepare('SELECT COUNT(*) c FROM customers').get().c - (walkinSeed ? 1 : 0);
  const invCount = db.prepare('SELECT COUNT(*) c FROM invoices').get().c;
  if (custCount || invCount) {
    throw new Error('اتصال فقط روی پایگاه‌داده خالی امکان‌پذیر است — ابتدا «قطع اتصال و اتصال مجدد» را بزنید');
  }

  const base = await resolveReachableCentralUrl(preferred);
  if (!base) {
    throw new Error('سرور مرکزی در دسترس نیست — اینترنت موبایل/وای‌فای را روشن کنید و آدرس https://erptaranom.com را بررسی کنید');
  }

  // Transport tokens may be copied from logs or a compromised proxy. Replay
  // authority is therefore a separate device-held Ed25519 private key; the
  // central server receives only the public half during the authenticated
  // pairing ceremony.
  const signingKeys = generateReplaySigningKeyPair();
  let r;
  try {
    r = await fetchWithTimeout(base + '/api/sync/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password,
        device_name: deviceName,
        replay_public_key: signingKeys.publicKey,
      })
    }, 30000);
  } catch (e) {
    throw new Error(networkErrorMessage(e, 'اتصال به سرور مرکزی ناموفق بود'));
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || 'اتصال به سرور مرکزی ناموفق بود');
  if (!body.device_id || !body.device_token) {
    throw new Error('پاسخ نامعتبر از سرور مرکزی — دوباره تلاش کنید');
  }

  if (walkinSeed) dropSystemWalkinSeed(db, walkinSeed);
  kvSet(db, 'central_url', base);
  kvSet(db, 'device_id', body.device_id);
  setSecret(db, 'device_token', body.device_token);
  setSecret(db, 'device_signing_private_key', signingKeys.privateKey);
  kvSet(db, 'last_pull_seq', -1);
  seedProvisionalSequences(db, body.device_id);
  state.online = true;
  state.lastError = null;

  // Register quickly, then pull in the background so the WebView request
  // does not hang for minutes on a large central database.
  startInitialSyncAfterPair();

  return {
    ok: true,
    device_id: body.device_id,
    central_url: base,
    initial_sync: 'started',
    message: 'دستگاه ثبت شد — در حال دریافت اطلاعات از سرور مرکزی'
  };
}

/** Update central URL on an already-paired device (e.g. migrate host). */
async function setCentralUrl(centralUrl) {
  const db = getDB();
  if (!isPaired(db)) throw new Error('دستگاه هنوز متصل نشده است');
  let base = assertCentralUrlAllowed(upgradeHttpCentralUrl(centralUrl));
  if (!base) throw new Error('آدرس سرور مرکزی نامعتبر است');
  if (isLegacyCentralUrl(base)) base = CANONICAL_CENTRAL_URL;
  const online = await probe(base);
  if (!online) throw new Error('سرور مرکزی در این آدرس در دسترس نیست');
  kvSet(db, 'central_url', base);
  state.online = true;
  state.lastError = null;
  return { ok: true, central_url: base };
}

/**
 * Wipe local sync state + syncable business rows so the device can pair again.
 * Restores placeholder admin / admin123. Local-only ops that were never pushed
 * are lost — therefore this is ONLY reachable through the authorized two-step
 * reset (prepareFactoryReset → commitFactoryReset), which first writes a
 * verified recovery copy of the outbox. Never call it on failure paths.
 */
function resetPairing() {
  const db = getDB();
  const bcrypt = require('bcryptjs');
  db.pragma('foreign_keys = OFF');
  const wipe = db.transaction(() => {
    try { db.exec('DELETE FROM sync_outbox'); } catch { /* */ }
    // Children-first: reverse registry order reduces FK surprises when FK is later re-enabled.
    for (let i = SYNCABLE_TABLES.length - 1; i >= 0; i--) {
      const { name } = SYNCABLE_TABLES[i];
      try { db.exec(`DELETE FROM ${name}`); } catch (e) {
        console.warn(`[sync] resetPairing skip ${name}:`, e.message);
      }
    }
    for (const k of ['central_url', 'device_id', 'device_token', 'device_signing_private_key',
      'last_pull_seq', 'initial_sync_done']) kvDel(db, k);
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (name,username,password,role,must_change_password) VALUES (?,?,?,?,0)')
      .run('مدیر موقت', 'admin', hash, 'admin');
  });
  wipe();
  db.pragma('foreign_keys = ON');
  state.online = false;
  state.syncing = false;
  state.lastSyncAt = null;
  state.lastError = null;
  state.dataVersion++;
  return { ok: true, message: 'اتصال قطع شد — با admin / admin123 وارد شوید و دوباره به سرور مرکزی وصل کنید' };
}

// ---- Guarded factory reset (device-local recovery) ----
//
// Authorization model (fail closed; HTTP-side role/loopback checks live in
// routes/sync.js):
//   * per-install secret — DEVICE_RESET_SECRET env, else a random 32-byte file
//     created in the device data dir on first device boot. Never a constant.
//   * prepare  — verify secret, snapshot every sync_outbox row to a JSON file
//                plus sha256 sidecar, write a one-time challenge nonce file.
//   * commit   — verify secret + challenge nonce (read from that file) + the
//                backup id/sha/pending_count echoed by the caller; the backup
//                must still match the live pending rows byte-for-byte. Only
//                then resetPairing() runs.
//   * restore  — verify secret + backup sha, re-queue pending/conflict rows
//                byte-for-byte (re-signed with the current replay key when the
//                device is paired again).
// Static phrases (RESET / RESET-DEVICE) are never accepted as a credential.
const RESET_SECRET_FILE = 'device-reset.secret';
const RESET_CHALLENGE_FILE = 'device-reset-challenge.json';
const RECOVERY_DIR_NAME = 'sync-recovery';
const RESET_CHALLENGE_TTL_SEC = 15 * 60;
const STATIC_RESET_PHRASES = new Set(['RESET', 'RESET-DEVICE']);
const BACKUP_ID_RE = /^ob-\d{10,16}-[a-f0-9]{16}$/;
const OUTBOX_BACKUP_FORMAT = 'erp-taranom/outbox-backup/v1';
// Columns restored verbatim (id is re-minted so restored ops sort after any newer local ops).
const OUTBOX_RESTORE_COLUMNS = [
  'method', 'path', 'body_json', 'user_id', 'base_version', 'entity_table', 'entity_local_id',
  'captured_rows_json', 'has_file', 'file_path', 'status', 'central_result', 'reason', 'attempts',
  'created_at', 'resolved_at', 'replay_file_hash', 'replay_file_field',
];

function resetError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Constant-time string equality that does not leak the expected length. */
function constantTimeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a == null ? '' : a), 'utf8').digest();
  const right = crypto.createHash('sha256').update(String(b == null ? '' : b), 'utf8').digest();
  return crypto.timingSafeEqual(left, right) && String(a) === String(b);
}

/** Writable per-install data dir: DEVICE_DATA_DIR, else the folder holding the SQLite file. */
function deviceDataDir() {
  const fromEnv = process.env.DEVICE_DATA_DIR && String(process.env.DEVICE_DATA_DIR).trim();
  if (fromEnv) return path.resolve(fromEnv);
  getDB(); // resolves the live DB path on first use
  return path.dirname(path.resolve(getDBPath()));
}
function resetSecretPath() { return path.join(deviceDataDir(), RESET_SECRET_FILE); }
function resetChallengePath() { return path.join(deviceDataDir(), RESET_CHALLENGE_FILE); }
function recoveryDir() { return path.join(deviceDataDir(), RECOVERY_DIR_NAME); }

/**
 * Create the per-install reset secret on first device boot (no-op when
 * DEVICE_RESET_SECRET is set or the file already exists). Pairing never needs it.
 */
function ensureDeviceResetSecret() {
  if (process.env.DEVICE_RESET_SECRET && String(process.env.DEVICE_RESET_SECRET).trim()) {
    return { source: 'env', created: false };
  }
  const file = resetSecretPath();
  if (fs.existsSync(file)) return { source: 'file', created: false, path: file };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  return { source: 'file', created: true, path: file };
}

function readDeviceResetSecret() {
  const env = process.env.DEVICE_RESET_SECRET;
  if (env && String(env).trim()) return String(env).trim();
  try {
    const raw = fs.readFileSync(resetSecretPath(), 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * Verify a supplied reset secret. Fails closed when no secret exists, when the
 * value is empty, or when it is one of the legacy static phrases.
 */
function verifyDeviceResetSecret(supplied) {
  const expected = readDeviceResetSecret();
  if (!expected) return { ok: false, code: 'E_RESET_SECRET_MISSING' };
  const value = typeof supplied === 'string' ? supplied.trim() : '';
  if (!value || STATIC_RESET_PHRASES.has(value.toUpperCase())) return { ok: false, code: 'E_RESET_SECRET_INVALID' };
  return constantTimeEqual(value, expected) ? { ok: true } : { ok: false, code: 'E_RESET_SECRET_INVALID' };
}

function isStaticResetPhrase(value) {
  return typeof value === 'string' && STATIC_RESET_PHRASES.has(value.trim().toUpperCase());
}

function backupPaths(backupId) {
  return {
    file: path.join(recoveryDir(), `${backupId}.json`),
    meta: path.join(recoveryDir(), `${backupId}.meta.json`),
  };
}

/** Write the one-time challenge nonce file (loopback+device role enforced by the route). */
function writeResetChallenge(backupId) {
  const now = Math.floor(Date.now() / 1000);
  const challenge = {
    nonce: crypto.randomBytes(32).toString('hex'),
    backup_id: backupId || null,
    created_at: now,
    expires_at: now + RESET_CHALLENGE_TTL_SEC,
  };
  const file = resetChallengePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(challenge), { mode: 0o600 });
  // The nonce itself is deliberately NOT returned: the operator must read it from the device file system.
  return { ok: true, challenge_file: file, backup_id: challenge.backup_id, expires_at: challenge.expires_at };
}

function readResetChallenge() {
  try {
    const parsed = JSON.parse(fs.readFileSync(resetChallengePath(), 'utf8'));
    return parsed && typeof parsed.nonce === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function clearResetChallenge() {
  try { fs.unlinkSync(resetChallengePath()); } catch { /* already gone */ }
}

/**
 * Step 1: snapshot the outbox to a verifiable recovery copy. Nothing is wiped.
 * Returns pending_count / backup_id / backup_sha256 that commit must echo.
 */
function prepareFactoryReset() {
  const db = getDB();
  const cfg = getConfig(db);
  const rows = db.prepare('SELECT * FROM sync_outbox ORDER BY id').all();
  const pendingCount = rows.filter(r => r.status === 'pending').length;
  const backupId = `ob-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const payload = {
    format: OUTBOX_BACKUP_FORMAT,
    backup_id: backupId,
    created_at: createdAt,
    device_id: cfg.deviceId,
    central_url: cfg.centralUrl,
    pending_count: pendingCount,
    row_count: rows.length,
    rows,
  };
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const sha = sha256Hex(bytes);
  const { file, meta } = backupPaths(backupId);
  fs.mkdirSync(recoveryDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(meta, JSON.stringify({
    format: OUTBOX_BACKUP_FORMAT, backup_id: backupId, sha256: sha,
    pending_count: pendingCount, row_count: rows.length, bytes: bytes.length, created_at: createdAt,
  }), { mode: 0o600, flag: 'wx' });
  // Read back and verify before offering the copy as a recovery point.
  if (sha256Hex(fs.readFileSync(file)) !== sha) {
    throw resetError(500, 'E_RESET_BACKUP_VERIFY', 'نسخهٔ بازیابی صف همگام‌سازی روی دیسک تأیید نشد — بازنشانی انجام نشد');
  }
  const challenge = writeResetChallenge(backupId);
  return {
    ok: true,
    pending_count: pendingCount,
    row_count: rows.length,
    backup_id: backupId,
    backup_sha256: sha,
    backup_file: file,
    challenge_file: challenge.challenge_file,
    challenge_expires_at: challenge.expires_at,
    wiped: false,
  };
}

/** Load a backup and verify its bytes against the sidecar (and the caller's sha when given). */
function loadVerifiedBackup(backupId, suppliedSha, { requireSha = true } = {}) {
  const id = typeof backupId === 'string' ? backupId.trim() : '';
  if (!BACKUP_ID_RE.test(id)) throw resetError(400, 'E_RESET_BACKUP_ID', 'شناسهٔ نسخهٔ بازیابی نامعتبر است');
  const { file, meta } = backupPaths(id);
  if (!fs.existsSync(file) || !fs.existsSync(meta)) {
    throw resetError(404, 'E_RESET_BACKUP_MISSING', 'نسخهٔ بازیابی صف همگام‌سازی پیدا نشد — ابتدا prepare را اجرا کنید');
  }
  const bytes = fs.readFileSync(file);
  const actualSha = sha256Hex(bytes);
  let metaObj;
  try { metaObj = JSON.parse(fs.readFileSync(meta, 'utf8')); } catch { metaObj = null; }
  if (!metaObj || !constantTimeEqual(metaObj.sha256, actualSha)) {
    throw resetError(409, 'E_RESET_BACKUP_SHA', 'اثر انگشت (sha256) نسخهٔ بازیابی با فایل مطابقت ندارد');
  }
  const supplied = typeof suppliedSha === 'string' ? suppliedSha.trim().toLowerCase() : '';
  if (supplied || requireSha) {
    if (!/^[a-f0-9]{64}$/.test(supplied) || !constantTimeEqual(supplied, actualSha)) {
      throw resetError(409, 'E_RESET_BACKUP_SHA', 'اثر انگشت (sha256) ارسال‌شده با نسخهٔ بازیابی مطابقت ندارد');
    }
  }
  let payload;
  try { payload = JSON.parse(bytes.toString('utf8')); } catch { payload = null; }
  if (!payload || payload.format !== OUTBOX_BACKUP_FORMAT || payload.backup_id !== id || !Array.isArray(payload.rows)) {
    throw resetError(409, 'E_RESET_BACKUP_CORRUPT', 'محتوای نسخهٔ بازیابی نامعتبر است');
  }
  return { id, payload, sha256: actualSha, meta: metaObj, file };
}

function sameOutboxRow(a, b) {
  return OUTBOX_RESTORE_COLUMNS.every(col => {
    const x = a[col] === undefined ? null : a[col];
    const y = b[col] === undefined ? null : b[col];
    return x === y;
  }) && (a.replay_proof || null) === (b.replay_proof || null);
}

/**
 * Step 2: wipe ONLY when secret (checked by the route), challenge nonce, backup
 * id/sha and pending_count all verify and the backup still matches the live
 * pending outbox rows byte-for-byte.
 */
function commitFactoryReset({ backup_id, backup_sha256, pending_count, challenge_nonce } = {}) {
  const db = getDB();
  const now = Math.floor(Date.now() / 1000);
  const challenge = readResetChallenge();
  if (!challenge) {
    throw resetError(403, 'E_RESET_CHALLENGE_MISSING', 'فایل چالش بازنشانی وجود ندارد — ابتدا prepare (یا challenge) را روی همین دستگاه اجرا کنید');
  }
  if (!Number.isFinite(Number(challenge.expires_at)) || Number(challenge.expires_at) < now) {
    clearResetChallenge();
    throw resetError(403, 'E_RESET_CHALLENGE_EXPIRED', 'چالش بازنشانی منقضی شده است — prepare را دوباره اجرا کنید');
  }
  const nonce = typeof challenge_nonce === 'string' ? challenge_nonce.trim().toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/.test(nonce) || !constantTimeEqual(nonce, challenge.nonce)) {
    throw resetError(403, 'E_RESET_CHALLENGE_NONCE', 'nonce چالش بازنشانی نامعتبر است — مقدار را از فایل چالش روی دستگاه بخوانید');
  }
  const backup = loadVerifiedBackup(backup_id, backup_sha256, { requireSha: true });
  if (challenge.backup_id && challenge.backup_id !== backup.id) {
    throw resetError(409, 'E_RESET_CHALLENGE_BACKUP', 'چالش بازنشانی برای نسخهٔ بازیابی دیگری صادر شده است');
  }
  const echoed = Number(pending_count);
  const livePending = db.prepare("SELECT * FROM sync_outbox WHERE status='pending' ORDER BY id").all();
  if (!Number.isInteger(echoed) || echoed !== Number(backup.payload.pending_count) || echoed !== livePending.length) {
    throw resetError(409, 'E_RESET_PENDING_MISMATCH',
      `تعداد عملیات در انتظار تغییر کرده است (نسخهٔ بازیابی: ${backup.payload.pending_count}، اکنون: ${livePending.length}) — prepare را دوباره اجرا کنید`);
  }
  // Every live pending row must be present, byte-for-byte, in the verified backup.
  const backedUp = new Map(backup.payload.rows.map(r => [r.id, r]));
  for (const row of livePending) {
    const copy = backedUp.get(row.id);
    if (!copy || !sameOutboxRow(copy, row)) {
      throw resetError(409, 'E_RESET_BACKUP_STALE', 'صف همگام‌سازی پس از prepare تغییر کرده است — prepare را دوباره اجرا کنید');
    }
  }
  const result = resetPairing();
  clearResetChallenge();
  return {
    ...result,
    wiped: true,
    backup_id: backup.id,
    backup_sha256: backup.sha256,
    backup_file: backup.file,
    pending_backed_up: echoed,
  };
}

/**
 * Re-queue the pending/conflict rows of a verified backup. method/path/body_json
 * and entity fields are restored byte-for-byte; ids are re-minted and the
 * replay proof is re-signed with the current device key when one exists.
 */
function restoreOutboxBackup({ backup_id, backup_sha256 } = {}) {
  const db = getDB();
  const backup = loadVerifiedBackup(backup_id, backup_sha256, { requireSha: false });
  const cols = tableColumns(db, 'sync_outbox');
  const restoreCols = OUTBOX_RESTORE_COLUMNS.filter(c => cols.includes(c));
  const cfg = getConfig(db);
  let privateKey = null;
  try { privateKey = getSecret(db, 'device_signing_private_key'); } catch { privateKey = null; }
  const canSign = !!(privateKey && Number.isSafeInteger(Number(cfg.deviceId)) && Number(cfg.deviceId) > 0);
  const dupe = db.prepare(`SELECT id, replay_proof FROM sync_outbox
    WHERE status IN ('pending','conflict') AND method=? AND path=? AND body_json IS ? AND user_id IS ?
      AND entity_table IS ? AND entity_local_id IS ? LIMIT 1`);
  const insert = db.prepare(`INSERT INTO sync_outbox (${restoreCols.join(',')}) VALUES (${restoreCols.map(() => '?').join(',')})`);
  const setProof = db.prepare('UPDATE sync_outbox SET replay_proof=? WHERE id=?');
  const signRow = (row, seq) => {
    let body = {};
    try { body = JSON.parse(row.body_json || '{}'); } catch { body = {}; }
    return signReplayEnvelope(privateKey, {
      deviceId: Number(cfg.deviceId),
      seq,
      method: row.method,
      path: row.path,
      userId: Number(row.user_id),
      body,
      fileHash: row.replay_file_hash || '',
      fileField: row.replay_file_field || '',
    });
  };
  const summary = { restored: 0, skipped_existing: 0, skipped_settled: 0, signed: 0, signed_existing: 0, unsigned: 0, ids: [] };
  db.transaction(() => {
    for (const row of backup.payload.rows) {
      if (row.status !== 'pending' && row.status !== 'conflict') { summary.skipped_settled++; continue; }
      const existing = dupe.get(row.method, row.path, row.body_json ?? null, row.user_id ?? null,
        row.entity_table ?? null, row.entity_local_id ?? null);
      if (existing) {
        // Idempotent re-run: only (re)sign a copy restored earlier while unpaired.
        if (canSign && !existing.replay_proof) {
          setProof.run(signRow(row, Number(existing.id)), existing.id);
          summary.signed_existing++;
        }
        summary.skipped_existing++;
        continue;
      }
      const inserted = insert.run(...restoreCols.map(c => (row[c] === undefined ? null : row[c])));
      const newId = Number(inserted.lastInsertRowid);
      if (canSign) {
        setProof.run(signRow(row, newId), newId);
        summary.signed++;
      } else {
        setProof.run(null, newId);
        summary.unsigned++;
      }
      summary.restored++;
      summary.ids.push(newId);
    }
  })();
  if (summary.restored || summary.signed_existing) state.dataVersion++;
  return {
    ok: true,
    backup_id: backup.id,
    backup_sha256: backup.sha256,
    ...summary,
    note: canSign ? null : 'دستگاه هنوز متصل نیست؛ عملیات بدون امضا بازگردانی شد — پس از اتصال مجدد، restore را دوباره اجرا کنید تا امضا شوند',
  };
}

// ---- Sync cycle ----
async function syncNow() {
  const db = getDB();
  if (!isPaired(db)) return { ok: false, error: 'دستگاه هنوز به سرور مرکزی متصل نشده است' };
  if (state.syncing) return { ok: false, error: 'همگام‌سازی در حال اجراست' };
  const health = pairingHealth(db);
  if (!health.initial_sync_done) {
    if (!initialSyncPromise) startInitialSyncAfterPair();
    return { ok: false, error: 'همگام‌سازی اولیه هنوز تمام نشده است — لطفاً صبر کنید' };
  }
  const cfg = getConfig(db);

  state.syncing = true;
  try {
    state.online = await probe(cfg.centralUrl);
    if (!state.online) return { ok: false, error: 'سرور مرکزی در دسترس نیست' };

    const pushRes = await pushPending(db, cfg);
    await pullAll(db, cfg);
    const fileRes = await pullMissingFiles(db, cfg);
    if (fileRes.pulled > 0) state.dataVersion++;
    state.lastSyncAt = Math.floor(Date.now() / 1000);
    state.lastError = null;
    return {
      ok: true, ...pushRes, ...fileRes,
      pending: pendingCount(db), conflicts: conflictCount(db), pull_conflicts: pullConflictCount(db),
    };

  } catch (e) {
    state.lastError = e.message;
    return { ok: false, error: e.message };
  } finally {
    state.syncing = false;
  }
}

async function pushPending(db, cfg) {
  const reconciled = reconcileCaptureFailures(db, cfg);
  const ops = db.prepare("SELECT * FROM sync_outbox WHERE status='pending' ORDER BY id LIMIT 400").all();
  if (!ops.length) return { pushed: 0, confirmed: 0, reconciled };

  const unsigned = ops.find((op) => !op.replay_proof);
  if (unsigned) {
    const error = new Error('عملیات قدیمی فاقد امضای معتبر است؛ اتصال دستگاه باید دوباره برقرار شود');
    error.code = 'SYNC_REPAIR_REQUIRED';
    throw error;
  }
  const payload = ops.map(o => ({
    seq: o.id, method: o.method, path: o.path,
    body: JSON.parse(o.body_json || '{}'),
    user_id: o.user_id, base_version: o.base_version,
    entity_table: o.entity_table, entity_local_id: o.entity_local_id,
    replay_proof: o.replay_proof,
    file_hash: o.replay_file_hash || '',
    file_field: o.replay_file_field || '',
  }));

  const r = await fetch(cfg.centralUrl + '/api/sync/push', {
    method: 'POST', headers: deviceHeaders(cfg), body: JSON.stringify({ ops: payload })
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || 'خطا در ارسال عملیات به سرور مرکزی');

  let confirmed = 0;
  for (const result of (body.results || [])) {
    const op = ops.find(o => o.id === result.seq);
    if (!op) continue;
    db.prepare('UPDATE sync_outbox SET attempts=attempts+1 WHERE id=?').run(op.id);
    if (result.status === 'applied') {
      confirmOp(db, op, result.result || {});
      confirmed++;
      state.dataVersion++; // ids were remapped locally — UI must refresh
      if (op.has_file && op.file_path) await replayFile(cfg, op).catch(e => console.error('file relay:', e.message));
    } else if (result.status === 'conflict') {
      db.prepare("UPDATE sync_outbox SET status='conflict', reason=?, resolved_at=NULL WHERE id=?")
        .run(result.reason || 'تعارض', op.id);
    }
    // 'deferred' → stays pending, retried next cycle
  }
  return { pushed: ops.length, confirmed, reconciled };
}

function reconcileCaptureFailures(db, cfg) {
  let failures;
  try {
    failures = db.prepare("SELECT * FROM sync_capture_failures WHERE status='pending' ORDER BY id LIMIT 100").all();
  } catch {
    return 0; // pre-migration standalone database
  }
  if (!failures.length) return 0;
  const privateKey = getSecret(db, 'device_signing_private_key');
  if (!privateKey || !Number.isSafeInteger(Number(cfg.deviceId)) || Number(cfg.deviceId) <= 0) {
    const error = new Error('کلید ترمیم عملیات همگام‌سازی موجود نیست؛ دستگاه باید دوباره متصل شود');
    error.code = 'SYNC_REPAIR_REQUIRED';
    throw error;
  }

  let reconciled = 0;
  for (const failure of failures) {
    db.transaction(() => {
      const current = db.prepare("SELECT * FROM sync_capture_failures WHERE id=? AND status='pending'").get(failure.id);
      if (!current) return;
      const body = JSON.parse(current.body_json || '{}');
      const inserted = db.prepare(`INSERT INTO sync_outbox
        (method,path,body_json,user_id,base_version,entity_table,entity_local_id,
         captured_rows_json,has_file,file_path,replay_file_hash,replay_file_field)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        current.method, current.path, current.body_json || '{}', current.user_id,
        current.base_version, current.entity_table, current.entity_local_id,
        current.captured_rows_json || '{}', Number(current.has_file || 0), current.file_path,
        current.replay_file_hash, current.replay_file_field
      );
      const outboxId = Number(inserted.lastInsertRowid);
      const proof = signReplayEnvelope(privateKey, {
        deviceId: Number(cfg.deviceId),
        seq: outboxId,
        method: current.method,
        path: current.path,
        userId: Number(current.user_id),
        body,
        fileHash: current.replay_file_hash || '',
        fileField: current.replay_file_field || '',
      });
      db.prepare('UPDATE sync_outbox SET replay_proof=? WHERE id=?').run(proof, outboxId);
      db.prepare(`
        UPDATE sync_capture_failures
        SET status='reconciled',outbox_id=?,reconciled_at=strftime('%s','now')
        WHERE id=? AND status='pending'
      `).run(outboxId, current.id);
      reconciled += 1;
    })();
  }
  return reconciled;
}

// Central confirmed the op: delete the rows this op created locally (their
// authoritative versions arrive in the pull that follows), and re-point any
// pending rows that referenced the provisional id to the new central id.
function confirmOp(db, op, result) {
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      const captured = JSON.parse(op.captured_rows_json || '{}');
      for (const [tbl, ids] of Object.entries(captured)) {
        if (!SYNCABLE_TABLES.some(t => t.name === tbl) || !ids.length) continue;
        db.prepare(`DELETE FROM ${tbl} WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      }
      if (isProvisionalId(op.entity_local_id) && result && Number.isInteger(result.id)) {
        for (const [tbl, col] of FK_COLUMNS) {
          try { db.prepare(`UPDATE ${tbl} SET ${col}=? WHERE ${col}=?`).run(result.id, op.entity_local_id); }
          catch { /* column may not exist in older schemas */ }
        }
      }
      db.prepare("UPDATE sync_outbox SET status='confirmed', central_result=?, resolved_at=strftime('%s','now') WHERE id=?")
        .run(JSON.stringify(result || {}), op.id);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

// Relay a locally-stored uploaded file (product image / voucher attachment)
// to central after the owning entity is confirmed.
async function replayFile(cfg, op) {
  if (!fs.existsSync(op.file_path)) return;
  const buf = fs.readFileSync(op.file_path);
  const field = op.replay_file_field
    ? String(op.replay_file_field)
    : selectClientRelayField(op.path, op.method).field;
  if (!op.replay_proof
      || !op.replay_file_hash || sha256Buffer(buf) !== String(op.replay_file_hash).toLowerCase()) {
    const error = new Error('فایل یا امضای عملیات همگام‌سازی دستکاری شده است');
    error.code = 'SYNC_REPLAY_PROOF_INVALID';
    throw error;
  }
  const form = new FormData();
  form.append('path', op.path);
  form.append('method', op.method);
  form.append('user_id', String(op.user_id));
  form.append('field', field);
  form.append('seq', String(op.id));
  form.append('replay_proof', op.replay_proof);
  form.append('body_json', op.body_json || '{}');
  form.append('file', new Blob([buf]), `upload${path.extname(op.file_path).toLowerCase()}`);
  const response = await fetch(cfg.centralUrl + '/api/sync/replay-multipart', {
    method: 'POST',
    headers: createDeviceHeaders(cfg),
    body: form
  });
  if (!response.ok) {
    const out = await response.json().catch(() => ({}));
    const error = new Error(out.error || 'بازپخش فایل روی سرور مرکزی ناموفق بود');
    error.code = out.code || 'SYNC_FILE_REPLAY_FAILED';
    throw error;
  }
}

// ---- Pull ----
async function pullAll(db, cfg) {
  const pulledUserIds = new Set();
  let since = parseInt(kvGet(db, 'last_pull_seq'));
  if (!Number.isInteger(since)) since = -1;
  let more = true;
  let pages = 0;
  // One context per pull cycle: parent-reference checks are deferred until the
  // final page because sync_seq is stamped per write (an edited parent sorts
  // after its children and may arrive in a later page).
  const pullCtx = createPullContext();
  while (more) {
    pages += 1;
    if (pages > 5000) throw new Error('دریافت تغییرات از سرور بیش از حد طول کشید');
    let r;
    try {
      r = await fetchWithTimeout(
        `${cfg.centralUrl}/api/sync/pull?since=${since}&limit=2000`,
        { headers: deviceHeaders(cfg) },
        60000
      );
    } catch (e) {
      throw new Error(networkErrorMessage(e, 'خطا در دریافت تغییرات از سرور مرکزی'));
    }
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || 'خطا در دریافت تغییرات از سرور مرکزی');
    const changes = body.changes || [];
    more = !!body.has_more && changes.length > 0;
    applyChanges(db, changes, pulledUserIds, { final: !more, ctx: pullCtx });
    since = body.next_since;
    kvSet(db, 'last_pull_seq', since);
  }
  return pulledUserIds;
}

const columnCache = {};
function tableColumns(db, tbl) {
  if (!columnCache[tbl]) columnCache[tbl] = db.prepare(`PRAGMA table_info(${tbl})`).all().map(c => c.name);
  return columnCache[tbl];
}

// ---- Pull-side conflict protection (device-local; never synced) ----
//
// A pulled row (INSERT OR REPLACE) or tombstone must not silently overwrite or
// delete a local row that still carries an unpushed operation
// (sync_outbox.status='pending'). Both versions are retained in
// sync_pull_conflicts for explicit resolution; nothing is last-writer-wins.
//   policy 'keep_both'          — customers, CRM, invoice drafts, stock moves, BOM, …
//   policy 'reversal_required'  — journal_entries / journal_lines, and invoices
//                                 whose local OR remote version is posted/final.
const PULL_CONFLICT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sync_pull_conflicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tbl TEXT NOT NULL,
    row_key TEXT NOT NULL,
    remote_seq INTEGER,
    remote_kind TEXT NOT NULL,          -- replace | delete
    reason TEXT NOT NULL,               -- pending_local_op | child_pending_local_op
    policy TEXT NOT NULL,               -- keep_both | reversal_required
    local_json TEXT,                    -- snapshot of the local row when the remote change was held
    remote_json TEXT,                   -- remote row; NULL for a tombstone
    outbox_ids TEXT,                    -- JSON array of the protecting sync_outbox ids
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now')),
    resolved_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_sync_pull_conflicts_open ON sync_pull_conflicts(status, tbl, row_key);
`;
const REVERSAL_REQUIRED_TABLES = new Set(['journal_entries', 'journal_lines']);

function ensurePullConflictTable(db) {
  db.exec(PULL_CONFLICT_SCHEMA);
}

function createPullContext() {
  return { unverifiedRefs: [], held: 0 };
}

// Firm (official) invoice = type 'final'. NOTE: invoices.status is the R13
// void-lifecycle flag and defaults to 'posted' for proformas as well, so it
// must not be read as "posted/firm" — a proforma stays a draft (keep_both).
function isPostedInvoice(row) {
  if (!row || typeof row !== 'object') return false;
  return String(row.type == null ? '' : row.type).trim().toLowerCase() === 'final';
}

function pullConflictPolicy(tbl, localRow, remoteRow) {
  if (REVERSAL_REQUIRED_TABLES.has(tbl)) return 'reversal_required';
  if (tbl === 'invoices' && (isPostedInvoice(localRow) || isPostedInvoice(remoteRow))) return 'reversal_required';
  return 'keep_both';
}

/** Map: entity_table → Map(entity_local_id → [outbox ids]) for the given outbox statuses. */
function outboxIndex(db, statuses) {
  const index = new Map();
  const rows = db.prepare(`SELECT id, entity_table, entity_local_id FROM sync_outbox
    WHERE status IN (${statuses.map(() => '?').join(',')}) AND entity_table IS NOT NULL AND entity_local_id IS NOT NULL`)
    .all(...statuses);
  for (const r of rows) {
    let byId = index.get(r.entity_table);
    if (!byId) index.set(r.entity_table, byId = new Map());
    const key = Number(r.entity_local_id);
    let ids = byId.get(key);
    if (!ids) byId.set(key, ids = []);
    ids.push(r.id);
  }
  return index;
}

function outboxIdsFor(index, tbl, id) {
  const byId = index.get(tbl);
  if (!byId) return [];
  return byId.get(Number(id)) || [];
}

// Declared FK graph over syncable tables (PRAGMA foreign_key_list; composite FKs skipped).
let fkGraphCache = null;
function fkGraph(db) {
  if (fkGraphCache) return fkGraphCache;
  const syncable = new Set(SYNCABLE_TABLES.map(t => t.name));
  const parentsOf = new Map(); // child → [{ from, parentTbl, parentCol }]
  const childrenOf = new Map(); // parent → [{ child, from }]
  for (const t of SYNCABLE_TABLES) {
    let fks;
    try { fks = db.prepare(`PRAGMA foreign_key_list(${t.name})`).all(); } catch { continue; }
    const perFk = {};
    for (const f of fks) perFk[f.id] = (perFk[f.id] || 0) + 1;
    for (const f of fks) {
      if (perFk[f.id] > 1 || !syncable.has(f.table) || !f.from) continue;
      const parentCol = f.to || 'id';
      if (!parentsOf.has(t.name)) parentsOf.set(t.name, []);
      parentsOf.get(t.name).push({ from: f.from, parentTbl: f.table, parentCol });
      if (parentCol === 'id') {
        if (!childrenOf.has(f.table)) childrenOf.set(f.table, []);
        childrenOf.get(f.table).push({ child: t.name, from: f.from });
      }
    }
  }
  fkGraphCache = { parentsOf, childrenOf };
  return fkGraphCache;
}

function chunked(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Local child rows of parent `parentTbl`:`parentId` that still carry unsynced work (pending/conflict op). */
function protectedChildrenOf(db, parentTbl, parentId, workIndex) {
  const hits = [];
  for (const { child, from } of fkGraph(db).childrenOf.get(parentTbl) || []) {
    if (!workIndex.has(child) || !tableColumns(db, child).includes('id')) continue;
    const rows = db.prepare(`SELECT id FROM ${child} WHERE ${from}=?`).all(parentId);
    for (const r of rows) {
      const ids = outboxIdsFor(workIndex, child, r.id);
      if (ids.length) hits.push({ tbl: child, id: r.id, outbox_ids: ids });
    }
  }
  return hits;
}

function recordPullConflict(db, { tbl, rowKey, remoteSeq, remoteKind, reason, policy, localRow, remoteRow, outboxIds }) {
  const existing = db.prepare("SELECT id FROM sync_pull_conflicts WHERE tbl=? AND row_key=? AND status='open'")
    .get(tbl, String(rowKey));
  const localJson = localRow ? JSON.stringify(localRow) : null;
  const remoteJson = remoteRow ? JSON.stringify(remoteRow) : null;
  if (existing) {
    // Same hold replayed (or a newer remote version of the same row): refresh, never duplicate.
    db.prepare(`UPDATE sync_pull_conflicts
      SET remote_seq=?, remote_kind=?, reason=?, policy=?, local_json=?, remote_json=?, outbox_ids=?, updated_at=strftime('%s','now')
      WHERE id=?`).run(remoteSeq ?? null, remoteKind, reason, policy, localJson, remoteJson, JSON.stringify(outboxIds || []), existing.id);
    return existing.id;
  }
  const r = db.prepare(`INSERT INTO sync_pull_conflicts
    (tbl,row_key,remote_seq,remote_kind,reason,policy,local_json,remote_json,outbox_ids) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(tbl, String(rowKey), remoteSeq ?? null, remoteKind, reason, policy, localJson, remoteJson, JSON.stringify(outboxIds || []));
  return Number(r.lastInsertRowid);
}

/**
 * Referential integrity gate, run inside the apply transaction before commit.
 *  (1) a parent deleted in this transaction must not leave local children behind;
 *  (2) rows written in this pull must reference existing parents — verified on
 *      the final page of the cycle (earlier pages only register the refs).
 * SYNC_PULL_ORPHAN_CHECK=warn|off downgrades the gate (operator escape hatch).
 */
function verifyPullIntegrity(db, { written, deleted, ctx, isFinal }) {
  const mode = String(process.env.SYNC_PULL_ORPHAN_CHECK || 'strict').toLowerCase();
  if (mode === 'off') return;
  const graph = fkGraph(db);
  const problems = [];
  for (const [parentTbl, ids] of deleted) {
    for (const { child, from } of graph.childrenOf.get(parentTbl) || []) {
      for (const chunk of chunked([...ids], 300)) {
        const n = db.prepare(`SELECT COUNT(*) c FROM ${child} WHERE ${from} IN (${chunk.map(() => '?').join(',')})`).get(...chunk).c;
        if (n > 0) problems.push(`${child}.${from}→${parentTbl}: ${n} ردیف به والد حذف‌شده اشاره می‌کند`);
      }
    }
  }
  for (const [tbl, ids] of written) {
    for (const ref of graph.parentsOf.get(tbl) || []) ctx.unverifiedRefs.push({ tbl, ids: [...ids], ...ref });
  }
  if (isFinal) {
    for (const ref of ctx.unverifiedRefs) {
      for (const chunk of chunked(ref.ids, 300)) {
        const rows = db.prepare(`SELECT c.id AS id, c.${ref.from} AS parent_id FROM ${ref.tbl} c
          WHERE c.id IN (${chunk.map(() => '?').join(',')}) AND c.${ref.from} IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM ${ref.parentTbl} p WHERE p.${ref.parentCol} = c.${ref.from}) LIMIT 3`).all(...chunk);
        if (rows.length) {
          problems.push(`${ref.tbl}.${ref.from}→${ref.parentTbl}.${ref.parentCol}: ${rows.map(r => `${r.id}→${r.parent_id}`).join(', ')}`);
        }
      }
    }
    ctx.unverifiedRefs = [];
  }
  if (!problems.length) return;
  if (mode === 'warn') {
    console.warn('[sync] pull integrity warning (SYNC_PULL_ORPHAN_CHECK=warn):', problems.join('; '));
    return;
  }
  throw Object.assign(
    new Error('دریافت تغییرات متوقف شد — یکپارچگی ارجاع‌ها برقرار نیست: ' + problems.join('; ')),
    { code: 'E_SYNC_PULL_ORPHAN', problems }
  );
}

/**
 * Apply one page of pulled changes atomically. opts.final=false defers the
 * parent-reference check to a later page of the same cycle (opts.ctx).
 * Returns { applied, held }.
 */
function applyChanges(db, changes, pulledUserIds, opts = {}) {
  const stats = { applied: 0, held: 0 };
  if (!changes.length) return stats;
  ensurePullConflictTable(db);
  const ctx = opts.ctx || createPullContext();
  const isFinal = opts.final !== false;
  state.dataVersion++; // pulled rows/deletes changed local data — UI must refresh
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      const pendingIndex = outboxIndex(db, ['pending']);
      const workIndex = outboxIndex(db, ['pending', 'conflict']);
      const written = new Map(); // tbl → Set(id) written in this transaction
      const deleted = new Map(); // tbl → Set(id) deleted in this transaction (id-keyed tables)
      const track = (map, tbl, id) => {
        if (!map.has(tbl)) map.set(tbl, new Set());
        map.get(tbl).add(id);
      };
      const hold = (spec, rowKey, remoteKind, reason, localRow, remoteRow, outboxIds, seq) => {
        recordPullConflict(db, {
          tbl: spec.name, rowKey, remoteSeq: seq, remoteKind, reason,
          policy: pullConflictPolicy(spec.name, localRow, remoteRow),
          localRow, remoteRow, outboxIds,
        });
        stats.held++;
        ctx.held++;
      };

      for (const ch of changes) {
        const spec = SYNCABLE_TABLES.find(t => t.name === ch.tbl);
        if (!spec) continue;
        const isComposite = !!(spec.compositeKeys && spec.compositeKeys.length);
        const hasId = tableColumns(db, spec.name).includes('id');

        if (ch.del !== undefined) {
          if (isComposite) {
            const parts = String(ch.del).split(':');
            if (parts.length !== spec.compositeKeys.length) {
              console.warn(`sync tombstone key mismatch for ${spec.name}:`, ch.del);
              continue;
            }
            const wh = spec.compositeKeys.map(c => `${c}=?`).join(' AND ');
            const vals = parts.map(p => {
              const n = Number(p);
              return Number.isFinite(n) && String(n) === String(p).trim() ? n : p;
            });
            db.prepare(`DELETE FROM ${spec.name} WHERE ${wh}`).run(...vals);
            stats.applied++;
            continue;
          }
          const localRow = db.prepare(`SELECT * FROM ${spec.name} WHERE ${spec.upsertKey}=?`).get(ch.del);
          if (localRow && hasId) {
            const pendingIds = outboxIdsFor(pendingIndex, spec.name, localRow.id);
            if (pendingIds.length) {
              hold(spec, ch.del, 'delete', 'pending_local_op', localRow, null, pendingIds, ch.seq);
              continue;
            }
            // Deleting this parent would orphan local rows that still carry unsynced work.
            const children = protectedChildrenOf(db, spec.name, localRow.id, workIndex);
            if (children.length) {
              hold(spec, ch.del, 'delete', 'child_pending_local_op', localRow, null,
                children.flatMap(c => c.outbox_ids), ch.seq);
              continue;
            }
          }
          db.prepare(`DELETE FROM ${spec.name} WHERE ${spec.upsertKey}=?`).run(ch.del);
          stats.applied++;
          if (localRow && hasId && spec.upsertKey === 'id') track(deleted, spec.name, localRow.id);
          continue;
        }

        const row = ch.row;
        if (!row) continue;
        const cols = tableColumns(db, spec.name).filter(c => c in row);
        if (spec.upsertKey === 'id' || isComposite) {
          // Central has this user either way — a held row must survive the placeholder cleanup.
          if (spec.name === 'users' && pulledUserIds) pulledUserIds.add(row.id);
          if (spec.upsertKey === 'id') {
            const pendingIds = outboxIdsFor(pendingIndex, spec.name, row.id);
            if (pendingIds.length) {
              const localRow = db.prepare(`SELECT * FROM ${spec.name} WHERE id=?`).get(row.id);
              if (localRow) {
                hold(spec, row.id, 'replace', 'pending_local_op', localRow, row, pendingIds, ch.seq);
                continue;
              }
            }
          }
          db.prepare(`INSERT OR REPLACE INTO ${spec.name} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
            .run(...cols.map(c => row[c]));
          stats.applied++;
          if (spec.upsertKey === 'id') track(written, spec.name, row.id);
        } else {
          // Business-key tables (settings/chart_of_accounts): local ids differ
          // from central's, so match on the unique key and never touch id.
          const existing = db.prepare(`SELECT * FROM ${spec.name} WHERE ${spec.upsertKey}=?`).get(row[spec.upsertKey]);
          if (existing && hasId) {
            const pendingIds = outboxIdsFor(pendingIndex, spec.name, existing.id);
            if (pendingIds.length) {
              hold(spec, row[spec.upsertKey], 'replace', 'pending_local_op', existing, row, pendingIds, ch.seq);
              continue;
            }
          }
          const dataCols = cols.filter(c => c !== 'id');
          if (existing) {
            db.prepare(`UPDATE ${spec.name} SET ${dataCols.map(c => c + '=?').join(',')} WHERE id=?`)
              .run(...dataCols.map(c => row[c]), existing.id);
            if (hasId) track(written, spec.name, existing.id);
          } else {
            const ins = db.prepare(`INSERT INTO ${spec.name} (${dataCols.join(',')}) VALUES (${dataCols.map(() => '?').join(',')})`)
              .run(...dataCols.map(c => row[c]));
            if (hasId) track(written, spec.name, Number(ins.lastInsertRowid));
          }
          stats.applied++;
        }
      }

      // Integrity before commit: any orphan throws and rolls the page back.
      verifyPullIntegrity(db, { written, deleted, ctx, isFinal });
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return stats;
}

function listPullConflicts(db, { status = 'open', limit = 200 } = {}) {
  ensurePullConflictTable(db);
  const rows = status === 'all'
    ? db.prepare('SELECT * FROM sync_pull_conflicts ORDER BY id DESC LIMIT ?').all(limit)
    : db.prepare('SELECT * FROM sync_pull_conflicts WHERE status=? ORDER BY id DESC LIMIT ?').all(status, limit);
  const parse = s => { try { return s == null ? null : JSON.parse(s); } catch { return s; } };
  return rows.map(r => ({ ...r, local: parse(r.local_json), remote: parse(r.remote_json), outbox_ids: parse(r.outbox_ids) || [] }));
}

function pullConflictCount(db) {
  try {
    ensurePullConflictTable(db);
    return db.prepare("SELECT COUNT(*) c FROM sync_pull_conflicts WHERE status='open'").get().c;
  } catch {
    return 0;
  }
}

// ---- Conflict resolution ----
// Discarding a conflicted op undoes it locally:
//  - creates: run the matching local DELETE route logic via loopback (restores
//    stock and posts proper reversal entries) — capture-suppressed
//  - updates/deletes: restore the row to central's current state
async function discardConflict(outboxId, actingUser, internalReplayToken) {
  const db = getDB();
  const op = db.prepare("SELECT * FROM sync_outbox WHERE id=? AND status='conflict'").get(outboxId);
  if (!op) throw new Error('عملیات متعارض یافت نشد');
  const cfg = getConfig(db);

  if (op.method === 'POST' && isProvisionalId(op.entity_local_id)) {
    const jwt = require('jsonwebtoken');
    const { SECRET } = require('../middleware/auth');
    const token = jwt.sign(
      {
        id: actingUser.id,
        username: actingUser.username,
        role: actingUser.role,
        name: actingUser.name,
        phone: actingUser.phone || '',
        ae: Number(actingUser.ae || 0),
      },
      SECRET, { expiresIn: '5m' }
    );
    const port = process.env.PORT || 3000;
    const basePath = op.path.replace(/\?.*$/, '');
    const delPath = `${basePath}/${op.entity_local_id}`;
    const r = await fetch(`http://127.0.0.1:${port}${delPath}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-internal-replay': String(internalReplayToken || ''),
        'x-sync-suppress': '1',
      }
    });
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      throw new Error(b.error || 'حذف محلی رکورد متعارض ناموفق بود');
    }
    // The pull that accompanied the failed push may have already overwritten
    // affected product rows with central values — the local DELETE just
    // re-added this op's quantities on top of them. Re-fetch those rows from
    // central so local stock ends at the authoritative value.
    const body = JSON.parse(op.body_json || '{}');
    const productIds = Array.isArray(body.rows)
      ? [...new Set(body.rows.map(r2 => r2.product_id).filter(id => Number.isInteger(id) && !isProvisionalId(id)))]
      : [];
    if (productIds.length && (state.online || await probe(cfg.centralUrl))) {
      for (const pid of productIds) {
        const pr = await fetch(`${cfg.centralUrl}/api/sync/row?tbl=products&id=${pid}`, { headers: deviceHeaders(cfg) });
        const pb = await pr.json().catch(() => ({}));
        if (pr.ok && pb.row) applyChanges(db, [{ seq: 0, tbl: 'products', row: pb.row }], null);
      }
    }
  } else if ((op.method === 'PUT' || op.method === 'PATCH' || op.method === 'DELETE') && op.entity_table && op.entity_local_id) {
    if (state.online || await probe(cfg.centralUrl)) {
      const r = await fetch(`${cfg.centralUrl}/api/sync/row?tbl=${op.entity_table}&id=${op.entity_local_id}`, { headers: deviceHeaders(cfg) });
      const body = await r.json().catch(() => ({}));
      if (r.ok && body.row) {
        applyChanges(db, [{ seq: 0, tbl: op.entity_table, row: body.row }], null);
      } else if (r.ok && !body.row) {
        db.prepare(`DELETE FROM ${op.entity_table} WHERE id=?`).run(op.entity_local_id);
      }
    }
  }

  db.prepare("UPDATE sync_outbox SET status='discarded', resolved_at=strftime('%s','now') WHERE id=?").run(outboxId);
  return { ok: true };
}

function pendingCount(db) {
  return db.prepare("SELECT COUNT(*) c FROM sync_outbox WHERE status='pending'").get().c;
}
function conflictCount(db) {
  return db.prepare("SELECT COUNT(*) c FROM sync_outbox WHERE status='conflict'").get().c;
}

function getStatus() {
  const db = getDB();
  const cfg = getConfig(db);
  const health = pairingHealth(db);
  let filesMissing = 0;
  try { filesMissing = isPaired(db) ? countMissingFiles(db) : 0; } catch { /* */ }
  return {
    role: 'device',
    paired: isPaired(db),
    central_url: cfg.centralUrl,
    device_id: cfg.deviceId,
    online: state.online,
    // Online-First: when online, UI shows live/online; offline falls back to local DB + outbox
    connection_mode: state.syncing ? 'syncing' : (state.online ? 'online' : 'offline'),
    syncing: state.syncing,
    pending: pendingCount(db),
    conflicts: conflictCount(db),
    pull_conflicts: pullConflictCount(db),
    files_missing: filesMissing,
    last_sync_at: state.lastSyncAt,
    last_pull_seq: cfg.lastPullSeq,
    last_error: state.lastError,
    data_version: state.dataVersion,
    users_count: health.users,
    initial_sync_done: health.initial_sync_done,
    pairing_broken: health.broken,
    pairing_broken_reason: health.reason,
    initial_sync_running: !!initialSyncPromise || (state.syncing && !health.initial_sync_done)
  };
}

async function pullFilesNow() {
  const db = getDB();
  if (!isPaired(db)) return { ok: false, error: 'دستگاه هنوز به سرور مرکزی متصل نشده است' };
  const cfg = getConfig(db);
  if (!(state.online || await probe(cfg.centralUrl))) {
    return { ok: false, error: 'سرور مرکزی در دسترس نیست' };
  }
  const fileRes = await pullMissingFiles(db, cfg);
  if (fileRes.pulled > 0) state.dataVersion++;
  const missing = listMissingFiles(db);
  return {
    ok: true,
    ...fileRes,
    files_missing: missing.length,
    missing_files: missing
  };
}

function skipSyncFile(subdir, name) {
  const db = getDB();
  const { skipMissingFile } = require('./files');
  skipMissingFile(db, subdir, name);
  return { files_missing: countMissingFiles(db) };
}

// Background loop: sync shortly after boot, then every interval. Re-seeds the
// provisional id ranges at startup (defensive, idempotent).
let loopTimer = null;
function startClientLoop(intervalMs) {
  const db = getDB();
  migrateLegacyCentralUrl(db);
  // First device boot: mint the per-install reset secret (never required for pairing).
  try {
    const secret = ensureDeviceResetSecret();
    if (secret.created) console.log('[sync] device reset secret created at', secret.path);
  } catch (e) {
    console.warn('[sync] could not create device reset secret (reset stays locked):', e.message);
  }
  if (isPaired(db)) {
    const cfg = getConfig(db);
    seedProvisionalSequences(db, cfg.deviceId);
    const health = pairingHealth(db);
    // Resume interrupted first pull (app killed mid-pair) instead of leaving a dead pairing.
    if (!health.initial_sync_done || health.broken) {
      setTimeout(() => {
        startInitialSyncAfterPair().catch(e => console.error('resume initial sync:', e.message));
      }, 1500);
    }
  }
  const tick = () => { syncNow().catch(e => console.error('sync loop:', e.message)); };
  setTimeout(tick, 2000);
  // Online-First: tighter loop (10s) so reconnect + pending outbox flush quickly
  loopTimer = setInterval(tick, Math.min(intervalMs || 10000, 10000));
  return loopTimer;
}

async function fetchCentralAppUpdate(platform, current) {
  const db = getDB();
  const cfg = getConfig(db);
  if (!cfg.centralUrl) return null;
  try {
    const r = await fetch(
      `${cfg.centralUrl.replace(/\/$/, '')}/api/system/app-update?platform=${encodeURIComponent(platform)}&version=${encodeURIComponent(current)}`
    );
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function fetchCentralUpdateFeedUrl() {
  const db = getDB();
  const cfg = getConfig(db);
  if (!cfg.centralUrl) return null;
  try {
    const r = await fetch(`${cfg.centralUrl.replace(/\/$/, '')}/api/system/update-feed`);
    if (!r.ok) return null;
    const j = await r.json();
    return j.url || null;
  } catch {
    return null;
  }
}

function getUpdateFeedUrl() {
  return fetchCentralUpdateFeedUrl();
}

function getLocalAppUpdate(platform, current) {
  const manifest = readManifest();
  const base = getConfig(getDB()).centralUrl || '';
  return buildUpdateResponse(platform, current, manifest, base);
}

// Password changes on paired devices must go through central — local-only
// updates are overwritten on the next users-table pull (see capture blocklist).
async function changePasswordOnCentral(username, oldPass, newPass) {
  const db = getDB();
  if (!isPaired(db)) return { ok: false, notPaired: true };
  const cfg = getConfig(db);
  const base = cfg.centralUrl.replace(/\/$/, '');
  if (!(state.online || await probe(cfg.centralUrl))) {
    return { ok: false, offline: true };
  }
  const loginR = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: oldPass })
  });
  const loginData = await loginR.json().catch(() => ({}));
  if (!loginR.ok) {
    return { ok: false, error: loginData.error || 'رمز قدیمی اشتباه است' };
  }
  if (loginData.twofa_required) {
    return {
      ok: false,
      code: 'twofa_required',
      error: 'با احراز هویت دو مرحله‌ای فعال، تغییر رمز فقط از نسخه وب (سرور مرکزی) امکان‌پذیر است.'
    };
  }
  const changeR = await fetch(base + '/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + loginData.token },
    body: JSON.stringify({ oldPass, newPass })
  });
  const changeData = await changeR.json().catch(() => ({}));
  if (!changeR.ok) {
    return { ok: false, error: changeData.error || 'خطا در تغییر رمز روی سرور مرکزی' };
  }
  return { ok: true };
}

// ---- Synchronous online-only relay (v522) ----
// Forwards one request to central /api/sync/relay-now (signed, fresh nonce) and
// returns central's status + body. Never touches the outbox. Network failure or a
// missing pairing → { offline: true } so callers answer 503 E_ONLINE_REQUIRED.
async function relayNow({ method, path: reqPath, userId, body, timeoutMs = 60000 }) {
  const { buildRelayEnvelope } = require('./relay-now');
  const db = getDB();
  if (!isPaired(db)) return { ok: false, offline: true, reason: 'not_paired' };
  const cfg = getConfig(db);
  let privateKey = null;
  try { privateKey = getSecret(db, 'device_signing_private_key'); } catch { privateKey = null; }
  if (!privateKey) return { ok: false, offline: true, reason: 'no_signing_key' };
  if (!state.online) {
    try {
      const r = await fetchWithTimeout(cfg.centralUrl.replace(/\/$/, '') + '/api/system/time', {}, 3000);
      state.online = r.ok;
    } catch { state.online = false; }
    if (!state.online) return { ok: false, offline: true, reason: 'offline' };
  }
  const envelope = buildRelayEnvelope(privateKey, {
    deviceId: Number(cfg.deviceId), userId, method, path: reqPath, body: method === 'GET' ? {} : body,
  });
  const payload = JSON.stringify(envelope);
  for (let attempt = 0; attempt < 2; attempt++) {
    let r;
    try {
      r = await fetchWithTimeout(cfg.centralUrl + '/api/sync/relay-now', {
        method: 'POST', headers: deviceHeaders(cfg), body: payload,
      }, timeoutMs);
    } catch (e) {
      // Same signed envelope on retry: central returns the stored outcome instead of re-posting.
      if (attempt === 0 && method !== 'GET' && !(e && e.name === 'AbortError')) continue;
      state.online = false;
      return { ok: false, offline: true, reason: 'network', error: networkErrorMessage(e, 'رله به سرور مرکزی') };
    }
    const out = await r.json().catch(() => ({}));
    return { ok: true, status: r.status, body: out, relayResult: r.headers.get('x-relay-result') || null };
  }
  return { ok: false, offline: true, reason: 'network' };
}

/** Fire-and-forget pull after a relayed mutation so local read tables refresh. */
function syncSoon() {
  setTimeout(() => { syncNow().catch(() => {}); }, 0);
}

module.exports = {
  relayNow, syncSoon,
  pair, syncNow, pullFilesNow, skipSyncFile, discardConflict, getStatus, getConfig, startClientLoop, isPaired,
  setCentralUrl, resetPairing, migrateLegacyCentralUrl, normalizeCentralUrl, assertCentralUrlAllowed,
  upgradeHttpCentralUrl, CANONICAL_CENTRAL_URL,
  fetchCentralAppUpdate, getUpdateFeedUrl, fetchCentralUpdateFeedUrl, getLocalAppUpdate, pullMissingFiles,
  changePasswordOnCentral, pairingHealth, resolveReachableCentralUrl, startInitialSyncAfterPair
  , maskSensitive, networkErrorMessage, reconcileCaptureFailures,
  // guarded factory reset / outbox recovery
  ensureDeviceResetSecret, verifyDeviceResetSecret, isStaticResetPhrase, deviceDataDir,
  prepareFactoryReset, commitFactoryReset, restoreOutboxBackup, writeResetChallenge,
  // pull-side conflict protection
  applyChanges, createPullContext, listPullConflicts, pullConflictCount, pullConflictPolicy, pendingCount,
};
