'use strict';
/**
 * W1-APP1 — 4 colors × 6 sizes = 24 SKUs + stock isolation.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

let passed = 0;
let failed = 0;
function ok(name, cond) {
  if (cond) { passed += 1; console.log(`  PASS ${name}`); }
  else { failed += 1; console.error(`  FAIL ${name}`); }
}

// Stock single source: boot the REAL schema (it owns inventory_ledger + the derived caches); variant stock
// changes go through adjustVariantStock → an 'adjustment' ledger row stamped with the variant.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w1-app1-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'test-product-variants-secret-32chars!!!!!';
process.env.AUTH_SESSION_DB_PATH = path.join(tmp, 'sessions.db');
process.env.NODE_ENV = 'test';
const { getDB, initDB } = require('../db');
initDB();
const db = getDB();
const {
  generateMatrix,
  adjustVariantStock,
} = require('../lib/product-variants');

const adminId = Number(db.prepare("INSERT INTO users (name, username, password, role, active, must_change_password) VALUES ('مدیر','pv_admin','x','admin',1,0)").run().lastInsertRowid);
const whId = Number(db.prepare("INSERT INTO warehouses (name, code, active, allow_negative, warehouse_type, inventory_system) VALUES ('FG','PV-FG',1,1,'finished_goods','perpetual')").run().lastInsertRowid);
const style = db.prepare(
  "INSERT INTO products (user_id, code, name, price, stock, unit, warehouse_id, average_cost_rial, cost) VALUES (?, 'STY1','مدل تست',100000,0,'عدد',?,1000,1000)"
).run(adminId, whId);
const productId = style.lastInsertRowid;
const colors = [
  { code: 'C1', name: 'قرمز' },
  { code: 'C2', name: 'آبی' },
  { code: 'C3', name: 'سبز' },
  { code: 'C4', name: 'مشکی' },
];
const sizes = [
  { code: 'S', name: 'S' },
  { code: 'M', name: 'M' },
  { code: 'L', name: 'L' },
  { code: 'XL', name: 'XL' },
  { code: 'XXL', name: 'XXL' },
  { code: '3XL', name: '3XL' },
];

console.log('W1-APP1 test-product-variants');
const result = generateMatrix(db, { product_id: productId, colors, sizes });
const matrixRows = db.prepare(`
  SELECT * FROM product_variants
  WHERE product_id=? AND color_id IS NOT NULL AND size_id IS NOT NULL AND active=1
`).all(productId);
ok('exactly 24 matrix SKUs', matrixRows.length === 24);
ok('generateMatrix ran', !!result);

const a = matrixRows[0];
const b = matrixRows[1];
const stockA0 = Number(a.stock) || 0;
const stockB0 = Number(b.stock) || 0;

adjustVariantStock(db, a.id, 5, 'delta', { warehouseId: whId, userId: adminId });
const a1 = db.prepare('SELECT stock FROM product_variants WHERE id=?').get(a.id);
const b1 = db.prepare('SELECT stock FROM product_variants WHERE id=?').get(b.id);
ok('SKU A stock increased', Number(a1.stock) === stockA0 + 5);
ok('SKU B unchanged', Number(b1.stock) === stockB0);

let matrixCap = false;
try {
  const manyColors = Array.from({ length: 26 }, (_, i) => ({ code: `X${i}`, name: `C${i}` }));
  const manySizes = Array.from({ length: 20 }, (_, i) => ({ code: `Z${i}`, name: `S${i}` }));
  generateMatrix(db, { product_id: productId, colors: manyColors, sizes: manySizes });
} catch (e) {
  matrixCap = e.code === 'VARIANT_MATRIX_TOO_LARGE' || (e.status === 400 && /500/.test(String(e.message)));
}
ok('matrix >500 rejected', matrixCap);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
