'use strict';
/**
 * Variant stock movement invariant tests.
 * Run: node server/scripts/test-variant-stock-movement.js
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const testDb = path.join(__dirname, '_variant-stock-movement-test.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch (_) {}
}

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : String(extra)); }
}

console.log('\n══ Variant stock movement ══\n');

const db = new Database(testDb);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, stock REAL DEFAULT 0, warehouse_id INTEGER, pack_size INTEGER DEFAULT 1
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
    sku TEXT, stock REAL DEFAULT 0,
    active INTEGER DEFAULT 1, is_default INTEGER DEFAULT 0
  );
`);

const {
  ensureInventorySchema, postStockMovement, reverseStockDocument, expandLivePack,
} = require('../lib/inventory/movement');

ensureInventorySchema(db);

const whId = db.prepare('INSERT INTO warehouses (name) VALUES (?)').run('FG').lastInsertRowid;
const matrixId = db.prepare(
  'INSERT INTO products (name, stock, warehouse_id, pack_size) VALUES (?,?,?,?)'
).run('Matrix Tee', 40, whId, 4).lastInsertRowid;
db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)')
  .run(matrixId, whId, 40);

const c1 = db.prepare('INSERT INTO product_colors (name) VALUES (?)').run('مشکی').lastInsertRowid;
const c2 = db.prepare('INSERT INTO product_colors (name) VALUES (?)').run('سفید').lastInsertRowid;
const s1 = db.prepare('INSERT INTO product_sizes (name) VALUES (?)').run('M').lastInsertRowid;
const s2 = db.prepare('INSERT INTO product_sizes (name) VALUES (?)').run('L').lastInsertRowid;

const variants = [];
for (const colorId of [c1, c2]) {
  for (const sizeId of [s1, s2]) {
    const id = db.prepare(`
      INSERT INTO product_variants (product_id, color_id, size_id, sku, stock, active, is_default)
      VALUES (?,?,?,?,?,1,0)
    `).run(matrixId, colorId, sizeId, `SKU-${colorId}-${sizeId}`, 10).lastInsertRowid;
    variants.push(id);
  }
}
ok(variants.length === 4, 'ماتریس ۲×۲ ساخته شد');

// Opening seed (single WH) should copy variant stock into variant_warehouse_stock
ensureInventorySchema(db);
const seeded = db.prepare(
  'SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?'
).get(variants[0], whId);
ok(seeded && Number(seeded.qty) === 10, 'seed opening → variant_warehouse_stock=10', seeded);

const soldVariant = variants[0];

db.transaction(() => {
  postStockMovement(db, {
    productId: matrixId,
    variantId: soldVariant,
    warehouseId: whId,
    qtyDelta: -1,
    docType: 'invoice',
    docId: 1001,
    docLine: 0,
    userId: 1,
    note: 'sale test',
    allowNegative: true,
  });
})();

const pAfter = db.prepare('SELECT stock FROM products WHERE id=?').get(matrixId);
const wsAfter = db.prepare(
  'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
).get(matrixId, whId);
const vAfter = db.prepare('SELECT stock FROM product_variants WHERE id=?').get(soldVariant);
const vwsAfter = db.prepare(
  'SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?'
).get(soldVariant, whId);

ok(Number(pAfter.stock) === 39, 'products.stock −1 → 39', pAfter.stock);
ok(Number(wsAfter.qty) === 39, 'warehouse_stock −1 → 39', wsAfter.qty);
ok(Number(vAfter.stock) === 9, 'variant.stock −1 → 9', vAfter.stock);
ok(Number(vwsAfter.qty) === 9, 'variant_warehouse_stock −1 → 9', vwsAfter.qty);

const movCount1 = db.prepare(
  "SELECT COUNT(*) c FROM inventory_movements WHERE doc_type='invoice' AND doc_id=1001"
).get().c;
ok(movCount1 === 1, 'یک ردیف inventory_movements', movCount1);

db.transaction(() => {
  postStockMovement(db, {
    productId: matrixId,
    variantId: soldVariant,
    warehouseId: whId,
    qtyDelta: -1,
    docType: 'invoice',
    docId: 1001,
    docLine: 0,
    userId: 1,
    note: 'sale retry',
    allowNegative: true,
  });
})();

const pIdem = db.prepare('SELECT stock FROM products WHERE id=?').get(matrixId);
const vIdem = db.prepare('SELECT stock FROM product_variants WHERE id=?').get(soldVariant);
const movCount2 = db.prepare(
  "SELECT COUNT(*) c FROM inventory_movements WHERE doc_type='invoice' AND doc_id=1001"
).get().c;
ok(Number(pIdem.stock) === 39 && Number(vIdem.stock) === 9, 'idempotent — موجودی دوباره کم نشد',
  `p=${pIdem.stock} v=${vIdem.stock}`);
ok(movCount2 === 1, 'idempotent — ردیف حرکت تکراری نشد', movCount2);

db.transaction(() => {
  reverseStockDocument(db, {
    docType: 'invoice', docId: 1001, userId: 1, note: 'void sale',
  });
})();

const pRev = db.prepare('SELECT stock FROM products WHERE id=?').get(matrixId);
const wsRev = db.prepare(
  'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
).get(matrixId, whId);
const vRev = db.prepare('SELECT stock FROM product_variants WHERE id=?').get(soldVariant);
const vwsRev = db.prepare(
  'SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?'
).get(soldVariant, whId);
ok(Number(pRev.stock) === 40, 'reverse → products.stock=40', pRev.stock);
ok(Number(wsRev.qty) === 40, 'reverse → warehouse_stock=40', wsRev.qty);
ok(Number(vRev.stock) === 10, 'reverse → variant.stock=10', vRev.stock);
ok(Number(vwsRev.qty) === 10, 'reverse → variant_warehouse_stock=10', vwsRev.qty);

db.transaction(() => {
  reverseStockDocument(db, {
    docType: 'invoice', docId: 1001, userId: 1, note: 'void again',
  });
})();
const pRev2 = db.prepare('SELECT stock FROM products WHERE id=?').get(matrixId);
ok(Number(pRev2.stock) === 40, 'double-reverse no-op', pRev2.stock);

let threw = null;
try {
  postStockMovement(db, {
    productId: matrixId,
    variantId: null,
    warehouseId: whId,
    qtyDelta: -1,
    docType: 'invoice',
    docId: 2002,
    docLine: 0,
    allowNegative: true,
  });
} catch (e) { threw = e; }
ok(threw && threw.code === 'E_VARIANT_REQUIRED', 'ماتریس بدون variant_id → E_VARIANT_REQUIRED',
  threw && threw.code);

const plainId = db.prepare(
  'INSERT INTO products (name, stock, warehouse_id) VALUES (?,?,?)'
).run('Plain Tee', 5, whId).lastInsertRowid;
db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)')
  .run(plainId, whId, 5);

db.transaction(() => {
  postStockMovement(db, {
    productId: plainId,
    variantId: null,
    warehouseId: whId,
    qtyDelta: -2,
    docType: 'invoice',
    docId: 3003,
    docLine: 0,
    allowNegative: true,
  });
})();
const plainAfter = db.prepare('SELECT stock FROM products WHERE id=?').get(plainId);
const plainWs = db.prepare(
  'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
).get(plainId, whId);
ok(Number(plainAfter.stock) === 3, 'غیرماتریسی products.stock −2 → 3', plainAfter.stock);
ok(Number(plainWs.qty) === 3, 'غیرماتریسی warehouse_stock −2 → 3', plainWs.qty);
ok(
  !db.prepare('SELECT 1 FROM inventory_movements WHERE doc_id=3003 AND variant_id IS NOT NULL').get(),
  'غیرماتریسی بدون variant_id در حرکت'
);

const live = expandLivePack(db, matrixId, whId);
ok(Array.isArray(live.lines) && live.lines.length === 4, 'live-pack ۴ SKU زنده (۲ رنگ کامل)', live.lines && live.lines.length);
ok(live.pack_size_auto === 4 && live.live_colors === 2 && live.live_sizes === 2,
  'pack_size_auto = complete_colors × sizes',
  `auto=${live.pack_size_auto} c=${live.live_colors} s=${live.live_sizes}`);

// Sell one SKU to zero → that color leaves the pack entirely (sibling size drops too)
db.transaction(() => {
  postStockMovement(db, {
    productId: matrixId, variantId: soldVariant, warehouseId: whId, qtyDelta: -10,
    docType: 'invoice', docId: 4004, docLine: 0, allowNegative: true,
  });
})();
const live2 = expandLivePack(db, matrixId, whId);
ok(live2.lines.length === 2 && live2.pack_size_auto === 2,
  'پس از صفر شدن یک SKU، رنگ ناقص از پک خارج → ۲ خط', live2);

db.close();
try { fs.unlinkSync(testDb); } catch (_) {}
try { fs.unlinkSync(testDb + '-wal'); } catch (_) {}
try { fs.unlinkSync(testDb + '-shm'); } catch (_) {}

console.log(`\n══ ${pass} passed, ${fail} failed ══\n`);
process.exit(fail ? 1 : 0);
