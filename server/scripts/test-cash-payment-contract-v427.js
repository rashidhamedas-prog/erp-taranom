/**
 * قرارداد پرداخت خروجی — مبلغ صحیح، منبع انحصاری، چک بسته، اقساط.
 * Run: node server/scripts/test-cash-payment-contract-v427.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  parseStrictRial, parseOptionalRial, exclusivePaySource, installmentAmounts, assertTransferPair,
} = require('../lib/cash-payment-contract');

let n = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  n++;
  console.log('ok', msg);
}
function rejects(fn, code) {
  try {
    fn();
    assert.fail('expected throw ' + code);
  } catch (e) {
    ok(e.code === code, code + ' ' + (e.message || ''));
  }
}

ok(parseStrictRial(15000) === 15000, 'integer rial');
ok(parseStrictRial('۱۵۰۰۰') === 15000, 'persian digits');
rejects(() => parseStrictRial(-1), 'E_AMOUNT');
rejects(() => parseStrictRial(1.5), 'E_AMOUNT');
rejects(() => parseStrictRial('12.5'), 'E_AMOUNT');
rejects(() => parseStrictRial('abc'), 'E_AMOUNT');
rejects(() => parseStrictRial('1e5'), 'E_AMOUNT');
rejects(() => parseStrictRial(0), 'E_AMOUNT');
ok(parseOptionalRial('', 'کارمزد') === 0, 'empty fee is zero');
rejects(() => parseOptionalRial('1.2', 'کارمزد'), 'E_AMOUNT');

const cash = exclusivePaySource({ pay_type: 'cash', cash_box_id: 3, bank_id: '' });
ok(cash.payType === 'cash' && cash.cashBoxId === 3 && cash.bankId == null, 'cash source');
rejects(() => exclusivePaySource({ pay_type: 'cash', cash_box_id: 3, bank_id: 9 }), 'E_PAY_SOURCE');
rejects(() => exclusivePaySource({ pay_type: 'bank', bank_id: 2, cash_box_id: 4 }), 'E_PAY_SOURCE');
rejects(() => exclusivePaySource({ pay_type: 'cheque', bank_id: 2 }), 'E_CHEQUE_FORM_CLOSED');
ok(exclusivePaySource({ pay_type: 'bank_transfer', bank_id: '8' }).payType === 'bank', 'bank_transfer canonical');

rejects(() => installmentAmounts({ installments: [1000, 0, 2000] }), 'E_INSTALLMENT');
ok(installmentAmounts({ installments: [1000, 2000] }).join() === '1000,2000', 'two installments');

const pair = assertTransferPair({ from_type: 'cash', from_id: 1, to_type: 'bank', to_id: 2, amount: 5000 });
ok(pair.fromId === 1 && pair.toId === 2, 'transfer pair');
rejects(() => assertTransferPair({ from_type: 'cash', from_id: 1, to_type: 'cash', to_id: 1, amount: 5000 }), 'E_TRANSFER_SAME');
rejects(() => assertTransferPair({ from_type: 'bank', to_type: 'cash', to_id: 1, amount: 5000 }), 'E_TRANSFER_SIDE');
rejects(() => assertTransferPair({ from_type: 'cash', from_id: 1, to_type: 'cash', to_id: 2, amount: 5000, fee_rial: 100 }), 'E_FEE');

rejects(() => exclusivePaySource({ pay_type: 'cash', cash_box_id: 3, bank_id: 'abc' }), 'E_PAY_SOURCE');
rejects(() => exclusivePaySource({ pay_type: 'cash', cash_box_id: '3abc' }), 'E_PAY_SOURCE');
rejects(() => exclusivePaySource({ pay_type: 'چک', bank_id: 2 }), 'E_CHEQUE_FORM_CLOSED');
rejects(() => parseStrictRial([100]), 'E_AMOUNT');
rejects(() => assertTransferPair({ from_type: 'cash', from_id: '3abc', to_type: 'bank', to_id: 2, amount: 5000 }), 'E_TRANSFER_SIDE');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(app.includes('انتقال داخلی به بانک'), 'chooser names internal bank transfer');
ok(app.includes('انتقال داخلی به صندوق'), 'chooser names internal cash transfer');
ok(app.includes("doc_type:'person_payment'"), 'party payment uses stable doc type');
ok(app.includes('payInstallmentBody'), 'installments leave in one request');
ok(!app.includes('عمومی (بدون انتخاب مشخص)'), 'generic transfer bucket removed from the form');
ok(app.includes('تسویهٔ بدهی فاکتور خرید'), 'expense form explains it is not AP settlement');

const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
ok(sw.includes('erp-taranom-v428'), 'service worker v428');

const amend = fs.readFileSync(path.join(__dirname, '../lib/amend-cash-ops.js'), 'utf8');
const supplierFn = amend.slice(amend.indexOf('function amendSupplierPayment'), amend.indexOf('function assertPurchaseRoom') > -1 ? amend.indexOf('function amendIncentivePayment') : amend.length);
ok(supplierFn.includes("cashAccount(db, payType, bankId, cashBoxId, '')"), 'supplier amend resolves cash from the selected box or bank');
ok(supplierFn.includes('E_PAY_SOURCE'), 'supplier amend rejects a different account code');
ok(supplierFn.includes('E_EXPENSE_NOT_AP') === false, 'supplier function is not the expense guard');
ok(amend.includes('مبلغ هزینه‌ای که به فاکتور خرید وصل است'), 'linked expense amount stays until a separate heal');
ok(!app.includes('حساب پرداخت به‌جای بانک یا صندوق'), 'supplier amend form no longer offers a free cash override');

console.log('PASS', n);
