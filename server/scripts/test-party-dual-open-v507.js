/**
 * SW v507 — dual-role party opening mirrors once (control leaf only).
 * Run: node server/scripts/test-party-dual-open-v507.js
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-jwt-secret-party-dual-open-v507-dummy-key-32xx';

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  OK', msg); }
  else { failed++; console.log('  FAIL', msg, detail != null ? detail : ''); }
}

console.log('\n══ party dual-open opening v507 ══\n');

const openSrc = fs.readFileSync(path.join(__dirname, '../lib/opening-post.js'), 'utf8');
const turnSrc = fs.readFileSync(path.join(__dirname, '../lib/party-turnover.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const idxSrc = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

ok(openSrc.includes('partyOpeningMirrorTargets'), 'partyOpeningMirrorTargets');
ok(openSrc.includes('retireDuplicateRoleOpeningMirrors'), 'retireDuplicateRoleOpeningMirrors');
ok(openSrc.includes('clearPartyOpeningSubledgers(db, partyId)'), 'mirror clears all then rewrites leaf');
ok(/targets\.customer[\s\S]*targets\.supplier/.test(openSrc), 'mirror gated by targets');
ok(dbSrc.includes('retireDuplicateRoleOpeningMirrors'), 'boot wires dual-open retire');
ok(dbSrc.includes('party_dual_open_retire_v507'), 'boot logs v507 heal');
ok(turnSrc.includes("description: desc") && turnSrc.includes("'مانده اول دوره'"), 'turnover plain opening label');
ok(/erp-taranom-v507/.test(swSrc), 'SW v507');
ok(/app\.js\?v=507/.test(idxSrc), 'index cache bust v507');
ok(appJs.includes('v507') && appJs.includes('همان برگ کنترل'), 'Help v507 present');

let Database;
try {
  Database = require('better-sqlite3');
  const probe = new Database(':memory:');
  probe.close();
} catch (e) {
  console.log('\nSKIP SQLite ABI — static checks only:', e.message);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const { freshDb } = (() => {
  try { return require('./lib/test-harness'); }
  catch (_) { return { freshDb: null }; }
})();

if (!freshDb) {
  console.log('\nSKIP freshDb harness');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const { db, cleanup } = freshDb();
const {
  partyOpeningMirrorTargets,
  mirrorPartyOpeningSubledgers,
  retireDuplicateRoleOpeningMirrors,
  upsertPartyOpening,
} = require('../lib/opening-post');
const { buildPartyTurnover } = require('../lib/party-turnover');
const { partySignedBalanceDetailMap, partyBooksMismatch } = require('../lib/party-books');

const coaPerson = '110601009507';
const coaCust = '110301009507';
const coaSup = '210101009507';

for (const [code, name, type] of [
  [coaPerson, 'شخص v507', 'asset'],
  [coaCust, 'مشتری v507', 'asset'],
  [coaSup, 'تأمین v507', 'liability'],
]) {
  try {
    db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,level) VALUES (?,?,?,?)')
      .run(code, name, type, 4);
  } catch (_) {
    try {
      db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type) VALUES (?,?,?)')
        .run(code, name, type);
    } catch (__) { /* */ }
  }
}

try {
  db.prepare(`
    INSERT OR IGNORE INTO fiscal_years (name, start_date, end_date, is_active)
    VALUES ('FY507','1405/01/01','1405/12/29',1)
  `).run();
} catch (_) { /* optional schema */ }

const partyId = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, coa_code, opening_balance, is_active)
  VALUES ('P-D507','other','["customer","supplier","employee"]','تست دوگانه v507','09120005007',?, -40396000, 1)
`).run(coaPerson).lastInsertRowid;

const custId = db.prepare(`
  INSERT INTO customers (biz, phone, coa_code, party_id, balance) VALUES ('تست دوگانه v507','09120005007',?,?,0)
`).run(coaCust, partyId).lastInsertRowid;

const supId = db.prepare(`
  INSERT INTO suppliers (name, phone, coa_code, party_id, balance) VALUES ('تست دوگانه v507','09120005007',?,?,0)
`).run(coaSup, partyId).lastInsertRowid;

db.prepare(`
  INSERT INTO persons (name, phone, active, party_id, coa_code) VALUES ('تست دوگانه v507','09120005007',1,?,?)
