'use strict';
/**
 * v406 — بسته قانونی ۱۴۰۵ + کف مزایا + جمعه‌کاری + معافیت پیش‌فرض + تفکیک JE مسیر قدیمی
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const testDb = path.join(__dirname, 'payroll-legal-pack-v406-test.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch { /* absent */ }
}
process.env.DB_PATH = testDb;
process.env.SYNC_ROLE = 'device';

const { initDB, getDB } = require('../db');
const { calculatePayroll } = require('../lib/payroll/engine');
const { seedLegalPack, legalPackForYear, insuranceCapMonthly } = require('../lib/payroll/legal-pack');
const { postToLedger } = require('../lib/ledger');
const { acct } = require('../lib/coa-map');
const { rialToLedger } = require('../lib/money');

let passed = 0;
function ok(cond, msg) {
  assert(cond, msg);
  passed += 1;
  console.log('OK', msg);
}

initDB();
const db = getDB();

const pack = legalPackForYear(1405);
ok(!!pack, 'legal pack 1405 exists');
ok(pack.min_wage_daily_rial === 5541850, 'min daily wage 1405');
ok(pack.housing_allowance_rial === 30000000, 'housing 30M');
ok(pack.food_allowance_rial === 22000000, 'food 22M');
ok(pack.child_allowance_rial === 16625550, 'child allowance');
ok(pack.spouse_allowance_rial === 5000000, 'spouse 5M');
ok(pack.tax_exemption_rial === 400000000, 'monthly tax exemption 400M');

const seeded = seedLegalPack(db, 1405, { force: true });
ok(seeded.seeded, 'seed force ok');
const labor = db.prepare('SELECT * FROM payroll_labor_settings WHERE year=1405').get();
ok(labor && labor.min_wage_daily_rial === 5541850, 'labor settings seeded');
ok(Number(labor.spouse_allowance_rial) === 5000000, 'spouse column seeded');
ok(Number(labor.insurance_cap_monthly_rial) === insuranceCapMonthly(pack, 30), 'insurance cap = 7×min×30');

const brackets = db.prepare(`
  SELECT * FROM payroll_tax_brackets WHERE fiscal_year=1405 AND active=1 ORDER BY bracket_order
`).all();
ok(brackets.length === 5, '5 tax brackets');
ok(brackets[0].tax_rate_bp === 1000 && brackets[4].tax_rate_bp === 3000, 'bracket rates 10..30');

// Engine floors: structure below legal → lifted
const period = {
  fiscal_year: 1405, standard_days: 30, standard_hours_x100: 22000,
  employee_insurance_bp: 700, employer_insurance_bp: 2300,
};
const structure = {
  wage_basis: 'monthly', base_wage_rial: 100000000, // below min monthly
  housing_allowance_rial: 0, grocery_allowance_rial: 0,
  child_allowance_rial: 0, spouse_allowance_rial: 0,
  other_fixed_allowance_rial: 0, child_count: 1, marital_status: 1,
  insurance_type: 'sso', tax_exemption_type: 'none', tax_exemption_percent_bp: 0,
  overtime_factor_bp: 14000, night_shift_factor_bp: 11500,
};
const calc = calculatePayroll({
  period, structure, brackets, laborSettings: labor,
  input: {
    working_days_x100: 3000, regular_hours_x100: 22000,
    overtime_hours_x100: 0, night_shift_hours_x100: 0,
    friday_hours_x100: 800, // 8h friday
    seniority_days_x100: 3000, // 30 days
    hardship_allowance_rial: 0, other_allowance_rial: 0,
    insurance_exempt_rial: 0, tax_exemption_rial: 0, other_deductions_rial: 0,
  },
});
const minMonthly = pack.min_wage_daily_rial * 30;
ok(calc.base_pay_rial === minMonthly, 'base floored to min monthly');
ok(calc.housing_allowance_rial === pack.housing_allowance_rial, 'housing floor');
ok(calc.grocery_allowance_rial === pack.food_allowance_rial, 'grocery floor from food');
ok(calc.spouse_allowance_rial === pack.spouse_allowance_rial, 'spouse floor when married');
ok(calc.child_allowance_rial === pack.child_allowance_rial, 'child floor');
ok(calc.friday_pay_rial > 0, 'friday pay computed');
ok(calc.seniority_rial === pack.seniority_base_rial * 30, 'seniority = daily × 30');
ok(calc.tax_exemption_applied_rial === pack.tax_exemption_rial, 'default tax exemption from settings');
ok(calc.insurance_cap_rial === Number(labor.insurance_cap_monthly_rial), 'cap reported');
ok(calc.employer_cost_rial === calc.gross_earnings_rial + calc.sso_employer_rial, 'employer cost');

// Tax on income above exemption
ok(calc.taxable_income_rial === Math.max(0, calc.gross_earnings_rial - calc.sso_employee_rial - pack.tax_exemption_rial), 'taxable formula');

// Legacy-style JE split (gross / net / SSO / tax / other)
const gross = 1000000, ins = 70000, tax = 50000, ded = 30000;
const net = gross - ins - tax - ded;
const jeId = db.transaction(() => postToLedger(db, {
  sourceType: 'payroll_test_v406', sourceId: 1, date: '1405/07/01',
  description: 'تست تفکیک JE حقوق', createdBy: 1,
  lines: [
    { ...acct(db, 'coa_payroll_expense'), debit: rialToLedger(gross), credit: 0 },
    { ...acct(db, 'coa_payroll_payable'), debit: 0, credit: rialToLedger(net) },
    { ...acct(db, 'coa_sso_payable'), debit: 0, credit: rialToLedger(ins) },
    { ...acct(db, 'coa_payroll_tax_payable'), debit: 0, credit: rialToLedger(tax) },
    { ...acct(db, 'coa_payroll_other_deductions'), debit: 0, credit: rialToLedger(ded) },
  ],
}))();
const bal = db.prepare('SELECT SUM(debit_rial) d, SUM(credit_rial) c FROM journal_lines WHERE entry_id=?').get(jeId);
ok(bal.d === bal.c, 'legacy JE balanced');
ok(bal.d === rialToLedger(gross), 'debit = gross');

// UI / nav presence
const nav = fs.readFileSync(path.join(__dirname, '../public/acc-nav.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(nav.includes("'acc-payroll-labor'"), 'nav labor item');
ok(app.includes('renderPayrollLaborSettings'), 'labor settings UI');
ok(app.includes('pc-friday'), 'friday field in processing');
ok(app.includes('legal-pack'), 'legal pack API wired in UI');

// Idempotent seed without force keeps custom override
db.prepare('UPDATE payroll_labor_settings SET housing_allowance_rial=? WHERE year=1405').run(99999999);
const soft = seedLegalPack(db, 1405, { force: false });
const after = db.prepare('SELECT housing_allowance_rial FROM payroll_labor_settings WHERE year=1405').get();
ok(Number(after.housing_allowance_rial) === 99999999, 'soft seed does not overwrite filled settings');
ok(soft.seeded, 'soft seed still reports seeded');

db.close();
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch { /* absent */ }
}
console.log(`\nPASS ${passed}/0 failures`);
