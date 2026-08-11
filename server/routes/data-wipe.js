/**
 * Section-based data wipe for test/QA environments.
 * Modes: transactions | full (transactions + masters for that section).
 * Never touches: users, settings, chart_of_accounts, api_keys, fiscal_years.
 */
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { getDB, audit } = require('../db');
const { auth, adminOnly, centralOnlyStrict } = require('../middleware/auth');

const PROTECTED = new Set([
  'users', 'settings', 'chart_of_accounts', 'api_keys', 'fiscal_years',
  'number_sequences', 'sync_outbox', 'sync_seq', 'tombstones',
]);

const SECTIONS = {
  erp: {
    label: 'ERP / مشتریان',
    transactions: [
      'followups', 'orders', 'reminders', 'messages', 'customer_ledger',
      'ai_insights', 'app_notifications',
    ],
    full: [
      'followups', 'orders', 'reminders', 'messages', 'customer_ledger',
      'ai_insights', 'app_notifications', 'customers',
    ],
    afterTx: (db) => {
      try { db.prepare('UPDATE customers SET balance=0, churn_score=0').run(); } catch (_) {}
    },
    afterFull: (db) => {
      try { db.prepare("UPDATE parties SET legacy_id=NULL, legacy_table=NULL WHERE legacy_table='customers'").run(); } catch (_) {}
    },
  },
  sales: {
    label: 'فروش / فاکتورها',
    transactions: [
      'settlements', 'sales_returns', 'incentive_payments', 'vat_records', 'invoices',
    ],
    full: [
      'settlements', 'sales_returns', 'incentive_payments', 'vat_records', 'invoices',
    ],
  },
  purchases: {
    label: 'خرید / تأمین‌کنندگان',
    transactions: [
      'purchase_returns', 'supplier_payments', 'supplier_ledger', 'purchase_invoices',
    ],
    full: [
      'purchase_returns', 'supplier_payments', 'supplier_ledger', 'purchase_invoices', 'suppliers',
    ],
  },
  products: {
    label: 'کالاها / انبار',
    transactions: [
      'warehouse_moves', 'stock_logs', 'stocktaking_items', 'stocktaking_sessions',
      'inventory_ledger', 'inventory_cost_layers', 'inventory_batches', 'inventory_serials',
      'inventory_reservations', 'landed_cost_headers', 'landed_cost_lines', 'consignments',
    ],
    full: [
      'warehouse_moves', 'stock_logs', 'stocktaking_items', 'stocktaking_sessions',
      'inventory_ledger', 'inventory_cost_layers', 'inventory_batches', 'inventory_serials',
      'inventory_reservations', 'landed_cost_headers', 'landed_cost_lines', 'consignments',
      'warehouse_stock', 'products', 'product_categories',
    ],
    afterTx: (db) => {
      try { db.prepare('UPDATE products SET stock=0').run(); } catch (_) {}
      try { db.prepare('UPDATE warehouse_stock SET qty=0').run(); } catch (_) {}
    },
  },
  parties: {
    label: 'اشخاص / گروه‌ها',
    transactions: ['person_ledger'],
    full: [
      'person_ledger', 'persons', 'parties', 'party_groups', 'detail_accounts', 'detail_categories',
      'person_categories', 'customer_groups',
    ],
    afterFull: (db) => {
      try { db.prepare('UPDATE customers SET party_id=NULL, party_group_id=NULL').run(); } catch (_) {}
      try { db.prepare('UPDATE suppliers SET party_id=NULL, party_group_id=NULL').run(); } catch (_) {}
    },
  },
  accounting: {
    label: 'حسابداری / اسناد',
    transactions: [
      'journal_lines', 'journal_entries', 'journal_templates', 'voucher_drafts',
      'account_transfers', 'expense_payments',
    ],
    full: [
      'journal_lines', 'journal_entries', 'journal_templates', 'voucher_drafts',
      'account_transfers', 'expense_payments',
    ],
  },
  cash: {
    label: 'نقد / بانک / چک',
    transactions: ['trust_checks', 'cheque_records', 'rep_payment_submissions'],
    full: [
      'trust_checks', 'cheque_records', 'rep_payment_submissions',
      'banks', 'cash_boxes', 'check_categories',
    ],
  },
  production: {
    label: 'تولید',
    transactions: [
      'production_variances', 'production_period_close', 'production_receipts',
      'production_waste', 'production_rework', 'production_subcontract',
      'production_overhead_applications', 'production_labor_entries',
      'production_material_issues', 'production_order_stages', 'production_orders',
      'production_runs', 'production_estimates', 'mrp_runs', 'mrp_suggestions',
    ],
    full: [
      'production_variances', 'production_period_close', 'production_receipts',
      'production_waste', 'production_rework', 'production_subcontract',
      'production_overhead_applications', 'production_labor_entries',
      'production_material_issues', 'production_order_stages', 'production_orders',
      'production_runs', 'production_estimates', 'mrp_runs', 'mrp_suggestions',
      'bom_change_log', 'bom_outputs', 'bom_operations', 'bom_lines', 'bom_headers',
      'cost_center_rates', 'overhead_allocation_weights', 'overhead_allocation_rules',
    ],
  },
  payroll: {
    label: 'حقوق و دستمزد',
    transactions: [
      'payroll_records', 'payroll_periods', 'payroll_year_end_bonuses',
    ],
    full: [
      'payroll_records', 'payroll_periods', 'payroll_year_end_bonuses',
      'salary_structures', 'payroll_tax_brackets',
    ],
  },
  reps: {
    label: 'ویزیتورها / نمایندگان',
    transactions: [
      'rep_visit_logs', 'rep_call_logs', 'rep_expenses', 'rep_advances',
      'rep_settlements', 'rep_ledger', 'rep_assignment_history',
      'rep_commission_tiers', 'rep_commission_rules',
    ],
    full: [
      'rep_visit_logs', 'rep_call_logs', 'rep_expenses', 'rep_advances',
      'rep_settlements', 'rep_ledger', 'rep_assignment_history',
      'rep_commission_tiers', 'rep_commission_rules', 'rep_territories',
    ],
  },
};

