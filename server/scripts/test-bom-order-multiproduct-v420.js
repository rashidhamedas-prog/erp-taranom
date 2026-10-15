'use strict';
/**
 * v420 — سفارش تولید چندمحصولی: resolve co، اجرای مشترک، advanced اجباری،
 * plan FG، finalize با outputs override
 * Run: node server/scripts/test-bom-order-multiproduct-v420.js
 */
process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-jwt-secret-bom-order-mp-v420-dummy-key-32chars!!';

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

console.log('\n══ BOM order multiproduct joint-run v420 ══\n');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const idxSrc = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
ok(appJs.includes('prodOrderRefreshFgPlan') && appJs.includes('برنامه محصولات این اجرای مشترک'), 'UI fg plan');
ok(appJs.includes('pf-out-qty'), 'UI finalize outputs');
ok(appJs.includes('سفارش چندمحصولی — اجرای مشترک (v420)'), 'Help v420');
ok(swSrc.includes('erp-taranom-v420'), 'SW v420');
ok(idxSrc.includes('app.js?v=420'), 'index v420');

let Database;
try {
  Database = require('better-sqlite3');
  const probe = new Database(':memory:');
  probe.close();
} catch (e) {
  console.log('\nSKIP SQLite ABI — static checks only:', e.message);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const { freshDb } = require('./lib/test-harness');
const bom = require('../lib/production/bom');
const adv = require('../lib/production/bom-advanced');
const engine = require('../lib/production/engine');
const engAdv = require('../lib/production/engine-advanced');

const { db, cleanup } = freshDb();
const adminId = 1;
const DATE = '1405/07/23';
const PERIOD = '1405/07';

function seedProduct(name, avg, type, mfg, stock = 10000) {
  const id = db.prepare('INSERT INTO products (user_id,name,price,stock) VALUES (1,?,?,?)')
    .run(name, avg / 10, stock).lastInsertRowid;
  db.prepare('UPDATE products SET average_cost_rial=?, item_type=?, is_manufactured=?, std_cost_rial=? WHERE id=?')
    .run(avg, type, mfg, avg, id);
  return id;
}

const pMain = seedProduct('کاپشن یلدا', 0, 'finished', 1, 0);
const pCo = seedProduct('کاپشن آبان', 0, 'finished', 1, 0);
const pFab = seedProduct('پارچه مشترک', 1_000_000, 'raw', 0);
const pZipY = seedProduct('زیپ یلدا', 100_000, 'raw', 0);
const pZipA = seedProduct('زیپ آبان', 80_000, 'raw', 0);

const cc10 = db.prepare("SELECT id FROM cost_centers WHERE code='CC-10'").get()?.id;
const whRaw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get()?.id;
const whFg = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get()?.id;
ok(!!cc10 && !!whRaw && !!whFg, 'T420-00 seed');

db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_raw_id',?)").run(String(whRaw));
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_fg_id',?)").run(String(whFg));
db.prepare(`
  INSERT INTO cost_center_rates
    (cost_center_id, period_label, driver, total_rate_rial, fixed_rate_rial,
     monthly_labor_rate_rial, status, is_estimated)
  VALUES (?,?, 'output_qty', 1000, 1000, 0, 'active', 0)
`).run(cc10, PERIOD);

for (const id of [pFab, pZipY, pZipA]) {
  db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)')
    .run(id, whRaw, 10000);
  db.prepare('UPDATE warehouse_stock SET qty=10000 WHERE product_id=? AND warehouse_id=?')
    .run(id, whRaw);
}

const draft = bom.createBom(db, {
  product_id: pMain,
  name: 'BOM-MP-ORDER',
  has_routing: 1,
  has_coproducts: 1,
  co_product_ids: [pCo],
  auto_share_method: 'physical',
  base_qty: 1,
  yield_percent: 100,
  lines: [
    {
      component_product_id: pFab, qty_per_base: 2, line_type: 'material',
      product_scope: 'shared', stage_cost_center_id: cc10,
    },
    {
      component_product_id: pZipY, qty_per_base: 1, line_type: 'material',
      product_scope: 'exclusive', scoped_product_id: pMain, stage_cost_center_id: cc10,
    },
    {
      component_product_id: pZipA, qty_per_base: 1, line_type: 'material',
      product_scope: 'exclusive', scoped_product_id: pCo, stage_cost_center_id: cc10,
    },
  ],
}, adminId);
adv.addOperation(db, draft.id, {
  seq: 10, cost_center_id: cc10, operation_name: 'برش',
  labor_method: 'piece', labor_rate_rial: 500, yield_percent: 100,
  product_scope: 'shared',
}, adminId);
db.prepare(`UPDATE bom_outputs SET cost_share_percent=50 WHERE bom_id=? AND output_type IN ('main','co')`).run(draft.id);
bom.activateBom(db, draft.id, '1405/01/01', adminId);

