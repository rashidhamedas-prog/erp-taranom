'use strict';
/**
 * v459 — مراحل سفارش چندمحصولی از دامنهٔ عملیات BOM
 * Run: node server/scripts/test-order-stage-scope-v459.js
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

console.log('\n══ order stages follow multiproduct BOM v459 ══\n');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const idxSrc = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const advSrc = fs.readFileSync(path.join(__dirname, '../lib/production/engine-advanced.js'), 'utf8');

ok(appJs.includes('prodOrderPreviewStages') && appJs.includes('po-stage-plan'), 'UI stage plan');
ok(appJs.includes('برنامه محصولات این اجرای مشترک'), 'UI fg plan kept');
ok(appJs.includes('مرحلهٔ مشترک جمع تعداد'), 'UI explains shared qty');
ok(appJs.includes('سفارش چندمحصولی — اجرای مشترک (v420/v423/v459/v460)'), 'Help v460');
ok(swSrc.includes('erp-taranom-v460'), 'SW v460');
ok(idxSrc.includes('app.js?v=460') && idxSrc.includes('prod-ui.css?v=460'), 'index v460');
ok(advSrc.includes('planScopedStageQtys') && advSrc.includes('handoffNextStage'), 'release uses scoped plan');
ok(advSrc.includes('qtyByProduct: orderFgQtyMap'), 'issue/reserve uses per-product qty');

let planScopedStageQtys;
try {
  ({ planScopedStageQtys } = require('../lib/production/bom-advanced'));
} catch (e) {
  console.log('\nSKIP planner require:', e.message);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const shared = { id: 1, seq: 10, product_scope: 'shared', yield_percent: 100, normal_waste_percent: 0 };
const sewA = { id: 2, seq: 20, product_scope: 'exclusive', scoped_product_id: 11, yield_percent: 100, normal_waste_percent: 0, operation_name: 'دوخت یلدا' };
const sewB = { id: 3, seq: 30, product_scope: 'exclusive', scoped_product_id: 22, yield_percent: 100, normal_waste_percent: 0, operation_name: 'دوخت آبان' };
const rows = planScopedStageQtys([shared, sewA, sewB], { 11: 10, 22: 6 });
eq('shared qty is sum', rows.find(r => r.operation_id === 1)?.qty_in, 16);
eq('exclusive A keeps own qty', rows.find(r => r.operation_id === 2)?.qty_in, 10);
eq('exclusive B keeps own qty', rows.find(r => r.operation_id === 3)?.qty_in, 6);
eq('A is exclusive', rows.find(r => r.operation_id === 2)?.product_scope, 'exclusive');

const bothShared = planScopedStageQtys(
  [{ id: 9, seq: 10, product_scope: 'shared', yield_percent: 100, normal_waste_percent: 0 }],
  { 11: 10, 22: 10 }
);
eq('one shared op sums both', bothShared[0]?.qty_in, 20);

const classic = planScopedStageQtys(
  [
    { id: 1, seq: 10, product_scope: 'shared', yield_percent: 98, normal_waste_percent: 0 },
    { id: 2, seq: 20, product_scope: 'shared', yield_percent: 100, normal_waste_percent: 2 },
  ],
  { 5: 300 }
);
const f = 0.98 * 0.98;
eq('single-product pipe matches ceil(target/factor)', classic[0]?.qty_in, Math.ceil(300 / f - 1e-9));
ok(classic.length === 2 && classic[1].product_scope === 'shared', 'classic keeps both shared stages');

let Database;
try {
  Database = require('better-sqlite3');
  const probe = new Database(':memory:');
  probe.close();
} catch (e) {
  console.log('\nSKIP SQLite ABI — planner checks done:', e.message);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const { freshDb } = require('./lib/test-harness');
const bom = require('../lib/production/bom');
const advBom = require('../lib/production/bom-advanced');
const engine = require('../lib/production/engine');
const engAdv = require('../lib/production/engine-advanced');

const { db, cleanup } = freshDb();
try {
  const adminId = 1;
  const DATE = '1405/07/26';
  function seedProduct(name, type, mfg) {
    const id = db.prepare('INSERT INTO products (user_id,name,price,stock) VALUES (1,?,?,0)').run(name, 0).lastInsertRowid;
    db.prepare(`UPDATE products SET item_type=?, is_manufactured=?, average_cost_rial=0, unit='عدد', code=? WHERE id=?`)
      .run(type, mfg, 'T459-' + id, id);
    return id;
  }
  const pA = seedProduct('یلدا', 'finished', 1);
  const pB = seedProduct('آبان', 'finished', 1);
  const pFab = seedProduct('پارچه', 'raw', 0);
  const cc = db.prepare("SELECT id FROM cost_centers WHERE code='CC-10'").get()?.id
    || db.prepare("SELECT id FROM cost_centers LIMIT 1").get()?.id;
  const whRaw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get()?.id
    || db.prepare('SELECT id FROM warehouses LIMIT 1').get()?.id;
  const whFg = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get()?.id || whRaw;
  ok(!!cc && !!whRaw, 'db seed centers');
  db.prepare('UPDATE products SET average_cost_rial=1000, stock=1000 WHERE id=?').run(pFab);
  db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,1000)').run(pFab, whRaw);

  const draft = bom.createBom(db, {
    product_id: pA,
    name: 'BOM-STAGE-SCOPE',
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

  const po = engine.createOrder(db, {
    product_id: pA, bom_id: draft.id, qty_planned: 4,
    analysis_type: 'fixed_adv', date: DATE,
    warehouse_raw_id: whRaw, warehouse_fg_id: whFg, cost_center_id: cc,
  }, adminId);
  engine.releaseOrder(db, po.id, adminId);
  const stages = engAdv.stageList(db, po.id);
  eq('three stages', stages.length, 3);
  eq('cut qty is both garments', stages.find(s => s.seq === 10)?.qty_in, 8);
  eq('yalda sew stays 4', stages.find(s => s.seq === 20)?.qty_in, 4);
  eq('aban sew stays 4', stages.find(s => s.seq === 30)?.qty_in, 4);
  ok(stages.find(s => s.seq === 20)?.product_scope === 'exclusive', 'yalda scope stored');

  const cut = stages.find(s => s.seq === 10);
  engAdv.postStageOutputFixed(db, {
    orderId: po.id, stageId: cut.id,
    body: { date: DATE, qty_out: 8, waste_normal: 0, waste_abnormal: 0 },
    userId: adminId,
  });
  const after = engAdv.stageList(db, po.id);
  eq('handoff does not replace exclusive qty', after.find(s => s.seq === 20)?.qty_in, 4);
  eq('second exclusive still planned', after.find(s => s.seq === 30)?.qty_in, 4);

  const reserved = db.prepare(`
    SELECT COALESCE(SUM(qty),0) q FROM production_reservations
    WHERE order_id=? AND product_id=? AND status='active'
  `).get(po.id, pFab)?.q;
  eq('shared fabric reserved for both products', reserved, 8);
} catch (e) {
  ok(false, 'sqlite scenario', e && (e.stack || e.message || e));
} finally {
  try { cleanup(); } catch (_) {}
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
