#!/usr/bin/env node
/**
 * Clean-slate wipe that KEEPS products + product images (+ categories / warehouse stock).
 *
 * Removes customers, parties, ledgers, journals, invoices, reps, banks, messages, …
 * Keeps: products, product_images, product_categories, warehouses, warehouse_stock,
 *        admin user(s), settings shell, then rebuilds base COA.
 *
 * Usage (central / production):
 *   node server/scripts/keep-products-clean.js --confirm=WIPE-KEEP-PRODUCTS
 *   DB_PATH=/path/to/crm.db node server/scripts/keep-products-clean.js --confirm=WIPE-KEEP-PRODUCTS
 *
 * Creates a timestamped .bak next to the DB before wiping.
 * Does NOT delete files under uploads/products (or public/uploads product filenames).
 */
const fs = require('fs');
const path = require('path');

const CONFIRM = 'WIPE-KEEP-PRODUCTS';
const arg = process.argv.find((a) => a.startsWith('--confirm='));
const confirm = arg ? arg.slice('--confirm='.length) : '';
if (confirm !== CONFIRM) {
  console.error(`Refuse: pass --confirm=${CONFIRM}`);
  process.exit(1);
}

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'crm.db');
if (!fs.existsSync(dbPath)) {
  console.error('DB not found:', dbPath);
  process.exit(1);
}

const bak = dbPath + '.pre-keep-products-' + new Date().toISOString().replace(/[:.]/g, '-') + '.bak';
fs.copyFileSync(dbPath, bak);
console.log('Backup:', bak);

const Database = require('better-sqlite3');
const { rebuildBaseCoa } = require('../lib/coa-map');
const db = new Database(dbPath);
db.pragma('foreign_keys = OFF');

/** Tables / masters that must survive this wipe. */
const KEEP = new Set([
  'products',
  'product_images',
  'product_categories',
  'warehouses',
  'warehouse_stock',
  'users',
  'settings',
  'fiscal_years',
  'number_sequences',
  'units_of_measure',
  'cost_centers',
  // sync cursor — do not reset under live product sync_seq values
  'global_seq',
  // sqlite internals
  'sqlite_sequence',
]);

/** Explicit wipe order for known heavy / FK-sensitive tables (best-effort). */
const WIPE_FIRST = [
  'journal_lines', 'journal_entries', 'journal_templates', 'voucher_drafts',
  'customer_ledger', 'person_ledger', 'supplier_ledger', 'rep_ledger',
  'settlements', 'invoice_items', 'invoices', 'purchase_items', 'purchase_invoices',
  'supplier_payments', 'sales_returns', 'purchase_returns', 'expense_payments',
  'incentive_payments', 'account_transfers', 'vat_records',
  'rep_payment_submissions', 'rep_expenses', 'rep_advances', 'rep_visit_logs',
  'rep_call_logs', 'rep_settlements', 'rep_assignment_history',
  'rep_commission_tiers', 'rep_commission_rules', 'rep_territories',
  'payroll_records', 'payroll_periods', 'payroll_year_end_bonuses',
  'salary_structures', 'payroll_tax_brackets',
  'production_variances', 'production_period_close', 'production_receipts',
  'production_waste', 'production_rework', 'production_subcontract',
  'production_overhead_applications', 'production_labor_entries',
  'production_material_issues', 'production_order_stages', 'production_orders',
  'production_runs', 'production_estimates', 'production_estimate_lines',
  'production_events', 'production_idempotency', 'production_reservations',
  'mrp_runs', 'mrp_suggestions', 'mrp_requirements',
  'bom_change_log', 'bom_outputs', 'bom_operations', 'bom_lines', 'bom_headers',
  'cost_center_rates', 'overhead_allocation_weights', 'overhead_allocation_rules',
  'user_cost_centers',
  'stocktaking_items', 'stocktaking_sessions',
  'warehouse_moves', 'stock_logs',
  'inventory_ledger', 'inventory_cost_layers', 'inventory_batches', 'inventory_serials',
  'inventory_reservations', 'landed_cost_headers', 'landed_cost_lines',
  'landed_cost_docs', 'landed_cost_allocations',
  'consignments', 'trust_checks', 'cheque_records',
  'followups', 'orders', 'reminders', 'messages', 'ai_insights', 'app_notifications',
  'marketer_carts', 'user_catalog_categories',
  'customers', 'suppliers', 'persons', 'parties', 'party_groups',
  'person_categories', 'customer_groups', 'detail_accounts', 'detail_categories',
  'banks', 'cash_boxes', 'check_categories', 'expense_categories',
  'pos_terminals', 'currencies', 'exchange_rates',
  'projects', 'report_configurations',
  'sms_log', 'sms_scheduled', 'audit_log',
  'sync_outbox', 'sync_conflicts', 'sync_tombstones',
  'two_factor_auth', 'api_keys', 'devices', 'paired_devices',
  'b2b_orders', 'b2b_order_items', 'portal_orders',
  'chart_of_accounts',
];

const SETTINGS_CLEAR = [
  'coa_mode',
  'warehouse_stock_seeded_v1',
  'accounting_backfill_v1',
  'product_categories_shared_backfill_v1',
  'production_wh_raw_id',
  'production_wh_fg_id',
  'production_wh_sub_id',
  'production_wh_scrap_id',
  'production_wh_dist_id',
];

