/**
 * v455: party with customer role must get a CRM customers row even when
 * party_group.entity_type = 'person' (پرسنل). Dual-role must not copy AP onto customers.
 * Run: node server/scripts/test-customer-role-projection-v455.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cust-role-v455-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-customer-role-projection-v455-secret!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra != null ? JSON.stringify(extra) : ''); }
}

(async () => {
  const { syncPartyToLegacy, healCustomerRoleProjectionsV455, safeCustomerCoaMirror } = require('../lib/parties-sync');
  const { ensureDualRoleSeparateLeaves, codeUnderKind } = require('../lib/party-tafsili');
  const { allocTafsili } = require('../lib/coa-map');

  // Personnel group (entity_type=person) — historically blocked CRM customer projection.
  let groupId = db.prepare("SELECT id FROM party_groups WHERE entity_type='person' LIMIT 1").get()?.id;
  if (!groupId) {
    groupId = db.prepare(`
      INSERT INTO party_groups (code, name, entity_type, description)
      VALUES (9455, 'پرسنل تست v455', 'person', '')
    `).run().lastInsertRowid;
  }

  const apLeaf = allocTafsili(db, 'supplier', 'ابراهیمی AP تست');
  ok(!!apLeaf && codeUnderKind(db, apLeaf, 'supplier'), 'AP leaf allocated', { apLeaf });

  const partyId = db.prepare(`
    INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, is_active, party_group_id, coa_code, opening_balance)
    VALUES ('P-V455','both','["customer","supplier","employee"]','مهدیه ابراهیمی تست','09360887707',1,?,?,40396000)
  `).run(groupId, apLeaf).lastInsertRowid;

  // Supplier-first legacy (like live party 136).
  const supId = db.prepare(`
    INSERT INTO suppliers (name, phone, party_id, party_group_id, coa_code)
    VALUES ('مهدیه ابراهیمی تست', '09360887707', ?, ?, ?)
  `).run(partyId, groupId, apLeaf).lastInsertRowid;
  db.prepare("UPDATE parties SET legacy_table='suppliers', legacy_id=? WHERE id=?").run(supId, partyId);

  ok(!db.prepare('SELECT id FROM customers WHERE party_id=?').get(partyId), 'no customer before sync');

  // Old gate would skip; new rule must create.
  syncPartyToLegacy(db, partyId);
  const cust = db.prepare('SELECT * FROM customers WHERE party_id=?').get(partyId);
  ok(!!cust, 'customer row created despite پرسنل group', { partyId });
  ok(cust && (!cust.coa_code || !String(cust.coa_code).trim() || codeUnderKind(db, cust.coa_code, 'customer')),
    'customer coa is empty or AR (not AP copy)', { coa: cust?.coa_code, apLeaf });

  ensureDualRoleSeparateLeaves(db, partyId);
  const cust2 = db.prepare('SELECT coa_code FROM customers WHERE party_id=?').get(partyId);
  const sup2 = db.prepare('SELECT coa_code FROM suppliers WHERE id=?').get(supId);
  ok(!!cust2?.coa_code && codeUnderKind(db, cust2.coa_code, 'customer'), 'dual customer AR leaf', { ar: cust2?.coa_code });
  ok(!!sup2?.coa_code && codeUnderKind(db, sup2.coa_code, 'supplier'), 'dual supplier AP leaf', { ap: sup2?.coa_code });
  ok(String(cust2.coa_code) !== String(sup2.coa_code), 'AR ≠ AP after dual fix');

  ok(safeCustomerCoaMirror(db, { coa_code: apLeaf }, true) === '', 'safeCustomerCoaMirror rejects AP');
  const arLeaf = allocTafsili(db, 'customer', 'AR mirror');
  ok(safeCustomerCoaMirror(db, { coa_code: arLeaf }, true) === arLeaf, 'safeCustomerCoaMirror accepts AR');

  // Heal: second personnel-group party without customer → sync via heal (flag cleared).
  db.prepare("DELETE FROM settings WHERE key='customer_role_projection_v455'").run();
  const orphanParty = db.prepare(`
    INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, is_active, party_group_id)
    VALUES ('P-V455B','customer','["customer","employee"]','پرسنل مشتری یتیم','09121112233',1,?)
  `).run(groupId).lastInsertRowid;
  ok(!db.prepare('SELECT id FROM customers WHERE party_id=?').get(orphanParty), 'orphan has no customer');
  const heal = healCustomerRoleProjectionsV455(db);
  ok(!heal.skipped && heal.synced >= 1, 'heal synced orphan projections', heal);
  ok(!!db.prepare('SELECT id FROM customers WHERE party_id=?').get(orphanParty), 'orphan got customer via heal');
  const heal2 = healCustomerRoleProjectionsV455(db);
  ok(heal2.skipped === true, 'heal idempotent');

  // ensureCustomerTafsili rejects AP stuck on customer.
  const partyBad = db.prepare(`
    INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, is_active, coa_code)
    VALUES ('P-V455C','customer','["customer"]','مشتری با AP اشتباه','09123334455',1,?)
  `).run(apLeaf).lastInsertRowid;
  const badCust = db.prepare(`
    INSERT INTO customers (user_id,biz,owner,phone,type,status,balance,party_id,coa_code)
    VALUES (1,'AP روی مشتری','مالک','09123334455','بوتیک','active',0,?,?)
  `).run(partyBad, apLeaf).lastInsertRowid;
  const { ensureCustomerTafsili } = require('../lib/party-tafsili');
  const fixed = ensureCustomerTafsili(db, badCust);
  ok(!!fixed && codeUnderKind(db, fixed, 'customer') && fixed !== apLeaf, 'ensureCustomerTafsili replaces AP', { fixed, apLeaf });

  console.log(`\ncustomer-role-projection-v455: ${pass} pass, ${fail} fail`);
  try { closeDB(); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
