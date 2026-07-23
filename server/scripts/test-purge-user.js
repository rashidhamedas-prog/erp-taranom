/**
 * تست حذف کامل کاربر + انتقال مالکیت.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-purge-'));
const dbPath = path.join(tmpDir, 'test.db');
process.env.DB_PATH = dbPath;

const { getDB, initDB } = require('../db');
const { purgeUser } = require('../lib/purge-user');

initDB();
const db = getDB();

const admin = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
assert.ok(admin, 'admin seed');

const hash = db.prepare('SELECT password FROM users WHERE id=?').get(admin.id).password;
const ins = db.prepare(`
  INSERT INTO users (name, username, password, role, active, phone)
  VALUES ('کاربر تست حذف', 'purge_test_user', ?, 'field_sales', 1, '09120001111')
`).run(hash);
const uid = Number(ins.lastInsertRowid);

db.prepare(`
  INSERT INTO customers (user_id, biz, owner, phone, status, type)
  VALUES (?, 'فروشگاه تست حذف', 'مالک', '09120002222', 'active', 'shop')
`).run(uid);
const custId = db.prepare('SELECT id FROM customers WHERE user_id=?').get(uid).id;

db.prepare(`
  INSERT INTO invoices (user_id, cust_id, type, date, num, subtotal, disc, disc_amt, final, status)
  VALUES (?, ?, 'final', '1405/01/01', 'TMP-PURGE', 1000, 0, 0, 1000, 'open')
`).run(uid, custId);

purgeUser(db, uid, admin.id);

assert.strictEqual(db.prepare('SELECT id FROM users WHERE id=?').get(uid), undefined, 'user deleted');
const cust = db.prepare('SELECT user_id FROM customers WHERE id=?').get(custId);
assert.strictEqual(cust.user_id, admin.id, 'customer reassigned');
const inv = db.prepare('SELECT user_id FROM invoices WHERE num=?').get('TMP-PURGE');
assert.strictEqual(inv.user_id, admin.id, 'invoice reassigned');

let blocked = false;
try { purgeUser(db, admin.id, admin.id); } catch (e) { blocked = true; }
assert.ok(blocked, 'cannot purge self');

console.log('OK purge-user');
