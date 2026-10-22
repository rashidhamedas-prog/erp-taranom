#!/usr/bin/env node
/**
 * v526: (1) open-month sales return enters at original invoice issue unit cost;
 * (2) open-month cutting/order receipt value change with a sold share posts to COGS
 * and creates a bell notification (no approval queue).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v526-'));
const dbPath = path.join(tmp, 't.db');
process.env.DB_PATH = dbPath;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'x'.repeat(48);
process.env.NODE_ENV = 'test';

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const L = require('../lib/inventory/ledger');
const VAP = require('../lib/inventory/value-approval');
const PL = require('../lib/inventory/period-lock');
const SR = require('../lib/sales-return-doc');
const OCR = require('../lib/production/order-cost-reconcile');
const { acct } = require('../lib/coa-map');
const { postToLedger } = require('../lib/ledger');

let pass = 0, fail = 0;
function ok(c, m, extra) {
  if (c) { pass++; console.log('  OK  ', m); }
  else { fail++; console.log('  FAIL', m, extra != null ? JSON.stringify(extra) : ''); }
}
function attempt(fn) {
  try { return { value: fn() }; } catch (e) { return { error: e }; }
}

const uid = 1;
const user = { id: uid, role: 'admin', username: 'admin' };
db.prepare("INSERT OR IGNORE INTO users (id,name,username,password,role,active) VALUES (1,'Admin','admin','x','admin',1)").run();

function mkWh(name) {
  return Number(db.prepare("INSERT INTO warehouses (name,code,active) VALUES (?,?,1)").run(name, 'W' + Date.now() + Math.random()).lastInsertRowid);
}
function mkProduct(code) {
  return Number(db.prepare(
    "INSERT INTO products (user_id,name,code,stock,average_cost_rial,cost,unit) VALUES (?,?,?,0,0,0,'عدد')"
  ).run(uid, `کالا ${code}`, code).lastInsertRowid);
}
function postJe(st, sid, date, dr, cr, amountRial) {
  const a = Math.round(amountRial) / 10;
  postToLedger(db, {
    sourceType: st, sourceId: sid, date, description: st, createdBy: uid,
    lines: [
      { code: dr.code, name: dr.name, debit: a, credit: 0 },
      { code: cr.code, name: cr.name, debit: 0, credit: a },
    ],
  });
}

console.log('\n[1] open-month sales return at original issue rate');
{
  const W = mkWh('فروش باز');
  const p = mkProduct('SR-OPEN');
  const inv = L.inventoryAccountForWarehouse(db, W);
  const ap = acct(db, 'coa_grni');
  const cogs = acct(db, 'coa_cogs');
  const custId = Number(db.prepare("INSERT INTO customers (user_id,biz,owner,status) VALUES (?,'C','O','active')").run(uid).lastInsertRowid);
  L.postInventoryMovement(db, { eventType: 'purchase', productId: p, warehouseId: W, qtyIn: 10, unitCostRial: 1000, sourceType: 'purchase', sourceId: 1, date: '1405/07/02', createdBy: uid });
  postJe('test_purchase', 1, '1405/07/02', inv, ap, 10000);
  const invId = Number(db.prepare(`
    INSERT INTO invoices (user_id,cust_id,num,type,date,rows,subtotal,final) VALUES (?,?,?,?,?,?,?,?)
  `).run(uid, custId, 'T-OPEN', 'normal', '1405/07/03', JSON.stringify([{ product_id: p, qty: 4, price: 5000, warehouse_id: W }]), 20000, 20000).lastInsertRowid);
  const sale = L.postInventoryMovement(db, { eventType: 'sale', productId: p, warehouseId: W, qtyOut: 4, sourceType: 'invoice', sourceId: invId, date: '1405/07/03', createdBy: uid });
  postJe('test_cogs', invId, '1405/07/03', cogs, inv, sale.amount_rial);
  // Later purchase raises pool avg so a naive return would use ~1500, not 1000.
  L.postInventoryMovement(db, { eventType: 'purchase', productId: p, warehouseId: W, qtyIn: 10, unitCostRial: 2000, sourceType: 'purchase', sourceId: 2, date: '1405/07/10', createdBy: uid });
  postJe('test_purchase', 2, '1405/07/10', inv, ap, 20000);
  const avg = () => Math.round(Number(db.prepare('SELECT average_cost_rial a FROM products WHERE id=?').get(p).a) || 0);
  ok(avg() === 1625, `pool avg before return 1625 (got ${avg()})`);

  const r = attempt(() => SR.createSalesReturn(db, {
    cust_id: custId, invoice_id: invId, date: '1405/07/12',
    rows: [{ product_id: p, qty: 2, cost_rial: 9999 }], // bogus line cost — must ignore for valuation
  }, user));
  ok(!r.error && r.value && r.value.id, 'open-month sales return posts', r.error && r.error.message);
  const retId = r.value.id;
  const docs = db.prepare("SELECT * FROM inventory_value_approvals WHERE source_type LIKE '%sales_return%' AND source_id=? AND status='pending'").all(retId);
  ok(docs.length === 0, 'open month → no approval doc');
  const led = db.prepare("SELECT * FROM inventory_ledger WHERE source_type='sales_return' AND source_id=? AND reversed_of IS NULL").get(retId);
  ok(led && Math.round(led.amount_rial) === 2000 && Math.round(led.unit_cost_rial) === 1000,
    'return enters at original issue 1000×2=2000 (not pool 1625, not line 9999)',
    { a: led && led.amount_rial, u: led && led.unit_cost_rial });
  const ret = db.prepare('SELECT cost_amount FROM sales_returns WHERE id=?').get(retId);
  ok(Math.round(Number(ret.cost_amount)) === 2000, 'return COGS reversal at original issue 2000', ret);
}

console.log('\n[2] open-month receipt value change with sold share → notify');
{
  const fgWh = (() => {
    const row = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get();
    if (row) return row.id;
    return Number(db.prepare("INSERT INTO warehouses (name,code,active) VALUES ('FG','WH-FG',1)").run().lastInsertRowid);
  })();
  const p = mkProduct('OCR-OPEN');
  const fg = acct(db, 'coa_finished_goods');
  const wip = acct(db, 'coa_wip');
  const cogs = acct(db, 'coa_cogs');
  const poId = Number(db.prepare(`
    INSERT INTO production_orders (order_no, product_id, qty_planned, date, status, analysis_type, material_cost_rial, abnormal_waste_rial)
    VALUES ('PO-OPEN', ?, 100, '1405/07/01', 'completed', 'fixed_adv', 100000, 0)
  `).run(p).lastInsertRowid);
  db.prepare(`
    INSERT INTO production_receipts (order_id, product_id, qty, unit_cost_rial, amount_rial, warehouse_id, date, status)
    VALUES (?,?,100,1000,100000,?,'1405/07/01','posted')
  `).run(poId, p, fgWh);
  L.postInventoryMovement(db, {
    eventType: 'production_receipt', productId: p, warehouseId: fgWh, qtyIn: 100, amountRial: 100000,
    sourceType: 'production_receipt', sourceId: poId, date: '1405/07/01', createdBy: uid,
  });
  postJe('test_prd', poId, '1405/07/01', fg, wip, 100000);
  const sold = L.postInventoryMovement(db, {
    eventType: 'sale', productId: p, warehouseId: fgWh, qtyOut: 40, sourceType: 'invoice', sourceId: 9001, date: '1405/07/05', createdBy: uid,
  });
  postJe('test_cogs2', 9001, '1405/07/05', cogs, fg, sold.amount_rial);

  const n0 = Number(db.prepare("SELECT COUNT(*) c FROM app_notifications WHERE kind='value_change_auto_cogs'").get().c);
  // Bump receipt by +20000 → 40% sold → 8000 to COGS, 12000 to FG
  const receipt = db.prepare('SELECT * FROM production_receipts WHERE order_id=?').get(poId);
  db.prepare('UPDATE production_receipts SET amount_rial=amount_rial+20000, unit_cost_rial=? WHERE id=?')
    .run(Math.round(120000 / 100), receipt.id);
  const routed = OCR.routeReceiptValueChange(db, {
    sourceType: 'order_cost_receipt_align', sourceId: poId,
    label: `هم‌ترازی بهای رسید سفارش #${poId}`,
    eventNote: 'تست v526',
    shares: [{ receipt: { ...receipt, amount_rial: 120000 }, share: 20000 }],
    date: '1405/07/08', userId: uid,
  });
  ok(routed.sold_cogs_rial === 8000, `sold_cogs_rial=8000 (got ${routed.sold_cogs_rial})`);
  ok(!routed.approval, 'open month → no approval doc');
  const n1 = Number(db.prepare("SELECT COUNT(*) c FROM app_notifications WHERE kind='value_change_auto_cogs'").get().c);
  ok(n1 === n0 + 1, 'one bell notification created');
  const note = db.prepare("SELECT title,body FROM app_notifications WHERE kind='value_change_auto_cogs' ORDER BY id DESC LIMIT 1").get();
  ok(note && /فروش‌رفته/.test(note.title) && /بهای تمام‌شده/.test(note.body), 'notification title/body mention sold share → COGS', note);
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
