// Device-side outbox capture. Express middleware (installed only when
// SYNC_ROLE=device) that records every successful mutating API call into
// sync_outbox for later replay against the central server.
//
// Design: rather than refactoring ~30 route handlers to emit ops explicitly,
// this wraps the route layer. Handlers in this codebase are synchronous
// (better-sqlite3), so by the time a handler calls res.json() its transaction
// has already committed — the middleware then records the op in the same JS
// tick. The rows the op created locally are detected generically by diffing
// sqlite_sequence before/after the handler (Node runs handlers one at a
// time, so the diff can only contain this op's rows). Those captured rows are
// deleted when central confirms the op, and central's authoritative versions
// arrive via pull.
const fs = require('fs');
const path = require('path');
const { getDB } = require('../db');
const { UPLOADS_ROOT } = require('../paths');
const { SYNCABLE_TABLES } = require('./tables');

// Paths that must never be captured/replayed:
//  - auth/sync plumbing and centrally-gated admin surfaces
//  - bulk Excel imports (multipart bodies that can't replay as JSON)
//  - direct message/SMS sends (replaying would double-send)
const BLOCKLIST = [
  '/api/auth', '/api/sync', '/api/admin', '/api/api-keys', '/api/settings',
  '/api/messages', '/api/v1', '/api/ai', '/api/b2b'
];
const BLOCK_PATTERNS = [/\/import/, /\/export/, /\/backup/, /\/backfill/, /\/stock$/];

// Path prefix → entity table, used to tag create ops so central can record
// the provisional→central id mapping. Longest prefix wins.
const PATH_TABLE_MAP = [
  ['/api/accounting/settlements', 'settlements'],
  ['/api/accounting/sales-returns', 'sales_returns'],
  ['/api/accounting/vouchers/drafts', 'voucher_drafts'],
  ['/api/accounting/vouchers/templates', 'journal_templates'],
  ['/api/accounting/vouchers', 'journal_entries'],
  ['/api/accounting/cost-centers', 'cost_centers'],
  ['/api/accounting/customer-groups', 'customer_groups'],
  ['/api/purchases/returns', 'purchase_returns'],
  ['/api/purchases/payments', 'supplier_payments'],
  ['/api/purchases', 'purchase_invoices'],
  ['/api/persons/categories', 'person_categories'],
  ['/api/persons', 'persons'],
  ['/api/customers', 'customers'],
  ['/api/invoices', 'invoices'],
  ['/api/followups', 'followups'],
  ['/api/products', 'products'],
  ['/api/suppliers', 'suppliers'],
  ['/api/banks', 'banks'],
  ['/api/cash-boxes', 'cash_boxes'],
  ['/api/check-categories', 'check_categories'],
  ['/api/expenses', 'expense_payments'],
  ['/api/transfers', 'account_transfers'],
  ['/api/trust-checks', 'trust_checks'],
  ['/api/warehouses', 'warehouses'],
  ['/api/stocktaking', 'stocktaking_sessions'],
  ['/api/consignments', 'consignments'],
  ['/api/production', 'production_runs'],
  ['/api/payroll', 'payroll_records'],
  ['/api/reminders', 'reminders'],
  ['/api/orders', 'orders']
];

function tableForPath(path) {
  if (path.startsWith('/api/reps/') && path.includes('/expenses')) return 'rep_expenses';
  if (path.startsWith('/api/reps/') && path.includes('/advances')) return 'rep_advances';
  if (path === '/api/reps/transfer-customer') return 'customers';
  for (const [prefix, tbl] of PATH_TABLE_MAP) {
    if (path === prefix || path.startsWith(prefix + '/')) return tbl;
  }
  return null;
}

function isBlocked(path) {
  if (BLOCKLIST.some(p => path === p || path.startsWith(p + '/'))) return true;
  return BLOCK_PATTERNS.some(re => re.test(path));
}

function snapshotSequences(db) {
  const snap = {};
  try {
    for (const r of db.prepare('SELECT name, seq FROM sqlite_sequence').all()) snap[r.name] = r.seq;
  } catch { /* sqlite_sequence may not exist on a brand-new empty DB */ }
  return snap;
}

