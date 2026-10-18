'use strict';
/**
 * v460 — تعداد، رنگ و سایز مستقل برای هر محصول یک اجرای مشترک
 * Run: node server/scripts/test-order-fg-qty-v460.js
 */
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  OK', msg); }
  else { failed++; console.log('  FAIL', msg, detail != null ? detail : ''); }
}
function eq(msg, a, b) {
  ok(Number(a) === Number(b) || a === b, msg, `got ${a} expected ${b}`);
}

console.log('\n══ independent FG qty on a joint production order v460 ══\n');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const engSrc = fs.readFileSync(path.join(__dirname, '../lib/production/engine.js'), 'utf8');
const schemaSrc = fs.readFileSync(path.join(__dirname, '../lib/production/schema.js'), 'utf8');
ok(appJs.includes('po-fg-qty') && appJs.includes('fg_plan'), 'UI per-product qty and fg_plan');
ok(appJs.includes('data-fg-pid'), 'UI matrix per product');
ok(appJs.includes('prodOrderEditJointModal'), 'draft edit keeps each product');
ok(schemaSrc.includes("ensureColumn(db, 'production_orders', 'fg_plan_json'"), 'column fg_plan_json');
ok(engSrc.includes('resolveMatrixGroups') && engSrc.includes('fgPlanJson'), 'server stores independent plan');
ok(appJs.includes('v420/v423/v459/v460'), 'help mentions v460');

