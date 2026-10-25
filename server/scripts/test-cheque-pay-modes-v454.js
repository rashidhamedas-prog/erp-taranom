const { swAtLeast } = require('./lib/sw-at-least');
/**
 * v454/v457 — outbound pay forms: cheque_book + cheque_recv in روش پرداخت;
 * no standalone «پرداخت چک» in paymentOpChooser.
 * Run: node server/scripts/test-cheque-pay-modes-v454.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, l, e) {
  if (c) { pass++; console.log('  OK', l); }
  else { fail++; console.log('  FAIL', l, e == null ? '' : e); }
}

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const routes = fs.readFileSync(path.join(__dirname, '../routes/cheque-records.js'), 'utf8');
const contract = fs.readFileSync(path.join(__dirname, '../lib/cash-payment-contract.js'), 'utf8');

console.log('══ v454/v457 cheque pay modes in روش پرداخت ══');

const chooser = app.slice(app.indexOf('function paymentOpChooser'), app.indexOf('function paymentOpChooser') + 900);
ok(!chooser.includes('پرداخت چک'), 'chooser has no standalone پرداخت چک');
ok(app.includes('cheque_book') && app.includes('پرداخت از دسته‌چک'), 'cheque_book option');
ok(app.includes('cheque_recv') && app.includes('چک‌های دریافتی'), 'cheque_recv option');
ok(app.includes('function saveOutboundChequePayment'), 'shared save helper');
ok(/pp-paytype[\s\S]{0,180}cheque:true/.test(app), 'person form enables cheque modes');
ok(/apay-paytype[\s\S]{0,180}cheque:true/.test(app), 'account form enables cheque modes');
ok(/ex-paytype[\s\S]{0,180}cheque:true/.test(app), 'expense form enables cheque modes');
ok(/sp-paytype[\s\S]{0,180}cheque:true/.test(app), 'supplier form enables cheque modes');
ok(app.includes('payOutboundChequeFieldsHtml'), 'live cheque field blocks');
ok(app.includes('loadRecvChequesForPay'), 'loads receivable cheques live');
ok(contract.includes("'E_CHEQUE_FORM_CLOSED'"), 'cash APIs still refuse legacy cheque pay_type');
ok(routes.includes('account_code') && routes.includes('E_CHEQUE_ENDORSE_ACCOUNT'),
  'endorse accepts chart account_code');
ok(swAtLeast(sw, 457), 'SW v457');

console.log(fail ? `FAIL ${pass} ok ${fail} bad` : `PASS ${pass}`);
process.exit(fail ? 1 : 0);
