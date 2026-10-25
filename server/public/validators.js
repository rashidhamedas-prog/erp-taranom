/**
 * Shared field validators (audit 8B) — browser + Node.
 * Empty optional fields are allowed; non-empty values must pass.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ErpValidators = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function toEnDigits(s) {
    return String(s == null ? '' : s)
      .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  }

  function digitsOnly(s) {
    return toEnDigits(s).replace(/\D/g, '');
  }

  function err(message, code, status) {
    const e = new Error(message);
    e.status = status || 400;
    e.code = code || 'E_VALIDATION';
    return e;
  }

  /** Iranian natural-person national ID (10 digits + checksum). */
  function isNationalId10(raw) {
    const s = digitsOnly(raw);
    if (!/^\d{10}$/.test(s)) return false;
    if (/^(\d)\1{9}$/.test(s)) return false;
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += parseInt(s[i], 10) * (10 - i);
    const r = sum % 11;
    const c = parseInt(s[9], 10);
    return r < 2 ? c === r : c === 11 - r;
  }

  /** Iranian legal-entity national ID (11 digits + checksum). */
  function isCompanyNationalId11(raw) {
    const s = digitsOnly(raw);
    if (!/^\d{11}$/.test(s)) return false;
    if (/^(\d)\1{10}$/.test(s)) return false;
    const weights = [29, 27, 23, 19, 17, 29, 27, 23, 19, 17];
    let sum = 0;
    const controlBase = parseInt(s[10], 10) + 2;
    for (let i = 0; i < 10; i++) sum += (parseInt(s[i], 10) + controlBase) * weights[i];
    const r = sum % 11;
    const c = parseInt(s[10], 10);
    return (r === 10 ? 0 : r) === c;
  }

  function isNationalOrCompanyId(raw) {
    const s = digitsOnly(raw);
    if (s.length === 10) return isNationalId10(s);
    if (s.length === 11) return isCompanyNationalId11(s);
    return false;
  }

  /** Economic code: 11–14 digits (loose Iranian practice). */
  function isEconomicCode(raw) {
    const s = digitsOnly(raw);
    return /^\d{11,14}$/.test(s);
  }

  function isPostalCode(raw) {
    return /^\d{10}$/.test(digitsOnly(raw));
  }

  function isMobile09(raw) {
    const s = digitsOnly(raw);
    return /^09\d{9}$/.test(s);
  }

  function isEmail(raw) {
    const s = String(raw || '').trim();
    if (!s) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 200;
  }

  /**
   * Valid Jalali calendar date YYYY/MM/DD (Persian/Arabic digits OK).
   * Month 1..12; day within month (Esfand leap-aware).
   */
  function isJalaliDate(raw, opts) {
    const s = toEnDigits(raw).trim().replace(/-/g, '/');
    const m = /^(\d{3,4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
    if (!m) return false;
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const d = parseInt(m[3], 10);
    if (mo < 1 || mo > 12) return false;
    let dim;
    if (mo <= 6) dim = 31;
    else if (mo <= 11) dim = 30;
    else {
      // leap: year % 33 in {1,5,9,13,17,22,26,30} — same set as common Iranian civil calendars
      const r = ((y % 33) + 33) % 33;
      const leap = [1, 5, 9, 13, 17, 22, 26, 30].indexOf(r) >= 0;
      dim = leap ? 30 : 29;
    }
    if (d < 1 || d > dim) return false;
    if (opts && opts.minYear != null && y < opts.minYear) return false;
    if (opts && opts.maxYear != null && y > opts.maxYear) return false;
    return true;
  }

  function normalizeMobile(raw) {
    const s = digitsOnly(raw);
    if (/^9\d{9}$/.test(s)) return '0' + s;
    return s;
  }

  function assertOptional(fieldLabel, raw, predicate, code) {
    if (raw == null || String(raw).trim() === '') return null;
    if (!predicate(raw)) throw err(`${fieldLabel} نامعتبر است`, code);
    return raw;
  }

  function validateCustomerFields(body, { strictPhone } = {}) {
    const b = body || {};
    assertOptional('کد ملی / شناسه ملی', b.national_id, isNationalOrCompanyId, 'E_NATIONAL_ID');
    assertOptional('کد اقتصادی', b.economic_code, isEconomicCode, 'E_ECONOMIC_CODE');
    assertOptional('کد پستی', b.postal_code, isPostalCode, 'E_POSTAL_CODE');
    assertOptional('ایمیل', b.email, isEmail, 'E_EMAIL');
    assertOptional('تاریخ تولد', b.birth_date, (v) => isJalaliDate(v), 'E_JALALI_DATE');
    const phoneRaw = b.mobile || b.phone;
    if (strictPhone || (phoneRaw != null && String(phoneRaw).trim() !== '')) {
      const cand = b.mobile != null && String(b.mobile).trim() !== '' ? b.mobile : b.phone;
      if (cand != null && String(cand).trim() !== '') {
        if (!isMobile09(cand) && !isMobile09(normalizeMobile(cand))) {
          // allow landline-looking phones on `phone` if mobile empty — only validate mobile-shaped values
          const dig = digitsOnly(cand);
          if (/^09\d{9}$/.test(dig) || /^9\d{9}$/.test(dig) || dig.length === 10 && dig[0] === '9') {
            throw err('موبایل باید به صورت 09xxxxxxxxx باشد', 'E_MOBILE');
          }
          if (dig.length >= 8 && dig.length <= 11 && dig[0] === '0' && dig[1] === '9') {
            throw err('موبایل باید به صورت 09xxxxxxxxx باشد', 'E_MOBILE');
          }
          // short junk like "999" from #85
          if (dig.length > 0 && dig.length < 8) throw err('شماره تماس نامعتبر است', 'E_PHONE');
          if (!/^\d{8,15}$/.test(dig)) throw err('شماره تماس نامعتبر است', 'E_PHONE');
        }
      }
    }
    return true;
  }

  function assertJalaliDocDate(raw, label) {
    const v = raw == null || String(raw).trim() === '' ? null : raw;
    if (v == null) return null;
    if (!isJalaliDate(v)) throw err((label || 'تاریخ') + ' نامعتبر است', 'E_JALALI_DATE');
    return toEnDigits(String(v)).trim().replace(/-/g, '/');
  }

  return {
    toEnDigits,
    digitsOnly,
    isNationalId10,
    isCompanyNationalId11,
    isNationalOrCompanyId,
    isEconomicCode,
    isPostalCode,
    isMobile09,
    isEmail,
    isJalaliDate,
    normalizeMobile,
    validateCustomerFields,
    assertJalaliDocDate,
    err,
  };
});