function tableExists(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function countRows(db, name) {
  if (!tableExists(db, name)) return 0;
  try { return db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get().c || 0; } catch (_) { return 0; }
}

function wipeTables(db, tables) {
  const wiped = [];
  const skipped = [];
  for (const t of tables) {
    if (PROTECTED.has(t)) { skipped.push(t); continue; }
    if (!tableExists(db, t)) { skipped.push(t); continue; }
    try {
      db.prepare(`DELETE FROM ${t}`).run();
      wiped.push(t);
    } catch (e) {
      skipped.push(t + ':' + e.message);
    }
  }
  return { wiped, skipped };
}

router.get('/sections', auth, adminOnly, centralOnlyStrict, (req, res) => {
  const db = getDB();
  const list = Object.entries(SECTIONS).map(([key, sec]) => {
    const txTables = sec.transactions || [];
    const fullTables = sec.full || [];
    const txCount = txTables.reduce((a, t) => a + countRows(db, t), 0);
    const fullCount = fullTables.reduce((a, t) => a + countRows(db, t), 0);
    return {
      key,
      label: sec.label,
      tx_tables: txTables.length,
      full_tables: fullTables.length,
      tx_rows: txCount,
      full_rows: fullCount,
      confirm_prefix: 'WIPE-' + key.toUpperCase(),
    };
  });
  res.json(list);
});

router.post('/wipe', auth, adminOnly, centralOnlyStrict, (req, res) => {
  const { section, mode, confirm_text, confirm_password } = req.body || {};
  const sec = SECTIONS[section];
  if (!sec) return res.status(400).json({ error: 'بخش نامعتبر است' });
  if (mode !== 'transactions' && mode !== 'full') {
    return res.status(400).json({ error: 'mode باید transactions یا full باشد' });
  }
  const expected = 'WIPE-' + String(section).toUpperCase();
  if (confirm_text !== expected) {
    return res.status(400).json({ error: `متن تأیید نادرست است — ${expected} را تایپ کنید` });
  }
  const db = getDB();
  const user = db.prepare('SELECT password FROM users WHERE id=?').get(req.user.id);
  if (!user || !bcrypt.compareSync(confirm_password || '', user.password)) {
    return res.status(403).json({ error: 'رمز عبور نادرست است' });
  }

  const tables = mode === 'full' ? (sec.full || []) : (sec.transactions || []);
  let result;
  db.transaction(() => {
    result = wipeTables(db, tables);
    if (mode === 'transactions' && typeof sec.afterTx === 'function') sec.afterTx(db);
    if (mode === 'full' && typeof sec.afterFull === 'function') sec.afterFull(db);
  })();

  audit(
    req.user.id,
    'data_wipe',
    'section:' + section,
    null,
    `wipe mode=${mode} wiped=${(result.wiped || []).join(',')}`
  );
  res.json({
    ok: true,
    section,
    mode,
    wiped: result.wiped,
    skipped: result.skipped,
  });
});

module.exports = router;
