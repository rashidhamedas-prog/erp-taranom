'use strict';
/**
 * Regression: colours with leftover VWS=0 + opening_seed (unallocated live ledger)
 * survive generate-matrix + structure_only stock-matrix + drain-equivalent retire.
 * Run (Node 20): node server/scripts/test-variant-save-history-zero-persists.js
 *
 * Never uses product ids 100 / 151 / 342 as fixtures.
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'variant-save-hist-'));
process.env.DB_PATH = path.join(dir, 'erp.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-variant-save-hist-secret-32chars!!';

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

/** Mirror website-stock-sync.js after push.ok — keep-set then retire. */
function drainLikeRetire(dbConn, productId, payload) {
  const keepColorIds = [
    ...variants.keepColorIdsForPostPushRetire(dbConn, productId),
    ...variants.keepColorIdsFromPushPayload(dbConn, productId, payload || null),
  ];
  return variants.retireZeroStockColors(dbConn, productId, { keepColorIds });
}

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
  const get = async (url) => {
    const response = await fetch(base + url);
    let data = null;
    try { data = await response.json(); } catch (_) { /* null */ }
    return { status: response.status, data };
  };

  try {
    // Enable website push so afterVariantStockWrite defers (same as production 100102).
    db.prepare(`
      INSERT INTO settings (key,value) VALUES ('website_stock_sync_enabled','1')
      ON CONFLICT(key) DO UPDATE SET value='1'
    `).run();
    db.prepare(`
      INSERT INTO settings (key,value) VALUES ('website_stock_sync_mode','push')
      ON CONFLICT(key) DO UPDATE SET value='push'
    `).run();

    const warehouseId = Number(db.prepare(
      "INSERT INTO warehouses (name, allow_negative) VALUES ('انبار تست تاریخچه صفر',0)"
    ).run().lastInsertRowid);

    const productId = Number(db.prepare(`
      INSERT INTO products
        (user_id,name,code,price,stock,unit,average_cost_rial,cost,warehouse_id,has_variants,is_style,website_stock_push)
      VALUES (?,?,?,?,148,'عدد',1000,100,?,1,1,1)
    `).run(admin.id, 'مدل تست ذخیره تاریخچه صفر', 'HIST-ZERO-SAVE', 100000, warehouseId).lastInsertRowid);

    ok(productId !== 100 && productId !== 151 && productId !== 342,
      'فیکسچر از شناسه‌های ممنوعهٔ ۱۰۰/۱۵۱/۳۴۲ استفاده نمی‌کند', productId);
    ok(!db.prepare('SELECT 1 FROM products WHERE id=342').get(),
      'محصول ۳۴۲ در DB موقت نیست یا دست‌نخورده می‌ماند');

    const colorKeepA = Number(db.prepare(
      "INSERT INTO product_colors (code,name,sort_order,active) VALUES ('HZ-A','رنگ نگه‌دار الف',0,1)"
    ).run().lastInsertRowid);
    const colorKeepB = Number(db.prepare(
      "INSERT INTO product_colors (code,name,sort_order,active) VALUES ('HZ-B','رنگ نگه‌دار ب',1,1)"
    ).run().lastInsertRowid);
    const colorControl = Number(db.prepare(
      "INSERT INTO product_colors (code,name,sort_order,active) VALUES ('HZ-C','رنگ کنترل فروش‌رفته',2,1)"
    ).run().lastInsertRowid);
    const size1 = Number(db.prepare(
      "INSERT INTO product_sizes (code,name,sort_order,active) VALUES ('HZ1','سایز ۱',0,1)"
    ).run().lastInsertRowid);
    const size2 = Number(db.prepare(
      "INSERT INTO product_sizes (code,name,sort_order,active) VALUES ('HZ2','سایز ۲',1,1)"
    ).run().lastInsertRowid);

    // Default + 2×2 matrix (inactive) + style rows — like 100102 before save.
    variants.ensureDefaultVariant(db, productId);
    const genSeed = variants.generateMatrix(db, {
      product_id: productId,
      color_ids: [colorKeepA, colorKeepB],
      size_ids: [size1, size2],
      auto_barcode: true,
      stock: 0,
    });
    ok(genSeed.created.length === 4 || genSeed.total_skus === 4, 'ماتریس ۲×۲ اولیه ساخته شد', genSeed);

    const matrixRows = db.prepare(`
      SELECT * FROM product_variants
      WHERE product_id=? AND COALESCE(is_default,0)=0
      ORDER BY id
    `).all(productId);
    ok(matrixRows.length === 4, 'چهار SKU ماتریس', matrixRows.length);

    // Deactivate all matrix SKUs (post-retire shape).
    db.prepare(`
      UPDATE product_variants SET active=0, status='inactive'
      WHERE product_id=? AND COALESCE(is_default,0)=0
    `).run(productId);

    // Style attachments remain (soft retire keeps them).
    for (const [cid, ord] of [[colorKeepA, 0], [colorKeepB, 1]]) {
      variants.attachStyleColor(db, productId, cid, ord);
    }
    for (const [sid, ord] of [[size1, 0], [size2, 1]]) {
      variants.attachStyleSize(db, productId, sid, ord);
    }

    // Unallocated posted ledger (variant_id NULL) — live stock on product, not on colours.
    const jeId = Number(db.prepare(`
      INSERT INTO journal_entries (entry_date, description, status, created_by, voucher_number)
      VALUES ('1405/06/31','افتتاحیه تست تاریخچه صفر','approved',?,'JE-HZ-OPEN')
    `).run(admin.id).lastInsertRowid);
    db.prepare(`
      INSERT INTO inventory_ledger
        (tx_no,event_type,product_id,warehouse_id,variant_id,qty_in,qty_out,qty_balance,
         unit_cost_rial,amount_rial,status,date,je_id)
      VALUES ('HZ-OPEN-1','opening',?,?,NULL,148,0,148,1000,148000,'posted','1405/06/31',?)
    `).run(productId, warehouseId, jeId);

    const ledgerBefore = db.prepare(`
      SELECT id, qty_in, variant_id, je_id FROM inventory_ledger WHERE product_id=? ORDER BY id
    `).all(productId);
    ok(ledgerBefore.length === 1
      && Number(ledgerBefore[0].qty_in) === 148
      && ledgerBefore[0].variant_id == null
      && Number(ledgerBefore[0].je_id) === jeId,
      'یک ردیف کاردکس بی‌واریانت با ۱۴۸ واحد', ledgerBefore);

    // Poison: VWS qty 0 + opening_seed movements summing to 148 (cache backfill).
    const seedQtys = [40, 34, 37, 37]; // sum 148
    ok(seedQtys.reduce((a, b) => a + b, 0) === 148, 'جمع opening_seed = ۱۴۸');
    const upsertVws = db.prepare(`
      INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty)
      VALUES (?,?,0)
      ON CONFLICT(variant_id, warehouse_id) DO UPDATE SET qty=0
    `);
    const insMov = db.prepare(`
      INSERT INTO inventory_movements
        (product_id, variant_id, warehouse_id, qty_delta, doc_type, doc_id, note)
      VALUES (?,?,?,?, 'opening_seed', NULL, 'cache backfill fixture')
    `);
    matrixRows.forEach((row, i) => {
      upsertVws.run(row.id, warehouseId);
      insMov.run(productId, row.id, warehouseId, seedQtys[i] || 0);
    });

    // History must NOT treat bare VWS=0 / opening_seed as stocked.
    ok(
      matrixRows.every((row) => !variants.variantHasStockHistory(db, row)),
      'variantHasStockHistory برای VWS=0 + opening_seed نادرست است',
      matrixRows.map((r) => ({ id: r.id, hist: variants.variantHasStockHistory(db, r) }))
    );

    const cells = [];
    for (const cid of [colorKeepA, colorKeepB]) {
      for (const sid of [size1, size2]) {
        cells.push({ color_id: cid, size_id: sid, qty: 0 });
      }
    }

    const generate = await call('/api/product-variants/generate-matrix', {
      product_id: productId,
      color_ids: [colorKeepA, colorKeepB],
      size_ids: [size1, size2],
      auto_barcode: true,
    });
    ok(generate.status === 201, 'generate-matrix 201', generate);
    ok(
      Number(generate.data && generate.data.created && generate.data.created.length) === 0
        || (generate.data && generate.data.existing && generate.data.existing.length >= 4),
      'SKUهای موجود دوباره ساخته نشدند (created≈0)',
      { created: generate.data && generate.data.created, existing: generate.data && generate.data.existing }
    );

    const structure = await call('/api/product-variants/stock-matrix', {
      product_id: productId,
      warehouse_id: warehouseId,
      structure_only: true,
      cells,
    });
    ok(structure.status === 200, 'stock-matrix structure_only 200', structure);

    const activeFor = (colorId) => db.prepare(`
      SELECT active FROM product_variants
      WHERE product_id=? AND color_id=? AND COALESCE(is_default,0)=0
      ORDER BY id
    `).all(productId, colorId);

    ok(
      activeFor(colorKeepA).every((r) => Number(r.active) === 1)
        && activeFor(colorKeepB).every((r) => Number(r.active) === 1),
      'بعد از generate+structure ماتریس انتخاب‌شده فعال است',
      { a: activeFor(colorKeepA), b: activeFor(colorKeepB) }
    );

    // Bare drain (no keep) — must keep after history tightening.
    const bareRetire = variants.retireZeroStockColors(db, productId);
    ok(
      !bareRetire.retired.includes(colorKeepA)
        && !bareRetire.retired.includes(colorKeepB)
        && activeFor(colorKeepA).every((r) => Number(r.active) === 1)
        && activeFor(colorKeepB).every((r) => Number(r.active) === 1),
      'retire بدون keep-set رنگ‌های بدون تاریخچهٔ واقعی را نگه می‌دارد',
      bareRetire
    );

    // Drain-equivalent with keep helper (website path).
    const activeMatrix = db.prepare(`
      SELECT sku FROM product_variants
      WHERE product_id=? AND COALESCE(is_default,0)=0 AND active=1
    `).all(productId);
    const fakePayload = {
      variants: activeMatrix.map((r) => ({ erpVariantSku: r.sku, qty: 0 })),
    };
    const drainRetire = drainLikeRetire(db, productId, fakePayload);
    ok(
      !drainRetire.retired.includes(colorKeepA)
        && !drainRetire.retired.includes(colorKeepB),
      'مسیر مشابه drain وب‌سایت رنگ‌های انتخاب‌شده را نگه می‌دارد',
      drainRetire
    );

    const ledgerAfter = db.prepare(`
      SELECT id, qty_in, variant_id, je_id FROM inventory_ledger WHERE product_id=? ORDER BY id
    `).all(productId);
    ok(
      ledgerAfter.length === ledgerBefore.length
        && Number(ledgerAfter[0].qty_in) === 148
        && ledgerAfter[0].variant_id == null
        && Number(ledgerAfter[0].je_id) === jeId,
      'کاردکس/JE بدون تغییر ماند',
      ledgerAfter
    );
    const jeCount = db.prepare('SELECT COUNT(*) AS c FROM journal_entries WHERE id=?').get(jeId).c;
    ok(jeCount === 1, 'هیچ JE جدیدی ساخته نشد');

    // Control: colour with real ledger.variant_id history, all sizes 0, removed from style → retired.
    const ctrlGen = variants.generateMatrix(db, {
      product_id: productId,
      color_ids: [colorKeepA, colorKeepB, colorControl],
      size_ids: [size1, size2],
      auto_barcode: true,
      stock: 0,
    });
    ok(ctrlGen.created.length >= 2 || ctrlGen.existing.length >= 2, 'رنگ کنترل به ماتریس اضافه شد', ctrlGen);
    const ctrlSkus = db.prepare(`
      SELECT * FROM product_variants
      WHERE product_id=? AND color_id=? AND COALESCE(is_default,0)=0
    `).all(productId, colorControl);
    ok(ctrlSkus.length === 2, 'دو SKU رنگ کنترل', ctrlSkus.length);
    for (const v of ctrlSkus) {
      db.prepare(`
        INSERT INTO inventory_ledger
          (tx_no,event_type,product_id,warehouse_id,variant_id,qty_in,qty_out,qty_balance,
           unit_cost_rial,amount_rial,status,date)
        VALUES (?,?,?,?,?,1,1,0,1000,0,'posted','1405/07/01')
      `).run(`HZ-CTRL-${v.id}`, 'adjustment', productId, warehouseId, v.id);
      db.prepare("UPDATE product_variants SET stock=0, active=1, status='active' WHERE id=?").run(v.id);
    }
    db.prepare('DELETE FROM product_style_colors WHERE product_id=? AND color_id=?')
      .run(productId, colorControl);
    // Drop control from keep by ensuring style no longer lists it; bare+drain should retire it.
    const controlRetire = variants.retireZeroStockColors(db, productId);
    ok(
      controlRetire.retired.includes(colorControl),
      'رنگ کنترل با تاریخچهٔ ledger و خارج از style بازنشسته می‌شود',
      controlRetire
    );
    ok(
      activeFor(colorKeepA).every((r) => Number(r.active) === 1)
        && activeFor(colorKeepB).every((r) => Number(r.active) === 1),
      'رنگ‌های سبک پس از retire کنترل همچنان فعال‌اند'
    );

    // Style API exposes style_color_ids even when only inactive SKUs remain for a colour.
    db.prepare(`
      UPDATE product_variants SET active=0, status='inactive'
      WHERE product_id=? AND color_id=? AND COALESCE(is_default,0)=0
    `).run(productId, colorControl);
    // Re-attach keep colours (already there) and fetch style.
    const styleGet = await get(`/api/product-variants/style/${productId}?warehouse_id=${warehouseId}`);
    ok(styleGet.status === 200, 'GET style 200', styleGet.status);
    const styleIds = (styleGet.data && styleGet.data.style_color_ids) || [];
    ok(
      styleIds.includes(colorKeepA) && styleIds.includes(colorKeepB),
      'style_color_ids رنگ‌های سبک را برمی‌گرداند',
      styleIds
    );
    ok(
      Array.isArray(styleGet.data && styleGet.data.style_size_ids)
        && styleGet.data.style_size_ids.includes(size1)
        && styleGet.data.style_size_ids.includes(size2),
      'style_size_ids سایزهای سبک را برمی‌گرداند',
      styleGet.data && styleGet.data.style_size_ids
    );

    // Product 342 never written.
    ok(!db.prepare('SELECT 1 FROM products WHERE id=342').get()
      || db.prepare('SELECT code,stock FROM products WHERE id=342').get().code === '7217',
      'محصول ۳۴۲ دست‌نخورده / غایب');
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
