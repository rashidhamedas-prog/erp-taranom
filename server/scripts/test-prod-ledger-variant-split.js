#!/usr/bin/env node
'use strict';
/**
 * Stock single-source — production ledger rows of a matrix product carry variant_id.
 * One posting = one row per colour×size; Σ amount equals the single-row amount; voids reverse
 * every split row; a WIP pack exit splits over the pack's remaining SKUs.
 * Run: node server/scripts/test-prod-ledger-variant-split.js
 */
const { ok, eq, throws, freshDb, summary } = require('./lib/test-harness');

const { db, cleanup } = freshDb();
try {
  const costing = require('../lib/production/costing');
  const apparel = require('../lib/inventory/apparel-lines');
  const { relieveStagedPackQty } = require('../lib/production/cutting');

  const uid = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
  const wh = db.prepare("INSERT INTO warehouses (code,name,active) VALUES ('WH-T','تست',1)").run().lastInsertRowid;
  const wip = db.prepare("INSERT INTO warehouses (code,name,active) VALUES ('WH-TW','کار در جریان تست',1)").run().lastInsertRowid;
  const color = db.prepare("INSERT INTO product_colors (name, active, sort_order) VALUES ('مشکی',1,1)").run().lastInsertRowid;
  const sizes = ['38', '40', '42'].map((n, i) => db.prepare(
    'INSERT INTO product_sizes (name, active, sort_order) VALUES (?,1,?)'
  ).run(n, i + 1).lastInsertRowid);
  const pid = db.prepare(
    "INSERT INTO products (user_id, name, code, unit, item_type, is_manufactured) VALUES (?, 'مانتو تست','SPLIT-1','عدد','finished',1)"
  ).run(uid).lastInsertRowid;
  const [v1, v2, v3] = sizes.map((s) => db.prepare(
    'INSERT INTO product_variants (product_id, color_id, size_id, stock, active, is_default) VALUES (?,?,?,0,1,0)'
  ).run(pid, color, s).lastInsertRowid);
  const plain = db.prepare(
    "INSERT INTO products (user_id, name, code, unit, item_type) VALUES (?, 'نخ تست','SPLIT-Y','متر','raw')"
  ).run(uid).lastInsertRowid;

  const rows = (where, ...p) => db.prepare(`SELECT * FROM inventory_ledger WHERE ${where} ORDER BY id`).all(...p);
  const header = (id) => Number(db.prepare('SELECT stock FROM products WHERE id=?').get(id).stock) || 0;
  const vstock = (id) => Number(db.prepare('SELECT stock FROM product_variants WHERE id=?').get(id).stock) || 0;

  console.log('\n== matrix FG receipt: one row per SKU, Σ amount exact ==');
  const ORDER = 9101;
  throws('matrix receipt without colour×size → E_VARIANT_REQUIRED', () => costing.updateMovingAverage(db, {
    productId: pid, warehouseId: wh, qtyIn: 3, amountRial: 1000, userId: uid,
    sourceType: 'production_receipt', sourceId: ORDER, date: '1405/08/01',
  }), 'E_VARIANT_REQUIRED');
  ok('refused receipt writes no ledger row', rows('product_id=?', pid).length === 0);

  const rec = db.transaction(() => costing.updateMovingAverage(db, {
    productId: pid, warehouseId: wh, qtyIn: 3, amountRial: 1000, userId: uid,
    note: 'تولید PO-SPLIT', sourceType: 'production_receipt', sourceId: ORDER, date: '1405/08/01',
    variantLines: [{ variantId: v1, qty: 1 }, { variantId: v2, qty: 1 }, { variantId: v3, qty: 1 }],
  }))();
  const recRows = rows("product_id=? AND event_type='production_receipt'", pid);
  ok('3 receipt rows', recRows.length === 3, JSON.stringify(recRows.map((r) => r.qty_in)));
  ok('every row carries variant_id', recRows.every((r) => Number(r.variant_id) > 0));
  eq('Σ amount = 1000', recRows.reduce((s, r) => s + r.amount_rial, 0), 1000);
  ok('remainder on last row (333/333/334)', recRows.map((r) => r.amount_rial).join('/') === '333/333/334');
  ok('result ledger_ids lists all rows', (rec.ledger_ids || []).length === 3);
  eq('header stock 3', header(pid), 3);
  ok('each SKU stock 1', vstock(v1) === 1 && vstock(v2) === 1 && vstock(v3) === 1);
  eq('average equals single-row average (round(1000/3))', rec.new_avg, 333);

  console.log('\n== matrix issue + group void ==');
  const iss = db.transaction(() => costing.issueFromStock(db, {
    productId: pid, warehouseId: wh, qty: 2, userId: uid, note: 'مصرف مرحله 1 PO-SPLIT',
    variantLines: [{ variant_id: v1, qty: 1 }, { variant_id: v2, qty: 1 }],
    sourceType: 'production_issue', sourceId: ORDER, date: '1405/08/02',
  }))();
  ok('issue split into 2 rows', (iss.ledger_ids || []).length === 2);
  eq('issue Σ amount = 2 × avg', iss.amount_rial, 666);
  ok('SKUs 1/2 drained', vstock(v1) === 0 && vstock(v2) === 0 && vstock(v3) === 1);
  db.transaction(() => costing.reverseIssueStock(db, {
    productId: pid, warehouseId: wh, qty: 2, userId: uid, orderId: ORDER, stageSeq: 1, date: '1405/08/03',
  }))();
  ok('both issue rows reversed', rows("product_id=? AND event_type='production_issue' AND status='posted'", pid).length === 0);
  ok('SKUs restored after issue void', vstock(v1) === 1 && vstock(v2) === 1 && header(pid) === 3);

  db.transaction(() => costing.reverseReceiptStock(db, {
    productId: pid, warehouseId: wh, qty: 3, userId: uid, orderId: ORDER, orderNo: 'PO-SPLIT', date: '1405/08/04',
  }))();
  ok('all 3 receipt rows reversed', rows("product_id=? AND event_type='production_receipt' AND status='posted'", pid).length === 0);
  ok('receipt void zeroes header + SKUs', header(pid) === 0 && vstock(v1) === 0 && vstock(v2) === 0 && vstock(v3) === 0);

  console.log('\n== non-matrix stays one row without variant ==');
  db.transaction(() => costing.updateMovingAverage(db, {
    productId: plain, warehouseId: wh, qtyIn: 10, amountRial: 5000, userId: uid,
    sourceType: 'production_receipt', sourceId: ORDER, date: '1405/08/01',
  }))();
  const pr = rows('product_id=?', plain);
  ok('single plain row, variant_id NULL', pr.length === 1 && pr[0].variant_id == null && pr[0].amount_rial === 5000);

  console.log('\n== WIP pack exit splits over remaining SKUs ==');
  db.pragma('foreign_keys = OFF');
  const PO = 9202;
  const packId = db.prepare(`
    INSERT INTO cutting_packs (pack_no, lay_id, production_order_id, product_id, warehouse_id, qty, amount_rial, status, date)
    VALUES ('PK-SPLIT', 0, ?, ?, ?, 5, 5000, 'posted', '1405/08/05')
  `).run(PO, pid, wip).lastInsertRowid;
  db.pragma('foreign_keys = ON');
  db.transaction(() => apparel.postLedgerByVariant(db, {
    eventType: 'cutting_pack', productId: pid, warehouseId: wip, qtyIn: 5, unitCostRial: 1000, amountRial: 5000,
    sourceType: 'cutting_pack', sourceId: packId, date: '1405/08/05', note: 'بسته برش (WIP) PK-SPLIT',
    createdBy: uid, updateAvg: false, warehouseOnly: true,
  }, [{ variantId: v1, qty: 2 }, { variantId: v2, qty: 3 }]))();
  eq('WIP pack does not touch header', header(pid), 0);
  db.transaction(() => relieveStagedPackQty(db, { orderId: PO, productId: pid, qtyGood: 3, userId: uid, date: '1405/08/06', receiptId: 1 }))();
  let out = rows("source_type='cutting_pack' AND source_id=? AND qty_out>0", packId);
  ok('partial exit rows carry variants', out.length >= 1 && out.every((r) => Number(r.variant_id) > 0));
  eq('partial exit qty 3', out.reduce((s, r) => s + r.qty_out, 0), 3);
  ok('partial exit in whole pieces', out.every((r) => Number.isInteger(r.qty_out)));
  eq('partial exit amount pro rata (3000)', out.reduce((s, r) => s + r.amount_rial, 0), 3000);
  db.transaction(() => relieveStagedPackQty(db, { orderId: PO, productId: pid, qtyGood: 2, userId: uid, date: '1405/08/06', receiptId: 2 }))();
  out = rows("source_type='cutting_pack' AND source_id=? AND qty_out>0", packId);
  const per = new Map();
  for (const r of out) per.set(r.variant_id, (per.get(r.variant_id) || 0) + r.qty_out);
  ok('full exit drains each SKU exactly', per.get(v1) === 2 && per.get(v2) === 3, JSON.stringify([...per]));
  eq('Σ exit amount = pack amount', out.reduce((s, r) => s + r.amount_rial, 0), 5000);
  const wipVws = db.prepare('SELECT COALESCE(SUM(qty),0) q FROM variant_warehouse_stock WHERE warehouse_id=?').get(wip).q;
  eq('WIP variant figures back to 0', wipVws, 0);

  console.log('\n== matrix row without breakdown fails before any write ==');
  const before = rows('product_id=?', pid).length;
  throws('postLedgerByVariant matrix without lines → E_VARIANT_REQUIRED', () => apparel.postLedgerByVariant(db, {
    eventType: 'production_return', productId: pid, warehouseId: wh, qtyIn: 1, unitCostRial: 10,
    sourceType: 'test', date: '1405/08/07',
  }, []), 'E_VARIANT_REQUIRED');
  ok('no row written', rows('product_id=?', pid).length === before);
} catch (e) {
  console.error(e);
  ok('unexpected error: ' + (e.code || e.message), false);
} finally {
  cleanup();
}
summary('prod-ledger-variant-split');
