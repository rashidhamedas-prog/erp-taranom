'use strict';

const { insuranceCapMonthly, legalPackForYear } = require('./legal-pack');

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

function factorToBp(factor, fallbackBp) {
  const f = Number(factor);
  if (Number.isFinite(f) && f > 0) return Math.round(f * 10000);
  return fallbackBp;
}

/**
 * Apply yearly legal floors + factors from payroll_labor_settings onto a copy of structure.
 *
 * Floors (max with structure):
 *   - min_wage_daily_rial → base_wage_rial
 *   - housing / food(grocery) / child / spouse allowances
 * Factors (prefer labor settings when set):
 *   - overtime_factor, night_factor → *_factor_bp
 * Cap helper used later:
 *   - insurance_cap_monthly_rial (or 7×min×days)
 */
function applyLaborSettingsFloor(structure, period, laborSettings) {
  if (!laborSettings) return structure;
  let next = { ...structure };

  const minDaily = Math.max(0, Math.round(Number(laborSettings.min_wage_daily_rial) || 0));
  const basis = next.wage_basis || 'monthly';
  if (minDaily > 0 && basis !== 'contractor') {
    let base = int(next.base_wage_rial, 'مزد پایه');
    if (basis === 'daily') {
      base = Math.max(base, minDaily);
    } else if (basis === 'hourly') {
      base = Math.max(base, Math.round(minDaily * 100 / 733));
    } else {
      const standardDays = int(period.standard_days || 30, 'روز موظفی', { min: 1 });
      base = Math.max(base, minDaily * standardDays);
    }
    next.base_wage_rial = base;
  }

  const housingFloor = Math.max(0, Math.round(Number(laborSettings.housing_allowance_rial) || 0));
  const foodFloor = Math.max(0, Math.round(
    Number(laborSettings.food_allowance_rial || laborSettings.grocery_allowance_rial) || 0
  ));
  const childFloor = Math.max(0, Math.round(Number(laborSettings.child_allowance_rial) || 0));
  const spouseFloor = Math.max(0, Math.round(Number(laborSettings.spouse_allowance_rial) || 0));

  next.housing_allowance_rial = Math.max(int(next.housing_allowance_rial, 'حق مسکن'), housingFloor);
  next.grocery_allowance_rial = Math.max(int(next.grocery_allowance_rial, 'بن کارگری'), foodFloor);
  next.child_allowance_rial = Math.max(int(next.child_allowance_rial, 'حق اولاد'), childFloor);
  next.spouse_allowance_rial = Math.max(int(next.spouse_allowance_rial, 'حق تاهل'), spouseFloor);

  const otBp = factorToBp(laborSettings.overtime_factor, int(next.overtime_factor_bp || 14000, 'ضریب اضافه‌کاری'));
  const nightBp = factorToBp(laborSettings.night_factor, int(next.night_shift_factor_bp || 13500, 'ضریب شب‌کاری'));
  next.overtime_factor_bp = otBp;
  next.night_shift_factor_bp = nightBp;
  next._friday_factor_bp = factorToBp(laborSettings.friday_factor, 14000);
  next._seniority_daily_rial = Math.max(0, Math.round(Number(laborSettings.seniority_base_rial) || 0));

  return next;
}

function resolveInsuranceCap(laborSettings, period) {
  const explicit = laborSettings
    ? Math.max(0, Math.round(Number(laborSettings.insurance_cap_monthly_rial) || 0))
    : 0;
  if (explicit > 0) return explicit;
  const minDaily = laborSettings
    ? Math.max(0, Math.round(Number(laborSettings.min_wage_daily_rial) || 0))
    : 0;
  if (minDaily <= 0) return 0;
  const year = period?.fiscal_year;
  const pack = legalPackForYear(year) || { min_wage_daily_rial: minDaily, insurance_multiple: 7 };
  return insuranceCapMonthly(
    { ...pack, min_wage_daily_rial: minDaily },
    period?.standard_days || 30
  );
}

