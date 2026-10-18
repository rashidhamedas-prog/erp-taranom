/**
 * v447 — rep_ledger incentives on شخص گردش must NOT spawn fake «تطبیق با دفتر زنده».
 * Static always; sqlite runtime when ABI available (Iran).
 * Run: node server/scripts/test-rep-align-ignore-v447.js
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

console.log('\n— 0 static —');
const pt = fs.readFileSync(path.join(__dirname, '../lib/party-turnover.js'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(pt.includes("align_ignore_sources: ['rep_ledger']"), 'person path ignores rep_ledger in align');
ok(pt.includes('ignoreSources'), 'alignEntriesToTarget supports ignoreSources');
ok(pt.includes('balanceIgnoreSources') || pt.includes('recomputeRunning(out, ignoreSources)'),
  'running balance skips rep_ledger');
ok(sw.includes('erp-taranom-v447'), 'SW v447');
ok(app.includes('v447') && app.includes('تطبیق با دفتر زنده'), 'help mentions v447 reconcile policy');

let db = null;
let closeDB = null;
let dir = null;
try {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-align-v447-'));
  process.env.DB_PATH = path.join(dir, 't.db');
  process.env.SYNC_ROLE = 'central';
  process.env.JWT_SECRET = 'test-rep-align-v447-secret-32chars!!!!';
  process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
  delete require.cache[require.resolve('../db')];
  const dbMod = require('../db');
  dbMod.initDB();
  db = dbMod.getDB();
  closeDB = dbMod.closeDB;
} catch (e) {
  console.log('\n— SKIP_SQLITE —', String(e && e.message || e).slice(0, 80));
}

if (db) {
  const { buildPartyTurnover } = require('../lib/party-turnover');
  const opening = 65848074;
  const partyId = db.prepare(`
    INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, is_active, opening_balance)
    VALUES ('P-ARF447','other','["other"]','عارف تست ۴۴۷','09121110447',1,?)
  `).run(opening).lastInsertRowid;
  const personId = db.prepare(`
    INSERT INTO persons (name, phone, party_id, active)
    VALUES ('عارف تست ۴۴۷','09121110447',?,1)
  `).run(partyId).lastInsertRowid;
  db.prepare(`
    INSERT INTO person_ledger (person_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id)
    VALUES (?, '1405/06/31', 'opening', 'opening_balance', ?, 'مانده اول دوره - عارف تست ۴۴۷', 0, ?, 1)
  `).run(personId, partyId, opening);
  const userId = db.prepare(`
    INSERT INTO users (username, password, name, role, active, party_id)
    VALUES ('aref447','x','عارف تست ۴۴۷','field_sales',1,?)
  `).run(partyId).lastInsertRowid;
  const amts = [100000000, 2000000, 5000000, 25000000];
  for (let i = 0; i < amts.length; i += 1) {
    db.prepare(`
      INSERT INTO incentive_payments (rep_id, amount, pay_type, date, note, created_by, status)
      VALUES (?, ?, 'cash', '1405/07/12', 'live', 1, 'posted')
    `).run(userId, amts[i]);
    const payId = db.prepare('SELECT last_insert_rowid() id').get().id;
    db.prepare(`
      INSERT INTO rep_ledger (rep_id, date, entry_type, ref_type, ref_id, description, debit, credit, created_by)
      VALUES (?, '1405/07/12', 'commission_paid', 'incentive_payment', ?, 'پرداخت انگیزه فروش', ?, 0, 1)
    `).run(userId, payId, amts[i]);
  }

  console.log('\n— 1 no fake reconcile —');
  const turn = buildPartyTurnover(db, partyId);
  ok(!!turn, 'turnover built');
  const fold = (turn.entries || []).filter(
    (e) => e.source === 'opening_fold'
      || String(e.description || '').includes('تطبیق با دفتر زنده')
  );
  ok(fold.length === 0, 'no synthetic تطبیق row', fold);
  const inc = (turn.entries || []).filter((e) => e.source === 'rep_ledger');
  ok(inc.length === 4, 'incentive rows still visible', inc.length);
  // Signed: credit opening → negative creditor balance
  ok(Math.round(Number(turn.closing)) === -opening, 'closing = -opening (creditor)', turn.closing);
  ok(Math.round(Number(turn.totalDebit || 0)) === 0, 'books period debit excludes incentives', turn.totalDebit);
  ok(Math.round(Number(turn.totalCredit || 0)) === opening, 'books period credit = opening', turn.totalCredit);

  try { closeDB(); } catch (_) { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
