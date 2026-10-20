'use strict';
/**
 * Kardex parent-row aggregation + spurious align retire (v504).
 * Run: node server/scripts/test-kardex-group-v504.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kardex-v504-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.JWT_SECRET = 'test-kardex-v504-secret-32chars!!!!';
process.env.SYNC_ROLE = 'central';
process.env.PORT = '0';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; console.log('  ✓', msg); }
  else { failed += 1; console.log('  ✗', msg); }
}

console.log('\n══ Kardex group + align retire v504 ══\n');

const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(appSrc.includes('is_group') && appSrc.includes('kardex-tog'), 'UI has group expand');
ok(appSrc.includes("editing?'*'") || appSrc.includes("editing?'*'"), 'pack edit defaults to all colors');
ok(appSrc.includes('onHand=whId'), 'invoice picker warehouse-scoped stock');
ok(appSrc.includes('warehouse_doc'), 'kardex opens warehouse_doc');

const ledSrc = fs.readFileSync(path.join(__dirname, '../lib/ledgers.js'), 'utf8');
ok(ledSrc.includes('aggregateStockLedgerLines'), 'aggregate helper exported');
ok(ledSrc.includes('wh_doc_id'), 'join warehouse doc id');

const openSrc = fs.readFileSync(path.join(__dirname, '../lib/opening-post.js'), 'utf8');
ok(openSrc.includes('retireSpuriousKardexAlign'), 'retire heal present');

let getDB, initDB;
try {
  ({ getDB, initDB } = require('../db'));
  initDB();
} catch (e) {
  console.log('  ⚠ sqlite ABI unavailable locally — static checks only:', e.message.split('\n')[0]);
  console.log(`\n══ Result: ${passed} passed, ${failed} failed (DB skipped) ══\n`);
  process.exit(failed ? 1 : 0);
}
const db = getDB();

const adminId = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get()?.id || 1;
const whA = db.prepare("INSERT INTO warehouses (name, active) VALUES ('WH-A-504',1)").run().lastInsertRowid;
const whB = db.prepare("INSERT INTO warehouses (name, active) VALUES ('WH-B-504',1)").run().lastInsertRowid;
const pid = db.prepare(
  "INSERT INTO products (name, code, unit, stock, warehouse_id, average_cost_rial, user_id) VALUES ('Jacket','J504','عدد',24,?,1000,?)"
).run(whA, adminId).lastInsertRowid;

db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)').run(pid, whA, 24);
db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)').run(pid, whB, 0);

const { postInventoryMovement } = require('../lib/inventory/ledger');
const { buildStockLedger } = require('../lib/ledgers');
const { retireSpuriousKardexAlign } = require('../lib/opening-post');

// Spurious align seed on WH-B (skipStock) while real transfers will also land there.
postInventoryMovement(db, {
  eventType: 'opening', productId: pid, warehouseId: whB, qty: 1,
  unitCostRial: 1000, sourceType: 'opening_inventory', sourceId: pid,
  date: '1405/06/31', note: 'موجودی اول دوره (هم‌ترازی کاردکس)',
  createdBy: adminId, skipStock: true, updateAvg: false,
});

const docId = db.prepare(`
  INSERT INTO warehouse_docs (num, type, from_warehouse_id, to_warehouse_id, date, note, status, created_by, line_count, qty_total)
  VALUES ('WH-5040','transfer',?,?, '1405/07/18','test', 'posted', ?, 4, 24)
`).run(whA, whB, adminId).lastInsertRowid;

for (let i = 0; i < 4; i++) {
  const ledOut = postInventoryMovement(db, {
    eventType: 'transfer_out', productId: pid, warehouseId: whA, qty: -6,
    unitCostRial: 1000, sourceType: 'warehouse_transfer', date: '1405/07/18',
    note: 'خروج انتقال به WH-B', createdBy: adminId, updateAvg: false, allowNegative: true,
  });
  const ledIn = postInventoryMovement(db, {
    eventType: 'transfer_in', productId: pid, warehouseId: whB, qty: 6,
    unitCostRial: 1000, amountRial: ledOut.amount_rial, sourceType: 'warehouse_transfer',
    date: '1405/07/18', note: 'ورود انتقال از WH-A', createdBy: adminId, updateAvg: false,
  });
  const moveId = db.prepare(`
    INSERT INTO warehouse_moves
      (type,product_id,from_warehouse_id,to_warehouse_id,qty,date,note,created_by,ledger_id,unit_cost_rial,amount_rial,status,doc_id,line_no)
    VALUES ('transfer',?,?,?,?,?,?,?,?,?,?,'posted',?,?)
  `).run(pid, whA, whB, 6, '1405/07/18', 'test', adminId, ledOut.id, 1000, ledOut.amount_rial, docId, i + 1)
    .lastInsertRowid;
  db.prepare('UPDATE inventory_ledger SET source_id=? WHERE id IN (?,?)')
    .run(moveId, ledOut.id, ledIn.id);
}

const ledB = buildStockLedger(db, {
  product_id: pid, warehouse_id: whB, from: '1405/01/01', to: '1405/12/29',
});
const groupIn = (ledB.lines || []).filter((l) => l.is_group && Number(l.qty_in) > 0);
ok(groupIn.length >= 1, 'transfer in collapsed to parent group');
ok(groupIn[0] && Number(groupIn[0].qty_in) === 24, 'parent qty_in=24 got ' + (groupIn[0] && groupIn[0].qty_in));
ok(groupIn[0] && Array.isArray(groupIn[0].details) && groupIn[0].details.length === 4,
  '4 detail lines under parent');
ok(groupIn[0] && String(groupIn[0].tx_no || groupIn[0].doc_num || '').includes('WH'),
  'parent shows WH doc num');

postInventoryMovement(db, {
  eventType: 'sale', productId: pid, warehouseId: whB, qtyOut: 2,
  sourceType: 'invoice', sourceId: 900504, date: '1405/07/20',
  note: 'فروش فاکتور معمولی T-TEST', createdBy: adminId, updateAvg: false, allowNegative: true,
});
postInventoryMovement(db, {
  eventType: 'sale', productId: pid, warehouseId: whB, qtyOut: 1,
  sourceType: 'invoice', sourceId: 900504, date: '1405/07/20',
  note: 'فروش فاکتور معمولی T-TEST', createdBy: adminId, updateAvg: false, allowNegative: true,
});

const ledB2 = buildStockLedger(db, {
  product_id: pid, warehouse_id: whB, from: '1405/01/01', to: '1405/12/29',
});
const saleGroup = (ledB2.lines || []).filter((l) => l.is_group && Number(l.qty_out) > 0);
ok(saleGroup.length >= 1, 'invoice sales collapsed');
ok(saleGroup.some((l) => Number(l.qty_out) === 3), 'sale parent qty_out=3');

// Physical WH qty matches transfer only (24), not the +1 seed → seed is redundant.
db.prepare('UPDATE warehouse_stock SET qty=? WHERE product_id=? AND warehouse_id=?')
  .run(24, pid, whB);
const dry = retireSpuriousKardexAlign(db, { apply: false, productId: pid });
ok(dry.candidates >= 1, 'dry-run finds align seed candidates=' + dry.candidates);
const applied = retireSpuriousKardexAlign(db, { apply: true, productId: pid });
ok(applied.reversed >= 1, 'apply reverses align seeds=' + applied.reversed);

const leftover = db.prepare(`
  SELECT COUNT(*) c FROM inventory_ledger
  WHERE product_id=? AND COALESCE(status,'posted')='posted'
    AND replace(replace(IFNULL(note,''), char(8204), ''), 'ي', 'ی') LIKE '%همترازی کاردکس%'
`).get(pid).c;
ok(leftover === 0, 'no live هم‌ترازی seeds left');

console.log(`\n══ Result: ${passed} passed, ${failed} failed ══\n`);
process.exit(failed ? 1 : 0);
