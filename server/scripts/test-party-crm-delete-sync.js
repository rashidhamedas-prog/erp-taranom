/**
 * Verifies Accounting party soft-delete cascades to CRM customers + followups,
 * and CRM customer delete soft-deletes the linked party.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-party-sync-'));
const dbPath = path.join(tmpDir, 'test.db');
process.env.DB_PATH = dbPath;

const { getDB, initDB } = require('../db');
const {
  syncPartyToLegacy,
  deactivatePartyCascade,
  deactivatePartyFromCustomer,
  CRM_CUSTOMER_ACTIVE_SQL,
} = require('../lib/parties-sync');

initDB();
const db = getDB();

function count(sql, ...args) {
  return db.prepare(sql).get(...args).c;
}

// Seed a customer-type party → dual-write creates CRM customer
const partyIns = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, city, biz, owner, is_active, user_id)
  VALUES ('P-99901','customer','["customer"]','علی تست','09120000001','تهران','فروشگاه تست','علی تست',1,1)
`).run();
const partyId = partyIns.lastInsertRowid;
syncPartyToLegacy(db, partyId);

const cust = db.prepare('SELECT * FROM customers WHERE party_id=?').get(partyId);
assert.ok(cust, 'CRM customer created from party');
db.prepare(`
  INSERT INTO followups (user_id,cust_id,date,type,subject,status) VALUES (1,?,?,?,?,?)
`).run(cust.id, '1405/01/01', 'تماس', 'پیگیری تست', 'open');
assert.strictEqual(count('SELECT COUNT(*) c FROM followups WHERE cust_id=?', cust.id), 1);

// --- Accounting delete must remove CRM customer + followups ---
const casc = db.transaction(() => deactivatePartyCascade(db, partyId))();
assert.ok(casc.ok, 'cascade ok');
assert.strictEqual(db.prepare('SELECT is_active FROM parties WHERE id=?').get(partyId).is_active, 0);
assert.strictEqual(count('SELECT COUNT(*) c FROM customers WHERE id=?', cust.id), 0, 'CRM customer deleted');
assert.strictEqual(count('SELECT COUNT(*) c FROM followups WHERE cust_id=?', cust.id), 0, 'followups deleted');

// Active filter must hide inactive-party leftovers
const party2 = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, is_active, user_id, biz)
  VALUES ('P-99902','customer','["customer"]','ب تست','09120000002',0,1,'غیرفعال')
`).run().lastInsertRowid;
db.prepare(`INSERT INTO customers (user_id,biz,owner,phone,party_id,status) VALUES (1,'orphan','o','09',?, 'new')`).run(party2);
const visible = db.prepare(`SELECT COUNT(*) c FROM customers c WHERE ${CRM_CUSTOMER_ACTIVE_SQL}`).get().c;
assert.strictEqual(visible, 0, 'inactive-party customers hidden');

// CRM delete → soft-delete party
const party3 = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, is_active, user_id, biz, owner)
  VALUES ('P-99903','customer','["customer"]','ج تست','09120000003',1,1,'فروشگاه ج','ج')
`).run().lastInsertRowid;
syncPartyToLegacy(db, party3);
const cust3 = db.prepare('SELECT * FROM customers WHERE party_id=?').get(party3);
assert.ok(cust3);
const fromCrm = db.transaction(() => deactivatePartyFromCustomer(db, cust3.id))();
assert.ok(fromCrm.ok);
assert.strictEqual(count('SELECT COUNT(*) c FROM customers WHERE id=?', cust3.id), 0);
assert.strictEqual(db.prepare('SELECT is_active FROM parties WHERE id=?').get(party3).is_active, 0);

console.log('OK party↔CRM delete sync');
