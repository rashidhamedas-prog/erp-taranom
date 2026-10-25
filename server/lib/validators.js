'use strict';
/**
 * Server-side validators (audit 8B). Pure rules live in public/validators.js;
 * Jalali day bounds use the project jalali.js leap algorithm.
 */
const base = require('../public/validators');
const { daysInJalaliMonth } = require('../jalali');

function isJalaliDate(raw) {
  const s = base.toEnDigits(raw).trim().replace(/-/g, '/');
  const m = /^(\d{3,4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (!m) return false;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  const dim = daysInJalaliMonth(y, mo);
  if (!dim) return false;
  return d >= 1 && d <= dim;
}

function assertJalaliDocDate(raw, label) {
  const v = raw == null || String(raw).trim() === '' ? null : raw;
  if (v == null) return null;
  if (!isJalaliDate(v)) throw base.err((label || 'تاریخ') + ' نامعتبر است', 'E_JALALI_DATE');
  const s = base.toEnDigits(String(v)).trim().replace(/-/g, '/');
  const parts = s.split('/');
  return `${parts[0]}/${String(parseInt(parts[1], 10)).padStart(2, '0')}/${String(parseInt(parts[2], 10)).padStart(2, '0')}`;
}

function validateCustomerFields(body, opts) {
  const b = body || {};
  if (b.national_id != null && String(b.national_id).trim() !== '') {
    if (!base.isNationalOrCompanyId(b.national_id)) {
      throw base.err('کد ملی / شناسه ملی نامعتبر است', 'E_NATIONAL_ID');
    }
  }
  if (b.economic_code != null && String(b.economic_code).trim() !== '') {
    if (!base.isEconomicCode(b.economic_code)) {
      throw base.err('کد اقتصادی نامعتبر است', 'E_ECONOMIC_CODE');
    }
  }
  if (b.postal_code != null && String(b.postal_code).trim() !== '') {
    if (!base.isPostalCode(b.postal_code)) {
      throw base.err('کد پستی نامعتبر است', 'E_POSTAL_CODE');
    }
  }
  if (b.email != null && String(b.email).trim() !== '') {
    if (!base.isEmail(b.email)) {
      throw base.err('ایمیل نامعتبر است', 'E_EMAIL');
    }
  }
  if (b.birth_date != null && String(b.birth_date).trim() !== '') {
    if (!isJalaliDate(b.birth_date)) {
      throw base.err('تاریخ تولد نامعتبر است', 'E_JALALI_DATE');
    }
  }
  const phoneRaw = b.mobile != null && String(b.mobile).trim() !== '' ? b.mobile : b.phone;
  if (phoneRaw != null && String(phoneRaw).trim() !== '') {
    const dig = base.digitsOnly(phoneRaw);
    if (dig.length > 0 && dig.length < 8) throw base.err('شماره تماس نامعتبر است', 'E_PHONE');
    if (/^0?9/.test(dig) && !base.isMobile09(base.normalizeMobile(dig))) {
      throw base.err('موبایل باید به صورت 09xxxxxxxxx باشد', 'E_MOBILE');
    }
    if (opts && opts.strictPhone && !base.isMobile09(base.normalizeMobile(dig))) {
      throw base.err('موبایل باید به صورت 09xxxxxxxxx باشد', 'E_MOBILE');
    }
  }
  return true;
}

module.exports = {
  ...base,
  isJalaliDate,
  assertJalaliDocDate,
  validateCustomerFields,
};
