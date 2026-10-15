'use strict';
/**
 * v408 â€” Wave 2: remittance JE, advance + recovery, year-end reserve release
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const testDb = path.join(__dirname, 'payroll-wave2-v408-test.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch { /* absent */ }
}
process.env.DB_PATH = testDb;
process.env.SYNC_ROLE = 'device';

const { initDB, getDB, resolveCashAccount, createPersonLedgerEntry } = require('../db');
const { postToLedger } = require('../lib/ledger');
const { acct } = require('../lib/coa-map');
const { postRemittance, remittanceBalances, voidRemittance } = require('../lib/payroll/remittance');
const {
  issueAdvance,
  allocateAdvanceRecovery,
  applyAdvanceRecoveries,
  reverseAdvanceRecoveries,
  personAdvanceBalance,
  voidAdvance,
} = require('../lib/payroll/advances');
const { postYearEndWithReserveRelease, sumUnreleased } = require('../lib/payroll/year-end-post');
const { SYNCABLE_TABLES } = require('../sync/tables');
const { PATH_TABLE_MAP } = require('../sync/capture');

let passed = 0;
function ok(cond, msg) {
  assert(cond, msg);
  passed += 1;
  console.log('OK', msg);
}

initDB();
const db = getDB();

const syncNames = SYNCABLE_TABLES.map(t => t.name);
ok(syncNames.includes('payroll_remittances'), 'sync: payroll_remittances');
ok(syncNames.includes('payroll_advances'), 'sync: payroll_advances');
ok(syncNames.includes('payroll_advance_recoveries'), 'sync: payroll_advance_recoveries');
ok(PATH_TABLE_MAP.some(([p, t]) => p === '/api/payroll/remittances' && t === 'payroll_remittances'), 'capture remittances');
ok(PATH_TABLE_MAP.some(([p, t]) => p === '/api/payroll/advances' && t === 'payroll_advances'), 'capture advances');

db.prepare(`INSERT INTO persons (name, active) VALUES ('Ú©Ø§Ø±Ù…Ù†Ø¯ ØªØ³Øª Ù…ÙˆØ¬Û²', 1)`).run();
const personId = db.prepare(`SELECT id FROM persons WHERE name='Ú©Ø§Ø±Ù…Ù†Ø¯ ØªØ³Øª Ù…ÙˆØ¬Û²'`).get().id;

const ssoAmt = 30000000;
const taxAmt = 10000000;
db.transaction(() => {
  postToLedger(db, {
    sourceType: 'payroll_test_accrual',
    sourceId: 1,
    date: '1405/07/01',
    description: 'ØªØ¹Ù‡Ø¯ ØªØ³Øª Ø¨ÛŒÙ…Ù‡/Ù…Ø§Ù„ÛŒØ§Øª',
    createdBy: 1,
    lines: [
      { ...acct(db, 'coa_payroll_expense'), debit: (ssoAmt + taxAmt) / 10, credit: 0 },
      { ...acct(db, 'coa_sso_payable'), debit: 0, credit: ssoAmt / 10 },
      { ...acct(db, 'coa_payroll_tax_payable'), debit: 0, credit: taxAmt / 10 },
    ],
  });
})();

let bal = remittanceBalances(db);
ok(bal.sso_payable_rial >= ssoAmt, 'SSO payable balance after accrual');
ok(bal.tax_payable_rial >= taxAmt, 'tax payable balance after accrual');

const remit = db.transaction(() => postRemittance(db, {
  kind: 'sso',
  amount_rial: ssoAmt,
  pay_type: 'bank',
  date: '1405/07/10',
  period_label: '1405/07',
  userId: 1,
  resolveCashAccount,
}))();
ok(!!remit.journal_id, 'remittance JE created');
bal = remittanceBalances(db);
ok(bal.sso_payable_rial < ssoAmt, 'SSO payable reduced after remittance');

const remitLines = db.prepare(`
  SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?
`).all(remit.journal_id);
ok(remitLines.some(l => l.account_code === '2105' && l.debit_rial === ssoAmt), 'Dr 2105 on remittance');
ok(remitLines.some(l => l.credit_rial === ssoAmt), 'Cr bank/cash on remittance');

db.transaction(() => voidRemittance(db, remit.id, 1))();
bal = remittanceBalances(db);
ok(bal.sso_payable_rial >= ssoAmt, 'SSO payable restored after remittance void');

