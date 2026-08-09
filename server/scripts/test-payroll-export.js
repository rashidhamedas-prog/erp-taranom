'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const testDb = path.join(__dirname, 'payroll-export-test.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch { /* absent */ }
}
process.env.DB_PATH = testDb;
process.env.SYNC_ROLE = 'device';

const { initDB, getDB } = require('../db');
const { calculatePayroll } = require('../lib/payroll/engine');
const { buildInsuranceListCsv, buildTaxDraftCsv } = require('../lib/payroll/export-legal');

initDB();
const db = getDB();

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
const input = {
  working_days_x100: 3000, regular_hours_x100: 22000,
  overtime_hours_x100: 1000, night_shift_hours_x100: 0,
  hardship_allowance_rial: 0, other_allowance_rial: 0,
  insurance_exempt_rial: 0, tax_exemption_rial: 0, other_deductions_rial: 0,
};

const baseline = calculatePayroll({ period, structure, brackets, input });

// Insurance cap lowers SSO base → changes net (higher net expected when cap binds).
const capped = calculatePayroll({
  period, structure, brackets, input,
  laborSettings: { min_wage_daily_rial: 0, insurance_cap_monthly_rial: 100000000 },
});
assert.strictEqual(capped.insurance_base_rial, 100000000);
assert.ok(capped.sso_employee_rial < baseline.sso_employee_rial, 'cap must reduce employee SSO');
assert.notStrictEqual(capped.net_pay_rial, baseline.net_pay_rial, 'insurance cap must affect net');

// Min wage floor raises base when structure wage is below legal daily * days.
const lowStructure = { ...structure, base_wage_rial: 100000000 };
const floored = calculatePayroll({
  period, structure: lowStructure, brackets, input,
  laborSettings: { min_wage_daily_rial: 12000000, insurance_cap_monthly_rial: 0 },
});
const lowBaseline = calculatePayroll({ period, structure: lowStructure, brackets, input });
assert.ok(floored.base_pay_rial > lowBaseline.base_pay_rial, 'min wage must raise base pay');
assert.notStrictEqual(floored.net_pay_rial, lowBaseline.net_pay_rial, 'min wage must affect net');

// Labor-settings housing must NOT double-count on top of structure housing.
const withHousingNoise = calculatePayroll({
  period, structure, brackets, input,
  laborSettings: {
    min_wage_daily_rial: 0,
    insurance_cap_monthly_rial: 0,
    housing_allowance_rial: 999999999,
    food_allowance_rial: 999999999,
    child_allowance_rial: 999999999,
  },
});
assert.strictEqual(withHousingNoise.gross_earnings_rial, baseline.gross_earnings_rial);
assert.strictEqual(withHousingNoise.net_pay_rial, baseline.net_pay_rial);

// Fixtures for CSV export (fake national id — not a real person).
const personId = db.prepare(`
  INSERT INTO persons (name, personnel_code, employee_no, first_name, last_name,
    national_id, insurance_id, tax_id, active)
  VALUES ('کارمند تست', 'T-HR-001', 'T-HR-001', 'تست', 'کارمند',
    '0999988877', 'INS-TEST-001', 'TAX-TEST-001', 1)
`).run().lastInsertRowid;

const periodId = db.prepare(`
  INSERT INTO payroll_periods
    (fiscal_year, month_no, label, start_date, end_date, standard_days, standard_hours_x100,
     employee_insurance_bp, employer_insurance_bp, status, params_json)
  VALUES (1405, 4, '1405/04', '1405/04/01', '1405/04/31', 30, 22000, 700, 2300, 'processed', ?)
`).run(JSON.stringify({
  snapshot_at: 1,
  fiscal_year: 1405,
  labor_settings: { insurance_cap_monthly_rial: 100000000, min_wage_daily_rial: 0 },
})).lastInsertRowid;

assert.ok(
  db.prepare('SELECT params_json FROM payroll_periods WHERE id=?').get(periodId).params_json,
  'params_json column must persist snapshot'
);

db.prepare(`
  INSERT INTO payroll_records
    (person_id, period_id, period_label, gross_pay, net_pay, insurance_deduction, tax_deduction,
     date, paid, created_by, status, gross_earnings_rial, insurance_base_rial,
     sso_employee_rial, sso_employer_rial, taxable_income_rial, income_tax_rial, net_pay_rial)
  VALUES (?,?,?,?,?,?,?,?,0,1,'posted',?,?,?,?,?,?,?)
`).run(
  personId, periodId, '1405/04',
  capped.gross_earnings_rial / 10, capped.net_pay_rial / 10,
  capped.sso_employee_rial / 10, capped.income_tax_rial / 10,
  '1405/04/31',
  capped.gross_earnings_rial, capped.insurance_base_rial,
  capped.sso_employee_rial, capped.sso_employer_rial,
  capped.taxable_income_rial, capped.income_tax_rial, capped.net_pay_rial
);

const insuranceCsv = buildInsuranceListCsv(db, periodId);
assert.ok(insuranceCsv.includes('DRAFT'), 'insurance CSV must be marked DRAFT');
assert.ok(insuranceCsv.includes('personnel_code,national_id,insurance_id'), 'insurance header missing');
assert.ok(insuranceCsv.includes('T-HR-001'), 'insurance CSV needs one data row');
assert.ok(insuranceCsv.includes('0999988877'), 'fake test national_id in insurance row');

const taxCsv = buildTaxDraftCsv(db, periodId);
assert.ok(taxCsv.includes('DRAFT'), 'tax CSV must be marked DRAFT');
assert.ok(taxCsv.includes('personnel_code,national_id,tax_id'), 'tax header missing');
assert.ok(taxCsv.includes('T-HR-001'), 'tax CSV needs one data row');
assert.ok(taxCsv.includes('TAX-TEST-001'), 'tax_id in tax row');

const dataLinesIns = insuranceCsv.split(/\r?\n/).filter(l => l && !l.startsWith('#'));
assert.ok(dataLinesIns.length >= 2, 'insurance CSV: header + >=1 row');
const dataLinesTax = taxCsv.split(/\r?\n/).filter(l => l && !l.startsWith('#'));
assert.ok(dataLinesTax.length >= 2, 'tax CSV: header + >=1 row');

db.close();
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch { /* absent */ }
}
console.log('✅ payroll labor-settings wire + DRAFT legal CSV export tests passed');
