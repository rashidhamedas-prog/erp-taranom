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
const crypto = require('crypto');
const { getDB } = require('../db');
const { UPLOADS_ROOT } = require('../paths');
const { SYNCABLE_TABLES } = require('./tables');
const { getSecret } = require('./secure-kv');
const { signReplayEnvelope, sha256Buffer } = require('./device-auth');
const { resolveReferencedFile } = require('./files');
const { PRIVATE_UPLOADS_ROOT } = require('../lib/private-uploads');

// Paths that must never be captured/replayed:
//  - auth/sync plumbing and centrally-gated admin surfaces
//  - bulk Excel imports (multipart bodies that can't replay as JSON)
//  - direct message/SMS sends (replaying would double-send)
const BLOCKLIST = [
  '/api/auth', '/api/users', '/api/sync', '/api/api-keys',
  '/api/messages', '/api/v1', '/api/ai', '/api/b2b',
  '/api/onboarding',
  '/api/admin/backup', '/api/admin/backups', '/api/admin/backup-now',
  '/api/admin/backup-download', '/api/admin/backup-restore',
  '/api/admin/restore-product-stock-wipe',
  '/api/crm/automations',
];
const BLOCK_PATTERNS = [/\/import/, /\/export/, /\/backup/, /\/backfill/, /\/stock$/];

// Path prefix → entity table, used to tag create ops so central can record
// the provisional→central id mapping. Longest prefix wins.
// Maps request path → primary entity table for outbox tagging / id remap.
// Longer/more-specific prefixes MUST appear before shorter ones
// (e.g. /api/warehouses/moves before /api/warehouses).
// When adding a mutating /api route: update this list — see sync-hygiene.mdc.
const PATH_TABLE_MAP = [
  ['/api/admin/users', 'users'],
  ['/api/settings', 'settings'],
  ['/api/rbac/matrix', 'user_permissions'],
  ['/api/accounting/settlements', 'settlements'],
  ['/api/accounting/account-payments', 'journal_entries'],
  ['/api/accounting/account-receipts', 'journal_entries'],
  ['/api/accounting/sales-returns', 'sales_returns'],
  ['/api/accounting/invoices', 'invoices'],
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
  ['/api/parties', 'parties'],
  ['/api/invoices', 'invoices'],
  ['/api/followups', 'followups'],
  ['/api/crm/opportunities', 'crm_opportunities'],
  ['/api/crm/activities', 'crm_activities'],
  ['/api/crm/segmentation', 'crm_customer_segments'],
  // Product variants — specific prefixes BEFORE generic /api/product-variants
  ['/api/product-variants/colors', 'product_colors'],
  ['/api/product-variants/sizes', 'product_sizes'],
  ['/api/product-variants/generate-matrix', 'product_variants'],
  ['/api/product-variants/ensure-default', 'product_variants'],
  ['/api/product-variants/style', 'product_variants'],
  ['/api/product-variants', 'product_variants'],
  ['/api/products', 'products'],
  ['/api/product-categories', 'product_categories'],
  ['/api/suppliers', 'suppliers'],
  ['/api/banks', 'banks'],
  ['/api/cash-boxes', 'cash_boxes'],
  ['/api/check-categories', 'check_categories'],
  ['/api/expenses', 'expense_payments'],
  ['/api/transfers', 'account_transfers'],
  ['/api/trust-checks', 'trust_checks'],
  // Warehouse moves BEFORE generic /api/warehouses
  ['/api/warehouses/moves', 'warehouse_moves'],
  ['/api/warehouses/stock', 'warehouse_stock'],
  ['/api/warehouses', 'warehouses'],
  ['/api/stocktaking', 'stocktaking_sessions'],
  ['/api/consignments', 'consignments'], // settle/cancel share this prefix
  // POS — longer prefixes first (receipts/batches before terminals)
  ['/api/pos/receipts', 'pos_receipts'],
  ['/api/pos/batches', 'pos_settlement_batches'],
  ['/api/pos/terminals', 'pos_terminals'],
  // Detail accounts — categories before generic
  ['/api/detail-accounts/categories', 'detail_categories'],
  ['/api/detail-accounts', 'detail_accounts'],
  ['/api/units', 'units_of_measure'],
  ['/api/fixed-assets', 'fixed_assets'],
  // Production — longer prefixes BEFORE /api/production (legacy production_runs)
  ['/api/production/cost-centers/rates', 'cost_center_rates'],
  // BOM ops/outputs: /api/production/boms/:id/{operations|outputs} — id mid-path;
  // cannot encode with startsWith prefixes; see tableForPath custom branch (PROD-P5).
  ['/api/production/boms', 'bom_headers'],
  ['/api/production/orders', 'production_orders'],
  ['/api/production/execution', 'production_orders'],
  ['/api/production/mrp', 'mrp_runs'],
  ['/api/production/cost-centers', 'cost_centers'],
  ['/api/production/user-cost-centers', 'user_cost_centers'],
  ['/api/production/close', 'production_period_close'],
  ['/api/production', 'production_runs'],
  // Inventory — specific before generic
  ['/api/inventory/batches', 'inventory_batches'],
  ['/api/inventory/serials', 'inventory_serials'],
  ['/api/inventory/reservations', 'inventory_reservations'],
  ['/api/inventory/landed-cost', 'landed_cost_docs'],
  ['/api/inventory/ledger', 'inventory_ledger'],
  ['/api/inventory/adjust', 'inventory_ledger'],
  ['/api/payroll/employee-groups', 'employee_groups'],
  ['/api/payroll/group-salary-structures', 'group_salary_structures'],
  ['/api/payroll', 'payroll_records'],
  ['/api/reminders', 'reminders'],
  ['/api/orders', 'orders'],
  ['/api/party-groups', 'party_groups'],
  // Update 11
  ['/api/fx/rates', 'exchange_rates'],
  ['/api/fx/currencies', 'currencies'],
  ['/api/person-positions', 'person_positions'],
  ['/api/pricing-rules', 'pricing_rules'],
  // Portal karmandan + gap accounting (device ops)
  ['/api/portal/parameters', 'op_parameters'],
  ['/api/portal/units', 'op_units'],
  ['/api/portal/departments', 'op_departments'],
  ['/api/bank-reconciliation', 'bank_reconciliations'],
  ['/api/budgeting', 'budgets'],
  ['/api/reserves', 'legal_reserve_entries'],
  ['/api/cheque-records', 'cheque_records'],
  ['/api/sms-module/rules', 'sms_rules'],
  ['/api/sms-module/templates', 'sms_templates'],
  ['/api/sms-module/options', 'sms_options'],
  ['/api/sms-module/scheduled', 'sms_scheduled'],
];

