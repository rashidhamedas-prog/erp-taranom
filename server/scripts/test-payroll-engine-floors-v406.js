'use strict';
/** Pure engine tests — no better-sqlite3 (Windows-safe). */
const assert = require('assert');
const { calculatePayroll, calculateProgressiveTax, resolveInsuranceCap } = require('../lib/payroll/engine');
const { legalPackForYear, insuranceCapMonthly } = require('../lib/payroll/legal-pack');

let n = 0;
function ok(c, m) { assert(c, m); n++; console.log('OK', m); }

const pack = legalPackForYear(1405);
ok(!!pack, 'pack 1405');
ok(insuranceCapMonthly(pack, 30) === pack.min_wage_daily_rial * 7 * 30, 'cap formula');

const period = {
  fiscal_year: 1405, standard_days: 30, standard_hours_x100: 22000,
  employee_insurance_bp: 700, employer_insurance_bp: 2300,
};
const labor = {
  min_wage_daily_rial: pack.min_wage_daily_rial,
  housing_allowance_rial: pack.housing_allowance_rial,
  food_allowance_rial: pack.food_allowance_rial,
  child_allowance_rial: pack.child_allowance_rial,
  spouse_allowance_rial: pack.spouse_allowance_rial,
  seniority_base_rial: pack.seniority_base_rial,
  insurance_cap_monthly_rial: insuranceCapMonthly(pack, 30),
  overtime_factor: 1.4,
  night_factor: 1.35,
  friday_factor: 1.4,
  tax_exemption_rial: pack.tax_exemption_rial,
};
const brackets = pack.tax_brackets_monthly;
const structure = {
  wage_basis: 'monthly', base_wage_rial: 1,
  housing_allowance_rial: 0, grocery_allowance_rial: 0,
  child_allowance_rial: 0, spouse_allowance_rial: 0,
  other_fixed_allowance_rial: 0, child_count: 2, marital_status: 1,
  insurance_type: 'sso', tax_exemption_type: 'none', tax_exemption_percent_bp: 0,
  overtime_factor_bp: 10000, night_shift_factor_bp: 10000,
};
const calc = calculatePayroll({
  period, structure, brackets, laborSettings: labor,
  input: {
    working_days_x100: 3000, regular_hours_x100: 22000,
    overtime_hours_x100: 1000, night_shift_hours_x100: 1000,
    friday_hours_x100: 800, seniority_days_x100: 3000,
    hardship_allowance_rial: 0, other_allowance_rial: 0,
    insurance_exempt_rial: 0, tax_exemption_rial: 0, other_deductions_rial: 1000,
  },
});
ok(calc.base_pay_rial === pack.min_wage_daily_rial * 30, 'min wage floor');
ok(calc.housing_allowance_rial === pack.housing_allowance_rial, 'housing floor');
ok(calc.grocery_allowance_rial === pack.food_allowance_rial, 'food→grocery');
ok(calc.spouse_allowance_rial === pack.spouse_allowance_rial, 'spouse');
ok(calc.child_allowance_rial === pack.child_allowance_rial * 2, 'child ×2');
ok(calc.friday_pay_rial > 0, 'friday');
ok(calc.seniority_rial === pack.seniority_base_rial * 30, 'seniority');
ok(calc.tax_exemption_applied_rial === pack.tax_exemption_rial, 'default exemption');
ok(calc.other_deductions_rial === 1000, 'other ded');
ok(calc.net_pay_rial === calc.gross_earnings_rial - calc.sso_employee_rial - calc.income_tax_rial - 1000, 'net');
ok(resolveInsuranceCap(labor, period) === labor.insurance_cap_monthly_rial, 'resolve cap');
ok(calculateProgressiveTax(500000000, brackets) === 400000000 * 0.1 + 100000000 * 0.15, 'progressive sample');

console.log(`\nPASS ${n}`);
