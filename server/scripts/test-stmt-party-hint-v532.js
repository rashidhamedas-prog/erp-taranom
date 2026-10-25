const { swAtLeast } = require('./lib/sw-at-least');
/**
 * v532 — customer statement party_hint for dual-role customer+employee.
 * Run: node server/scripts/test-stmt-party-hint-v532.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stmt-hint-v532-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-stmt-party-hint-v532-secret-32chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log('  OK', label);
  } else {
    fail++;
    console.log(' FAIL', label, extra != null ? JSON.stringify(extra) : '');
  }
}

const { allocTafsili } = require('../lib/coa-map');
const { customerPartyAltHint } = require('../lib/customer-books');

const leafCust = allocTafsili(db, 'customer', 'محبوبه تست دوگانه');
const leafPerson = allocTafsili(db, 'person', 'محبوبه تست شخص');

const partyId = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, coa_code, is_active, user_id, status, type)
  VALUES ('TST-532', 'customer', ?, 'محبوبه تست', '09120000532', ?, 1, 1, 'active', 'other')
`).run(JSON.stringify(['customer', 'employee']), leafCust).lastInsertRowid;

const custId = db.prepare(`
  INSERT INTO customers (user_id, biz, phone, status, coa_code, party_id)
  VALUES (1, 'محبوبه تست', '09120000532', 'active', ?, ?)
`).run(leafCust, partyId).lastInsertRowid;

const personId = db.prepare(`
  INSERT INTO persons (name, phone, coa_code, party_id, active)
  VALUES ('محبوبه تست', '09120000532', ?, ?, 1)
`).run(leafPerson, partyId).lastInsertRowid;

let hint = customerPartyAltHint(db, custId);
ok(!!hint, 'hint for dual-role party');
ok(hint && hint.party_id === Number(partyId), 'party_id matches');
ok(hint && hint.roles.includes('employee') && hint.roles.includes('customer'), 'roles customer+employee');
ok(hint && hint.has_person_activity === false, 'no activity yet → has_person_activity false');

db.prepare(`
  INSERT INTO person_ledger (person_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id, created_at, deleted_at)
  VALUES (?, '1405/06/31', 'payroll', 'payroll', 1, 'حقوق تست', 0, 1000, 1, strftime('%s','now'), 0)
`).run(personId);

hint = customerPartyAltHint(db, custId);
ok(hint && hint.has_person_activity === true, 'live person_ledger → has_person_activity');
ok(hint && hint.person_coa === leafPerson, 'person_coa');
ok(hint && hint.customer_coa === leafCust, 'customer_coa');
ok(hint && /گردش شخص|۱۱۰۶|حساب شخص/.test(hint.message || ''), 'message steers to person book');

const party2 = db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, coa_code, is_active, user_id, status, type)
  VALUES ('TST-532B', 'customer', '["customer"]', 'مشتری خالص', '09120000533', ?, 1, 1, 'active', 'بوتیک')
`).run(allocTafsili(db, 'customer', 'مشتری خالص v532')).lastInsertRowid;
const cust2 = db.prepare(`
  INSERT INTO customers (user_id, biz, phone, status, coa_code, party_id)
  VALUES (1, 'مشتری خالص', '09120000533', 'active', ?, ?)
`).run(db.prepare('SELECT coa_code FROM parties WHERE id=?').get(party2).coa_code, party2).lastInsertRowid;
ok(customerPartyAltHint(db, cust2) == null, 'pure customer → no hint');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(appJs.includes('party_hint') && appJs.includes('گردش شخص / همه نقش‌ها'), 'UI banner hook');
ok(swAtLeast(fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8'), 532), 'SW v532');

console.log(`\n${fail ? 'FAIL' : 'PASS'} ${pass}/${pass + fail} (stmt-party-hint-v532)`);
closeDB();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
