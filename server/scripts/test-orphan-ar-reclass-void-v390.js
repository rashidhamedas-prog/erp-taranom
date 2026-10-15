/**
 * Orphan ar_control_reclass after settlement void must not leave leaf credits (SW v390).
 * Reproduces Sadoughi-class bug: books exclude reversed settlement; leaf still has reclass Cr.
 * Run: node server/scripts/test-orphan-ar-reclass-void-v390.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-reclass-v390-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-orphan-reclass-v390-secret-32chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB, createLedgerEntry } = require('../db');
initDB();
const db = getDB();

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra != null ? extra : ''); }
}

const { postToLedger } = require('../lib/ledger');
const { rialToLedger } = require('../lib/money');
const { acct } = require('../lib/coa-map');
const {
  reclassifyControlArToCustomerLeaf,
  repairOrphanArControlReclass,
  softVoidArControlReclassForSettlement,
  canonicalCustomerFold,
  glCustomersTafsiliBalance,
  ensureCustomerBooksRepaired,
  AR_CONTROL_RECLASS,
} = require('../lib/customer-books');
const { reverseSettlementInTx } = require('../lib/void-settlement');
const { ensureCustomerTafsili } = require('../lib/party-tafsili');

const custId = db.prepare(`
  INSERT INTO customers (user_id, biz, phone, status)
  VALUES (1, 'صدوقی تست v390', '09121111111', 'active')
`).run().lastInsertRowid;
ensureCustomerTafsili(db, custId);
const cust = db.prepare('SELECT coa_code FROM customers WHERE id=?').get(custId);
ok(!!cust && !!cust.coa_code && cust.coa_code !== '1103', 'customer has leaf coa', cust);

const INV_AMT = 152380000;
const SETT_AMT = 151800000;

const invId = db.prepare(`
  INSERT INTO invoices (user_id, cust_id, num, type, date, final, pay_type, status, approved, deleted_at)
  VALUES (1, ?, 'T-TEST-389', 'normal', '1405/07/02', ?, 'mixed', 'posted', 1, 0)
`).run(custId, INV_AMT).lastInsertRowid;

createLedgerEntry(db, {
  customer_id: custId,
  date: '1405/07/02',
  entry_type: 'invoice',
  ref_type: 'invoice',
  ref_id: invId,
  description: 'فاکتور تست v390',
  debit: INV_AMT,
  credit: 0,
  user_id: 1,
});

const recv = acct(db, 'coa_receivable');
const sales = acct(db, 'coa_sales');
postToLedger(db, {
  sourceType: 'invoice', sourceId: invId, date: '1405/07/02',
  description: 'فاکتور تست v390', createdBy: 1,
  lines: [
    { code: recv.code, name: recv.name, debit: rialToLedger(INV_AMT), credit: 0 },
    { code: sales.code, name: sales.name, debit: 0, credit: rialToLedger(INV_AMT) },
  ],
});

const settId = db.prepare(`
  INSERT INTO settlements (user_id, cust_id, invoice_id, date, amount, amount_rial, pay_type, status)
  VALUES (1, ?, ?, '1405/07/02', ?, ?, 'bank_transfer', 'posted')
`).run(custId, invId, SETT_AMT, SETT_AMT).lastInsertRowid;

createLedgerEntry(db, {
  customer_id: custId,
  date: '1405/07/02',
  entry_type: 'settlement',
  ref_type: 'settlement',
  ref_id: settId,
  description: 'تسویه تست v390',
  debit: 0,
  credit: SETT_AMT,
  user_id: 1,
});

const bank = acct(db, 'coa_bank_default');
postToLedger(db, {
  sourceType: 'settlement', sourceId: settId, date: '1405/07/02',
  description: 'تسویه تست v390', createdBy: 1,
  lines: [
    { code: bank.code, name: bank.name, debit: rialToLedger(SETT_AMT), credit: 0 },
    { code: recv.code, name: recv.name, debit: 0, credit: rialToLedger(SETT_AMT) },
  ],
});

const moved = reclassifyControlArToCustomerLeaf(db);
ok((moved.moved || 0) >= 2, 'reclass moved invoice+settlement lines', moved);

const leafBefore = db.prepare(`
  SELECT
    COALESCE(SUM(CASE WHEN jl.debit_rial IS NOT NULL THEN jl.debit_rial ELSE ROUND(jl.debit*10) END),0) AS d,
    COALESCE(SUM(CASE WHEN jl.credit_rial IS NOT NULL THEN jl.credit_rial ELSE ROUND(jl.credit*10) END),0) AS c
  FROM journal_lines jl
  JOIN journal_entries je ON je.id=jl.entry_id
  WHERE jl.account_code=?
    AND COALESCE(je.deleted_at,0)=0
    AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
`).get(cust.coa_code);
ok(Number(leafBefore.d) === INV_AMT, 'leaf debit = invoice', leafBefore);
ok(Number(leafBefore.c) === SETT_AMT, 'leaf credit = settlement reclass', leafBefore);

const sett = db.prepare('SELECT * FROM settlements WHERE id=?').get(settId);
db.transaction(() => {
  reverseSettlementInTx(db, sett, 1, { date: '1405/07/03' });
})();

const settAfter = db.prepare('SELECT status FROM settlements WHERE id=?').get(settId);
ok(settAfter.status === 'reversed', 'settlement marked reversed');

const orphanAlive = db.prepare(`
  SELECT COUNT(*) AS n FROM journal_entries re
  JOIN journal_lines src ON src.id=re.ref_id
  JOIN journal_entries parent ON parent.id=src.entry_id
  WHERE re.ref_type=?
    AND COALESCE(re.deleted_at,0)=0
    AND COALESCE(re.status,'posted') NOT IN ('reversed','void')
    AND parent.ref_type='settlement' AND parent.ref_id=?
`).get(AR_CONTROL_RECLASS, settId);
ok(Number(orphanAlive.n) === 0, 'no alive settlement reclass after void', orphanAlive);

const invReclassAlive = db.prepare(`
  SELECT COUNT(*) AS n FROM journal_entries re
  JOIN journal_lines src ON src.id=re.ref_id
  JOIN journal_entries parent ON parent.id=src.entry_id
  WHERE re.ref_type=?
    AND COALESCE(re.deleted_at,0)=0
    AND COALESCE(re.status,'posted') NOT IN ('reversed','void')
    AND parent.ref_type='invoice' AND parent.ref_id=?
`).get(AR_CONTROL_RECLASS, invId);
ok(Number(invReclassAlive.n) === 1, 'invoice reclass kept alive', invReclassAlive);

const fold = canonicalCustomerFold(db);
const gl = glCustomersTafsiliBalance(db);
ok(Math.abs(Number(fold.display) - Number(gl.display)) <= 1, 'fold AR == leaf GL after void', {
  fold: fold.display, gl: gl.display, delta: fold.display - gl.display,
});
ok(Math.round(Number(fold.display)) === INV_AMT, 'fold shows full invoice AR', fold);

// --- Heal path: simulate pre-v390 orphan (reclass left after manual JE void) ---
const sett2 = db.prepare(`
  INSERT INTO settlements (user_id, cust_id, invoice_id, date, amount, amount_rial, pay_type, status)
  VALUES (1, ?, ?, '1405/07/04', 5000000, 5000000, 'cash', 'posted')
`).run(custId, invId).lastInsertRowid;

createLedgerEntry(db, {
  customer_id: custId, date: '1405/07/04', entry_type: 'settlement',
  ref_type: 'settlement', ref_id: sett2, description: 'تسویه یتیم',
  debit: 0, credit: 5000000, user_id: 1,
});
postToLedger(db, {
  sourceType: 'settlement', sourceId: sett2, date: '1405/07/04',
  description: 'تسویه یتیم', createdBy: 1,
  lines: [
    { code: bank.code, name: bank.name, debit: rialToLedger(5000000), credit: 0 },
    { code: recv.code, name: recv.name, debit: 0, credit: rialToLedger(5000000) },
  ],
});
reclassifyControlArToCustomerLeaf(db);

// Soft-void settlement JE + mark reversed WITHOUT cascade (legacy bug simulation)
const settJe = db.prepare(`
  SELECT id FROM journal_entries WHERE ref_type='settlement' AND ref_id=? LIMIT 1
`).get(sett2);
const { reverseJournalEntry } = require('../lib/void-journal');
reverseJournalEntry(db, settJe.id, { reason: 'sim legacy void' });
db.prepare(`UPDATE settlements SET status='reversed' WHERE id=?`).run(sett2);
db.prepare(`
  DELETE FROM customer_ledger WHERE ref_type='settlement' AND ref_id=?
`).run(sett2);

const beforeHeal = db.prepare(`
  SELECT COUNT(*) AS n FROM journal_entries re
  JOIN journal_lines src ON src.id=re.ref_id
  JOIN journal_entries parent ON parent.id=src.entry_id
  WHERE re.ref_type=? AND COALESCE(re.deleted_at,0)=0
    AND COALESCE(re.status,'posted') NOT IN ('reversed','void')
    AND parent.ref_type='settlement' AND parent.ref_id=?
`).get(AR_CONTROL_RECLASS, sett2);
ok(Number(beforeHeal.n) === 1, 'orphan reclass exists before heal', beforeHeal);

const healed = repairOrphanArControlReclass(db);
ok((healed.voided || 0) >= 1, 'heal soft-voided orphan', healed);

const afterHeal = db.prepare(`
  SELECT COUNT(*) AS n FROM journal_entries re
  JOIN journal_lines src ON src.id=re.ref_id
  JOIN journal_entries parent ON parent.id=src.entry_id
  WHERE re.ref_type=? AND COALESCE(re.deleted_at,0)=0
    AND COALESCE(re.status,'posted') NOT IN ('reversed','void')
    AND parent.ref_type='settlement' AND parent.ref_id=?
`).get(AR_CONTROL_RECLASS, sett2);
ok(Number(afterHeal.n) === 0, 'orphan gone after heal', afterHeal);

const healed2 = repairOrphanArControlReclass(db);
ok((healed2.voided || 0) === 0, 'heal idempotent', healed2);

const fold2 = canonicalCustomerFold(db);
const gl2 = glCustomersTafsiliBalance(db);
ok(Math.abs(Number(fold2.display) - Number(gl2.display)) <= 1, 'aligned after heal', {
  fold: fold2.display, gl: gl2.display,
});

// softVoid helper direct
ok(typeof softVoidArControlReclassForSettlement === 'function', 'export softVoid helper');
ok(typeof ensureCustomerBooksRepaired === 'function', 'ensure includes heal path');

console.log(`\n${pass} passed, ${fail} failed`);
try { closeDB(); } catch (_) {}
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
