'use strict';
/**
 * Regression: a newly-added zero-stock color survives the product save and delayed website drain.
 * Run: node server/scripts/test-new-color-persists-on-save.js
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'new-color-save-'));
process.env.DB_PATH = path.join(dir, 'erp.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-new-color-persists-secret-32!!';

delete require.cache[require.resolve('../db')];
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

let passed = 0;
let failed = 0;
function ok(condition, label, detail) {
  if (condition) {
    passed += 1;
    console.log('  OK', label);
  } else {
    failed += 1;
    console.log(' FAIL', label, detail == null ? '' : JSON.stringify(detail));
  }
}

const authMw = require('../middleware/auth');
const admin = db.prepare("SELECT id,name FROM users WHERE role='admin' ORDER BY id LIMIT 1").get()
  || { id: 1, name: 'admin' };
authMw.auth = (req, _res, next) => {
  req.user = { id: admin.id, name: admin.name, role: 'admin' };
  next();
};

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/product-variants', require('../routes/product-variants'));

const variants = require('../lib/product-variants/service');

async function main() {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (url, body) => {
    const response = await fetch(base + url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await response.json(); } catch (_) { /* assertion reports null */ }
    return { status: response.status, data };
  };

  try {
    const warehouseId = Number(db.prepare(
      "INSERT INTO warehouses (name, allow_negative) VALUES ('انبار تست رنگ جدید',0)"
    ).run().lastInsertRowid);
    const productId = Number(db.prepare(`
      INSERT INTO products
        (user_id,name,code,price,stock,unit,average_cost_rial,cost,warehouse_id)
      VALUES (?,?,?,?,0,'عدد',1000,100,?)
    `).run(admin.id, 'مدل تست رنگ جدید', 'NEW-COLOR-SAVE', 100000, warehouseId).lastInsertRowid);
    const colorA = Number(db.prepare(
      "INSERT INTO product_colors (code,name,sort_order,active) VALUES ('A','رنگ الف',0,1)"
    ).run().lastInsertRowid);
    const colorB = Number(db.prepare(
      "INSERT INTO product_colors (code,name,sort_order,active) VALUES ('B','رنگ ب',1,1)"
    ).run().lastInsertRowid);
    const sizeS = Number(db.prepare(
      "INSERT INTO product_sizes (code,name,sort_order,active) VALUES ('S','S',0,1)"
    ).run().lastInsertRowid);
    const sizeM = Number(db.prepare(
      "INSERT INTO product_sizes (code,name,sort_order,active) VALUES ('M','M',1,1)"
    ).run().lastInsertRowid);

    const generateA = await call('/api/product-variants/generate-matrix', {
      product_id: productId, color_ids: [colorA], size_ids: [sizeS, sizeM],
    });
    ok(generateA.status === 201, 'ماتریس اولیهٔ رنگ الف ساخته شد', generateA);

    const cellsA = [
      { color_id: colorA, size_id: sizeS, qty: 4 },
      { color_id: colorA, size_id: sizeM, qty: 3 },
    ];
    const seedA = await call('/api/product-variants/stock-matrix', {
      product_id: productId, warehouse_id: warehouseId, cells: cellsA,
    });
    ok(seedA.status === 200, 'رنگ الف از مسیر واقعی stock-matrix موجودی گرفت', seedA);

    const generateB = await call('/api/product-variants/generate-matrix', {
      product_id: productId,
      color_ids: [colorA, colorB],
      size_ids: [sizeS, sizeM],
      auto_barcode: true,
    });
    ok(generateB.status === 201, 'رنگ ب در درخواست generate-matrix اضافه شد', generateB);
    ok(
      Array.isArray(generateB.data && generateB.data.kept_new_color_ids)
        && generateB.data.kept_new_color_ids.includes(colorB),
      'پاسخ generate-matrix شامل kept_new_color_ids رنگ ب است',
      generateB.data
    );
    ok(
      typeof (generateB.data && generateB.data.zero_color_hint_fa) === 'string',
      'پاسخ generate-matrix راهنمای فارسی رنگ صفر دارد',
      generateB.data
    );

    const allCells = [
      ...cellsA,
      { color_id: colorB, size_id: sizeS, qty: 0 },
      { color_id: colorB, size_id: sizeM, qty: 0 },
    ];
    const structure = await call('/api/product-variants/stock-matrix', {
      product_id: productId,
      warehouse_id: warehouseId,
      structure_only: true,
      cells: allCells,
    });
    ok(structure.status === 200, 'ذخیرهٔ structure_only موفق شد', structure);
    ok(
      Array.isArray(structure.data && structure.data.kept_new_color_ids)
        && structure.data.kept_new_color_ids.includes(colorB),
      'پاسخ stock-matrix شامل kept_new_color_ids رنگ ب است',
      structure.data
    );
    const activeFor = (colorId) => db.prepare(`
      SELECT active FROM product_variants
      WHERE product_id=? AND color_id=? AND COALESCE(is_default,0)=0
      ORDER BY id
    `).all(productId, colorId);
    ok(
      activeFor(colorB).length === 2 && activeFor(colorB).every((row) => Number(row.active) === 1),
      'رنگ ب بعد از همان ذخیره فعال ماند',
      activeFor(colorB)
    );

    const changeA = await call('/api/product-variants/stock-matrix', {
      product_id: productId,
      warehouse_id: warehouseId,
      cells: allCells.map((cell) => (
        cell.color_id === colorA && cell.size_id === sizeS ? { ...cell, qty: 5 } : cell
      )),
    });
    ok(changeA.status === 200, 'تغییر موجودی رنگ الف موفق شد', changeA);
    ok(
      activeFor(colorB).every((row) => Number(row.active) === 1),
      'تغییر موجودی رنگ الف، رنگ ب را خاموش نکرد',
      activeFor(colorB)
    );

    const drainLike = variants.retireZeroStockColors(db, productId);
    ok(
      !drainLike.retired.includes(colorB)
        && activeFor(colorB).every((row) => Number(row.active) === 1),
      'مسیر مشابه drain رنگ ب بدون سابقه را نگه داشت',
      drainLike
    );

    const stockB = await call('/api/product-variants/stock-matrix', {
      product_id: productId,
      warehouse_id: warehouseId,
      cells: allCells.map((cell) => {
        if (cell.color_id === colorA && cell.size_id === sizeS) return { ...cell, qty: 5 };
        if (cell.color_id === colorB && cell.size_id === sizeS) return { ...cell, qty: 2 };
        return cell;
      }),
    });
    ok(stockB.status === 200, 'رنگ ب واقعاً موجودی گرفت', stockB);
    const zeroB = await call('/api/product-variants/stock-matrix', {
      product_id: productId,
      warehouse_id: warehouseId,
      cells: allCells.map((cell) => (
        cell.color_id === colorA && cell.size_id === sizeS ? { ...cell, qty: 5 } : cell
      )),
    });
    ok(zeroB.status === 200, 'موجودی رنگ ب دوباره دقیقاً صفر شد', zeroB);
    ok(
      activeFor(colorB).every((row) => Number(row.active) === 0),
      'رنگ ب پس از داشتن موجودی و بازگشت به صفر بازنشسته شد',
      activeFor(colorB)
    );
  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error('FATAL', error && error.stack || error);
  process.exit(2);
});
