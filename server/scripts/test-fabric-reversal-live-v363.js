/**
 * v363 — fabric roll live meters after void must not double-count.
 * reverseInventoryMovement marks original reversed AND posts opposite row;
 * liveBatchMeters must sum ALL ledger rows for the batch.
 *
 * Run: node server/scripts/test-fabric-reversal-live-v363.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-v363-'));
const dbFile = path.join(dir, 't.db');
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-fabric-v363-secret-at-least-32-bytes!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

const {
  liveBatchMeters,
  availableBatchMeters,
  receiveFabricRoll,
  syncFabricProductWarehouse,
  listFabricCirculation,
  applyLiveRollQty,
} = require('../lib/inventory/fabric-rolls');
const {
  postInventoryMovement,
  reverseInventoryMovement,
  warehouseQty,
} = require('../lib/inventory/ledger');
const { adjustBatchQty } = require('../lib/inventory/batch-serial');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);

let wh = db.prepare("SELECT * FROM warehouses WHERE code='WH-RAW' LIMIT 1").get();
if (!wh) {
  const id = db.prepare(`
    INSERT INTO warehouses (code, name, warehouse_type, kind, is_active)
    VALUES ('WH-RAW', 'مواد اولیه', 'raw_material', 'raw_material', 1)
  `).run().lastInsertRowid;
  wh = db.prepare('SELECT * FROM warehouses WHERE id=?').get(id);
}

const fabricId = db.prepare(`
  INSERT INTO products (user_id, name, unit, stock, cost, average_cost_rial, is_manufactured, item_type)
  VALUES (?, 'پارچه تست v363', 'متر', 0, 0, 0, 0, 'raw')
`).run(admin.id).lastInsertRowid;

const roll = receiveFabricRoll(db, {
  product_id: fabricId,
  warehouse_id: wh.id,
  color: 'سرمه‌ای',
  meters: 113,
  unit_cost_rial: 0,
  idempotency_key: 'fab-v363-a',
  date: '1405/07/07',
}, admin);
ok(!!roll && roll.id, 'fabric roll received', roll && roll.id);
ok(Math.abs(liveBatchMeters(db, roll.id) - 113) < 1e-6, 'live after receipt = 113', liveBatchMeters(db, roll.id));

const issue = postInventoryMovement(db, {
  eventType: 'production_issue',
  productId: fabricId,
  warehouseId: wh.id,
  qtyOut: 67.802,
  unitCostRial: 0,
  amountRial: 0,
  sourceType: 'cutting_lay',
  sourceId: 999363,
  batchId: roll.id,
  date: '1405/07/09',
  note: 'لایه‌چینی LAY-TEST',
  createdBy: admin.id,
});
adjustBatchQty(db, roll.id, -67.802);
ok(Math.abs(liveBatchMeters(db, roll.id) - (113 - 67.802)) < 1e-3, 'live after issue', liveBatchMeters(db, roll.id));

reverseInventoryMovement(db, issue.id, {
  createdBy: admin.id,
  date: '1405/07/09',
  note: 'ابطال از گزارش',
});
adjustBatchQty(db, roll.id, 67.802);

const afterVoid = liveBatchMeters(db, roll.id);
ok(Math.abs(afterVoid - 113) < 1e-3, 'live after void = 113 (no double-count)', afterVoid);
ok(Math.abs(availableBatchMeters(db, roll.id) - 113) < 1e-3, 'available after void = 113', availableBatchMeters(db, roll.id));

const batchRow = db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(roll.id);
applyLiveRollQty(db, batchRow);
ok(Math.abs(Number(batchRow.qty_on_hand) - 113) < 1e-3, 'qty_on_hand healed to 113', batchRow.qty_on_hand);

const circ = listFabricCirculation(db, { batch_id: roll.id });
const last = (circ.rows || [])[circ.rows.length - 1];
ok(last && Math.abs(Number(last.running_meters) - 113) < 1e-3, 'circulation running ends at 113', last && last.running_meters);
ok((circ.rows || []).some((r) => r.ledger_status === 'reversed'), 'circulation shows reversed original');

// Simulate untagged drain of product warehouse while roll still holds meters
db.prepare(
  'UPDATE warehouse_stock SET qty=? WHERE product_id=? AND warehouse_id=?'
).run(20, fabricId, wh.id);
db.prepare('UPDATE products SET stock=? WHERE id=?').run(20, fabricId);
ok(warehouseQty(db, fabricId, wh.id) < 67, 'warehouse artificially short');

syncFabricProductWarehouse(db, fabricId, wh.id);
ok(
  Math.abs(warehouseQty(db, fabricId, wh.id) - 113) < 1e-3,
  'sync restores warehouse to roll live',
  warehouseQty(db, fabricId, wh.id)
);

// Second issue of 67 must pass warehouse check after sync
let secondOk = false;
try {
  const issue2 = postInventoryMovement(db, {
    eventType: 'production_issue',
    productId: fabricId,
    warehouseId: wh.id,
    qtyOut: 67,
    unitCostRial: 0,
    amountRial: 0,
    sourceType: 'cutting_lay',
    sourceId: 999364,
    batchId: roll.id,
    date: '1405/07/10',
    note: 'لایه‌چینی دوم',
    createdBy: admin.id,
  });
  secondOk = !!issue2.id;
  adjustBatchQty(db, roll.id, -67);
} catch (e) {
  console.log(' second issue error', e.code || e.message);
}
ok(secondOk, 're-issue 67m after sync succeeds');
ok(Math.abs(liveBatchMeters(db, roll.id) - 46) < 1e-3, 'live after re-issue = 46', liveBatchMeters(db, roll.id));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
