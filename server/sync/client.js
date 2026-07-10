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

function kvGet(db, key) {
  const r = db.prepare('SELECT value FROM sync_local_kv WHERE key=?').get(key);
  return r ? r.value : null;
}
function kvSet(db, key, value) {
  db.prepare('INSERT INTO sync_local_kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
}

function getConfig(db) {
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

async function probe(centralUrl) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(centralUrl.replace(/\/$/, '') + '/api/system/time', { signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

// ---- Pairing ----
async function pair(centralUrl, username, password, deviceName) {
  const db = getDB();
  if (isPaired(db)) throw new Error('این دستگاه قبلاً متصل شده است');
  const base = centralUrl.replace(/\/$/, '');

  // Pairing requires a fresh (empty) local database — pre-pairing business
  // rows would occupy the low id range and collide with pulled central rows.
  const custCount = db.prepare('SELECT COUNT(*) c FROM customers').get().c;
  const invCount = db.prepare('SELECT COUNT(*) c FROM invoices').get().c;
  if (custCount || invCount) {
    throw new Error('اتصال فقط روی پایگاه‌داده خالی امکان‌پذیر است — داده‌های محلی موجود ابتدا باید حذف شوند');
  }

  const r = await fetch(base + '/api/sync/pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, device_name: deviceName })
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || 'اتصال به سرور مرکزی ناموفق بود');

  kvSet(db, 'central_url', base);
  kvSet(db, 'device_id', body.device_id);
  kvSet(db, 'device_token', body.device_token);
  kvSet(db, 'last_pull_seq', -1);
  seedProvisionalSequences(db, body.device_id);

  // Initial full pull. Then remove the pre-pairing placeholder admin: any
  // local user row whose id wasn't in the pulled user set is a seed artifact.
  const cfg = getConfig(db);
  const pulledUserIds = await pullAll(db, cfg);
  await pullMissingFiles(db, cfg).catch(e => console.error('initial file sync:', e.message));
  if (pulledUserIds.size) {
    const ids = [...pulledUserIds];
    db.prepare(`DELETE FROM users WHERE id NOT IN (${ids.map(() => '?').join(',')})`).run(...ids);
  }
  state.online = true;
  return { ok: true, device_id: body.device_id };
}

// ---- Sync cycle ----
async function syncNow() {
  const db = getDB();
  if (!isPaired(db)) return { ok: false, error: 'دستگاه هنوز به سرور مرکزی متصل نشده است' };
  if (state.syncing) return { ok: false, error: 'همگام‌سازی در حال اجراست' };
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
  while (more) {
    const r = await fetch(`${cfg.centralUrl}/api/sync/pull?since=${since}&limit=2000`, { headers: deviceHeaders(cfg) });
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
          db.prepare(`DELETE FROM ${spec.name} WHERE ${spec.upsertKey}=?`).run(ch.del);
          continue;
        }
        const row = ch.row;
        if (!row) continue;
        if (spec.name === 'users' && pulledUserIds) pulledUserIds.add(row.id);
        const cols = tableColumns(db, spec.name).filter(c => c in row);
        if (spec.upsertKey === 'id') {
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
    data_version: state.dataVersion
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
  if (isPaired(db)) {
    const cfg = getConfig(db);
    seedProvisionalSequences(db, cfg.deviceId);
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

module.exports = {
  pair, syncNow, pullFilesNow, skipSyncFile, discardConflict, getStatus, getConfig, startClientLoop, isPaired,
  fetchCentralAppUpdate, getUpdateFeedUrl, fetchCentralUpdateFeedUrl, getLocalAppUpdate, pullMissingFiles
};
