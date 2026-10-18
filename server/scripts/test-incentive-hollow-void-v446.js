/**
 * v446 — Incentive / marketer / rep hollow-void:
 * void must not leave twin «پرداخت انگیزه + ابطال» on rep_ledger or party turnover.
 * Run: node server/scripts/test-incentive-hollow-void-v446.js
 * On Windows without better-sqlite3 ABI: static contracts only (SKIP_SQLITE).
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra != null ? extra : ''); }
}

console.log('\n— 0 static source contracts —');
const retireSrc = fs.readFileSync(path.join(__dirname, '../lib/party-ledger-retire.js'), 'utf8');
const accSrc = fs.readFileSync(path.join(__dirname, '../routes/accounting.js'), 'utf8');
const repSrc = fs.readFileSync(path.join(__dirname, '../lib/rep-ledger.js'), 'utf8');
const turnSrc = fs.readFileSync(path.join(__dirname, '../lib/party-turnover.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

ok(retireSrc.includes('retireRepLedgerByRef'), 'retireRepLedgerByRef exported');
ok(retireSrc.includes('hideVoidedRepLedgerRows'), 'hideVoidedRepLedgerRows exported');
ok(retireSrc.includes('repDeleted'), 'purge returns repDeleted');
const delIdx = accSrc.indexOf("router.delete('/incentive-payments/:id'");
const delSlice = delIdx >= 0 ? accSrc.slice(delIdx, delIdx + 2200) : '';
ok(delSlice.includes('retireRepLedgerByRef'), 'DELETE incentive uses retire');
ok(delSlice.includes('reverseJournalEntry'), 'DELETE incentive soft-voids JE');
ok(!delSlice.includes("entry_type: 'reversal'") && !delSlice.includes("entry_type='reversal'"),
  'DELETE incentive no longer inserts reversal row');
ok(repSrc.includes("COALESCE(status,'posted')<>'reversed'"), 'paid/statement exclude reversed');
ok(repSrc.includes('hideVoidedRepLedgerRows'), 'buildRepLedgerView filters voids');
ok(turnSrc.includes('hideVoidedRepLedgerRows'), 'party turnover filters rep_ledger');
ok(/reverseCommissionAccrual[\s\S]*retireRepLedgerByRef/.test(repSrc),
  'reverseCommissionAccrual retires (no hollow twin)');
ok(dbSrc.includes('purge_hollow_rep_incentive_v446'), 'boot heal flag v446');
ok(swSrc.includes('erp-taranom-v446'), 'SW v446');
ok(appSrc.includes('v446') && appSrc.includes('پرداخت انگیزه فروش، دفتر بازاریاب'),
  'admin help mentions incentive hollow-void');

let db = null;
let closeDB = null;
let dir = null;
try {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-hollow-v446-'));
  process.env.DB_PATH = path.join(dir, 't.db');
  process.env.SYNC_ROLE = 'central';
  process.env.JWT_SECRET = 'test-inc-hollow-v446-secret-32chars!!!';
  process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
  delete require.cache[require.resolve('../db')];
  const dbMod = require('../db');
  dbMod.initDB();
  db = dbMod.getDB();
  closeDB = dbMod.closeDB;
} catch (e) {
  console.log('\n— SKIP_SQLITE (better-sqlite3 ABI) — runtime DB cases deferred to Iran —');
  console.log('   ', (e && e.message) ? String(e.message).slice(0, 80) : e);
  db = null;
}

if (db) {

  const {
    retireRepLedgerByRef, hideVoidedRepLedgerRows, purgeHollowPartyLedgerReversals,
  } = require('../lib/party-ledger-retire');
  const { reverseJournalEntry } = require('../lib/void-journal');
  const { buildRepLedgerView, buildRepStatement } = require('../lib/rep-ledger');

  const adminId = db.prepare('SELECT id FROM users LIMIT 1').get()?.id || 1;
  const repId = db.prepare(`
    INSERT INTO users (username, name, role, password, active)
    VALUES ('rep446','بازاریاب تست ۴۴۶','field_sales','x',1)
  `).run().lastInsertRowid;

  console.log('\n— 1 void path retires (simulate) —');
  const payId = db.prepare(`
    INSERT INTO incentive_payments (rep_id, amount, pay_type, date, note, created_by, status)
    VALUES (?, 100000000, 'cash', '1405/07/03', 'تست', ?, 'posted')
  `).run(repId, adminId).lastInsertRowid;
  db.prepare(`
    INSERT INTO rep_ledger (rep_id, date, entry_type, ref_type, ref_id, description, debit, credit, created_by)
    VALUES (?, '1405/07/03', 'commission_paid', 'incentive_payment', ?, 'پرداخت انگیزه فروش', 100000000, 0, ?)
  `).run(repId, payId, adminId);
  const jeId = db.prepare(`
    INSERT INTO journal_entries (ref_type, ref_id, entry_date, description, status, created_by)
    VALUES ('incentive_payment', ?, '1405/07/03', 'پرداخت انگیزه فروش', 'posted', ?)
  `).run(payId, adminId).lastInsertRowid;

  reverseJournalEntry(db, jeId, {
    userId: adminId, reason: 'ابطال پرداخت انگیزه فروش', sourceType: 'incentive_payment_reversal',
  });
  retireRepLedgerByRef(db, {
    refTypes: ['incentive_payment', 'incentive_payment_reversal'],
    refId: payId,
    repId,
  });
  db.prepare("UPDATE incentive_payments SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=? WHERE id=?")
    .run(adminId, payId);

  const left = db.prepare(`
    SELECT COUNT(*) c FROM rep_ledger
    WHERE ref_type IN ('incentive_payment','incentive_payment_reversal') AND ref_id=?
  `).get(payId);
  ok(Number(left.c) === 0, 'rep_ledger retired after void', left);
  const je = db.prepare('SELECT status, deleted_at FROM journal_entries WHERE id=?').get(jeId);
  ok(je && (je.status === 'reversed' || Number(je.deleted_at) > 0), 'JE soft-voided', je);

  console.log('\n— 2 hideVoidedRepLedgerRows —');
  const livePay = db.prepare(`
    INSERT INTO incentive_payments (rep_id, amount, pay_type, date, note, created_by, status)
    VALUES (?, 5000000, 'cash', '1405/07/12', 'زنده', ?, 'posted')
  `).run(repId, adminId).lastInsertRowid;
  db.prepare(`
    INSERT INTO rep_ledger (rep_id, date, entry_type, ref_type, ref_id, description, debit, credit, created_by)
    VALUES (?, '1405/07/12', 'commission_paid', 'incentive_payment', ?, 'پرداخت انگیزه فروش', 5000000, 0, ?)
  `).run(repId, livePay, adminId);
  const deadPay = db.prepare(`
    INSERT INTO incentive_payments (rep_id, amount, pay_type, date, note, created_by, status)
    VALUES (?, 25000000, 'cash', '1405/07/16', 'مرده', ?, 'reversed')
  `).run(repId, adminId).lastInsertRowid;
  db.prepare(`
    INSERT INTO rep_ledger (rep_id, date, entry_type, ref_type, ref_id, description, debit, credit, created_by)
    VALUES (?, '1405/07/16', 'commission_paid', 'incentive_payment', ?, 'پرداخت انگیزه فروش', 25000000, 0, ?)
  `).run(repId, deadPay, adminId);
  db.prepare(`
    INSERT INTO rep_ledger (rep_id, date, entry_type, ref_type, ref_id, description, debit, credit, created_by)
    VALUES (?, '1405/07/23', 'reversal', 'incentive_payment_reversal', ?, 'ابطال پرداخت انگیزه فروش', 0, 25000000, ?)
  `).run(repId, deadPay, adminId);

  const raw = db.prepare('SELECT * FROM rep_ledger WHERE rep_id=?').all(repId);
  const hidden = hideVoidedRepLedgerRows(db, raw);
  ok(!hidden.some((e) => Number(e.ref_id) === deadPay), 'reversed twin hidden', hidden.length);
  ok(hidden.some((e) => Number(e.ref_id) === livePay && e.entry_type === 'commission_paid'),
    'live payment still visible');

  console.log('\n— 3 paid / statement exclude reversed —');
  const view = buildRepLedgerView(db, repId);
  ok(Math.round(Number(view.paid)) === 5000000, 'paid = live only', view.paid);
  const stmt = buildRepStatement(db, repId);
  const payEntries = (stmt.entries || []).filter((e) => e.type === 'payment');
  ok(payEntries.length === 1 && Math.round(Number(payEntries[0].debit)) === 5000000,
    'statement payments live only', payEntries);

  console.log('\n— 4 purge hollow cleans DB —');
  db.prepare("DELETE FROM settings WHERE key='purge_hollow_rep_incentive_v446'").run();
  const purged = purgeHollowPartyLedgerReversals(db);
  ok(Number(purged.repDeleted) >= 2, 'purge deletes hollow incentive rows', purged);
  const afterDead = db.prepare(`
    SELECT COUNT(*) c FROM rep_ledger
    WHERE ref_id=? AND ref_type IN ('incentive_payment','incentive_payment_reversal')
  `).get(deadPay);
  ok(Number(afterDead.c) === 0, 'dead twin gone from DB', afterDead);
  const afterLive = db.prepare(`
    SELECT COUNT(*) c FROM rep_ledger WHERE ref_id=? AND entry_type='commission_paid'
  `).get(livePay);
  ok(Number(afterLive.c) === 1, 'live payment kept', afterLive);

  try { closeDB(); } catch (_) { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
