'use strict';
/**
 * Zero company-wide color stock leaves the product's color rows.
 * Run: node server/scripts/test-zero-color-row-v316.js
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
ok(appJs.includes('function prodLiveColorIds'), 'فرم فقط رنگ دارای موجودی را تیک می‌زند');
ok(appJs.includes('stock_global'), 'موجودی سراسری رنگ از موجودی یک انبار جدا است');
ok(serviceSrc.includes('function retireZeroStockColors'), 'صفر شدن رنگ در سرور از کالا جدا می‌شود');
ok(appJs.includes('از تیک‌ها و جدول همین کالا حذف می‌شود'), 'راهنما حذف ردیف رنگ صفر را می‌گوید');

// Stock single source: boot the REAL schema (it owns inventory_ledger + derived caches); matrix quantities are
// ledger 'adjustment' documents (test-helpers/matrix-seed), never hand-written cache rows.
const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zc316-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'test-zc316-secret-32chars!!!!!!!!!!!!!';
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
  `INSERT INTO products (user_id,code,name,price,stock,pack_size,unit,warehouse_id,average_cost_rial,cost) VALUES (${adminId},'K-ZERO','مانتو',1000,0,1,'عدد',${wh1},1000,1000)`
).run().lastInsertRowid;
generateMatrix(db, {
  product_id: productId,
  colors: [{ name: 'صورتی' }, { name: 'مشکی' }],
  sizes: [{ name: 'سایز 1' }, { name: 'سایز 2' }],
});
const colors = db.prepare('SELECT id,name,active FROM product_colors').all();
const sizes = db.prepare('SELECT id,name FROM product_sizes').all();
const pink = colors.find((c) => c.name === 'صورتی');
const black = colors.find((c) => c.name === 'مشکی');
const s1 = sizes.find((s) => s.name === 'سایز 1');
const s2 = sizes.find((s) => s.name === 'سایز 2');

applyStockMatrix(db, productId, [
  { color_id: pink.id, size_id: s1.id, qty: 10 },
  { color_id: pink.id, size_id: s2.id, qty: 8 },
  { color_id: black.id, size_id: s1.id, qty: 5 },
  { color_id: black.id, size_id: s2.id, qty: 0 },
], { warehouse_id: wh1 });

const blackActivePartial = db.prepare(`
  SELECT COUNT(*) c FROM product_variants
  WHERE product_id=? AND color_id=? AND active=1 AND COALESCE(is_default,0)=0
`).get(productId, black.id).c;
ok(blackActivePartial === 2, 'صفر شدن یک سایز رنگ را حذف نمی‌کند', blackActivePartial);

const blackS1 = db.prepare(
  'SELECT id FROM product_variants WHERE product_id=? AND color_id=? AND size_id=? AND active=1'
).get(productId, black.id, s1.id);
adjustVariantStock(db, blackS1.id, 0, 'set', { warehouseId: wh1, userId: adminId });

const blackLeft = db.prepare(`
  SELECT COUNT(*) c FROM product_variants
  WHERE product_id=? AND color_id=? AND active=1 AND COALESCE(is_default,0)=0
`).get(productId, black.id).c;
const blackKept = db.prepare(`
  SELECT COUNT(*) c FROM product_variants
  WHERE product_id=? AND color_id=? AND COALESCE(is_default,0)=0
`).get(productId, black.id).c;
const blackStyle = db.prepare(
  'SELECT COUNT(*) c FROM product_style_colors WHERE product_id=? AND color_id=?'
).get(productId, black.id).c;
const blackMaster = db.prepare('SELECT active FROM product_colors WHERE id=?').get(black.id);
const pinkLeft = db.prepare(`
  SELECT COUNT(*) c FROM product_variants
  WHERE product_id=? AND color_id=? AND active=1 AND COALESCE(is_default,0)=0
`).get(productId, pink.id).c;
ok(blackLeft === 0, 'موجودی صفرِ همه سایزها رنگ را از ردیف‌های کالا برمی‌دارد', blackLeft);
ok(blackKept === 2, 'واریانت برای فاکتور قبلی حذف فیزیکی نمی‌شود', blackKept);
ok(blackStyle === 1, 'P1: پیوند رنگ با کالا حذف نمی‌شود (soft-retire، فقط واریانت غیرفعال)', blackStyle);
ok(blackMaster && Number(blackMaster.active) === 1, 'رنگ در فهرست رنگ‌ها می‌ماند', blackMaster);
ok(pinkLeft === 2, 'رنگ دارای موجودی می‌ماند', pinkLeft);

const back = applyStockMatrix(db, productId, [
  { color_id: pink.id, size_id: s1.id, qty: 10 },
  { color_id: pink.id, size_id: s2.id, qty: 8 },
  { color_id: black.id, size_id: s1.id, qty: 4 },
  { color_id: black.id, size_id: s2.id, qty: 0 },
], { warehouse_id: wh1 });
const blackBack = db.prepare(`
  SELECT COUNT(*) c FROM product_variants
  WHERE product_id=? AND color_id=? AND active=1 AND COALESCE(is_default,0)=0
`).get(productId, black.id).c;
ok(blackBack === 2 && back.pack.live_colors === 2, 'تیک دوباره همان رنگ را برمی‌گرداند', { blackBack, pack: back.pack });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
