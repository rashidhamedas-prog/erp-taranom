'use strict';
/**
 * Print line collapse v204 — one product = one printed row.
 * Run: node server/scripts/test-print-collapse-v204.js
 */
const { collapsePrintRows, renderInvoicePrintHtml, computePrintTotals } = require('../lib/invoice-print');
const collapseLib = require('../lib/print-line-collapse');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra == null ? '' : extra); }
}

function sku(over) {
  return Object.assign({
    product_id: 10,
    name: 'مانتو شومیزی',
    variant_id: 101,
    color_name: 'مشکی',
    size_name: 'L',
    qty: 2,
    price: 1000000,
    disc: 0,
    disc_amount: 0,
    sum: 2000000,
    unit: 'عدد',
    code: 'P-10',
    sku: 'SKU-BLK-L',
    warehouse_id: 1,
  }, over);
}

const threeSkus = [
  sku({ variant_id: 101, color_name: 'مشکی', size_name: 'L', qty: 2, sum: 2000000 }),
  sku({ variant_id: 102, color_name: 'مشکی', size_name: 'XL', qty: 1, sum: 1000000 }),
  sku({ variant_id: 103, color_name: 'سفید', size_name: 'M', qty: 2, sum: 2000000 }),
];

// 1) سه SKU هم‌قیمت → یک ردیف
const c1 = collapsePrintRows(threeSkus);
ok(c1.length === 1, '3 SKUs collapse to 1 row', c1.length);
ok(c1[0] && c1[0].qty === 5, 'collapsed qty is sum', c1[0] && c1[0].qty);
ok(c1[0] && String(c1[0].name).indexOf('مشکی') === -1, 'product name has no color in title', c1[0] && c1[0].name);
const d1 = String(c1[0] && c1[0].description || '');
ok(d1.indexOf('مشکی') !== -1 && d1.indexOf('سفید') !== -1, 'summary has color names', d1);
ok(/L×[۲2]/.test(d1) && /XL×[۱1]/.test(d1) && /M×[۲2]/.test(d1), 'summary has size×qty', d1);
ok(c1[0] && c1[0].code === 'P-10' && c1[0].sku === 'P-10', 'code/sku is product code not SKU barcode');

// 2) دو قیمت متفاوت → دو ردیف
const twoPrices = [
  sku({ price: 1000000, sum: 2000000, variant_id: 1 }),
  sku({ price: 1500000, sum: 3000000, qty: 2, variant_id: 2, size_name: 'XL' }),
];
const c2 = collapsePrintRows(twoPrices);
ok(c2.length === 2, 'same product two prices → 2 rows', c2.length);

// 3) طاقه / درآمد / بدون variant → جمع نمی‌شود
const noCollapse = [
  sku({ is_fabric_roll: 1, variant_id: 9, name: 'پارچه' }),
  sku({ row_type: 'income', variant_id: 8, name: 'خدمات' }),
  { name: 'بدون واریانت', qty: 1, price: 100, sum: 100, product_id: 3 },
];
const c3 = collapsePrintRows(noCollapse);
ok(c3.length === noCollapse.length, 'fabric/income/no-variant stay 1:1', c3.length);

const oneSku = collapsePrintRows([sku()]);
ok(oneSku.length === 1 && /مشکی/.test(String(oneSku[0].description)) && /L×[۲2]/.test(String(oneSku[0].description)),
  'single SKU still gets compact summary', oneSku[0] && oneSku[0].description);

// 4) HTML چاپ — یک tr داده در tbody اقلام
const inv = {
  num: 'T-0204', type: 'normal', date: '1405/06/16', cust_biz: 'مشتری چاپ',
  pay_type: 'cash', subtotal: 5000000, final: 5000000,
};
const html = renderInvoicePrintHtml({
  inv,
  rows: threeSkus,
  settings: { company_name: 'پوشاک ترنم' },
  paper: 'A4',
  templateOverride: 'formal-official',
});
const tbody = (html.match(/<table class="items">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/) || [])[1] || '';
const dataRows = tbody.match(/<tr[\s>]/g) || [];
ok(dataRows.length === 1, 'print HTML has one item data row', dataRows.length + ' in: ' + tbody.slice(0, 180));
ok(html.indexOf('مانتو شومیزی') !== -1, 'print HTML has product name');
ok(/مشکی/.test(html) && /سفید/.test(html) && /L×[۲2]/.test(html), 'print HTML has compact summary');

// 5) XSS
const xssRows = [
  sku({ color_name: '</td><script>alert(1)</script>', size_name: 'L', qty: 2 }),
];
const xssHtml = renderInvoicePrintHtml({
  inv, rows: xssRows, settings: { company_name: 'پوشاک ترنم' }, paper: 'A4',
});
ok(xssHtml.indexOf('<script>') === -1, 'script tag not raw in HTML');
ok(xssHtml.indexOf('&lt;/td&gt;') !== -1 || xssHtml.indexOf('&lt;script&gt;') !== -1,
  'color_name XSS is escaped', xssHtml.includes('script') ? 'has escaped script' : 'missing escape');

// 6) جمع خالص ردیف‌های جمع‌شده = جمع اصلی
function nets(list) {
  return list.reduce((a, r) => a + collapseLib.lineNet(r), 0);
}
const origNet = nets(threeSkus);
const colNet = nets(c1);
ok(origNet === colNet, 'collapsed lineNet sum equals original', origNet + ' vs ' + colNet);
const totOrig = computePrintTotals(inv, threeSkus);
const totCol = computePrintTotals(inv, c1);
ok(totOrig.rowsNet === totCol.rowsNet, 'computePrintTotals rowsNet unchanged', totOrig.rowsNet + ' vs ' + totCol.rowsNet);

// 7) فاکتور خرید هم جمع می‌شود
const buyHtml = renderInvoicePrintHtml({
  inv: Object.assign({}, inv, { doc_kind: 'purchase', type: 'purchase', num: 'P-0204' }),
  rows: threeSkus,
  settings: { company_name: 'پوشاک ترنم' },
  paper: 'A4',
  templateOverride: 'formal-official',
});
const buyBody = (buyHtml.match(/<table class="items">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/) || [])[1] || '';
const buyRows = buyBody.match(/<tr[\s>]/g) || [];
ok(buyRows.length === 1, 'purchase print also collapses to 1 row', buyRows.length);
ok(buyHtml.indexOf('فاکتور خرید') !== -1, 'purchase label present');
ok(/مشکی/.test(buyHtml) && /L×[۲2]/.test(buyHtml), 'purchase HTML has compact summary');

// حرارتی: همان جمع + برش توضیح
const longSku = [];
for (let i = 0; i < 12; i++) {
  longSku.push(sku({
    variant_id: 200 + i,
    color_name: 'رنگ‌بلند-' + i,
    size_name: 'XXL',
    qty: 3,
    sum: 3000000,
  }));
}
const thermalCollapsed = collapsePrintRows(longSku, { thermal: true });
ok(thermalCollapsed.length === 1, 'thermal collapse still 1 row');
ok(String(thermalCollapsed[0].description).length <= 71, 'thermal description truncated to 70+…',
  String(thermalCollapsed[0].description).length);
ok(/…$/.test(thermalCollapsed[0].description), 'thermal truncate uses …');

console.log(fail ? `\nFAILED ${fail} / ${pass + fail}` : `\nAll ${pass} checks passed`);
process.exit(fail ? 1 : 0);
