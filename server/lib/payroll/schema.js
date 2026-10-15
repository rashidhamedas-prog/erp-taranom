'use strict';

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

function ensureColumn(db, table, name, definition) {
  if (!columns(db, table).includes(name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

function expandTaxExemptionCheck(db, table) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!row || !row.sql || row.sql.includes("'tax_exempt'")) return;
  if (!/tax_exemption_type/.test(row.sql)) return;
  const tmp = `${table}__tax_ex`;
  const createSql = row.sql
    .replace(new RegExp(`CREATE TABLE(?: IF NOT EXISTS)?\\s+${table}\\b`, 'i'), `CREATE TABLE ${tmp}`)
    .replace(
      /CHECK\s*\(\s*tax_exemption_type\s+IN\s*\(\s*'none'\s*,\s*'veteran'\s*,\s*'petroleum_zones'\s*\)\s*\)/i,
      "CHECK(tax_exemption_type IN ('none','tax_exempt','veteran','petroleum_zones'))"
    );
  if (createSql === row.sql) return;
  const cols = columns(db, table);
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    db.exec(createSql);
    db.exec(`INSERT INTO ${tmp} (${cols.join(',')}) SELECT ${cols.join(',')} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
  } catch (e) {
    try { db.exec(`DROP TABLE IF EXISTS ${tmp}`); } catch (_) {}
    console.error('expandTaxExemptionCheck', table, e.message);
  } finally {
    db.exec('PRAGMA foreign_keys=ON');
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
        CHECK(tax_exemption_type IN ('none','tax_exempt','veteran','petroleum_zones')),
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
  ensureColumn(db, 'persons', 'is_tax_exempt', 'INTEGER DEFAULT 0');
  expandTaxExemptionCheck(db, 'salary_structures');

  // P0-HR1: freeze labor/insurance params used at process time (JSON snapshot).
  ensureColumn(db, 'payroll_periods', 'params_json', 'TEXT');

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
    ['reversed_by', 'INTEGER'],
    ['paid_rial', 'INTEGER DEFAULT 0'],
    ['settlement_mode', "TEXT DEFAULT 'labor'"],
    ['exempt_reason', 'TEXT'],
    ['exempt_note', 'TEXT'],
    ['cost_center_id', 'INTEGER'],
  ];
  for (const [name, definition] of payrollColumns) ensureColumn(db, 'payroll_records', name, definition);

  // Multi-leg salary settlements (partial / multi-source payments)
  db.exec(`
    CREATE TABLE IF NOT EXISTS payroll_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payroll_record_id INTEGER NOT NULL,
      amount_rial INTEGER NOT NULL DEFAULT 0,
      pay_type TEXT DEFAULT 'cash',
      bank_id INTEGER,
      cash_box_id INTEGER,
      date TEXT DEFAULT '',
      note TEXT DEFAULT '',
      journal_id INTEGER,
      reversal_journal_id INTEGER,
      status TEXT NOT NULL DEFAULT 'posted'
        CHECK(status IN ('posted','reversed')),
      legacy_ref_payroll_record INTEGER DEFAULT 0,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      reversed_at INTEGER,
      reversed_by INTEGER,
      FOREIGN KEY(payroll_record_id) REFERENCES payroll_records(id)
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_payments_record
      ON payroll_payments(payroll_record_id, status);
  `);

  // Backfill one payment row for historically fully-paid accruals
  try {
    const legacy = db.prepare(`
      SELECT id, net_pay_rial, net_pay, payment_journal_id, date, paid_at, created_by
      FROM payroll_records
      WHERE paid=1 AND payment_journal_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM payroll_payments pp WHERE pp.payroll_record_id = payroll_records.id
        )
    `).all();
    const ins = db.prepare(`
      INSERT INTO payroll_payments (
        payroll_record_id, amount_rial, pay_type, date, journal_id, status,
        legacy_ref_payroll_record, created_by, created_at
      ) VALUES (?,?, 'cash', ?, ?, 'posted', 1, ?, COALESCE(?, strftime('%s','now')))
    `);
    const updPaid = db.prepare('UPDATE payroll_records SET paid_rial=? WHERE id=?');
    for (const r of legacy) {
      const amt = Math.round(Number(r.net_pay_rial) || ((Number(r.net_pay) || 0) * 10));
      ins.run(r.id, amt, r.date || '', r.payment_journal_id, r.created_by || null, r.paid_at || null);
      updPaid.run(amt, r.id);
    }
  } catch (e) {
    console.warn('⚠️ payroll_payments backfill:', e.message);
  }

  try {
    db.prepare(`
      UPDATE payroll_records SET paid_rial = COALESCE((
        SELECT SUM(pp.amount_rial) FROM payroll_payments pp
        WHERE pp.payroll_record_id = payroll_records.id
          AND COALESCE(pp.status,'posted')<>'reversed'
      ), 0)
      WHERE COALESCE(paid_rial,0)=0 AND paid=1
    `).run();
  } catch (e) {
    console.warn('⚠️ payroll paid_rial sync:', e.message);
  }

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
  ensureColumn(db, 'person_ledger', 'deleted_at', 'INTEGER DEFAULT 0');

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
        CHECK(tax_exemption_type IN ('none','tax_exempt','veteran','petroleum_zones')),
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
  expandTaxExemptionCheck(db, 'group_salary_structures');

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

  try {
    require('./rulings').initSalaryRulingExtras(db);
  } catch (e) {
    console.error('initSalaryRulingExtras failed:', e.message);
    throw e;
  }
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
