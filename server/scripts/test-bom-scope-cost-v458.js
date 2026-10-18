'use strict';
/**
 * v458 — same component on two exclusive products, per-product cost qty,
 * overhead rate edit that used to snap back to the mirrored fixed rate.
 */
const { ok, eq, throws, freshDb, summary } = require('./lib/test-harness');
const bom = require('../lib/production/bom');
const adv = require('../lib/production/bom-advanced');
const oh = require('../lib/production/overhead');

console.log('\n══ BOM scope / per-product cost / rate edit v458 ══\n');

const { db, cleanup } = freshDb();
const adminId = 1;
const PERIOD = '1405/07';

function seedProduct(name, code, avg, type, mfg) {
  const id = db.prepare('INSERT INTO products (user_id,name,price,stock) VALUES (1,?,0,0)').run(name).lastInsertRowid;
  const unit = type === 'raw' ? 'متر' : 'عدد';
  db.prepare('UPDATE products SET code=?, unit=?, average_cost_rial=?, item_type=?, is_manufactured=?, std_cost_rial=? WHERE id=?')
    .run(code, unit, avg, type, mfg, avg, id);
  return id;
}

const pY = seedProduct('کاپشن مموری یلدا', 'FG-YALDA', 0, 'finished', 1);
const pA = seedProduct('کاپشن مموری آبان', 'FG-ABAN', 0, 'finished', 1);
const pFab = seedProduct('پارچه مموری', 'RM-FAB', 1000000, 'raw', 0);
const pTrim = seedProduct('کشباف', 'RM-TRIM', 100000, 'raw', 0);
const pOther = seedProduct('زیپ', 'RM-ZIP', 5000, 'raw', 0);

const cc30 = db.prepare("SELECT id FROM cost_centers WHERE code='CC-30'").get().id;
const cc60 = db.prepare("SELECT id FROM cost_centers WHERE code='CC-60'").get().id;
ok('T458-00 centers', !!(cc30 && cc60));

const mirrored = oh.computePredeterminedRates({
  fixed_rate_rial: 166700, var_rate_rial: 0, total_rate_rial: 200000,
  monthly_labor_rate_rial: 180000,
});
eq('T458-01 edited total sticks', mirrored.total_rate_rial, 200000, 0);
eq('T458-02 fixed follows total', mirrored.fixed_rate_rial, 200000, 0);
eq('T458-03 labor untouched', mirrored.monthly_labor_rate_rial, 180000, 0);

const overBudget = oh.computePredeterminedRates({
  budget_fixed_oh_rial: 1000000,
  budget_driver_qty: 10,
  fixed_rate_rial: 100000,
  total_rate_rial: 250000,
  rate_touch: 'total',
});
eq('T458-04 manual total beats budget', overBudget.total_rate_rial, 250000, 0);
ok('T458-05 manual is not from_budget', overBudget.from_budget === false);

db.prepare(`
  INSERT INTO cost_center_rates
    (cost_center_id, period_label, driver, budget_fixed_oh_rial, budget_driver_qty,
     total_rate_rial, fixed_rate_rial, var_rate_rial, monthly_labor_rate_rial,
     status, is_estimated, absorb_pct)
  VALUES (?,?,'output_qty', 1000000, 10, 166700, 100000, 0, 166700, 'active', 0, 100)
`).run(cc60, PERIOD);
const live = oh.getOverheadRate(db, cc60, PERIOD);
eq('T458-06 read keeps manual CC-60 rate', live.total_rate_rial, 166700, 0);
ok('T458-07 read did not derive 100k', live.from_budget === false);

const stillBudget = oh.computePredeterminedRates({
  budget_fixed_oh_rial: 900000000,
  budget_driver_qty: 100,
  total_rate_rial: 0,
});
eq('T458-08 empty total still derives', stillBudget.total_rate_rial, 9000000, 0);
ok('T458-09 derive flag', stillBudget.from_budget === true);

const draft = bom.createBom(db, {
  product_id: pY,
  name: 'یلدا+آبان',
  yield_percent: 100,
  has_coproducts: 1,
  co_product_ids: [pA],
  auto_share_method: 'physical',
  lines: [
    { component_product_id: pFab, qty_per_base: 1.3, line_type: 'material', product_scope: 'exclusive', scoped_product_id: pY },
    { component_product_id: pFab, qty_per_base: 1.655, line_type: 'material', product_scope: 'exclusive', scoped_product_id: pA },
    { component_product_id: pTrim, qty_per_base: 0.026, line_type: 'material', product_scope: 'shared' },
    { component_product_id: pOther, qty_per_base: 1, line_type: 'material', product_scope: 'exclusive', scoped_product_id: pY },
  ],
}, adminId);

