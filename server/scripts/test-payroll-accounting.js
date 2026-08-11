'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const testDb = path.join(__dirname, 'payroll-accounting-test.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch { /* absent */ }
}
process.env.DB_PATH = testDb;
process.env.SYNC_ROLE = 'device';

const { initDB, getDB } = require('../db');
const { calculatePayroll, calculateProgressiveTax } = require('../lib/payroll/engine');
const { postToLedger } = require('../lib/ledger');
const { acct } = require('../lib/coa-map');
const { SYNCABLE_TABLES } = require('../sync/tables');

initDB();
const db = getDB();

const requiredTables = [
  'payroll_periods', 'salary_structures', 'payroll_tax_brackets',
  'payroll_year_end_bonuses', 'projects', 'report_configurations', 'vat_records',
];
for (const table of requiredTables) {
  assert(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), `${table} missing`);
}

for (const [table, names] of Object.entries({
  salary_structures: ['base_wage_rial', 'housing_allowance_rial', 'child_allowance_rial'],
  payroll_records: ['gross_earnings_rial', 'income_tax_rial', 'net_pay_rial', 'sso_employer_rial'],
  payroll_year_end_bonuses: ['eidi_rial', 'severance_rial', 'net_pay_rial'],
  vat_records: ['base_amount_rial', 'vat_amount_rial'],
})) {
  const columns = new Map(db.prepare(`PRAGMA table_info(${table})`).all().map(c => [c.name, c.type]));
  for (const name of names) assert.strictEqual(columns.get(name), 'INTEGER', `${table}.${name} must be INTEGER`);
}

const period = {
  standard_days: 30, standard_hours_x100: 22000,
  employee_insurance_bp: 700, employer_insurance_bp: 2300,
};
const structure = {
  wage_basis: 'monthly', base_wage_rial: 300000000,
  housing_allowance_rial: 9000000, grocery_allowance_rial: 22000000,
  child_allowance_rial: 7000000, spouse_allowance_rial: 0,
  other_fixed_allowance_rial: 0, child_count: 1, marital_status: 0,
  insurance_type: 'sso', tax_exemption_percent_bp: 0,
  overtime_factor_bp: 14000, night_shift_factor_bp: 11500,
};
const brackets = [
  { bracket_order: 1, bracket_min_rial: 0, bracket_max_rial: 200000000, tax_rate_bp: 0 },
  { bracket_order: 2, bracket_min_rial: 200000000, bracket_max_rial: null, tax_rate_bp: 1000 },
];
const calculation = calculatePayroll({
  period, structure, brackets,
  input: {
    working_days_x100: 3000, regular_hours_x100: 22000,
    overtime_hours_x100: 1000, night_shift_hours_x100: 0,
    hardship_allowance_rial: 0, other_allowance_rial: 0,
    insurance_exempt_rial: 0, tax_exemption_rial: 0, other_deductions_rial: 0,
  },
});
assert.strictEqual(calculation.gross_earnings_rial, 357090904);
assert.strictEqual(calculation.sso_employee_rial, 24996363);
assert.strictEqual(calculation.sso_employer_rial, 82130908);
assert.strictEqual(calculation.income_tax_rial, 13209454);
assert.strictEqual(calculation.net_pay_rial, 318885087);
assert.strictEqual(calculateProgressiveTax(250000000, brackets), 5000000);

const journalId = db.transaction(() => postToLedger(db, {
  sourceType: 'payroll_test', sourceId: 1, date: '1405/04/31',
  description: 'تست سند حقوق', createdBy: 1,
  lines: [
    { ...acct(db, 'coa_payroll_expense'), debit: calculation.gross_earnings_rial / 10, credit: 0 },
    { ...acct(db, 'coa_employer_insurance_expense'), debit: calculation.sso_employer_rial / 10, credit: 0 },
    { ...acct(db, 'coa_payroll_payable'), debit: 0, credit: calculation.net_pay_rial / 10 },
    { ...acct(db, 'coa_sso_payable'), debit: 0, credit: (calculation.sso_employee_rial + calculation.sso_employer_rial) / 10 },
    { ...acct(db, 'coa_payroll_tax_payable'), debit: 0, credit: calculation.income_tax_rial / 10 },
  ],
}))();
const balance = db.prepare(`
  SELECT SUM(debit_rial) debit, SUM(credit_rial) credit FROM journal_lines WHERE entry_id=?
`).get(journalId);
assert.strictEqual(balance.debit, balance.credit);
assert.strictEqual(balance.debit, calculation.employer_cost_rial);

// Registry is APPEND-ONLY: payroll block must be present and in order,
// but new tables may legitimately follow it.
const syncNames = SYNCABLE_TABLES.map(t => t.name);
const payrollStart = syncNames.indexOf(requiredTables[0]);
assert(payrollStart >= 0, 'payroll sync block missing');
assert.deepStrictEqual(syncNames.slice(payrollStart, payrollStart + requiredTables.length), requiredTables);

const navSource = fs.readFileSync(path.join(__dirname, '../public/acc-nav.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const uiBundle = uiSource + '\n' + appSource;
// Model A nav: payroll is a top-level module with subgroups (اطلاعات پایه/عملیات/گزارشات)
assert(navSource.includes("title: 'حقوق و دستمزد'"), 'payroll navigation module missing');
assert(navSource.includes("'acc-payroll-processing'"), 'payroll processing nav item missing');
assert(navSource.includes("'acc-adv-reports'"), 'advanced reports nav item missing');
for (const fn of [
  'renderPayrollEmployees', 'renderSalaryStructures', 'renderPayrollPeriods',
  'renderPayrollTaxConfig', 'renderPayrollProcessing', 'renderPayrollYearEnd',
  'renderPayrollLegalReports', 'renderVatLedgerReport', 'renderCostAccountingReport',
  'renderFinancialReportDesigner',
]) assert(uiBundle.includes(`function ${fn}`) || uiBundle.includes(`async function ${fn}`), `${fn} UI missing`);
assert(appSource.includes('/export/insurance-csv'), 'DRAFT insurance CSV export UI missing');
assert(appSource.includes('/export/tax-csv'), 'DRAFT tax CSV export UI missing');
const payrollUiStart = Math.max(uiBundle.indexOf('HOURLY PAYROLL'), 0);
const payrollUiEnd = uiBundle.indexOf('PURCHASE INVOICES');
const payrollUi = payrollUiEnd > payrollUiStart
  ? uiBundle.slice(payrollUiStart, payrollUiEnd)
  : appSource;
assert(!payrollUi.includes('(ت)'), 'payroll UI still contains Toman unit');
for (const match of uiSource.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
  if (match[1].trim()) new Function(match[1]);
}

// Labor settings (insurance cap) must change net vs uncapped baseline.
{
  const capped = calculatePayroll({
    period, structure, brackets,
    laborSettings: { min_wage_daily_rial: 0, insurance_cap_monthly_rial: 100000000 },
    input: {
      working_days_x100: 3000, regular_hours_x100: 22000,
      overtime_hours_x100: 1000, night_shift_hours_x100: 0,
      hardship_allowance_rial: 0, other_allowance_rial: 0,
      insurance_exempt_rial: 0, tax_exemption_rial: 0, other_deductions_rial: 0,
    },
  });
  assert.strictEqual(capped.insurance_base_rial, 100000000);
  assert.notStrictEqual(capped.net_pay_rial, calculation.net_pay_rial);
}

db.close();
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch { /* absent */ }
}
console.log('✅ payroll/accounting schema, calculations, ledger and sync tests passed');
