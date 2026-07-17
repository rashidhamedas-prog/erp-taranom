'use strict';
/**
 * P3 — Variable analysis (ADR-011) — key golden tests
 */
const { ok, eq, throws, freshDb, summary } = require('./lib/test-harness');
const bom = require('../lib/production/bom');
const engine = require('../lib/production/engine');
const { acct } = require('../lib/coa-map');

console.log('\n══ P3 Variable Analysis Tests ══\n');

const { db, cleanup } = freshDb();
const adminId = 1;
const DATE = '1405/04/10';
const PERIOD = '1405/04';

function seed() {
  const run = (name, avg, type, mfg, stock, std) => {
    const id = db.prepare('INSERT INTO products (user_id,name,price,stock) VALUES (1,?,?,?)')
      .run(name, 0, stock).lastInsertRowid;
    db.prepare('UPDATE products SET average_cost_rial=?, item_type=?, is_manufactured=?, std_cost_rial=? WHERE id=?')
      .run(avg, type, mfg, std != null ? std : avg, id);
    return id;
  };
  return {
    p101: run('مانتو', 2100000, 'finished', 1, 50, 0),
    p201: run('پارچه', 950000, 'raw', 0, 5000, 900000),
    p202: run('آستر', 180000, 'raw', 0, 5000, 175000),
    p203: run('نخ', 85000, 'raw', 0, 5000, 85000),
    p204: run('دکمه', 12000, 'raw', 0, 50000, 12500),
    p205: run('لیبل', 6000, 'packaging', 0, 5000, 6000),
    p206: run('نایلون', 9000, 'packaging', 0, 5000, 9000),
    p299: run('خرده', 0, 'scrap', 0, 0, 0),
  };
}

const P = seed();
const whRaw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get()?.id;
const whFg = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get()?.id;
const whScrap = db.prepare("SELECT id FROM warehouses WHERE code='WH-SCRAP'").get()?.id || whRaw;
const cc30 = db.prepare("SELECT id FROM cost_centers WHERE code='CC-30'").get()?.id;

db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_raw_id',?)").run(String(whRaw));
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_fg_id',?)").run(String(whFg));
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_scrap_id',?)").run(String(whScrap));
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_variance_reason_pct',?)").run('20');

if (cc30) {
  db.prepare(`
    INSERT INTO cost_center_rates
      (cost_center_id, period_label, driver, total_rate_rial, fixed_rate_rial, status)
    VALUES (?,?,?,?,?,'active')
  `).run(cc30, PERIOD, 'output_qty', 150000, 150000);
}

const lines = [
  { component_product_id: P.p201, qty_per_base: 1.60, scrap_percent: 4, line_type: 'material', std_cost_rial: 900000 },
  { component_product_id: P.p202, qty_per_base: 0.35, scrap_percent: 3, line_type: 'material', std_cost_rial: 175000 },
  { component_product_id: P.p203, qty_per_base: 0.08, scrap_percent: 0, line_type: 'material', std_cost_rial: 85000 },
  { component_product_id: P.p204, qty_per_base: 6, scrap_percent: 2, line_type: 'material', std_cost_rial: 12500 },
  { component_product_id: P.p205, qty_per_base: 1, scrap_percent: 0, line_type: 'packaging', std_cost_rial: 6000 },
  { component_product_id: P.p206, qty_per_base: 1, scrap_percent: 0, line_type: 'packaging', std_cost_rial: 9000 },
];

const b = bom.createBom(db, {
  product_id: P.p101, name: 'BOM V', yield_percent: 97, base_qty: 1, lines,
}, adminId);
// set std before activate (trigger locks active BOMs)
for (const L of lines) {
  db.prepare('UPDATE bom_lines SET std_cost_rial=? WHERE bom_id=? AND component_product_id=?')
    .run(L.std_cost_rial, b.id, L.component_product_id);
}
bom.activateBom(db, b.id, '1405/01/01', adminId);

const ACTUAL = [
  { product_id: P.p201, qty_actual: 530, reason: 'عرض طاقه' },
  { product_id: P.p202, qty_actual: 105, reason: 'صرفه‌جویی' },
  { product_id: P.p203, qty_actual: 26, reason: 'ok' },
  { product_id: P.p204, qty_actual: 1900, reason: 'ok' },
  { product_id: P.p205, qty_actual: 300, reason: 'ok' },
  { product_id: P.p206, qty_actual: 300, reason: 'ok' },
];

