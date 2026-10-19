'use strict';
/**
 * v482 — staff loan issue stays off gross pay; installment slices reverse per payslip.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const testDb = path.join(__dirname, 'payroll-loan-issue-v482-test.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch { /* absent */ }
}
process.env.DB_PATH = testDb;
process.env.SYNC_ROLE = 'device';

const { initDB, getDB, resolveCashAccount, createPersonLedgerEntry } = require('../db');
const { acct } = require('../lib/coa-map');
const {
  issueLoan,
  listLoanInstallments,
  allocateLoanRecovery,
  applyLoanRecoveries,
  reverseLoanRecoveries,
  voidLoan,
  nextPeriodLabel,
} = require('../lib/payroll/loans');
const { SYNCABLE_TABLES, FK_COLUMNS } = require('../sync/tables');

let passed = 0;
function ok(cond, msg) {
  assert(cond, msg);
  passed += 1;
  console.log('OK', msg);
}

initDB();
const db = getDB();

ok(SYNCABLE_TABLES.some(t => t.name === 'payroll_loan_recoveries'), 'sync table appended');
ok(FK_COLUMNS.some(([t, c]) => t === 'payroll_loan_recoveries' && c === 'payroll_record_id'), 'fk payroll_record_id');
ok(nextPeriodLabel('1405/12', 1) === '1406/01', 'next period year roll');

db.prepare(`INSERT INTO persons (name, active) VALUES ('کارمند وام ۴۸۲', 1)`).run();
const personId = db.prepare(`SELECT id FROM persons WHERE name='کارمند وام ۴۸۲'`).get().id;

const principal = 10000007;
const issued = issueLoan(db, {
  person_id: personId,
  principal_rial: principal,
  installment_count: 3,
  start_period_label: '1405/08',
  pay_type: 'cash',
  date: '1405/07/27',
  note: 'تست',
  userId: 1,
  resolveCashAccount,
  createPersonLedgerEntry,
});
ok(issued.principal_rial === principal, 'principal stored in rial');
ok(issued.start_period_label === '1405/08', 'first due is the chosen period');

const inst = listLoanInstallments(db, issued.id);
ok(inst.length === 3, 'three installments');
ok(inst.reduce((s, r) => s + r.amount_rial, 0) === principal, 'schedule sums to principal');
ok(inst[0].due_period_label === '1405/08', 'first row is start period');
ok(inst[2].due_period_label === '1405/10', 'third row is two months later');
ok(inst[2].amount_rial === inst[0].amount_rial + (principal % 3), 'remainder on last installment');

const advance = acct(db, 'coa_employee_advance');
const lines = db.prepare('SELECT * FROM journal_lines WHERE entry_id=?').all(issued.journal_id);
const dr = lines.find(l => l.debit > 0);
const cr = lines.find(l => l.credit > 0);
ok(dr && dr.account_code === advance.code, 'issue debits 1119');
ok(Math.round(dr.debit * 10) === principal, 'issue amount is principal in rial via toman journal');
ok(cr && cr.credit === dr.debit, 'cash credit matches');
ok(!lines.some(l => /6104|5201|2105|2106/.test(String(l.account_code || ''))), 'principal is not wage, insurance, or tax');

const dueNow = allocateLoanRecovery(db, personId, '1405/07', 10 ** 9);
ok(dueNow.allocated_rial === 0, 'nothing due before start period');
const dueFirst = allocateLoanRecovery(db, personId, '1405/08', inst[0].amount_rial);
ok(dueFirst.allocated_rial === inst[0].amount_rial, 'first installment due on start period');

const slice = Math.floor(inst[0].amount_rial / 2);
const legA = allocateLoanRecovery(db, personId, '1405/08', slice);
applyLoanRecoveries(db, 901, legA.legs);
const legB = allocateLoanRecovery(db, personId, '1405/08', inst[0].amount_rial);
applyLoanRecoveries(db, 902, legB.legs);
const mid = db.prepare('SELECT paid_rial, status FROM payroll_loan_installments WHERE id=?').get(inst[0].id);
ok(mid.paid_rial === inst[0].amount_rial && mid.status === 'paid', 'two payslips can finish one installment');

reverseLoanRecoveries(db, 901);
const afterA = db.prepare('SELECT paid_rial, status, payroll_record_id FROM payroll_loan_installments WHERE id=?').get(inst[0].id);
ok(afterA.paid_rial === inst[0].amount_rial - slice, 'voiding the first payslip keeps the second slice');
ok(afterA.status === 'partial', 'installment stays partial');
ok(Number(afterA.payroll_record_id) === 902, 'remaining slice points at the live payslip');

let blocked = false;
try { voidLoan(db, issued.id, 1); } catch (e) { blocked = e.status === 409; }
ok(blocked, 'loan void blocked while a recovery remains');

reverseLoanRecoveries(db, 902);
const cleared = db.prepare('SELECT paid_rial, status FROM payroll_loan_installments WHERE id=?').get(inst[0].id);
ok(cleared.paid_rial === 0 && cleared.status === 'pending', 'second void reopens the installment');
const loanRow = db.prepare('SELECT recovered_rial, status FROM payroll_loans WHERE id=?').get(issued.id);
ok(loanRow.recovered_rial === 0 && loanRow.status === 'open', 'loan reopened with zero recovered');
const voided = voidLoan(db, issued.id, 1);
ok(voided.ok === true, 'unrecovered loan voids');
const gone = db.prepare('SELECT status FROM payroll_loans WHERE id=?').get(issued.id);
ok(gone.status === 'reversed', 'status reversed');

console.log(`\nPASS ${passed}`);
