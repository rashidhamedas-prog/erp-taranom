'use strict';

/**
 * پرداختی که رابطه کارگری و کسر بیمه/مالیات حقوق ندارد.
 * مبلغ بیمه و مالیات از کلاینت پذیرفته نمی‌شود؛ خالص = ناخالص − سایر کسورات.
 */

const EXEMPT_REASONS = {
  contractor: 'پیمانکار، خارج از رابطه کارگری',
  marketer: 'بازاریاب غیروابسته، بدون رابطه استخدامی',
  owner: 'صاحب کار یا شریک، نه کارگر مشمول قانون کار',
  other: 'سایر',
};

function fail(message, code) {
  return Object.assign(new Error(message), { status: 422, code });
}

function rial(value) {
  const out = Math.round(Number(value) || 0);
  if (!Number.isSafeInteger(out)) return null;
  return out;
}

function exemptReasonLabel(code) {
  return EXEMPT_REASONS[String(code || '').trim()] || '';
}

function buildManualExemptCalc(input) {
  const body = input || {};
  const reason = String(body.exempt_reason || '').trim();
  if (!EXEMPT_REASONS[reason]) {
    throw fail('مبنای قانونی ثبت بدون بیمه و مالیات را انتخاب کنید', 'E_PAYROLL_EXEMPT_REASON');
  }
  const note = String(body.exempt_note || '').trim();
  if (reason === 'other' && note.length < 8) {
    throw fail('برای مبنای «سایر» توضیح حداقل ۸ نویسه الزامی است', 'E_PAYROLL_EXEMPT_NOTE');
  }
  const gross = rial(body.gross_earnings_rial);
  const other = rial(body.other_deductions_rial);
  if (gross == null || gross <= 0) {
    throw fail('ناخالص باید بیشتر از صفر و به ریال باشد', 'E_PAYROLL_EXEMPT_GROSS');
  }
  if (other == null || other < 0) {
    throw fail('سایر کسورات نامعتبر است', 'E_PAYROLL_EXEMPT_DEDUCTION');
  }
  if (other > gross) throw fail('سایر کسورات از ناخالص بیشتر است', 'E_PAYROLL_EXEMPT_DEDUCTION');
  const statutory = [body.sso_employee_rial, body.sso_employer_rial, body.income_tax_rial]
    .some(v => Math.round(Number(v) || 0) > 0);
  if (statutory) {
    throw fail(
      'در ثبت دستی بدون بیمه و مالیات، مبلغ بیمه یا مالیات پذیرفته نمی‌شود. کارگر مشمول از محاسبه قانون کار ثبت می‌شود.',
      'E_PAYROLL_EXEMPT_HAS_STATUTORY'
    );
  }
  const days = Math.max(0, Math.round(Number(body.working_days) || 0));
  const hours = Math.max(0, Number(body.regular_hours) || 0);
  return {
    meta: {
      settlement_mode: 'manual_exempt',
      exempt_reason: reason,
      exempt_note: note,
      reason_label: EXEMPT_REASONS[reason],
    },
    calc: {
      working_days_x100: days * 100,
      regular_hours_x100: Math.round(hours * 100),
      overtime_hours_x100: 0,
      night_shift_hours_x100: 0,
      base_pay_rial: gross,
      housing_allowance_rial: 0,
      grocery_allowance_rial: 0,
      child_allowance_rial: 0,
      spouse_allowance_rial: 0,
      hardship_allowance_rial: 0,
      other_allowance_rial: 0,
      overtime_pay_rial: 0,
      night_shift_pay_rial: 0,
      gross_earnings_rial: gross,
      insurance_base_rial: 0,
      taxable_income_rial: 0,
      income_tax_rial: 0,
      sso_employee_rial: 0,
      sso_employer_rial: 0,
      other_deductions_rial: other,
      net_pay_rial: gross - other,
      employer_cost_rial: gross,
    },
  };
}

function assertLaborPathAllowed(structure, person) {
  const ins = String(structure?.insurance_type || person?.insurance_type || 'sso');
  if (ins === 'none') {
    throw fail(
      'بیمه این شخص «بدون بیمه» است. پردازش قانون کار برای کارگر مشمول مجاز نیست. اگر پیمانکار، بازاریاب غیروابسته یا صاحب کار است، روش «ثبت دستی بدون بیمه و مالیات» را با ذکر مبنا انتخاب کنید.',
      'E_PAYROLL_UNINSURED_LABOR'
    );
  }
}

function minWageWarning(structure, period, laborSettings) {
  if (!structure || !laborSettings) return null;
  if (structure.wage_basis === 'contractor') return null;
  const minDaily = Math.max(0, Math.round(Number(laborSettings.min_wage_daily_rial) || 0));
  if (minDaily <= 0) return null;
  const days = Math.max(1, Math.round(Number(period?.standard_days) || 30));
  let floor = minDaily * days;
  if (structure.wage_basis === 'daily') floor = minDaily;
  else if (structure.wage_basis === 'hourly') floor = Math.round(minDaily * 100 / 733);
  const base = Math.round(Number(structure.base_wage_rial) || 0);
  if (base <= 0 || base >= floor) return null;
  const fmt = n => n.toLocaleString('fa-IR');
  return `مزد پایه حکم (${fmt(base)} ریال) از حداقل مزد همین سال (${fmt(floor)} ریال) کمتر است. سند ثبت می‌شود؛ حکم را با بخشنامه مزد همان سال تطبیق دهید.`;
}

module.exports = {
  EXEMPT_REASONS,
  exemptReasonLabel,
  buildManualExemptCalc,
  assertLaborPathAllowed,
  minWageWarning,
};
