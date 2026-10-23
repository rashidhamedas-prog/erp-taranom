/**
 * v530 — Home dashboard KPIs use invoice face (rial), exclude reversed,
 * lowStock from warehouse_stock, and period vs all revenue fields.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const { firmSaleAliveSql } = require('../lib/sales-document');
const { sqlInvoiceFaceRial } = require('../lib/invoice-face-amount');

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed += 1;
  console.log('  ✓', msg);
}

const FACE = sqlInvoiceFaceRial();
const FIRM_ALIVE = firmSaleAliveSql();

ok(FIRM_ALIVE.includes("type IN ('normal','final')"), 'alive SQL has firm types');
ok(FIRM_ALIVE.includes('deleted_at'), 'alive SQL has deleted_at');
ok(FIRM_ALIVE.includes('reversed'), 'alive SQL excludes reversed');
ok(FACE.includes('final_rial'), 'face SQL prefers final_rial');

const adminSrc = fs.readFileSync(path.join(__dirname, '../routes/admin.js'), 'utf8');
ok(adminSrc.includes('sqlInvoiceFaceRial'), 'admin overview uses face helper');
ok(adminSrc.includes('firmSaleAliveSql'), 'admin overview uses alive helper');
ok(adminSrc.includes('warehouse_stock'), 'admin lowStock uses warehouse_stock');
ok(adminSrc.includes('totalRevenueAll'), 'overview exposes totalRevenueAll for period empty hint');
ok(adminSrc.includes('DASH_BOARD_ROLES'), 'expert board filters sales-ish roles');

const dashSrc = fs.readFileSync(path.join(__dirname, '../routes/dashboard.js'), 'utf8');
ok(dashSrc.includes('sqlInvoiceFaceRial'), 'dashboard summary/kpis use face');
ok(dashSrc.includes('firmSaleAliveSql'), 'dashboard uses alive SQL');
ok(dashSrc.includes('warehouse_stock'), 'dashboard alerts lowStock uses warehouse_stock');

const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(appSrc.includes('totalRevenueAll'), 'home UI reads totalRevenueAll');
ok(appSrc.includes("applyDashPreset('all')"), 'empty-period hint offers «همه»');
ok(appSrc.includes('v530'), 'Help mentions v530 period-zero hint');
ok(fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8').includes('erp-taranom-v530'), 'SW v530');
ok(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8').includes('app.js?v=530'), 'index asset ?v=530');

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.log('  ⚠ better-sqlite3 unavailable — skipping DB assertions (run on Iran Node)');
  console.log(`\nOK ${passed} assertions (home-dash-kpi-v530, static-only)`);
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-v530-'));
const dbPath = path.join(dir, 't.db');
let db;
try {
  db = new Database(dbPath);
} catch (e) {
  console.log('  ⚠ better-sqlite3 bindings missing — skipping DB assertions:', e.message.split('\n')[0]);
  console.log(`\nOK ${passed} assertions (home-dash-kpi-v530, static-only)`);
  process.exit(0);
}

db.exec(`
  CREATE TABLE products (
    id INTEGER PRIMARY KEY, stock REAL DEFAULT 0, stock_alert REAL DEFAULT 5, name TEXT
  );
  CREATE TABLE warehouse_stock (
    product_id INTEGER NOT NULL, warehouse_id INTEGER NOT NULL, qty REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (product_id, warehouse_id)
  );
  CREATE TABLE invoices (
    id INTEGER PRIMARY KEY, user_id INTEGER, cust_id INTEGER, type TEXT, date TEXT,
    final REAL, final_rial INTEGER, deleted_at INTEGER DEFAULT 0, status TEXT DEFAULT 'posted'
  );
`);

db.prepare('INSERT INTO products (id, stock, stock_alert, name) VALUES (1, 100, 5, \'A\')').run();
db.prepare('INSERT INTO products (id, stock, stock_alert, name) VALUES (2, 0, 5, \'B\')').run();
db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (1, 1, 2)').run();
db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (2, 1, 20)').run();

const lowStock = db.prepare(`
  SELECT COUNT(*) c FROM products p
  WHERE COALESCE((SELECT SUM(ws.qty) FROM warehouse_stock ws WHERE ws.product_id=p.id), 0)
        <= COALESCE(p.stock_alert, 5)
`).get().c;
ok(lowStock === 1, 'lowStock uses warehouse_stock (product 1 OH=2 ≤ alert 5; product 2 OH=20)');

const legacyStock = db.prepare('SELECT COUNT(*) c FROM products WHERE stock<=COALESCE(stock_alert,5)').get().c;
ok(legacyStock === 1, 'legacy products.stock flags product 2 (stock 0) only');
ok(lowStock !== legacyStock, 'WH-based lowStock diverges from products.stock mirror');

db.prepare(
  `INSERT INTO invoices (id,user_id,cust_id,type,date,final,final_rial,deleted_at,status)
   VALUES (1,1,1,'final','1405/07/15',100,1000,0,'posted')`
).run();
db.prepare(
  `INSERT INTO invoices (id,user_id,cust_id,type,date,final,final_rial,deleted_at,status)
   VALUES (2,1,1,'final','1405/08/01',50,500,0,'reversed')`
).run();
db.prepare(
  `INSERT INTO invoices (id,user_id,cust_id,type,date,final,final_rial,deleted_at,status)
   VALUES (3,1,1,'final','1405/08/01',50,500,1,'posted')`
).run();
db.prepare(
  `INSERT INTO invoices (id,user_id,cust_id,type,date,final,final_rial,deleted_at,status)
   VALUES (4,1,1,'final','1405/08/01',200,2000,0,'posted')`
).run();

const period = ` AND date >= '1405/08/01' AND date <= '1405/08/01'`;
const revPeriod = db.prepare(`SELECT COALESCE(SUM(${FACE}),0) s FROM invoices WHERE ${FIRM_ALIVE}${period}`).get().s;
const revAll = db.prepare(`SELECT COALESCE(SUM(${FACE}),0) s FROM invoices WHERE ${FIRM_ALIVE}`).get().s;
const bareFinal = db.prepare(
  `SELECT COALESCE(SUM(final),0) s FROM invoices WHERE type IN ('normal','final') AND COALESCE(deleted_at,0)=0${period}`
).get().s;

ok(revPeriod === 2000, 'period revenue = face of live invoice only (2000), not reversed/deleted');
ok(revAll === 3000, 'all-time revenue = 1000+2000 face');
ok(bareFinal === 250, 'bare SUM(final) would wrongly include reversed row amount 50 → 250');

db.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

console.log(`\nOK ${passed} assertions (home-dash-kpi-v530)`);
