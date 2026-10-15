'use strict';
/**
 * Wave3 payroll: child SSO exclusion, shift premium, mission tax/SSO exempt,
 * production bonus SSO exempt, employer 20+3 split.
 * Pure engine — no better-sqlite3 (Windows-safe).
 */
const assert = require('assert');
const { calculatePayroll, splitEmployerInsurance } = require('../lib/payroll/engine');
const { legalPackForYear, insuranceCapMonthly } = require('../lib/payroll/legal-pack');

let n = 0;
function ok(c, m) { assert(c, m); n++; console.log('OK', m); }

const pack = legalPackForYear(1405);
ok(!!pack, 'pack 1405');

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
  shift_factor: 1.225,
  tax_exemption_rial: pack.tax_exemption_rial,
};
const brackets = pack.tax_brackets_monthly;
const structure = {
  wage_basis: 'monthly', base_wage_rial: pack.min_wage_daily_rial * 30,
  housing_allowance_rial: pack.housing_allowance_rial,
  grocery_allowance_rial: pack.food_allowance_rial,
  child_allowance_rial: pack.child_allowance_rial,
  spouse_allowance_rial: 0,
  other_fixed_allowance_rial: 0, child_count: 1, marital_status: 0,
  insurance_type: 'sso', tax_exemption_type: 'none', tax_exemption_percent_bp: 0,
  overtime_factor_bp: 14000, night_shift_factor_bp: 13500,
};

const baseInput = {
  working_days_x100: 3000, regular_hours_x100: 22000,
  overtime_hours_x100: 0, night_shift_hours_x100: 0,
  friday_hours_x100: 0, shift_hours_x100: 0,
  seniority_days_x100: 0, hardship_allowance_rial: 0, other_allowance_rial: 0,
  mission_allowance_rial: 0, production_bonus_rial: 0,
  insurance_exempt_rial: 0, tax_exemption_rial: 0, other_deductions_rial: 0,
};

const calc0 = calculatePayroll({
  period, structure, brackets, laborSettings: labor, input: baseInput,
});
ok(calc0.child_allowance_rial === pack.child_allowance_rial, 'child amount');
ok(
  calc0.insurance_exempt_rial >= calc0.child_allowance_rial,
  'child auto-excluded from SSO base'
);
ok(
  calc0.insurance_base_rial === calc0.gross_earnings_rial - calc0.insurance_exempt_rial
    || calc0.insurance_base_rial === Math.min(
      calc0.gross_earnings_rial - calc0.insurance_exempt_rial,
      labor.insurance_cap_monthly_rial
    ),
  'insurance base excludes child'
);

const withMission = calculatePayroll({
  period, structure, brackets, laborSettings: labor,
  input: { ...baseInput, mission_allowance_rial: 5_000_000 },
});
ok(withMission.mission_allowance_rial === 5_000_000, 'mission in gross');
ok(withMission.insurance_exempt_rial >= withMission.child_allowance_rial + 5_000_000, 'mission SSO exempt');
ok(
  withMission.taxable_income_rial
    <= Math.max(0, withMission.gross_earnings_rial - 5_000_000 - withMission.sso_employee_rial - pack.tax_exemption_rial),
  'mission tax exempt'
);

const withBonus = calculatePayroll({
  period, structure, brackets, laborSettings: labor,
  input: { ...baseInput, production_bonus_rial: 10_000_000, production_bonus_sso_exempt: 1 },
});
ok(withBonus.production_bonus_rial === 10_000_000, 'bonus in gross');
ok(withBonus.insurance_exempt_rial >= withBonus.child_allowance_rial + 10_000_000, 'bonus SSO exempt');

const withShift = calculatePayroll({
  period, structure, brackets, laborSettings: labor,
  input: { ...baseInput, shift_hours_x100: 1000 },
});
ok(withShift.shift_pay_rial > 0, 'shift premium > 0');
ok(withShift.shift_hours_x100 === 1000, 'shift hours stored');

const split = splitEmployerInsurance(100_000_000, 2300);
ok(split.sso_employer_rial === 23_000_000, 'employer 23%');
ok(split.sso_employer_base_rial === 20_000_000, 'employer base 20%');
ok(split.sso_unemployment_rial === 3_000_000, 'unemployment 3%');
ok(calc0.sso_employer_base_rial + calc0.sso_unemployment_rial === calc0.sso_employer_rial, 'split sums to employer');

const withAbsence = calculatePayroll({
  period, structure, brackets, laborSettings: labor,
  input: {
    ...baseInput,
    working_days_x100: 3000,
    absence_days_x100: 200,
    unpaid_leave_days_x100: 100,
    apply_absence_to_days: 1,
  },
});
ok(withAbsence.working_days_x100 === 2700, 'absence applied to days');
ok(withAbsence.base_pay_rial < calc0.base_pay_rial, 'base reduced by absence');

console.log(`\nPASS ${n}`);
