'use strict';
/**
 * Party opening JE must not be voided when another party's customer.id
 * equals this party's id (production: party 26 تجری vs customer 26 افروز).
 * Run: node server/scripts/test-opening-id-collision-v436.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-id-collision-v436-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-open-id-collision-v436-secret!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.NODE_ENV = 'test';
process.env.ERP_TEST_ISOLATION = '1';

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

const AMT_A = 5895000;
const AMT_B = 1000000;
let pass = 0;
function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log('  OK', label);
  } else {
    console.error(' FAIL', label, extra != null ? JSON.stringify(extra) : '');
    try { closeDB(); } catch (_) { /* */ }
    process.exit(1);
  }
}

const {
  upsertPartyOpening,
  livePartyOpeningJeId,
  collectPartyOpeningJournalIds,
  repairStaleCustomerOpeningMirrors,
  deleteCustomerOpeningMirrors,
} = require('../lib/opening-post');
const { canonicalCustomerFold, glCustomersTafsiliBalance } = require('../lib/customer-books');

(async () => {
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  ok(!!admin, 'admin exists');

  // Force party id = 26 (تجری shape) and customer id = 26 on a different party (افروز shape)
  db.prepare(`
    INSERT INTO parties (id, person_code, party_type, full_name, phone, party_roles, opening_balance)
    VALUES (26, 'P26', 'customer', 'تجری تست v436', '09120000026', '["customer"]', 0)
  `).run();
  db.prepare(`
    INSERT INTO parties (id, person_code, party_type, full_name, phone, party_roles, opening_balance)
    VALUES (69, 'P69', 'customer', 'افروز تست v436', '09120000069', '["customer"]', 0)
  `).run();

  // Customer for تجری (party 26) — any id ≠ 26
  db.prepare(`
    INSERT INTO customers (id, user_id, biz, phone, status, party_id, balance)
    VALUES (51, ?, 'تجری تست v436', '09120000026', 'active', 26, 0)
  `).run(admin.id);
  // Customer id = 26 linked to افروز (party 69) — the collision key
  db.prepare(`
    INSERT INTO customers (id, user_id, biz, phone, status, party_id, balance)
    VALUES (26, ?, 'افروز تست v436', '09120000069', 'active', 69, 0)
  `).run(admin.id);

  try {
    const { ensureCustomerTafsili } = require('../lib/party-tafsili');
    ensureCustomerTafsili(db, 51);
    ensureCustomerTafsili(db, 26);
  } catch (e) {
    ok(false, 'ensureCustomerTafsili', e.message);
  }
  const cA = db.prepare('SELECT id, coa_code, party_id FROM customers WHERE id=51').get();
  const cB = db.prepare('SELECT id, coa_code, party_id FROM customers WHERE id=26').get();
  ok(!!cA.coa_code && !!cB.coa_code, 'both customers have tafsili', { cA, cB });

  const jeA = upsertPartyOpening(db, 26, AMT_A, admin.id);
  ok(!!jeA, 'party 26 opening JE created', jeA);
  const liveA1 = livePartyOpeningJeId(db, 26);
  ok(Number(liveA1) === Number(jeA), 'live opening for party 26', { liveA1, jeA });

  const partyB = db.prepare('SELECT * FROM parties WHERE id=69').get();
  const collectedB = collectPartyOpeningJournalIds(db, partyB);
  ok(!collectedB.includes(Number(jeA)), 'افروز collect must NOT include تجری JE', {
    collectedB, jeA,
  });

  const jeB = upsertPartyOpening(db, 69, AMT_B, admin.id);
  ok(!!jeB, 'party 69 opening JE created', jeB);
  const liveA2 = livePartyOpeningJeId(db, 26);
  const jeArow = db.prepare('SELECT id, status, deleted_at, total_debit_rial FROM journal_entries WHERE id=?').get(jeA);
  ok(Number(liveA2) === Number(jeA), 'party 26 JE still live after افروز upsert', { liveA2, jeA });
  ok(jeArow && String(jeArow.status) !== 'reversed' && !(Number(jeArow.deleted_at) > 0),
    'party 26 JE not soft-voided', jeArow);
  ok(Number(jeArow.total_debit_rial) === AMT_A, 'party 26 amount intact', jeArow);

  // Simulate pre-fix damage: void تجری JE, leave party.opening_balance + books row
  const { reverseJournalEntry } = require('../lib/void-journal');
  reverseJournalEntry(db, jeA, {
    userId: admin.id,
    reason: 'جمع شدن سند تکراری مانده اول دوره — افروز تست v436',
    sourceType: 'opening_balance_reversal',
  });
  db.prepare('UPDATE parties SET opening_balance=? WHERE id=26').run(AMT_A);
  deleteCustomerOpeningMirrors(db, 51);
  db.prepare(`
    INSERT INTO customer_ledger
      (customer_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(51, '1405/06/31', 'opening', 'opening_balance', 26, 'مانده اول دوره — تجری تست v436', AMT_A, 0, admin.id);

  ok(!livePartyOpeningJeId(db, 26), 'JE voided before heal');
  const partyClaim = db.prepare('SELECT opening_balance FROM parties WHERE id=26').get();
  ok(Number(partyClaim.opening_balance) === AMT_A, 'party still claims opening amt', partyClaim);
  const orphanBooks = db.prepare(`
    SELECT id, debit FROM customer_ledger
    WHERE customer_id=51 AND LOWER(COALESCE(ref_type,'')) IN ('opening','opening_balance')
  `).all();
  ok(orphanBooks.length >= 1 && Number(orphanBooks[0].debit) === AMT_A,
    'orphan books opening row present', orphanBooks);

  const heal1 = repairStaleCustomerOpeningMirrors(db);
  ok(Number(heal1.restored) >= 1, 'heal restores voided opening', heal1);
  const liveAfter = livePartyOpeningJeId(db, 26);
  ok(!!liveAfter, 'live JE after heal', liveAfter);
  const jeRestored = db.prepare('SELECT total_debit_rial, status, deleted_at FROM journal_entries WHERE id=?').get(liveAfter);
  ok(Number(jeRestored.total_debit_rial) === AMT_A, 'restored amount', jeRestored);

  const foldAfter = canonicalCustomerFold(db);
  const glAfter = glCustomersTafsiliBalance(db);
  ok(Math.abs(Number(foldAfter.display) - Number(glAfter.display)) <= 1,
    'dashboard AR delta <= 1 after heal', { foldAfter, glAfter });

  const heal2 = repairStaleCustomerOpeningMirrors(db);
  ok(Number(heal2.restored || 0) === 0 && Number(heal2.removed || 0) === 0,
    'second heal is no-op', heal2);

  // Source guard
  const src = fs.readFileSync(path.join(__dirname, '../lib/opening-post.js'), 'utf8');
  ok(/never mix party\.id and customer\.id/.test(src), 'collision comment present');
  ok(/ref_type IN \('opening_balance','opening_reclass'\)/.test(src), 'party-scoped opening_balance query');
  ok(/ref_type IN \('opening','opening_ledger'\)/.test(src), 'customer-scoped opening_ledger query');
  const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  ok(/erp-taranom-v436/.test(sw), 'SW v436');

  try { closeDB(); } catch (_) { /* */ }
  console.log(`\nPASS ${pass} assertions — opening id collision v436`);
})().catch((e) => {
  console.error(e);
  try { closeDB(); } catch (_) { /* */ }
  process.exit(1);
});