const resolved = bom.resolveBom(db, { productId: pCo, date: DATE });
ok(Number(resolved.id) === Number(draft.id), 'T420-01 resolve co');

const listed = bom.listBoms(db, { for_product_id: pCo, status: 'active' });
ok((listed.rows || []).some(r => Number(r.id) === Number(draft.id)), 'T420-02 list for_product co');

const plan = bom.planBomFgOutputs(db, draft.id, 10, pCo);
eq('T420-03 plan co self', plan.find(p => Number(p.product_id) === pCo)?.qty_planned, 10);
eq('T420-04 plan main from co', plan.find(p => Number(p.product_id) === pMain)?.qty_planned, 10);

const po = engine.createOrder(db, {
  product_id: pCo,
  bom_id: draft.id,
  qty_planned: 10,
  analysis_type: 'fixed',
  date: DATE,
  warehouse_raw_id: whRaw,
  warehouse_fg_id: whFg,
  cost_center_id: cc10,
}, adminId);
ok(['fixed_adv', 'variable_adv'].includes(po.analysis_type), 'T420-05 force advanced', po.analysis_type);

const detail = engine.getOrderDetail(db, po.id);
ok(detail.is_multiproduct && (detail.fg_plan || []).length === 2, 'T420-06 fg_plan multi');
ok(bom.explodeProductScopeForOrder(db, po) == null, 'T420-07 scope joint');

const exJoint = bom.explodeBom(db, {
  bomId: draft.id, qty: bom.explodeQtyForOrder(db, po), priceBasis: 'average',
  forProductId: bom.explodeProductScopeForOrder(db, po),
});
ok(
  exJoint.lines.some(L => Number(L.product_id) === pZipY)
  && exJoint.lines.some(L => Number(L.product_id) === pZipA)
  && exJoint.lines.some(L => Number(L.product_id) === pFab),
  'T420-08 joint has both zips'
);

try {
  const pOther = seedProduct('بی‌ربط', 0, 'finished', 1, 0);
  engine.createOrder(db, {
    product_id: pOther, bom_id: draft.id, qty_planned: 1,
    analysis_type: 'fixed_adv', date: DATE,
    warehouse_raw_id: whRaw, warehouse_fg_id: whFg,
  }, adminId);
  ok(false, 'T420-09 mismatch product', 'no throw');
} catch (e) {
  ok(String(e.code || e.message).includes('E_BOM_PRODUCT_MISMATCH'), 'T420-09 mismatch product', e.code || e.message);
}

engine.releaseOrder(db, po.id, adminId);
const stages = engAdv.stageList(db, po.id);
ok(stages.length >= 1, 'T420-10 stages', stages.length);
const st = stages[0];
engAdv.postStageOutputFixed(db, {
  orderId: po.id, stageId: st.id,
  body: { date: DATE, qty_out: 10, waste_normal: 0, waste_abnormal: 0 },
  userId: adminId,
});

const fin = engAdv.finalizeAdvancedOrder(db, {
  orderId: po.id,
  body: {
    date: DATE,
    qty_produced: 10,
    outputs: [
      { product_id: pMain, qty: 10 },
      { product_id: pCo, qty: 8 },
    ],
  },
  userId: adminId,
});
ok(!!fin && (fin.receipts || []).length >= 2, 'T420-11 finalize ok', fin?.receipts?.length);
const recCo = (fin.receipts || []).find(r => Number(r.product_id) === pCo);
const recMain = (fin.receipts || []).find(r => Number(r.product_id) === pMain);
eq('T420-12 co qty override', recCo?.qty, 8);
eq('T420-13 main qty', recMain?.qty, 10);
const stockCo = db.prepare('SELECT stock FROM products WHERE id=?').get(pCo)?.stock;
const stockMain = db.prepare('SELECT stock FROM products WHERE id=?').get(pMain)?.stock;
ok(Number(stockCo) >= 8 && Number(stockMain) >= 10, 'T420-14 both FG stocked', { stockCo, stockMain });

cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
