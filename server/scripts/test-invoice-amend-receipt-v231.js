'use strict';
/**
 * v231: amend append settlements; Persian/comma money; print receipts without inline style.
 * Run: .tools/node20/.../node.exe server/scripts/test-invoice-amend-receipt-v231.js
 */
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

console.log('\n══ Invoice amend receipt + print v231 ══\n');

const { moneyRial } = require('../lib/cash-on-document');
const {
  resolveInvoicePayments, recomputeInvoiceSettledBalances,
} = require('../lib/invoice-payments');
const amendSrc = fs.readFileSync(path.join(__dirname, '../lib/amend-invoice.js'), 'utf8');
const printJs = fs.readFileSync(path.join(__dirname, '../lib/invoice-print.js'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/app.css'), 'utf8');

ok(/erp-taranom-v231/.test(sw), 'SW v231');
ok(typeof recomputeInvoiceSettledBalances === 'function', 'recomputeInvoiceSettledBalances export');
ok(amendSrc.includes('splits.length > invoiceTime.length'), 'amend append path when more splits');
ok(amendSrc.includes('patchOneInvoiceTimeSettlement'), 'amend patches prefix in place');
ok(amendSrc.includes('startIndex: invoiceTime.length'), 'append uses startIndex for POS keys');
ok(amendSrc.includes('دریافت کارتخوان'), 'POS in-transit counted as invoice-time');

ok(moneyRial('۷٬۸۰۰٬۰۰۰') === 7800000, 'moneyRial Persian + separators');
ok(moneyRial('1,500,000') === 1500000, 'moneyRial comma Latin');
ok(moneyRial(7800000) === 7800000, 'moneyRial number');

const multi = resolveInvoicePayments({
  pay_splits: [
    { pay_type: 'bank_transfer', amount: '۷۸۰۰۰۰۰', bank_id: 3 },
    {
      pay_type: 'cheque', amount: '50000000',
      cheque_bank: 'ملی', cheque_branch: '۱', cheque_account: '1',
      cheque_number: '99', cheque_sayadi: '۱۲۳۴۵۶۷۸۹۰۱۲۳۴۵۶',
      cheque_due_date: '1405/08/01', cheque_owner: 'صدوقی',
    },
  ],
}, 152380000);
ok(multi.splits.length === 2 && multi.splits[0].amount === 7800000, 'multi split Persian amount + cheque');
ok(multi.splits[1].sayadi === '1234567890123456', 'cheque sayadi normalized');

let zeroAmtErr = false;
try {
  resolveInvoicePayments({
    pay_splits: [
      { pay_type: 'bank_transfer', amount: 1000, bank_id: 1 },
      {
        pay_type: 'cheque', amount: 0, cheque_bank: 'x', cheque_branch: 'y', cheque_account: '1',
        cheque_number: '2', cheque_sayadi: '1234567890123456', cheque_due_date: '1405/01/01', cheque_owner: 'a',
      },
    ],
  }, 10000);
} catch (e) {
  zeroAmtErr = e && e.code === 'E_PAY_SPLIT_AMOUNT';
}
ok(zeroAmtErr, 'zero-amount split rejected (not silently dropped)');

ok(printJs.includes('.receipts-box{margin-top:8px}'), 'print receipts CSS class');
ok(printJs.includes('receipts-head'), 'print receipts-head class');
ok(!/receipts-box"\s+style=/.test(printJs), 'print receipts HTML has no inline style');

ok(appJs.includes('function renderInvReceiptLedger'), 'live receipt ledger UI');
ok(appJs.includes('inv-receipt-live'), 'inv-receipt-live DOM id');
ok(/parseInvMoney[\s\S]{0,120}toEnDigits/.test(appJs), 'parseInvMoney uses toEnDigits');
ok(appJs.includes('On edit, always expose multi-stage UI'), 'hydrate enables multi on edit');
ok(css.includes('.inv-receipt-live'), 'CSS for live receipt ledger');
ok(appJs.includes('دفتر دریافت زنده'), 'Help mentions live receipt ledger');

const { renderInvoicePrintHtml } = require('../lib/invoice-print');
const html = renderInvoicePrintHtml({
  inv: {
    id: 2, num: 'T-0002', type: 'normal', date: '1405/01/01',
    final: 1000, final_rial: 1000, pay_type: 'mixed',
    cust_name: 'تست',
  },
  rows: [{ name: 'کالا', qty: 1, price: 1000, disc: 0, disc_amount: 0 }],
  settings: { company_name: 'ترنم', invoice_paper_size: 'A4' },
  settlements: [{
    pay_type: 'cheque', amount_rial: 500, amount: 500,
    cheque_bank: 'ملی', cheque_sayadi: '1234567890123456', cheque_number: '1', cheque_due: '1405/08/01',
  }],
  posReceipts: [],
});
ok(html.includes('دریافت') && html.includes('receipts-box'), 'print HTML includes receipts block');
ok(!/\sstyle\s*=/i.test(html), 'print HTML has no inline style attributes');

try {
  const { assertNoInlineExecutableMarkup, secureHtmlDocument } = require('../lib/secure-html-response');
  assertNoInlineExecutableMarkup(html, { allowPrintScript: true });
  const wrapped = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
  const doc = secureHtmlDocument(wrapped, { allowPrintScript: true });
  ok(!!doc && !!doc.html && doc.html.length > 100, 'secureHtmlDocument accepts receipt print HTML');
} catch (e) {
  ok(false, 'secureHtmlDocument accepts receipt print HTML', e && e.message);
}

console.log(`\n══ Result: ${pass} pass, ${fail} fail ══\n`);
process.exit(fail ? 1 : 0);
