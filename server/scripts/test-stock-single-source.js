#!/usr/bin/env node
/**
 * Stock single source of truth — inventory_ledger (live rows) is the only on-hand source;
 * products.stock / warehouse_stock / product_variants.stock / variant_warehouse_stock are caches
 * rebuilt from it (stock-cache.js).
 *
 *  A. K-00009 pattern: matrix product, opening per variant (one SKU in another warehouse),
 *     per-variant transfers A→B, an adjustment + its reversal (reversal row posted, original
 *     reversed) → every cache = Σ live ledger; transfer ledger rows carry variant_id.
 *  B. Zero-cost transfer: header avg 0, back-dated ledger-only opening with value → transfer
 *     leaves at the source bucket average; in-leg amount = out-leg amount > 0.
 *  C. Gates: E_NEGATIVE_STOCK (product / warehouse / variant×warehouse), E_VARIANT_REQUIRED.
 *
 * Run: node server/scripts/test-stock-single-source.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-ssot-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-stock-single-source-secret-32ch!!';
process.env.AUTH_SESSION_DB_PATH = path.join(tmp, 'sessions.db');
process.env.NODE_ENV = 'test';
process.env.ERP_TEST_ISOLATION = '1';

const { getDB, initDB } = require('../db');
initDB();
const db = getDB();
try { require('../lib/inventory/valuation').ensureValuationSchema(db); } catch (_) { /* optional */ }

const L = require('../lib/inventory/ledger');
const SC = require('../lib/inventory/stock-cache');
const WD = require('../lib/warehouse-docs');
const PV = require('../lib/product-variants');
const V = require('../lib/inventory/valuation');
const { todayJalali } = require('../jalali');

let pass = 0;
let fail = 0;
function ok(cond, msg, detail) {
  if (cond) { pass += 1; console.log('  ✓', msg); }
  else {
    fail += 1;
    console.log('  ✗', msg, detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail)));
  }
}
function throwsCode(fn, code) {
  try { fn(); return null; } catch (e) { return e && e.code === code ? e : (e || null); }
}

const q1 = (sql, ...a) => db.prepare(sql).get(...a);
const pstock = (pid) => Number((q1('SELECT stock FROM products WHERE id=?', pid) || {}).stock) || 0;
const ws = (pid, wh) => Number((q1('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?', pid, wh) || {}).qty) || 0;
const vws = (vid, wh) => Number((q1('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?', vid, wh) || {}).qty) || 0;
const vstock = (vid) => Number((q1('SELECT stock FROM product_variants WHERE id=?', vid) || {}).stock) || 0;

