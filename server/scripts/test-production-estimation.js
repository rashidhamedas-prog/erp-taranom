'use strict';
/**
 * P5 — Estimation + MRP (docs/Production/05-production-estimation.md)
 */
const { ok, eq, freshDb, summary } = require('./lib/test-harness');
const bom = require('../lib/production/bom');
const advBom = require('../lib/production/bom-advanced');
const { estimateCost } = require('../lib/production/estimate');
const { mrpRun } = require('../lib/production/mrp');

console.log('\n══ P5 Estimation + MRP Tests ══\n');

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
const p201 = seedProduct('پارچه', 950000, 'raw', 0, 5000);
const p202 = seedProduct('آستر', 180000, 'raw', 0, 5000);
const p203 = seedProduct('نخ', 85000, 'raw', 0, 5000);
const p204 = seedProduct('دکمه', 12000, 'raw', 0, 50000);
const p205 = seedProduct('لیبل', 6000, 'packaging', 0, 5000);
const p206 = seedProduct('نایلون', 9000, 'packaging', 0, 5000);
const p299 = seedProduct('خرده پارچه', 120000, 'scrap', 0);

const cc = {};
for (const code of ['CC-10', 'CC-20', 'CC-30', 'CC-40', 'CC-50', 'CC-60']) {
  cc[code] = db.prepare('SELECT id FROM cost_centers WHERE code=?').get(code)?.id;
}

db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('pricing_margin_percent','35')").run();
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('rep_commission_percent','4.5')").run();
db.prepare('UPDATE products SET price=? WHERE id=?').run(320000, p101);

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

const draft = bom.createBom(db, {
  product_id: p101, name: 'BOM est', yield_percent: 100, base_qty: 1,
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
advBom.addOutput(db, draft.id, {
  product_id: p101, output_type: 'main', qty_per_base: 1,
  cost_method: 'share', cost_share_percent: 100,
});
advBom.addOutput(db, draft.id, {
  product_id: p299, output_type: 'by', qty_per_base: 0.09,
  cost_method: 'nrv', nrv_rial: 120000,
});
bom.activateBom(db, draft.id, '1405/01/01', adminId);

const stockBefore = {};
for (const id of [p201, p202, p203, p204, p205, p206]) {
  stockBefore[id] = db.prepare('SELECT stock FROM products WHERE id=?').get(id).stock;
}

const est500 = estimateCost(db, { productId: p101, qty: 500, period: PERIOD, date: '1405/04/10' });
eq('T5-01 unit_cost @500', est500.cost.unit_cost_rial, 2315880, 5);
eq('T5-02 qty_start @500', est500.qty_start, 524, 0);

const est300 = estimateCost(db, { productId: p101, qty: 300, period: PERIOD });
eq('T5-01 scale-invariant unit', est300.cost.unit_cost_rial, 2315880, 5);

eq('T5-04 markup price', est500.pricing.markup_price_rial, Math.round(2315880 * 1.35), 5);
eq('T5-05 margin price', est500.pricing.margin_price_rial, Math.round(2315880 / 0.65), 5);
eq('T5-06 breakeven', est500.discount_analysis.breakeven_discount_pct, 24.22, 0.05);

const jeCountBefore = db.prepare(`
  SELECT COUNT(*) c FROM journal_entries WHERE ref_type LIKE 'production%'
`).get().c;

estimateCost(db, { productId: p101, qty: 100, period: PERIOD });
const jeCountAfter = db.prepare(`
  SELECT COUNT(*) c FROM journal_entries WHERE ref_type LIKE 'production%'
`).get().c;
ok('T5-22 no JE on estimate', jeCountBefore === jeCountAfter);

for (const id of [p201, p202, p203, p204, p205, p206]) {
  const s = db.prepare('SELECT stock FROM products WHERE id=?').get(id).stock;
  ok(`T5-23 stock unchanged ${id}`, s === stockBefore[id]);
}

const mrp = mrpRun(db, { horizonDays: 30, date: '1405/04/10', userId: adminId });
ok('T5 MRP run', mrp.ok && mrp.run_id > 0);

cleanup();
summary('P5 Estimation + MRP');
