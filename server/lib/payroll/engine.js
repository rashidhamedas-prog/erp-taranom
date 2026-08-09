'use strict';

function int(value, name, { min = 0 } = {}) {
  const out = Math.round(Number(value) || 0);
  if (!Number.isSafeInteger(out) || out < min) {
    throw new Error(`${name} نامعتبر است`);
  }
  return out;
}

function calculateProgressiveTax(taxableIncomeRial, brackets) {
  const income = int(taxableIncomeRial, 'درآمد مشمول مالیات');
  let tax = 0;
  for (const bracket of [...(brackets || [])].sort((a, b) => a.bracket_order - b.bracket_order)) {
    const min = int(bracket.bracket_min_rial, 'حد پایین مالیات');
    const max = bracket.bracket_max_rial == null ? null : int(bracket.bracket_max_rial, 'حد بالای مالیات');
    const rateBp = int(bracket.tax_rate_bp, 'نرخ مالیات');
    if (income <= min) continue;
    const taxableInBracket = Math.max(0, Math.min(income, max == null ? income : max) - min);
    tax += Math.round(taxableInBracket * rateBp / 10000);
  }
  return tax;
}

function hourlyBaseRial(structure, period) {
  const base = int(structure.base_wage_rial, 'مزد پایه');
  if (structure.wage_basis === 'hourly') return base;
  if (structure.wage_basis === 'daily') return Math.round(base * 100 / 733);
  const standardHoursX100 = int(period.standard_hours_x100 || 22000, 'ساعات موظفی', { min: 1 });
  return Math.round(base * 100 / standardHoursX100);
}

function basePayRial(structure, period, input) {
  const base = int(structure.base_wage_rial, 'مزد پایه');
  const workingDaysX100 = int(input.working_days_x100, 'روز کارکرد');
  const regularHoursX100 = int(input.regular_hours_x100, 'ساعت کارکرد');
  if (structure.wage_basis === 'daily') return Math.round(base * workingDaysX100 / 100);
  if (structure.wage_basis === 'hourly') return Math.round(base * regularHoursX100 / 100);
  if (structure.wage_basis === 'contractor') return base;
  const standardDays = int(period.standard_days || 30, 'روز موظفی', { min: 1 });
  return Math.round(base * workingDaysX100 / (standardDays * 100));
}

/**
 * Apply yearly legal floors from payroll_labor_settings onto a copy of structure.
 *
 * CHOICE (no double-count): salary_structures / group_salary_structures already own
 * housing/grocery/child/spouse allowances and overtime/night factors. Labor-settings
 * columns with the same names (housing_allowance_rial, food_allowance_rial,
 * child_allowance_rial, overtime_factor, night_factor, …) are NOT re-applied here —
 * they remain for year-end / accrual UIs. Engine only consumes:
 *   - min_wage_daily_rial  → floor on base_wage_rial
 *   - insurance_cap_monthly_rial → cap on insurance_base after gross (applied in calculatePayroll)
 */
function applyLaborSettingsFloor(structure, period, laborSettings) {
  if (!laborSettings) return structure;
  const minDaily = Math.max(0, Math.round(Number(laborSettings.min_wage_daily_rial) || 0));
  if (minDaily <= 0) return structure;
  const basis = structure.wage_basis || 'monthly';
  if (basis === 'contractor') return structure;
  let base = int(structure.base_wage_rial, 'مزد پایه');
  if (basis === 'daily') {
    base = Math.max(base, minDaily);
  } else if (basis === 'hourly') {
    // Same 7.33h/day convention as hourlyBaseRial (733/100).
    base = Math.max(base, Math.round(minDaily * 100 / 733));
  } else {
    const standardDays = int(period.standard_days || 30, 'روز موظفی', { min: 1 });
    base = Math.max(base, minDaily * standardDays);
  }
  return { ...structure, base_wage_rial: base };
}

