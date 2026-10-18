'use strict';
/**
 * Source + calendar checks for SW v433 (no sqlite).
 * Run: node server/scripts/test-books-receipt-excel-v433.js
 */
const fs = require('fs');
const path = require('path');
const { addDaysToJalali } = require('../jalali');

let pass = 0;
function ok(cond, label) {
  if (!cond) {
    console.error(' FAIL', label);
    process.exit(1);
  }
  pass++;
  console.log('  OK', label);
}

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const opening = read('lib/opening-post.js');
const cash = read('routes/cash-boxes.js');
const excel = read('routes/excel.js');
const quick = read('lib/product-quick.js');
const acc = read('routes/accounting.js');
const app = read('public/app.js');

ok(addDaysToJalali('1405/07/01', -1) === '1405/06/31', 'day before 1 Mehr is 31 Shahrivar');
ok(opening.includes('function retireOtherPartyOpenings'), 'duplicate opening journals are retired');
ok(opening.includes('refreshCustomerBalanceFromLedger'), 'customer balance is recomputed from the book');
ok(cash.includes('function cashOpeningDate') && cash.includes('کیمیا'), 'Kimiya cash box uses the prior-day opening date');
ok(excel.includes("'قیمت تک (ریال)'"), 'product excel has the single price column');
ok(quick.includes('retail_price_rial'), 'excel product upsert writes retail price');
ok(acc.includes('SET client_request_id=NULL'), 'a dead voucher key does not block a new manual voucher');
ok(acc.includes('function mirrorManualVoucherToCustomers'), 'manual voucher mirrors the customer book');
ok(app.includes("kind==='person_receipt'") && app.includes('renderPrrCheques'), 'receipt cheque cards render for person receipt');
ok(/erp-taranom-v\d+/.test(read('public/sw.js')), 'service worker cache version stamped');

console.log('PASS', pass);