`).run(partyId, coaPerson);

const party = db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
const targets = partyOpeningMirrorTargets(db, party);
ok(targets.person === true && !targets.customer && !targets.supplier,
  'targets = person leaf only', targets);

// Simulate legacy buggy dual mirror (cust+sup same abs amount, no person mirror).
const openDate = '1405/01/01';
const amt = 40396000;
db.prepare(`
  INSERT INTO customer_ledger
    (customer_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
  VALUES (?,?,?,?,?,?,?,?,?)
`).run(custId, openDate, 'opening', 'opening', 1, 'مانده اولیه حساب', 0, amt, 1);
db.prepare(`
  INSERT INTO supplier_ledger
    (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
  VALUES (?,?,?,?,?,?,?,?,?)
`).run(supId, openDate, 'opening', 'opening_balance', 1, 'مانده اول دوره', 0, amt, 1);

const dry = retireDuplicateRoleOpeningMirrors(db, { apply: false, partyId });
ok(dry.candidates >= 1, 'heal dry-run finds dual open', dry);

const applied = retireDuplicateRoleOpeningMirrors(db, { apply: true, partyId });
ok(applied.retired >= 1, 'heal apply retires dual open', applied);

const custOpen = db.prepare(`
  SELECT COALESCE(SUM(ABS(debit)+ABS(credit)),0) a FROM customer_ledger
  WHERE customer_id=? AND LOWER(IFNULL(ref_type,'')) IN ('opening','opening_balance')
`).get(custId).a;
const supOpen = db.prepare(`
  SELECT COALESCE(SUM(ABS(debit)+ABS(credit)),0) a FROM supplier_ledger
  WHERE supplier_id=? AND LOWER(IFNULL(ref_type,'')) IN ('opening','opening_balance')
`).get(supId).a;
ok(Number(custOpen) === 0 && Number(supOpen) === 0, 'both role openings purged for person leaf', {
  custOpen, supOpen,
});

// Fresh upsert mirrors only person leaf
try {
  upsertPartyOpening(db, partyId, -40396000, 1);
} catch (e) {
  ok(false, 'upsertPartyOpening', e.message);
}

const afterCust = db.prepare(`
  SELECT COUNT(*) n FROM customer_ledger
  WHERE customer_id=? AND LOWER(IFNULL(ref_type,'')) IN ('opening','opening_balance')
`).get(custId).n;
const afterSup = db.prepare(`
  SELECT COUNT(*) n FROM supplier_ledger
  WHERE supplier_id=? AND LOWER(IFNULL(ref_type,'')) IN ('opening','opening_balance')
`).get(supId).n;
const afterPe = db.prepare(`
  SELECT COUNT(*) n FROM person_ledger
  WHERE person_id IN (SELECT id FROM persons WHERE party_id=?)
    AND LOWER(IFNULL(ref_type,'')) IN ('opening','opening_balance')
`).get(partyId).n;
ok(Number(afterCust) === 0 && Number(afterSup) === 0, 'upsert does not dual-mirror AR+AP', {
  afterCust, afterSup,
});
ok(Number(afterPe) >= 1, 'upsert mirrors person leaf', afterPe);

const turn = buildPartyTurnover(db, partyId);
const openRows = (turn && turn.entries || []).filter((e) =>
  /مانده\s*اول\s*دوره/.test(String(e.description || ''))
    || String(e.ref_type || '').includes('opening')
    || e.source === 'opening_fold'
);
const openCredit = openRows.reduce((s, e) => s + (Number(e.credit) || 0), 0);
ok(openRows.length <= 2, 'turnover opening rows not exploded', { n: openRows.length, openRows });
ok(Math.abs(openCredit - amt) <= 2 || openRows.length === 0, 'opening credit ≈ 1× header (not 2×)', {
  openCredit, openRows,
});
ok(
  !(turn && turn.entries || []).some((e) => String(e.description || '').includes('تطبیق با دفتر زنده')),
  'no «تطبیق با دفتر زنده» label on healthy fold'
);

const detail = partySignedBalanceDetailMap(db).get(Number(partyId));
ok(partyBooksMismatch(db, detail) !== true, 'no books mismatch after heal', detail);

try { cleanup(); } catch (_) { /* */ }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