let parseFgPlanJson;
let orderFgPlanRows;
try {
  ({ parseFgPlanJson } = require('../lib/production/bom'));
} catch (e) {
  console.log('\nSKIP bom require:', e.message);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
const parsed = parseFgPlanJson(JSON.stringify([{ product_id: 11, qty: 7 }, { product_id: 22, qty: 3 }]));
eq('stored plan keeps 7', parsed[11], 7);
eq('stored plan keeps 3', parsed[22], 3);
ok(parseFgPlanJson('') == null && parseFgPlanJson('[]') == null, 'empty plan is absent');

let Database;
try {
  Database = require('better-sqlite3');
  const probe = new Database(':memory:');
  probe.close();
} catch (e) {
  console.log('\nSKIP SQLite ABI — static checks done:', e.message);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const { freshDb } = require('./lib/test-harness');
const bom = require('../lib/production/bom');
const advBom = require('../lib/production/bom-advanced');
const engine = require('../lib/production/engine');
const engAdv = require('../lib/production/engine-advanced');
orderFgPlanRows = bom.orderFgPlanRows;

const { db, cleanup } = freshDb();
try {
  const adminId = 1;
  const DATE = '1405/07/27';
  function seedProduct(name, type, mfg) {
    const id = db.prepare('INSERT INTO products (user_id,name,price,stock) VALUES (1,?,?,0)').run(name, 0).lastInsertRowid;
    db.prepare(`UPDATE products SET item_type=?, is_manufactured=?, average_cost_rial=0, unit='عدد', code=? WHERE id=?`)
      .run(type, mfg, 'T460-' + id, id);
    return id;
  }
  const pA = seedProduct('یلدا', 'finished', 1);
  const pB = seedProduct('آبان', 'finished', 1);
  const pFab = seedProduct('پارچه', 'raw', 0);
  const cc = db.prepare("SELECT id FROM cost_centers WHERE code='CC-10'").get()?.id
    || db.prepare('SELECT id FROM cost_centers LIMIT 1').get()?.id;
  const whRaw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get()?.id
    || db.prepare('SELECT id FROM warehouses LIMIT 1').get()?.id;
  const whFg = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get()?.id || whRaw;
  ok(!!cc && !!whRaw, 'db seed centers');
  db.prepare('UPDATE products SET average_cost_rial=1000, stock=1000 WHERE id=?').run(pFab);
  db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,1000)').run(pFab, whRaw);

  const draft = bom.createBom(db, {
    product_id: pA,
    name: 'BOM-FG-QTY',
    has_routing: 1,
    has_coproducts: 1,
    co_product_ids: [pB],
    auto_share_method: 'physical',
    base_qty: 1,
    yield_percent: 100,
    lines: [{
      component_product_id: pFab, qty_per_base: 1, line_type: 'material',
      product_scope: 'shared', stage_cost_center_id: cc,
    }],
  }, adminId);
  db.prepare(`UPDATE bom_outputs SET qty_per_base=2 WHERE bom_id=? AND product_id=?`).run(draft.id, pB);
  advBom.addOperation(db, draft.id, {
    seq: 10, cost_center_id: cc, operation_name: 'برش',
    labor_method: 'contract', yield_percent: 100, product_scope: 'shared',
  }, adminId);
  advBom.addOperation(db, draft.id, {
    seq: 20, cost_center_id: cc, operation_name: 'دوخت یلدا',
    labor_method: 'contract', yield_percent: 100,
    product_scope: 'exclusive', scoped_product_id: pA,
  }, adminId);
  advBom.addOperation(db, draft.id, {
    seq: 30, cost_center_id: cc, operation_name: 'دوخت آبان',
    labor_method: 'contract', yield_percent: 100,
    product_scope: 'exclusive', scoped_product_id: pB,
  }, adminId);
  db.prepare(`UPDATE bom_outputs SET cost_share_percent=50 WHERE bom_id=? AND output_type='main'`).run(draft.id);
  bom.activateBom(db, draft.id, '1405/01/01', adminId);
  db.prepare(`UPDATE bom_outputs SET qty_per_base=2, cost_share_percent=50 WHERE bom_id=? AND product_id=?`).run(draft.id, pB);
  db.prepare(`UPDATE bom_outputs SET qty_per_base=1, cost_share_percent=50 WHERE bom_id=? AND product_id=?`).run(draft.id, pA);

  const formula = bom.planBomFgOutputs(db, draft.id, 7, pA);
  eq('formula would scale the peer by qty_per_base', formula.find(p => p.product_id === pB)?.qty_planned, 14);

  const po = engine.createOrder(db, {
    product_id: pA, bom_id: draft.id, qty_planned: 7,
    analysis_type: 'fixed_adv', date: DATE,
    warehouse_raw_id: whRaw, warehouse_fg_id: whFg, cost_center_id: cc,
    fg_plan: [{ product_id: pA, qty: 7 }, { product_id: pB, qty: 3 }],
  }, adminId);
  const detail = engine.getOrderDetail(db, po.id);
  eq('header qty stays the selected product', detail.qty_planned, 7);
  eq('stored peer qty is independent', detail.fg_plan.find(p => p.product_id === pB)?.qty_planned, 3);
  eq('share stays on the BOM percent', detail.fg_plan.find(p => p.product_id === pB)?.cost_share_percent, 50);
  const shown = orderFgPlanRows(db, po);
  eq('detail helper reads the stored plan', shown.find(p => p.product_id === pB)?.qty_planned, 3);

  engine.releaseOrder(db, po.id, adminId);
  const stages = engAdv.stageList(db, po.id);
  eq('cut is the sum of the two qtys', stages.find(s => s.seq === 10)?.qty_in, 10);
  eq('yalda sew stays 7', stages.find(s => s.seq === 20)?.qty_in, 7);
  eq('aban sew stays 3, not the formula 14', stages.find(s => s.seq === 30)?.qty_in, 3);

  const reserved = db.prepare(`
    SELECT COALESCE(SUM(qty),0) q FROM production_reservations
    WHERE order_id=? AND product_id=? AND status='active'
  `).get(po.id, pFab)?.q;
  eq('shared fabric reserved for 7+3', reserved, 10);

  const listed = engine.listOrders(db, {}).rows.find(r => r.id === po.id);
  eq('list carries both products', (listed.fg_plan || []).length, 2);
  eq('list peer qty stays 3', listed.fg_plan.find(p => p.product_id === pB)?.qty_planned, 3);

  const reports = require('../lib/production/reports');
  const sheet = reports.costSheet(db, { orderId: po.id });
  eq('cost sheet splits both products', (sheet.data.summary.products || []).length, 2);
  eq('cost sheet peer qty', sheet.data.summary.products.find(p => p.product_id === pB)?.qty_planned, 3);
  eq('cost sheet keeps BOM share', sheet.data.summary.products.find(p => p.product_id === pB)?.cost_share_percent, 50);
} catch (e) {
  ok(false, 'sqlite scenario', e && (e.stack || e.message || e));
} finally {
  try { cleanup(); } catch (_) {}
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