const advAmt = 50000000;
const adv = db.transaction(() => issueAdvance(db, {
  person_id: personId,
  amount_rial: advAmt,
  pay_type: 'cash',
  date: '1405/07/05',
  note: 'ØªØ³Øª',
  userId: 1,
  resolveCashAccount,
  createPersonLedgerEntry,
}))();
ok(personAdvanceBalance(db, personId) === advAmt, 'advance balance = issued');
const advJe = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(adv.journal_id);
ok(!!advJe, 'advance JE exists');
const advLines = db.prepare(`
  SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?
`).all(adv.journal_id);
ok(advLines.some(l => l.account_code === '1119' && l.debit_rial === advAmt), 'Dr 1119 on advance');

const recover = 20000000;
const alloc = allocateAdvanceRecovery(db, personId, recover);
ok(alloc.allocated_rial === recover, 'allocate recovery amount');
db.prepare(`
  INSERT INTO payroll_records (person_id, period_label, net_pay_rial, status, gross_earnings_rial)
  VALUES (?, '1405/07', 100000000, 'posted', 120000000)
`).run(personId);
const recId = db.prepare(`
  SELECT id FROM payroll_records WHERE person_id=? AND period_label='1405/07' ORDER BY id DESC LIMIT 1
`).get(personId).id;
applyAdvanceRecoveries(db, recId, personId, alloc.legs);
ok(personAdvanceBalance(db, personId) === advAmt - recover, 'balance after recovery');
reverseAdvanceRecoveries(db, recId);
ok(personAdvanceBalance(db, personId) === advAmt, 'balance restored after reverse recovery');

db.transaction(() => voidAdvance(db, adv.id, 1, createPersonLedgerEntry))();
ok(personAdvanceBalance(db, personId) === 0, 'balance zero after void unrecovered advance');

db.prepare(`
  INSERT INTO payroll_monthly_accruals (period_label, person_id, severance_rial, eidi_rial, je_id, created_by)
  VALUES ('1405/01', ?, 10000000, 15000000, NULL, 1)
`).run(personId);
db.prepare(`
  INSERT INTO payroll_monthly_accruals (period_label, person_id, severance_rial, eidi_rial, je_id, created_by)
  VALUES ('1405/02', ?, 10000000, 15000000, NULL, 1)
`).run(personId);

const reserved = sumUnreleased(db, personId, 1405);
ok(reserved.eidi_rial === 30000000, 'unreleased eidi sum');
ok(reserved.severance_rial === 20000000, 'unreleased severance sum');

const yeInfo = db.prepare(`
  INSERT INTO payroll_year_end_bonuses
    (person_id, fiscal_year, service_days, eidi_rial, severance_rial, tax_exempt_rial,
     taxable_rial, income_tax_rial, net_pay_rial, status, created_by)
  VALUES (?, 1405, 365, 50000000, 30000000, 0, 50000000, 0, 80000000, 'draft', 1)
`).run(personId);
const yeId = yeInfo.lastInsertRowid;
const person = db.prepare('SELECT * FROM persons WHERE id=?').get(personId);
const yeResult = db.transaction(() => postYearEndWithReserveRelease(db, {
  row: { ...db.prepare('SELECT * FROM payroll_year_end_bonuses WHERE id=?').get(yeId), person_name: person.name },
  person,
  date: '1405/12/29',
  userId: 1,
  createPersonLedgerEntry,
}))();
ok(yeResult.released_eidi_rial === 30000000, 'released eidi from reserve');
ok(yeResult.released_severance_rial === 20000000, 'released severance from reserve');
ok(yeResult.expense_eidi_rial === 20000000, 'expense only eidi shortfall');
ok(yeResult.expense_severance_rial === 10000000, 'expense only severance shortfall');
const yeLines = db.prepare(`
  SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?
`).all(yeResult.journal_id);
ok(yeLines.some(l => l.account_code === '2111' && l.debit_rial === 30000000), 'Dr 2111 release eidi');
ok(yeLines.some(l => l.account_code === '2110' && l.debit_rial === 20000000), 'Dr 2110 release severance');
const left = sumUnreleased(db, personId, 1405);
ok(left.eidi_rial === 0 && left.severance_rial === 0, 'no unreleased accruals left');

const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(appSrc.includes('renderPayrollRemittances'), 'UI remittances');
ok(appSrc.includes('renderPayrollAdvances'), 'UI advances');
ok(appSrc.includes('renderPayrollMonthlyAccruals'), 'UI accruals');
ok(appSrc.includes('advance_recovery_rial'), 'UI advance recovery field');

console.log(`\nPASSED ${passed}`);
process.exit(0);
