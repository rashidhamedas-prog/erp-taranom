'use strict';
/**
 * v331 (updated for opening SSOT): stock with empty kardex is REPORTED by the
 * continuous reconcile (inventory_ledger_gap_report_v2) — never healed with opening rows.
 */
const { ok, eq, freshDb, summary } = require('./lib/test-harness');
const {
  backfillOpeningInventoryLedger,
  reconcileInventoryLedgerGaps,
  reconcileProductStockLedger,
} = require('../lib/opening-post');
const { buildStockLedger } = require('../lib/ledgers');

console.log('\n══ v331 kardex gap reconcile ══\n');

const { db, cleanup } = freshDb();
try {
  const wh = db.prepare('SELECT id FROM warehouses WHERE COALESCE(active,1)=1 ORDER BY id LIMIT 1').get()
    || { id: db.prepare("INSERT INTO warehouses (name,code,active) VALUES ('انبار کاردکس','WH-KX',1)").run().lastInsertRowid };
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();

  // Seal one-shot backfill with count=0 BEFORE stock exists (prod bug sequence).
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('opening_inventory_ledger_backfill_v1',?)")
    .run(JSON.stringify({ ok: 1, count: 0 }));

  const prodId = db.prepare(`
    INSERT INTO products (user_id,name,code,stock,cost,average_cost_rial,warehouse_id)
    VALUES (?,'اورکت تست کاردکس','7134-QA',10,5008500,0,?)
  `).run(admin.id, wh.id).lastInsertRowid;
  db.prepare('INSERT OR REPLACE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,10)')
    .run(prodId, wh.id);

  const sealed = backfillOpeningInventoryLedger(db);
  ok('one-shot stays sealed', !!(sealed && sealed.skipped), JSON.stringify(sealed));
  eq('still no ledger after sealed backfill', db.prepare(
    "SELECT COUNT(*) c FROM inventory_ledger WHERE product_id=? AND COALESCE(status,'posted')='posted'"
  ).get(prodId).c, 0);

  // Opening SSOT: continuous reconcile is REPORT-ONLY (never posts opening/adjustment rows).
  const gap = reconcileInventoryLedgerGaps(db);
  ok('continuous reconcile is report-only', gap && gap.count === 0 && gap.report_only === true, JSON.stringify(gap));
  const report = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='inventory_ledger_gap_report_v2'").get()?.value || '{}');
  ok('gap reported in inventory_ledger_gap_report_v2', (report.gaps || []).some((g) => g.product_id === prodId && g.ws_qty === 10 && g.kardex_qty === 0), JSON.stringify(report));
  const net = db.prepare(`
    SELECT COALESCE(SUM(qty_in-qty_out),0) q FROM inventory_ledger
    WHERE product_id=? AND warehouse_id=? AND COALESCE(status,'posted')='posted'
  `).get(prodId, wh.id).q;
  eq('ledger net untouched (no opening invented)', Number(net), 0);
  eq('products.stock unchanged', db.prepare('SELECT stock FROM products WHERE id=?').get(prodId).stock, 10);
  eq('warehouse_stock unchanged', db.prepare(
    'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
  ).get(prodId, wh.id).qty, 10);
  eq('skipStock does not invent stock_logs', db.prepare(
    'SELECT COUNT(*) c FROM stock_logs WHERE product_id=?'
  ).get(prodId).c, 0);

  const ledger = buildStockLedger(db, { product_id: prodId });
  ok('kardex API has no invented lines', Array.isArray(ledger.lines) && ledger.lines.length === 0, String(ledger.lines?.length));
  eq('header stock exposed', Number(ledger.product.stock), 10);

  // Idempotent second pass
  const gap2 = reconcileInventoryLedgerGaps(db);
  eq('second reconcile is no-op', Number(gap2.count) || 0, 0);

  // Header-only (no WH row): reported, never seeds WH or ledger
  const orphanId = db.prepare(`
    INSERT INTO products (user_id,name,code,stock,cost,average_cost_rial,warehouse_id)
    VALUES (?,'کالای بدون ردیف انبار','ORPH-QA',7,1000,10000,?)
  `).run(admin.id, wh.id).lastInsertRowid;
  db.prepare('DELETE FROM warehouse_stock WHERE product_id=?').run(orphanId);
  const rOrphan = reconcileProductStockLedger(db, orphanId);
  ok('orphan reported, WH not seeded', (rOrphan.seeded_wh || 0) === 0
    && (rOrphan.gaps || []).some((g) => g.header_stock === 7)
    && !db.prepare('SELECT 1 FROM warehouse_stock WHERE product_id=?').get(orphanId), JSON.stringify(rOrphan));
  eq('orphan ledger net untouched', Number(db.prepare(`
    SELECT COALESCE(SUM(qty_in-qty_out),0) q FROM inventory_ledger
    WHERE product_id=? AND COALESCE(status,'posted')='posted'
  `).get(orphanId).q), 0);

  // Device must skip
  const prev = process.env.SYNC_ROLE;
  process.env.SYNC_ROLE = 'device';
  const dev = reconcileInventoryLedgerGaps(db);
  ok('device skips reconcile', !!(dev && dev.skipped && dev.reason === 'device'), JSON.stringify(dev));
  process.env.SYNC_ROLE = prev;
} finally {
  cleanup();
}

summary();
