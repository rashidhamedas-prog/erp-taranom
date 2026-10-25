const { swAtLeast } = require('./lib/sw-at-least');
/**
 * v448 — ADR-PARTY-001 §13: person turnover ≠ incentive ledger.
 * No display-only rows; no half-merge; linked_rep for UI only.
 * Run: node server/scripts/test-party-rep-separation-v448.js
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

console.log('\n— 0 static contracts —');
const pt = fs.readFileSync(path.join(__dirname, '../lib/party-turnover.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const adr = fs.readFileSync(path.join(__dirname, '../../docs/architecture/PARTY-ACC-ADR-001.md'), 'utf8');

ok(!/FROM rep_ledger WHERE rep_id=\? ORDER BY date/.test(pt)
  || pt.includes('do NOT merge rep_ledger'),
  'person turnover does not merge rep_ledger rows');
ok(pt.includes('linked_rep_id') && pt.includes('has_incentive_ledger'),
  'API exposes linked_rep for UI');
ok(!pt.includes("align_ignore_sources: ['rep_ledger']"),
  'no v447 ignore-sources half-merge');
ok(app.includes('has_incentive_ledger') && app.includes('loadRepDetail'),
  'UI links to rep statement');
ok(swAtLeast(sw, 449), 'SW v449');
ok(adr.includes('Amendment v448') && adr.includes('Two books'),
  'ADR-PARTY-001 §13 recorded');

let db = null;
let closeDB = null;
let dir = null;
try {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'party-rep-v448-'));
  process.env.DB_PATH = path.join(dir, 't.db');
  process.env.SYNC_ROLE = 'central';
  process.env.JWT_SECRET = 'test-party-rep-v448-secret-32chars!!!!';
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
  const { buildRepStatement, hideVoidedRepLedgerRows } = (() => {
    const rl = require('../lib/rep-ledger');
    const retire = require('../lib/party-ledger-retire');
    return { buildRepStatement: rl.buildRepStatement, hideVoidedRepLedgerRows: retire.hideVoidedRepLedgerRows };
  })();

  const opening = 65848074;
  const partyId = db.prepare(`
    INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, is_active, opening_balance)
    VALUES ('P-V448','other','["other"]','عارف تست ۴۴۸','09121110448',1,?)
  `).run(opening).lastInsertRowid;
  const personId = db.prepare(`
    INSERT INTO persons (name, phone, party_id, active)
    VALUES ('عارف تست ۴۴۸','09121110448',?,1)
  `).run(partyId).lastInsertRowid;
  db.prepare(`
    INSERT INTO person_ledger (person_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id)
    VALUES (?, '1405/06/31', 'opening', 'opening_balance', ?, 'مانده اول دوره', 0, ?, 1)
  `).run(personId, partyId, opening);
  const userId = db.prepare(`
    INSERT INTO users (username, password, name, role, active, party_id)
    VALUES ('aref448','x','عارف تست ۴۴۸','field_sales',1,?)
  `).run(partyId).lastInsertRowid;

  const amts = [100000000, 2000000, 5000000, 25000000];
  for (const amt of amts) {
    db.prepare(`
      INSERT INTO incentive_payments (rep_id, amount, pay_type, date, note, created_by, status)
      VALUES (?, ?, 'cash', '1405/07/12', 'live', 1, 'posted')
    `).run(userId, amt);
    const payId = db.prepare('SELECT last_insert_rowid() id').get().id;
    db.prepare(`
      INSERT INTO rep_ledger (rep_id, date, entry_type, ref_type, ref_id, description, debit, credit, created_by)
      VALUES (?, '1405/07/12', 'commission_paid', 'incentive_payment', ?, 'پرداخت انگیزه فروش', ?, 0, 1)
    `).run(userId, payId, amt);
  }

  console.log('\n— 1 person turnover = books only —');
  const turn = buildPartyTurnover(db, partyId);
  ok(!!turn, 'turnover built');
  ok(!(turn.entries || []).some((e) => e.source === 'rep_ledger'),
    'no incentive rows on person turnover');
  ok(!(turn.entries || []).some((e) => String(e.description || '').includes('تطبیق با دفتر زنده')),
    'no synthetic reconcile');
  ok(Math.round(Number(turn.closing)) === -opening, 'closing = books opening', turn.closing);
  ok(Math.round(Number(turn.totalDebit || 0)) === 0, 'totalDebit matches table (0)', turn.totalDebit);
  ok(Math.round(Number(turn.totalCredit || 0)) === opening, 'totalCredit = opening', turn.totalCredit);
  ok(Number(turn.linked_rep_id) === Number(userId) && turn.has_incentive_ledger === true,
    'linked_rep metadata', turn);

  console.log('\n— 2 rep statement still has incentives —');
  const stmt = buildRepStatement(db, userId);
  const pays = (stmt.entries || []).filter((e) => e.type === 'payment');
  ok(pays.length === 4, 'rep statement has 4 live payments', pays.length);
  const paidSum = pays.reduce((s, e) => s + (Number(e.debit) || 0), 0);
  ok(paidSum === 132000000, 'rep payments sum 132M', paidSum);
  ok(Math.round(Number(stmt.paid)) === 132000000, 'view.paid = 132M', stmt.paid);

  const hidden = hideVoidedRepLedgerRows(db, db.prepare('SELECT * FROM rep_ledger WHERE rep_id=?').all(userId));
  ok(hidden.length === 4, 'hideVoided keeps live commissions', hidden.length);

  try { closeDB(); } catch (_) { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
