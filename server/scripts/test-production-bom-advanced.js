'use strict';
/**
 * P4 — Advanced BOM tests (docs/Production/04-advanced-formulas.md §18)
 */
const { ok, eq, throws, freshDb, summary } = require('./lib/test-harness');
const bom = require('../lib/production/bom');
const adv = require('../lib/production/bom-advanced');
const oh = require('../lib/production/overhead');

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
for (const code of ['CC-10', 'CC-20', 'CC-30', 'CC-40', 'CC-50', 'CC-60', 'CC-90']) {
  cc[code] = db.prepare('SELECT id FROM cost_centers WHERE code=?').get(code)?.id;
}

// Overhead + monthly labor rates
// NOTE: freshDb() (company-workspace registry under os.tmpdir()) can reuse a
// previously-seeded DB file across runs, so cost_center_rates may already have
// rows for (cost_center_id, period_label) — upsert instead of blind INSERT
// (same pattern as scripts/test-production-overhead-labor.js).
const rates = [
  { code: 'CC-10', driver: 'material_rial', rate: 9000, monthly: 25000 },
  { code: 'CC-20', driver: 'machine_hours', rate: 1200000, monthly: 0 },
  { code: 'CC-30', driver: 'direct_labor_rial', rate: 350000, monthly: 0 },
  { code: 'CC-40', driver: 'output_qty', rate: 8000, monthly: 0 },
  { code: 'CC-50', driver: 'output_qty', rate: 5000, monthly: 0 },
  { code: 'CC-60', driver: 'output_qty', rate: 12000, monthly: 15000 },
];
for (const r of rates) {
  const existing = db.prepare(`
    SELECT id FROM cost_center_rates WHERE cost_center_id=? AND period_label=?
  `).get(cc[r.code], PERIOD);
  if (existing) {
    db.prepare(`
      UPDATE cost_center_rates SET
        driver=?, total_rate_rial=?, fixed_rate_rial=?,
        monthly_labor_rate_rial=?, status='active', is_estimated=0,
        applied_oh_rial=0, actual_driver_qty=0
      WHERE id=?
    `).run(r.driver, r.rate, r.rate, r.monthly, existing.id);
  } else {
    db.prepare(`
      INSERT INTO cost_center_rates
        (cost_center_id, period_label, driver, total_rate_rial, fixed_rate_rial,
         monthly_labor_rate_rial, status, is_estimated)
      VALUES (?,?,?,?,?,?, 'active', 0)
    `).run(cc[r.code], PERIOD, r.driver, r.rate, r.rate, r.monthly);
  }
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

// T4-03 مرکز غیرمرحله (CC-90 is_stage=0) — محصول جدا تا با draft فعال تداخل نسخه ندهد
throws('T4-03 مرکز غیرمرحله', () => {
  const pCc = seedProduct('تست CC', 0, 'finished', 1, 0);
  const d0 = bom.createBom(db, {
    product_id: pCc, name: 'cc not stage', yield_percent: 100, has_routing: 1,
    lines: [{ component_product_id: p201, qty_per_base: 1, scrap_percent: 0, line_type: 'material' }],
  }, adminId);
  adv.addOperation(db, d0.id, { seq: 10, cost_center_id: cc['CC-90'], labor_method: 'piece', labor_rate_rial: 1000 }, adminId);
}, 'E_CC_NOT_STAGE');

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

// Full roll-up — golden numbers from §6.6 / §15 JSON sample
try {
  adv.clearRollUpMemo();
  const r = adv.rollUpBom(db, { bomId: draft.id, qtyTarget: 300, period: PERIOD, priceBasis: 'average' });
  eq('T4-06b qty_start in rollup', r.qty_start, 314, 0);
  eq('T4-05b yield in rollup', r.total_yield_percent, 95.5647, 0.0001);

  const s30 = r.stages.find(s => s.seq === 30);
  const s60 = r.stages.find(s => s.seq === 60);

  eq('T4-07 دستمزد دوخت', s30?.labor_rial, 55389600, 5);
  eq('T4-13 cost_out[60]', s60?.cost_out_rial, 698324500, 1);
  eq('T4-15 بهای واحد', r.breakdown.unit_cost_rial, 2315880, 1);

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

// T4-17 بدون main (has_coproducts=1 + فقط خروجی by)
throws('T4-17 بدون main', () => {
  const d3b = bom.createBom(db, {
    product_id: p101, name: 'no main', yield_percent: 100, has_routing: 1, has_coproducts: 1,
    lines: [{ component_product_id: p201, qty_per_base: 1, scrap_percent: 0, line_type: 'material', stage_cost_center_id: cc['CC-10'] }],
  }, adminId);
  adv.applyRoutingTemplate(db, d3b.id, adminId);
  adv.addOutput(db, d3b.id, { product_id: p299, output_type: 'by', qty_per_base: 0.1, cost_method: 'nrv', nrv_rial: 1000 });
  adv.rollUpBom(db, { bomId: d3b.id, qtyTarget: 10, period: PERIOD });
}, 'E_NO_MAIN_OUTPUT');

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

// extra — V4-13 E_NRV_ZERO (نه بخشی از شمارهٔ رسمی §18 — T4-24/۲۵ واقعی پایین‌تر است)
throws('extra E_NRV_ZERO — محصول فرعی NRV صفر', () => {
  const d5 = bom.createBom(db, {
    product_id: p101, name: 'nrv0', yield_percent: 100, has_routing: 1, has_coproducts: 1,
    lines: [{ component_product_id: p201, qty_per_base: 1, scrap_percent: 0, line_type: 'material', stage_cost_center_id: cc['CC-10'] }],
  }, adminId);
  adv.applyRoutingTemplate(db, d5.id, adminId);
  adv.addOutput(db, d5.id, { product_id: p101, output_type: 'main', cost_share_percent: 100, cost_method: 'share' });
  adv.addOutput(db, d5.id, { product_id: p299, output_type: 'by', qty_per_base: 0.1, cost_method: 'nrv', nrv_rial: 0 });
  adv.rollUpBom(db, { bomId: d5.id, qtyTarget: 10, period: PERIOD });
}, 'E_NRV_ZERO');

// extra — V4-21 از طریق validateAdvancedBom (مکمل T4-29 که مسیر rollUpBom را پوشش می‌دهد)
try {
  const d6 = bom.createBom(db, {
    product_id: p101, name: 'route yield', yield_percent: 97, has_routing: 1,
    lines: [{ component_product_id: p201, qty_per_base: 1, scrap_percent: 0, line_type: 'material', stage_cost_center_id: cc['CC-10'] }],
  }, adminId);
  adv.applyRoutingTemplate(db, d6.id, adminId);
  db.prepare('UPDATE bom_headers SET yield_percent=97 WHERE id=?').run(d6.id);
  throws('extra validateAdvancedBom routing+yield≠100', () => adv.validateAdvancedBom(db, d6.id), 'E_YIELD_DOUBLE_COUNT');
} catch (e) {
  ok('extra validateAdvancedBom routing+yield≠100', false, e.message);
}

// ═══ T4-24 — Bootstrap نرخ: حذف cost_center_rates یک مرکز → نرخ از ۳ ماه + is_estimated=1 ═══
try {
  const ccIdBoot = cc['CC-50'];
  const before = db.prepare(`
    SELECT * FROM cost_center_rates WHERE cost_center_id=? AND period_label=?
  `).get(ccIdBoot, PERIOD);
  db.prepare('DELETE FROM cost_center_rates WHERE cost_center_id=? AND period_label=?').run(ccIdBoot, PERIOD);
  const gone = db.prepare(`
    SELECT 1 FROM cost_center_rates WHERE cost_center_id=? AND period_label=?
  `).get(ccIdBoot, PERIOD);
  ok('T4-24 نرخ دوره قبل از Bootstrap حذف شد', !gone);

  const boot = oh.bootstrapRate(db, ccIdBoot, PERIOD, 3);
  ok('T4-24 Bootstrap نرخ ایجاد شد', !!boot && !!boot.id);
  ok('T4-24 نرخ Bootstrap برآوردی است', !!boot && Number(boot.is_estimated) === 1 && boot.status === 'estimated');

  const viaGetRate = oh.getOverheadRate(db, ccIdBoot, PERIOD);
  ok('T4-24 getOverheadRate نرخ برآوردی برمی‌گرداند', !!viaGetRate && Number(viaGetRate.is_estimated) === 1);

  // restore original active rate so downstream golden roll-ups stay exact
  db.prepare('DELETE FROM cost_center_rates WHERE cost_center_id=? AND period_label=?').run(ccIdBoot, PERIOD);
  if (before) {
    db.prepare(`
      INSERT INTO cost_center_rates
        (cost_center_id, period_label, driver, total_rate_rial, fixed_rate_rial,
         monthly_labor_rate_rial, status, is_estimated)
      VALUES (?,?,?,?,?,?, 'active', 0)
    `).run(before.cost_center_id, before.period_label, before.driver,
      before.total_rate_rial, before.fixed_rate_rial, before.monthly_labor_rate_rial);
  }
} catch (e) {
  ok('T4-24 Bootstrap نرخ', false, e.stack || e.message);
}

// ═══ T4-25 — تسهیم خودکار sales_value روی خروجی main+co ═══
try {
  const pCo = seedProduct('شال ست', 300000, 'finished', 0);
  const d7 = bom.createBom(db, {
    product_id: p101, name: 'coproduct autoShare', yield_percent: 100, has_routing: 1, has_coproducts: 1,
    lines: [{ component_product_id: p201, qty_per_base: 1, scrap_percent: 0, line_type: 'material', stage_cost_center_id: cc['CC-10'] }],
  }, adminId);
  adv.applyRoutingTemplate(db, d7.id, adminId);
  adv.addOutput(db, d7.id, { product_id: p101, output_type: 'main', qty_per_base: 1, cost_method: 'share', cost_share_percent: 50 });
  adv.addOutput(db, d7.id, { product_id: pCo, output_type: 'co', qty_per_base: 0.2, cost_method: 'share', cost_share_percent: 50 });
  db.prepare('UPDATE products SET price=? WHERE id=?').run(320000, p101);
  db.prepare('UPDATE products SET price=? WHERE id=?').run(150000, pCo);

  const res = adv.autoShare(db, d7.id, 'sales_value');
  const sum = res.rows.reduce((s, row) => s + row.cost_share_percent, 0);
  eq('T4-25 autoShare sales_value مجموع سهم=۱۰۰', sum, 100, 0.01);
  ok('T4-25 autoShare دو ردیف با سهم مثبت', res.rows.length === 2 && res.rows.every(row => row.cost_share_percent > 0));
} catch (e) {
  ok('T4-25 autoShare sales_value', false, e.stack || e.message);
}

// ═══ Smoke — کمک‌تابع‌های جدید (yieldAnalysis, costTree, sensitivity, breakeven, compareScenarios) ═══
try {
  const ya = adv.yieldAnalysis(db, draft.id, 300);
  ok('smoke yieldAnalysis qty_start=314', ya.qty_start === 314);
  ok('smoke yieldAnalysis ۶ مرحله', Array.isArray(ya.stages) && ya.stages.length === 6);
} catch (e) {
  ok('smoke yieldAnalysis', false, e.message);
}

try {
  const ct = adv.costTree(db, { bomId: draft.id, qty: 300, period: PERIOD, deadlineMs: 5000 });
  ok('smoke costTree unit_cost_rial عدد است', typeof ct.unit_cost_rial === 'number' && ct.unit_cost_rial > 0);
  ok('smoke costTree زیر ۵ ثانیه', ct.elapsed_ms < 5000);
} catch (e) {
  ok('smoke costTree', false, e.message);
}

try {
  const sens = adv.sensitivity(db, { bomId: draft.id, qtyTarget: 300, period: PERIOD, param: 'fabric_price', deltaPercent: 20 });
  ok('smoke sensitivity افزایش قیمت مواد → بهای بالاتر', sens.new_unit_cost_rial > sens.base_unit_cost_rial);
} catch (e) {
  ok('smoke sensitivity', false, e.message);
}

try {
  const be = adv.breakeven(db, { bomId: draft.id, qtyTarget: 300, period: PERIOD, priceRial: 4000000 });
  ok('smoke breakeven سودآور با قیمت بالاتر از بها', be.profitable === true && be.margin_rial > 0);
} catch (e) {
  ok('smoke breakeven', false, e.message);
}

try {
  const cmp = adv.compareScenarios(db, draft.id, draft.id, 300, PERIOD);
  ok('smoke compareScenarios اختلاف صفر با خودش', cmp.delta_unit_cost_rial === 0);
} catch (e) {
  ok('smoke compareScenarios', false, e.message);
}

// SEC follow-up: active BOM cannot resequence (E_BOM_LOCKED)
throws('sec resequence on active → E_BOM_LOCKED', () => {
  adv.resequenceOperations(db, draft.id);
}, 'E_BOM_LOCKED');

// SEC follow-up: applyCostPolicy strips *_rial for non-cost-viewer (ops payload)
// (assertDraftBom in resequenceOperations already covered above via E_BOM_LOCKED)
try {
  const { applyCostPolicy, canSeeCost } = require('../lib/production/access');
  const fakeUser = { id: 912, role: 'production_operator' };
  db.prepare('INSERT OR IGNORE INTO users (id, username, password, name, role) VALUES (?,?,?,?,?)')
    .run(fakeUser.id, 'po_sec_bom', 'x', 'اپراتور تست هزینه', fakeUser.role);
  ok('sec R11 کاربر بدون production_cost', !canSeeCost(db, fakeUser));

  const sampleOpsPayload = {
    rows: [{
      seq: 10,
      labor_rate_rial: 180000,
      subcontract_fee_rial: 38000,
      operation_name: 'دوخت',
    }],
  };
  const filtered = applyCostPolicy(db, fakeUser, sampleOpsPayload);
  const json = JSON.stringify(filtered);
  ok(
    'sec R11 applyCostPolicy حذف *_rial از عملیات',
    !json.includes('_rial')
      && filtered.rows[0].operation_name === 'دوخت'
      && filtered.rows[0].seq === 10
      && filtered.rows[0].labor_rate_rial === undefined
      && filtered.rows[0].subcontract_fee_rial === undefined
  );

  // Same strip for single cost-bearing row shapes returned by POST/PUT ops/outputs
  const filteredOpRow = applyCostPolicy(db, fakeUser, {
    id: 1, seq: 10, operation_name: 'برش', labor_rate_rial: 90000, subcontract_fee_rial: 0,
  });
  ok(
    'sec R11 applyCostPolicy حذف *_rial از ردیف عملیات (POST/PUT)',
    filteredOpRow.operation_name === 'برش'
      && filteredOpRow.labor_rate_rial === undefined
      && filteredOpRow.subcontract_fee_rial === undefined
  );
  const filteredOutRow = applyCostPolicy(db, fakeUser, {
    id: 2, product_id: 1, output_type: 'by', qty_per_base: 0.1, nrv_rial: 120000,
  });
  ok(
    'sec R11 applyCostPolicy حذف *_rial از ردیف خروجی (POST/PUT)',
    filteredOutRow.output_type === 'by'
      && filteredOutRow.qty_per_base === 0.1
      && filteredOutRow.nrv_rial === undefined
  );

  // Aggregate getBom-shaped payload (GET /:id embeds ops/outputs)
  const getBomShape = {
    id: draft.id,
    status: 'active',
    operations: [{ seq: 10, labor_rate_rial: 180000, operation_name: 'دوخت' }],
    outputs: [{ output_type: 'by', nrv_rial: 5000 }],
    lines: [{ component_product_id: 1, std_cost_rial: 999 }],
  };
  const filteredBom = applyCostPolicy(db, fakeUser, getBomShape);
  const bomJson = JSON.stringify(filteredBom);
  ok(
    'sec R11 applyCostPolicy حذف *_rial از getBom',
    !bomJson.includes('_rial')
      && filteredBom.operations[0].operation_name === 'دوخت'
      && filteredBom.outputs[0].output_type === 'by'
  );
} catch (e) {
  ok('sec R11 applyCostPolicy حذف *_rial از عملیات', false, e.message);
}

cleanup();
summary('P4 Advanced BOM');
