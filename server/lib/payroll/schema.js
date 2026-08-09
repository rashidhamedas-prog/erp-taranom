'use strict';

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

function ensureColumn(db, table, name, definition) {
  if (!columns(db, table).includes(name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

function initPayrollSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payroll_periods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fiscal_year INTEGER NOT NULL,
      month_no INTEGER NOT NULL CHECK(month_no BETWEEN 1 AND 12),
      label TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      standard_days INTEGER NOT NULL DEFAULT 30,
      standard_hours_x100 INTEGER NOT NULL DEFAULT 22000,
      employee_insurance_bp INTEGER NOT NULL DEFAULT 700,
      employer_insurance_bp INTEGER NOT NULL DEFAULT 2300,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','processed','closed')),
      processed_at INTEGER,
      closed_at INTEGER,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(fiscal_year, month_no)
    );

    CREATE TABLE IF NOT EXISTS salary_structures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL,
      fiscal_year INTEGER NOT NULL,
      wage_basis TEXT NOT NULL DEFAULT 'monthly'
        CHECK(wage_basis IN ('monthly','daily','hourly','contractor')),
      base_wage_rial INTEGER NOT NULL DEFAULT 0,
      housing_allowance_rial INTEGER NOT NULL DEFAULT 0,
      grocery_allowance_rial INTEGER NOT NULL DEFAULT 0,
      child_allowance_rial INTEGER NOT NULL DEFAULT 0,
      spouse_allowance_rial INTEGER NOT NULL DEFAULT 0,
      other_fixed_allowance_rial INTEGER NOT NULL DEFAULT 0,
      child_count INTEGER NOT NULL DEFAULT 0,
      marital_status INTEGER NOT NULL DEFAULT 0,
      insurance_type TEXT NOT NULL DEFAULT 'sso'
        CHECK(insurance_type IN ('sso','armed_forces','none')),
      tax_exemption_type TEXT NOT NULL DEFAULT 'none'
        CHECK(tax_exemption_type IN ('none','veteran','petroleum_zones')),
      tax_exemption_percent_bp INTEGER NOT NULL DEFAULT 0,
      overtime_factor_bp INTEGER NOT NULL DEFAULT 14000,
      night_shift_factor_bp INTEGER NOT NULL DEFAULT 11500,
      active INTEGER NOT NULL DEFAULT 1,
      effective_from TEXT,
      effective_to TEXT,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(person_id, fiscal_year),
      FOREIGN KEY(person_id) REFERENCES persons(id)
    );

    CREATE TABLE IF NOT EXISTS payroll_tax_brackets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fiscal_year INTEGER NOT NULL,
      bracket_order INTEGER NOT NULL,
      bracket_min_rial INTEGER NOT NULL DEFAULT 0,
      bracket_max_rial INTEGER,
      tax_rate_bp INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(fiscal_year, bracket_order)
    );

    CREATE TABLE IF NOT EXISTS payroll_year_end_bonuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL,
      fiscal_year INTEGER NOT NULL,
      service_days INTEGER NOT NULL DEFAULT 365,
      eidi_rial INTEGER NOT NULL DEFAULT 0,
      severance_rial INTEGER NOT NULL DEFAULT 0,
      tax_exempt_rial INTEGER NOT NULL DEFAULT 0,
      taxable_rial INTEGER NOT NULL DEFAULT 0,
      income_tax_rial INTEGER NOT NULL DEFAULT 0,
      net_pay_rial INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','posted','paid','reversed')),
      journal_entry_id INTEGER,
      reversal_journal_id INTEGER,
      posted_at INTEGER,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(person_id, fiscal_year),
      FOREIGN KEY(person_id) REFERENCES persons(id)
    );

    CREATE INDEX IF NOT EXISTS idx_salary_structures_person_year
      ON salary_structures(person_id, fiscal_year);
    CREATE INDEX IF NOT EXISTS idx_payroll_tax_brackets_year
      ON payroll_tax_brackets(fiscal_year, bracket_order);
    CREATE INDEX IF NOT EXISTS idx_payroll_periods_status
      ON payroll_periods(status, fiscal_year, month_no);
  `);

  const personColumns = [
    ['personnel_code', 'TEXT'],
    ['first_name', 'TEXT'],
    ['last_name', 'TEXT'],
    ['insurance_id', 'TEXT'],
    ['tax_id', 'TEXT'],
    ['employment_type', 'TEXT'],
    ['termination_date', 'TEXT'],
    ['tax_exemption_type', 'TEXT'],
    ['insurance_type', 'TEXT'],
  ];
  for (const [name, definition] of personColumns) ensureColumn(db, 'persons', name, definition);

  const payrollColumns = [
    ['period_id', 'INTEGER'],
    ['working_days_x100', 'INTEGER DEFAULT 0'],
    ['regular_hours_x100', 'INTEGER DEFAULT 0'],
    ['overtime_hours_x100', 'INTEGER DEFAULT 0'],
    ['night_shift_hours_x100', 'INTEGER DEFAULT 0'],
    ['base_pay_rial', 'INTEGER DEFAULT 0'],
    ['housing_allowance_rial', 'INTEGER DEFAULT 0'],
    ['grocery_allowance_rial', 'INTEGER DEFAULT 0'],
    ['child_allowance_rial', 'INTEGER DEFAULT 0'],
    ['spouse_allowance_rial', 'INTEGER DEFAULT 0'],
    ['hardship_allowance_rial', 'INTEGER DEFAULT 0'],
    ['other_allowance_rial', 'INTEGER DEFAULT 0'],
    ['overtime_pay_rial', 'INTEGER DEFAULT 0'],
    ['night_shift_pay_rial', 'INTEGER DEFAULT 0'],
    ['gross_earnings_rial', 'INTEGER DEFAULT 0'],
    ['insurance_base_rial', 'INTEGER DEFAULT 0'],
    ['taxable_income_rial', 'INTEGER DEFAULT 0'],
    ['income_tax_rial', 'INTEGER DEFAULT 0'],
    ['sso_employee_rial', 'INTEGER DEFAULT 0'],
    ['sso_employer_rial', 'INTEGER DEFAULT 0'],
    ['other_deductions_rial', 'INTEGER DEFAULT 0'],
    ['net_pay_rial', 'INTEGER DEFAULT 0'],
    ['employer_cost_rial', 'INTEGER DEFAULT 0'],
    ['status', "TEXT DEFAULT 'posted'"],
    ['journal_entry_id', 'INTEGER'],
    ['payment_journal_id', 'INTEGER'],
    ['reversal_journal_id', 'INTEGER'],
    ['paid_at', 'INTEGER'],
    ['reversed_at', 'INTEGER'],
  ];
  for (const [name, definition] of payrollColumns) ensureColumn(db, 'payroll_records', name, definition);

  const coaColumns = [
    ['balance_type', "TEXT DEFAULT 'trial_balance'"],
    ['is_cost_element', 'INTEGER DEFAULT 0'],
  ];
  for (const [name, definition] of coaColumns) ensureColumn(db, 'chart_of_accounts', name, definition);

  const entryColumns = [
    ['doc_type', 'TEXT'],
    ['is_closing', 'INTEGER DEFAULT 0'],
  ];
  for (const [name, definition] of entryColumns) ensureColumn(db, 'journal_entries', name, definition);

  const lineColumns = [
    ['cost_center_id', 'INTEGER'],
    ['project_id', 'INTEGER'],
    ['tax_type', 'TEXT'],
  ];
  for (const [name, definition] of lineColumns) ensureColumn(db, 'journal_lines', name, definition);

  db.exec(`
    CREATE TABLE IF NOT EXISTS employee_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS group_salary_structures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_group_id INTEGER NOT NULL,
      fiscal_year INTEGER NOT NULL,
      wage_basis TEXT NOT NULL DEFAULT 'monthly'
        CHECK(wage_basis IN ('monthly','daily','hourly','contractor')),
      base_wage_rial INTEGER NOT NULL DEFAULT 0,
      housing_allowance_rial INTEGER NOT NULL DEFAULT 0,
      grocery_allowance_rial INTEGER NOT NULL DEFAULT 0,
      child_allowance_rial INTEGER NOT NULL DEFAULT 0,
      spouse_allowance_rial INTEGER NOT NULL DEFAULT 0,
      other_fixed_allowance_rial INTEGER NOT NULL DEFAULT 0,
      child_count INTEGER NOT NULL DEFAULT 0,
      marital_status INTEGER NOT NULL DEFAULT 0,
      insurance_type TEXT NOT NULL DEFAULT 'sso'
        CHECK(insurance_type IN ('sso','armed_forces','none')),
      tax_exemption_type TEXT NOT NULL DEFAULT 'none'
        CHECK(tax_exemption_type IN ('none','veteran','petroleum_zones')),
      tax_exemption_percent_bp INTEGER NOT NULL DEFAULT 0,
      overtime_factor_bp INTEGER NOT NULL DEFAULT 14000,
      night_shift_factor_bp INTEGER NOT NULL DEFAULT 11500,
      active INTEGER NOT NULL DEFAULT 1,
      effective_from TEXT,
      effective_to TEXT,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(employee_group_id, fiscal_year),
      FOREIGN KEY(employee_group_id) REFERENCES employee_groups(id)
    );
    CREATE INDEX IF NOT EXISTS idx_group_salary_structures_group_year
      ON group_salary_structures(employee_group_id, fiscal_year);
  `);
  ensureColumn(db, 'persons', 'employee_group_id', 'INTEGER');

  // W1-HR1: immutable params snapshot captured at period process time
  ensureColumn(db, 'payroll_periods', 'params_snapshot_json', 'TEXT');

  // Versioned labor settings (effective dating); year row remains for backward compat
  db.exec(`
    CREATE TABLE IF NOT EXISTS payroll_labor_settings_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      min_daily_wage_rial INTEGER NOT NULL DEFAULT 0,
      housing_allowance_rial INTEGER NOT NULL DEFAULT 0,
      grocery_allowance_rial INTEGER NOT NULL DEFAULT 0,
      child_allowance_rial INTEGER NOT NULL DEFAULT 0,
      seniority_daily_rial INTEGER NOT NULL DEFAULT 0,
      insurance_base_cap_rial INTEGER NOT NULL DEFAULT 0,
      tax_exemption_rial INTEGER NOT NULL DEFAULT 0,
      overtime_factor_bp INTEGER NOT NULL DEFAULT 14000,
      night_factor_bp INTEGER NOT NULL DEFAULT 13500,
      friday_factor_bp INTEGER NOT NULL DEFAULT 14000,
      shift_factor_bp INTEGER NOT NULL DEFAULT 0,
      note TEXT DEFAULT '',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_labor_versions_year
      ON payroll_labor_settings_versions(year, effective_from);
  `);
}

/**
 * Build a frozen snapshot of labor settings + tax brackets for a fiscal year.
 */
function buildPayrollParamsSnapshot(db, year) {
  const labor = db.prepare('SELECT * FROM payroll_labor_settings WHERE year=?').get(year) || null;
  const brackets = db.prepare(
    'SELECT * FROM payroll_tax_brackets WHERE fiscal_year=? AND active=1 ORDER BY bracket_order'
  ).all(year);
  return {
    captured_at: Math.floor(Date.now() / 1000),
    year: Number(year),
    labor,
    brackets,
  };
}

function savePeriodParamsSnapshot(db, periodId, snapshot) {
  db.prepare('UPDATE payroll_periods SET params_snapshot_json=? WHERE id=?')
    .run(JSON.stringify(snapshot), periodId);
}

function loadPeriodParamsSnapshot(db, periodId) {
  const row = db.prepare('SELECT params_snapshot_json, status FROM payroll_periods WHERE id=?').get(periodId);
  if (!row || !row.params_snapshot_json) return null;
  try {
    return JSON.parse(row.params_snapshot_json);
  } catch (_) {
    return null;
  }
}

/**
 * Prefer snapshot for processed periods; otherwise live settings.
 */
function resolveLaborSettingsForPeriod(db, period) {
  if (!period) return null;
  if (period.status === 'processed' || period.status === 'closed') {
    const snap = loadPeriodParamsSnapshot(db, period.id);
    if (snap?.labor) return snap.labor;
  }
  return db.prepare('SELECT * FROM payroll_labor_settings WHERE year=?').get(period.fiscal_year) || null;
}

module.exports = {
  initPayrollSchema,
  buildPayrollParamsSnapshot,
  savePeriodParamsSnapshot,
  loadPeriodParamsSnapshot,
  resolveLaborSettingsForPeriod,
};
