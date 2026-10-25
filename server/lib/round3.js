/**
 * Quantity rounding to 3 decimal places (Update 11 / D1).
 * Money stays INTEGER rial — only qty/stock use REAL + round3.
 */
function round3(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 1000) / 1000;
}

/** Normalize Persian/Arabic-Indic digits to ASCII before parse. */
function normalizeDigits(v) {
  return String(v == null ? '' : v)
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

/** Parse user/API qty → round3 float (never parseInt). Accepts FA/AR digits. */
function parseQty(v, fallback = 0) {
  if (v == null || v === '') return round3(fallback);
  const x = parseFloat(normalizeDigits(v).replace(/,/g, ''));
  if (!Number.isFinite(x)) return round3(fallback);
  return round3(x);
}

/**
 * Strict qty for invoice/return lines: >0 finite, else E_QTY_INVALID.
 * @throws {{status:400,code:'E_QTY_INVALID'}}
 */
function requirePositiveQty(v, fallback) {
  if (v == null || v === '') {
    if (fallback != null && Number(fallback) > 0) return round3(fallback);
  }
  const x = parseQty(v, NaN);
  if (!Number.isFinite(x) || !(x > 0)) {
    const e = new Error('تعداد نامعتبر است — باید عددی بزرگ‌تر از صفر باشد');
    e.status = 400;
    e.code = 'E_QTY_INVALID';
    throw e;
  }
  return x;
}

/** Display qty: up to 3 decimals, trim trailing zeros. */
function fmtQty(n) {
  const x = round3(n);
  if (Object.is(x, -0) || x === 0) return '0';
  return String(parseFloat(x.toFixed(3)));
}

module.exports = { round3, parseQty, fmtQty, normalizeDigits, requirePositiveQty };
