'use strict';
/**
 * P5 — pure barcode helpers (no Express): EAN-13 (internal prefixes 20–29) + Code128-B SVG,
 * and idempotent unique-barcode assignment for products / product_variants.
 *
 * Internal EAN-13 layout: 2-digit prefix (20–29) + 10-digit zero-padded id + check digit.
 * For product ids < 1e6 this is byte-identical to the legacy generator
 * ('200' + '000' + pad6(id) + check), so existing printed labels stay valid.
 */

const PRODUCT_PREFIXES = ['20', '22', '24', '26', '28'];
const VARIANT_PREFIXES = ['21', '23', '25', '27', '29'];

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Check digit for the first 12 digits of an EAN-13 (GS1 mod-10, weights 1/3). */
function ean13CheckDigit(first12) {
  const s = String(first12 || '');
  if (!/^\d{12}$/.test(s)) throw new Error('EAN-13 needs exactly 12 digits before the check digit');
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

function isValidEan13(code) {
  const s = String(code || '');
  if (!/^\d{13}$/.test(s)) return false;
  return ean13CheckDigit(s.slice(0, 12)) === Number(s[12]);
}

/** Internal (in-store) EAN-13 for a numeric id under a 20–29 prefix. */
function internalEan13(prefix, id) {
  const p = String(prefix || '');
  if (!/^2\d$/.test(p)) throw new Error('internal EAN-13 prefix must be 20–29');
  const n = Math.floor(Number(id));
  if (!(n > 0) || n > 9999999999) throw new Error('id out of range for internal EAN-13');
  const base = p + String(n).padStart(10, '0');
  return base + ean13CheckDigit(base);
}

const EAN_SETS = {
  L: ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'],
  G: ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'],
  R: ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'],
};
const EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

/** 95-module bit string for a valid 13-digit EAN. */
function ean13Bits(code) {
  const c = String(code || '');
  if (!/^\d{13}$/.test(c)) throw new Error('EAN-13 needs 13 digits');
  let bits = '101';
  const p = EAN_PARITY[Number(c[0])];
  for (let i = 1; i <= 6; i += 1) bits += EAN_SETS[p[i - 1]][Number(c[i])];
  bits += '01010';
  for (let i = 7; i <= 12; i += 1) bits += EAN_SETS.R[Number(c[i])];
  bits += '101';
  return bits;
}

function ean13Svg(value) {
  const code = String(value || '');
  if (!/^\d{13}$/.test(code)) return `<div class="barcode-text">${escapeHtml(code)}</div>`;
  const bits = ean13Bits(code);
  let bars = '';
  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i] === '1') bars += `<rect x="${i}" y="0" width="1" height="42"></rect>`;
  }
  return `<svg class="bc" data-symbology="ean13" viewBox="0 0 95 55" role="img" aria-label="${escapeHtml(code)}" xmlns="http://www.w3.org/2000/svg"><g>${bars}</g><text x="47.5" y="53" text-anchor="middle">${escapeHtml(code)}</text></svg>`;
}

/** Code 128 bar/space module widths, symbol values 0..106 (106 = stop, 7 elements). */
const CODE128_WIDTHS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const CODE128_START_B = 104;
const CODE128_STOP = 106;

/** Encode printable ASCII (32..126) as Code 128 subset B: { values, checksum }. */
function code128BValues(text) {
  const s = String(text == null ? '' : text);
  if (!s.length) throw new Error('Code128: empty text');
  const values = [CODE128_START_B];
  for (let i = 0; i < s.length; i += 1) {
    const cc = s.charCodeAt(i);
    if (cc < 32 || cc > 126) throw new Error('Code128-B supports printable ASCII only');
    values.push(cc - 32);
  }
  let sum = values[0];
  for (let i = 1; i < values.length; i += 1) sum += values[i] * i;
  const checksum = sum % 103;
  return { values: values.concat([checksum, CODE128_STOP]), checksum };
}

/** Run-length widths (bar,space,bar,…) for a full Code128-B symbol incl. 2-module stop bar. */
function code128BWidths(text) {
  const { values } = code128BValues(text);
  return values.map((v) => CODE128_WIDTHS[v]).join('');
}

