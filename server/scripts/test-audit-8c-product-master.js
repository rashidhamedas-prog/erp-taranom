'use strict';
/**
 * Audit 8C — product uniqueness, EAN, color/size in-use, opening period lock.
 * Run: $env:DB_PATH="server/.tmp-test-artifacts/wave-test-8c.db"; npm --prefix server run test:audit-8c
 */
const path = require('path');
const fs = require('fs');
const {
  isEan13, assertBarcodeOk, validateProductMoneyAndStock, colorInUse, sizeInUse,
} = require('../lib/product-master');
const { swAtLeast } = require('./lib/sw-at-least');

(function guardDbPath() {
  const raw = process.env.DB_PATH || '';
  if (!raw) {
    console.error('FATAL: DB_PATH required under .tmp-test-artifacts');
    process.exit(1);
  }
  if (/^crm.*\.db$/i.test(path.basename(raw))) {
    console.error('FATAL: refuse crm*.db');
    process.exit(1);
  }
})();

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✅', name); }
  else { fail += 1; console.log('  ❌', name, extra == null ? '' : extra); }
}

console.log('\n══ Audit 8C — product master ══\n');

const goodEan = (() => {
  const base = '200000000001';
  const { ean13CheckDigit } = require('../lib/product-master');
  return base + String(ean13CheckDigit(base));
})();
ok('EAN-13 valid', isEan13(goodEan));
ok('EAN-13 bad check', !isEan13('2000000000010'));
ok('assertBarcodeOk good', (() => { try { assertBarcodeOk(goodEan); return true; } catch { return false; } })());
ok('assertBarcodeOk bad 13', (() => {
  try { assertBarcodeOk('2000000000010'); return false; }
  catch (e) { return e.code === 'E_EAN13'; }
})());
ok('negative price throws', (() => {
  try { validateProductMoneyAndStock({ price: -1 }); return false; }
  catch (e) { return e.code === 'E_NEGATIVE_PRICE'; }
})());

const root = path.join(__dirname, '..');
const prodSrc = fs.readFileSync(path.join(root, 'routes/products.js'), 'utf8');
const pvSrc = fs.readFileSync(path.join(root, 'routes/product-variants.js'), 'utf8');
const openSrc = fs.readFileSync(path.join(root, 'lib/opening-post.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(root, 'db.js'), 'utf8');
const syncSrc = fs.readFileSync(path.join(root, 'sync/tables.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

ok('products POST validateProductCreateFields', /validateProductCreateFields/.test(prodSrc));
ok('products PUT validateProductUpdateFields', /validateProductUpdateFields/.test(prodSrc));
ok('opening asserts period lock', /assertPeriodOpen/.test(openSrc) && /موجودی اول دوره محصول/.test(openSrc));
ok('color delete E_COLOR_IN_USE', /E_COLOR_IN_USE/.test(pvSrc));
ok('size delete E_SIZE_IN_USE', /E_SIZE_IN_USE/.test(pvSrc));
ok('db tax_basket_code column', /tax_basket_code/.test(dbSrc));
ok('db iran_product_id column', /iran_product_id/.test(dbSrc));
ok('db product_unit_conversions', /product_unit_conversions/.test(dbSrc));
ok('db unique products code', /idx_products_code_unique/.test(dbSrc));
ok('sync append product_unit_conversions', /product_unit_conversions/.test(syncSrc));
ok('sync_seq_backfill_v30', /sync_seq_backfill_v30/.test(dbSrc));
ok('SW at least 546', swAtLeast(swSrc, 546));
ok('Help mentions 8C', /۸C|8C|کد کالا تکراری|EAN-13/.test(appSrc));
ok('colorInUse exported', typeof colorInUse === 'function' && typeof sizeInUse === 'function');

console.log(`\n── result: ${pass} pass / ${fail} fail ──\n`);
process.exit(fail ? 1 : 0);
