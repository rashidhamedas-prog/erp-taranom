'use strict';
/**
 * Follow-up v227: void clears cheque_records; final amend role gate; sales_manager discount.
 * Run: node server/scripts/test-invoice-void-cheque-v227.js
 */
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

console.log('\n══ Invoice void/cheque follow-up v227 ══\n');

const voidSett = fs.readFileSync(path.join(__dirname, '../lib/void-settlement.js'), 'utf8');
const voidInv = fs.readFileSync(path.join(__dirname, '../lib/void-invoice.js'), 'utf8');
const amend = fs.readFileSync(path.join(__dirname, '../lib/amend-invoice.js'), 'utf8');
const invRoutes = fs.readFileSync(path.join(__dirname, '../routes/invoices.js'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const printCss = fs.readFileSync(path.join(__dirname, '../public/invoice-print.css'), 'utf8');

ok(voidSett.includes('reverseChequeRecordsForSettlement'), 'void-settlement exports cheque reverse helper');
ok(voidSett.includes("pay_type || '') === 'cheque'") || voidSett.includes("pay_type || '') === \"cheque\"")
  || voidSett.includes("=== 'cheque'"), 'cheque reverse uses notes receivable path');
ok(voidInv.includes('reverseChequeRecordsForInvoice'), 'void-invoice clears cheque_records');
ok(voidInv.includes('voidReceipt'), 'void-invoice voids POS receipts');
ok(amend.includes('E_AMEND_SPLIT_COUNT') && !amend.includes('posLater.length'), 'amend blocks any later settlement (no POS orphan path)');
ok(amend.includes('UPDATE cheque_records SET') && amend.includes('INSERT INTO cheque_records'), 'same-count amend syncs cheque_records');
ok(!amend.includes("payType === 'cheque' ? '1109'"), 'amend no longer hardcodes 1109');
ok(invRoutes.includes('E_FINAL_AMEND_ROLE'), 'final amend role gate');
ok(/canDiscount = req\.user\.role === 'admin' \|\| req\.user\.role === 'accounting' \|\| req\.user\.role === 'sales_manager'/.test(invRoutes),
  'sales_manager canDiscount on POST/PUT');
ok(/erp-taranom-v227/.test(sw), 'SW v227');
ok(printCss.includes('::before') && printCss.includes('::after'), 'print CSS covers pseudo-elements');

const { reverseChequeRecordsForInvoice, reverseChequeRecordsForSettlement } = require('../lib/void-settlement');
ok(typeof reverseChequeRecordsForInvoice === 'function', 'require reverseChequeRecordsForInvoice');
ok(typeof reverseChequeRecordsForSettlement === 'function', 'require reverseChequeRecordsForSettlement');

console.log(`\nResult: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
