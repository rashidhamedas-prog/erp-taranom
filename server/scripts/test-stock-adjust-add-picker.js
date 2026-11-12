'use strict';
/**
 * Unit + source-shape tests for stock-adjust aggregated add-picker (SW v645).
 * No production DB writes. Never uses product 342.
 */
const fs = require('fs');
const path = require('path');
const { resolveAdjustDocProduct, toAsciiDigits } = require('../lib/inventory/adjust-product-resolve');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log('  OK', msg);
  } else {
    failed++;
    console.log('  FAIL', msg);
  }
}

const fixtures = [
  { id: 10, code: '7132', name: 'تیرا', barcode: 'BC7132', sku: 'SKU-TIRA' },
  { id: 11, code: '1001', name: 'مانتو یلدا آبی', barcode: '', sku: '' },
  { id: 12, code: '1002', name: 'مانتو یلدا قرمز', barcode: '', sku: '' },
  { id: 13, code: '2001', name: 'کیمیا', barcode: 'DUPBC', sku: '' },
  { id: 14, code: '2002', name: 'کیمیا ۲', barcode: 'DUPBC', sku: '' },
];

console.log('— resolveAdjustDocProduct —');
ok(toAsciiDigits('۷۱۳۲') === '7132', 'Persian digits → ASCII');
{
  const r = resolveAdjustDocProduct(fixtures, { raw: '۷۱۳۲' });
  ok(r.ok && r.product.id === 10, 'Persian digit code resolves');
}
{
  const r = resolveAdjustDocProduct(fixtures, { raw: '7132' });
  ok(r.ok && r.product.id === 10, 'Latin code resolves');
}
{
  const r = resolveAdjustDocProduct(fixtures, { raw: 'تیرا' });
  ok(r.ok && r.product.id === 10, 'unique name resolves');
}
{
  const r = resolveAdjustDocProduct(fixtures, { raw: 'BC7132' });
  ok(r.ok && r.product.id === 10, 'barcode resolves');
}
{
  const r = resolveAdjustDocProduct(fixtures, { raw: 'SKU-TIRA' });
  ok(r.ok && r.product.id === 10, 'sku resolves');
}
{
  const r = resolveAdjustDocProduct(fixtures, { raw: '7132 - تیرا' });
  ok(r.ok && r.product.id === 10, 'hyphen label resolves like em-dash');
}
{
  const r = resolveAdjustDocProduct(fixtures, { raw: '7132 — تیرا' });
  ok(r.ok && r.product.id === 10, 'em-dash pLabel resolves');
}
{
  const r = resolveAdjustDocProduct(fixtures, { hiddenId: 11, raw: 'garbage' });
  ok(r.ok && r.product.id === 11, 'hidden id wins over typed garbage');
}
{
  const r = resolveAdjustDocProduct(fixtures, { raw: 'یلدا' });
  ok(!r.ok && /چند کالا/.test(r.error), 'ambiguous partial name → pick from list');
}
{
  const r = resolveAdjustDocProduct(fixtures, { raw: 'zzzz-nope' });
  ok(!r.ok && /پیدا نشد/.test(r.error), 'unknown → not found');
}
{
  const r = resolveAdjustDocProduct(fixtures, { raw: '' });
  ok(!r.ok && /انتخاب کنید/.test(r.error), 'empty → select product');
}
{
  const r = resolveAdjustDocProduct([], { raw: '7132', cacheFailed: true, cacheErrorMsg: 'network' });
  ok(!r.ok && /بارگذاری نشد/.test(r.error) && /network/.test(r.error), 'empty cache with failure message');
}
{
  const r = resolveAdjustDocProduct(fixtures, { raw: 'DUPBC' });
  ok(!r.ok && /چند کالا/.test(r.error), 'ambiguous barcode');
}
{
  // never fixture 342
  ok(!fixtures.some((p) => Number(p.id) === 342), 'fixtures exclude product 342');
}

console.log('— app.js shape (v645 picker) —');
const appPath = path.join(__dirname, '../public/app.js');
const app = fs.readFileSync(appPath, 'utf8');
ok(!/datalist id="sadd-products"/.test(app), 'no sadd-products datalist');
ok(/productSelect\(\s*['"]sadd-prod['"]/.test(app), 'uses productSelect(sadd-prod)');
ok(/initCustSearches\(\s*sadjRoot\(\)\s*\)/.test(app) || /initCustSearches\(sadjRoot\(\)\)/.test(app), 'initCustSearches(sadjRoot())');
ok(/sadd-add-err/.test(app), 'in-modal error node sadd-add-err');
ok(/resolveAdjustDocProduct/.test(app), 'resolveAdjustDocProduct present in app.js');
{
  const i = app.indexOf('function openStockAdjustDocModal');
  const slice = i >= 0 ? app.slice(i, i + 20000) : '';
  ok(i >= 0 && /sadd-prod-input/.test(slice) && /e\.key===['"]Enter['"]/.test(slice), 'Enter handler in openStockAdjustDocModal');
  ok(/setSearchSelect\(\s*['"]sadd-prod['"]/.test(slice), 'clears via setSearchSelect after add');
  ok(/افزودن/.test(slice) && /type="button"/.test(slice), 'add button type=button');
}

console.log('— SW / index cache bump —');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
ok(/erp-taranom-v64[56]/.test(sw) || /erp-taranom-v646/.test(sw), 'SW CACHE v645+');
ok(/app\.js\?v=64[56]/.test(index) || /app\.js\?v=646/.test(index), 'index app.js?v=645+');

console.log('— new Function(app.js) —');
try {
  // eslint-disable-next-line no-new-func
  new Function(app);
  ok(true, 'app.js parses');
} catch (e) {
  ok(false, 'app.js parses: ' + (e && e.message));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
