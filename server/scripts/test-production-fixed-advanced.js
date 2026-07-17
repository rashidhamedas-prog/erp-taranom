'use strict';
/**
 * P7 — Fixed advanced execution (docs/Production/07-fixed-analysis-advanced.md)
 */
const { ok, eq, freshDb, summary } = require('./lib/test-harness');
const bom = require('../lib/production/bom');
const advBom = require('../lib/production/bom-advanced');
const engine = require('../lib/production/engine');
const adv = require('../lib/production/engine-advanced');
const { acct } = require('../lib/coa-map');

console.log('\n══ P7 Fixed Advanced Tests ══\n');

const { db, cleanup } = freshDb();
const adminId = 1;
const DATE = '1405/04/15';
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

const whRaw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get()?.id;
const whFg = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get()?.id;
const whScrap = db.prepare("SELECT id FROM warehouses WHERE code='WH-SCRAP'").get()?.id || whRaw;

db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_raw_id',?)").run(String(whRaw));
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_fg_id',?)").run(String(whFg));
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_scrap_id',?)").run(String(whScrap));

for (const id of [p101, p201, p202, p203, p204, p205, p206, p299]) {
  const p = db.prepare('SELECT stock FROM products WHERE id=?').get(id);
  if (whRaw) {
    db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)')
      .run(id, whRaw, p.stock);
    db.prepare('UPDATE warehouse_stock SET qty=? WHERE product_id=? AND warehouse_id=?')
      .run(p.stock, id, whRaw);
  }
}

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

let supplierId = 1;
try {
  supplierId = db.prepare('INSERT INTO suppliers (name) VALUES (?)').run('خشکشویی رضوان').lastInsertRowid;
} catch {
  supplierId = db.prepare('SELECT id FROM suppliers LIMIT 1').get()?.id || 1;
}

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

advBom.applyRoutingTemplate(db, draft.id, adminId);
db.prepare(`UPDATE bom_operations SET crew_size=2 WHERE bom_id=? AND seq IN (10,60)`).run(draft.id);
db.prepare(`UPDATE bom_operations SET subcontract_supplier_id=? WHERE bom_id=? AND seq=50`)
  .run(supplierId, draft.id);

advBom.addOutput(db, draft.id, {
  product_id: p101, output_type: 'main', qty_per_base: 1,
  cost_method: 'share', cost_share_percent: 100,
});
advBom.addOutput(db, draft.id, {
  product_id: p299, output_type: 'by', qty_per_base: 0.09,
  cost_method: 'nrv', nrv_rial: 120000,
});

bom.activateBom(db, draft.id, '1405/01/01', adminId);

const STAGES = [
  { seq: 10, qty_out: 307.72, waste_normal: 6.28 },
  { seq: 20, qty_out: 307.72, waste_normal: 0 },
  { seq: 30, qty_out: 304.6428, waste_normal: 3.0772 },
  { seq: 40, qty_out: 304.6428, waste_normal: 0 },
  { seq: 50, qty_out: 300.073158, waste_normal: 4.569642, auto_subcontract_fee: true },
  { seq: 60, qty_out: 300.073158, waste_normal: 0, qc_passed: 1 },
];

const GOLDEN_COST_OUT = {
  10: 530068525,
  20: 562379125,
  30: 639290285,
  40: 672412885,
  50: 685512525,
  60: 698324500,
};

const po = engine.createOrder(db, {
  product_id: p101,
  bom_id: draft.id,
  qty_planned: 300,
  analysis_type: 'fixed_adv',
  date: DATE,
  warehouse_raw_id: whRaw,
  warehouse_fg_id: whFg,
  cost_center_id: cc['CC-30'],
}, adminId);

const rel = engine.releaseOrder(db, po.id, adminId);
const stages = adv.stageList(db, po.id);

ok('T7-01 stages=6', stages.length === 6);
eq('T7-01 qty_in[10]', stages.find(s => s.seq === 10)?.qty_in, 314, 0.01);

for (const spec of STAGES) {
  const st = stages.find(s => s.seq === spec.seq);
  const body = {
    date: DATE,
    qty_out: spec.qty_out,
    waste_normal: spec.waste_normal,
    waste_abnormal: 0,
    rework: 0,
    auto_subcontract_fee: spec.auto_subcontract_fee,
    qc_passed: spec.qc_passed,
    supplier_id: supplierId,
  };
  const r = adv.postStageOutputFixed(db, {
    orderId: po.id, stageId: st.id, body, userId: adminId,
  });
  eq(`T7-${String(spec.seq).padStart(2, '0')} cost_out`, r.costs.cost_out_rial,
    GOLDEN_COST_OUT[spec.seq], 50);
}

const stageTransferJe = db.prepare(`
  SELECT COUNT(*) c FROM journal_entries
  WHERE ref_type LIKE '%stage_transfer%' AND COALESCE(deleted_at,0)=0
`).get().c;
ok('T7-10 no stage_transfer JE', stageTransferJe === 0);

const fin = adv.finalizeAdvancedOrder(db, {
  orderId: po.id,
  body: { date: DATE, qty_produced: 300.073158 },
  userId: adminId,
});

eq('T7-28 receipt amount', fin.amount_rial, 694933300, 50);
eq('T7-29 unit_cost', fin.unit_cost_rial, 2315880, 50);
eq('T7-30 WIP residual', fin.wip_residual_rial, 0, 5);

cleanup();
summary('P7 Fixed Advanced');