const LABOR = [
  { method: 'piece', rate_rial: 250000 },
  { method: 'monthly', rate_rial: 40000 },
];

let po = engine.createOrder(db, {
  product_id: P.p101, qty_planned: 300, analysis_type: 'variable',
  date: DATE, warehouse_raw_id: whRaw, warehouse_fg_id: whFg, cost_center_id: cc30,
}, adminId);
engine.releaseOrder(db, po.id, adminId);

// T3-01 template
try {
  const tpl = engine.issueTemplate(db, { orderId: po.id, qtyStarted: 300 });
  ok('T3-01 قالب حواله', tpl.lines.length === 6 && Math.abs(tpl.lines[0].qty_standard - 515.4639) < 0.0001);
} catch (e) {
  ok('T3-01 قالب حواله', false, e.message);
}

// T3-03..T3-09 issue + receipt
try {
  const iss = engine.issueMaterialsVariable(db, {
    orderId: po.id,
    body: { date: DATE, qty_started: 300, materials: ACTUAL },
    userId: adminId,
  });
  eq('T3-06 مبلغ سند واقعی', iss.totals.total_rial, 551910000, 0);
  eq('T3-03 انحراف نرخ', iss.totals.var_price_rial, 26075000, 0);
  eq('T3-04 انحراف مقدار', iss.totals.var_qty_rial, 11976770, 0);
  eq('T3-05 تجزیه انحراف', iss.totals.var_price_rial + iss.totals.var_qty_rial, iss.totals.var_total_rial, 0);

  const bad5210 = db.prepare(`
    SELECT COUNT(*) c FROM journal_lines jl
    JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.account_code IN ('5210','5211') AND COALESCE(je.deleted_at,0)=0
  `).get().c;
  ok('T3-07 بدون سند انحراف ADR-011', bad5210 === 0);

  db.prepare('UPDATE products SET stock=50, average_cost_rial=2100000 WHERE id=?').run(P.p101);
  const r = engine.postReceiptVariable(db, {
    orderId: po.id,
    body: {
      date: DATE, qty_produced: 294, waste_normal: 4, waste_abnormal: 2,
      labor: LABOR, auto_labor: true,
      scrap: [{ product_id: P.p299, qty: 27, nrv_unit_rial: 120000 }],
    },
    userId: adminId,
  });
  eq('T3-08 بهای واحد', r.costs.unit_cost_rial, 2299696, 0);
  eq('T3-09 WIP صفر', engine.wipResidual(db, po.id), 0, 5);
  eq('T3-08b WIP خالص', r.costs.net_rial, 676110600, 0);
} catch (e) {
  ok('T3 golden path', false, e.stack || e.message);
  console.error(e);
}

// T3-15 no material
throws('T3-15 رسید بدون حواله', () => {
  const po2 = engine.createOrder(db, {
    product_id: P.p101, qty_planned: 10, analysis_type: 'variable',
    date: DATE, warehouse_raw_id: whRaw, warehouse_fg_id: whFg, cost_center_id: cc30,
  }, adminId);
  engine.releaseOrder(db, po2.id, adminId);
  engine.postReceiptVariable(db, {
    orderId: po2.id,
    body: { date: DATE, qty_produced: 10, labor: LABOR },
    userId: adminId,
  });
}, 'E_NO_MATERIAL_ISSUED');

// T3-10 variance reason — lower threshold
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_variance_reason_pct','5')").run();
throws('T3-10 دلیل الزامی', () => {
  const po3 = engine.createOrder(db, {
    product_id: P.p101, qty_planned: 300, analysis_type: 'variable',
    date: DATE, warehouse_raw_id: whRaw, warehouse_fg_id: whFg, cost_center_id: cc30,
  }, adminId);
  engine.releaseOrder(db, po3.id, adminId);
  engine.issueMaterialsVariable(db, {
    orderId: po3.id,
    body: {
      date: DATE, qty_started: 300,
      materials: [{ product_id: P.p201, qty_actual: 600 }], // big variance, no reason
    },
    userId: adminId,
  });
}, 'E_VARIANCE_NEEDS_REASON');

cleanup();
summary('P3 Variable');
