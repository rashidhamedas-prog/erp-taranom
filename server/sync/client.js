// Device-side sync client (SYNC_ROLE=device only).
//
// Each sync cycle: probe central → PUSH pending outbox ops (in order) →
// clean up confirmed ops' local provisional rows → PULL incremental changes
// and apply them. Locally-created rows live in this device's reserved id
// range (see tables.js), so pulled central rows can never collide with rows
// whose ops haven't been confirmed yet.
const crypto = require('crypto');
const fs = require('fs');
const { getDB, seedProvisionalSequences } = require('../db');
const { SYNCABLE_TABLES, FK_COLUMNS, isProvisionalId } = require('./tables');
const { pullMissingFiles, countMissingFiles, listMissingFiles } = require('./files');
const { readManifest, buildUpdateResponse } = require('../lib/app-update');

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
const CANONICAL_CENTRAL_URL = 'https://erp.poshaktaranom.com';
const FALLBACK_CENTRAL_URLS = [
  'https://erp.poshaktaranom.com',
  'http://erp.poshaktaranom.com'
];
const LEGACY_CENTRAL_HOSTS = [
  '45.90.98.99',
  'http://45.90.98.99',
  'http://45.90.98.99:3000',
  'https://45.90.98.99',
  'https://45.90.98.99:3000'
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

function isLegacyCentralUrl(url) {
  if (!url) return false;
  const u = normalizeCentralUrl(url).toLowerCase();
  return LEGACY_CENTRAL_HOSTS.some(h => u === h || u.startsWith(h + '/') || u.includes('://45.90.98.99'));
}

/** Rewrite stored German/legacy central URL → Iran canonical. Idempotent. */
function migrateLegacyCentralUrl(db) {
  const cur = kvGet(db, 'central_url');
  if (!cur || !isLegacyCentralUrl(cur)) return false;
  kvSet(db, 'central_url', CANONICAL_CENTRAL_URL);
  state.lastError = null;
  console.warn(`[sync] migrated legacy central_url ${cur} → ${CANONICAL_CENTRAL_URL}`);
  return true;
}

function getConfig(db) {
  migrateLegacyCentralUrl(db);
  return {
    centralUrl: kvGet(db, 'central_url'),
    deviceId: parseInt(kvGet(db, 'device_id')) || null,
    deviceToken: kvGet(db, 'device_token'),
    lastPullSeq: parseInt(kvGet(db, 'last_pull_seq'))
  };
}

function isPaired(db) {
  const c = getConfig(db);
  return !!(c.centralUrl && c.deviceId && c.deviceToken);
}

function deviceHeaders(cfg) {
  return { 'Authorization': `Device ${cfg.deviceId}:${cfg.deviceToken}`, 'Content-Type': 'application/json' };
}

function networkErrorMessage(err, context) {
  const msg = String(err && err.message || err || '');
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
    return `${context}: خطای گواهی SSL — آدرس http://erp.poshaktaranom.com را امتحان کنید`;
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

/** Try preferred URL then https/http canonical fallbacks; return first reachable base. */
async function resolveReachableCentralUrl(preferred) {
  let base = normalizeCentralUrl(preferred) || CANONICAL_CENTRAL_URL;
  if (isLegacyCentralUrl(base)) base = CANONICAL_CENTRAL_URL;
  const candidates = [base];
  for (const u of FALLBACK_CENTRAL_URLS) {
    if (!candidates.includes(u)) candidates.push(u);
  }
  for (const u of candidates) {
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

function clearPairingKeys(db) {
  for (const k of ['central_url', 'device_id', 'device_token', 'last_pull_seq', 'initial_sync_done']) kvDel(db, k);
}

/**
 * After device credentials are saved: pull all rows, drop placeholder admin,
 * pull files. On hard failure wipe local pairing so the user can retry cleanly.
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
    console.error('[sync] initial pull after pair failed:', msg);
    try { resetPairing(); } catch (re) {
      console.error('[sync] rollback after failed initial pull:', re.message);
      clearPairingKeys(db);
    }
    return { ok: false, error: msg, rolled_back: true };
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
async function pair(centralUrl, username, password, deviceName) {
  const db = getDB();
  if (isPaired(db)) {
    const health = pairingHealth(db);
    if (health.broken) {
      throw new Error('اتصال قبلی خراب است — از صفحه ورود «قطع اتصال و اتصال مجدد» را بزنید، سپس دوباره وصل کنید');
    }
    throw new Error('این دستگاه قبلاً متصل شده است — از پنل همگام‌سازی «قطع اتصال و اتصال مجدد» را بزنید');
  }
  let preferred = normalizeCentralUrl(centralUrl);
  if (!preferred) throw new Error('آدرس سرور مرکزی نامعتبر است');
  if (isLegacyCentralUrl(preferred)) {
    console.warn(`[sync] rejecting legacy central URL ${preferred}, using canonical`);
    preferred = CANONICAL_CENTRAL_URL;
  }

  // Pairing requires a fresh (empty) local database — pre-pairing business
  // rows would occupy the low id range and collide with pulled central rows.
  const custCount = db.prepare('SELECT COUNT(*) c FROM customers').get().c;
  const invCount = db.prepare('SELECT COUNT(*) c FROM invoices').get().c;
  if (custCount || invCount) {
    throw new Error('اتصال فقط روی پایگاه‌داده خالی امکان‌پذیر است — ابتدا «قطع اتصال و اتصال مجدد» را بزنید');
  }

  const base = await resolveReachableCentralUrl(preferred);
  if (!base) {
    throw new Error('سرور مرکزی در دسترس نیست — اینترنت موبایل/وای‌فای را روشن کنید و آدرس https://erp.poshaktaranom.com را بررسی کنید');
  }

  let r;
  try {
    r = await fetchWithTimeout(base + '/api/sync/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, device_name: deviceName })
    }, 30000);
  } catch (e) {
    throw new Error(networkErrorMessage(e, 'اتصال به سرور مرکزی ناموفق بود'));
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || 'اتصال به سرور مرکزی ناموفق بود');
  if (!body.device_id || !body.device_token) {
    throw new Error('پاسخ نامعتبر از سرور مرکزی — دوباره تلاش کنید');
  }

  kvSet(db, 'central_url', base);
  kvSet(db, 'device_id', body.device_id);
  kvSet(db, 'device_token', body.device_token);
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
  let base = normalizeCentralUrl(centralUrl);
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
 * are lost — intended recovery for broken/wrong pairing.
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
    for (const k of ['central_url', 'device_id', 'device_token', 'last_pull_seq', 'initial_sync_done']) kvDel(db, k);
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
    return { ok: true, ...pushRes, ...fileRes, pending: pendingCount(db), conflicts: conflictCount(db) };

  } catch (e) {
    state.lastError = e.message;
    return { ok: false, error: e.message };
  } finally {
    state.syncing = false;
  }
}

async function pushPending(db, cfg) {
  const ops = db.prepare("SELECT * FROM sync_outbox WHERE status='pending' ORDER BY id LIMIT 200").all();
  if (!ops.length) return { pushed: 0, confirmed: 0 };

  const payload = ops.map(o => ({
    seq: o.id, method: o.method, path: o.path,
    body: JSON.parse(o.body_json || '{}'),
    user_id: o.user_id, base_version: o.base_version,
    entity_table: o.entity_table, entity_local_id: o.entity_local_id
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
  return { pushed: ops.length, confirmed };
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
  const body = JSON.parse(op.body_json || '{}');
  const field = op.path.includes('/attachment') ? 'file' : 'image';
  const form = new FormData();
  form.append('path', op.path);
  form.append('method', op.method);
  form.append('user_id', String(op.user_id));
  form.append('field', field);
  for (const [k, v] of Object.entries(body)) form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  form.append('file', new Blob([buf]), op.file_path.split('/').pop());
  await fetch(cfg.centralUrl + '/api/sync/replay-multipart', {
    method: 'POST',
    headers: { 'Authorization': `Device ${cfg.deviceId}:${cfg.deviceToken}` },
    body: form
  });
}

// ---- Pull ----
async function pullAll(db, cfg) {
  const pulledUserIds = new Set();
  let since = parseInt(kvGet(db, 'last_pull_seq'));
  if (!Number.isInteger(since)) since = -1;
  let more = true;
  let pages = 0;
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
    applyChanges(db, body.changes || [], pulledUserIds);
    since = body.next_since;
    kvSet(db, 'last_pull_seq', since);
    more = !!body.has_more && (body.changes || []).length > 0;
  }
  return pulledUserIds;
}

const columnCache = {};
function tableColumns(db, tbl) {
  if (!columnCache[tbl]) columnCache[tbl] = db.prepare(`PRAGMA table_info(${tbl})`).all().map(c => c.name);
  return columnCache[tbl];
}

function applyChanges(db, changes, pulledUserIds) {
  if (!changes.length) return;
  state.dataVersion++; // pulled rows/deletes changed local data — UI must refresh
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (const ch of changes) {
        const spec = SYNCABLE_TABLES.find(t => t.name === ch.tbl);
        if (!spec) continue;
        if (ch.del !== undefined) {
          if (spec.compositeKeys && spec.compositeKeys.length) {
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
          } else {
            db.prepare(`DELETE FROM ${spec.name} WHERE ${spec.upsertKey}=?`).run(ch.del);
          }
          continue;
        }
        const row = ch.row;
        if (!row) continue;
        if (spec.name === 'users' && pulledUserIds) pulledUserIds.add(row.id);
        const cols = tableColumns(db, spec.name).filter(c => c in row);
        if (spec.upsertKey === 'id' || (spec.compositeKeys && spec.compositeKeys.length)) {
          db.prepare(`INSERT OR REPLACE INTO ${spec.name} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
            .run(...cols.map(c => row[c]));
        } else {
          // Business-key tables (settings/chart_of_accounts): local ids differ
          // from central's, so match on the unique key and never touch id.
          const existing = db.prepare(`SELECT id FROM ${spec.name} WHERE ${spec.upsertKey}=?`).get(row[spec.upsertKey]);
          const dataCols = cols.filter(c => c !== 'id');
          if (existing) {
            db.prepare(`UPDATE ${spec.name} SET ${dataCols.map(c => c + '=?').join(',')} WHERE id=?`)
              .run(...dataCols.map(c => row[c]), existing.id);
          } else {
            db.prepare(`INSERT INTO ${spec.name} (${dataCols.join(',')}) VALUES (${dataCols.map(() => '?').join(',')})`)
              .run(...dataCols.map(c => row[c]));
          }
        }
      }
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

// ---- Conflict resolution ----
// Discarding a conflicted op undoes it locally:
//  - creates: run the matching local DELETE route logic via loopback (restores
//    stock and posts proper reversal entries) — capture-suppressed
//  - updates/deletes: restore the row to central's current state
async function discardConflict(outboxId, actingUser) {
  const db = getDB();
  const op = db.prepare("SELECT * FROM sync_outbox WHERE id=? AND status='conflict'").get(outboxId);
  if (!op) throw new Error('عملیات متعارض یافت نشد');
  const cfg = getConfig(db);

  if (op.method === 'POST' && isProvisionalId(op.entity_local_id)) {
    const jwt = require('jsonwebtoken');
    const { SECRET } = require('../middleware/auth');
    const token = jwt.sign(
      { id: actingUser.id, username: actingUser.username, role: actingUser.role, name: actingUser.name, phone: actingUser.phone || '' },
      SECRET, { expiresIn: '5m' }
    );
    const port = process.env.PORT || 3000;
    const basePath = op.path.replace(/\?.*$/, '');
    const delPath = `${basePath}/${op.entity_local_id}`;
    const r = await fetch(`http://127.0.0.1:${port}${delPath}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}`, 'x-sync-suppress': '1' }
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
    syncing: state.syncing,
    pending: pendingCount(db),
    conflicts: conflictCount(db),
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
  setTimeout(tick, 5000);
  loopTimer = setInterval(tick, intervalMs || 60000);
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

module.exports = {
  pair, syncNow, pullFilesNow, skipSyncFile, discardConflict, getStatus, getConfig, startClientLoop, isPaired,
  setCentralUrl, resetPairing, migrateLegacyCentralUrl, normalizeCentralUrl, CANONICAL_CENTRAL_URL,
  fetchCentralAppUpdate, getUpdateFeedUrl, fetchCentralUpdateFeedUrl, getLocalAppUpdate, pullMissingFiles,
  changePasswordOnCentral, pairingHealth, resolveReachableCentralUrl, startInitialSyncAfterPair
};
