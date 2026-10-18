/**
 * v449 — rep cash/accrual hits the person's COA leaf + person_ledger.
 * A bank payment must show on گردش شخص and move party-books.
 * Run: node server/scripts/test-person-counterparty-v449.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra != null ? JSON.stringify(extra) : ''); }
}

console.log('\n— 0 static —');
const acc = fs.readFileSync(path.join(__dirname, '../routes/accounting.js'), 'utf8');
const reps = fs.readFileSync(path.join(__dirname, '../routes/rep-management.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(acc.includes('counterpartyAccount'), 'incentive route uses person leaf');
ok(acc.includes('retirePersonLedgerByRef'), 'void incentive retires person ledger');
ok(reps.includes("counterpartyAccount(db, repId, 'coa_rep_advance')"), 'advance uses person leaf');
ok(reps.includes('rep_expense_paid'), 'expense reimbursement mirrors person');
ok(dbSrc.includes('reclass_rep_person_v449'), 'boot heal v449');
ok(sw.includes('erp-taranom-v449'), 'SW v449');
ok(app.includes('تفصیلی همین شخص') && !app.includes('در این گردش نیست'), 'banner no longer hides payments');

let db = null;
let closeDB = null;
let dir = null;
try {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'person-cp-v449-'));
  process.env.DB_PATH = path.join(dir, 't.db');
  process.env.SYNC_ROLE = 'central';
  process.env.JWT_SECRET = 'test-person-counterparty-v449-secret!!';
  process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
  delete require.cache[require.resolve('../db')];
  const dbMod = require('../db');
  dbMod.initDB();
  db = dbMod.getDB();
  closeDB = dbMod.closeDB;
} catch (e) {
  console.log('\n— SKIP_SQLITE —', String(e && e.message || e).slice(0, 120));
}

if (db) {
  const { postToLedger } = require('../lib/ledger');
  const { rialToLedger } = require('../lib/money');
  const { acct } = require('../lib/coa-map');
  const { reclassRepCounterpartyToPerson, counterpartyAccount } = require('../lib/person-counterparty');
  const { buildPartyTurnover } = require('../lib/party-turnover');
  const { retirePersonLedgerByRef } = require('../lib/party-ledger-retire');
  const { reverseJournalEntry } = require('../lib/void-journal');

  const leafCode = '110601000449';
  db.prepare(`
    INSERT INTO chart_of_accounts (code, name, type, parent_code, level, is_active)
    VALUES (?, 'عارف تست ۴۴۹', 'asset', '1106', 4, 1)
  `).run(leafCode);
  const opening = 65848074;
  const paid = 100000000;
  const partyId = db.prepare(`
    INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, is_active, opening_balance, coa_code)
    VALUES ('P-V449','other','["other"]','عارف تست ۴۴۹','09121110449',1,?,?)
  `).run(-opening, leafCode).lastInsertRowid;
  const personId = db.prepare(`
    INSERT INTO persons (name, phone, party_id, active, coa_code)
    VALUES ('عارف تست ۴۴۹','09121110449',?,1,?)
  `).run(partyId, leafCode).lastInsertRowid;
  db.prepare(`
    INSERT INTO person_ledger (person_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id)
    VALUES (?, '1405/06/31', 'opening', 'opening_balance', 900001, 'مانده اول دوره', 0, ?, 1)
  `).run(personId, opening);
  const userId = db.prepare(`
    INSERT INTO users (username, password, name, role, active, party_id)
    VALUES ('aref449','x','عارف تست ۴۴۹','field_sales',1,?)
  `).run(partyId).lastInsertRowid;
  const orphanId = db.prepare(`
    INSERT INTO users (username, password, name, role, active)
    VALUES ('norep449','x','بدون شخص','field_sales',1)
  `).run().lastInsertRowid;

  const payable = acct(db, 'coa_rep_commission_payable');
  const cash = acct(db, 'coa_cash_default');
  const payId = db.prepare(`
    INSERT INTO incentive_payments (rep_id, amount, pay_type, date, note, created_by, status)
    VALUES (?, ?, 'bank', '1405/07/03', 'بانک', 1, 'posted')
  `).run(userId, paid).lastInsertRowid;

  console.log('\n— 1 legacy 2107 reclass —');
  const jeId = postToLedger(db, {
    sourceType: 'incentive_payment', sourceId: payId,
    date: '1405/07/03', description: 'پرداخت انگیزه فروش به عارف تست ۴۴۹', createdBy: 1,
    lines: [
      { code: payable.code, name: payable.name, debit: rialToLedger(paid), credit: 0 },
      { code: cash.code, name: cash.name, debit: 0, credit: rialToLedger(paid) },
    ],
  });
  const before = db.prepare('SELECT account_code FROM journal_lines WHERE entry_id=? AND debit_rial>0').get(jeId);
  ok(before && before.account_code === payable.code, 'legacy debit is pooled', before);
  const stats = reclassRepCounterpartyToPerson(db);
  ok(stats.moved >= 1 && stats.mirrored >= 1, 'heal moved and mirrored', stats);
  const after = db.prepare('SELECT account_code, debit_rial FROM journal_lines WHERE entry_id=? AND debit_rial>0').get(jeId);
  ok(after && after.account_code === leafCode && Number(after.debit_rial) === paid, 'debit now on person leaf', after);
  const bank = db.prepare('SELECT account_code, credit_rial FROM journal_lines WHERE entry_id=? AND credit_rial>0').get(jeId);
  ok(bank && bank.account_code === cash.code && Number(bank.credit_rial) === paid, 'bank line unchanged', bank);
  const pl = db.prepare(`
    SELECT debit, credit FROM person_ledger
    WHERE person_id=? AND ref_type='incentive_payment' AND ref_id=? AND COALESCE(deleted_at,0)=0
  `).get(personId, payId);
  ok(pl && Number(pl.debit) === paid && Number(pl.credit) === 0, 'person_ledger debit', pl);

  const turn = buildPartyTurnover(db, partyId);
  const payRows = (turn.entries || []).filter((e) => String(e.description || '').includes('پرداخت انگیزه'));
  ok(payRows.length === 1 && Number(payRows[0].debit) === paid, 'turnover shows the payment once', payRows);
  ok(!(turn.entries || []).some((e) => String(e.description || '').includes('تطبیق با دفتر زنده')),
    'no synthetic reconcile');
  ok(Math.round(Number(turn.closing)) === paid - opening, 'closing includes payment', turn && turn.closing);
  ok(Math.round(Number(turn.totalDebit)) === paid, 'period debit is the payment', turn && turn.totalDebit);

  console.log('\n— 2 unlinked rep stays pooled —');
  const orphanPay = db.prepare(`
    INSERT INTO incentive_payments (rep_id, amount, pay_type, date, note, created_by, status)
    VALUES (?, 5000, 'cash', '1405/07/04', 'یتیم', 1, 'posted')
  `).run(orphanId).lastInsertRowid;
  const orphanJe = postToLedger(db, {
    sourceType: 'incentive_payment', sourceId: orphanPay,
    date: '1405/07/04', description: 'پرداخت بدون شخص', createdBy: 1,
    lines: [
      { code: payable.code, name: payable.name, debit: rialToLedger(5000), credit: 0 },
      { code: cash.code, name: cash.name, debit: 0, credit: rialToLedger(5000) },
    ],
  });
  reclassRepCounterpartyToPerson(db);
  const orphanLine = db.prepare('SELECT account_code FROM journal_lines WHERE entry_id=? AND debit_rial>0').get(orphanJe);
  ok(orphanLine && orphanLine.account_code === payable.code, 'no leaf → stays pooled', orphanLine);
  const resolved = counterpartyAccount(db, orphanId, 'coa_rep_commission_payable');
  ok(resolved.pooled === true && resolved.account.code === payable.code, 'fallback account', resolved.account);

  console.log('\n— 3 void drops the document —');
  reverseJournalEntry(db, jeId, { userId: 1, reason: 'ابطال', sourceType: 'incentive_payment_reversal' });
  retirePersonLedgerByRef(db, { refTypes: ['incentive_payment'], refId: payId });
  const turn2 = buildPartyTurnover(db, partyId);
  ok(!(turn2.entries || []).some((e) => String(e.description || '').includes('پرداخت انگیزه')),
    'voided payment hidden');
  ok(Math.round(Number(turn2.closing)) === -opening, 'closing back to opening', turn2 && turn2.closing);

  try { closeDB(); } catch (_) { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
