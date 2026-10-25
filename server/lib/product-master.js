'use strict';
/**
 * Audit 8C — product master field guards (uniqueness, non-negative, EAN).
 */
const V = require('./validators');

function ean13CheckDigit(digits12) {
  const s = String(digits12);
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const n = parseInt(s[i], 10);
    sum += i % 2 === 0 ? n : n * 3;
  }
  return (10 - (sum % 10)) % 10;
}

function isEan13(raw) {
  const s = V.digitsOnly(raw);
  if (!/^\d{13}$/.test(s)) return false;
  return ean13CheckDigit(s.slice(0, 12)) === parseInt(s[12], 10);
}

function assertNonNegative(label, raw, code) {
  if (raw == null || String(raw).trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw V.err((label || 'مقدار') + ' نمی‌تواند منفی باشد', code || 'E_NEGATIVE');
  }
  return n;
}

function assertBarcodeOk(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const dig = V.digitsOnly(raw);
  if (dig.length === 13) {
    if (!isEan13(dig)) throw V.err('بارکد EAN-13 نامعتبر است', 'E_EAN13');
    return dig;
  }
  const t = String(raw).trim();
  if (t.length < 3) throw V.err('بارکد خیلی کوتاه است', 'E_BARCODE');
  return t;
}

function assertUniqueProductCode(db, code, excludeId) {
  const c = String(code || '').trim();
  if (!c) return;
  const row = excludeId
    ? db.prepare('SELECT id FROM products WHERE code=? AND id<>? LIMIT 1').get(c, excludeId)
    : db.prepare('SELECT id FROM products WHERE code=? LIMIT 1').get(c);
  if (row) throw V.err('کد کالا تکراری است', 'E_DUP_CODE', 409);
}

function assertUniqueProductBarcode(db, barcode, excludeId) {
  const b = barcode == null || String(barcode).trim() === '' ? null : String(barcode).trim();
  if (!b) return;
  const row = excludeId
    ? db.prepare('SELECT id FROM products WHERE barcode=? AND id<>? LIMIT 1').get(b, excludeId)
    : db.prepare('SELECT id FROM products WHERE barcode=? LIMIT 1').get(b);
  if (row) throw V.err('بارکد کالا تکراری است', 'E_DUP_BARCODE', 409);
}

function assertUniqueVariantSku(db, sku, excludeId) {
  const s = String(sku || '').trim();
  if (!s) return;
  const row = excludeId
    ? db.prepare('SELECT id FROM product_variants WHERE sku=? AND id<>? LIMIT 1').get(s, excludeId)
    : db.prepare('SELECT id FROM product_variants WHERE sku=? LIMIT 1').get(s);
  if (row) throw V.err('SKU واریانت تکراری است', 'E_DUP_SKU', 409);
}

function validateProductMoneyAndStock(body) {
  const b = body || {};
  assertNonNegative('قیمت', b.price, 'E_NEGATIVE_PRICE');
  assertNonNegative('بهای تمام‌شده', b.cost, 'E_NEGATIVE_COST');
  assertNonNegative('موجودی', b.stock, 'E_NEGATIVE_STOCK');
  assertNonNegative('قیمت مصرف‌کننده', b.consumer_price, 'E_NEGATIVE_PRICE');
  assertNonNegative('قیمت خرده', b.retail_price, 'E_NEGATIVE_PRICE');
  assertNonNegative('قیمت اول دوره', b.opening_price, 'E_NEGATIVE_COST');
  if (Object.prototype.hasOwnProperty.call(b, 'barcode')) assertBarcodeOk(b.barcode);
}

function validateProductCreateFields(db, body) {
  validateProductMoneyAndStock(body);
  const code = body && body.code != null ? String(body.code).trim() : '';
  if (code) assertUniqueProductCode(db, code, null);
  if (body && body.barcode != null && String(body.barcode).trim() !== '') {
    const bc = assertBarcodeOk(body.barcode);
    assertUniqueProductBarcode(db, bc, null);
  }
}

function validateProductUpdateFields(db, body, productId) {
  validateProductMoneyAndStock(body);
  if (body && Object.prototype.hasOwnProperty.call(body, 'code') && String(body.code || '').trim()) {
    assertUniqueProductCode(db, body.code, productId);
  }
  if (body && Object.prototype.hasOwnProperty.call(body, 'barcode')) {
    const bc = assertBarcodeOk(body.barcode);
    if (bc) assertUniqueProductBarcode(db, bc, productId);
  }
}

function colorInUse(db, colorId) {
  return !!db.prepare(`
    SELECT 1 FROM product_variants WHERE color_id=? AND COALESCE(active,1)=1 LIMIT 1
  `).get(colorId);
}

function sizeInUse(db, sizeId) {
  return !!db.prepare(`
    SELECT 1 FROM product_variants WHERE size_id=? AND COALESCE(active,1)=1 LIMIT 1
  `).get(sizeId);
}

module.exports = {
  isEan13,
  ean13CheckDigit,
  assertNonNegative,
  assertBarcodeOk,
  assertUniqueProductCode,
  assertUniqueProductBarcode,
  assertUniqueVariantSku,
  validateProductMoneyAndStock,
  validateProductCreateFields,
  validateProductUpdateFields,
  colorInUse,
  sizeInUse,
};
