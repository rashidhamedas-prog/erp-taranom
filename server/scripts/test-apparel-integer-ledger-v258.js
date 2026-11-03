'use strict';
const { swAtLeast } = require('./lib/sw-at-least');
/**
 * Piece/matrix stock stays integer. A float projection (6.462) is restored
 * from the movement ledger (opening 14 minus transfer 2 = 12), not rounded to 6.
 * Run: node server/scripts/test-apparel-integer-ledger-v258.js
 *
 * Stock single source: the REAL schema is booted (initDB) and every quantity is a ledger document
 * (seedStock / setStock → inventory_ledger). The only direct cache writes left are the deliberate
 * CORRUPTION of the derived caches (the legacy v238 float reconcile this heal exists to undo).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apparel-int-v258-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'test-apparel-int-v258-secret-32chars!!!!!';
process.env.AUTH_SESSION_DB_PATH = path.join(tmp, 'sessions.db');
process.env.NODE_ENV = 'test';

const { getDB, initDB } = require('../db');
initDB();
const db = getDB();
const { healApparelIntegerStock, parseStockQty } = require('../lib/inventory/qty-policy');
const { seedStock, setStock } = require('./lib/stock-fixture');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : String(extra)); }
}
function insert(table, obj) {
  const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  const keys = Object.keys(obj).filter((k) => cols.has(k));
  return Number(db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => obj[k])).lastInsertRowid);
}
const one = (sql, ...a) => db.prepare(sql).get(...a) || { qty: 0, stock: 0 };

const adminId = insert('users', { name: 'مدیر', username: 'aiv_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
const wh34 = insert('warehouses', { name: 'انبار محصول', code: 'AIV-34', active: 1, allow_negative: 1, warehouse_type: 'finished_goods', inventory_system: 'perpetual' });
const wh35 = insert('warehouses', { name: 'انبار کیمیا', code: 'AIV-35', active: 1, allow_negative: 1, warehouse_type: 'finished_goods', inventory_system: 'perpetual' });
const black = insert('product_colors', { name: 'مشکی', code: 'AIVB', active: 1 });
const size1 = insert('product_sizes', { name: 'سایز 1', code: 'AIVS1', active: 1 });
const size2 = insert('product_sizes', { name: 'سایز 2', code: 'AIVS2', active: 1 });

const P = insert('products', { user_id: adminId, name: 'کت کتان درسا', code: '7157', unit: 'عدد', price: 1000, cost: 1000, average_cost_rial: 1000, warehouse_id: wh34, stock: 0 });
const V64 = insert('product_variants', { product_id: P, color_id: black, size_id: size1, sku: '7157-blk', stock: 0, active: 1, is_default: 0 });
const V70 = insert('product_variants', { product_id: P, color_id: black, size_id: size2, sku: 'phantom', stock: 0, active: 1, is_default: 0 });
const PH = insert('products', { user_id: adminId, name: 'کالای سالم', code: '9000', unit: 'عدد', price: 1000, cost: 1000, average_cost_rial: 1000, warehouse_id: wh34, stock: 0 });
const V80 = insert('product_variants', { product_id: PH, color_id: black, size_id: size1, sku: '9000-ok', stock: 0, active: 1, is_default: 0 });
const PF = insert('products', { user_id: adminId, name: 'پارچه', code: 'FAB', unit: 'متر', price: 1000, cost: 1000, average_cost_rial: 1000, warehouse_id: wh34, stock: 0 });

// ── ledger documents (the truth): opening 14 − transfer 2 in wh34, transfer-in 2 in wh35, sibling 4 ──
seedStock(db, { productId: P, variantId: V64, warehouseId: wh34, qty: 14, note: 'opening_seed' });
setStock(db, { productId: P, variantId: V64, warehouseId: wh34, target: 12, note: 'wh_transfer_out' });
seedStock(db, { productId: P, variantId: V64, warehouseId: wh35, qty: 2, note: 'wh_transfer_in' });
seedStock(db, { productId: P, variantId: V70, warehouseId: wh34, qty: 4, note: 'opening_seed' });
seedStock(db, { productId: PH, variantId: V80, warehouseId: wh34, qty: 9 });
seedStock(db, { productId: PF, warehouseId: wh34, qty: 1.25 });

// ── deliberate corruption of the DERIVED caches (legacy v238 float reconcile) ──
db.prepare('UPDATE variant_warehouse_stock SET qty=6.462 WHERE variant_id=? AND warehouse_id=?').run(V64, wh34);
db.prepare('INSERT OR REPLACE INTO variant_warehouse_stock (variant_id,warehouse_id,qty) VALUES (?,?,0.5)').run(V70, wh35);
db.prepare('UPDATE variant_warehouse_stock SET qty=1.5 WHERE variant_id=? AND warehouse_id=?').run(V70, wh34);
db.prepare('UPDATE product_variants SET stock=8.462 WHERE id=?').run(V64);
db.prepare('UPDATE products SET stock=45.033 WHERE id=?').run(P);
// heal may already have run at boot: re-arm its one-shot flag for this fixture
db.prepare("DELETE FROM settings WHERE key='apparel_qty_ledger_heal_v1'").run();

const healed = healApparelIntegerStock(db);
ok(healed.productsRebuilt >= 1, 'heal rewrites fractional projections', JSON.stringify(healed));
const w34 = one('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?', V64, wh34);
const w35 = one('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?', V64, wh35);
const vstock = one('SELECT stock FROM product_variants WHERE id=?', V64);
ok(w34.qty === 12, 'product warehouse restored to 14-2', w34.qty);
ok(w35.qty === 2, 'transfer destination stays 2', w35.qty);
ok(vstock.stock === 14, 'variant total is ledger sum', vstock.stock);
const phantom = one('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?', V70, wh35);
const real70 = one('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?', V70, wh34);
ok(phantom.qty === 0, 'phantom split with no movements returns to 0', phantom.qty);
ok(real70.qty === 4, 'sibling warehouse follows its own ledger', real70.qty);
const head = one('SELECT stock FROM products WHERE id=?', P);
ok(head.stock === 18, 'product header is the integer variant sum', head.stock);
const healthy = one('SELECT stock FROM products WHERE id=?', PH);
const healthyWs = one('SELECT qty FROM warehouse_stock WHERE product_id=?', PH);
ok(healthy.stock === 9 && healthyWs.qty === 9, 'integer product is left untouched', healthy.stock);
const fabric = one('SELECT stock FROM products WHERE id=?', PF);
ok(fabric.stock === 1.25, 'fabric meters stay decimal', fabric.stock);
const again = healApparelIntegerStock(db);
ok(again.already === true, 'heal is idempotent');

let rejected = false;
try {
  parseStockQty(0.75, { integer: true, strict: true });
} catch (e) {
  rejected = e && e.code === 'E_QTY_NOT_INTEGER';
}
ok(rejected, 'piece qty policy rejects 0.75');
const kept = one('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?', V64, wh34);
ok(kept.qty === 12, 'heal left the restored integer in place', kept.qty);
const svc = fs.readFileSync(path.join(__dirname, '../lib/product-variants/service.js'), 'utf8');
ok(/integer:\s*true,\s*strict:\s*true/.test(svc), 'stock matrix enforces integer qty');

const parsed = parseStockQty(12, { integer: true, strict: true });
ok(parsed === 12, 'integer parse keeps 12', parsed);

const css = fs.readFileSync(path.join(__dirname, '../public/app.css'), 'utf8');
ok(/\.tbl-wrap\{overflow:visible/.test(css), 'tables are not an inner scrollport');
ok(!/\.tbl-wrap\.tbl-scroll\{[^}]*max-height:min\(/.test(css), 'tbl-scroll no longer caps height');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(/fmtPieceQty\(v\.stock\)/.test(app), 'SKU grid prints an integer');
ok(/Math\.round\(parseQty\(inp\.value/.test(app), 'SKU save sends an integer');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
ok(swAtLeast(sw, 259), 'SW v259');

try { db.close(); } catch (_) { /* shared handle */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
