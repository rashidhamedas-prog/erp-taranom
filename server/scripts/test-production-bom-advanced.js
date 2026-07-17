'use strict';
/**
 * P4 — Advanced BOM tests (docs/Production/04-advanced-formulas.md §18)
 */
const { ok, eq, throws, freshDb, summary } = require('./lib/test-harness');
const bom = require('../lib/production/bom');
const adv = require('../lib/production/bom-advanced');

console.log('\n══ P4 Advanced BOM Tests ══\n');

const { db, cleanup } = freshDb();
const adminId = 1;
const PERIOD = '1405/04';

function seedProduct(name, avg, type, mfg, stock = 10000) {
  const id = db.prepare('INSERT INTO products (user_id,name,price,stock) VALUES (1,?,?,?)')
    .run(name, 0, stock).lastInsertRowid;
  db.prepare('UPDATE products SET average_cost_rial=?, item_type=?, is_manufactured=?, std_cost_rial=? WHERE id=?')
    .run(avg, type, mfg, avg, id);
  return id;
}

const p101 = seedProduct('مانتو ترمه', 0, 'finished', 1, 0);
const p201 = seedProduct('پارچه', 950000, 'raw', 0);
const p202 = seedProduct('آستر', 180000, 'raw', 0);
const p203 = seedProduct('نخ', 85000, 'raw', 0);
const p204 = seedProduct('دکمه', 12000, 'raw', 0);
const p205 = seedProduct('لیبل', 6000, 'packaging', 0);
const p206 = seedProduct('نایلون', 9000, 'packaging', 0);
const p299 = seedProduct('خرده پارچه', 120000, 'scrap', 0);

const cc = {};
for (const code of ['CC-10', 'CC-20', 'CC-30', 'CC-40', 'CC-50', 'CC-60']) {
  cc[code] = db.prepare('SELECT id FROM cost_centers WHERE code=?').get(code)?.id;
}

// Overhead + monthly labor rates
const rates = [
  { code: 'CC-10', driver: 'material_rial', rate: 9000, monthly: 25000 },
  { code: 'CC-20', driver: 'machine_hours', rate: 1200000, monthly: 0 },
  { code: 'CC-30', driver: 'direct_labor_rial', rate: 350000, monthly: 0 },
  { code: 'CC-40', driver: 'output_qty', rate: 8000, monthly: 0 },
  { code: 'CC-50', driver: 'output_qty', rate: 5000, monthly: 0 },
  { code: 'CC-60', driver: 'output_qty', rate: 12000, monthly: 15000 },
];
for (const r of rates) {
  db.prepare(`
    INSERT INTO cost_center_rates
      (cost_center_id, period_label, driver, total_rate_rial, fixed_rate_rial,
       monthly_labor_rate_rial, status, is_estimated)
    VALUES (?,?,?,?,?,?, 'active', 0)
  `).run(cc[r.code], PERIOD, r.driver, r.rate, r.rate, r.monthly);
}

db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('pricing_margin_percent','35')").run();

const draft = bom.createBom(db, {
  product_id: p101,
  name: 'BOM پیشرفته ترمه',
  yield_percent: 100,
  base_qty: 1,
  has_routing: 1,
  has_coproducts: 1,
  lines: [
    { component_product_id: p201, qty_per_base: 1.60, scrap_percent: 4, line_type: 'material', stage_cost_center_id: cc['CC-10'] },
    { component_product_id: p202, qty_per_base: 0.35, scrap_percent: 3, line_type: 'material', stage_cost_center_id: cc['CC-10'] },
    { component_product_id: p203, qty_per_base: 0.08, scrap_percent: 0, line_type: 'material', stage_cost_center_id: cc['CC-30'] },
    { component_product_id: p204, qty_per_base: 6, scrap_percent: 2, line_type: 'material', stage_cost_center_id: cc['CC-40'] },
    { component_product_id: p205, qty_per_base: 1, scrap_percent: 0, line_type: 'packaging', stage_cost_center_id: cc['CC-60'] },
    { component_product_id: p206, qty_per_base: 1, scrap_percent: 0, line_type: 'packaging', stage_cost_center_id: cc['CC-60'] },
  ],
}, adminId);

