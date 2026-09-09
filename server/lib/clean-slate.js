/**
 * Canonical transactional wipe for a company SQLite workspace.
 *
 * Two professional operations (do not mix them):
 *   - rollover: keep documents, close P&L, open a new fiscal year (not this module)
 *   - clean slate: delete operational documents/ledgers/movements, keep identity
 *
 * Root-cause rules this module encodes:
 *   1. Never swallow DELETE failures — leftover rows mean the API lied.
 *   2. Disable FK during wipe so child tables cannot block parents.
 *   3. Discover tables from sqlite_master so newly added modules are not forgotten.
 *   4. Keep sync_tombstones so paired devices still receive deletes.
 *   5. Reset number_sequences + stock projections after wipe.
 */
'use strict';

const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Identity / config that must survive every wipe (including wipe_master). */
const ALWAYS_KEEP = new Set([
  'users',
  'settings',
  'chart_of_accounts',
  'api_keys',
  'fiscal_years',
  'number_sequences',
  'two_factor_auth',
  'sync_tombstones',
  'sync_seq',
  'global_seq',
  'user_permissions',
  'rbac_overrides',
  'sms_templates',
  'license_state',
  'license_events',
  'paired_devices',
  'devices',
]);

/** Master data kept on transactional wipe / new-company / factory-reset. */
const MASTER_KEEP = new Set([
  ...ALWAYS_KEEP,
  'warehouses',
  'customer_groups',
  'person_categories',
  'units_of_measure',
  'cost_centers',
  'expense_categories',
  'product_categories',
  'products',
  'product_images',
  'product_colors',
  'product_sizes',
  'product_style_colors',
  'product_style_sizes',
  'product_variants',
  'customers',
  'suppliers',
  'persons',
  'parties',
  'party_groups',
  'detail_accounts',
  'detail_categories',
  'banks',
  'cash_boxes',
  'check_categories',
  'bom_headers',
  'bom_lines',
  'bom_operations',
  'bom_outputs',
  'overhead_allocation_rules',
  'overhead_allocation_weights',
  'cost_center_rates',
  'user_cost_centers',
  'positions',
  'currencies',
  'warehouse_stock', // qty reset to 0; rows kept as product×warehouse projection
]);

const TXN_PROBE = [
  'invoices', 'purchase_invoices', 'journal_entries', 'journal_lines',
  'settlements', 'cheque_records', 'trust_checks', 'orders', 'followups',
  'customer_ledger', 'supplier_ledger', 'person_ledger', 'inventory_ledger',
  'warehouse_moves', 'stock_logs', 'sales_returns', 'purchase_returns',
  'expense_payments', 'account_transfers', 'voucher_drafts',
  'production_orders', 'production_runs', 'payroll_records',
  'rep_payment_submissions', 'vat_records', 'consignments',
];

function assertSafeTable(name) {
  if (!TABLE_RE.test(name)) throw new Error('نام جدول نامعتبر است');
  return name;
}

function listUserTables(db) {
  return db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map((r) => r.name).filter((n) => TABLE_RE.test(n));
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function countRows(db, name) {
  if (!tableExists(db, name)) return 0;
  try {
    return db.prepare(`SELECT COUNT(*) AS c FROM ${assertSafeTable(name)}`).get().c || 0;
  } catch {
    return 0;
  }
}

function snapshotTxnCounts(db) {
  const out = {};
  for (const t of TXN_PROBE) {
    if (tableExists(db, t)) out[t] = countRows(db, t);
  }
  return out;
}

function keepSetForMode(mode) {
  if (mode === 'full' || mode === 'wipe_master') return ALWAYS_KEEP;
  return MASTER_KEEP;
}

function resetMasterBalances(db) {
  const stmts = [
    'UPDATE customers SET balance=0, churn_score=0',
    'UPDATE products SET stock=0',
    'UPDATE warehouse_stock SET qty=0',
    'UPDATE number_sequences SET current_value=0',
  ];
  for (const sql of stmts) {
    try { db.exec(sql); } catch { /* column/table may not exist */ }
  }
}

function resetSqliteSequence(db, wiped) {
  if (!tableExists(db, 'sqlite_sequence') || !wiped.length) return;
  const ph = wiped.map(() => '?').join(',');
  try {
    db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${ph})`).run(...wiped);
  } catch { /* optional */ }
}

function clearTransactionalSettings(db) {
  const keys = [
    'warehouse_stock_seeded_v1',
    'accounting_backfill_v1',
    'opening_inventory_ledger_backfill_v1',
  ];
  try {
    const ph = keys.map(() => '?').join(',');
    db.prepare(`DELETE FROM settings WHERE key IN (${ph})`).run(...keys);
  } catch { /* ignore */ }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ mode?: 'transactions'|'full'|'wipe_master'|'new-company' }} [opts]
 * @returns {{ wiped: string[], skipped: string[], leftover: Record<string, number>, counts: Record<string, number> }}
 */
function purgeTransactionalData(db, opts = {}) {
  const mode = opts.mode || 'transactions';
  const keep = keepSetForMode(mode);
  const tables = listUserTables(db);
  const toWipe = tables.filter((t) => !keep.has(t));
  const skipped = tables.filter((t) => keep.has(t));
  const wiped = [];
  const errors = [];

  const prevFk = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    const run = db.transaction(() => {
      for (const t of toWipe) {
        try {
          db.prepare(`DELETE FROM ${assertSafeTable(t)}`).run();
          wiped.push(t);
        } catch (e) {
          errors.push(t + ': ' + (e.message || e));
        }
      }
      resetMasterBalances(db);
      if (mode === 'full' || mode === 'wipe_master') {
        try { db.prepare('DELETE FROM warehouse_stock').run(); } catch { /* ignore */ }
      }
      resetSqliteSequence(db, wiped);
      clearTransactionalSettings(db);
      if (mode === 'full' || mode === 'wipe_master') {
        try { db.prepare('UPDATE users SET party_id=NULL').run(); } catch { /* column may not exist */ }
      }
      if (typeof opts.after === 'function') opts.after(db);
    });
    run();
  } finally {
    db.pragma(`foreign_keys = ${prevFk ? 'ON' : 'OFF'}`);
  }

  if (errors.length) {
    const err = new Error('پاک‌سازی ناقص ماند: ' + errors.slice(0, 8).join('؛ '));
    err.code = 'CLEAN_SLATE_INCOMPLETE';
    err.errors = errors;
    throw err;
  }

  const leftover = {};
  for (const t of TXN_PROBE) {
    const n = countRows(db, t);
    if (n > 0) leftover[t] = n;
  }
  if (Object.keys(leftover).length) {
    const err = new Error('پس از پاک‌سازی هنوز سند باقی است: ' + JSON.stringify(leftover));
    err.code = 'CLEAN_SLATE_LEFTOVER';
    err.leftover = leftover;
    throw err;
  }

  return {
    wiped,
    skipped,
    leftover,
    counts: snapshotTxnCounts(db),
    mode,
  };
}

function isWorkspaceClean(db) {
  const counts = snapshotTxnCounts(db);
  return {
    clean: Object.values(counts).every((n) => n === 0),
    counts,
  };
}

module.exports = {
  ALWAYS_KEEP,
  MASTER_KEEP,
  TXN_PROBE,
  listUserTables,
  snapshotTxnCounts,
  purgeTransactionalData,
  isWorkspaceClean,
};
