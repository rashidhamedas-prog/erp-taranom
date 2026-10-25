const { swAtLeast } = require('./lib/sw-at-least');
/**
 * Warehouse slip print — static gates (v277)
 * Run: node server/scripts/test-warehouse-slip-print-v277.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  paperDims, normalizeSlipLines, renderWarehouseSlipHtml,
  buildSalesInvoiceSlip, buildPurchaseInvoiceSlip,
  buildWarehouseDocSlip, buildSalesReturnSlip, DOC_TITLES,
} = require('../lib/warehouse-slip-print');
const { secureHtmlDocument } = require('../lib/secure-html-response');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  PASS', msg); }
  else { failed++; console.error('  FAIL', msg); }
}

console.log('=== warehouse-slip-print v277 ===');

const a4 = paperDims('A4');
const a5 = paperDims('A5');
ok(a4.widthMm === 210 && a4.heightMm === 297, 'A4 ISO dims');
ok(a5.widthMm === 148 && a5.heightMm === 210, 'A5 ISO dims');
ok(paperDims('weird').paper === 'A4', 'unknown paper falls back to A4');

const lines = normalizeSlipLines([
  { row_type: 'income', name: 'کرایه', qty: 1, price: 1000 },
  { name: 'مانتو A', code: 'M-1', qty: 2, color_name: 'مشکی', size_name: '38', unit: 'عدد' },
  { name: 'skip-zero', qty: 0, code: 'Z' },
  { product_name: 'شومیز', product_code: 'S-2', qty: 1.5, color: 'کرم', size_name: '40' },
]);
ok(lines.length === 2, 'skips income + zero qty');
ok(lines[0].color === 'مشکی' && lines[0].size === '38', 'keeps color/size for picking');
ok(lines[0].code === 'M-1', 'keeps product code');
ok(!('price' in lines[0]), 'normalized lines have no price field');

const fakeDb = {
  prepare() {
    return {
      get() { return null; },
      all() { return []; },
    };
  },
};

const salesHtml = buildSalesInvoiceSlip(fakeDb, {
  num: 'T-0001', date: '1405/07/09', type: 'normal',
  cust_biz: 'فروشگاه تست', cust_owner: 'علی', note: 'تحویل فوری',
  seller_name: 'فاطمه',
}, [
  { name: 'مانتو', code: 'M1', qty: 3, color_name: 'آبی', size_name: '40', price: 999999 },
  { row_type: 'income', name: 'خدمات', qty: 1, price: 100 },
], { company_name: 'پوشاک ترنم', company_phone: '051', company_address: 'مشهد' }, 'A5');

ok(salesHtml.includes('حواله خروج انبار'), 'sales title');
ok(salesHtml.includes('A5'), 'sales paper badge');
ok(salesHtml.includes('مانتو'), 'sales product name');
ok(salesHtml.includes('آبی'), 'sales color visible');
ok(!salesHtml.includes('999999') && !salesHtml.includes('۹۹۹٬۹۹۹') && !/<th[^>]*>فی</.test(salesHtml) && !salesHtml.includes('مبلغ نهایی'), 'no commercial amounts in sales slip');
ok(salesHtml.includes('/warehouse-slip-print.css'), 'links slip CSS');
ok(salesHtml.includes('/print-page.js'), 'print script');
ok(salesHtml.includes('انباردار'), 'signature block');

const proformaHtml = buildSalesInvoiceSlip(fakeDb, {
  num: 'T-P1', date: '1405/07/09', type: 'proforma', cust_biz: 'X',
}, [{ name: 'کالا', qty: 1, code: 'C1' }], { company_name: 'ترنم' }, 'A4');
ok(proformaHtml.includes('پیش‌فاکتور'), 'proforma watermark');

const purchaseHtml = buildPurchaseInvoiceSlip(fakeDb, {
  num: 'P-1', date: '1405/07/09', supplier_name: 'تأمین تست', recorder: 'حسابدار',
}, [{ name: 'پارچه', code: 'F1', qty: 12, unit: 'متر' }], { company_name: 'ترنم' }, 'A4');
ok(purchaseHtml.includes('رسید ورود انبار'), 'purchase title');
ok(purchaseHtml.includes('تأمین تست'), 'supplier party');

const whHtml = buildWarehouseDocSlip({
  id: 7, num: 'WH-0007', type: 'transfer', date: '1405/07/09',
  from_warehouse_name: 'انبار محصول', to_warehouse_name: 'انبار کیمیا',
  recorder: 'معین', note: 'جابه‌جایی',
  lines: [
    { product_name: 'مانتو', product_code: 'M1', qty: 5, color_name: 'قرمز', size_name: '42', product_unit: 'عدد' },
  ],
}, { company_name: 'ترنم' }, 'A4');
ok(whHtml.includes(DOC_TITLES.wh_transfer), 'transfer title');
ok(whHtml.includes('انبار محصول') && whHtml.includes('انبار کیمیا'), 'from/to warehouses');
ok(whHtml.includes('قرمز') && (whHtml.includes('42') || whHtml.includes('۴۲')), 'variant attrs on WH slip');

const srHtml = buildSalesReturnSlip(fakeDb, {
  id: 3, date: '1405/07/09', cust_biz: 'مشتری', invoice_num: 'T-0001',
  rows: JSON.stringify([{ name: 'برگشتی', code: 'R1', qty: 2, color_name: 'سفید', size_name: '36' }]),
}, { company_name: 'ترنم' }, 'A5');
ok(srHtml.includes('رسید برگشت به انبار'), 'sales return title');

try {
  secureHtmlDocument(salesHtml, { allowPrintScript: true });
  ok(true, 'sales slip passes secure HTML gate');
} catch (e) {
  ok(false, 'secure HTML: ' + (e && e.message));
}

const cssPath = path.join(__dirname, '../public/warehouse-slip-print.css');
ok(fs.existsSync(cssPath), 'CSS file exists');
const css = fs.readFileSync(cssPath, 'utf8');
ok(css.includes('html.wh-slip') && css.includes('@media print'), 'CSS has print rules');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(appJs.includes('function printWarehouseSlip'), 'frontend printWarehouseSlip');
ok(appJs.includes("printWarehouseSlip('invoice'"), 'sales invoice button');
ok(appJs.includes("printWarehouseSlip('purchase'"), 'purchase button');
ok(appJs.includes("printWarehouseSlip('warehouse'"), 'warehouse ops button');
ok(appJs.includes("printWarehouseSlip('sales_return'"), 'sales return button');

const invRoute = fs.readFileSync(path.join(__dirname, '../routes/invoices.js'), 'utf8');
ok(invRoute.includes('/warehouse-slip'), 'invoice route');
const poRoute = fs.readFileSync(path.join(__dirname, '../routes/purchases.js'), 'utf8');
ok(poRoute.includes('/warehouse-slip'), 'purchase route');
const whRoute = fs.readFileSync(path.join(__dirname, '../routes/warehouses.js'), 'utf8');
ok(whRoute.includes('/moves/docs/:id/print'), 'warehouse doc print route');
const accRoute = fs.readFileSync(path.join(__dirname, '../routes/accounting.js'), 'utf8');
ok(accRoute.includes('/sales-returns/:id/warehouse-slip'), 'sales-return slip route');

const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
ok(swAtLeast(sw, 277), 'SW v277');
const index = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
ok(index.includes('app.js?v=277'), 'index cache-bust v277');

const bare = renderWarehouseSlipHtml({
  docKind: 'wh_issue',
  paper: 'A4',
  settings: { company_name: '<script>x</script>' },
  doc: { num: 'WH-1', date: '1405/01/01', party: 'A&B' },
  lines: [{ line_no: 1, code: 'C', name: '<b>x</b>', color: '', size: '', qty: 1, unit: 'عدد', warehouse: '', note: '' }],
});
ok(bare.includes('&lt;script&gt;') && bare.includes('&lt;b&gt;'), 'HTML escaped');
ok(bare.includes('A&amp;B'), 'ampersand escaped in party');

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