// T4-01
try {
  const r = adv.applyRoutingTemplate(db, draft.id, adminId);
  const ops = db.prepare('SELECT seq FROM bom_operations WHERE bom_id=? ORDER BY seq').all(draft.id);
  ok('T4-01 الگوی Routing', r.count === 6 && ops.map(o => o.seq).join(',') === '10,20,30,40,50,60');
} catch (e) {
  ok('T4-01 الگوی Routing', false, e.message);
}

// ensure crew on cut/iron
db.prepare(`UPDATE bom_operations SET crew_size=2 WHERE bom_id=? AND seq IN (10,60)`).run(draft.id);

// T4-02 duplicate seq
throws('T4-02 seq تکراری', () => {
  adv.addOperation(db, draft.id, { seq: 10, cost_center_id: cc['CC-10'], labor_method: 'piece', labor_rate_rial: 1 }, adminId);
}, 'E_SEQ_DUPLICATE');

// outputs
adv.addOutput(db, draft.id, {
  product_id: p101, output_type: 'main', qty_per_base: 1,
  cost_method: 'share', cost_share_percent: 100,
});
adv.addOutput(db, draft.id, {
  product_id: p299, output_type: 'by', qty_per_base: 0.09,
  cost_method: 'nrv', nrv_rial: 120000,
});

bom.activateBom(db, draft.id, '1405/01/01', adminId);

// T4-05 / T4-06
try {
  const bw = adv.backwardQty(db, draft.id, 300);
  eq('T4-05 بازده کل', bw.total_yield_percent, 95.5647, 0.0001);
  eq('T4-06 qty_start', bw.qty_start, 314, 0);
} catch (e) {
  ok('T4-05/06 backward', false, e.message);
}

// T4-29 V4-21 — active BOM can't edit yield; test on a copy/draft
try {
  const d2 = bom.createBom(db, {
    product_id: p101, name: 'yield bad', yield_percent: 97, has_routing: 1, lines: [
      { component_product_id: p201, qty_per_base: 1, scrap_percent: 0, line_type: 'material' },
    ],
  }, adminId);
  adv.applyRoutingTemplate(db, d2.id, adminId);
  // applyRoutingTemplate forces yield=100 — set back to 97 for test
  db.prepare('UPDATE bom_headers SET yield_percent=97 WHERE id=?').run(d2.id);
  throws('T4-29 ضد-دوباره‌شماری', () => {
    adv.rollUpBom(db, { bomId: d2.id, qtyTarget: 300, period: PERIOD });
  }, 'E_YIELD_DOUBLE_COUNT');
} catch (e) {
  ok('T4-29 ضد-دوباره‌شماری', false, e.message);
}

// Full roll-up
try {
  adv.clearRollUpMemo();
  const r = adv.rollUpBom(db, { bomId: draft.id, qtyTarget: 300, period: PERIOD, priceBasis: 'average' });
  eq('T4-06b qty_start in rollup', r.qty_start, 314, 0);
  eq('T4-05b yield in rollup', r.total_yield_percent, 95.5647, 0.0001);

  const s10 = r.stages.find(s => s.seq === 10);
  const s30 = r.stages.find(s => s.seq === 30);
  const s60 = r.stages.find(s => s.seq === 60);

  eq('T4-07 دستمزد دوخت', s30?.labor_rial, 55389600, 5);
  eq('T4-13 cost_out[60]', s60?.cost_out_rial, 698324500, 50);
  eq('T4-15 بهای واحد', r.breakdown.unit_cost_rial, 2315880, 5);

  const by = r.outputs.find(o => o.type === 'by');
  eq('T4-14 محصول فرعی NRV', by?.amount_rial, 3391200, 5);

  ok('T4-13/15 roll-up stages', r.stages.length === 6);
} catch (e) {
  ok('T4 roll-up golden', false, e.stack || e.message);
  console.error(e);
}

