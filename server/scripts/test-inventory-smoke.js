'use strict';
/**
 * Smoke test — inventory ledger + cost layer + reservation + cycle-count wiring.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-test-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.SYNC_ROLE = 'central';

const { getDB, initDB } = require('../db');
const { postInventoryMovement, reverseInventoryMovement, getKardex } = require('../lib/inventory/ledger');
const { createReservation, availableQty } = require('../lib/inventory/reservation');
const { createBatch, pickBatchesFefo } = require('../lib/inventory/batch-serial');
const { applyCycleCount } = require('../lib/inventory/cycle-count');
const { todayJalali } = require('../jalali');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, detail || ''); }
}

initDB();
const db = getDB();

console.log('\n══ Inventory Smoke ══\n');

ok('inventory_ledger table', !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='inventory_ledger'").get());
ok('inventory_cost_layers table', !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='inventory_cost_layers'").get());
ok('inventory_batches table', !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='inventory_batches'").get());
ok('inventory_reservations table', !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='inventory_reservations'").get());
ok('landed_cost_docs table', !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='landed_cost_docs'").get());

const admin = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get()
  || db.prepare('SELECT id FROM users LIMIT 1').get();
const userId = admin?.id || 1;

const whRow = db.prepare("SELECT id FROM warehouses WHERE active=1 LIMIT 1").get();
let whId = whRow?.id;
if (!whId) {
  whId = db.prepare("INSERT INTO warehouses (name,code,warehouse_type) VALUES ('تست','WH-T','finished_goods')").run().lastInsertRowid;
}

const prodId = db.prepare(`
  INSERT INTO products (user_id, name, code, stock, average_cost_rial, cost, warehouse_id)
  VALUES (?,'کالای تست انبار','INV-T1',0,100000,10000,?)
`).run(userId, whId).lastInsertRowid;

db.transaction(() => {
  const r1 = postInventoryMovement(db, {
    eventType: 'receipt', productId: prodId, warehouseId: whId, qty: 10,
    unitCostRial: 100000, date: todayJalali(), note: 'رسید تست', createdBy: 1,
  });
  ok('receipt ledger id', !!r1.id);
  ok('receipt amount', r1.amount_rial === 1000000, r1.amount_rial);
  const p1 = db.prepare('SELECT stock, average_cost_rial FROM products WHERE id=?').get(prodId);
  ok('stock after receipt', p1.stock === 10, p1.stock);
  ok('avg after receipt', p1.average_cost_rial === 100000, p1.average_cost_rial);

  const r2 = postInventoryMovement(db, {
    eventType: 'receipt', productId: prodId, warehouseId: whId, qty: 10,
    unitCostRial: 200000, date: todayJalali(), note: 'رسید ۲', createdBy: 1,
  });
  const p2 = db.prepare('SELECT stock, average_cost_rial FROM products WHERE id=?').get(prodId);
  ok('stock after 2nd receipt', p2.stock === 20, p2.stock);
  ok('moving avg 150000', p2.average_cost_rial === 150000, p2.average_cost_rial);

  const r3 = postInventoryMovement(db, {
    eventType: 'issue', productId: prodId, warehouseId: whId, qty: -5,
    date: todayJalali(), note: 'حواله تست', createdBy: 1,
  });
  const p3 = db.prepare('SELECT stock FROM products WHERE id=?').get(prodId);
  ok('stock after issue', p3.stock === 15, p3.stock);

  const rev = reverseInventoryMovement(db, r3.id, { createdBy: 1, date: todayJalali() });
  const p4 = db.prepare('SELECT stock FROM products WHERE id=?').get(prodId);
  ok('stock after reverse', p4.stock === 20, p4.stock);
  const orig = db.prepare('SELECT status FROM inventory_ledger WHERE id=?').get(r3.id);
  ok('original marked reversed', orig.status === 'reversed');

  const layers = db.prepare('SELECT COUNT(*) c FROM inventory_cost_layers WHERE product_id=?').get(prodId);
  ok('cost layers created', layers.c >= 2, layers.c);

  const batch = createBatch(db, {
    productId: prodId, warehouseId: whId, expiryDate: '1405/12/01', qty: 5, createdBy: 1,
  });
  ok('batch created', !!batch.id);
  const fefo = pickBatchesFefo(db, prodId, whId, 3);
  ok('fefo picks', fefo.picks.length >= 1 && fefo.shortfall === 0);

  const availBefore = availableQty(db, prodId, whId);
  const rsv = createReservation(db, {
    productId: prodId, warehouseId: whId, qty: 4, kind: 'sales', createdBy: 1,
  });
  ok('reservation created', !!rsv.id);
  ok('available reduced', availableQty(db, prodId, whId) === availBefore - 4,
    `${availableQty(db, prodId, whId)} vs ${availBefore - 4}`);

  const kx = getKardex(db, prodId);
  ok('kardex rows', kx.rows.length >= 3, kx.rows.length);
})();

// Cycle count session
const stkId = db.prepare(`
  INSERT INTO stocktaking_sessions (warehouse_id,date,status,created_by)
  VALUES (?,?,'completed',1)
`).run(whId, todayJalali()).lastInsertRowid;
const cur = db.prepare('SELECT stock FROM products WHERE id=?').get(prodId).stock;
db.prepare(`
  INSERT INTO stocktaking_items (session_id,product_id,system_qty,counted_qty)
  VALUES (?,?,?,?)
`).run(stkId, prodId, cur, cur - 2);

try {
  const applied = applyCycleCount(db, stkId, { createdBy: 1 });
  ok('cycle count applied', applied.ok);
  ok('cycle count loss rial', applied.total_loss_rial > 0, applied.total_loss_rial);
  const after = db.prepare('SELECT stock FROM products WHERE id=?').get(prodId);
  ok('stock after cycle count', after.stock === cur - 2, after.stock);
  const sess = db.prepare('SELECT status, je_id FROM stocktaking_sessions WHERE id=?').get(stkId);
  ok('session adjusted', sess.status === 'adjusted');
} catch (e) {
  ok('cycle count applied', false, e.message);
}

console.log(`\n────────────────────────────────────────`);
console.log(`Inventory Smoke: ${fail ? '❌' : '✅'} ${pass} پاس · ${fail} شکست\n`);
process.exit(fail ? 1 : 0);
