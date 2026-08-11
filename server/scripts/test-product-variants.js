'use strict';
/**
 * W1-APP1 — 4 colors × 6 sizes = 24 SKUs + stock isolation.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

function loadBetterSqlite3() {
  const candidates = [
    path.join(__dirname, '..', 'node_modules', 'better-sqlite3'),
    'D:/soft/Claud/porje/crm-taranom/erp-taranom1/server/node_modules/better-sqlite3',
  ];
  for (const c of candidates) {
    try { return require(c); } catch (_) {}
  }
  return require('better-sqlite3');
}
const Database = loadBetterSqlite3();
const {
  initProductVariantsSchema,
  generateMatrix,
  adjustVariantStock,
  listVariants,
} = require('../lib/product-variants');

let passed = 0;
let failed = 0;
function ok(name, cond) {
  if (cond) { passed += 1; console.log(`  PASS ${name}`); }
  else { failed += 1; console.error(`  FAIL ${name}`); }
}

const dbPath = path.join(os.tmpdir(), `w1-app1-${Date.now()}.db`);
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT, name TEXT, barcode TEXT,
    price REAL DEFAULT 0, price_rial INTEGER DEFAULT 0, cost REAL DEFAULT 0, stock REAL DEFAULT 0
  );
`);

initProductVariantsSchema(db);
const style = db.prepare(
  "INSERT INTO products (code, name, price, stock) VALUES ('STY1','مدل تست',100000,0)"
).run();
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

if (typeof adjustVariantStock === 'function') {
  adjustVariantStock(db, a.id, 5, 'delta');
} else {
  db.prepare('UPDATE product_variants SET stock=stock+? WHERE id=?').run(5, a.id);
}
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

db.close();
try { fs.unlinkSync(dbPath); } catch (_) {}
console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