const SETTINGS_SET = [
  ['coa_mode', 'standard'],
];

function allUserTables() {
  return db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map((r) => r.name);
}

function wipeTable(name) {
  if (KEEP.has(name)) return 0;
  try {
    const n = db.prepare(`DELETE FROM ${name}`).run().changes;
    if (n) console.log(`  cleared ${name}: ${n}`);
    return n;
  } catch (e) {
    console.warn(`  skip ${name}:`, e.message);
    return 0;
  }
}

const before = {
  products: db.prepare('SELECT COUNT(*) c FROM products').get().c,
  product_images: (() => {
    try { return db.prepare('SELECT COUNT(*) c FROM product_images').get().c; } catch (_) { return 0; }
  })(),
  customers: (() => {
    try { return db.prepare('SELECT COUNT(*) c FROM customers').get().c; } catch (_) { return 0; }
  })(),
  journal: (() => {
    try { return db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c; } catch (_) { return 0; }
  })(),
};

const tx = db.transaction(() => {
  const seen = new Set();
  for (const t of WIPE_FIRST) {
    wipeTable(t);
    seen.add(t);
  }
  // Catch any other business tables not listed above
  for (const t of allUserTables()) {
    if (seen.has(t) || KEEP.has(t)) continue;
    wipeTable(t);
  }

  // Drop product tafsil links (COA rebuilt below)
  try {
    db.prepare('UPDATE products SET coa_code=NULL').run();
    console.log('  nulled products.coa_code');
  } catch (_) {}

  // Keep only admin-role users (login). Remove field/office reps shown in UI.
  try {
    const removed = db.prepare(
      "DELETE FROM users WHERE role NOT IN ('admin','accounting') OR COALESCE(active,1)=0"
    ).run().changes;
    // Always keep at least one admin
    const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;
    if (!admins) {
      console.warn('  WARNING: no admin user left — skipping further user deletes');
    } else if (removed) {
      console.log(`  removed non-admin users: ${removed}`);
    }
    // Explicitly drop known demo field users if still present
    for (const u of ['aref', 'sharafi']) {
      const n = db.prepare('DELETE FROM users WHERE username=?').run(u).changes;
      if (n) console.log(`  deleted user @${u}`);
    }
  } catch (e) {
    console.warn('  users cleanup:', e.message);
  }

  try {
    db.prepare("DELETE FROM settings WHERE key LIKE 'coa_%'").run();
  } catch (_) {}
  try {
    const ph = SETTINGS_CLEAR.map(() => '?').join(',');
    db.prepare(`DELETE FROM settings WHERE key IN (${ph})`).run(...SETTINGS_CLEAR);
  } catch (_) {}

  try { db.prepare('UPDATE number_sequences SET current_value=0').run(); } catch (_) {}

  try {
    db.prepare("UPDATE fiscal_years SET status='closed' WHERE status='open'").run();
    const { todayJalali } = require('../jalali');
    const label = 'سال مالی ' + todayJalali().slice(0, 4);
    const fy = db.prepare(
      `INSERT INTO fiscal_years (label, start_date, status) VALUES (?, ?, 'open')`
    ).run(label, todayJalali());
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('active_fiscal_year_id',?)")
      .run(String(fy.lastInsertRowid));
    console.log('  new fiscal year:', label);
  } catch (e) {
    console.warn('  fiscal year reset skipped:', e.message);
  }

  for (const [k, v] of SETTINGS_SET) {
    try {
      db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(k, v);
    } catch (_) {}
  }

  const coaN = rebuildBaseCoa(db);
  console.log('  rebuilt base COA accounts:', coaN);
});

tx();
db.pragma('foreign_keys = ON');

const after = {
  products: db.prepare('SELECT COUNT(*) c FROM products').get().c,
  product_images: (() => {
    try { return db.prepare('SELECT COUNT(*) c FROM product_images').get().c; } catch (_) { return 0; }
  })(),
  customers: (() => {
    try { return db.prepare('SELECT COUNT(*) c FROM customers').get().c; } catch (_) { return 0; }
  })(),
  parties: (() => {
    try { return db.prepare('SELECT COUNT(*) c FROM parties').get().c; } catch (_) { return 0; }
  })(),
  journal: (() => {
    try { return db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c; } catch (_) { return 0; }
  })(),
  customer_ledger: (() => {
    try { return db.prepare('SELECT COUNT(*) c FROM customer_ledger').get().c; } catch (_) { return 0; }
  })(),
  invoices: (() => {
    try { return db.prepare('SELECT COUNT(*) c FROM invoices').get().c; } catch (_) { return 0; }
  })(),
  users: db.prepare('SELECT id,username,role FROM users').all(),
  coa: db.prepare('SELECT COUNT(*) c FROM chart_of_accounts').get().c,
  warehouses: (() => {
    try { return db.prepare('SELECT COUNT(*) c FROM warehouses').get().c; } catch (_) { return 0; }
  })(),
  warehouse_stock: (() => {
    try { return db.prepare('SELECT COUNT(*) c FROM warehouse_stock').get().c; } catch (_) { return 0; }
  })(),
};

db.close();

if (after.products !== before.products || after.product_images !== before.product_images) {
  console.error('❌ SAFETY FAIL: product counts changed', { before, after });
  process.exit(2);
}

console.log(JSON.stringify({ before, after }, null, 2));
console.log('✅ keep-products-clean complete. Restart pm2.');
