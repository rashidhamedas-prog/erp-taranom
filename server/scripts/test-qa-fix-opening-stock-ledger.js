'use strict';
/**
 * Regression: opening inventory must write inventory_ledger (event_type=opening)
 * with skipStock so warehouse_stock is not doubled.
 */
const { ok, eq, freshDb, summary } = require('./lib/test-harness');
const { postProductOpeningInventory, backfillOpeningInventoryLedger } = require('../lib/opening-post');

console.log('\n══ QA-FIX opening stock inventory_ledger ══\n');

const { db, cleanup } = freshDb();
try {
  const wh = db.prepare('SELECT id FROM warehouses WHERE COALESCE(active,1)=1 ORDER BY id LIMIT 1').get()
    || { id: db.prepare("INSERT INTO warehouses (name,code,active) VALUES ('انبار افتتاحیه','WH-OP',1)").run().lastInsertRowid };
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();

  const prodId = db.prepare(`
    INSERT INTO products (user_id,name,code,stock,cost,average_cost_rial,warehouse_id)
    VALUES (?,'کالای افتتاحیه QA','OP-QA-1',20,4000,40000,?)
  `).run(admin.id, wh.id).lastInsertRowid;
  db.prepare('INSERT OR REPLACE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,20)').run(prodId, wh.id);

  postProductOpeningInventory(db, {
    productId: prodId, qty: 20, unitCostRial: 40000, userId: admin.id,
  });

  const led = db.prepare(`
    SELECT event_type, qty_in, qty_out, warehouse_id, source_type
    FROM inventory_ledger WHERE product_id=? AND COALESCE(status,'posted')='posted'
  `).all(prodId);
  const opening = led.find((r) => r.event_type === 'opening');
  ok('opening ledger row created', !!opening, JSON.stringify(led));
  eq('opening qty_in', opening ? Number(opening.qty_in) : 0, 20);
  eq('opening warehouse', opening ? Number(opening.warehouse_id) : 0, wh.id);
  eq('products.stock unchanged (skipStock)', db.prepare('SELECT stock FROM products WHERE id=?').get(prodId).stock, 20);
  eq('warehouse_stock unchanged', db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(prodId, wh.id).qty, 20);

  const prod2 = db.prepare(`
    INSERT INTO products (user_id,name,code,stock,cost,average_cost_rial,warehouse_id)
    VALUES (?,'کالای گپ QA','OP-QA-2',17,1000,10000,?)
  `).run(admin.id, wh.id).lastInsertRowid;
  db.prepare('INSERT OR REPLACE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,17)').run(prod2, wh.id);
  db.prepare("DELETE FROM settings WHERE key='opening_inventory_ledger_backfill_v1'").run();
  const bf = backfillOpeningInventoryLedger(db);
  ok('backfill ran', bf && bf.count >= 1, JSON.stringify(bf));
  const net2 = db.prepare(`
    SELECT COALESCE(SUM(qty_in-qty_out),0) q FROM inventory_ledger
    WHERE product_id=? AND warehouse_id=? AND COALESCE(status,'posted')='posted'
  `).get(prod2, wh.id).q;
  eq('backfill ledger net equals warehouse', Number(net2), 17);

  const prevRole = process.env.SYNC_ROLE;
  process.env.SYNC_ROLE = 'device';
  db.prepare("DELETE FROM settings WHERE key='opening_inventory_ledger_backfill_v1'").run();
  const bfDev = backfillOpeningInventoryLedger(db);
  ok('device skips backfill', !!(bfDev && bfDev.skipped && bfDev.reason === 'device'), JSON.stringify(bfDev));
  process.env.SYNC_ROLE = prevRole;
} finally {
  cleanup();
}

summary();
