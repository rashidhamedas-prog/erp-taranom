// Sync engine endpoints.
//
// CENTRAL role (SYNC_ROLE=central):
//   POST /api/sync/pair       — register a new device (admin credentials required)
//   POST /api/sync/push       — replay a device's queued operations, in order
//   GET  /api/sync/pull       — incremental row changes + tombstones since a sequence
//   GET  /api/sync/row        — fetch one current row (conflict-resolution restore)
//   POST /api/sync/replay-multipart — relay a file-carrying op (product image, voucher attachment)
//
// DEVICE role (SYNC_ROLE=device):
//   GET  /api/sync/status     — pairing/online/pending/conflict state for the UI
//   POST /api/sync/pair-device— run the pairing flow against a central URL
//   POST /api/sync/now        — trigger an immediate sync cycle
//   GET  /api/sync/conflicts  — list conflicted local operations
//   POST /api/sync/conflicts/:outboxId/discard — undo a conflicted op locally
//
// Replay strategy: central re-executes each op through its OWN existing route
// handlers via a loopback HTTP request as the acting user. Validation, stock
// checks, numbering, ledger and journal postings all run through the exact
// same code as a live request — nothing is duplicated, so device-originated
// operations can never post differently than direct ones.
const router = require('express').Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDB, isDevice, audit } = require('../db');
const { auth, adminOnly, SECRET } = require('../middleware/auth');
const { SYNCABLE_TABLES, isProvisionalId } = require('../sync/tables');
const { tableForPath } = require('../sync/capture');

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// ---- Device authentication (central side) ----
function deviceAuth(req, res, next) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Device (\d+):([a-f0-9]+)$/);
  if (!m) return res.status(401).json({ error: 'اعتبار دستگاه نامعتبر است' });
  const db = getDB();
  const device = db.prepare('SELECT * FROM sync_devices WHERE id=? AND active=1').get(+m[1]);
  if (!device || device.token_hash !== sha256(m[2])) {
    return res.status(401).json({ error: 'اعتبار دستگاه نامعتبر است' });
  }
  req.device = device;
  next();
}

