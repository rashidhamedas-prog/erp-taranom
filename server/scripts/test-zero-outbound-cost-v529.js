'use strict';
/**
 * v529 — گیت خروج بدون بها + منطق heal میانگین زمانی
 * Run: node server/scripts/test-zero-outbound-cost-v529.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-out-v529-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(dir, 't.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.JWT_SECRET = 'test-zero-outbound-v529-secret-32bytes!!';
process.env.SYNC_ROLE = 'central';

let passed = 0;
let failed = 0;
function ok(c, m, detail) {
  if (c) { passed++; console.log('  OK', m); }
  else { failed++; console.error('  FAIL', m, detail != null ? detail : ''); }
}
function finish() {
  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  process.exit(failed ? 1 : 0);
}

let db;
try {
  const { initDB, getDB } = require('../db');
  initDB();
  db = getDB();
} catch (e) {
  console.log('SKIP — better-sqlite3:', e.message);
  process.exit(0);
}

const L = require('../lib/inventory/ledger');
const { rebuildBaseCoa } = require('../lib/coa-map');
if (!db.prepare('SELECT COUNT(*) c FROM chart_of_accounts').get().c) rebuildBaseCoa(db);

const uid = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()?.id || 1;
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('inventory_costing_method','moving_average')").run();
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('inventory_valuation_level','product')").run();
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('inventory_allow_negative','1')").run();

const whId = db.prepare("INSERT INTO warehouses (name, warehouse_type, costing_method, allow_negative) VALUES ('FG','finished_goods','moving_average',1)")
  .run().lastInsertRowid;
const pid = db.prepare(`
  INSERT INTO products (user_id,name,code,stock,average_cost_rial,cost,unit,warehouse_id)
  VALUES (?,?,?,0,0,0,'عدد',?)
`).run(uid, 'کاپشن تست صفر', 'Z-529', whId).lastInsertRowid;

console.log('\n1) sale with zero avg must throw E_ZERO_OUTBOUND_COST (no stock mutation)');
const stockBefore = Number(db.prepare('SELECT stock FROM products WHERE id=?').get(pid).stock) || 0;
let code = null;
try {
  L.postInventoryMovement(db, {
    eventType: 'sale', productId: pid, warehouseId: whId, qtyOut: 2,
    sourceType: 'invoice', sourceId: 1, date: '1405/07/10', createdBy: uid,
    updateAvg: false, allowNegative: true,
  });
} catch (e) { code = e.code || e.message; }
ok(code === 'E_ZERO_OUTBOUND_COST', 'blocks zero-cost sale', code);
const stockAfter = Number(db.prepare('SELECT stock FROM products WHERE id=?').get(pid).stock) || 0;
ok(stockAfter === stockBefore, 'stock unchanged after rejected sale', { stockBefore, stockAfter });

console.log('\n2) after valued receipt, sale gets amount');
L.postInventoryMovement(db, {
  eventType: 'production_receipt', productId: pid, warehouseId: whId, qtyIn: 10, unitCostRial: 1000000,
  sourceType: 'production_receipt', sourceId: 1, date: '1405/07/05', createdBy: uid,
});
const sale = L.postInventoryMovement(db, {
  eventType: 'sale', productId: pid, warehouseId: whId, qtyOut: 2,
  sourceType: 'invoice', sourceId: 2, date: '1405/07/12', createdBy: uid,
  updateAvg: false, allowNegative: true,
});
ok(Math.round(sale.amount_rial) === 2000000, 'sale amount = 2 × unit', sale.amount_rial);
ok(Math.round(sale.unit_cost_rial) === 1000000, 'sale unit cost', sale.unit_cost_rial);

console.log('\n3) allowZeroCost escape still works for controlled tools');
const z = L.postInventoryMovement(db, {
  eventType: 'sale', productId: pid, warehouseId: whId, qtyOut: 1,
  sourceType: 'invoice', sourceId: 99, date: '1405/07/13', createdBy: uid,
  updateAvg: false, allowNegative: true, allowZeroCost: true, unitCostRial: 0, amountRial: 0,
});
ok(Math.round(z.amount_rial) === 0, 'allowZeroCost permits zero', z.amount_rial);

console.log('\n4) heal chronological assigns cost to legacy zero row');
const zeroRow = db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(z.id);
ok(zeroRow && Math.round(zeroRow.amount_rial) === 0, 'legacy zero exists');

const rows = db.prepare(`
  SELECT id, date, event_type, qty_in, qty_out, amount_rial, reversed_of
  FROM inventory_ledger WHERE product_id=? AND status='posted' ORDER BY COALESCE(date,''), id
`).all(pid);
let qty = 0; let value = 0;
const fixes = [];
for (const r of rows) {
  if (r.reversed_of) continue;
  const qIn = Number(r.qty_in) || 0;
  const qOut = Number(r.qty_out) || 0;
  let amt = Math.round(Number(r.amount_rial) || 0);
  if (qIn > 0) { qty += qIn; value += amt; continue; }
  if (qOut > 0) {
    const avg = qty > 1e-9 ? Math.max(0, Math.round(value / qty)) : 0;
    if (amt <= 0 && avg > 0) {
      const newAmt = Math.round(avg * qOut);
      fixes.push({ id: r.id, newAmt, unit: Math.round(newAmt / qOut) });
      amt = newAmt;
    }
    qty -= qOut; value -= amt;
  }
}
ok(fixes.length === 1 && fixes[0].id === z.id, 'heal finds the zero sale', fixes);
db.prepare('UPDATE inventory_ledger SET unit_cost_rial=?, amount_rial=? WHERE id=?')
  .run(fixes[0].unit, fixes[0].newAmt, fixes[0].id);
const healed = db.prepare('SELECT unit_cost_rial, amount_rial FROM inventory_ledger WHERE id=?').get(z.id);
ok(Math.round(healed.amount_rial) === 1000000, 'healed amount 1×avg', healed);

console.log('\n5) FIFO product: gate still fires when layers empty and avg 0');
const fifoId = db.prepare(`
  INSERT INTO products (user_id,name,code,stock,average_cost_rial,cost,unit,costing_method,warehouse_id)
  VALUES (?,?,?,0,0,0,'عدد','fifo',?)
`).run(uid, 'FIFO تست', 'F-529', whId).lastInsertRowid;
db.prepare('UPDATE products SET stock=3 WHERE id=?').run(fifoId);
let fifoCode = null;
try {
  L.postInventoryMovement(db, {
    eventType: 'sale', productId: fifoId, warehouseId: whId, qtyOut: 1,
    sourceType: 'invoice', sourceId: 3, date: '1405/07/14', createdBy: uid,
    updateAvg: false, allowNegative: true,
  });
} catch (e) { fifoCode = e.code || e.message; }
ok(fifoCode === 'E_ZERO_OUTBOUND_COST', 'FIFO empty layers also blocked', fifoCode);

finish();