function main() {
  console.log('\n=== stock single source (ledger → caches) ===\n');
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('feature_perpetual_docs','1')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('inventory_allow_negative','0')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('ledger_leaf_enforcement','warn')").run();

  const admin = q1("SELECT * FROM users WHERE role='admin' ORDER BY id LIMIT 1")
    || { id: Number(db.prepare("INSERT INTO users (name, username, password, role, active) VALUES ('مدیر','ssot_admin','x','admin',1)").run().lastInsertRowid), role: 'admin' };
  const user = { ...admin, role: 'admin' };
  const date = todayJalali();

  const mkWh = (name) => Number(db.prepare(
    "INSERT INTO warehouses (name, active, allow_negative, warehouse_type) VALUES (?,1,0,'finished_goods')"
  ).run(name).lastInsertRowid);
  const A = mkWh('انبار A');
  const B = mkWh('انبار B');
  const C = mkWh('انبار C');
  const mkProduct = (name, code, avg) => Number(db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, average_cost_rial, cost, warehouse_id)
    VALUES (?, ?, ?, 1000000, 0, 'عدد', ?, ?, ?)
  `).run(admin.id, name, code, avg, Math.round(avg / 10), A).lastInsertRowid);

  // ── A. K-00009 pattern ──
  console.log('[A] matrix product: opening per variant, transfers, reversed adjustment');
  const P = mkProduct('مانتو K-00009', 'K-00009', 100000);
  PV.generateMatrix(db, { product_id: P, colors: [{ name: 'مشکی' }], sizes: [{ name: 'S' }, { name: 'M' }, { name: 'L' }] });
  const vars = db.prepare('SELECT id FROM product_variants WHERE product_id=? AND COALESCE(is_default,0)=0 ORDER BY id').all(P).map((r) => Number(r.id));
  ok(vars.length === 3, 'three matrix SKUs', vars);
  const [v1, v2, v3] = vars;

  db.transaction(() => {
    L.postInventoryMovement(db, {
      eventType: 'opening', productId: P, warehouseId: A, variantId: v1, qtyIn: 4,
      unitCostRial: 100000, sourceType: 'opening_stock_doc', date, note: 'افتتاحیه v1', createdBy: admin.id,
    });
    // ledger-only seed (skipStock) still counts in every figure under SSOT
    L.postInventoryMovement(db, {
      eventType: 'opening', productId: P, warehouseId: A, variantId: v2, qtyIn: 3,
      unitCostRial: 100000, sourceType: 'product_opening_stock', date, note: 'افتتاحیه v2', createdBy: admin.id, skipStock: true,
    });
    L.postInventoryMovement(db, {
      eventType: 'opening', productId: P, warehouseId: C, variantId: v3, qtyIn: 3,
      unitCostRial: 100000, sourceType: 'opening_stock_doc', date, note: 'افتتاحیه v3', createdBy: admin.id,
    });
  })();
  ok(pstock(P) === 10 && ws(P, A) === 7 && ws(P, C) === 3, 'after opening: products.stock 10, A 7, C 3',
    { p: pstock(P), a: ws(P, A), c: ws(P, C) });

  const xfer = WD.createWarehouseDoc(db, {
    type: 'transfer', from_warehouse_id: A, to_warehouse_id: B, date, note: 'انتقال SKU',
    lines: [{ product_id: P, variant_id: v1, qty: 2 }, { product_id: P, variant_id: v2, qty: 1 }],
  }, user);
  ok(xfer && xfer.ok && xfer.ids.length === 2, 'transfer doc A→B posted (2 lines)', xfer);

  const xRows = db.prepare(`
    SELECT * FROM inventory_ledger WHERE source_type='warehouse_transfer' AND source_id IN (${xfer.ids.map(() => '?').join(',')})
  `).all(...xfer.ids);
  ok(xRows.length === 4 && xRows.every((r) => Number(r.variant_id) > 0), 'all 4 transfer ledger rows carry variant_id',
    xRows.map((r) => [r.event_type, r.variant_id]));
  ok(xRows.filter((r) => r.event_type === 'transfer_out').every((r) => Number(r.amount_rial) === Number(r.qty_out) * 100000),
    'out-leg priced at source average', xRows.map((r) => [r.event_type, r.amount_rial]));

  // adjustment + reversal: reversal row stays posted, original becomes reversed → pair excluded
  let adj;
  db.transaction(() => {
    adj = L.postInventoryMovement(db, {
      eventType: 'adjustment', productId: P, warehouseId: B, variantId: v1, qty: 5,
      unitCostRial: 100000, sourceType: 'inventory_adjust', date, note: 'تعدیل', createdBy: admin.id,
    });
  })();
  ok(pstock(P) === 15 && vws(v1, B) === 7, 'adjustment +5 lands on cache immediately', { p: pstock(P), v: vws(v1, B) });
  let rev;
  db.transaction(() => { rev = L.reverseInventoryMovement(db, adj.id, { createdBy: admin.id, date, note: 'ابطال تعدیل' }); })();
  const origRow = q1('SELECT status FROM inventory_ledger WHERE id=?', adj.id);
  const revRow = q1('SELECT status, variant_id FROM inventory_ledger WHERE id=?', rev.id);
  ok(origRow.status === 'reversed' && revRow.status === 'posted', 'original reversed, reversal row posted', { origRow, revRow });
  ok(Number(revRow.variant_id) === v1, 'reversal copies variant_id', revRow);

  ok(pstock(P) === 10, 'products.stock = 10 (Σ live ledger)', pstock(P));
  ok(L.stockOf(db, { productId: P }) === 10, 'stockOf(company) = 10');
  ok(ws(P, A) === 4 && ws(P, B) === 3 && ws(P, C) === 3, 'warehouse_stock A4 / B3 / C3', { a: ws(P, A), b: ws(P, B), c: ws(P, C) });
  ok(vws(v1, A) === 2 && vws(v1, B) === 2 && vws(v2, A) === 2 && vws(v2, B) === 1 && vws(v3, C) === 3 && vws(v3, A) === 0,
    'variant_warehouse_stock per SKU×warehouse', { v1A: vws(v1, A), v1B: vws(v1, B), v2A: vws(v2, A), v2B: vws(v2, B), v3C: vws(v3, C) });
  ok(vstock(v1) === 4 && vstock(v2) === 3 && vstock(v3) === 3, 'product_variants.stock 4 / 3 / 3', [vstock(v1), vstock(v2), vstock(v3)]);
  const d = SC.deriveProductStock(db, P);
  ok(d.header === pstock(P) && [A, B, C].every((w) => (d.warehouses.get(w) || 0) === ws(P, w)),
    'stock-cache derive = cached product / warehouse figures');
  ok(vars.every((v) => (d.variants.get(v) || 0) === vstock(v)), 'stock-cache derive = cached variant figures');
  ok(d.unattributed.size === 0, 'no unattributed (variant_id NULL) live qty', [...d.unattributed]);
  const recP = SC.stockCacheVsLedger(db, { productId: P });
  ok(recP.ok === true, 'stockCacheVsLedger(product).ok', recP.rows);

  // a stray cache write is healed by the next ledger posting of the product
  db.prepare('UPDATE warehouse_stock SET qty=99 WHERE product_id=? AND warehouse_id=?').run(P, B);
  db.transaction(() => {
    L.postInventoryMovement(db, {
      eventType: 'adjustment', productId: P, warehouseId: C, variantId: v3, qty: 1,
      unitCostRial: 100000, sourceType: 'inventory_adjust', date, note: 'تعدیل دوم', createdBy: admin.id,
    });
  })();
  ok(ws(P, B) === 3 && pstock(P) === 11, 'next posting re-derives the caches (B back to 3, total 11)', { b: ws(P, B), p: pstock(P) });

  // ── B. zero-cost transfer ──
  console.log('\n[B] transfer of a product with header avg 0 and a valued back-dated opening');
  const Z = mkProduct('کالای بدون میانگین', 'Z-0', 0);
  db.transaction(() => {
    L.postInventoryMovement(db, {
      eventType: 'opening', productId: Z, warehouseId: A, qtyIn: 10, unitCostRial: 50000, amountRial: 500000,
      sourceType: 'product_opening_stock', date: '1404/01/01', note: 'افتتاحیه عقب‌تاریخ', createdBy: admin.id, skipStock: true,
    });
  })();
  ok(Math.round(Number(q1('SELECT average_cost_rial a FROM products WHERE id=?', Z).a) || 0) === 0, 'header average still 0 (ledger-only seed)');
  const bucketA = V.getBucket(db, Z, A);
  ok(bucketA && Number(bucketA.qty) === 10 && Math.round(Number(bucketA.avg_rial)) === 50000, 'source bucket holds 10 @ 50,000', bucketA);
  let zx = null;
  let zErr = null;
  try {
    zx = WD.createWarehouseDoc(db, {
      type: 'transfer', from_warehouse_id: A, to_warehouse_id: B, date, lines: [{ product_id: Z, qty: 4 }],
    }, user);
  } catch (e) { zErr = e; }
  ok(zx && zx.ok, 'transfer posts (no E_ZERO_OUTBOUND_COST)', zErr && (zErr.code || zErr.message));
  if (zx && zx.ok) {
    const zr = db.prepare("SELECT * FROM inventory_ledger WHERE source_type='warehouse_transfer' AND source_id=? ORDER BY id").all(zx.ids[0]);
    const out = zr.find((r) => r.event_type === 'transfer_out');
    const inn = zr.find((r) => r.event_type === 'transfer_in');
    ok(out && Number(out.amount_rial) === 200000, 'out-leg = 4 × 50,000 (source bucket avg)', out && out.amount_rial);
    ok(inn && Number(inn.amount_rial) === Number(out && out.amount_rial) && Number(inn.amount_rial) > 0, 'in-leg amount = out-leg amount > 0',
      { in: inn && inn.amount_rial, out: out && out.amount_rial });
    ok(ws(Z, A) === 6 && ws(Z, B) === 4 && pstock(Z) === 10, 'Z caches A6 / B4 / total 10', { a: ws(Z, A), b: ws(Z, B), p: pstock(Z) });
  }

  // ── C. gates ──
  console.log('\n[C] negative gate + variant required');
  const neg1 = throwsCode(() => db.transaction(() => L.postInventoryMovement(db, {
    eventType: 'issue', productId: Z, warehouseId: B, qty: -5, unitCostRial: 50000, sourceType: 'test', date, createdBy: admin.id,
  }))(), 'E_NEGATIVE_STOCK');
  ok(neg1 && neg1.code === 'E_NEGATIVE_STOCK' && neg1.status === 409 && Number(neg1.available) === 4 && Number(neg1.warehouse_id) === B,
    'warehouse shortage → E_NEGATIVE_STOCK 409 (available 4)', neg1 && { code: neg1.code, a: neg1.available, w: neg1.warehouse_id });
  ok(ws(Z, B) === 4 && pstock(Z) === 10, 'refused posting leaves caches untouched');
  const neg2 = throwsCode(() => db.transaction(() => L.postInventoryMovement(db, {
    eventType: 'issue', productId: Z, warehouseId: A, qty: -11, unitCostRial: 50000, sourceType: 'test', date, createdBy: admin.id,
  }))(), 'E_NEGATIVE_STOCK');
  ok(neg2 && neg2.code === 'E_NEGATIVE_STOCK' && Number(neg2.available) === 10 && neg2.warehouse_id == null,
    'company-wide shortage → E_NEGATIVE_STOCK (available 10)', neg2 && { code: neg2.code, a: neg2.available });
  const neg3 = throwsCode(() => db.transaction(() => L.postInventoryMovement(db, {
    eventType: 'issue', productId: P, warehouseId: A, variantId: v1, qty: -3, sourceType: 'test', date, createdBy: admin.id,
  }))(), 'E_NEGATIVE_STOCK');
  ok(neg3 && neg3.code === 'E_NEGATIVE_STOCK' && Number(neg3.variant_id) === v1 && Number(neg3.available) === 2,
    'variant×warehouse shortage (A has 4, SKU only 2) → E_NEGATIVE_STOCK', neg3 && { code: neg3.code, v: neg3.variant_id, a: neg3.available });
  const okNeg = (() => {
    try {
      db.transaction(() => L.postInventoryMovement(db, {
        eventType: 'issue', productId: Z, warehouseId: B, qty: -5, sourceType: 'test', date, createdBy: admin.id, allowNegative: true, allowZeroCost: true,
      }))();
      return true;
    } catch (e) { return e.code || e.message; }
  })();
  ok(okNeg === true && ws(Z, B) === -1, 'allowNegative → real negative mirrored in cache (−1)', { r: okNeg, b: ws(Z, B) });
  const vr = throwsCode(() => db.transaction(() => L.postInventoryMovement(db, {
    eventType: 'receipt', productId: P, warehouseId: A, qty: 1, unitCostRial: 100000, sourceType: 'test', date, createdBy: admin.id,
  }))(), 'E_VARIANT_REQUIRED');
  ok(vr && vr.code === 'E_VARIANT_REQUIRED' && vr.status === 400 && /واریانت/.test(vr.message), 'matrix qty row without variant → E_VARIANT_REQUIRED 400', vr && vr.code);

  const all = SC.stockCacheVsLedger(db);
  ok(all.ok === true, 'stockCacheVsLedger(db).ok === true (all products)', all.rows);
}

try {
  main();
} catch (e) {
  fail += 1;
  console.error('  ✗ crashed:', e && (e.stack || e.message));
}
console.log(`\n=== result: ${pass} passed, ${fail} failed ===\n`);
try { db.close(); } catch (_) { /* */ }
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* */ }
process.exit(fail ? 1 : 0);
