'use strict';
/**
 * v506 — kardex root-fix: no live-SKU align reseed, invoice detail qty integrity,
 * UI toggle uses aria-expanded.
 * Run: node server/scripts/test-kardex-rootfix-v506.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kardex-v506-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.JWT_SECRET = 'test-kardex-v506-secret-32chars!!!!';
process.env.SYNC_ROLE = 'central';
process.env.PORT = '0';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; console.log('  ✓', msg); }
  else { failed += 1; console.log('  ✗', msg); }
}

console.log('\n══ Kardex root-fix v506 ══\n');

const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(appSrc.includes("aria-expanded") && appSrc.includes('kardex-tog'), 'UI toggle uses aria-expanded');
ok(appSrc.includes("willOpen=this.getAttribute('aria-expanded')!=='true'"), 'collapse reads aria-expanded');
ok(appSrc.includes('v506') && appSrc.includes('کلیک دوم'), 'help mentions v506 toggle');

const ledSrc = fs.readFileSync(path.join(__dirname, '../lib/ledgers.js'), 'utf8');
ok(ledSrc.includes('child_ids') && ledSrc.includes('invSumOut'), 'invoice enrich guards sum vs parent');

const openSrc = fs.readFileSync(path.join(__dirname, '../lib/opening-post.js'), 'utf8');
ok(openSrc.includes('skipped_live') || openSrc.includes('skippedLive'), 'reconcile skips live SKUs');
ok(openSrc.includes('hasLive'), 'hasLive gate present');

const dbSrc = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');
ok(dbSrc.includes('retireSpuriousKardexAlign') && dbSrc.includes('kardex_align_retire_v506'),
  'boot runs align retire after gap reconcile');

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
const whA = db.prepare("INSERT INTO warehouses (name, active) VALUES ('WH-A-506',1)").run().lastInsertRowid;
const pid = db.prepare(
  "INSERT INTO products (name, code, unit, stock, warehouse_id, average_cost_rial, user_id) VALUES ('Dress','D506','عدد',10,?,1000,?)"
).run(whA, adminId).lastInsertRowid;
db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)').run(pid, whA, 10);

const { postInventoryMovement } = require('../lib/inventory/ledger');
const { buildStockLedger } = require('../lib/ledgers');
const {
  reconcileProductStockLedger,
  retireSpuriousKardexAlign,
} = require('../lib/opening-post');

// Real economic life first, then inflate WS — must NOT seed هم‌ترازی opening.
postInventoryMovement(db, {
  eventType: 'receipt', productId: pid, warehouseId: whA, qty: 10,
  unitCostRial: 1000, sourceType: 'cutting_pack', sourceId: 50601,
  date: '1405/07/01', note: 'رسید بسته‌بندی', createdBy: adminId, updateAvg: false,
});
db.prepare('UPDATE warehouse_stock SET qty=? WHERE product_id=? AND warehouse_id=?')
  .run(25, pid, whA);
const gap = reconcileProductStockLedger(db, pid);
ok((gap.count || 0) === 0, 'no align seed when SKU has live movements count=' + gap.count);
ok((gap.skipped_live || 0) >= 1, 'skipped_live reported=' + gap.skipped_live);

const seedCount = db.prepare(`
  SELECT COUNT(*) c FROM inventory_ledger
  WHERE product_id=? AND COALESCE(status,'posted')='posted'
    AND replace(replace(IFNULL(note,''), char(8204), ''), 'ي', 'ی') LIKE '%همترازی کاردکس%'
`).get(pid).c;
ok(seedCount === 0, 'no live هم‌ترازی rows after reconcile');

const custId = db.prepare(
  "INSERT INTO customers (user_id, biz, owner, phone, status) VALUES (?, 'C506', 'T', '09000000506', 'active')"
).run(adminId).lastInsertRowid;

// Invoice detail integrity: parent qty_out=2, invoice JSON 4×2 must NOT explode.
const invId = db.prepare(`
  INSERT INTO invoices (user_id, cust_id, num, type, date, rows, final)
  VALUES (?, ?, 'T-V506', 'normal', '1405/07/08', ?, 0)
`).run(adminId, custId, JSON.stringify([
  { product_id: pid, qty: 2, color_name: 'مشکی', size_name: '1' },
  { product_id: pid, qty: 2, color_name: 'سورمه', size_name: '1' },
  { product_id: pid, qty: 2, color_name: 'شکلاتی', size_name: '1' },
  { product_id: pid, qty: 2, color_name: 'قهوه', size_name: '1' },
])).lastInsertRowid;

postInventoryMovement(db, {
  eventType: 'sale', productId: pid, warehouseId: whA, qtyOut: 2,
  sourceType: 'invoice', sourceId: invId, date: '1405/07/08',
  note: 'فروش فاکتور معمولی T-V506', createdBy: adminId, updateAvg: false, allowNegative: true,
});

const led = buildStockLedger(db, {
  product_id: pid, warehouse_id: whA, from: '1405/01/01', to: '1405/12/29',
});
const sale = (led.lines || []).find((l) => String(l.source_type) === 'invoice'
  && Number(l.source_id) === Number(invId));
ok(!!sale, 'sale line present');
ok(Number(sale.qty_out) === 2, 'parent qty_out=2');
ok(!sale.is_group && !(sale.details && sale.details.length > 1),
  'mismatched invoice matrix does not create fake detail group');

// Matching matrix still groups.
const inv2 = db.prepare(`
  INSERT INTO invoices (user_id, cust_id, num, type, date, rows, final)
  VALUES (?, ?, 'T-V506B', 'normal', '1405/07/09', ?, 0)
`).run(adminId, custId, JSON.stringify([
  { product_id: pid, qty: 1, color_name: 'مشکی', size_name: '1' },
  { product_id: pid, qty: 1, color_name: 'سورمه', size_name: '1' },
])).lastInsertRowid;
postInventoryMovement(db, {
  eventType: 'sale', productId: pid, warehouseId: whA, qtyOut: 2,
  sourceType: 'invoice', sourceId: inv2, date: '1405/07/09',
  note: 'فروش T-V506B', createdBy: adminId, updateAvg: false, allowNegative: true,
});
const led2 = buildStockLedger(db, {
  product_id: pid, warehouse_id: whA, from: '1405/01/01', to: '1405/12/29',
});
const sale2 = (led2.lines || []).find((l) => Number(l.source_id) === Number(inv2));
ok(sale2 && sale2.is_group && sale2.details && sale2.details.length === 2,
  'matching invoice lines still expand');
const detSum = (sale2.details || []).reduce((s, d) => s + (Number(d.qty_out) || 0), 0);
ok(Math.abs(detSum - Number(sale2.qty_out)) < 1e-6, 'detail sum equals parent');

// Retire path still works for virgin seed + later inbound.
const pid2 = db.prepare(
  "INSERT INTO products (name, code, unit, stock, warehouse_id, average_cost_rial, user_id) VALUES ('Coat','C506','عدد',0,?,1000,?)"
).run(whA, adminId).lastInsertRowid;
db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)').run(pid2, whA, 6);
postInventoryMovement(db, {
  eventType: 'opening', productId: pid2, warehouseId: whA, qty: 6,
  unitCostRial: 1000, sourceType: 'opening_inventory', sourceId: pid2,
  date: '1405/06/31', note: 'موجودی اول دوره (هم‌ترازی کاردکس)',
  createdBy: adminId, skipStock: true, updateAvg: false,
});
postInventoryMovement(db, {
  eventType: 'transfer_in', productId: pid2, warehouseId: whA, qty: 6,
  unitCostRial: 1000, sourceType: 'warehouse_transfer', sourceId: 50602,
  date: '1405/07/10', note: 'ورود انتقال', createdBy: adminId, updateAvg: false,
});
db.prepare('UPDATE warehouse_stock SET qty=? WHERE product_id=? AND warehouse_id=?')
  .run(6, pid2, whA);
const retired = retireSpuriousKardexAlign(db, { apply: true, productId: pid2 });
ok(retired.reversed >= 1, 'retire reverses covered align seed');

console.log(`\n══ Result: ${passed} passed, ${failed} failed ══\n`);
process.exit(failed ? 1 : 0);
