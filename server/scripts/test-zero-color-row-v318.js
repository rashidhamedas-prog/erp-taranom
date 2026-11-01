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

function loadBetterSqlite3() {
  const candidates = [
    path.join(__dirname, '..', 'node_modules', 'better-sqlite3'),
  ];
  for (const c of candidates) {
    try { return require(c); } catch (_) {}
  }
  return require('better-sqlite3');
}

const Database = loadBetterSqlite3();
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT, name TEXT, barcode TEXT, price REAL DEFAULT 0, price_rial INTEGER DEFAULT 0,
    cost REAL DEFAULT 0, stock REAL DEFAULT 0, colors INTEGER DEFAULT 1,
    pack_size INTEGER DEFAULT 1, unit TEXT DEFAULT 'عدد', warehouse_id INTEGER,
    is_style INTEGER DEFAULT 0, has_variants INTEGER DEFAULT 0, default_variant_id INTEGER
  );
  CREATE TABLE warehouse_stock (
    product_id INTEGER NOT NULL, warehouse_id INTEGER NOT NULL, qty REAL DEFAULT 0,
    PRIMARY KEY (product_id, warehouse_id)
  );
  CREATE TABLE variant_warehouse_stock (
    variant_id INTEGER NOT NULL, warehouse_id INTEGER NOT NULL, qty REAL DEFAULT 0,
    PRIMARY KEY (variant_id, warehouse_id)
  );
`);
const { initProductVariantsSchema } = require('../lib/product-variants');
const { generateMatrix } = require('../lib/product-variants/service');
// P1: applyStockMatrix is structure-only in production; fixtures seed cache layers directly.
const applyStockMatrix = (...a) => require('./test-helpers/matrix-seed').seedMatrixQty(...a);
initProductVariantsSchema(db);

const productId = db.prepare(
  "INSERT INTO products (code,name,price,stock,pack_size,unit,warehouse_id) VALUES ('7141','اورکت',1000,0,1,'عدد',1)"
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
], { warehouse_id: 1 });

const creamVars = db.prepare(`
  SELECT id FROM product_variants
  WHERE product_id=? AND color_id=? AND COALESCE(is_default,0)=0
`).all(productId, cream.id);
const putWh = db.prepare(`
  INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,?)
  ON CONFLICT(variant_id, warehouse_id) DO UPDATE SET qty=excluded.qty
`);
for (const row of creamVars) putWh.run(row.id, 2, 1);
db.prepare(`
  UPDATE product_variants SET stock=1, active=1, status='active'
  WHERE product_id=? AND color_id=? AND COALESCE(is_default,0)=0
`).run(productId, cream.id);
db.prepare(`
  INSERT INTO product_style_colors (product_id, color_id, sort_order) VALUES (?,?,0)
  ON CONFLICT(product_id, color_id) DO NOTHING
`).run(productId, cream.id);

applyStockMatrix(db, productId, [
  { color_id: black.id, size_id: s1.id, qty: 9 },
  { color_id: black.id, size_id: s2.id, qty: 8 },
], { warehouse_id: 1 });

const creamLeft = db.prepare(`
  SELECT COUNT(*) c FROM product_variants
  WHERE product_id=? AND color_id=? AND active=1 AND COALESCE(is_default,0)=0
`).get(productId, cream.id).c;
const creamWh2 = db.prepare(`
  SELECT COALESCE(SUM(vws.qty),0) q
  FROM variant_warehouse_stock vws
  JOIN product_variants v ON v.id=vws.variant_id
  WHERE v.product_id=? AND v.color_id=? AND vws.warehouse_id=2
`).get(productId, cream.id).q;
const creamWh1 = db.prepare(`
  SELECT COALESCE(SUM(vws.qty),0) q
  FROM variant_warehouse_stock vws
  JOIN product_variants v ON v.id=vws.variant_id
  WHERE v.product_id=? AND v.color_id=? AND vws.warehouse_id=1
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
  WHERE v.product_id=? AND v.color_id=? AND vws.warehouse_id=1
`).get(productId, black.id).q;
ok(Number(blackWh1) === 17, 'موجودی مشکی همین انبار دست نمی‌خورد', blackWh1);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