// Rows created between two snapshots, restricted to syncable tables.
// Multer memoryStorage has no .path — resolve the saved filename from DB/response.
function resolveUploadedFilePath(db, reqPath, entityTable, entityLocalId, responseBody) {
  const id = entityLocalId || (responseBody && Number.isInteger(responseBody.id) ? responseBody.id : null);
  if (!id) return null;
  try {
    if (entityTable === 'products') {
      const row = db.prepare('SELECT image FROM products WHERE id=?').get(id);
      if (row && row.image) return path.join(UPLOADS_ROOT, 'products', row.image);
    }
    if (reqPath.includes('/attachment')) {
      const row = db.prepare('SELECT attachment FROM journal_entries WHERE id=?').get(id);
      if (row && row.attachment) return path.join(UPLOADS_ROOT, 'vouchers', row.attachment);
    }
    if (reqPath.includes('/with-image') && responseBody && responseBody.image) {
      return path.join(UPLOADS_ROOT, 'messages', responseBody.image);
    }
  } catch { /* schema drift */ }
  return null;
}

function diffSequences(before, after) {
  const created = {};
  for (const t of SYNCABLE_TABLES) {
    const a = after[t.name], b = before[t.name];
    if (a != null && a > (b || 0)) {
      const ids = [];
      for (let id = (b || 0) + 1; id <= a; id++) ids.push(id);
      created[t.name] = ids;
    }
  }
  return created;
}

function captureMiddleware(req, res, next) {
  const method = req.method;
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return next();
  if (!req.path.startsWith('/api/')) return next();
  if (isBlocked(req.path)) return next();
  if (req.headers['x-sync-suppress']) return next(); // internal ops (discard etc.)

  const db = getDB();
  const reqPath = req.path;
  const entityTable = tableForPath(reqPath);

  // Optimistic-concurrency base version for edits of already-synced rows
  let baseVersion = null;
  if ((method === 'PUT' || method === 'PATCH') && entityTable) {
    const m = reqPath.match(/\/(\d+)(?:\/[a-z-]+)?$/);
    if (m) {
      try {
        const row = db.prepare(`SELECT version FROM ${entityTable} WHERE id=?`).get(+m[1]);
        if (row) baseVersion = row.version || 0;
      } catch { /* path id may not belong to entityTable (sub-resources) */ }
    }
  }

  const seqBefore = snapshotSequences(db);
  const origJson = res.json.bind(res);
  res.json = function (body) {
    try {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const captured = diffSequences(seqBefore, snapshotSequences(db));
        let entityLocalId = null;
        if (method === 'POST' && body && typeof body === 'object' && Number.isInteger(body.id)) {
          entityLocalId = body.id;
        } else {
          const m = reqPath.match(/\/(\d+)(?:\/[a-z-]+)?$/);
          if (m) entityLocalId = +m[1];
        }
        let filePath = null;
        if (req.file) {
          if (req.file.path && fs.existsSync(req.file.path)) filePath = req.file.path;
          else if (req.file.buffer) {
            const pendingDir = path.join(path.dirname(UPLOADS_ROOT), 'sync-pending');
            fs.mkdirSync(pendingDir, { recursive: true });
            const fname = `${Date.now()}-${(req.file.originalname || 'upload').replace(/[^\w.-]/g, '_')}`;
            filePath = path.join(pendingDir, fname);
            fs.writeFileSync(filePath, req.file.buffer);
          }
        }
        if (req.file && !filePath) {
          filePath = resolveUploadedFilePath(db, reqPath, entityTable, entityLocalId, body);
        }
        db.prepare(`INSERT INTO sync_outbox
          (method, path, body_json, user_id, base_version, entity_table, entity_local_id, captured_rows_json, has_file, file_path)
          VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(method, req.originalUrl || reqPath, JSON.stringify(req.body || {}),
               req.user ? req.user.id : null, baseVersion, entityTable, entityLocalId,
               JSON.stringify(captured), req.file ? 1 : 0, filePath);
      }
    } catch (e) {
      console.error('sync capture error:', e.message);
    }
    return origJson(body);
  };
  next();
}

module.exports = { captureMiddleware, tableForPath, PATH_TABLE_MAP };
