#!/usr/bin/env node
/**
 * Go-live clean slate — wipe ALL business data, keep users + COA + settings skeleton.
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

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'erp.db');
if (!fs.existsSync(dbPath)) {
  console.error('DB not found:', dbPath);
  process.exit(1);
}

const bak = dbPath + '.pre-golive-' + new Date().toISOString().replace(/[:.]/g, '-') + '.bak';
fs.copyFileSync(dbPath, bak);
console.log('Backup:', bak);

const Database = require('better-sqlite3');
const db = new Database(dbPath);
db.pragma('foreign_keys = OFF');

const TABLES = [
  'journal_lines', 'journal_entries', 'journal_templates', 'voucher_drafts',
  'customer_ledger', 'person_ledger', 'supplier_ledger',
  'settlements', 'invoices', 'invoice_items', 'purchase_invoices', 'purchase_items',
  'supplier_payments', 'sales_returns', 'purchase_returns', 'expense_payments',
  'incentive_payments', 'account_transfers',
  'rep_payment_submissions', 'rep_expenses', 'rep_advances',
  'payroll_records', 'production_runs', 'production_events', 'production_idempotency',
  'stocktaking_items', 'stocktaking_sessions',
  'warehouse_moves', 'stock_logs', 'warehouse_stock',
  'inventory_ledger', 'inventory_cost_layers', 'inventory_batches', 'inventory_serials',
  'inventory_reservations', 'landed_cost_headers', 'landed_cost_lines',
  'consignments', 'trust_checks', 'cheque_records',
  'followups', 'orders', 'reminders', 'messages', 'ai_insights', 'app_notifications',
  'customers', 'suppliers', 'persons', 'parties',
  'products', 'product_categories',
  'banks', 'cash_boxes', 'check_categories',
  'detail_accounts', 'sms_log', 'audit_log',
  'sync_outbox', 'sync_conflicts', 'sync_tombstones',
];

const tx = db.transaction(() => {
  for (const t of TABLES) {
    try {
      const n = db.prepare(`DELETE FROM ${t}`).run().changes;
      if (n) console.log(`  cleared ${t}: ${n}`);
    } catch (e) {
      /* table may not exist */
    }
  }
  try { db.prepare("UPDATE number_sequences SET current_value=0").run(); } catch (_) {}
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
  try {
    db.prepare("DELETE FROM settings WHERE key IN ('coa_mode','warehouse_stock_seeded_v1','accounting_backfill_v1')").run();
  } catch (_) {}
});

tx();
db.pragma('foreign_keys = ON');
db.close();
console.log('✅ Go-live clean complete. Restart pm2 and load real data via Excel.');
