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
ok(appSrc.includes("editing?'*'") || appSrc.includes('editing?\'*\''), 'pack edit defaults to all colors');
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
const whA = db.prepare("INSERT INTO warehouses (name, active) VALUES ('WH-A',1)").run().lastInsertRowid;
const whB = db.prepare("INSERT INTO warehouses (name, active) VALUES ('WH-B',1)").run().lastInsertRowid;
const pid = db.prepare(
  "INSERT INTO products (name, code, unit, stock, warehouse_id, average_cost_rial) VALUES ('Jacket','J504','عدد',0,?,1000)"
).run(whA).lastInsertRowid;

db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)').run(pid, whA, 24);
db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)').run(pid, whB, 0);

const { postInventoryMovement } = require('../lib/inventory/ledger');
const { createWarehouseDoc } = require('../lib/warehouse-docs');
const { buildStockLedger } = require('../lib/ledgers');
const { retireSpuriousKardexAlign, reconcileProductStockLedger } = require('../lib/opening-post');

// Fake align seed on WH-B while real transfer will land there later — seed on WH-A gap first
reconcileProductStockLedger(db, pid, {
  createdBy: adminId,
  noteIn: 'موجودی اول دوره (هم‌ترازی کاردکس)',
});

const user = { id: adminId, role: 'admin', name: 'Admin' };
// Need colors/sizes optional — transfer without variants
const doc = createWarehouseDoc(db, {
  type: 'transfer',
  date: '1405/07/18',
  from_warehouse_id: whA,
  to_warehouse_id: whB,
  lines: [
    { product_id: pid, qty: 6 },
    { product_id: pid, qty: 6 },
    { product_id: pid, qty: 6 },
    { product_id: pid, qty: 6 },
  ],
}, user);

ok(doc && doc.num, 'transfer doc created ' + (doc && doc.num));

const ledB = buildStockLedger(db, {
  product_id: pid, warehouse_id: whB, from: '1405/01/01', to: '1405/12/29',
});
const groupIn = (ledB.lines || []).filter((l) => l.is_group && Number(l.qty_in) > 0);
ok(groupIn.length >= 1, 'transfer in collapsed to parent group');
ok(groupIn[0] && Number(groupIn[0].qty_in) === 24, 'parent qty_in=24 got ' + (groupIn[0] && groupIn[0].qty_in));
ok(groupIn[0] && Array.isArray(groupIn[0].details) && groupIn[0].details.length === 4,
  '4 detail lines under parent');
ok(groupIn[0] && String(groupIn[0].tx_no || groupIn[0].doc_num || '').startsWith('WH'),
  'parent shows WH doc num');

// Invoice-style multi sale rows same source_id
postInventoryMovement(db, {
  eventType: 'sale', productId: pid, warehouseId: whB, qtyOut: 2,
  sourceType: 'invoice', sourceId: 900504, date: '1405/07/20',
  note: 'فروش فاکتور معمولی T-TEST', createdBy: adminId, updateAvg: false,
});
postInventoryMovement(db, {
  eventType: 'sale', productId: pid, warehouseId: whB, qtyOut: 1,
  sourceType: 'invoice', sourceId: 900504, date: '1405/07/20',
  note: 'فروش فاکتور معمولی T-TEST', createdBy: adminId, updateAvg: false,
});
db.prepare(
  "INSERT INTO invoices (cust_id, num, type, date, rows, subtotal, final, stock_deducted) VALUES (1,'T-TEST','ordinary','1405/07/20',?,?,?,1)"
).run(JSON.stringify([
  { product_id: pid, qty: 2, color_name: 'مشکی', size_name: 'فری' },
  { product_id: pid, qty: 1, color_name: 'سورمه‌ای', size_name: 'فری' },
]), 0, 0);

const ledB2 = buildStockLedger(db, {
  product_id: pid, warehouse_id: whB, from: '1405/01/01', to: '1405/12/29',
});
const saleGroup = (ledB2.lines || []).filter((l) => l.is_group && Number(l.qty_out) > 0);
ok(saleGroup.length >= 1, 'invoice sales collapsed');
ok(saleGroup.some((l) => Number(l.qty_out) === 3), 'sale parent qty_out=3');

const dry = retireSpuriousKardexAlign(db, { apply: false, productId: pid });
ok(dry.candidates >= 1, 'dry-run finds align seed candidates=' + dry.candidates);
const applied = retireSpuriousKardexAlign(db, { apply: true, productId: pid });
ok(applied.reversed >= 1, 'apply reverses align seeds=' + applied.reversed);

const leftover = db.prepare(`
  SELECT COUNT(*) c FROM inventory_ledger
  WHERE product_id=? AND COALESCE(status,'posted')='posted'
    AND replace(replace(IFNULL(note,''), char(8204), ''), 'ي', 'ی') LIKE '%هم‌ترازی کاردکس%'
`).get(pid).c;
ok(leftover === 0, 'no live هم‌ترازی seeds left');

console.log(`\n══ Result: ${passed} passed, ${failed} failed ══\n`);
process.exit(failed ? 1 : 0);
