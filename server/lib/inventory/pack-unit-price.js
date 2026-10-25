'use strict';
/**
 * Unit (piece) price for matrix SKU sales — INTEGER rial.
 *
 * Rule A+ (aligned with current pack cart / invoice billing):
 *   1) If product_variants.price_rial > 0 → that value
 *   2) Else style wholesale: products.price (UI stores rial digits) rounded to int
 *      (fallback products.price_rial if price is empty)
 *
 * Does NOT divide by pack_size: style price is already per piece
 * (full pack of N lines bills N × style price today).
 */
const { assertSafeRial } = require('../money');

function styleUnitPriceRial(prod) {
  if (!prod) return 0;
  const fromPrice = Math.round(Number(prod.price) || 0);
  if (fromPrice > 0) return assertSafeRial(fromPrice, 'style.price');
  const fromRial = Math.round(Number(prod.price_rial) || 0);
  return fromRial > 0 ? assertSafeRial(fromRial, 'style.price_rial') : 0;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} productId
 * @param {number|null} variantId
 * @returns {number} integer rial
 */
function unitPriceRialForVariant(db, productId, variantId) {
  const pid = parseInt(productId, 10);
  if (!pid) return 0;
  const prod = db.prepare(
    'SELECT id, price, price_rial FROM products WHERE id=?'
  ).get(pid);
  const style = styleUnitPriceRial(prod);

  const vid = variantId != null && variantId !== '' ? parseInt(variantId, 10) : null;
  if (!vid || !Number.isFinite(vid)) return style;

  let v = null;
  try {
    v = db.prepare(
      'SELECT id, product_id, price, price_rial FROM product_variants WHERE id=?'
    ).get(vid);
  } catch (_) { v = null; }
  if (!v || Number(v.product_id) !== Number(pid)) return style;

  const vr = Math.round(Number(v.price_rial) || 0);
  if (vr > 0) return assertSafeRial(vr, 'variant.price_rial');
  const vp = Math.round(Number(v.price) || 0);
  if (vp > 0) return assertSafeRial(vp, 'variant.price');
  return style;
}

module.exports = {
  unitPriceRialForVariant,
  styleUnitPriceRial,
};
