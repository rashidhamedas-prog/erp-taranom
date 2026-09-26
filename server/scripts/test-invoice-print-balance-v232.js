'use strict';
/**
 * v232: print due after receipts; top meta num+date; customer balance matches statement;
 * style API warehouse stock.
 */
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

console.log('\n══ Invoice print + balance v232 ══\n');

const printJs = fs.readFileSync(path.join(__dirname, '../lib/invoice-print.js'), 'utf8');
const booksJs = fs.readFileSync(path.join(__dirname, '../lib/customer-books.js'), 'utf8');
const pvRoute = fs.readFileSync(path.join(__dirname, '../routes/product-variants.js'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');

ok(/erp-taranom-v232/.test(sw), 'SW v232');
ok(printJs.includes('duePayable') && printJs.includes('paidTotal'), 'print computes due after receipts');
ok(printJs.includes('print-top-meta'), 'print top meta class');
ok(!printJs.includes('صورتحساب فروش کالا و خدمات</div>\n        <div class="kind">'),
  'formal-official top banner no longer has title+kind');
ok(booksJs.includes("LIKE ?") && booksJs.includes('attachMissingInvoiceRows'),
  'balance map docs mention missing invoices');
ok(booksJs.includes('firmSaleTypeSql') && booksJs.includes('NOT EXISTS'),
  'balance map adds missing firm invoices');
ok(booksJs.includes("account_code LIKE"), 'GL balance uses LIKE prefix like statement');
ok(pvRoute.includes('warehouse_id') && pvRoute.includes('variant_warehouse_stock'),
  'style API accepts warehouse_id');
ok(/editInvCartPack[\s\S]{0,400}warehouse_id/.test(appJs), 'editInvCartPack passes warehouse_id');
ok(/addToCart[\s\S]{0,400}warehouse_id/.test(appJs), 'addToCart passes warehouse_id');
ok(appJs.includes('رنگ/سایز در فاکتور'), 'Help mentions warehouse stock');
ok(appJs.includes('مانده لیست مشتریان'), 'Help mentions list balance');

const { renderInvoicePrintHtml } = require('../lib/invoice-print');
const html = renderInvoicePrintHtml({
  inv: {
    id: 2, num: 'T-0002', type: 'normal', date: '1405/07/01',
    final: 100000, final_rial: 100000, pay_type: 'mixed',
    cust_biz: 'تست',
  },
  rows: [{ name: 'کالا', qty: 1, price: 100000, disc: 0, disc_amount: 0 }],
  settings: { company_name: 'ترنم', invoice_paper_size: 'A4' },
  settlements: [{
    pay_type: 'bank_transfer', amount_rial: 30000, amount: 30000, bank_name: 'ملی',
  }],
  posReceipts: [],
});
ok(html.includes('print-top-meta'), 'rendered HTML has top meta');
ok(/print-top-num[\s\S]*T-0002/.test(html) && /print-top-date[\s\S]*1405\/07\/01/.test(html),
  'top meta has number and date');
const asciiHtml = html
  .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
  .replace(/[٬,]/g, '');
ok(/مبلغ قابل پرداخت[\s\S]{0,120}70000/.test(asciiHtml), 'payable after receipt is due amount');

const { assertNoInlineExecutableMarkup } = require('../lib/secure-html-response');
try {
  assertNoInlineExecutableMarkup(html, { allowPrintScript: true });
  ok(true, 'print HTML passes secure markup check');
} catch (e) {
  ok(false, 'print HTML passes secure markup check', e && e.message);
}

console.log(`\n══ Result: ${pass} pass, ${fail} fail ══\n`);
process.exit(fail ? 1 : 0);