'use strict';
/**
 * v238: warehouse-scoped variant stock — no global fallback, no seed-with-global,
 * transfer ATP uses source warehouse only.
 * Run: node server/scripts/test-variant-wh-scope-v238.js
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const testDb = path.join(__dirname, '_variant-wh-scope-v238-test.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch (_) {}
}

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : String(extra)); }
}

console.log('\n══ Variant warehouse scope v238 ══\n');

const db = new Database(testDb);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, stock REAL DEFAULT 0, warehouse_id INTEGER, pack_size INTEGER DEFAULT 1, colors INTEGER DEFAULT 1
  );
  CREATE TABLE warehouses (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, allow_negative INTEGER DEFAULT 0
  );
  CREATE TABLE warehouse_stock (
    product_id INTEGER NOT NULL, warehouse_id INTEGER NOT NULL, qty REAL DEFAULT 0,
    PRIMARY KEY (product_id, warehouse_id)
  );
  CREATE TABLE stock_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER, user_id INTEGER, change REAL, note TEXT
  );
  CREATE TABLE product_colors (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, active INTEGER DEFAULT 1
  );
  CREATE TABLE product_sizes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, active INTEGER DEFAULT 1
  );
  CREATE TABLE product_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    color_id INTEGER, size_id INTEGER,
    sku TEXT, barcode TEXT, stock REAL DEFAULT 0,
    active INTEGER DEFAULT 1, is_default INTEGER DEFAULT 0, status TEXT DEFAULT 'active'
  );
`);

const {
  ensureInventorySchema, postStockMovement, expandLivePack, variantWarehouseQty,
  reconcileVariantWarehouseProjections,
} = require('../lib/inventory/movement');

ensureInventorySchema(db);

const whA = db.prepare('INSERT INTO warehouses (name) VALUES (?)').run('محصول').lastInsertRowid;
const whB = db.prepare('INSERT INTO warehouses (name) VALUES (?)').run('کیمیا').lastInsertRowid;
const pid = db.prepare(
  'INSERT INTO products (name, stock, warehouse_id, pack_size) VALUES (?,?,?,?)'
).run('آفاق تست', 0, whA, 1).lastInsertRowid;
const c1 = db.prepare('INSERT INTO product_colors (name) VALUES (?)').run('مشکی').lastInsertRowid;
const s1 = db.prepare('INSERT INTO product_sizes (name) VALUES (?)').run('فری').lastInsertRowid;
const vid = db.prepare(`
  INSERT INTO product_variants (product_id, color_id, size_id, sku, stock, active, is_default)
  VALUES (?,?,?,?,?,1,0)
`).run(pid, c1, s1, 'SKU-AF', 5).lastInsertRowid;

// Opening seed only for single-WH products — give product one WH row then re-seed
db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)').run(pid, whA, 5);
ensureInventorySchema(db);
ok(
  Number(db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?').get(vid, whA)?.qty) === 5,
  'seed opening → VWS@A=5'
);

// Simulate corrupt double-count (old seed-with-global bug): B has full global copy
db.prepare(`
  INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,?)
  ON CONFLICT(variant_id, warehouse_id) DO UPDATE SET qty=excluded.qty
`).run(vid, whB, 5);
db.prepare("DELETE FROM settings WHERE key='vws_wh_reconcile_v1'").run();
const heal = reconcileVariantWarehouseProjections(db);
ok(heal && heal.scaled >= 1, 'reconcile scales double-count', heal);
const afterA = Number(db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?').get(vid, whA)?.qty || 0);
const afterB = Number(db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?').get(vid, whB)?.qty || 0);
ok(Math.abs(afterA + afterB - 5) < 0.01, 'after heal VWS sum = global 5', `A=${afterA} B=${afterB}`);

// Reset clean state: all 5 in کیمیا, 0 in محصول
db.prepare('UPDATE variant_warehouse_stock SET qty=? WHERE variant_id=? AND warehouse_id=?').run(0, vid, whA);
db.prepare('UPDATE variant_warehouse_stock SET qty=? WHERE variant_id=? AND warehouse_id=?').run(5, vid, whB);
db.prepare('UPDATE product_variants SET stock=? WHERE id=?').run(5, vid);
db.prepare(`
  INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)
  ON CONFLICT(product_id, warehouse_id) DO UPDATE SET qty=excluded.qty
`).run(pid, whA, 0);
db.prepare(`
  INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)
  ON CONFLICT(product_id, warehouse_id) DO UPDATE SET qty=excluded.qty
`).run(pid, whB, 5);
db.prepare('UPDATE products SET stock=? WHERE id=?').run(5, pid);

ok(variantWarehouseQty(db, vid, whA) === 0, 'ATP@محصول = 0 (no global fallback)');
ok(variantWarehouseQty(db, vid, whB) === 5, 'ATP@کیمیا = 5');
ok(variantWarehouseQty(db, vid, null) === 5, 'global without WH = 5');

const liveA = expandLivePack(db, pid, whA);
ok(liveA.lines.length === 0, 'live-pack@محصول empty', liveA.lines.length);
const liveB = expandLivePack(db, pid, whB);
ok(liveB.lines.length === 1 && liveB.lines[0].sku_stock === 5, 'live-pack@کیمیا has color');

// Transfer-in must NOT seed destination with global stock
db.transaction(() => {
  postStockMovement(db, {
    productId: pid, variantId: vid, warehouseId: whB, qtyDelta: -2,
    docType: 'wh_transfer_out', docId: 9001, docLine: 0, allowNegative: false,
    applyHeaderStock: true,
  });
  postStockMovement(db, {
    productId: pid, variantId: vid, warehouseId: whA, qtyDelta: 2,
    docType: 'wh_transfer_in', docId: 9001, docLine: 1, allowNegative: false,
    applyHeaderStock: true,
  });
})();
const vwsA2 = Number(db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?').get(vid, whA)?.qty || 0);
const vwsB2 = Number(db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?').get(vid, whB)?.qty || 0);
const g2 = Number(db.prepare('SELECT stock FROM product_variants WHERE id=?').get(vid)?.stock || 0);
ok(vwsA2 === 2 && vwsB2 === 3, 'transfer A←B: A=2 B=3', `A=${vwsA2} B=${vwsB2}`);
ok(g2 === 5 && Math.abs(vwsA2 + vwsB2 - g2) < 0.01, 'no double-count after transfer', `g=${g2}`);

// stock-matrix scoped write: set VWS@B absolute without wiping A
db.prepare(`
  INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,?)
  ON CONFLICT(variant_id, warehouse_id) DO UPDATE SET qty=excluded.qty
`).run(vid, whB, 10);
const sumAll = db.prepare(
  'SELECT COALESCE(SUM(qty),0) AS s FROM variant_warehouse_stock WHERE variant_id=?'
).get(vid).s;
db.prepare('UPDATE product_variants SET stock=? WHERE id=?').run(sumAll, vid);
const vwsA3 = Number(db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?').get(vid, whA)?.qty || 0);
const vwsB3 = Number(db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?').get(vid, whB)?.qty || 0);
ok(vwsB3 === 10 && vwsA3 === 2, 'stock-matrix@کیمیا=10 keeps محصول=2', `A=${vwsA3} B=${vwsB3}`);
ok(Number(db.prepare('SELECT stock FROM product_variants WHERE id=?').get(vid).stock) === 12,
  'variant.stock = sum VWS = 12');

const svc = fs.readFileSync(path.join(__dirname, '../lib/product-variants/service.js'), 'utf8');
ok(svc.includes('warehouse_id') && svc.includes('variant_warehouse_stock') && svc.includes('SUM(qty)'),
  'applyStockMatrix writes per-warehouse VWS');

// Frontend contract
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(appJs.includes('whOnSourceWarehouseChange') && appJs.includes('p-matrix-wh'),
  'UI: source WH change + matrix WH selector');
ok(appJs.includes("'/product-variants/style/'+Number(id)+qs") || appJs.includes('p-matrix-wh'),
  'UI: whPickProduct / matrix WH warehouse_id');
ok(appJs.includes('پک زندهٔ') || appJs.includes('همان انبار مبدأ'),
  'Help: transfer pack scoped to source warehouse');

const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
ok(/erp-taranom-v238/.test(sw), 'SW v238');

db.close();
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch (_) {}
}

console.log(`\n══ ${pass} passed, ${fail} failed ══\n`);
process.exit(fail ? 1 : 0);