// Note: /api/portal/departments/:id/delegate maps to op_departments prefix above;
// actual rows live in op_dept_delegations and sync via full-table pull.

function tableForPath(path) {
  if (path.startsWith('/api/reps/payments')) return 'rep_payment_submissions';
  if (path.startsWith('/api/reps/') && path.includes('/expenses')) return 'rep_expenses';
  if (path.startsWith('/api/reps/') && path.includes('/advances')) return 'rep_advances';
  if (path === '/api/reps/transfer-customer') return 'customers';
  // PROD-P5: BOM child resources have :id between boms/ and ops|outputs —
  // PATH_TABLE_MAP prefixes cannot distinguish them from bom_headers.
  if (path.startsWith('/api/production/boms/') && path.includes('/operations')) return 'bom_operations';
  if (path.startsWith('/api/production/boms/') && path.includes('/outputs')) return 'bom_outputs';
  for (const [prefix, tbl] of PATH_TABLE_MAP) {
    if (path === prefix || path.startsWith(prefix + '/')) return tbl;
  }
  return null;
}

function isBlocked(path) {
  if (BLOCKLIST.some(p => path === p || path.startsWith(p + '/'))) return true;
  return BLOCK_PATTERNS.some(re => re.test(path));
}

function replaySigningContext(db) {
  const rows = db.prepare(`
    SELECT key,value FROM sync_local_kv
    WHERE key IN ('central_url','device_id','device_token')
  `).all();
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const deviceId = Number(values.device_id);
  const paired = !!(values.central_url && values.device_token && Number.isSafeInteger(deviceId) && deviceId > 0);
  if (!paired) return null;
  const privateKey = getSecret(db, 'device_signing_private_key');
  if (!privateKey) {
    const error = new Error('This paired device has no replay signing key and must be paired again');
    error.code = 'SYNC_REPAIR_REQUIRED';
    throw error;
  }
  return { deviceId, privateKey };
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
      if (row && row.attachment) return resolveReferencedFile(db, 'vouchers', row.attachment, { migrateLegacy: true });
    }
    if (reqPath.includes('/with-image') && responseBody && responseBody.image) {
      return resolveReferencedFile(db, 'messages', responseBody.image, { migrateLegacy: true });
    }
    if (entityTable === 'rep_payment_submissions' || entityTable === 'rep_expenses') {
      const row = db.prepare(`SELECT receipt_file AS f FROM ${entityTable} WHERE id=?`).get(id);
      if (row && row.f) return resolveReferencedFile(db, 'reps', row.f, { migrateLegacy: true });
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
  let signingContext;
  try {
    signingContext = replaySigningContext(db);
  } catch (error) {
    return res.status(503).json({
      error: 'اعتبار امضای همگام‌سازی این دستگاه موجود نیست؛ دستگاه را دوباره متصل کنید',
      code: error.code || 'SYNC_REPAIR_REQUIRED',
    });
  }

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
    const diagnostic = {
      method,
      path: req.originalUrl || reqPath,
      bodyJson: '{}',
      userId: req.user ? Number(req.user.id) : null,
      baseVersion,
      entityTable,
      entityLocalId: null,
      capturedJson: '{}',
      hasFile: req.file ? 1 : 0,
      filePath: null,
      fileHash: '',
      fileField: '',
    };
    try {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const captured = diffSequences(seqBefore, snapshotSequences(db));
        diagnostic.capturedJson = JSON.stringify(captured);
        let entityLocalId = null;
        if (method === 'POST' && body && typeof body === 'object' && Number.isInteger(body.id)) {
          entityLocalId = body.id;
        } else {
          const m = reqPath.match(/\/(\d+)(?:\/[a-z-]+)?$/);
          if (m) entityLocalId = +m[1];
        }
        diagnostic.entityLocalId = entityLocalId;
        let filePath = null;
        if (req.file) {
          if (req.file.path && fs.existsSync(req.file.path)) filePath = req.file.path;
          else if (req.file.buffer) {
            const pendingDir = path.join(PRIVATE_UPLOADS_ROOT, 'sync-pending');
            fs.mkdirSync(pendingDir, { recursive: true, mode: 0o700 });
            const ext = /^\.[a-z0-9]{2,6}$/i.test(req.file.extension || '') ? req.file.extension.toLowerCase() : '.bin';
            const fname = `sync-${crypto.randomBytes(18).toString('hex')}${ext}`;
            filePath = path.join(pendingDir, fname);
            fs.writeFileSync(filePath, req.file.buffer, { flag: 'wx', mode: 0o600 });
          }
        }
        if (req.file && !filePath) {
          filePath = resolveUploadedFilePath(db, reqPath, entityTable, entityLocalId, body);
        }
        diagnostic.filePath = filePath;
        const replayPath = req.originalUrl || reqPath;
        const replayBody = req.body || {};
        const bodyJson = JSON.stringify(replayBody);
        const userId = req.user ? Number(req.user.id) : null;
        diagnostic.bodyJson = bodyJson;
        diagnostic.userId = userId;
        const hasFile = req.file ? 1 : 0;
        let fileHash = '';
        let fileField = '';
        if (hasFile) {
          if (!filePath || !fs.existsSync(filePath)) throw new Error('Captured upload is not available for signed replay');
          fileHash = sha256Buffer(fs.readFileSync(filePath));
          fileField = String(req.file.fieldname || '');
        }
        diagnostic.fileHash = fileHash;
        diagnostic.fileField = fileField;

        db.transaction(() => {
          const inserted = db.prepare(`INSERT INTO sync_outbox
            (method, path, body_json, user_id, base_version, entity_table, entity_local_id,
             captured_rows_json, has_file, file_path, replay_file_hash, replay_file_field)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(method, replayPath, bodyJson, userId, baseVersion, entityTable, entityLocalId,
                 JSON.stringify(captured), hasFile, filePath, fileHash || null, fileField || null);
          if (signingContext) {
            if (!Number.isSafeInteger(userId) || userId <= 0) {
              throw new Error('Authenticated user is required for signed replay');
            }
            const proof = signReplayEnvelope(signingContext.privateKey, {
              deviceId: signingContext.deviceId,
              seq: Number(inserted.lastInsertRowid),
              method,
              path: replayPath,
              userId,
              body: JSON.parse(bodyJson),
              fileHash,
              fileField,
            });
            db.prepare('UPDATE sync_outbox SET replay_proof=? WHERE id=?')
              .run(proof, inserted.lastInsertRowid);
            const stored = db.prepare('SELECT replay_proof FROM sync_outbox WHERE id=?').get(inserted.lastInsertRowid);
            if (!stored || !stored.replay_proof) throw new Error('Replay proof was not persisted');
          }
        })();
      }
    } catch (e) {
      const errorCode = String(e && e.code || 'SYNC_CAPTURE_FAILED').slice(0, 80);
      const errorMessage = String(e && e.message || 'capture failed').replace(/[\r\n]+/g, ' ').slice(0, 500);
      let recoveryId = null;
      try {
        recoveryId = Number(db.prepare(`
          INSERT INTO sync_capture_failures
            (method,path,body_json,user_id,base_version,entity_table,entity_local_id,
             captured_rows_json,has_file,file_path,replay_file_hash,replay_file_field,
             error_code,error_message,status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')
        `).run(
          diagnostic.method, diagnostic.path, diagnostic.bodyJson, diagnostic.userId,
          diagnostic.baseVersion, diagnostic.entityTable, diagnostic.entityLocalId,
          diagnostic.capturedJson, diagnostic.hasFile, diagnostic.filePath,
          diagnostic.fileHash || null, diagnostic.fileField || null,
          errorCode, errorMessage
        ).lastInsertRowid);
      } catch (diagnosticError) {
        console.error('sync capture durable diagnostic failed:', String(diagnosticError.code || 'DB_ERROR'));
      }
      console.error('sync capture failed:', errorCode, recoveryId ? `recovery=${recoveryId}` : 'recovery=unavailable');
      res.status(503);
      return origJson({
        error: 'تغییر محلی انجام شد اما ثبت امن آن برای همگام‌سازی نیازمند ترمیم است',
        code: 'SYNC_CAPTURE_REPAIR_QUEUED',
        local_change_applied: true,
        queued_for_repair: !!recoveryId,
        recovery_id: recoveryId,
      });
    }
    return origJson(body);
  };
  next();
}

module.exports = { captureMiddleware, tableForPath, PATH_TABLE_MAP };
