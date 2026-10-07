'use strict';
/**
 * v331: stock with empty kardex must heal via continuous reconcile;
 * one-shot opening backfill must not permanently seal gaps.
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

  const gap = reconcileInventoryLedgerGaps(db);
  ok('continuous reconcile posts rows', gap && gap.count >= 1, JSON.stringify(gap));
  const net = db.prepare(`
    SELECT COALESCE(SUM(qty_in-qty_out),0) q FROM inventory_ledger
    WHERE product_id=? AND warehouse_id=? AND COALESCE(status,'posted')='posted'
  `).get(prodId, wh.id).q;
  eq('ledger net = warehouse qty', Number(net), 10);
  eq('products.stock unchanged', db.prepare('SELECT stock FROM products WHERE id=?').get(prodId).stock, 10);
  eq('warehouse_stock unchanged', db.prepare(
    'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
  ).get(prodId, wh.id).qty, 10);
  eq('skipStock does not invent stock_logs', db.prepare(
    'SELECT COUNT(*) c FROM stock_logs WHERE product_id=?'
  ).get(prodId).c, 0);

  const ledger = buildStockLedger(db, { product_id: prodId });
  ok('kardex API has lines', Array.isArray(ledger.lines) && ledger.lines.length >= 1, String(ledger.lines?.length));
  eq('kardex closing matches stock', Number(ledger.closing_qty), 10);
  eq('header stock exposed', Number(ledger.product.stock), 10);

  // Idempotent second pass
  const gap2 = reconcileInventoryLedgerGaps(db);
  eq('second reconcile is no-op', Number(gap2.count) || 0, 0);

  // Header-only (no WH row) then reconcile seeds WH + ledger
  const orphanId = db.prepare(`
    INSERT INTO products (user_id,name,code,stock,cost,average_cost_rial,warehouse_id)
    VALUES (?,'کالای بدون ردیف انبار','ORPH-QA',7,1000,10000,?)
  `).run(admin.id, wh.id).lastInsertRowid;
  db.prepare('DELETE FROM warehouse_stock WHERE product_id=?').run(orphanId);
  const rOrphan = reconcileProductStockLedger(db, orphanId);
  ok('orphan seeds WH', (rOrphan.seeded_wh || 0) >= 1 || db.prepare(
    'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
  ).get(orphanId, wh.id)?.qty === 7, JSON.stringify(rOrphan));
  eq('orphan ledger net', Number(db.prepare(`
    SELECT COALESCE(SUM(qty_in-qty_out),0) q FROM inventory_ledger
    WHERE product_id=? AND COALESCE(status,'posted')='posted'
  `).get(orphanId).q), 7);

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
