'use strict';
/**
 * Shared cheque due-date validation (Phase 0 / v563).
 * Jalali YYYY/MM/DD only; due must not precede receive; same-day needs allow_same_day_due;
 * when invoice pay_splits exist, due must match the matching cheque split.
 */

function toAsciiDigits(s) {
  return String(s == null ? '' : s)
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

function digitsOnly(v) {
  return toAsciiDigits(v).replace(/\D/g, '');
}

function isValidJalaliDate(s) {
  const t = toAsciiDigits(String(s || '').trim());
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(t)) return false;
  const [y, m, d] = t.split('/').map((x) => parseInt(x, 10));
  if (y < 1300 || y > 1500) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  if (m <= 6 && d > 31) return false;
  if (m >= 7 && m <= 11 && d > 30) return false;
  if (m === 12 && d > 30) return false;
  return true;
}

function httpErr(status, message, code, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
}

/**
 * @param {object} opts
 * @param {string} opts.due
 * @param {string} opts.receiveDate
 * @param {boolean} [opts.allowSameDayDue]
 * @param {number} [opts.index] 1-based row for messages
 */
function assertChequeDueVsReceive({ due, receiveDate, allowSameDayDue, index }) {
  const n = index != null ? index : '';
  const dueS = toAsciiDigits(String(due || '').trim());
  const recvS = toAsciiDigits(String(receiveDate || '').trim());
  if (!dueS) {
    throw httpErr(400, `سررسید چک${n ? ` (ردیف ${n})` : ''} الزامی است`, 'E_CHEQUE_DUE_REQUIRED');
  }
  if (!isValidJalaliDate(dueS)) {
    throw httpErr(400, `سررسید چک${n ? ` (ردیف ${n})` : ''} معتبر نیست`, 'E_CHEQUE_DUE_INVALID');
  }
  if (recvS && isValidJalaliDate(recvS)) {
    if (dueS < recvS) {
      throw httpErr(
        400,
        `سررسید چک نمی‌تواند قبل از تاریخ دریافت باشد${n ? ` (ردیف ${n})` : ''}`,
        'E_CHEQUE_DUE_BEFORE_RECEIVE',
        { due: dueS, receive_date: recvS }
      );
    }
    if (dueS === recvS && !allowSameDayDue) {
      throw httpErr(
        400,
        `برای چک روز (سررسید = تاریخ دریافت) فلگ allow_same_day_due لازم است${n ? ` (ردیف ${n})` : ''}`,
        'E_CHEQUE_DUE_SAME_DAY',
        { due: dueS, receive_date: recvS }
      );
    }
  }
  return dueS;
}

/**
 * Match invoice pay_splits cheque row by sayadi or cheque_number; require equal due.
 */
function assertChequeDueMatchesInvoicePlan(db, {
  invoiceId, due, sayadi, chequeNumber, index,
}) {
  if (!invoiceId || !db) return;
  const inv = db.prepare('SELECT pay_splits_json FROM invoices WHERE id=?').get(invoiceId);
  if (!inv || !inv.pay_splits_json) return;
  let splits;
  try {
    splits = JSON.parse(inv.pay_splits_json);
  } catch (_) {
    return;
  }
  if (!Array.isArray(splits) || !splits.length) return;
  const say = digitsOnly(sayadi);
  const num = String(chequeNumber || '').trim();
  const chequeSplits = splits.filter((s) => String((s && s.pay_type) || '') === 'cheque');
  if (!chequeSplits.length) return;
  const match = chequeSplits.find((s) => {
    const sSay = digitsOnly(s.sayadi || s.cheque_sayadi);
    const sNum = String(s.cheque_number || '').trim();
    if (say && sSay && say === sSay) return true;
    if (num && sNum && num === sNum) return true;
    return false;
  });
  if (!match) return;
  const planDue = toAsciiDigits(String(match.cheque_due || match.cheque_due_date || '').trim());
  if (!planDue) return;
  const dueS = toAsciiDigits(String(due || '').trim());
  if (dueS !== planDue) {
    const n = index != null ? index : '';
    throw httpErr(
      400,
      `سررسید چک با برنامهٔ پرداخت فاکتور هم‌خوان نیست${n ? ` (ردیف ${n})` : ''} — ثبت: ${dueS} / فاکتور: ${planDue}`,
      'E_CHEQUE_DUE_MISMATCH',
      { register_due: dueS, invoice_due: planDue }
    );
  }
}

function validateIncomingChequeDue(db, opts) {
  const dueS = assertChequeDueVsReceive(opts);
  assertChequeDueMatchesInvoicePlan(db, { ...opts, due: dueS });
  return dueS;
}

module.exports = {
  toAsciiDigits,
  digitsOnly,
  isValidJalaliDate,
  assertChequeDueVsReceive,
  assertChequeDueMatchesInvoicePlan,
  validateIncomingChequeDue,
  httpErr,
};
