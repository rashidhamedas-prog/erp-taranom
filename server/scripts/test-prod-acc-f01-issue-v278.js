'use strict';
/**
 * PROD-ACC PA-03 — F01 warehouse shortage must not be masked
 * Run: node server/scripts/test-prod-acc-f01-issue-v278.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-acc-f01-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(dir, 't.db');
process.env.JWT_SECRET = 'test-prod-acc-f01-secret-32-bytes-xx';
process.env.SYNC_ROLE = 'central';

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const { issueFromStock } = require('../lib/production/costing');

let passed = 0, failed = 0;
function ok(c, m) {
  if (c) { passed++; console.log('  OK', m); }
  else { failed++; console.error('  FAIL', m); }
}

const whA = db.prepare("INSERT INTO warehouses (code,name,warehouse_type,active) VALUES ('WH-A','A','raw_material',1)").run().lastInsertRowid;
const whB = db.prepare("INSERT INTO warehouses (code,name,warehouse_type,active) VALUES ('WH-B','B','raw_material',1)").run().lastInsertRowid;
const uid = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()?.id || 1;
const pid = db.prepare(`
  INSERT INTO products (user_id, name, code, stock, average_cost_rial, cost, unit, is_manufactured)
  VALUES (?,'نخ تست','YARN-F01',100,1000,100,'متر',0)
`).run(uid).lastInsertRowid;
db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)').run(pid, whA, 5);
db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)').run(pid, whB, 95);

console.log('F01 — issue from WH-A with only 5 when header stock=100');
let threw = null;
try {
  issueFromStock(db, { productId: pid, warehouseId: whA, qty: 10, userId: 1, note: 'test' });
} catch (e) {
  threw = e;
}
ok(!!threw && (threw.code === 'E_NEGATIVE_STOCK' || threw.message === 'E_NEGATIVE_STOCK'), 'throws E_NEGATIVE_STOCK');
ok(threw && Number(threw.extra?.available) === 5, `available=5 got ${threw && threw.extra && threw.extra.available}`);

const whAfter = db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(pid, whA);
ok(Number(whAfter.qty) === 5, 'WH-A qty unchanged (no rewrite)');
const header = db.prepare('SELECT stock FROM products WHERE id=?').get(pid);
ok(Number(header.stock) === 100, 'header stock unchanged after failed issue');

console.log('F01 — successful issue from WH-A qty 3');
const r = issueFromStock(db, { productId: pid, warehouseId: whA, qty: 3, userId: 1 });
ok(r.ok && r.qty === 3, 'issue 3 ok');
const wh2 = db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(pid, whA);
ok(Number(wh2.qty) === 2, 'WH-A now 2');
const led = db.prepare(`
  SELECT COUNT(*) c FROM inventory_ledger
  WHERE product_id=? AND warehouse_id=? AND event_type='production_issue' AND status='posted'
`).get(pid, whA);
ok(Number(led.c) >= 1, 'inventory_ledger production_issue row');

console.log(`\nResult: ${passed} passed, ${failed} failed`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
if (failed) process.exit(1);
