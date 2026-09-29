'use strict';
/**
 * v257: POS+settlement print dedupe; no meta-strip; product code on A5/casual;
 * per-expert phone hide is print-route (tested via expertHtml input).
 */
const fs = require('fs');
const path = require('path');
const {
  renderInvoicePrintHtml,
  normalizePrintReceipts,
} = require('../lib/invoice-print');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

function asciiFa(html) {
  return String(html || '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٬,]/g, '');
}

console.log('\n══ Invoice print fix v257 ══\n');

const printJs = fs.readFileSync(path.join(__dirname, '../lib/invoice-print.js'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const invRoutes = fs.readFileSync(path.join(__dirname, '../routes/invoices.js'), 'utf8');
const dbJs = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');

ok(/erp-taranom-v257/.test(sw), 'SW v257');
ok(!/class="meta-strip"/.test(printJs), 'meta-strip HTML removed from templates');
ok(printJs.includes('linkedSettlementIds'), 'POS/settlement print dedupe present');
ok(invRoutes.includes('enrichRowsProductCodes') && invRoutes.includes('show_phone_on_invoice'),
  'print enrich code + per-user phone gate');
ok(dbJs.includes("show_phone_on_invoice"), 'users.show_phone_on_invoice column');
ok(appJs.includes('u-show-phone-inv') && appJs.includes('نمایش موبایل در فاکتور'),
  'user modal phone-on-invoice toggle');

const linked = normalizePrintReceipts({
  settlements: [{
    id: 10, pay_type: 'pos_card', amount_rial: 95600000, amount: 95600000,
  }],
  posReceipts: [{
    id: 3, settlement_id: 10, amount_rial: 95600000, amount: 95600000,
    terminal_name: 'دفتر بخش ۱۷ شهریور', note: 'دریافت هنگام فاکتور T-0003',
  }],
});
ok(linked.length === 1, 'linked POS+settlement → one print receipt', linked.length);
ok(linked[0].kind === 'pos' && linked[0].dest.includes('۱۷'), 'prefer POS terminal label');

const mixed = normalizePrintReceipts({
  settlements: [
    { id: 1, pay_type: 'cash', amount_rial: 10000, cash_box_name: 'صندوق' },
    { id: 2, pay_type: 'pos_card', amount_rial: 50000 },
  ],
  posReceipts: [
    { id: 9, settlement_id: 2, amount_rial: 50000, terminal_name: 'ترمینال ۱' },
  ],
});
ok(mixed.length === 2, 'cash + linked POS → two lines', mixed.length);
ok(mixed.reduce((a, r) => a + r.amount, 0) === 60000, 'mixed sum = cash+POS');

const html = renderInvoicePrintHtml({
  inv: {
    id: 3, num: 'T-0003', type: 'normal', date: '1405/07/06',
    final: 95600000, final_rial: 95600000, pay_type: 'pos_card',
    cust_biz: 'تست', seller_name: 'فاطمه شرفی', seller_phone: '09044600579',
  },
  rows: [{ name: 'نیم زیپ با شلوار', code: 'NZ-01', qty: 1, price: 95600000, disc: 0, disc_amount: 0 }],
  settings: {
    company_name: 'پوشاک ترنم',
    invoice_paper_size: 'A5',
    invoice_template_casual: 'casual-simple',
    invoice_customize: JSON.stringify({ show_seller: true, show_payment: true }),
  },
  paper: 'A5',
  settlements: [{
    id: 10, pay_type: 'pos_card', amount_rial: 95600000, amount: 95600000,
  }],
  posReceipts: [{
    id: 3, settlement_id: 10, amount_rial: 95600000,
    terminal_name: 'دفتر بخش ۱۷ شهریور',
    note: 'دریافت هنگام فاکتور T-0003',
  }],
});
const ascii = asciiFa(html);
ok(!/class="meta-strip"/.test(html), 'rendered HTML has no meta-strip');
ok((html.match(/دریافت ۱/g) || []).length === 1, 'only one receipt line labeled');
ok(!/دریافت ۲/.test(html), 'no second receipt line');
ok(/جمع دریافت[\s\S]{0,80}95600000/.test(ascii), 'جمع دریافت = invoice amount once');
ok(/مبلغ قابل پرداخت[\s\S]{0,120}0/.test(ascii), 'due payable is 0 after single receipt');
ok(!/191200000/.test(ascii), 'no double-count total 191.2M');
ok(/<th>کد<\/th>/.test(html) && /NZ-01/.test(html), 'product code column + value on A5/casual');
ok(/فاطمه شرفی/.test(html) && /09044600579/.test(html), 'expert name+phone when provided');

const htmlNoPhone = renderInvoicePrintHtml({
  inv: {
    id: 4, num: 'T-0004', type: 'normal', date: '1405/07/06',
    final: 1000, final_rial: 1000, pay_type: 'credit',
    cust_biz: 'تست', seller_name: 'فاطمه شرفی', seller_phone: '',
  },
  rows: [{ name: 'کالا', code: 'C1', qty: 1, price: 1000, disc: 0, disc_amount: 0 }],
  settings: {
    company_name: 'ترنم', invoice_paper_size: 'A5',
    invoice_customize: JSON.stringify({ show_seller: true }),
  },
  paper: 'A5',
});
ok(/فاطمه شرفی/.test(htmlNoPhone) && !/09044600579/.test(htmlNoPhone),
  'expert phone omitted when seller_phone empty (per-user gate)');

console.log(`\n══ Result: ${pass} pass, ${fail} fail ══\n`);
process.exit(fail ? 1 : 0);
