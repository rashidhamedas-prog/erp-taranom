'use strict';
/**
 * R13 payroll accrual void — soft-void JE + PL, keep row status=reversed, remaining=0.
 * Run: node server/scripts/test-payroll-void-r13-v301.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payroll-void-v301-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-payroll-void-r13-v301-secret!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, createPersonLedgerEntry, resolveCashAccount } = require('../db');
initDB();
const db = getDB();

const { postToLedger } = require('../lib/ledger');
const { acct } = require('../lib/coa-map');
const {
  postPayrollPayments,
  enrichPayrollRow,
  remainingRial,
} = require('../lib/payroll/payments');
const {
  voidPayrollAccrual,
  repairOrphanPayrollVoids,
  FLAG,
} = require('../lib/payroll/void-accrual');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra != null ? extra : ''); }
}

const personId = db.prepare(
  "INSERT INTO persons (name, active) VALUES ('کارمند ابطال v301',1)"
).run().lastInsertRowid;

const netRial = 50000000;
const accrualJe = db.transaction(() => postToLedger(db, {
  date: '1405/07/01',
  description: 'تعهد حقوق تست ابطال',
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

// Fix sourceId linkage (post used sourceId:1 placeholder)
db.prepare("UPDATE journal_entries SET ref_id=? WHERE id=?").run(recId, accrualJe);

createPersonLedgerEntry(db, {
  person_id: personId, date: '1405/07/01', entry_type: 'payroll',
  ref_type: 'payroll', ref_id: recId, description: 'حقوق 1405/07',
  debit: 0, credit: netRial / 10, user_id: 1,
});

const person = db.prepare('SELECT * FROM persons WHERE id=?').get(personId);
const row0 = db.prepare('SELECT * FROM payroll_records WHERE id=?').get(recId);

db.transaction(() => postPayrollPayments(db, {
  row: row0,
  person,
  body: { amount_rial: 20000000, pay_type: 'cash', date: '1405/07/05' },
  userId: 1,
  resolveCashAccount,
  createPersonLedgerEntry,
}))();

const before = enrichPayrollRow(db, db.prepare('SELECT * FROM payroll_records WHERE id=?').get(recId));
ok(before.status === 'partial', 'partial before void');
ok(before.remaining_rial === 30000000, 'remaining before void', before.remaining_rial);

const voided = db.transaction(() => voidPayrollAccrual(db, {
  row: db.prepare('SELECT * FROM payroll_records WHERE id=?').get(recId),
  userId: 1,
  reason: 'تست ابطال',
  cascadePayments: true,
}))();

ok(voided.status === 'reversed', 'record status reversed');
ok(Number(voided.reversed_at) > 0, 'reversed_at stamped');

const stillThere = db.prepare('SELECT id FROM payroll_records WHERE id=?').get(recId);
ok(!!stillThere, 'row not physically deleted');

const je = db.prepare('SELECT status, deleted_at FROM journal_entries WHERE id=?').get(accrualJe);
ok(je.status === 'reversed' && Number(je.deleted_at) > 0, 'accrual JE soft-voided');

const payJes = db.prepare(`
  SELECT status, deleted_at FROM journal_entries
  WHERE ref_type='payroll_payment' AND ref_id=?
`).all(recId);
ok(payJes.length >= 1 && payJes.every((j) => j.status === 'reversed' && Number(j.deleted_at) > 0),
  'payment JEs soft-voided', payJes);

const livePl = db.prepare(`
  SELECT COUNT(*) c FROM person_ledger
  WHERE ref_id=? AND COALESCE(deleted_at,0)=0
`).get(recId).c;
ok(livePl === 0, 'person_ledger soft-voided for record', livePl);

const enriched = enrichPayrollRow(db, voided);
ok(enriched.remaining_rial === 0, 'remaining 0 after void');
ok(remainingRial(db, voided) === 0, 'remainingRial helper 0');

// Orphan repair: mark another row reversed without voiding JE
const je2 = db.transaction(() => postToLedger(db, {
  date: '1405/07/10',
  description: 'تعهد یتیم',
  sourceType: 'payroll',
  sourceId: 99,
  createdBy: 1,
  lines: [
    { ...acct(db, 'coa_payroll_expense'), debit: 1000, credit: 0 },
    { ...acct(db, 'coa_payroll_payable'), debit: 0, credit: 1000 },
  ],
}))();
const orphanId = db.prepare(`
  INSERT INTO payroll_records (
    person_id, period_label, date, gross_pay, net_pay, net_pay_rial,
    paid, status, journal_entry_id, created_by, reversed_at
  ) VALUES (?,?,?,?,?,?,0,'reversed',?,1,strftime('%s','now'))
`).run(personId, '1405/07', '1405/07/10', 1000, 1000, 10000, je2).lastInsertRowid;
db.prepare("UPDATE journal_entries SET ref_id=? WHERE id=?").run(orphanId, je2);
createPersonLedgerEntry(db, {
  person_id: personId, date: '1405/07/10', entry_type: 'payroll',
  ref_type: 'payroll', ref_id: orphanId, description: 'یتیم',
  debit: 0, credit: 1000, user_id: 1,
});

db.prepare('DELETE FROM settings WHERE key=?').run(FLAG);
const repair = repairOrphanPayrollVoids(db);
ok(!repair.skipped, 'repair ran');
const je2After = db.prepare('SELECT status, deleted_at FROM journal_entries WHERE id=?').get(je2);
ok(je2After.status === 'reversed' && Number(je2After.deleted_at) > 0, 'orphan JE repaired');
const orphanPl = db.prepare(`
  SELECT COUNT(*) c FROM person_ledger WHERE ref_id=? AND COALESCE(deleted_at,0)=0
`).get(orphanId).c;
ok(orphanPl === 0, 'orphan PL soft-voided');

const again = repairOrphanPayrollVoids(db);
ok(again.skipped === true, 'repair idempotent');

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
