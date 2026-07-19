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

function calculatePayroll({ structure, period, brackets, input }) {
  if (!structure || !period) throw new Error('ساختار حقوق و دوره الزامی است');

  const basePay = basePayRial(structure, period, input);
  const hourly = hourlyBaseRial(structure, period);
  const overtimeHoursX100 = int(input.overtime_hours_x100, 'اضافه‌کاری');
  const nightHoursX100 = int(input.night_shift_hours_x100, 'شب‌کاری');
  const overtimeFactorBp = int(structure.overtime_factor_bp || 14000, 'ضریب اضافه‌کاری');
  const nightFactorBp = int(structure.night_shift_factor_bp || 11500, 'ضریب شب‌کاری');
  const overtimePay = Math.round(hourly * overtimeHoursX100 * overtimeFactorBp / 100 / 10000);
  const nightPremiumBp = Math.max(0, nightFactorBp - 10000);
  const nightPay = Math.round(hourly * nightHoursX100 * nightPremiumBp / 100 / 10000);

  const fixedAllowanceFactor = structure.wage_basis === 'monthly'
    ? int(input.working_days_x100, 'روز کارکرد') / (int(period.standard_days || 30, 'روز موظفی', { min: 1 }) * 100)
    : 1;
  const housing = Math.round(int(structure.housing_allowance_rial, 'حق مسکن') * fixedAllowanceFactor);
  const grocery = Math.round(int(structure.grocery_allowance_rial, 'بن کارگری') * fixedAllowanceFactor);
  const spouse = structure.marital_status
    ? Math.round(int(structure.spouse_allowance_rial, 'حق تاهل') * fixedAllowanceFactor)
    : 0;
  const child = int(structure.child_allowance_rial, 'حق اولاد') * int(structure.child_count, 'تعداد فرزند');
  const otherFixed = Math.round(int(structure.other_fixed_allowance_rial, 'مزایای ثابت') * fixedAllowanceFactor);
  const hardship = int(input.hardship_allowance_rial, 'فوق‌العاده سختی کار');
  const otherAllowance = int(input.other_allowance_rial, 'سایر مزایا');

  const gross = basePay + housing + grocery + spouse + child + otherFixed +
    hardship + otherAllowance + overtimePay + nightPay;
  const insuranceExempt = Math.min(gross, int(input.insurance_exempt_rial, 'معاف از بیمه'));
  const insuranceBase = structure.insurance_type === 'sso' ? gross - insuranceExempt : 0;
  const employeeInsuranceBp = int(period.employee_insurance_bp || 0, 'نرخ بیمه کارگر');
  const employerInsuranceBp = int(period.employer_insurance_bp || 0, 'نرخ بیمه کارفرما');
  const employeeInsurance = Math.round(insuranceBase * employeeInsuranceBp / 10000);
  const employerInsurance = Math.round(insuranceBase * employerInsuranceBp / 10000);

  const periodTaxExemption = int(input.tax_exemption_rial, 'معافیت مالیاتی');
  const taxableIncome = Math.max(0, gross - employeeInsurance - periodTaxExemption);
  const rawTax = calculateProgressiveTax(taxableIncome, brackets);
  const exemptionBp = Math.min(10000, int(structure.tax_exemption_percent_bp, 'درصد معافیت مالیاتی'));
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

module.exports = { calculatePayroll, calculateProgressiveTax };