function code128Svg(text) {
  const s = String(text == null ? '' : text);
  let widths;
  try { widths = code128BWidths(s); } catch (_) { return `<div class="barcode-text">${escapeHtml(s)}</div>`; }
  const quiet = 10;
  let x = quiet;
  let bars = '';
  for (let i = 0; i < widths.length; i += 1) {
    const w = Number(widths[i]);
    if (i % 2 === 0) bars += `<rect x="${x}" y="0" width="${w}" height="42"></rect>`;
    x += w;
  }
  const total = x + quiet;
  return `<svg class="bc bc-128" data-symbology="code128" viewBox="0 0 ${total} 55" role="img" aria-label="${escapeHtml(s)}" xmlns="http://www.w3.org/2000/svg"><g>${bars}</g><text x="${total / 2}" y="53" text-anchor="middle">${escapeHtml(s)}</text></svg>`;
}

/** symbology: 'ean13' | 'code128' | 'auto' (EAN-13 when valid 13 digits, else Code128-B). */
function barcodeSvg(value, symbology) {
  const v = String(value || '');
  const sym = String(symbology || 'auto').toLowerCase();
  if (sym === 'code128') return code128Svg(v);
  if (sym === 'ean13') return ean13Svg(v);
  return /^\d{13}$/.test(v) ? ean13Svg(v) : code128Svg(v);
}

function barcodeTaken(db, code) {
  const p = db.prepare('SELECT 1 FROM products WHERE barcode=? OR code=? LIMIT 1').get(code, code);
  if (p) return true;
  try {
    const v = db.prepare('SELECT 1 FROM product_variants WHERE barcode=? OR sku=? LIMIT 1').get(code, code);
    if (v) return true;
  } catch (_) { /* variants table optional */ }
  return false;
}

function pickFreeCode(db, prefixes, id) {
  for (const prefix of prefixes) {
    const code = internalEan13(prefix, id);
    if (!barcodeTaken(db, code)) return code;
  }
  const e = new Error('بارکد یکتای داخلی قابل تخصیص نیست — بارکد دستی وارد کنید');
  e.status = 409;
  e.code = 'E_BARCODE_EXHAUSTED';
  throw e;
}

/** Idempotent: returns { barcode, existed }. Deterministic per id → device replay converges. */
function assignProductBarcode(db, productId) {
  const prod = db.prepare('SELECT id, barcode FROM products WHERE id=?').get(productId);
  if (!prod) {
    const e = new Error('یافت نشد');
    e.status = 404;
    throw e;
  }
  if (prod.barcode && String(prod.barcode).trim()) return { barcode: prod.barcode, existed: true };
  const barcode = pickFreeCode(db, PRODUCT_PREFIXES, prod.id);
  db.prepare('UPDATE products SET barcode=? WHERE id=?').run(barcode, prod.id);
  return { barcode, existed: false };
}

function assignVariantBarcode(db, variantId) {
  const v = db.prepare('SELECT id, product_id, barcode FROM product_variants WHERE id=?').get(variantId);
  if (!v) {
    const e = new Error('تنوع یافت نشد');
    e.status = 404;
    throw e;
  }
  if (v.barcode && String(v.barcode).trim()) return { barcode: v.barcode, existed: true, product_id: v.product_id };
  const barcode = pickFreeCode(db, VARIANT_PREFIXES, v.id);
  db.prepare('UPDATE product_variants SET barcode=? WHERE id=?').run(barcode, v.id);
  return { barcode, existed: false, product_id: v.product_id };
}

module.exports = {
  PRODUCT_PREFIXES,
  VARIANT_PREFIXES,
  CODE128_WIDTHS,
  escapeHtml,
  ean13CheckDigit,
  isValidEan13,
  internalEan13,
  ean13Bits,
  ean13Svg,
  code128BValues,
  code128BWidths,
  code128Svg,
  barcodeSvg,
  barcodeTaken,
  assignProductBarcode,
  assignVariantBarcode,
};
