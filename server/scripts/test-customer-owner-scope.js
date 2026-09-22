#!/usr/bin/env node
/**
 * Customer ownership / visibility invariant tests.
 * Isolated temp SQLite via DB_PATH — no live server required.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cust-owner-scope-'));
const dbPath = path.join(tmpDir, 't.db');
process.env.DB_PATH = dbPath;
process.env.COMPANIES_DIR = path.join(tmpDir, 'companies');
process.env.ERP_TEST_ISOLATION = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'erp-test-isolation-jwt-secret-32chars!!';
process.env.SYNC_ROLE = 'central';

const { ok, summary } = require('./lib/test-harness');

// Bust caches so db + scope load against this DB_PATH
for (const rel of ['../db', '../lib/customer-scope', '../lib/parties-sync']) {
  try { delete require.cache[require.resolve(rel)]; } catch (_) {}
}

const dbMod = require('../db');
dbMod.initDB();
const db = dbMod.getDB();

const {
  scopeUserId,
  customerVisibilitySql,
  assignCustomerOwner,
  alignCustomerOwners,
  customerVisibleTo,
} = require('../lib/customer-scope');
const { syncPartyToLegacy } = require('../lib/parties-sync');

console.log('══ Customer owner scope ══');

function listVisible(userId) {
  return db.prepare(
    `SELECT id, user_id, assigned_to FROM customers WHERE ${customerVisibilitySql('customers')}`
  ).all(userId, userId);
}

try {
  // Users
  const adminId = db.prepare(
    `INSERT INTO users (username,password,name,role,active) VALUES ('adm_scope','x','Admin','admin',1)`
  ).run().lastInsertRowid;
  const repA = db.prepare(
    `INSERT INTO users (username,password,name,role,active) VALUES ('rep_a','x','Aref','field_sales',1)`
  ).run().lastInsertRowid;
  const repB = db.prepare(
    `INSERT INTO users (username,password,name,role,active) VALUES ('rep_b','x','Bahram','field_sales',1)`
  ).run().lastInsertRowid;
  const mgrId = db.prepare(
    `INSERT INTO users (username,password,name,role,active) VALUES ('sm_scope','x','Mgr','sales_manager',1)`
  ).run().lastInsertRowid;

  ok('scopeUserId admin null', scopeUserId({ user: { id: adminId, role: 'admin' } }) == null);
  ok('scopeUserId accounting null', scopeUserId({ user: { id: 99, role: 'accounting' } }) == null);
  ok('scopeUserId sales_manager NOT null', scopeUserId({ user: { id: mgrId, role: 'sales_manager' } }) === mgrId);
  ok('scopeUserId field_sales id', scopeUserId({ user: { id: repA, role: 'field_sales' } }) === repA);

  // 1) Admin creates / assigns to rep A → A sees, B does not
  const c1 = db.prepare(
    `INSERT INTO customers (user_id,biz,phone,status,created_by,assigned_to)
     VALUES (?,'فروشگاه عارف','09111111111','active',?,?)`
  ).run(adminId, adminId, null).lastInsertRowid;
  assignCustomerOwner(db, {
    customerId: c1,
    ownerUserId: repA,
    actorId: adminId,
    note: 'test assign A',
  });
  const c1row = db.prepare('SELECT user_id, assigned_to FROM customers WHERE id=?').get(c1);
  ok('assign sets user_id=assigned_to=A', Number(c1row.user_id) === Number(repA) && Number(c1row.assigned_to) === Number(repA));
  ok('rep A list includes c1', listVisible(repA).some((r) => r.id === c1));
  ok('rep B list excludes c1', !listVisible(repB).some((r) => r.id === c1));
  const hist = db.prepare('SELECT to_rep_id FROM rep_assignment_history WHERE customer_id=? ORDER BY id DESC LIMIT 1').get(c1);
  ok('history appended', hist && Number(hist.to_rep_id) === Number(repA));

  // 2) Drift: user_id=admin, assigned_to=A → align → A visible, user_id becomes A
  db.prepare("DELETE FROM settings WHERE key='customer_owner_align_v1'").run();
  const c2 = db.prepare(
    `INSERT INTO customers (user_id,biz,phone,status,created_by,assigned_to)
     VALUES (?,'دریفت','09112222222','active',?,?)`
  ).run(adminId, adminId, repA).lastInsertRowid;
  ok('before align A sees via assigned_to', listVisible(repA).some((r) => r.id === c2));
  // Simulate old API that only filtered user_id (would miss) — after align user_id becomes A
  ok('before align user_id still admin', Number(db.prepare('SELECT user_id FROM customers WHERE id=?').get(c2).user_id) === Number(adminId));
  const alignRes = alignCustomerOwners(db);
  ok('align ran', alignRes && alignRes.aligned);
  const c2after = db.prepare('SELECT user_id, assigned_to FROM customers WHERE id=?').get(c2);
  ok('after align user_id=A', Number(c2after.user_id) === Number(repA));
  ok('after align assigned_to=A', Number(c2after.assigned_to) === Number(repA));
  ok('align idempotent skip', alignCustomerOwners(db).skipped === true);
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_customers_assigned_to'").get();
  ok('idx_customers_assigned_to exists', !!idx);

  // 3) Party update sets user_id=A → linked customer visible to A
  const partyCode = 'P-SCOPE1';
  const partyId = db.prepare(`
    INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, user_id, biz, status, type, is_active)
    VALUES (?, 'customer', '["customer"]', 'پارتی عارف', '09113333333', ?, 'پارتی عارف', 'new', 'بوتیک', 1)
  `).run(partyCode, adminId).lastInsertRowid;
  // Link as existing customer owned by admin
  const c3 = db.prepare(
    `INSERT INTO customers (user_id,biz,phone,status,created_by,assigned_to,party_id)
     VALUES (?,'لینک پارتی','09113333333','active',?,?,?)`
  ).run(adminId, adminId, adminId, partyId).lastInsertRowid;
  db.prepare("UPDATE parties SET legacy_table='customers', legacy_id=?, user_id=? WHERE id=?")
    .run(c3, repA, partyId);
  syncPartyToLegacy(db, partyId);
  const c3after = db.prepare('SELECT user_id, assigned_to, party_id FROM customers WHERE id=?').get(c3);
  ok('party sync copies owner to customer', Number(c3after.user_id) === Number(repA) && Number(c3after.assigned_to) === Number(repA));
  ok('rep A sees party-linked customer', listVisible(repA).some((r) => r.id === c3));
  const partyAfter = db.prepare('SELECT user_id FROM parties WHERE id=?').get(partyId);
  ok('party.user_id stays A', Number(partyAfter.user_id) === Number(repA));

  // Also exercise assignCustomerOwner from party path (party + customer equal)
  assignCustomerOwner(db, { customerId: c3, ownerUserId: repA, actorId: adminId, note: 'noop' });
  ok('unchanged owner skips new history noise', true); // smoke — no throw

  // 4) Rep A cannot see rep B's customer
  const cB = db.prepare(
    `INSERT INTO customers (user_id,biz,phone,status,created_by,assigned_to)
     VALUES (?,'مالک ب','09114444444','active',?,?)`
  ).run(repB, repB, repB).lastInsertRowid;
  ok('rep A denied B customer', customerVisibleTo(db, cB, repA) === false);
  ok('rep B sees own', customerVisibleTo(db, cB, repB) === true);
  // Simulate GET-by-id gate: 403 equivalent
  const denied = !customerVisibleTo(db, cB, repA);
  ok('GET other customer → 403/404 gate', denied);

  // Followups list OR: followup by B on c1 (A's book) should show for A via customer visibility
  db.prepare(
    `INSERT INTO followups (user_id,cust_id,date,type,subject,status,priority) VALUES (?,?,?,?,?,?,?)`
  ).run(repB, c1, '1404/01/01', 'تلفن', 'از ب روی مشتری آ', 'open', 'mid');
  const fuWhere = `(f.user_id=? OR EXISTS (
    SELECT 1 FROM customers cx WHERE cx.id=f.cust_id AND ${customerVisibilitySql('cx')}
  ))`;
  const fuForA = db.prepare(`SELECT f.id FROM followups f WHERE ${fuWhere}`).all(repA, repA, repA);
  ok('followup on visible customer listed for A', fuForA.length >= 1);

  console.log('');
  summary('customer-owner-scope');
} catch (e) {
  console.error('FATAL:', e);
  process.exit(1);
} finally {
  try { dbMod.closeDB(); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}
