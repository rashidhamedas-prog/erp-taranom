'use strict';
/**
 * Payroll net-pay posts to person tafsili; party books/turnover in rial; historical reclass.
 * Run: node server/scripts/test-payroll-person-tafsili-v300.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payroll-tafsili-v300-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-payroll-person-tafsili-v300-secret!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB, resolveCashAccount, createPersonLedgerEntry } = require('../db');
initDB();
const db = getDB();

const { postToLedger } = require('../lib/ledger');
const { acct, allocTafsili } = require('../lib/coa-map');
const { postPayrollPayments } = require('../lib/payroll/payments');
const { resolvePersonPayableAccount } = require('../lib/payroll/person-account');
const { reclassPayrollPayableToPersonTafsili, FLAG } = require('../lib/payroll/tafsili-reclass');
const { applyPartyBalances } = require('../lib/party-books');
const { buildPartyTurnover } = require('../lib/party-turnover');
const { personLedgerLineRial } = require('../lib/person-ledger-money');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra != null ? extra : ''); }
}

const tafsili = allocTafsili(db, 'person', 'رسولی تست v300');
ok(!!tafsili && String(tafsili).startsWith('1106'), 'person tafsili under 1106', tafsili);

const partyId = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, coa_code, is_active)
  VALUES ('P-RSL','other','["employee"]','آقا رسولی تست','09120000001',?,1)
`).run(tafsili).lastInsertRowid;

const personId = db.prepare(`
  INSERT INTO persons (name, phone, active, party_id, coa_code)
  VALUES ('آقا رسولی تست','09120000001',1,?,?)
`).run(partyId, tafsili).lastInsertRowid;

const person = db.prepare('SELECT * FROM persons WHERE id=?').get(personId);
const dest = resolvePersonPayableAccount(db, person);
ok(dest.code === tafsili, 'payable account is leaf tafsili', dest);

const netRial = 300_000_000;
const payRial = 100_000_000;
const payableCtrl = acct(db, 'coa_payroll_payable');

const oldAccrual = db.transaction(() => postToLedger(db, {
  date: '1405/06/31',
  description: 'حقوق 1405/06',
  sourceType: 'payroll',
  sourceId: 1,
  createdBy: 1,
  lines: [
    { ...acct(db, 'coa_payroll_expense'), debit: netRial / 10, credit: 0 },
    { ...payableCtrl, debit: 0, credit: netRial / 10 },
  ],
}))();

const recId = db.prepare(`
  INSERT INTO payroll_records (
    person_id, period_label, date, gross_pay, net_pay, net_pay_rial,
    paid, status, journal_entry_id, created_by
  ) VALUES (?,?,?,?,?,?,0,'posted',?,1)
`).run(personId, '1405/06', '1405/06/31', netRial / 10, netRial / 10, netRial, oldAccrual).lastInsertRowid;

db.prepare(`
  UPDATE journal_entries SET ref_id=? WHERE id=?
`).run(recId, oldAccrual);

createPersonLedgerEntry(db, {
  person_id: personId, date: '1405/06/31', entry_type: 'payroll',
  ref_type: 'payroll', ref_id: recId, description: 'حقوق 1405/06',
  debit: 0, credit: netRial / 10, user_id: 1,
});

const row0 = db.prepare('SELECT * FROM payroll_records WHERE id=?').get(recId);
db.transaction(() => postPayrollPayments(db, {
  row: row0,
  person,
  body: { amount_rial: payRial, pay_type: 'cash', date: '1405/07/05' },
  userId: 1,
  resolveCashAccount,
  createPersonLedgerEntry,
}))();

const payLine = db.prepare(`
  SELECT jl.account_code, jl.debit_rial
  FROM journal_lines jl
  JOIN journal_entries je ON je.id=jl.entry_id
  WHERE je.ref_type='payroll_payment' AND je.ref_id=? AND jl.debit_rial>0
`).get(recId);
ok(payLine && payLine.account_code === tafsili, 'new payment JE hits person tafsili', payLine);
ok(payLine && Number(payLine.debit_rial) === payRial, 'payment debit_rial matches', payLine);

db.prepare('DELETE FROM settings WHERE key=?').run(FLAG);
const rc = reclassPayrollPayableToPersonTafsili(db);
ok(rc.moved >= 1, 'reclass moves historical accrual off 2104', rc);

const accLine = db.prepare(`
  SELECT account_code, credit_rial FROM journal_lines WHERE entry_id=? AND credit_rial>0
`).get(oldAccrual);
ok(accLine && accLine.account_code === tafsili, 'accrual credit now on tafsili', accLine);
ok(accLine && Number(accLine.credit_rial) === netRial, 'accrual still net rial', accLine);

const ctrlLeft = db.prepare(`
  SELECT COALESCE(SUM(jl.credit_rial)-SUM(jl.debit_rial),0) s
  FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
  WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
`).get(payableCtrl.code);
ok(Number(ctrlLeft.s) === 0, '2104 net for this fixture is 0', ctrlLeft);

const scaled = personLedgerLineRial(db, {
  debit: 0, credit: netRial / 10, ref_type: 'payroll', ref_id: recId,
});
ok(scaled.credit === netRial, 'person_ledger toman credit scales to rial', scaled);

const partyRow = applyPartyBalances(db, [{ id: partyId, opening_balance: 0 }])[0];
ok(partyRow.balance === -(netRial - payRial), 'party list remaining rial creditor', partyRow.balance);

const turn = buildPartyTurnover(db, partyId);
ok(turn && turn.kind === 'person', 'turnover kind person');
ok(turn.entries.some((e) => e.source === 'gl' && e.credit === netRial), 'turnover shows accrual rial from GL', turn.entries);
ok(turn.entries.some((e) => e.debit === payRial), 'turnover shows payment rial', turn.entries);
ok(turn.closing === -(netRial - payRial), 'turnover closing = unpaid wages rial', turn.closing);
ok(!turn.entries.some((e) => e.source === 'person_ledger' && e.credit === netRial / 10),
  'does not show raw toman payroll row');

const glOnTafsili = db.prepare(`
  SELECT COUNT(*) c FROM journal_lines jl
  JOIN journal_entries je ON je.id=jl.entry_id
  WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0
`).get(tafsili);
ok(glOnTafsili.c >= 2, 'GL tafsili has accrual+payment lines', glOnTafsili.c);

try { closeDB(); } catch (_) {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