// Only mount central endpoints on central, device endpoints on device —
// prevents a misconfigured instance from serving the wrong half.
if (!isDevice()) {
  // ---- Pairing ----
  router.post('/pair', (req, res) => {
    const { username, password, device_name } = req.body;
    if (!username || !password || !device_name) {
      return res.status(400).json({ error: 'نام کاربری، رمز عبور و نام دستگاه الزامی است' });
    }
    const db = getDB();
    const user = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است' });
    }
    if (user.role !== 'admin') {
      return res.status(403).json({ error: 'فقط مدیر سیستم می‌تواند دستگاه جدید متصل کند' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    const result = db.prepare('INSERT INTO sync_devices (name, token_hash, paired_by) VALUES (?,?,?)')
      .run(device_name, sha256(token), user.id);
    audit(user.id, 'create', 'sync_device', result.lastInsertRowid, `اتصال دستگاه آفلاین: ${device_name}`);
    res.json({ device_id: result.lastInsertRowid, device_token: token });
  });

  // List/deactivate paired devices (admin UI)
  router.get('/devices', auth, adminOnly, (req, res) => {
    const db = getDB();
    res.json(db.prepare('SELECT id,name,active,last_push_at,last_pull_at,created_at FROM sync_devices ORDER BY id').all());
  });
  router.post('/devices/:id/deactivate', auth, adminOnly, (req, res) => {
    getDB().prepare('UPDATE sync_devices SET active=0 WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });

  // Open conflicts overview for admins on central
  router.get('/conflicts-central', auth, adminOnly, (req, res) => {
    const db = getDB();
    res.json(db.prepare(`SELECT c.*, d.name as device_name FROM sync_conflicts c
      LEFT JOIN sync_devices d ON c.device_id=d.id WHERE c.status='open' ORDER BY c.created_at DESC LIMIT 200`).all());
  });

  // Translate provisional ids (device-local) inside a JSON value to central
  // ids via sync_id_map. Returns { value, missing } — missing lists any
  // provisional id with no mapping yet (op must be deferred, not failed).
  function translateIds(db, deviceId, value, missing) {
    if (Array.isArray(value)) return value.map(v => translateIds(db, deviceId, v, missing));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = translateIds(db, deviceId, v, missing);
      return out;
    }
    if (isProvisionalId(value)) {
      const m = db.prepare('SELECT central_id FROM sync_id_map WHERE device_id=? AND local_id=?').get(deviceId, value);
      if (!m) { missing.push(value); return value; }
      return m.central_id;
    }
    return value;
  }

  function translatePath(db, deviceId, path, missing) {
    return path.split('/').map(seg => {
      if (/^\d{13,}$/.test(seg) && isProvisionalId(+seg)) {
        const m = db.prepare('SELECT central_id FROM sync_id_map WHERE device_id=? AND local_id=?').get(deviceId, +seg);
        if (!m) { missing.push(+seg); return seg; }
        return String(m.central_id);
      }
      return seg;
    }).join('/');
  }

  // ---- Push: ordered, idempotent replay ----
  router.post('/push', deviceAuth, async (req, res) => {
    const db = getDB();
    const deviceId = req.device.id;
    const ops = Array.isArray(req.body.ops) ? req.body.ops : [];
    const results = [];
    const port = process.env.PORT || 3000;
    const replayToken = req.app.get('internalReplayToken') || '';

    for (const op of ops) {
      const key = `${deviceId}:${op.seq}`;

      // Idempotency: an op already processed returns its stored outcome.
      const prior = db.prepare('SELECT * FROM sync_applied_ops WHERE idempotency_key=?').get(key);
      if (prior) {
        results.push({ seq: op.seq, status: prior.status, result: prior.result_json ? JSON.parse(prior.result_json) : null });
        if (prior.status === 'conflict') break; // device must resolve before anything after it runs
        continue;
      }

      // Acting user must still exist and be active.
      const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(op.user_id);
      if (!user) {
        recordConflict(db, deviceId, op, key, 'کاربر ثبت‌کننده این عملیات در سرور مرکزی غیرفعال یا حذف شده است', null);
        results.push({ seq: op.seq, status: 'conflict', reason: 'کاربر غیرفعال' });
        break;
      }

      // Translate provisional ids in path and body.
      const missing = [];
      const path = translatePath(db, deviceId, op.path, missing);
      let body = null;
      try { body = op.body ? translateIds(db, deviceId, op.body, missing) : {}; }
      catch { body = op.body || {}; }
      if (missing.length) {
        // Ordering gap (an earlier create hasn't been applied) — defer, do
        // NOT record: the device resends after the prerequisite confirms.
        results.push({ seq: op.seq, status: 'deferred', reason: 'شناسه‌های محلی هنوز نگاشت نشده‌اند' });
        break;
      }

      // Optimistic concurrency for edits of shared rows: if the row changed
      // centrally since the device last saw it, flag for human review instead
      // of silently overwriting.
      if ((op.method === 'PUT' || op.method === 'PATCH') && op.base_version != null && op.entity_table) {
        const m = path.match(/\/(\d+)(?:\/[a-z-]+)?(\?.*)?$/);
        if (m) {
          try {
            const current = db.prepare(`SELECT * FROM ${op.entity_table} WHERE id=?`).get(+m[1]);
            if (current && (current.version || 0) > op.base_version) {
              recordConflict(db, deviceId, op, key,
                'این رکورد پس از آخرین همگام‌سازی دستگاه، در سرور مرکزی تغییر کرده است',
                JSON.stringify(current));
              results.push({ seq: op.seq, status: 'conflict', reason: 'تغییر همزمان در سرور مرکزی' });
              break;
            }
          } catch { /* sub-resource paths may not resolve to entity_table rows */ }
        }
      }

      // Replay through the real route handler as the acting user.
      const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role, name: user.name, phone: user.phone || '' },
        SECRET, { expiresIn: '5m' }
      );
      let resp, respBody;
      try {
        resp = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: op.method,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'x-internal-replay': replayToken
          },
          body: (op.method === 'DELETE') ? undefined : JSON.stringify(body)
        });
        respBody = await resp.json().catch(() => ({}));
      } catch (e) {
        // Loopback failure is infrastructural, not a business conflict — abort
        // the whole push; the device retries the batch later.
        return res.status(500).json({ error: 'خطای داخلی در بازپخش عملیات: ' + e.message, results });
      }

      if (resp.ok) {
        // Record the provisional→central id mapping for creates.
        if (op.method === 'POST' && op.entity_table && isProvisionalId(op.entity_local_id)) {
          const centralId = (respBody && Number.isInteger(respBody.id)) ? respBody.id : null;
          if (centralId) {
            db.prepare('INSERT OR REPLACE INTO sync_id_map (device_id, local_id, tbl, central_id) VALUES (?,?,?,?)')
              .run(deviceId, op.entity_local_id, op.entity_table, centralId);
          }
        }
        db.prepare('INSERT INTO sync_applied_ops (idempotency_key, device_id, device_seq, method, path, status, result_json) VALUES (?,?,?,?,?,?,?)')
          .run(key, deviceId, op.seq, op.method, path, 'applied', JSON.stringify(respBody || {}));
        results.push({ seq: op.seq, status: 'applied', result: respBody });
      } else {
        const reason = (respBody && respBody.error) || `HTTP ${resp.status}`;
        recordConflict(db, deviceId, op, key, reason, snapshotFor(db, op, path));
        results.push({ seq: op.seq, status: 'conflict', reason });
        break; // stop-at-first-failure: later ops may depend on this one
      }
    }

    db.prepare("UPDATE sync_devices SET last_push_at=strftime('%s','now') WHERE id=?").run(deviceId);
    res.json({ results });
  });

  function recordConflict(db, deviceId, op, key, reason, snapshot) {
    db.prepare('INSERT INTO sync_conflicts (device_id, device_seq, idempotency_key, method, path, payload, reason, central_snapshot) VALUES (?,?,?,?,?,?,?,?)')
      .run(deviceId, op.seq, key, op.method, op.path, JSON.stringify(op.body || {}), reason, snapshot || null);
    db.prepare('INSERT OR REPLACE INTO sync_applied_ops (idempotency_key, device_id, device_seq, method, path, status, result_json) VALUES (?,?,?,?,?,?,?)')
      .run(key, deviceId, op.seq, op.method, op.path, 'conflict', JSON.stringify({ error: reason }));
  }

  // Best-effort snapshot of current central state for conflict review UIs.
  function snapshotFor(db, op, path) {
    try {
      if (!op.entity_table) return null;
      const m = path.match(/\/(\d+)(?:\/[a-z-]+)?$/);
      if (m) {
        const row = db.prepare(`SELECT * FROM ${op.entity_table} WHERE id=?`).get(+m[1]);
        return row ? JSON.stringify(row) : null;
      }
      // Stock-style conflicts: include the referenced products' current state
      if (op.body && Array.isArray(op.body.rows)) {
        const ids = op.body.rows.map(r => r.product_id).filter(Number.isInteger);
        if (ids.length) {
          const rows = db.prepare(`SELECT id,name,stock FROM products WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
          return JSON.stringify(rows);
        }
      }
    } catch { /* snapshot is advisory only */ }
    return null;
  }

  // ---- File download for device sync (product images, attachments) ----
  router.get('/files', deviceAuth, (req, res) => {
    const rel = req.query.path;
    if (!rel || typeof rel !== 'string' || rel.includes('..')) {
      return res.status(400).json({ error: 'مسیر فایل نامعتبر است' });
    }
    const { UPLOADS_ROOT } = require('../paths');
    const filePath = path.join(UPLOADS_ROOT, rel);
    const root = path.resolve(UPLOADS_ROOT);
    if (!path.resolve(filePath).startsWith(root) || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'فایل یافت نشد' });
    }
    res.sendFile(filePath);
  });

  // ---- File relay: product images / voucher attachments created offline ----
  const multer = require('multer');
  const relayUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
  router.post('/replay-multipart', deviceAuth, relayUpload.single('file'), async (req, res) => {
    const db = getDB();
    const { path: opPath, method, user_id, field } = req.body;
    if (!opPath || !req.file) return res.status(400).json({ error: 'path و file الزامی است' });
    const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(+user_id);
    if (!user) return res.status(400).json({ error: 'کاربر نامعتبر' });
    const missing = [];
    const path = translatePath(db, req.device.id, opPath, missing);
    if (missing.length) return res.status(409).json({ error: 'شناسه محلی نگاشت نشده', deferred: true });
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, name: user.name, phone: user.phone || '' },
      SECRET, { expiresIn: '5m' }
    );
    const port = process.env.PORT || 3000;
    const form = new FormData();
    for (const [k, v] of Object.entries(req.body)) {
      if (!['path', 'method', 'user_id', 'field'].includes(k)) form.append(k, v);
    }
    form.append(field || 'image', new Blob([req.file.buffer]), req.file.originalname || 'upload.jpg');
    const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: method || 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'x-internal-replay': req.app.get('internalReplayToken') || '' },
      body: form
    });
    const out = await resp.json().catch(() => ({}));
    res.status(resp.status).json(out);
  });

  // ---- Pull: incremental changes since a global sequence ----
  router.get('/pull', deviceAuth, (req, res) => {
    const db = getDB();
    const since = parseInt(req.query.since);
    const from = Number.isInteger(since) ? since : -1;
    const limit = Math.min(parseInt(req.query.limit) || 2000, 5000);

    const changes = [];
    for (const t of SYNCABLE_TABLES) {
      const rows = db.prepare(`SELECT * FROM ${t.name} WHERE sync_seq > ? ORDER BY sync_seq LIMIT ?`).all(from, limit);
      for (const row of rows) changes.push({ seq: row.sync_seq, tbl: t.name, row });
    }
    for (const ts of db.prepare('SELECT * FROM sync_tombstones WHERE sync_seq > ? ORDER BY sync_seq LIMIT ?').all(from, limit)) {
      changes.push({ seq: ts.sync_seq, tbl: ts.tbl, del: ts.row_key });
    }
    changes.sort((a, b) => a.seq - b.seq);
    const page = changes.slice(0, limit);
    const next_since = page.length ? page[page.length - 1].seq : from;
    db.prepare("UPDATE sync_devices SET last_pull_at=strftime('%s','now') WHERE id=?").run(req.device.id);
    res.json({ changes: page, next_since, has_more: changes.length > limit });
  });

  // Single-row fetch — used by devices to restore a row after discarding a
  // conflicted local edit/delete.
  router.get('/row', deviceAuth, (req, res) => {
    const { tbl, id } = req.query;
    const spec = SYNCABLE_TABLES.find(t => t.name === tbl);
    if (!spec) return res.status(400).json({ error: 'جدول نامعتبر' });
    const db = getDB();
    const row = db.prepare(`SELECT * FROM ${spec.name} WHERE ${spec.upsertKey}=?`).get(id);
    res.json({ row: row || null });
  });
}

if (isDevice()) {
  const client = require('../sync/client');

  router.get('/status', auth, (req, res) => {
    res.json(client.getStatus());
  });

  router.post('/pair-device', auth, adminOnly, async (req, res) => {
    const { central_url, username, password, device_name } = req.body;
    if (!central_url || !username || !password) {
      return res.status(400).json({ error: 'آدرس سرور مرکزی، نام کاربری و رمز عبور الزامی است' });
    }
    try {
      const result = await client.pair(central_url, username, password, device_name || 'دستگاه آفلاین');
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/update-central-url', auth, adminOnly, async (req, res) => {
    const central_url = (req.body && req.body.central_url) || '';
    try {
      const result = await client.setCentralUrl(central_url);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Authenticated wipe + unpair (admin). Clears local syncable data.
  router.post('/reset-pairing', auth, adminOnly, (req, res) => {
    const confirm = (req.body && req.body.confirm) || '';
    if (confirm !== 'RESET') {
      return res.status(400).json({ error: 'برای تأیید، confirm را برابر RESET بفرستید' });
    }
    try {
      res.json(client.resetPairing());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Recovery when login itself is broken (paired to dead host / empty users).
  // Device builds bind localhost only — not exposed on the public internet.
  router.post('/factory-reset-device', (req, res) => {
    const confirm = (req.body && req.body.confirm) || '';
    if (confirm !== 'RESET-DEVICE') {
      return res.status(400).json({ error: 'برای تأیید، confirm را برابر RESET-DEVICE بفرستید' });
    }
    try {
      res.json(client.resetPairing());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/now', auth, async (req, res) => {
    try {
      const result = await client.syncNow();
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/pull-files', auth, async (req, res) => {
    try {
      const result = await client.pullFilesNow();
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/missing-files', auth, (req, res) => {
    const { listMissingFiles } = require('../sync/files');
    const db = getDB();
    res.json(listMissingFiles(db));
  });

  router.post('/skip-file', auth, (req, res) => {
    const { subdir, name } = req.body || {};
    if (!subdir || !name) return res.status(400).json({ error: 'subdir و name الزامی است' });
    try {
      res.json(client.skipSyncFile(subdir, name));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/conflicts', auth, (req, res) => {
    const db = getDB();
    res.json(db.prepare("SELECT * FROM sync_outbox WHERE status='conflict' ORDER BY id").all()
      .map(r => ({ ...r, body: JSON.parse(r.body_json || '{}') })));
  });

  router.get('/pending', auth, (req, res) => {
    const db = getDB();
    res.json(db.prepare("SELECT id,method,path,entity_table,created_at,status,reason FROM sync_outbox WHERE status IN ('pending','conflict') ORDER BY id").all());
  });

  router.post('/conflicts/:outboxId/discard', auth, async (req, res) => {
    try {
      const result = await client.discardConflict(+req.params.outboxId, req.user);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}

module.exports = router;
