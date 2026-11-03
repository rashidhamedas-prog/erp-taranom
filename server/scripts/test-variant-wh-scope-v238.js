'use strict';
const { swAtLeast } = require('./lib/sw-at-least');
/**
 * v238: warehouse-scoped variant stock — no global fallback, no seed-with-global,
 * transfer ATP uses source warehouse only.
 * Run: node server/scripts/test-variant-wh-scope-v238.js
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

console.log('\n══ Variant warehouse scope v238 ══\n');

// Stock single source: REAL schema (initDB) + stock only through ledger documents (variant-stamped rows).
// The old fixture hand-wrote variant_warehouse_stock (incl. a forged "global copy" double count); the caches are
// now derived, so the heal's job is "rebuild from the ledger" and we corrupt the caches deliberately to prove it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vwh-scope-v238-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'test-vwh-scope-v238-secret-32chars!!!!!!';
process.env.AUTH_SESSION_DB_PATH = path.join(tmp, 'sessions.db');
process.env.NODE_ENV = 'test';
const { getDB, initDB } = require('../db');
initDB();
const db = getDB();

const {
  expandLivePack, variantWarehouseQty, reconcileVariantWarehouseProjections,
} = require('../lib/inventory/movement');
const { postInventoryMovement } = require('../lib/inventory/ledger');
const { seedStock } = require('./lib/stock-fixture');
const vws = (vid, wh) => Number((db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?').get(vid, wh) || {}).qty || 0);

const adminId = Number(db.prepare("INSERT INTO users (name, username, password, role, active, must_change_password) VALUES ('مدیر','vws_admin','x','admin',1,0)").run().lastInsertRowid);
const whA = Number(db.prepare("INSERT INTO warehouses (name, code, active, allow_negative, warehouse_type, inventory_system) VALUES ('محصول','VWS-A',1,0,'finished_goods','perpetual')").run().lastInsertRowid);
const whB = Number(db.prepare("INSERT INTO warehouses (name, code, active, allow_negative, warehouse_type, inventory_system) VALUES ('کیمیا','VWS-B',1,0,'finished_goods','perpetual')").run().lastInsertRowid);
const pid = Number(db.prepare(
  "INSERT INTO products (user_id, name, code, unit, stock, warehouse_id, pack_size, price, cost, average_cost_rial) VALUES (?,?,?,?,?,?,?,1000,1000,1000)"
).run(adminId, 'آفاق تست', 'VWS-P', 'عدد', 0, whA, 1).lastInsertRowid);
const c1 = Number(db.prepare("INSERT INTO product_colors (name, code, active) VALUES ('مشکی','VWSB',1)").run().lastInsertRowid);
const s1 = Number(db.prepare("INSERT INTO product_sizes (name, code, active) VALUES ('فری','VWSF',1)").run().lastInsertRowid);
const vid = Number(db.prepare(`
  INSERT INTO product_variants (product_id, color_id, size_id, sku, stock, active, is_default)
  VALUES (?,?,?,?,0,1,0)
`).run(pid, c1, s1, 'SKU-AF').lastInsertRowid);

// Opening document: 5 in محصول
seedStock(db, { productId: pid, variantId: vid, warehouseId: whA, qty: 5, note: 'opening' });
ok(vws(vid, whA) === 5, 'seed opening → VWS@A=5');

// Simulate corrupt double-count (old seed-with-global bug): B has a full global copy in the CACHE only
db.prepare(`
  INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,?)
  ON CONFLICT(variant_id, warehouse_id) DO UPDATE SET qty=excluded.qty
`).run(vid, whB, 5);
db.prepare("DELETE FROM settings WHERE key='vws_wh_reconcile_v1'").run();
const heal = reconcileVariantWarehouseProjections(db);
ok(heal && heal.rebuilt >= 1, 'reconcile rebuilds the caches from the ledger', JSON.stringify(heal));
const afterA = vws(vid, whA);
const afterB = vws(vid, whB);
ok(afterA === 5 && afterB === 0 && Math.abs(afterA + afterB - 5) < 0.01, 'after heal VWS sum = ledger 5 (double count gone)', `A=${afterA} B=${afterB}`);

// Move all 5 to کیمیا by documents (transfer A→B, whole qty): 0 in محصول, 5 in کیمیا
const xfer = (qty, from, to, docId) => {
  postInventoryMovement(db, { eventType: 'transfer_out', productId: pid, variantId: vid, warehouseId: from, qtyOut: qty, sourceType: 'wh_transfer', sourceId: docId, date: '1405/01/02', updateAvg: false, allowZeroCost: true });
  postInventoryMovement(db, { eventType: 'transfer_in', productId: pid, variantId: vid, warehouseId: to, qtyIn: qty, unitCostRial: 1000, sourceType: 'wh_transfer', sourceId: docId, date: '1405/01/02', updateAvg: false, allowZeroCost: true });
};
xfer(5, whA, whB, 9000);

ok(variantWarehouseQty(db, vid, whA) === 0, 'ATP@محصول = 0 (no global fallback)');
ok(variantWarehouseQty(db, vid, whB) === 5, 'ATP@کیمیا = 5');
ok(variantWarehouseQty(db, vid, null) === 5, 'global without WH = 5');

const liveA = expandLivePack(db, pid, whA);
ok(liveA.lines.length === 0, 'live-pack@محصول empty', liveA.lines.length);
const liveB = expandLivePack(db, pid, whB);
ok(liveB.lines.length === 1 && liveB.lines[0].sku_stock === 5, 'live-pack@کیمیا has color');

// Transfer-in must NOT seed destination with global stock: B→A of 2 documents only
xfer(2, whB, whA, 9001);
const vwsA2 = vws(vid, whA);
const vwsB2 = vws(vid, whB);
const g2 = Number(db.prepare('SELECT stock FROM product_variants WHERE id=?').get(vid).stock || 0);
ok(vwsA2 === 2 && vwsB2 === 3, 'transfer A←B: A=2 B=3', `A=${vwsA2} B=${vwsB2}`);
ok(g2 === 5 && Math.abs(vwsA2 + vwsB2 - g2) < 0.01, 'no double-count after transfer', `g=${g2}`);

// stock-matrix scoped write: set VWS@B to 10 (an adjustment document of +7 in B) without wiping A
postInventoryMovement(db, { eventType: 'adjustment', productId: pid, variantId: vid, warehouseId: whB, qty: 7, sourceType: 'variant_stock_adjust', sourceId: null, date: '1405/01/03', updateAvg: false, allowNegative: true, allowZeroCost: true });
const vwsA3 = vws(vid, whA);
const vwsB3 = vws(vid, whB);
ok(vwsB3 === 10 && vwsA3 === 2, 'stock-matrix@کیمیا=10 keeps محصول=2', `A=${vwsA3} B=${vwsB3}`);
ok(Number(db.prepare('SELECT stock FROM product_variants WHERE id=?').get(vid).stock) === 12,
  'variant.stock = sum VWS = 12');
const svc = fs.readFileSync(path.join(__dirname, '../lib/product-variants/service.js'), 'utf8');
// SSOT: the matrix no longer writes variant_warehouse_stock; quantities are per-warehouse adjustment documents.
ok(svc.includes('function postStockMatrix') && svc.includes('MA.postAdjust(') && /warehouse_id/.test(svc.slice(svc.indexOf('function postStockMatrix'))),
  'postStockMatrix posts per-warehouse adjustment documents (no direct VWS write)');

// Frontend contract
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(appJs.includes('whOnSourceWarehouseChange') && appJs.includes('p-matrix-wh'),
  'UI: source WH change + matrix WH selector');
ok(appJs.includes("'/product-variants/style/'+Number(id)+qs") || appJs.includes('p-matrix-wh'),
  'UI: whPickProduct / matrix WH warehouse_id');
ok(appJs.includes('پک زندهٔ') || appJs.includes('همان انبار مبدأ'),
  'Help: transfer pack scoped to source warehouse');

const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
ok(swAtLeast(sw, 238), 'SW v238');


console.log(`\n══ ${pass} passed, ${fail} failed ══\n`);
process.exit(fail ? 1 : 0);
