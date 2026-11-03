'use strict';
/**
 * A color that is zero in the open warehouse is not a row of that warehouse.
 * Stock in another warehouse stays when this warehouse is saved.
 * Run: node server/scripts/test-zero-color-row-v318.js
 */
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const serviceSrc = fs.readFileSync(path.join(__dirname, '../lib/product-variants/service.js'), 'utf8');
ok(appJs.includes('function prodMatrixColorIds'), 'ردیف ماتریس فقط رنگ موجود در همین انبار است');
ok(appJs.includes('function prodPreserveColorIds'), 'رنگ موجود در انبار دیگر هنگام ذخیره نگه داشته می‌شود');
ok(appJs.includes('در این انبار صفر است ردیف ندارد'), 'راهنمای فرم ردیف صفر همین انبار را حذف می‌کند');
ok(serviceSrc.includes('function variantCarriesStock'), 'P1: ذخیره یک انبار رنگی را که در هر لایه موجودی دارد حذف نمی‌کند');

// Stock single source: boot the REAL schema (it owns inventory_ledger + derived caches); matrix quantities are
// ledger 'adjustment' documents (test-helpers/matrix-seed), never hand-written cache rows.
const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zc318-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'test-zc318-secret-32chars!!!!!!!!!!!!!';
process.env.AUTH_SESSION_DB_PATH = path.join(tmp, 'sessions.db');
process.env.NODE_ENV = 'test';
const { getDB, initDB } = require('../db');
initDB();
const db = getDB();
const adminId = Number(db.prepare("INSERT INTO users (name, username, password, role, active, must_change_password) VALUES ('مدیر','zc_admin','x','admin',1,0)").run().lastInsertRowid);
const mkWh = (code) => Number(db.prepare("INSERT INTO warehouses (name, code, active, allow_negative, warehouse_type, inventory_system) VALUES (?,?,1,1,'finished_goods','perpetual')").run(code, code).lastInsertRowid);
const wh1 = mkWh('ZC-1');
const wh2 = mkWh('ZC-2');
const { generateMatrix, adjustVariantStock } = require('../lib/product-variants/service');
const applyStockMatrix = (...a) => require('./test-helpers/matrix-seed').seedMatrixQty(...a);
const productId = db.prepare(
  `INSERT INTO products (user_id,code,name,price,stock,pack_size,unit,warehouse_id,average_cost_rial,cost) VALUES (${adminId},'7141','اورکت',1000,0,1,'عدد',${wh1},1000,1000)`
).run().lastInsertRowid;
generateMatrix(db, {
  product_id: productId,
  colors: [{ name: 'مشکی' }, { name: 'نخودی' }],
  sizes: [{ name: 'سایز 1' }, { name: 'سایز 2' }],
});
const colors = db.prepare('SELECT id,name FROM product_colors').all();
const sizes = db.prepare('SELECT id,name FROM product_sizes').all();
const black = colors.find((c) => c.name === 'مشکی');
const cream = colors.find((c) => c.name === 'نخودی');
const s1 = sizes.find((s) => s.name === 'سایز 1');
const s2 = sizes.find((s) => s.name === 'سایز 2');

applyStockMatrix(db, productId, [
  { color_id: black.id, size_id: s1.id, qty: 9 },
  { color_id: black.id, size_id: s2.id, qty: 8 },
  { color_id: cream.id, size_id: s1.id, qty: 0 },
  { color_id: cream.id, size_id: s2.id, qty: 0 },
], { warehouse_id: wh1 });

const creamVars = db.prepare(`
  SELECT id FROM product_variants
  WHERE product_id=? AND color_id=? AND COALESCE(is_default,0)=0
`).all(productId, cream.id);
// cream holds 1 pc per SKU in the OTHER warehouse — a stock document, not a cache write
const { seedStock } = require('./lib/stock-fixture');
for (const row of creamVars) seedStock(db, { productId, variantId: row.id, warehouseId: wh2, qty: 1, note: 'opening wh2' });
db.prepare(`
  UPDATE product_variants SET active=1, status='active'
  WHERE product_id=? AND color_id=? AND COALESCE(is_default,0)=0
`).run(productId, cream.id);
db.prepare(`
  INSERT INTO product_style_colors (product_id, color_id, sort_order) VALUES (?,?,0)
  ON CONFLICT(product_id, color_id) DO NOTHING
`).run(productId, cream.id);

applyStockMatrix(db, productId, [
  { color_id: black.id, size_id: s1.id, qty: 9 },
  { color_id: black.id, size_id: s2.id, qty: 8 },
], { warehouse_id: wh1 });

const creamLeft = db.prepare(`
  SELECT COUNT(*) c FROM product_variants
  WHERE product_id=? AND color_id=? AND active=1 AND COALESCE(is_default,0)=0
`).get(productId, cream.id).c;
const creamWh2 = db.prepare(`
  SELECT COALESCE(SUM(vws.qty),0) q
  FROM variant_warehouse_stock vws
  JOIN product_variants v ON v.id=vws.variant_id
  WHERE v.product_id=? AND v.color_id=? AND vws.warehouse_id=${wh2}
`).get(productId, cream.id).q;
const creamWh1 = db.prepare(`
  SELECT COALESCE(SUM(vws.qty),0) q
  FROM variant_warehouse_stock vws
  JOIN product_variants v ON v.id=vws.variant_id
  WHERE v.product_id=? AND v.color_id=? AND vws.warehouse_id=${wh1}
`).get(productId, cream.id).q;
const creamStyle = db.prepare(
  'SELECT COUNT(*) c FROM product_style_colors WHERE product_id=? AND color_id=?'
).get(productId, cream.id).c;
ok(creamLeft === 2, 'ذخیره انبار محصول نخودی را از کالا حذف نمی‌کند', creamLeft);
ok(Number(creamWh2) === 2, 'موجودی نخودی در انبار دیگر می‌ماند', creamWh2);
ok(Number(creamWh1) === 0, 'انبار محصول برای نخودی صفر می‌ماند', creamWh1);
ok(creamStyle === 1, 'پیوند نخودی با کالا می‌ماند', creamStyle);

const blackWh1 = db.prepare(`
  SELECT COALESCE(SUM(vws.qty),0) q
  FROM variant_warehouse_stock vws
  JOIN product_variants v ON v.id=vws.variant_id
  WHERE v.product_id=? AND v.color_id=? AND vws.warehouse_id=${wh1}
`).get(productId, black.id).q;
ok(Number(blackWh1) === 17, 'موجودی مشکی همین انبار دست نمی‌خورد', blackWh1);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
