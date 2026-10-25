'use strict';
/**
 * v546 — محاسبهٔ یکپارچهٔ مبلغ قابل پرداخت فاکتور فروش (ریال صحیح).
 *
 * همین فرمول در `server/public/app.js` (`computeInvoiceTotals`) آینه شده است؛
 * هر تغییری اینجا باید همان‌جا هم اعمال شود (تست test-invoice-pay-totals-v546 همخوانی را می‌سنجد).
 *
 * فرمول:
 *   net ردیف = max(0, round(qty*price - تخفیف ردیف))
 *   subtotal = Σ net ردیف‌ها
 *   discAmt  = مبلغ تخفیف سربرگ (اگر داده شده) وگرنه round(subtotal*discPct/100)
 *   vat      = round(مبنای مشمول × نرخ) — مبنا پس از تخفیف سربرگ به‌نسبت کم می‌شود
 *   payable  = subtotal − discAmt + vat + کرایه (فقط وقتی کرایه به عهدهٔ طرف حساب است)
 */

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/**
 * تبدیل ورودی پولی (عدد یا رشتهٔ فارسی/عربی/لاتین با جداکننده) به ریال صحیح.
 * @param {*} v
 * @param {{strict?: boolean}} [opts] strict=true → ورودی نامعتبر/منفی خطا می‌دهد
 */
function parseMoneyRial(v, opts) {
  const strict = !!(opts && opts.strict);
  const bad = (msg) => {
    if (!strict) return 0;
    const e = new Error(msg || 'مبلغ نامعتبر است');
    e.status = 400;
    e.code = 'E_MONEY_INVALID';
    throw e;
  };
  if (v == null || v === '') return 0;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return bad('مبلغ نامعتبر است');
    if (v < 0) return bad('مبلغ نمی‌تواند منفی باشد');
    return Math.round(v);
  }
  let s = String(v)
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .replace(/[٫]/g, '.') // ممیز عربی
    .replace(/[,٬،\s\u00a0\u200c\u200f\u200e]/g, '');
  if (s === '') return 0;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return bad('مبلغ نامعتبر است: ' + String(v));
  const n = Number(s);
  if (!Number.isFinite(n)) return bad('مبلغ نامعتبر است');
  if (n < 0) return bad('مبلغ نمی‌تواند منفی باشد');
  return Math.round(n);
}

function normalizeFreightTypeLocal(v) {
  const t = String(v || '').trim().toLowerCase();
  if (t === 'seller' || t === 'عهده فروشنده' || t === 'فروشنده') return 'seller';
  if (t === 'buyer' || t === 'عهده خریدار' || t === 'خریدار') return 'buyer';
  return '';
}

/** هم‌راستا با sales-document.freightChargedToCounterparty: فقط «فروشنده» کرایه را جذب می‌کند. */
function freightCharged(freightType) {
  return normalizeFreightTypeLocal(freightType) !== 'seller';
}

function numOr0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** تخفیف ردیف: مبلغ اولویت دارد، وگرنه از درصد (مثل buildRows). */
function lineDiscountRial(item, gross) {
  const amtIn = Math.max(0, Math.round(numOr0(item.disc_amount != null ? item.disc_amount : item.disc_amt)));
  if (amtIn > 0) return amtIn;
  const pct = Math.min(100, Math.max(0, numOr0(item.disc)));
  return Math.round(gross * pct / 100);
}

/**
 * @param {object} p
 * @param {Array<{qty:number, price:number, disc?:number, disc_amount?:number, disc_amt?:number}>} p.items
 * @param {number} [p.discPct]
 * @param {number|null} [p.discAmt] اگر null/''/undefined باشد از discPct محاسبه می‌شود
 * @param {boolean} [p.vatExempt]
 * @param {number} [p.vatRate] درصد (مثلاً ۱۰)
 * @param {number} [p.freightAmount]
 * @param {string} [p.freightType] seller | buyer | ''
 * @param {(item:object)=>boolean} [p.lineIsVatExempt]
 * @returns {{subtotal:number, discAmt:number, vatAmount:number, vatRate:number, freightCharged:number, payable:number}}
 */
function computeInvoiceTotals(p) {
  const o = p || {};
  const items = Array.isArray(o.items) ? o.items : [];
  const lineExempt = typeof o.lineIsVatExempt === 'function' ? o.lineIsVatExempt : () => false;

  let subtotal = 0;
  let taxable = 0;
  for (const it of items) {
    const qty = numOr0(it.qty);
    const price = numOr0(it.price);
    const gross = qty * price;
    const net = Math.max(0, Math.round(gross - lineDiscountRial(it, gross)));
    subtotal += net;
    if (!lineExempt(it)) taxable += net;
  }

  const hasOverride = o.discAmt != null && o.discAmt !== '';
  const discAmt = hasOverride
    ? Math.max(0, Math.round(numOr0(o.discAmt)))
    : Math.round(subtotal * numOr0(o.discPct) / 100);

  let vatAmount = 0;
  let vatRate = 0;
  if (!o.vatExempt) {
    vatRate = o.vatRate != null && o.vatRate !== '' ? numOr0(o.vatRate) : 10;
    let base = taxable;
    if (subtotal > 0 && discAmt > 0) base = Math.round(base * (1 - discAmt / subtotal));
    else base = Math.max(0, base);
    vatAmount = Math.round(base * vatRate / 100);
  }

  const freight = Math.max(0, Math.round(numOr0(o.freightAmount)));
  const freightChargedRial = freight > 0 && freightCharged(o.freightType) ? freight : 0;
  const payable = Math.max(0, subtotal - discAmt + vatAmount + freightChargedRial);

  return {
    subtotal,
    discAmt,
    vatAmount,
    vatRate,
    freightCharged: freightChargedRial,
    payable,
  };
}

function formatRial(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-US');
}

module.exports = { parseMoneyRial, computeInvoiceTotals, formatRial };
