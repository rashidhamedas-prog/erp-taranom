'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { validateReceivedCheque } = require('../lib/person-receipt');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/app.css'), 'utf8');
let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('ok', msg);
  else { failed++; console.error('FAIL', msg); }
}

ok(app.includes('async function ensureCustomerCatalog'), 'settlement loads customer catalog');
ok(app.includes('await ensureCustomerCatalog()'), 'receipt-from-customer awaits catalog');
ok(app.includes('textMatchesQuery('), 'customer search folds yeh/kaf');
ok(/function showCustDrop[\s\S]{0,900}textMatchesQuery/.test(app), 'showCustDrop uses folded match');
ok(css.includes('.cust-si-drop{') && css.includes('pointer-events:none') && css.includes('.cust-si-item{pointer-events:auto'), 'empty search panel does not block the invoice select');

ok(app.includes("flow:'in'") || app.includes('flow:"in"') || app.includes("flow:'in'"), 'inbound flow option exists');
ok(app.includes('دریافت نقد در صندوق') && app.includes('واریز به حساب بانکی') && app.includes('چک دریافتنی'), 'receipt method titles');
ok(app.includes('پرداخت نقد از صندوق') && app.includes('برداشت از حساب بانکی'), 'payment method titles');
ok(!/payTypeOptionsHtml\(\{pos:true\}\)/.test(app), 'person receipt does not use unlabeled shared options');
ok(app.includes('prr-cheque-block') && app.includes('شناسه صیاد ۱۶ رقمی'), 'person receipt collects sayad identity');
ok(app.includes('/accounting/person-receipts'), 'non-customer receipt posts on its own route');
ok(app.includes("payTypeOptionsHtml({cheque:false,flow:'out'})") || app.includes('flow:\'out\''), 'person payment uses outbound labels');
ok(app.includes('مبدأ وجه'), 'installment summary names the cash source on payments');

const good = validateReceivedCheque({
  bank: 'ملی', branch: 'مرکزی', account: '0101', number: '123',
  sayadi: '۱۲۳۴۵۶۷۸۹۰۱۲۳۴۵۶', due: '1405/08/01', owner: 'حامد', amount: 1000,
}, 0);
ok(good.sayadi === '1234567890123456' && good.amount === 1000, 'persian sayad digits normalize');
let threw = false;
try { validateReceivedCheque({ bank: 'ملی', sayadi: '12', amount: 10, due: '1405/08/01' }, 0); }
catch (e) { threw = e.code === 'E_CHEQUE_FIELDS'; }
ok(threw, 'incomplete cheque is rejected');

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('cash form terms v432 ok');