// T4-16 share != 100
throws('T4-16 سهم ≠ ۱۰۰', () => {
  const d3 = bom.createBom(db, {
    product_id: p101, name: 'share bad', yield_percent: 100, has_routing: 1, has_coproducts: 1,
    lines: [{ component_product_id: p201, qty_per_base: 1, scrap_percent: 0, line_type: 'material', stage_cost_center_id: cc['CC-10'] }],
  }, adminId);
  adv.applyRoutingTemplate(db, d3.id, adminId);
  adv.addOutput(db, d3.id, { product_id: p101, output_type: 'main', cost_share_percent: 80, cost_method: 'share' });
  adv.addOutput(db, d3.id, { product_id: p101, output_type: 'co', cost_share_percent: 10, cost_method: 'share', qty_per_base: 0.1 });
  adv.rollUpBom(db, { bomId: d3.id, qtyTarget: 10, period: PERIOD });
}, 'E_SHARE_NOT_100');

// T4-23 resequence
try {
  const d4 = bom.createBom(db, {
    product_id: p101, name: 'reseq', yield_percent: 100, has_routing: 1,
    lines: [{ component_product_id: p201, qty_per_base: 1, scrap_percent: 0, line_type: 'material' }],
  }, adminId);
  adv.addOperation(db, d4.id, { seq: 15, cost_center_id: cc['CC-10'], labor_method: 'piece', labor_rate_rial: 1000 }, adminId);
  adv.addOperation(db, d4.id, { seq: 25, cost_center_id: cc['CC-20'], labor_method: 'piece', labor_rate_rial: 1000 }, adminId);
  const rows = adv.resequenceOperations(db, d4.id);
  ok('T4-23 بازشماری', rows.map(r => r.seq).join(',') === '10,20');
} catch (e) {
  ok('T4-23 بازشماری', false, e.message);
}

// T4-21 circular multilevel — reuse bom detectCircular via create/activate path
throws('T4-21 حلقه چندسطحی', () => {
  const pA = seedProduct('نیمه‌A', 100000, 'semi', 1, 0);
  const pB = seedProduct('نیمه‌B', 100000, 'semi', 1, 0);
  const bA = bom.createBom(db, {
    product_id: pA, name: 'A', yield_percent: 100, is_multilevel: 1,
    lines: [{ component_product_id: pB, qty_per_base: 1, scrap_percent: 0, line_type: 'material' }],
  }, adminId);
  bom.activateBom(db, bA.id, '1405/01/01', adminId);
  const bB = bom.createBom(db, {
    product_id: pB, name: 'B', yield_percent: 100, is_multilevel: 1,
    lines: [{ component_product_id: pA, qty_per_base: 1, scrap_percent: 0, line_type: 'material' }],
  }, adminId);
  bom.activateBom(db, bB.id, '1405/01/01', adminId);
}, 'E_BOM_CIRCULAR');

// T4-24 NRV zero on by-product
throws('T4-24 NRV صفر', () => {
  const d5 = bom.createBom(db, {
    product_id: p101, name: 'nrv0', yield_percent: 100, has_routing: 1, has_coproducts: 1,
    lines: [{ component_product_id: p201, qty_per_base: 1, scrap_percent: 0, line_type: 'material', stage_cost_center_id: cc['CC-10'] }],
  }, adminId);
  adv.applyRoutingTemplate(db, d5.id, adminId);
  adv.addOutput(db, d5.id, { product_id: p101, output_type: 'main', cost_share_percent: 100, cost_method: 'share' });
  adv.addOutput(db, d5.id, { product_id: p299, output_type: 'by', qty_per_base: 0.1, cost_method: 'nrv', nrv_rial: 0 });
  adv.rollUpBom(db, { bomId: d5.id, qtyTarget: 10, period: PERIOD });
}, 'E_NRV_ZERO');

// T4-25 routing forces yield 100 on activate validate
try {
  const d6 = bom.createBom(db, {
    product_id: p101, name: 'route yield', yield_percent: 97, has_routing: 1,
    lines: [{ component_product_id: p201, qty_per_base: 1, scrap_percent: 0, line_type: 'material', stage_cost_center_id: cc['CC-10'] }],
  }, adminId);
  adv.applyRoutingTemplate(db, d6.id, adminId);
  db.prepare('UPDATE bom_headers SET yield_percent=97 WHERE id=?').run(d6.id);
  throws('T4-25 activate routing+yield≠100', () => adv.validateAdvancedBom(db, d6.id), 'E_YIELD_DOUBLE_COUNT');
} catch (e) {
  ok('T4-25 activate routing+yield≠100', false, e.message);
}

cleanup();
summary('P4 Advanced BOM');
