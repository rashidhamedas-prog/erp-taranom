'use strict';
/**
 * Color×size warehouse report.
 * Run: node server/scripts/test-variant-stock-report.js
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { buildVariantStockReport } = require('../lib/inventory/variant-report');

const testDb = path.join(__dirname, '_variant-stock-report-test.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch (_) {}
}

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}

const db = new Database(testDb);
db.exec(`
  CREATE TABLE warehouses (id INTEGER PRIMARY KEY, name TEXT, code TEXT, active INTEGER DEFAULT 1);
  CREATE TABLE product_categories (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE products (
    id INTEGER PRIMARY KEY, code TEXT, name TEXT, category TEXT, category_id INTEGER,
    cost REAL DEFAULT 0, price REAL DEFAULT 0, price_rial INTEGER DEFAULT 0,
    stock REAL DEFAULT 0, warehouse_id INTEGER
  );
  CREATE TABLE product_colors (
    id INTEGER PRIMARY KEY, name TEXT, hex TEXT, sort_order INTEGER DEFAULT 0, active INTEGER DEFAULT 1
  );
  CREATE TABLE product_sizes (
    id INTEGER PRIMARY KEY, name TEXT, sort_order INTEGER DEFAULT 0, active INTEGER DEFAULT 1
  );
  CREATE TABLE product_variants (
    id INTEGER PRIMARY KEY, product_id INTEGER, color_id INTEGER, size_id INTEGER,
    sku TEXT, cost REAL DEFAULT 0, price REAL DEFAULT 0, price_rial INTEGER DEFAULT 0,
    stock REAL DEFAULT 0, active INTEGER DEFAULT 1, is_default INTEGER DEFAULT 0
  );
  CREATE TABLE variant_warehouse_stock (
    variant_id INTEGER, warehouse_id INTEGER, qty REAL, PRIMARY KEY (variant_id, warehouse_id)
  );
`);

const wh1 = db.prepare("INSERT INTO warehouses (name, code) VALUES ('محصول','FG')").run().lastInsertRowid;
const wh2 = db.prepare("INSERT INTO warehouses (name, code) VALUES ('شعبه','BR')").run().lastInsertRowid;
const cat = db.prepare("INSERT INTO product_categories (name) VALUES ('مانتو')").run().lastInsertRowid;
const black = db.prepare("INSERT INTO product_colors (name, hex, sort_order) VALUES ('مشکی','#111111',1)").run().lastInsertRowid;
const white = db.prepare("INSERT INTO product_colors (name, hex, sort_order) VALUES ('سفید','#ffffff',2)").run().lastInsertRowid;
const blue = db.prepare("INSERT INTO product_colors (name, hex, sort_order) VALUES ('آبی','#2255aa',3)").run().lastInsertRowid;
const red = db.prepare("INSERT INTO product_colors (name, hex, sort_order) VALUES ('قرمز','#aa2222',4)").run().lastInsertRowid;
const s38 = db.prepare("INSERT INTO product_sizes (name, sort_order) VALUES ('38',1)").run().lastInsertRowid;
const s40 = db.prepare("INSERT INTO product_sizes (name, sort_order) VALUES ('40',2)").run().lastInsertRowid;

const p1 = db.prepare(
  "INSERT INTO products (code, name, category_id, cost, price_rial, warehouse_id) VALUES ('M-1','مانتو لینن',?,100,250,?)"
).run(cat, wh1).lastInsertRowid;
const p2 = db.prepare(
  "INSERT INTO products (code, name, cost, price_rial, warehouse_id, stock) VALUES ('S-1','شال',50,80,?,10)"
).run(wh1).lastInsertRowid;
const p3 = db.prepare(
  "INSERT INTO products (code, name, cost, price_rial, warehouse_id) VALUES ('SH-1','شومیز',10,20,?)"
).run(wh1).lastInsertRowid;

function addVariant(productId, colorId, sizeId, stock, flags) {
  const extra = flags || {};
  return db.prepare(`
    INSERT INTO product_variants (
      product_id, color_id, size_id, sku, cost, price_rial, stock, active, is_default
    ) VALUES (?,?,?,?,100,250,?,?,?)
  `).run(
    productId, colorId, sizeId, 'SKU-' + productId + '-' + colorId + '-' + sizeId,
    stock || 0, extra.active == null ? 1 : extra.active, extra.is_default ? 1 : 0
  ).lastInsertRowid;
}

const vBlack38 = addVariant(p1, black, s38, 999);
const vBlack40 = addVariant(p1, black, s40, 999);
const vWhite38 = addVariant(p1, white, s38, 999);
const vWhite40 = addVariant(p1, white, s40, 999);
addVariant(p1, blue, s38, 999);
addVariant(p1, blue, s40, 999);
addVariant(p1, black, null, 5000, { is_default: 1 });
addVariant(p1, red, s38, 70, { active: 0 });

db.prepare('INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,?)').run(vBlack38, wh1, 10);
db.prepare('INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,?)').run(vWhite38, wh1, 4);
db.prepare('INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,?)').run(vWhite40, wh1, 3);

const vRed38 = addVariant(p2, red, s38, 8);
const vRed40 = addVariant(p2, red, s40, 0);
db.prepare('UPDATE product_variants SET cost=50, price_rial=80 WHERE id IN (?,?)').run(vRed38, vRed40);

const vShirt38 = addVariant(p3, black, s38, 0);
const vShirt40 = addVariant(p3, black, s40, 0);
db.prepare('INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,?)').run(vShirt38, wh1, 5);
db.prepare('INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,?)').run(vShirt40, wh2, 2);

console.log('\n══ Variant stock report ══\n');

const mantel = buildVariantStockReport(db, { product_id: p1, low_qty: 5 });
ok(mantel.kpis.total_qty === 17, 'مانتو موجودی ۱۷ = ۱۰+۴+۳', mantel.kpis);
ok(mantel.kpis.sales_value_rial === 4250, 'ارزش فروش ۱۷×۲۵۰', mantel.kpis.sales_value_rial);
ok(mantel.kpis.cost_value_rial === 1700, 'ارزش موجودی ۱۷×۱۰۰', mantel.kpis.cost_value_rial);
ok(mantel.kpis.color_count === 2, 'دو رنگ دارای موجودی', mantel.kpis.color_count);
ok(mantel.kpis.sku_in_stock === 3, 'سه خانه موجود', mantel.kpis.sku_in_stock);
ok(mantel.kpis.sku_zero === 3, 'آبی هر دو سایز و مشکی ۴۰ صفرند', mantel.kpis.sku_zero);
ok(mantel.kpis.low_count === 2, 'آستانه ۵: سفید ۳۸ و ۴۰', mantel.kpis.low_count);
ok(mantel.kpis.gap_count === 1, 'فقط مشکی شکسته است', mantel.gaps);
ok(mantel.gaps[0] && mantel.gaps[0].color_name === 'مشکی' && mantel.gaps[0].missing[0].size_name === '40', 'سایز تمام‌شده مشکی ۴۰ است', mantel.gaps[0]);
ok(!mantel.cells.some((c) => c.qty === 5000 || c.qty === 70), 'پیش‌فرض و غیرفعال داخل گزارش نیستند');
const black40 = mantel.cells.find((c) => c.color_id === black && c.size_id === s40);
ok(black40 && black40.qty === 0 && black40.warehouse_id === wh1, 'نبود ردیف انبار برای مشکی ۴۰ صفر دیده می‌شود', black40);

const onlyBlack = buildVariantStockReport(db, { product_id: p1, color_id: black });
ok(onlyBlack.kpis.total_qty === 10, 'فیلتر رنگ مشکی فقط ۱۰', onlyBlack.kpis.total_qty);

const sized = buildVariantStockReport(db, { product_id: p1, size_id: s38 });
ok(sized.kpis.total_qty === 14, 'فیلتر سایز ۳۸ = ۱۰+۴', sized.kpis.total_qty);
ok(sized.kpis.gap_count === 1, 'شکستگی با فیلتر سایز پنهان نمی‌شود', sized.kpis.gap_count);
ok(Array.isArray(sized.matrix_cells) && sized.matrix_cells.some((c) => c.size_id === s40), 'ماتریس سایز فیلترشده را هم دارد');

const found = buildVariantStockReport(db, { q: 'لینن' });
ok(found.kpis.product_count === 1 && found.by_product[0].name === 'مانتو لینن', 'جستجوی نام کالا', found.by_product);
const none = buildVariantStockReport(db, { q: 'وجودندارد' });
ok(none.cells.length === 0 && none.options.products.length === 3, 'جستجوی بی‌نتیجه فهرست کالا را خالی نمی‌کند', none.options.products.length);

const scarf = buildVariantStockReport(db, { product_id: p2 });
ok(scarf.kpis.total_qty === 8, 'بدون ردیف انبار از موجودی واریانت خوانده می‌شود', scarf.kpis);
ok(scarf.kpis.gap_count === 1 && scarf.cells.every((c) => c.warehouse_name === 'محصول'), 'شال روی انبار خودش و شکسته است', scarf.gaps);
ok(scarf.kpis.sales_value_rial === 640, 'قیمت شال از واریانت است نه ۱۰۰', scarf.kpis.sales_value_rial);

const shirt = buildVariantStockReport(db, { product_id: p3 });
ok(shirt.kpis.total_qty === 7, 'دو انبار شومیز ۵+۲', shirt.kpis.total_qty);
ok(shirt.kpis.gap_count === 2, 'هر انبار یک سایز کم دارد', shirt.gaps.map((g) => g.warehouse_name + ':' + g.missing.map((m) => m.size_name).join(',')));
const shirtWh2 = buildVariantStockReport(db, { product_id: p3, warehouse_id: wh2 });
ok(shirtWh2.kpis.total_qty === 2 && shirtWh2.kpis.gap_count === 1, 'فیلتر شعبه فقط موجودی ۲ و شکستگی ۳۸', shirtWh2.kpis);

const catRep = buildVariantStockReport(db, { category: 'مانتو' });
ok(catRep.by_product.length === 1 && catRep.by_product[0].product_id === p1, 'فیلتر گروه', catRep.by_product);

db.close();
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch (_) {}
}
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
