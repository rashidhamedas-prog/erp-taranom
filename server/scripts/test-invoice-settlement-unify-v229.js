'use strict';
/**
 * Settlement unify v229: full cash/bank → splits; Persian sayadi; print receipts; repair.
 * Run: node server/scripts/test-invoice-settlement-unify-v229.js
 */
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

console.log('\n══ Invoice settlement unify v229 ══\n');

const {
  resolveInvoicePayments, digitsOnly, normalizeSheba, loadInvoiceReceipts,
} = require('../lib/invoice-payments');
const { repairMissingInvoiceSettlements } = require('../lib/repair-invoice-settlements');
const printJs = fs.readFileSync(path.join(__dirname, '../lib/invoice-print.js'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const invRoutes = fs.readFileSync(path.join(__dirname, '../routes/invoices.js'), 'utf8');

ok(/erp-taranom-v22[9]|erp-taranom-v23\d/.test(sw), 'SW v229+');
ok(printJs.includes('receiptsHtml') && printJs.includes('normalizePrintReceipts'), 'print receipts helpers');
ok(invRoutes.includes('loadInvoiceReceipts'), 'print route loads receipts');
ok(appJs.includes('toEnDigits(el(\'inv-cheque-sayadi\')') || appJs.includes("toEnDigits(el('inv-cheque-sayadi')"), 'client sayadi toEnDigits');
ok(appJs.includes('sayadi') && /wantsEnDigits[\s\S]*sayadi/.test(appJs), 'wantsEnDigits covers sayadi');

const bank = resolveInvoicePayments({
  pay_type: 'bank_transfer', pay_amount: 500000, bank_id: 3,
}, 500000);
ok(bank.splits.length === 1 && bank.skipInvoiceCash === true && bank.splits[0].bank_id === 3, 'واریز کامل → settlement');

ok(digitsOnly('۱۲۳۴۵۶۷۸۹۰۱۲۳۴۵۶') === '1234567890123456', 'digitsOnly Persian→Latin');
ok(normalizeSheba('123456789012345678901234') === 'IR123456789012345678901234', 'sheba auto IR');

try {
  resolveInvoicePayments({
    pay_type: 'cheque',
    pay_amount: 1000,
    cheque_bank: 'ملی',
    cheque_branch: '۱',
    cheque_account: '1',
    cheque_number: '2',
    cheque_sayadi: '۱۲۳۴۵۶۷۸۹۰۱۲۳۴۵۶',
    cheque_due_date: '1405/08/01',
    cheque_owner: 'مالک',
  }, 1000);
  ok(true, 'cheque with Persian sayadi resolves');
} catch (e) {
  ok(false, 'cheque with Persian sayadi resolves', e.message);
}

const credit = resolveInvoicePayments({ pay_type: 'credit' }, 1000);
ok(credit.splits.length === 0 && credit.skipInvoiceCash === false, 'نسیه بدون settlement');

ok(typeof repairMissingInvoiceSettlements === 'function', 'repair export');
ok(typeof loadInvoiceReceipts === 'function', 'loadInvoiceReceipts export');

const purchasePay = fs.readFileSync(path.join(__dirname, '../lib/purchase-payments.js'), 'utf8');
ok(purchasePay.includes('applyPurchasePaySplits') && purchasePay.includes('coa_cheques_payable'), 'purchase-payments module');

console.log(`\n══ Result: ${pass} pass, ${fail} fail ══\n`);
process.exit(fail ? 1 : 0);