function calculatePayroll({ structure, period, brackets, input, laborSettings }) {
  if (!structure || !period) throw new Error('ساختار حقوق و دوره الزامی است');

  const eff = applyLaborSettingsFloor(structure, period, laborSettings);

  const basePay = basePayRial(eff, period, input);
  const hourly = hourlyBaseRial(eff, period);
  const overtimeHoursX100 = int(input.overtime_hours_x100, 'اضافه‌کاری');
  const nightHoursX100 = int(input.night_shift_hours_x100, 'شب‌کاری');
  const fridayHoursX100 = int(input.friday_hours_x100 || 0, 'جمعه‌کاری');
  const overtimeFactorBp = int(eff.overtime_factor_bp || 14000, 'ضریب اضافه‌کاری');
  const nightFactorBp = int(eff.night_shift_factor_bp || 13500, 'ضریب شب‌کاری');
  const fridayFactorBp = int(eff._friday_factor_bp || 14000, 'ضریب جمعه‌کاری');
  const overtimePay = Math.round(hourly * overtimeHoursX100 * overtimeFactorBp / 100 / 10000);
  const nightPremiumBp = Math.max(0, nightFactorBp - 10000);
  const nightPay = Math.round(hourly * nightHoursX100 * nightPremiumBp / 100 / 10000);
  const fridayPay = Math.round(hourly * fridayHoursX100 * fridayFactorBp / 100 / 10000);

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

  const seniorityDaysX100 = int(input.seniority_days_x100 || 0, 'روز پایه سنوات');
  const seniorityDaily = Math.max(0, Math.round(Number(eff._seniority_daily_rial) || 0));
  const seniorityPay = seniorityDaily > 0 && seniorityDaysX100 > 0
    ? Math.round(seniorityDaily * seniorityDaysX100 / 100)
    : int(input.seniority_rial || 0, 'پایه سنوات');

  const gross = basePay + housing + grocery + spouse + child + otherFixed +
    hardship + otherAllowance + overtimePay + nightPay + fridayPay + seniorityPay;
  const insuranceExempt = Math.min(gross, int(input.insurance_exempt_rial, 'معاف از بیمه'));
  let insuranceBase = eff.insurance_type === 'sso' ? gross - insuranceExempt : 0;
  const insuranceCap = resolveInsuranceCap(laborSettings, period);
  if (insuranceCap > 0 && insuranceBase > insuranceCap) insuranceBase = insuranceCap;
  const employeeInsuranceBp = int(period.employee_insurance_bp || 0, 'نرخ بیمه کارگر');
  const employerInsuranceBp = int(period.employer_insurance_bp || 0, 'نرخ بیمه کارفرما');
  const employeeInsurance = Math.round(insuranceBase * employeeInsuranceBp / 10000);
  const employerInsurance = Math.round(insuranceBase * employerInsuranceBp / 10000);

  const settingsTaxEx = laborSettings
    ? Math.max(0, Math.round(Number(laborSettings.tax_exemption_rial) || 0))
    : 0;
  const inputTaxEx = int(input.tax_exemption_rial || 0, 'معافیت مالیاتی');
  const periodTaxExemption = inputTaxEx > 0 ? inputTaxEx : settingsTaxEx;
  const fullyExempt = Number(eff.is_tax_exempt) === 1
    || String(eff.tax_exemption_type || '') === 'tax_exempt'
    || int(eff.tax_exemption_percent_bp, 'درصد معافیت مالیاتی') >= 10000;
  const taxableIncome = fullyExempt ? 0 : Math.max(0, gross - employeeInsurance - periodTaxExemption);
  const rawTax = fullyExempt ? 0 : calculateProgressiveTax(taxableIncome, brackets || []);
  const exemptionBp = fullyExempt ? 10000 : Math.min(10000, int(eff.tax_exemption_percent_bp, 'درصد معافیت مالیاتی'));
  const incomeTax = fullyExempt ? 0 : Math.round(rawTax * (10000 - exemptionBp) / 10000);
  const otherDeductions = int(input.other_deductions_rial, 'سایر کسورات');
  const netPay = gross - employeeInsurance - incomeTax - otherDeductions;
  if (netPay < 0) throw new Error('کسورات از حقوق ناخالص بیشتر است');

  return {
    working_days_x100: int(input.working_days_x100, 'روز کارکرد'),
    regular_hours_x100: int(input.regular_hours_x100, 'ساعت کارکرد'),
    overtime_hours_x100: overtimeHoursX100,
    night_shift_hours_x100: nightHoursX100,
    friday_hours_x100: fridayHoursX100,
    seniority_days_x100: seniorityDaysX100,
    base_pay_rial: basePay,
    housing_allowance_rial: housing,
    grocery_allowance_rial: grocery,
    child_allowance_rial: child,
    spouse_allowance_rial: spouse,
    hardship_allowance_rial: hardship,
    other_allowance_rial: otherFixed + otherAllowance,
    overtime_pay_rial: overtimePay,
    night_shift_pay_rial: nightPay,
    friday_pay_rial: fridayPay,
    seniority_rial: seniorityPay,
    gross_earnings_rial: gross,
    insurance_base_rial: insuranceBase,
    insurance_cap_rial: insuranceCap,
    tax_exemption_applied_rial: fullyExempt ? 0 : periodTaxExemption,
    taxable_income_rial: taxableIncome,
    income_tax_rial: incomeTax,
    sso_employee_rial: employeeInsurance,
    sso_employer_rial: employerInsurance,
    other_deductions_rial: otherDeductions,
    net_pay_rial: netPay,
    employer_cost_rial: gross + employerInsurance,
  };
}

module.exports = {
  calculatePayroll,
  calculateProgressiveTax,
  applyLaborSettingsFloor,
  resolveInsuranceCap,
};
