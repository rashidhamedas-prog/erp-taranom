const { swAtLeast } = require('./lib/sw-at-least');
/**
 * account-receipts / account-payments mirror into customer/person books + void reverse.
 * Run: node server/scripts/test-account-voucher-books-v296.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-voucher-v296-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-account-voucher-v296-secret-32chars!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB, createLedgerEntry, createPersonLedgerEntry } = require('../db');
initDB();
const db = getDB();

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra != null ? extra : ''); }
}

const { allocTafsili } = require('../lib/coa-map');
const { resolveCustomerIdFromArJe } = require('../lib/customer-books');

// --- customer leaf ---
const custCode = allocTafsili(db, 'customer', 'مشتری آینه v296');
const custId = db.prepare(`
  INSERT INTO customers (user_id, biz, phone, status, coa_code)
  VALUES (1, 'مشتری آینه v296', '09120002961', 'active', ?)
`).run(custCode).lastInsertRowid;

const recvEntry = db.prepare(`
  INSERT INTO journal_entries (entry_date, description, ref_type, ref_id, created_by, status)
  VALUES ('1405/07/11', 'دریافت تست', 'account_receipt', NULL, 1, 'posted')
`).run().lastInsertRowid;
db.prepare('UPDATE journal_entries SET ref_id=? WHERE id=?').run(recvEntry, recvEntry);
db.prepare(`
  INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial)
  VALUES (?, '1101', 'صندوق', 1, 0, 5000000, 0)
`).run(recvEntry);
db.prepare(`
  INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial)
  VALUES (?, ?, 'مشتری', 0, 1, 0, 5000000)
`).run(recvEntry, custCode);

// Simulate mirrorAccountVoucherToPartyBooks for customer receipt
createLedgerEntry(db, {
  customer_id: custId,
  date: '1405/07/11',
  entry_type: 'settlement',
  ref_type: 'account_receipt',
  ref_id: recvEntry,
  description: 'دریافت از حساب مشتری',
  debit: 0,
  credit: 5000000,
  user_id: 1,
});

const booksRecv = db.prepare(
  "SELECT * FROM customer_ledger WHERE ref_type='account_receipt' AND ref_id=?"
).get(recvEntry);
ok(!!booksRecv && booksRecv.credit === 5000000, 'customer receipt mirrored to books');

const arCust = resolveCustomerIdFromArJe(db, 'account_receipt', recvEntry);
ok(arCust === custId, 'resolveCustomerIdFromArJe account_receipt', { arCust, custId });

// Void reverse for customer
createLedgerEntry(db, {
  customer_id: custId,
  date: '1405/07/11',
  entry_type: 'reversal',
  ref_type: 'account_receipt_reversal',
  ref_id: recvEntry,
  description: 'ابطال دریافت',
  debit: booksRecv.credit,
  credit: booksRecv.debit,
  user_id: 1,
});
const balCust = db.prepare(`
  SELECT COALESCE(SUM(debit),0)-COALESCE(SUM(credit),0) AS bal
  FROM customer_ledger WHERE customer_id=? AND ref_id=?
`).get(custId, recvEntry);
ok(Number(balCust.bal) === 0, 'customer receipt void nets to zero', balCust);

// --- person leaf ---
const personCode = allocTafsili(db, 'person', 'شخص آینه v296');
const personId = db.prepare(`
  INSERT INTO persons (name, phone, active, coa_code)
  VALUES ('شخص آینه v296', '09120002962', 1, ?)
`).run(personCode).lastInsertRowid;

const payEntry = db.prepare(`
  INSERT INTO journal_entries (entry_date, description, ref_type, ref_id, created_by, status)
  VALUES ('1405/07/11', 'پرداخت تست', 'account_payment', NULL, 1, 'posted')
`).run().lastInsertRowid;
db.prepare('UPDATE journal_entries SET ref_id=? WHERE id=?').run(payEntry, payEntry);
db.prepare(`
  INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial)
  VALUES (?, ?, 'شخص', 1, 0, 3000000, 0)
`).run(payEntry, personCode);
db.prepare(`
  INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial)
  VALUES (?, '1101', 'صندوق', 0, 1, 0, 3000000)
`).run(payEntry);

createPersonLedgerEntry(db, {
  person_id: personId,
  date: '1405/07/11',
  entry_type: 'account_payment',
  ref_type: 'account_payment',
  ref_id: payEntry,
  description: 'پرداخت به شخص',
  debit: 3000000,
  credit: 0,
  user_id: 1,
});
const booksPay = db.prepare(
  "SELECT * FROM person_ledger WHERE ref_type='account_payment' AND ref_id=?"
).get(payEntry);
ok(!!booksPay && booksPay.debit === 3000000, 'person payment mirrored to books');

createPersonLedgerEntry(db, {
  person_id: personId,
  date: '1405/07/11',
  entry_type: 'reversal',
  ref_type: 'account_payment_reversal',
  ref_id: payEntry,
  description: 'ابطال پرداخت',
  debit: booksPay.credit,
  credit: booksPay.debit,
  user_id: 1,
});
const balPerson = db.prepare(`
  SELECT COALESCE(SUM(debit),0)-COALESCE(SUM(credit),0) AS bal
  FROM person_ledger WHERE person_id=? AND ref_id=?
`).get(personId, payEntry);
ok(Number(balPerson.bal) === 0, 'person payment void nets to zero', balPerson);

// Static: mirror wired into routes + SW bump
const accountingSrc = fs.readFileSync(path.join(__dirname, '../routes/accounting.js'), 'utf8');
ok(accountingSrc.includes('mirrorAccountVoucherToPartyBooks'), 'route has mirror helper');
ok(accountingSrc.includes("direction: 'receipt'"), 'receipts call mirror');
ok(accountingSrc.includes("direction: 'payment'"), 'payments call mirror');
ok(accountingSrc.includes('account_receipt_reversal') || accountingSrc.includes("entry.ref_type + '_reversal'"),
  'void reverses account voucher books');

const swSrc = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
ok(swAtLeast(swSrc, 296), 'SW v296');
const idx = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
ok(idx.includes('app.js?v=296'), 'index cache-bust v296');

const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(appSrc.includes('دریافت/پرداخت از حساب') && appSrc.includes('دفتر طرف‌حساب'), 'help mentions account voucher books');

try { closeDB(); } catch (_) {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