function calculatePayroll({ structure, period, brackets, input, laborSettings }) {
  if (!structure || !period) throw new Error('ساختار حقوق و دوره الزامی است');

  // See applyLaborSettingsFloor comment — only min wage + insurance cap from labor settings.
  const eff = applyLaborSettingsFloor(structure, period, laborSettings);

  const basePay = basePayRial(eff, period, input);
  const hourly = hourlyBaseRial(eff, period);
  const overtimeHoursX100 = int(input.overtime_hours_x100, 'اضافه‌کاری');
  const nightHoursX100 = int(input.night_shift_hours_x100, 'شب‌کاری');
  const overtimeFactorBp = int(eff.overtime_factor_bp || 14000, 'ضریب اضافه‌کاری');
  const nightFactorBp = int(eff.night_shift_factor_bp || 11500, 'ضریب شب‌کاری');
  const overtimePay = Math.round(hourly * overtimeHoursX100 * overtimeFactorBp / 100 / 10000);
  const nightPremiumBp = Math.max(0, nightFactorBp - 10000);
  const nightPay = Math.round(hourly * nightHoursX100 * nightPremiumBp / 100 / 10000);

  const fixedAllowanceFactor = eff.wage_basis === 'monthly'
    ? int(input.working_days_x100, 'روز کارکرد') / (int(period.standard_days || 30, 'روز موظفی', { min: 1 }) * 100)
    : 1;
  const housing = Math.round(int(eff.housing_allowance_rial, 'حق مسکن') * fixedAllowanceFactor);
  const grocery = Math.round(int(eff.grocery_allowance_rial, 'بن کارگری') * fixedAllowanceFactor);
  const spouse = eff.marital_status
    ? Math.round(int(eff.spouse_allowance_rial, 'حق تاهل') * fixedAllowanceFactor)
    : 0;
  const child = int(eff.child_allowance_rial, 'حق اولاد') * int(eff.child_count, 'تعداد فرزند');
  const otherFixed = Math.round(int(eff.other_fixed_allowance_rial, 'مزایای ثابت') * fixedAllowanceFactor);
  const hardship = int(input.hardship_allowance_rial, 'فوق‌العاده سختی کار');
  const otherAllowance = int(input.other_allowance_rial, 'سایر مزایا');

  const gross = basePay + housing + grocery + spouse + child + otherFixed +
    hardship + otherAllowance + overtimePay + nightPay;
  const insuranceExempt = Math.min(gross, int(input.insurance_exempt_rial, 'معاف از بیمه'));
  let insuranceBase = eff.insurance_type === 'sso' ? gross - insuranceExempt : 0;
  // Cap from yearly labor settings (0 / missing = no cap).
  const insuranceCap = laborSettings
    ? Math.max(0, Math.round(Number(laborSettings.insurance_cap_monthly_rial) || 0))
    : 0;
  if (insuranceCap > 0 && insuranceBase > insuranceCap) insuranceBase = insuranceCap;
  const employeeInsuranceBp = int(period.employee_insurance_bp || 0, 'نرخ بیمه کارگر');
  const employerInsuranceBp = int(period.employer_insurance_bp || 0, 'نرخ بیمه کارفرما');
  const employeeInsurance = Math.round(insuranceBase * employeeInsuranceBp / 10000);
  const employerInsurance = Math.round(insuranceBase * employerInsuranceBp / 10000);

  const periodTaxExemption = int(input.tax_exemption_rial, 'معافیت مالیاتی');
  const taxableIncome = Math.max(0, gross - employeeInsurance - periodTaxExemption);
  const rawTax = calculateProgressiveTax(taxableIncome, brackets);
  const exemptionBp = Math.min(10000, int(eff.tax_exemption_percent_bp, 'درصد معافیت مالیاتی'));
  const incomeTax = Math.round(rawTax * (10000 - exemptionBp) / 10000);
  const otherDeductions = int(input.other_deductions_rial, 'سایر کسورات');
  const netPay = gross - employeeInsurance - incomeTax - otherDeductions;
  if (netPay < 0) throw new Error('کسورات از حقوق ناخالص بیشتر است');

  return {
    working_days_x100: int(input.working_days_x100, 'روز کارکرد'),
    regular_hours_x100: int(input.regular_hours_x100, 'ساعت کارکرد'),
    overtime_hours_x100: overtimeHoursX100,
    night_shift_hours_x100: nightHoursX100,
    base_pay_rial: basePay,
    housing_allowance_rial: housing,
    grocery_allowance_rial: grocery,
    child_allowance_rial: child,
    spouse_allowance_rial: spouse,
    hardship_allowance_rial: hardship,
    other_allowance_rial: otherFixed + otherAllowance,
    overtime_pay_rial: overtimePay,
    night_shift_pay_rial: nightPay,
    gross_earnings_rial: gross,
    insurance_base_rial: insuranceBase,
    taxable_income_rial: taxableIncome,
    income_tax_rial: incomeTax,
    sso_employee_rial: employeeInsurance,
    sso_employer_rial: employerInsurance,
    other_deductions_rial: otherDeductions,
    net_pay_rial: netPay,
    employer_cost_rial: gross + employerInsurance,
  };
}

module.exports = { calculatePayroll, calculateProgressiveTax, applyLaborSettingsFloor };
