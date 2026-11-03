'use strict';
/**
 * Stock single-source cache vs ledger reconciliation test (stock_cache_vs_ledger).
 * Run: node server/scripts/test-stock-cache-recon.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-cache-recon-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-stock-cache-recon-secret-32chars!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra != null ? JSON.stringify(extra) : ''); }
}

const authMw = require('../middleware/auth');
const ADMIN = db.prepare("SELECT id, role, name FROM users WHERE role='admin' ORDER BY id LIMIT 1").get()
  || { id: 1, role: 'admin', name: 'admin' };
authMw.auth = (req, _res, next) => { req.user = { id: ADMIN.id, role: 'admin', name: ADMIN.name }; next(); };

const recon = require('../lib/subledger-recon');
recon.ensureReconSchema(db);
const { postInventoryMovement } = require('../lib/inventory/ledger');
const {
  rebuildStockCache,
  withCacheWriter,
  stockCacheVsLedger,
  derivedQty,
  deriveProductStock,
} = require('../lib/inventory/stock-cache');
const { todayJalali } = require('../jalali');

async function main() {
  console.log('\n=== test-stock-cache-recon ===\n');
  const today = todayJalali();

  let wh1 = db.prepare('SELECT id FROM warehouses WHERE active=1 ORDER BY id LIMIT 1').get()?.id;
  if (!wh1) wh1 = Number(db.prepare("INSERT INTO warehouses (name, code, active) VALUES ('انبار ۱', 'WH1', 1)").run().lastInsertRowid);
  const wh2 = Number(db.prepare("INSERT INTO warehouses (name, code, active) VALUES ('انبار ۲', 'WH2', 1)").run().lastInsertRowid);

  // Align any pre-existing seed products first
  const { rebuildAllStockCaches } = require('../lib/inventory/stock-cache');
  rebuildAllStockCaches(db);

  // 1) Plain product + postInventoryMovement
  const pid = Number(db.prepare(`
    INSERT INTO products (user_id, name, code, price, cost, average_cost_rial, stock, warehouse_id, unit)
    VALUES (?, 'مانتو تست تطبیق', 'SCR-P1', 5000000, 1000000, 1000000, 0, ?, 'عدد')
  `).run(ADMIN.id, wh1).lastInsertRowid);

  postInventoryMovement(db, {
    eventType: 'receipt',
    productId: pid,
    warehouseId: wh1,
    qtyIn: 10,
    unitCostRial: 1000000,
    sourceType: 'warehouse_receipt',
    sourceId: 101,
    date: today,
    note: 'رسید تست ۱',
    createdBy: ADMIN.id,
  });
  postInventoryMovement(db, {
    eventType: 'sale',
    productId: pid,
    warehouseId: wh1,
    qtyOut: 3,
    unitCostRial: 1000000,
    sourceType: 'invoice',
    sourceId: 102,
    date: today,
    note: 'فروش تست ۱',
    createdBy: ADMIN.id,
  });
  rebuildStockCache(db, pid);

  ok(derivedQty(db, { productId: pid }) === 7, 'derivedQty product header = 7');
  ok(derivedQty(db, { productId: pid, warehouseId: wh1 }) === 7, 'derivedQty wh1 = 7');

  const runCheck = () => ({
    ...recon.runRecon(db, { checks: ['stock_cache_vs_ledger'], persist: false }).checks[0],
    rows: recon.checkRows(db, 'stock_cache_vs_ledger', { limit: 500 }).rows,
  });

  const c1 = runCheck();
  ok(c1.status === 'ok' && c1.mismatch_count === 0 && c1.rows.length === 0,
    'recon stock_cache_vs_ledger is ok when cache matches ledger', c1);

  // 2) Corrupt warehouse_stock directly via withCacheWriter
  withCacheWriter(db, () => {
    db.prepare('UPDATE warehouse_stock SET qty=19 WHERE product_id=? AND warehouse_id=?').run(pid, wh1);
    db.prepare('UPDATE products SET stock=19 WHERE id=?').run(pid);
  });

  const c2 = runCheck();
  ok(c2.status === 'warn' && c2.mismatch_count >= 2 && c2.mismatched_products === 1,
    'recon reports warn + mismatch count when warehouse_stock / products.stock corrupted', c2);
  ok(c2.rows.some((r) => r.level === 'warehouse' && r.product_id === pid && r.warehouse_id === wh1 && r.cache_qty === 19 && r.ledger_qty === 7 && r.diff_qty === 12),
    'recon sample includes warehouse level diff (19 vs 7)', c2.rows);
  ok(c2.rows.some((r) => r.level === 'product' && r.product_id === pid && r.cache_qty === 19 && r.ledger_qty === 7),
    'recon sample includes product level diff (19 vs 7)', c2.rows);

  // 3) rebuildStockCache fixes it
  rebuildStockCache(db, pid);
  const c3 = runCheck();
  ok(c3.status === 'ok' && c3.mismatch_count === 0,
    'rebuildStockCache heals the corruption and recon returns ok', c3);

  // 4) Matrix product: variant / variant_warehouse mismatch + unattributed warning
  const pMat = Number(db.prepare(`
    INSERT INTO products (user_id, name, code, price, cost, average_cost_rial, stock, warehouse_id, unit, has_variants, is_style)
    VALUES (?, 'شومیز ماتریسی تست', 'SCR-M1', 4000000, 800000, 800000, 0, ?, 'عدد', 1, 1)
  `).run(ADMIN.id, wh1).lastInsertRowid);
  const col1 = Number(db.prepare("INSERT INTO product_colors (name, code, active) VALUES ('مشکی تست', 'BLK-T', 1)").run().lastInsertRowid);
  const sz1 = Number(db.prepare("INSERT INTO product_sizes (name, code, active) VALUES ('38-T', '38T', 1)").run().lastInsertRowid);
  const sz2 = Number(db.prepare("INSERT INTO product_sizes (name, code, active) VALUES ('40-T', '40T', 1)").run().lastInsertRowid);
  const v1 = Number(db.prepare(`
    INSERT INTO product_variants (product_id, color_id, size_id, sku, stock, active, is_default)
    VALUES (?, ?, ?, 'SCR-M1-B38', 0, 1, 0)
  `).run(pMat, col1, sz1).lastInsertRowid);
  const v2 = Number(db.prepare(`
    INSERT INTO product_variants (product_id, color_id, size_id, sku, stock, active, is_default)
    VALUES (?, ?, ?, 'SCR-M1-B40', 0, 1, 0)
  `).run(pMat, col1, sz2).lastInsertRowid);

  postInventoryMovement(db, {
    eventType: 'receipt', productId: pMat, warehouseId: wh1, variantId: v1,
    qtyIn: 5, unitCostRial: 800000, sourceType: 'warehouse_receipt', sourceId: 201, date: today, createdBy: ADMIN.id,
  });
  postInventoryMovement(db, {
    eventType: 'receipt', productId: pMat, warehouseId: wh2, variantId: v2,
    qtyIn: 4, unitCostRial: 800000, sourceType: 'warehouse_receipt', sourceId: 202, date: today, createdBy: ADMIN.id,
  });
  rebuildStockCache(db, pMat);

  const dMat = deriveProductStock(db, pMat);
  ok(dMat.header === 9 && dMat.variants.get(v1) === 5 && dMat.variants.get(v2) === 4,
    'deriveProductStock computes header + per-variant quantities', { header: dMat.header });

  // Corrupt variant_warehouse_stock & product_variants
  withCacheWriter(db, () => {
    db.prepare('UPDATE variant_warehouse_stock SET qty=99 WHERE variant_id=? AND warehouse_id=?').run(v1, wh1);
    db.prepare('UPDATE product_variants SET stock=99 WHERE id=?').run(v1);
  });
  const c4 = runCheck();
  ok(c4.status === 'warn'
    && c4.rows.some((r) => r.level === 'variant' && r.variant_id === v1 && r.cache_qty === 99 && r.ledger_qty === 5)
    && c4.rows.some((r) => r.level === 'variant_warehouse' && r.variant_id === v1 && r.warehouse_id === wh1 && r.cache_qty === 99 && r.ledger_qty === 5),
  'recon reports variant and variant_warehouse level mismatches', c4.rows);

  rebuildStockCache(db, pMat);
  ok(runCheck().status === 'ok', 'rebuildStockCache heals variant + variant_warehouse caches');

  // Post a legacy unattributed ledger row (variant_id NULL) on matrix product
  db.prepare(`
    INSERT INTO inventory_ledger (tx_no, event_type, product_id, warehouse_id, qty_in, qty_out, unit_cost_rial, amount_rial,
      source_type, source_id, status, date, created_by, variant_id)
    VALUES ('SCR-UNATTR-1', 'receipt', ?, ?, 2, 0, 800000, 1600000, 'legacy_test', 203, 'posted', ?, ?, NULL)
  `).run(pMat, wh1, today, ADMIN.id);
  rebuildStockCache(db, pMat);
  const c5 = runCheck();
  ok(c5.status === 'ok' && c5.mismatch_count === 0 && c5.unattributed_count === 1
    && c5.unattributed[0].product_id === pMat && c5.unattributed[0].qty === 2,
  'matrix product with NULL variant_id live row: cache ok, unattributed reported as warning detail', c5);

  // 5) HTTP route exposes stock_cache_vs_ledger
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/accounting/subledger-recon', require('../routes/subledger-recon'));
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const listRes = await fetch(`${base}/api/accounting/subledger-recon/checks`);
    const listBody = await listRes.json();
    ok(listRes.status === 200 && listBody.checks.some((x) => x.code === 'stock_cache_vs_ledger'),
      'GET /api/accounting/subledger-recon/checks includes stock_cache_vs_ledger');
    const runRes = await fetch(`${base}/api/accounting/subledger-recon?checks=stock_cache_vs_ledger`);
    const runBody = await runRes.json();
    ok(runRes.status === 200 && runBody.checks.length === 1 && runBody.checks[0].code === 'stock_cache_vs_ledger',
      'GET /api/accounting/subledger-recon?checks=stock_cache_vs_ledger returns check', runBody.checks);
  } finally {
    srv.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
