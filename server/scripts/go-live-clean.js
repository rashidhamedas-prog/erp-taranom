#!/usr/bin/env node
/**
 * Go-live clean slate — wipe ALL business data + chart_of_accounts,
 * keep users + non-financial settings, then rebuild base COA.
 *
 * Usage (central only):
 *   node server/scripts/go-live-clean.js --confirm=WIPE-ALL-FOR-GOLIVE
 *   DB_PATH=/path/to/erp.db node server/scripts/go-live-clean.js --confirm=WIPE-ALL-FOR-GOLIVE
 *
 * Creates a timestamped .bak copy next to the DB before wiping.
 */
const fs = require('fs');
const path = require('path');

const CONFIRM = 'WIPE-ALL-FOR-GOLIVE';
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

const bak = dbPath + '.pre-golive-' + new Date().toISOString().replace(/[:.]/g, '-') + '.bak';
fs.copyFileSync(dbPath, bak);
console.log('Backup:', bak);

const Database = require('better-sqlite3');
const { rebuildBaseCoa } = require('../lib/coa-map');
const db = new Database(dbPath);
db.pragma('foreign_keys = OFF');

const TABLES = [
  // journals / ledgers
  'journal_lines', 'journal_entries', 'journal_templates', 'voucher_drafts',
  'customer_ledger', 'person_ledger', 'supplier_ledger', 'rep_ledger',
  // commercial docs
  'settlements', 'invoices', 'invoice_items', 'purchase_invoices', 'purchase_items',
  'supplier_payments', 'sales_returns', 'purchase_returns', 'expense_payments',
  'incentive_payments', 'account_transfers', 'vat_records',
  // reps
  'rep_payment_submissions', 'rep_expenses', 'rep_advances', 'rep_visit_logs',
  'rep_call_logs', 'rep_settlements', 'rep_assignment_history',
  'rep_commission_tiers', 'rep_commission_rules', 'rep_territories',
  // payroll
  'payroll_records', 'payroll_periods', 'payroll_year_end_bonuses',
  'salary_structures', 'payroll_tax_brackets',
  // production ops + masters
  'production_variances', 'production_period_close', 'production_receipts',
  'production_waste', 'production_rework', 'production_subcontract',
  'production_overhead_applications', 'production_labor_entries',
  'production_material_issues', 'production_order_stages', 'production_orders',
  'production_runs', 'production_estimates', 'production_events', 'production_idempotency',
  'mrp_runs', 'mrp_suggestions',
  'bom_change_log', 'bom_outputs', 'bom_operations', 'bom_lines', 'bom_headers',
  'cost_center_rates', 'overhead_allocation_weights', 'overhead_allocation_rules',
  'user_cost_centers',
  // inventory
  'stocktaking_items', 'stocktaking_sessions',
  'warehouse_moves', 'stock_logs', 'warehouse_stock',
  'inventory_ledger', 'inventory_cost_layers', 'inventory_batches', 'inventory_serials',
  'inventory_reservations', 'landed_cost_headers', 'landed_cost_lines',
  'consignments', 'trust_checks', 'cheque_records',
  // CRM
  'followups', 'orders', 'reminders', 'messages', 'ai_insights', 'app_notifications',
  'marketer_carts', 'product_images', 'user_catalog_categories',
  // masters
  'customers', 'suppliers', 'persons', 'parties', 'party_groups',
  'person_categories', 'customer_groups', 'detail_accounts', 'detail_categories',
  'products', 'product_categories',
  'banks', 'cash_boxes', 'check_categories',
  'warehouses', 'expense_categories',
  // coding
  'chart_of_accounts',
  // ops logs / sync
  'sms_log', 'audit_log', 'sms_scheduled',
  'sync_outbox', 'sync_conflicts', 'sync_tombstones',
];

const SETTINGS_CLEAR = [
  'coa_mode',
  'warehouse_stock_seeded_v1',
  'accounting_backfill_v1',
  'product_categories_shared_backfill_v1',
  'product_categories_no_auto_seed_v1',
  'production_wh_raw_id',
  'production_wh_fg_id',
  'production_wh_sub_id',
  'production_wh_scrap_id',
  'production_wh_dist_id',
];

const SETTINGS_SET = [
  ['warehouses_user_cleared', '1'],
  ['product_categories_user_cleared', '1'],
  ['product_categories_no_auto_seed_v1', '1'],
  ['coa_mode', 'standard'],
];

const tx = db.transaction(() => {
  for (const t of TABLES) {
    try {
      const n = db.prepare(`DELETE FROM ${t}`).run().changes;
      if (n) console.log(`  cleared ${t}: ${n}`);
    } catch (_) {
      /* table may not exist */
    }
  }

  // Clear coa_* mappings so rebuild writes fresh
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
    const fy = db.prepare(`INSERT INTO fiscal_years (label, start_date, status) VALUES (?, ?, 'open')`)
      .run(label, todayJalali());
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
db.close();
console.log('✅ Go-live clean complete (business data wiped, base COA rebuilt). Restart pm2.');
