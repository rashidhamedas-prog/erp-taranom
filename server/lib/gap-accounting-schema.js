/**
 * Accounting gap schema (docs/ACCOUNTING-GAP-ANALYSIS.md) — idempotent.
 * Moadian fields, cheque collection, bank recon, reserves, NRV, budgeting, payroll accruals.
 */
function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function seedCoa(db, code, name, type, parent) {
  try {
    db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code) VALUES (?,?,?,?)')
      .run(code, name, type, parent);
  } catch (_) { /* chart may differ */ }
}

function initGapAccountingSchema(db) {
  // ---- Phase 1: Moadian / VAT fields ----
  ensureColumn(db, 'invoices', 'moadian_invoice_type', 'INTEGER DEFAULT 1');
  ensureColumn(db, 'invoices', 'buyer_economic_code', 'TEXT');
  ensureColumn(db, 'invoices', 'moadian_ref_tax_id', 'TEXT');
  ensureColumn(db, 'invoices', 'moadian_correction_type', 'TEXT');
  ensureColumn(db, 'products', 'tax_stuff_id', 'TEXT');
  ensureColumn(db, 'customers', 'economic_code', 'TEXT');
  ensureColumn(db, 'moadian_queue', 'invoice_type', 'INTEGER DEFAULT 1');
  ensureColumn(db, 'moadian_queue', 'adapter', "TEXT DEFAULT 'stub'");

  // ---- Phase 2/3: COA seeds for new keys ----
  seedCoa(db, '1116', 'اسناد در جریان وصول', 'asset', '11');
  seedCoa(db, '3103', 'اندوخته قانونی', 'equity', '31');
  seedCoa(db, '2102', 'ذخیره مطالبات مشکوک‌الوصول', 'liability', '21');
  seedCoa(db, '6112', 'هزینه مطالبات مشکوک‌الوصول', 'expense', '61');
  seedCoa(db, '1117', 'ذخیره کاهش ارزش موجودی', 'asset', '11');
  seedCoa(db, '6113', 'هزینه کاهش ارزش موجودی', 'expense', '61');
  seedCoa(db, '3104', 'مازاد تجدید ارزیابی', 'equity', '31');
  seedCoa(db, '2110', 'ذخیره مزایای پایان خدمت', 'liability', '21');
  seedCoa(db, '2111', 'ذخیره عیدی کارکنان', 'liability', '21');

  // ---- Cheque cycle ----
  ensureColumn(db, 'cheque_records', 'lifecycle_status', "TEXT DEFAULT 'registered'");
  ensureColumn(db, 'cheque_records', 'collection_bank_id', 'INTEGER');
  ensureColumn(db, 'cheque_records', 'collection_je_id', 'INTEGER');
  ensureColumn(db, 'cheque_records', 'cleared_je_id', 'INTEGER');
  ensureColumn(db, 'cheque_records', 'bounced_je_id', 'INTEGER');
  ensureColumn(db, 'settlements', 'cheque_lifecycle', "TEXT DEFAULT ''");

  // ---- Bank reconciliation ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS bank_reconciliations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_id INTEGER NOT NULL,
      statement_date TEXT NOT NULL,
      statement_balance_rial INTEGER NOT NULL DEFAULT 0,
      book_balance_rial INTEGER NOT NULL DEFAULT 0,
      status TEXT DEFAULT 'open',
      notes TEXT DEFAULT '',
      adjustment_je_id INTEGER,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      closed_at INTEGER,
      FOREIGN KEY(bank_id) REFERENCES banks(id)
    );
    CREATE TABLE IF NOT EXISTS bank_reconciliation_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciliation_id INTEGER NOT NULL,
      side TEXT NOT NULL,
      ref_type TEXT,
      ref_id INTEGER,
      description TEXT DEFAULT '',
      amount_rial INTEGER NOT NULL DEFAULT 0,
      matched INTEGER DEFAULT 0,
      statement_line INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(reconciliation_id) REFERENCES bank_reconciliations(id)
    );
    CREATE TABLE IF NOT EXISTS bank_statement_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciliation_id INTEGER NOT NULL,
      line_date TEXT NOT NULL,
      amount_rial INTEGER NOT NULL DEFAULT 0,
      description TEXT DEFAULT '',
      ref TEXT DEFAULT '',
      matched INTEGER DEFAULT 0,
      match_confidence INTEGER DEFAULT 0,
      matched_ref_type TEXT,
      matched_ref_id INTEGER,
      matched_item_id INTEGER,
      bank_item_id INTEGER,
      status TEXT DEFAULT 'active',
      deleted_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(reconciliation_id) REFERENCES bank_reconciliations(id)
    );
  `);
  ensureColumn(db, 'bank_reconciliation_items', 'match_confidence', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'bank_reconciliation_items', 'statement_line_id', 'INTEGER');
  ensureColumn(db, 'bank_statement_lines', 'match_confidence', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'bank_statement_lines', 'matched_ref_type', 'TEXT');
  ensureColumn(db, 'bank_statement_lines', 'matched_ref_id', 'INTEGER');
  ensureColumn(db, 'bank_statement_lines', 'matched_item_id', 'INTEGER');
  ensureColumn(db, 'bank_statement_lines', 'bank_item_id', 'INTEGER');
  ensureColumn(db, 'bank_statement_lines', 'status', "TEXT DEFAULT 'active'");
  ensureColumn(db, 'bank_statement_lines', 'deleted_at', 'INTEGER');

  // ---- Doubtful debts / NRV ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS doubtful_debt_provisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      as_of_date TEXT NOT NULL,
      method TEXT DEFAULT 'aging',
      total_rial INTEGER NOT NULL DEFAULT 0,
      je_id INTEGER,
      notes TEXT DEFAULT '',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS inventory_nrv_provisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      as_of_date TEXT NOT NULL,
      total_rial INTEGER NOT NULL DEFAULT 0,
      je_id INTEGER,
      notes TEXT DEFAULT '',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS inventory_nrv_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provision_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      qty REAL NOT NULL DEFAULT 0,
      cost_rial INTEGER NOT NULL DEFAULT 0,
      nrv_rial INTEGER NOT NULL DEFAULT 0,
      writedown_rial INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(provision_id) REFERENCES inventory_nrv_provisions(id),
      FOREIGN KEY(product_id) REFERENCES products(id)
    );
  `);

  // ---- Legal reserve log ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS legal_reserve_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fiscal_year_id INTEGER,
      profit_rial INTEGER NOT NULL DEFAULT 0,
      reserve_rial INTEGER NOT NULL DEFAULT 0,
      capital_rial INTEGER NOT NULL DEFAULT 0,
      je_id INTEGER,
      date TEXT,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);

  // ---- Fixed assets: declining + dispose ----
  ensureColumn(db, 'fixed_assets', 'depreciation_method', "TEXT DEFAULT 'straight'");
  ensureColumn(db, 'fixed_assets', 'declining_rate_pct', 'REAL DEFAULT 25');
  ensureColumn(db, 'fixed_assets', 'disposed_at', 'INTEGER');
  ensureColumn(db, 'fixed_assets', 'dispose_je_id', 'INTEGER');
  ensureColumn(db, 'fixed_assets', 'dispose_proceeds_rial', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'fixed_assets', 'revaluation_surplus_rial', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'fixed_asset_depreciation', 'status', "TEXT DEFAULT 'posted'");
  ensureColumn(db, 'fixed_asset_depreciation', 'je_id', 'INTEGER');
  ensureColumn(db, 'fixed_asset_depreciation', 'reversed_at', 'INTEGER');
  ensureColumn(db, 'fixed_asset_depreciation', 'reversed_by', 'INTEGER');

  // ---- Payroll monthly accruals + labor settings ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS payroll_labor_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL UNIQUE,
      min_wage_daily_rial INTEGER NOT NULL DEFAULT 0,
      housing_allowance_rial INTEGER NOT NULL DEFAULT 0,
      food_allowance_rial INTEGER NOT NULL DEFAULT 0,
      child_allowance_rial INTEGER NOT NULL DEFAULT 0,
      seniority_base_rial INTEGER NOT NULL DEFAULT 0,
      insurance_cap_monthly_rial INTEGER NOT NULL DEFAULT 0,
      overtime_factor REAL NOT NULL DEFAULT 1.4,
      night_factor REAL NOT NULL DEFAULT 1.35,
      friday_factor REAL NOT NULL DEFAULT 1.4,
      shift_factor REAL NOT NULL DEFAULT 1.225,
      tax_exemption_rial INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS payroll_monthly_accruals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_label TEXT NOT NULL,
      person_id INTEGER,
      severance_rial INTEGER NOT NULL DEFAULT 0,
      eidi_rial INTEGER NOT NULL DEFAULT 0,
      je_id INTEGER,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);

  // ---- Budgeting ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      fiscal_year_id INTEGER,
      year_label TEXT,
      status TEXT DEFAULT 'draft',
      notes TEXT DEFAULT '',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS budget_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      budget_id INTEGER NOT NULL,
      account_code TEXT,
      cost_center_id INTEGER,
      month INTEGER NOT NULL,
      amount_rial INTEGER NOT NULL DEFAULT 0,
      category TEXT DEFAULT 'opex',
      notes TEXT DEFAULT '',
      FOREIGN KEY(budget_id) REFERENCES budgets(id)
    );
  `);

  db.prepare("INSERT OR IGNORE INTO number_sequences (key,current_value) VALUES ('legal_reserve',0)").run();
  db.prepare("INSERT OR IGNORE INTO number_sequences (key,current_value) VALUES ('bank_recon',0)").run();
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('gap_accounting_schema_v1','1')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('portal_review_timeout_hours','72')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('company_capital_rial','0')").run();
}

module.exports = { initGapAccountingSchema };
