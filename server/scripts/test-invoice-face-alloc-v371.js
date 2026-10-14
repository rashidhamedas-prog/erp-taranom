/**
 * v371 — invoice allocation face = after commercial discount (AR/AP net).
 */
'use strict';

const assert = require('assert');
const {
  invoiceFaceRial, allocPickerFields, sqlInvoiceFaceRial, sqlPurchaseFaceRial,
} = require('../lib/invoice-face-amount');

let passed = 0;
function ok(cond, msg, detail) {
  if (!cond) {
    console.error('FAIL', msg, detail != null ? detail : '');
    process.exitCode = 1;
    return;
  }
  passed += 1;
  console.log('OK', msg);
}

// T-0008 class: subtotal 25.4M, header disc 400k → face 25M
const inv = {
  subtotal: 25400000,
  disc_amt: 400000,
  final: 25000000,
  final_rial: 25000000,
};
ok(invoiceFaceRial(inv) === 25000000, 'face prefers final_rial after discount');
ok(invoiceFaceRial({ final: 25000000 }) === 25000000, 'face falls back to final');
ok(invoiceFaceRial({ final_rial: 0, final: 12 }) === 12, 'zero final_rial falls back');

const shaped = allocPickerFields(inv, { paid: 5000000 });
ok(shaped.amount_rial === 25000000, 'picker amount_rial is net face');
ok(shaped.final === 25000000, 'legacy .final field also net face');
ok(shaped.outstanding === 20000000, 'outstanding = face − paid', shaped);
ok(shaped.disc_amt === 400000, 'disc_amt surfaced for UI');

ok(sqlInvoiceFaceRial('i').includes('final_rial'), 'sales SQL uses final_rial');
ok(sqlPurchaseFaceRial('p') === 'COALESCE(ROUND(p.final), 0)', 'purchase SQL without final_rial col');

const fs = require('fs');
const path = require('path');
const acc = fs.readFileSync(path.join(__dirname, '../routes/accounting.js'), 'utf8');
ok(acc.includes("/customers/:custId/firm-invoices"), 'firm-invoices route');
ok(acc.includes("/suppliers/:supplierId/purchase-invoices"), 'purchase-invoices route');
ok(acc.includes('invoice-face-amount'), 'accounting uses face helper');
ok(acc.includes('sqlInvoiceFaceRial'), 'open-invoices uses face SQL');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(app.includes('formatInvoiceAllocOption'), 'UI formatter');
ok(app.includes('/accounting/customers/') && app.includes('/firm-invoices'), 'SR picker uses firm-invoices');
ok(app.includes('/purchase-invoices'), 'PR picker uses purchase-invoices API');
ok(app.includes('خالص'), 'UI labels net-after-discount');

console.log(`\n${passed} assertions ok`);
