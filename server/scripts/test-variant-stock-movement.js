'use strict';
/**
 * Variant stock movement invariant tests.
 * Run: node server/scripts/test-variant-stock-movement.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : String(extra)); }
}

console.log('\n══ Variant stock movement ══\n');

// Stock single source: the REAL schema (initDB) is booted and stock is created by ledger documents
// (variant-stamped receipts). products.stock / product_variants.stock / warehouse_stock /
// variant_warehouse_stock are derived caches and are only READ here.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'var-stock-mv-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'test-var-stock-mv-secret-32chars!!!!!!!!';
process.env.AUTH_SESSION_DB_PATH = path.join(tmp, 'sessions.db');
process.env.NODE_ENV = 'test';
const { getDB, initDB } = require('../db');
initDB();
const db = getDB();

const {
  postStockMovement, reverseStockDocument, expandLivePack,
} = require('../lib/inventory/movement');
const { seedStock } = require('./lib/stock-fixture');

const adminId = Number(db.prepare("INSERT INTO users (name, username, password, role, active, must_change_password) VALUES ('مدیر','vsm_admin','x','admin',1,0)").run().lastInsertRowid);
const whId = Number(db.prepare("INSERT INTO warehouses (name, code, active, allow_negative, warehouse_type, inventory_system) VALUES ('FG','VSM-FG',1,1,'finished_goods','perpetual')").run().lastInsertRowid);
const mkProduct = (name, code, packSize = 1) => Number(db.prepare(
  'INSERT INTO products (user_id, name, code, unit, stock, warehouse_id, pack_size, price, cost, average_cost_rial) VALUES (?,?,?,?,0,?,?,1000,1000,1000)'
).run(adminId, name, code, 'عدد', whId, packSize).lastInsertRowid);
const matrixId = mkProduct('Matrix Tee', 'VSM-MX', 4);

const c1 = Number(db.prepare("INSERT INTO product_colors (name, code, active) VALUES ('مشکی','VSMB',1)").run().lastInsertRowid);
const c2 = Number(db.prepare("INSERT INTO product_colors (name, code, active) VALUES ('سفید','VSMW',1)").run().lastInsertRowid);
const s1 = Number(db.prepare("INSERT INTO product_sizes (name, code, active) VALUES ('M','VSMM',1)").run().lastInsertRowid);
const s2 = Number(db.prepare("INSERT INTO product_sizes (name, code, active) VALUES ('L','VSML',1)").run().lastInsertRowid);

const variants = [];
for (const colorId of [c1, c2]) {
  for (const sizeId of [s1, s2]) {
    const id = Number(db.prepare(`
      INSERT INTO product_variants (product_id, color_id, size_id, sku, stock, active, is_default)
      VALUES (?,?,?,?,0,1,0)
    `).run(matrixId, colorId, sizeId, `SKU-${colorId}-${sizeId}`).lastInsertRowid);
    variants.push(id);
    seedStock(db, { productId: matrixId, variantId: id, warehouseId: whId, qty: 10, note: 'opening' });
  }
}
ok(variants.length === 4, 'ماتریس ۲×۲ ساخته شد');

// Opening documents (variant-stamped ledger receipts) → derived variant_warehouse_stock
const seeded = db.prepare(
  'SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?'
).get(variants[0], whId);
ok(seeded && Number(seeded.qty) === 10, 'seed opening → variant_warehouse_stock=10', seeded);
ok(Number(db.prepare('SELECT stock FROM products WHERE id=?').get(matrixId).stock) === 40, 'products.stock derived = Σ variants = 40');
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

const plainId = mkProduct('Plain Tee', 'VSM-PL');
seedStock(db, { productId: plainId, warehouseId: whId, qty: 5, note: 'opening' });

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


console.log(`\n══ ${pass} passed, ${fail} failed ══\n`);
process.exit(fail ? 1 : 0);
