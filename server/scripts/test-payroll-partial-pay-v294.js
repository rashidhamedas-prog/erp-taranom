'use strict';
/**
 * Payroll multi-leg / partial payment — accounting + R13.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payroll-partial-v294-'));
const testDb = path.join(TMP, 'test.db');
process.env.DB_PATH = testDb;
process.env.SYNC_ROLE = 'device';
process.env.JWT_SECRET = 'test-payroll-partial-v294';

const { initDB, getDB, resolveCashAccount, createPersonLedgerEntry } = require('../db');
const { postToLedger } = require('../lib/ledger');
const { acct } = require('../lib/coa-map');
const {
  postPayrollPayments,
  voidOnePayrollPayment,
  voidAllPayrollPayments,
  remainingRial,
  sumPaidRial,
  enrichPayrollRow,
} = require('../lib/payroll/payments');
const { SYNCABLE_TABLES } = require('../sync/tables');

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log('  OK', name); }
  else { failed += 1; console.error('  FAIL', name, detail || ''); }
}

initDB();
const db = getDB();

ok('payroll_payments in SYNCABLE_TABLES', SYNCABLE_TABLES.some((t) => t.name === 'payroll_payments'));
ok('payroll_payments table exists', !!db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name='payroll_payments'"
).get());
ok('paid_rial column', !!db.prepare('PRAGMA table_info(payroll_records)').all().find((c) => c.name === 'paid_rial'));

const personId = db.prepare(
  "INSERT INTO persons (name, category, active) VALUES ('کارمند تست قسط','کارمند',1)"
).run().lastInsertRowid;

const netRial = 10000000; // 10M rial = 1M toman ledger
const accrualJe = db.transaction(() => postToLedger(db, {
  date: '1405/07/01',
  description: 'تعهد حقوق تست',
  sourceType: 'payroll',
  sourceId: 1,
  createdBy: 1,
  lines: [
    { ...acct(db, 'coa_payroll_expense'), debit: netRial / 10, credit: 0 },
    { ...acct(db, 'coa_payroll_payable'), debit: 0, credit: netRial / 10 },
  ],
}))();

const recId = db.prepare(`
  INSERT INTO payroll_records (
    person_id, period_label, date, gross_pay, net_pay, net_pay_rial,
    paid, status, journal_entry_id, created_by
  ) VALUES (?,?,?,?,?,?,0,'posted',?,1)
`).run(personId, '1405/07', '1405/07/01', netRial / 10, netRial / 10, netRial, accrualJe).lastInsertRowid;

const person = db.prepare('SELECT * FROM persons WHERE id=?').get(personId);
const row0 = db.prepare('SELECT * FROM payroll_records WHERE id=?').get(recId);

const pay1 = db.transaction(() => postPayrollPayments(db, {
  row: row0,
  person,
  body: { amount_rial: 4000000, pay_type: 'cash', date: '1405/07/05' },
  userId: 1,
  resolveCashAccount,
  createPersonLedgerEntry,
}))();

ok('partial pay remaining', pay1.remaining_rial === 6000000, pay1);
ok('partial status', pay1.status === 'partial', pay1.status);
ok('not fully paid flag', pay1.paid === false);
ok('sum paid', sumPaidRial(db, recId) === 4000000);

const row1 = db.prepare('SELECT * FROM payroll_records WHERE id=?').get(recId);
let overOk = false;
try {
  db.transaction(() => postPayrollPayments(db, {
    row: row1,
    person,
    body: { amount_rial: 7000000, pay_type: 'cash', date: '1405/07/06' },
    userId: 1,
    resolveCashAccount,
    createPersonLedgerEntry,
  }))();
} catch (e) {
  overOk = e.code === 'E_PAYROLL_OVERPAY' || /مانده/.test(e.message);
}
ok('overpay rejected', overOk);

const row2 = db.prepare('SELECT * FROM payroll_records WHERE id=?').get(recId);
const pay2 = db.transaction(() => postPayrollPayments(db, {
  row: row2,
  person,
  body: {
    legs: [
      { amount_rial: 2500000, pay_type: 'bank', date: '1405/07/08' },
      { amount_rial: 3500000, pay_type: 'cash', date: '1405/07/08' },
    ],
  },
  userId: 1,
  resolveCashAccount,
  createPersonLedgerEntry,
}))();

ok('multi-leg clears', pay2.remaining_rial === 0 && pay2.paid === true, pay2);
ok('status paid', pay2.status === 'paid');
ok('three payment rows', db.prepare(
  "SELECT COUNT(*) c FROM payroll_payments WHERE payroll_record_id=? AND status='posted'"
).get(recId).c === 3);

const midPay = db.prepare(
  "SELECT * FROM payroll_payments WHERE payroll_record_id=? AND status='posted' ORDER BY id LIMIT 1"
).get(recId);
db.transaction(() => voidOnePayrollPayment(db, midPay, 1, createPersonLedgerEntry))();
const afterVoidOne = enrichPayrollRow(db, db.prepare('SELECT * FROM payroll_records WHERE id=?').get(recId));
ok('void one reopens remaining', afterVoidOne.remaining_rial === midPay.amount_rial, afterVoidOne);
ok('status partial after void one', afterVoidOne.status === 'partial');

const row3 = db.prepare('SELECT * FROM payroll_records WHERE id=?').get(recId);
db.transaction(() => voidAllPayrollPayments(db, row3, 1, createPersonLedgerEntry))();
const afterAll = enrichPayrollRow(db, db.prepare('SELECT * FROM payroll_records WHERE id=?').get(recId));
ok('void all clears paid', afterAll.paid_rial === 0 && afterAll.remaining_rial === netRial, afterAll);
ok('status posted after void all', afterAll.status === 'posted');
ok('no active payments', sumPaidRial(db, recId) === 0);
ok('remaining helper', remainingRial(db, afterAll) === netRial);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
process.exit(failed ? 1 : 0);
