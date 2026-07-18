'use strict';
/**
 * P8 — Variable advanced (ADR-011: no 5210/5211 JE)
 */
const { ok, eq, throws, freshDb, summary } = require('./lib/test-harness');
const bom = require('../lib/production/bom');
const advBom = require('../lib/production/bom-advanced');
const engine = require('../lib/production/engine');
const adv = require('../lib/production/engine-advanced');
const { acct } = require('../lib/coa-map');

console.log('\n══ P8 Variable Advanced Tests ══\n');

const { db, cleanup } = freshDb();
const adminId = 1;
const DATE = '1405/04/18';
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
  supplierId = db.prepare('INSERT INTO suppliers (name) VALUES (?)').run('خشکشویی').lastInsertRowid;
} catch {
  supplierId = db.prepare('SELECT id FROM suppliers LIMIT 1').get()?.id || 1;
}

const draft = bom.createBom(db, {
  product_id: p101, name: 'BOM var adv', yield_percent: 100, base_qty: 1,
  has_routing: 1, has_coproducts: 1,
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

const po = engine.createOrder(db, {
  product_id: p101, bom_id: draft.id, qty_planned: 300,
  analysis_type: 'variable_adv', date: DATE,
  warehouse_raw_id: whRaw, warehouse_fg_id: whFg, cost_center_id: cc['CC-30'],
}, adminId);

engine.releaseOrder(db, po.id, adminId);
let stages = adv.stageList(db, po.id);

// Issue actual materials per stage (doc §6.1)
const issues = {
  10: [
    { product_id: p201, qty_actual: 540 },
    { product_id: p202, qty_actual: 108 },
  ],
  30: [{ product_id: p203, qty_actual: 26 }],
  40: [{ product_id: p204, qty_actual: 1930 }],
  60: [
    { product_id: p205, qty_actual: 314 },
    { product_id: p206, qty_actual: 314 },
  ],
};

for (const [seq, mats] of Object.entries(issues)) {
  const st = stages.find(s => s.seq === Number(seq));
  adv.issueStageMaterials(db, {
    orderId: po.id, stageId: st.id,
    body: { date: DATE, materials: mats }, userId: adminId,
  });
}

const STAGES = [
  { seq: 10, qty_out: 307.72, waste_normal: 6.28 },
  { seq: 20, qty_out: 307.72, waste_normal: 0 },
  { seq: 30, qty_out: 304.6428, waste_normal: 3.0772 },
  { seq: 40, qty_out: 304.6428, waste_normal: 0 },
  { seq: 50, qty_out: 300.073158, waste_normal: 4.569642, auto_subcontract_fee: true },
  { seq: 60, qty_out: 300.073158, waste_normal: 0, qc_passed: 1 },
];

for (const spec of STAGES) {
  stages = adv.stageList(db, po.id);
  const st = stages.find(s => s.seq === spec.seq);
  adv.postStageOutputVariable(db, {
    orderId: po.id, stageId: st.id,
    body: {
      date: DATE,
      qty_out: spec.qty_out,
      waste_normal: spec.waste_normal,
      waste_abnormal: 0,
      auto_subcontract_fee: spec.auto_subcontract_fee,
      qc_passed: spec.qc_passed,
      supplier_id: supplierId,
    },
    userId: adminId,
  });
}

const a5210 = acct(db, 'coa_var_material_price');
const a5211 = db.prepare("SELECT code FROM chart_of_accounts WHERE code='5211'").get()?.code || '5211';
const bal5210 = db.prepare(`
  SELECT COALESCE(SUM(COALESCE(jl.debit_rial, ROUND(jl.debit*10))),0) -
         COALESCE(SUM(COALESCE(jl.credit_rial, ROUND(jl.credit*10))),0) bal
  FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
  WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0
`).get(a5210.code);
const bal5211 = db.prepare(`
  SELECT COALESCE(SUM(COALESCE(jl.debit_rial, ROUND(jl.debit*10))),0) -
         COALESCE(SUM(COALESCE(jl.credit_rial, ROUND(jl.credit*10))),0) bal
  FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
  WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0
`).get(a5211);

ok('T8-09 no 5210 JE', Math.abs(Number(bal5210?.bal) || 0) < 1);
ok('T8-09 no 5211 JE', Math.abs(Number(bal5211?.bal) || 0) < 1);

stages = adv.stageList(db, po.id);
const s10 = stages.find(s => s.seq === 10);
eq('T8-09b stage10 OH', s10?.overhead_rial, 4791960, 50);

const fin = adv.finalizeAdvancedOrder(db, {
  orderId: po.id,
  body: { date: DATE, qty_produced: 300.073158 },
  userId: adminId,
});
eq('T8-20 unit_cost', fin.unit_cost_rial, 2366463, 5000);

stages = adv.stageList(db, po.id);
ok('T8 smoke six stages', stages.length === 6);
ok('T8 smoke all done', stages.every(s => s.status === 'done'));

const issueRows = db.prepare(`
  SELECT qty_standard, qty_actual, unit_cost_rial, std_cost_rial, var_price_rial, var_qty_rial
  FROM production_material_issues WHERE order_id=?
`).all(po.id);
let aqAp = 0;
let sqSp = 0;
let varSum = 0;
for (const r of issueRows) {
  aqAp += Number(r.qty_actual) * Number(r.unit_cost_rial);
  sqSp += Number(r.qty_standard) * Number(r.std_cost_rial);
  varSum += Number(r.var_price_rial) + Number(r.var_qty_rial);
}
eq('T8-08 variance identity Σvar = ΣAQ×AP − ΣSQ×SP', varSum, Math.round(aqAp - sqSp), 50);
ok('T8-08 variance total > 0', varSum > 0);

const memoVars = db.prepare(`
  SELECT status FROM production_variances WHERE order_id=?
`).all(po.id);
ok('T8 memo variances only', memoVars.length > 0 && memoVars.every(v => v.status === 'memo'));

const memoIssues = db.prepare(`
  SELECT variance_status FROM production_material_issues WHERE order_id=?
`).all(po.id);
ok('T8 issue variance_status memo', memoIssues.length > 0 && memoIssues.every(v => v.variance_status === 'memo'));

const varJe5210 = db.prepare(`
  SELECT COUNT(*) c FROM journal_lines jl
  JOIN journal_entries je ON je.id=jl.entry_id
  WHERE jl.account_code IN (?, ?) AND COALESCE(je.deleted_at,0)=0
`).get(a5210.code, a5211).c;
ok('T8-09 no variance account JE lines', varJe5210 === 0);

// T8-11 already covered by T8-09b stage10 OH (4791960)

const poNoIssue = engine.createOrder(db, {
  product_id: p101, bom_id: draft.id, qty_planned: 50,
  analysis_type: 'variable_adv', date: DATE,
  warehouse_raw_id: whRaw, warehouse_fg_id: whFg, cost_center_id: cc['CC-30'],
}, adminId);
engine.releaseOrder(db, poNoIssue.id, adminId);
const stNoIssue = adv.stageList(db, poNoIssue.id).find(s => s.seq === 10);
throws('T8 E_NO_MATERIAL_ISSUED', () => {
  adv.postStageOutputVariable(db, {
    orderId: poNoIssue.id, stageId: stNoIssue.id,
    body: { date: DATE, qty_out: stNoIssue.qty_in, waste_normal: 0, waste_abnormal: 0 },
    userId: adminId,
  });
}, 'E_NO_MATERIAL_ISSUED');

cleanup();
summary('P8 Variable Advanced');
