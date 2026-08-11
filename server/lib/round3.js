/**
 * Quantity rounding to 3 decimal places (Update 11 / D1).
 * Money stays INTEGER rial — only qty/stock use REAL + round3.
 */
function round3(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 1000) / 1000;
}

/** Parse user/API qty → round3 float (never parseInt). */
function parseQty(v, fallback = 0) {
  if (v == null || v === '') return round3(fallback);
  const x = parseFloat(String(v).replace(/,/g, ''));
  if (!Number.isFinite(x)) return round3(fallback);
  return round3(x);
}

/** Display qty: up to 3 decimals, trim trailing zeros. */
function fmtQty(n) {
  const x = round3(n);
  if (Object.is(x, -0) || x === 0) return '0';
  return String(parseFloat(x.toFixed(3)));
}

module.exports = { round3, parseQty, fmtQty };
