'use strict';
/**
 * v321: invoice print code column is the catalog code, not the matrix SKU.
 * «K-00002-مشگی-فری سایز (مناسب تا 48)» prints as K-00002.
 */
const {
  collapsePrintRows,
  canonicalPrintCode,
  looksLikeVariantLabel,
  sanitizePrintName,
} = require('../lib/print-line-collapse');
const { renderInvoicePrintHtml } = require('../lib/invoice-print');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

console.log('\n══ Print style code v321 ══\n');

const matrixSku = 'K-00002-مشگی-فری سایز (مناسب تا 48)';
const row = {
  product_id: 2,
  variant_id: 48,
  name: 'وست ژرا 662',
  code: matrixSku,
  sku: matrixSku,
  color_name: 'مشگی',
  size_name: 'فری سایز (مناسب تا 48)',
  qty: 3,
  price: 19800000,
  disc: 0,
  disc_amount: 0,
  sum: 59400000,
  unit: 'عدد',
};

ok(looksLikeVariantLabel('مشگی-فری سایز (مناسب تا 48)', {}), 'free-size label detected');
ok(canonicalPrintCode(row) === 'K-00002', 'canonical code drops variant tail', canonicalPrintCode(row));
ok(canonicalPrintCode({ code: 'K-00002' }) === 'K-00002', 'plain catalog code unchanged');
ok(canonicalPrintCode({ code: 'PR-12-EXTRA' }) === 'PR-12-EXTRA', 'latin suffix that is not a size stays');
ok(sanitizePrintName('وست ژرا 662', row) === 'وست ژرا 662', 'style name kept');
ok(sanitizePrintName('مشگی-فری سایز (مناسب تا 48)', row) === '', 'variant-only name cleared');

const collapsed = collapsePrintRows([row]);
ok(collapsed.length === 1 && collapsed[0].code === 'K-00002', 'collapsed code is catalog code', collapsed[0] && collapsed[0].code);
ok(collapsed[0] && collapsed[0].name === 'وست ژرا 662', 'collapsed name kept');
ok(!/مشگی|فری سایز|مناسب تا/.test(String(collapsed[0].description || '')), 'desc has no variant');

const inv = {
  id: 4, num: 'T-0004', type: 'normal', date: '1405/07/14',
  final: 59400000, subtotal: 59400000, pay_type: 'credit',
  cust_biz: 'آقای نصراللهی',
};
const settings = {
  company_name: 'پوشاک ترنم',
  invoice_customize: JSON.stringify({ show_seller: true, show_payment: true }),
};

function assertClean(html, label) {
  ok(html.includes('K-00002'), label + ' has catalog code');
  ok(!html.includes(matrixSku), label + ' omits matrix SKU', html.includes('مشگی') ? 'still has مشگی' : '');
  ok(!/مشگی|فری سایز|مناسب تا/.test(html), label + ' omits color and size text');
  ok(html.includes('وست ژرا 662'), label + ' keeps style name');
}

assertClean(renderInvoicePrintHtml({
  inv, rows: [row], settings, paper: 'A5', templateOverride: 'casual-simple',
}), 'A5 casual');
assertClean(renderInvoicePrintHtml({
  inv, rows: [row], settings, paper: 'A5', templateOverride: 'formal-official',
}), 'A5 formal');
assertClean(renderInvoicePrintHtml({
  inv, rows: [row], settings, paper: 'A4', templateOverride: 'formal-official',
}), 'A4 formal');
assertClean(renderInvoicePrintHtml({
  inv, rows: [row], settings, paper: 'THERMAL', templateOverride: 'thermal',
}), 'thermal');

const oldLabel = '7132-سفید-سایز 1 (مناسب از 38 تا 42)';
ok(canonicalPrintCode({ code: oldLabel, name: 'مانتو' }) === '7132', 'numeric style code peeled', canonicalPrintCode({ code: oldLabel }));

const fakeDb = {
  prepare() {
    return {
      get(id) { return Number(id) === 7 ? { code: 'K-00002' } : null; },
    };
  },
};
const fromCatalog = renderInvoicePrintHtml({
  inv, settings, paper: 'A5', templateOverride: 'casual-simple', db: fakeDb,
  rows: [{
    product_id: 7, variant_id: 1, name: 'وست ژرا 662',
    code: 'SITE-ONLY-سایز', qty: 1, price: 10, sum: 10, unit: 'عدد',
  }],
});
ok(fromCatalog.includes('K-00002') && !fromCatalog.includes('SITE-ONLY'), 'catalog code wins over nonstandard SKU');

console.log(`\n══ Result: ${pass} pass, ${fail} fail ══\n`);
process.exit(fail ? 1 : 0);