bom.activateBom(db, draft.id, '1405/07/01', adminId);
ok('T458-10 activate two exclusive fabrics',
  db.prepare('SELECT status FROM bom_headers WHERE id=?').get(draft.id).status === 'active');

bom.deactivateBom(db, draft.id, adminId);
adv.addOperation(db, draft.id, {
  seq: 20, cost_center_id: cc30, operation_name: 'دوخت یلدا',
  labor_method: 'piece', labor_rate_rial: 50000, yield_percent: 100,
  product_scope: 'exclusive', scoped_product_id: pY, overhead_driver: 'output_qty',
}, adminId);
adv.addOperation(db, draft.id, {
  seq: 30, cost_center_id: cc30, operation_name: 'دوخت آبان',
  labor_method: 'piece', labor_rate_rial: 80000, yield_percent: 100,
  product_scope: 'exclusive', scoped_product_id: pA, overhead_driver: 'output_qty',
}, adminId);
adv.addOperation(db, draft.id, {
  seq: 40, cost_center_id: cc60, operation_name: 'اتو و بسته‌بندی',
  labor_method: 'contract', labor_rate_rial: 0, yield_percent: 100,
  product_scope: 'shared', overhead_driver: 'output_qty',
}, adminId);
db.prepare('UPDATE bom_headers SET has_routing=1, yield_percent=100 WHERE id=?').run(draft.id);

const roll = adv.rollUpBom(db, {
  bomId: draft.id,
  qtyTarget: 1,
  period: PERIOD,
  priceBasis: 'average',
  outputQtys: { [pY]: 100, [pA]: 50 },
});
const y = (roll.outputs || []).find(o => Number(o.product_id) === pY);
const a = (roll.outputs || []).find(o => Number(o.product_id) === pA);
eq('T458-11 yalda qty', y && y.qty, 100, 0);
eq('T458-12 aban qty', a && a.qty, 50, 0);
eq('T458-13 yalda exclusive fabric+zip+sew', y && y.exclusive_rial, 130000000 + 500000 + 5000000, 2);
eq('T458-14 aban exclusive fabric+sew', a && a.exclusive_rial, 82750000 + 4000000, 2);

const sewY = (roll.stages || []).find(s => s.seq === 20);
const sewA = (roll.stages || []).find(s => s.seq === 30);
const iron = (roll.stages || []).find(s => s.seq === 40);
eq('T458-15 sew yalda labor', sewY && sewY.labor_rial, 50000 * 100, 0);
eq('T458-16 sew aban labor', sewA && sewA.labor_rial, 80000 * 50, 0);
eq('T458-17 iron OH on sum qty', iron && iron.overhead_rial, 166700 * 150, 0);
eq('T458-18 iron driver qty', iron && iron.overhead_driver_qty, 150, 0.001);

const sharedTrim = 150 * 0.026 * 100000;
const sharedOh = 166700 * 150;
const yShared = Math.round((sharedTrim + sharedOh) * (100 / 150));
eq('T458-19 shared split by qty', y && y.shared_rial, yShared, 2);

throws('T458-20 two shared rows duplicate', () => {
  const d = bom.createBom(db, {
    product_id: pY, name: 'dup-shared', yield_percent: 100,
    lines: [
      { component_product_id: pTrim, qty_per_base: 1, line_type: 'material' },
      { component_product_id: pTrim, qty_per_base: 2, line_type: 'material' },
    ],
  }, adminId);
  bom.activateBom(db, d.id, '1405/07/02', adminId);
}, 'E_BOM_DUP_LINE');

throws('T458-21 shared+exclusive mix', () => {
  const d = bom.createBom(db, {
    product_id: pY, name: 'mix', has_coproducts: 1, co_product_ids: [pA],
    lines: [
      { component_product_id: pFab, qty_per_base: 1, line_type: 'material', product_scope: 'shared' },
      { component_product_id: pFab, qty_per_base: 1.2, line_type: 'material', product_scope: 'exclusive', scoped_product_id: pA },
    ],
  }, adminId);
  bom.activateBom(db, d.id, '1405/07/03', adminId);
}, 'E_BOM_SCOPE_MIX');

cleanup();
summary();
