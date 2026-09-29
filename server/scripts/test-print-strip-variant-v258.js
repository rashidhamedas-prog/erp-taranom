'use strict';
/**
 * v258: print identity = product code only; strip variant labels from name/desc.
 * e.g. «سفید-سایز 1 (مناسب از 38 تا 42)» must not appear in شرح کالا.
 */
const {
  collapsePrintRows,
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

console.log('\n══ Print strip variant label v258 ══\n');

const bad = 'سفید-سایز 1 (مناسب از 38 تا 42)';
ok(looksLikeVariantLabel(bad, { color_name: 'سفید', size_name: 'سایز 1 (مناسب از 38 تا 42)' }),
  'detect hyphen size label');
ok(looksLikeVariantLabel(bad, {}), 'detect even without row color/size');
ok(sanitizePrintName(bad, { code: '7132' }) === '', 'sanitize clears variant-only name');
ok(sanitizePrintName('7132-' + bad, { code: '7132' }) === '', 'sanitize clears code-prefixed variant name');
ok(sanitizePrintName('مانتو شومیزی', { code: 'P1' }) === 'مانتو شومیزی', 'keeps clean style name');

const collapsed = collapsePrintRows([{
  product_id: 1, variant_id: 9, name: bad, code: '7132',
  color_name: 'سفید', size_name: 'سایز 1 (مناسب از 38 تا 42)',
  qty: 16, price: 4800000, disc: 0, disc_amount: 0, sum: 76800000, unit: 'عدد',
}]);
ok(collapsed.length === 1, 'one print row');
ok(collapsed[0].code === '7132', 'code kept');
ok(!collapsed[0].name, 'name cleared', collapsed[0].name);
ok(!/سفید|سایز|مناسب/.test(String(collapsed[0].description || '')), 'desc has no variant');

const html = renderInvoicePrintHtml({
  inv: {
    id: 1, num: 'T-0001', type: 'normal', date: '1405/07/06',
    final: 76800000, final_rial: 76800000, pay_type: 'bank_transfer',
    cust_biz: 'تست',
  },
  rows: [{
    product_id: 1, variant_id: 9, name: bad, code: '7132',
    color_name: 'سفید', size_name: 'سایز 1 (مناسب از 38 تا 42)',
    qty: 16, price: 4800000, disc: 0, disc_amount: 0, sum: 76800000, unit: 'عدد',
  }],
  settings: {
    company_name: 'پوشاک ترنم', invoice_paper_size: 'A5',
    invoice_customize: JSON.stringify({ show_seller: false, show_payment: true }),
  },
  paper: 'A5',
});
ok(/7132/.test(html), 'HTML has product code');
ok(!/سفید-سایز/.test(html) && !/مناسب از 38/.test(html), 'HTML has no variant label in body');

console.log(`\n══ Result: ${pass} pass, ${fail} fail ══\n`);
process.exit(fail ? 1 : 0);
