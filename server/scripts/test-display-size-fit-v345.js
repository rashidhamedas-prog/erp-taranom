/**
 * Display size fit-note strip + warehouse slip code/size (v345)
 * Run: node server/scripts/test-display-size-fit-v345.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  stripSizeFitNote, displaySizeName, variantAttrsLabel, displayProductCode,
} = require('../lib/display-labels');
const {
  normalizeSlipLines, buildSalesInvoiceSlip, renderWarehouseSlipHtml,
} = require('../lib/warehouse-slip-print');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  PASS', msg); }
  else { failed++; console.error('  FAIL', msg); }
}

console.log('=== display-size-fit v345 ===');

ok(stripSizeFitNote('فری سایز (مناسب تا 48)') === 'فری سایز', 'free-size latin digits');
ok(stripSizeFitNote('فری سایز (مناسب تا ۴۸)') === 'فری سایز', 'free-size persian digits');
ok(stripSizeFitNote('سایز 1 (مناسب از 38 تا 42)') === 'سایز 1', 'sized range');
ok(stripSizeFitNote('سایز ۲ (مناسب از ۴۴ تا ۴۸)') === 'سایز ۲', 'sized range fa');
ok(displaySizeName('M') === 'M', 'plain size untouched');
ok(displaySizeName('') === '', 'empty');
ok(variantAttrsLabel('آبی آسمانی', 'فری سایز (مناسب تا 48)') === 'آبی آسمانی / فری سایز', 'pair label');

const matrix = 'K-00007-آبی آسمانی-فری سایز (مناسب تا 48)';
ok(displayProductCode({
  code: matrix,
  color_name: 'آبی آسمانی',
  size_name: 'فری سایز (مناسب تا 48)',
}) === 'K-00007', 'peel matrix sku to catalog');
ok(displayProductCode({
  product_code: 'K-00007',
  code: matrix,
  color_name: 'آبی آسمانی',
  size_name: 'فری سایز (مناسب تا 48)',
}) === 'K-00007', 'prefer product_code');

const lines = normalizeSlipLines([{
  name: 'لی خیابانی Sonel',
  code: matrix,
  qty: 1,
  color_name: 'آبی آسمانی',
  size_name: 'فری سایز (مناسب تا 48)',
  unit: 'عدد',
}]);
ok(lines.length === 1, 'one slip line');
ok(lines[0].code === 'K-00007', 'slip code is catalog');
ok(lines[0].size === 'فری سایز', 'slip size without fit note');
ok(lines[0].color === 'آبی آسمانی', 'slip keeps color');
ok(!/مناسب/.test(lines[0].code + lines[0].size), 'no مناسب in code/size');

const fakeDb = {
  prepare() {
    return { get() { return null; }, all() { return []; } };
  },
};
const html = buildSalesInvoiceSlip(fakeDb, {
  num: 'T-TEST', date: '1405/07/19', type: 'normal',
  cust_biz: 'تست',
}, [{
  name: 'لی خیابانی Sonel',
  code: matrix,
  qty: 2,
  color_name: 'آبی آسمانی',
  size_name: 'فری سایز (مناسب تا 48)',
}], { company_name: 'پوشاک ترنم' }, 'A5');

ok(html.includes('K-00007'), 'html has catalog code');
ok(!html.includes(matrix), 'html omits full matrix sku');
ok(html.includes('فری سایز'), 'html shows short size');
ok(!/مناسب\s+تا/.test(html), 'html has no مناسب تا');
ok(html.includes('آبی آسمانی'), 'html keeps color');

const bare = renderWarehouseSlipHtml({
  docKind: 'sales_issue',
  paper: 'A5',
  settings: { company_name: 'ترنم' },
  doc: { num: 'T-1', date: '1405/01/01' },
  lines: [{
    line_no: 1, code: 'K-1', name: 'x', color: 'c',
    size: 'فری سایز', qty: 1, unit: 'عدد', warehouse: '', note: '',
  }],
});
ok(bare.includes('warehouse-slip-print.css?v=345'), 'css cache bust 345');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(appJs.includes('function stripSizeFitNote'), 'frontend stripSizeFitNote');
ok(appJs.includes('function displaySizeName'), 'frontend displaySizeName');
ok(appJs.includes('function variantAttrsLabel'), 'frontend variantAttrsLabel');
ok(appJs.includes('displaySizeName(r.size_name'), 'packSubtitle uses displaySizeName');
ok((appJs.match(/variantAttrsLabel\(/g) || []).length >= 8, 'variantAttrsLabel wired in UI');
ok(appJs.includes('data-sname="${esc(v.size_name||\'\')}"'), 'data-sname keeps master size');
ok(!/data-sname="\$\{esc\(displaySizeName/.test(appJs), 'data-sname not stripped');

const svc = fs.readFileSync(path.join(__dirname, '../lib/product-variants/service.js'), 'utf8');
ok(svc.includes("require('../display-labels')"), 'variantLineSummary uses display-labels');
ok(svc.includes('sizesDisp'), 'variant summary display sizes');

const mk = fs.readFileSync(path.join(__dirname, '../public/marketer-ui.js'), 'utf8');
ok(mk.includes('variantAttrsLabel'), 'marketer skuLabel uses variantAttrsLabel');
const vsr = fs.readFileSync(path.join(__dirname, '../public/variant-stock-report.js'), 'utf8');
ok(vsr.includes('displaySizeName'), 'VSR size column strips fit note');

const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
ok(sw.includes('erp-taranom-v345'), 'SW v345');
const index = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
ok(index.includes('app.js?v=345'), 'index cache-bust v345');
ok(index.includes('marketer-ui.js?v=345'), 'marketer cache-bust v345');
ok(index.includes('variant-stock-report.js?v=345'), 'vsr cache-bust v345');

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
