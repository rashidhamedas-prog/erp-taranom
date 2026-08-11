'use strict';
/**
 * P3 — Variable analysis (ADR-011) — T3-01..T3-24
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { ok, eq, throws, freshDb, summary } = require('./lib/test-harness');
const bom = require('../lib/production/bom');
const engine = require('../lib/production/engine');
const variance = require('../lib/production/variance');
const { stripCostFields } = require('../lib/production/access');
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
    p999: run('خارجBOM', 100000, 'raw', 0, 5000, 100000),
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
    ON CONFLICT(cost_center_id, period_label) DO UPDATE SET
      driver=excluded.driver,
      total_rate_rial=excluded.total_rate_rial,
      fixed_rate_rial=excluded.fixed_rate_rial,
      status='active'
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

function makeOrder(qty = 300, type = 'variable') {
  const po = engine.createOrder(db, {
    product_id: P.p101, qty_planned: qty, analysis_type: type,
    date: DATE, warehouse_raw_id: whRaw, warehouse_fg_id: whFg, cost_center_id: cc30,
  }, adminId);
  engine.releaseOrder(db, po.id, adminId);
  return po;
}

function count5210() {
  return db.prepare(`
    SELECT COUNT(*) c FROM journal_lines jl
    JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.account_code IN ('5210','5211') AND COALESCE(je.deleted_at,0)=0
  `).get().c;
}

// ─── Golden path ─────────────────────────────────────────────
let po = makeOrder(300);

try {
  const tpl = engine.issueTemplate(db, { orderId: po.id, qtyStarted: 300 });
  ok('T3-01 قالب حواله', tpl.lines.length === 6 && Math.abs(tpl.lines[0].qty_standard - 515.4639) < 0.0001);
} catch (e) {
  ok('T3-01 قالب حواله', false, e.message);
}

// T3-02 AQ=SQ
try {
  const poEq = makeOrder(10);
  const tpl2 = engine.issueTemplate(db, { orderId: poEq.id, qtyStarted: 10 });
  const mats = tpl2.lines.map((L) => ({
    product_id: L.product_id, qty_actual: L.qty_standard, reason: 'ok',
  }));
  const issEq = engine.issueMaterialsVariable(db, {
    orderId: poEq.id, body: { date: DATE, qty_started: 10, materials: mats }, userId: adminId,
  });
  ok('T3-02 حواله=استاندارد', issEq.lines.every((l) => Math.abs(l.qty_variance) < 1e-6 && l.var_qty_rial === 0));
} catch (e) {
  ok('T3-02 حواله=استاندارد', false, e.message);
}

try {
  const iss = engine.issueMaterialsVariable(db, {
    orderId: po.id,
    body: { date: DATE, qty_started: 300, materials: ACTUAL },
    userId: adminId,
  });
  const fabric = iss.lines.find((l) => l.product_id === P.p201);
  eq('T3-06 مبلغ سند واقعی', iss.totals.total_rial, 551910000, 0);
  eq('T3-03 انحراف نرخ پارچه', fabric.var_price_rial, 26500000, 0);
  eq('T3-04 انحراف مقدار پارچه', fabric.var_qty_rial, 13082474, 20);
  eq('T3-03b انحراف نرخ کل', iss.totals.var_price_rial, 26075000, 0);
  eq('T3-04b انحراف مقدار کل', iss.totals.var_qty_rial, 11976770, 0);

  const indep = iss.lines.reduce((s, l) => s + (l.amount_rial - l.std_amount_rial), 0);
  eq('T3-05 تجزیه انحراف', iss.totals.var_price_rial + iss.totals.var_qty_rial, indep, 0);
  ok('T3-07 بدون سند انحراف ADR-011', count5210() === 0);

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
  eq('T3-08 بهای واحد', r.costs.unit_cost_rial, 2299697, 1);
  eq('T3-09 WIP صفر', engine.wipResidual(db, po.id), 0, 5);
  eq('T3-08b WIP خالص', r.costs.net_rial, 676110600, 5);
} catch (e) {
  ok('T3 golden path', false, e.stack || e.message);
  console.error(e);
}

throws('T3-15 رسید بدون حواله', () => {
  const po2 = makeOrder(10);
  engine.postReceiptVariable(db, {
    orderId: po2.id,
    body: { date: DATE, qty_produced: 10, labor: LABOR },
    userId: adminId,
  });
}, 'E_NO_MATERIAL_ISSUED');

db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_variance_reason_pct','5')").run();
throws('T3-10 دلیل الزامی', () => {
  const po3 = makeOrder(300);
  engine.issueMaterialsVariable(db, {
    orderId: po3.id,
    body: {
      date: DATE, qty_started: 300,
      materials: [{ product_id: P.p201, qty_actual: 600 }],
    },
    userId: adminId,
  });
}, 'E_VARIANCE_NEEDS_REASON');
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_variance_reason_pct','20')").run();

// T3-11 out of BOM
try {
  const po4 = makeOrder(10);
  const iss4 = engine.issueMaterialsVariable(db, {
    orderId: po4.id,
    body: {
      date: DATE, qty_started: 10,
      materials: [{ product_id: P.p999, qty_actual: 5, reason: 'اضافه' }],
    },
    userId: adminId,
  });
  const line = iss4.lines[0];
  const warn = JSON.stringify(iss4.warnings || []);
  ok('T3-11 خارج BOM', line.qty_standard === 0 && warn.includes('W_ITEM_NOT_IN_BOM'));
} catch (e) {
  ok('T3-11 خارج BOM', false, e.message);
}

// T3-12 / T3-13 / T3-14 returns
try {
  const poR = makeOrder(50);
  engine.issueMaterialsVariable(db, {
    orderId: poR.id,
    body: {
      date: DATE, qty_started: 50,
      materials: [{ product_id: P.p201, qty_actual: 80, reason: 'مصرف' }],
    },
    userId: adminId,
  });
  const beforeAvg = db.prepare('SELECT average_cost_rial FROM products WHERE id=?').get(P.p201).average_cost_rial;
  db.prepare('UPDATE products SET average_cost_rial=? WHERE id=?').run(999999, P.p201); // T3-14 change avg

  const ret = engine.postMaterialReturn(db, {
    orderId: poR.id,
    body: {
      date: DATE, qty_started: 50,
      materials: [{ product_id: P.p201, qty_actual: 30, reason: 'برگشت' }],
    },
    userId: adminId,
  });
  eq('T3-12 برگشت مبلغ', Math.abs(ret.totals.total_rial), 28500000, 0);
  const retLine = ret.lines[0];
  eq('T3-14 نرخ سند اصلی', retLine.unit_cost_rial, 950000, 0);

  throws('T3-13 برگشت بیش از حواله', () => {
    engine.postMaterialReturn(db, {
      orderId: poR.id,
      body: {
        date: DATE,
        materials: [{ product_id: P.p201, qty_actual: 600 }],
      },
      userId: adminId,
    });
  }, 'E_RETURN_EXCEEDS_ISSUE');

  db.prepare('UPDATE products SET average_cost_rial=? WHERE id=?').run(beforeAvg, P.p201);
} catch (e) {
  ok('T3 return suite', false, e.message);
}

// T3-16 analysis lock
try {
  const poL = makeOrder(20);
  engine.issueMaterialsVariable(db, {
    orderId: poL.id,
    body: {
      date: DATE, qty_started: 20,
      materials: [{ product_id: P.p201, qty_actual: 32, reason: 'ok' }],
    },
    userId: adminId,
  });
  throws('T3-16 قفل آنالیز', () => {
    engine.updateOrder(db, poL.id, { analysis_type: 'fixed' });
  }, 'E_ANALYSIS_LOCKED');
} catch (e) {
  ok('T3-16 قفل آنالیز', false, e.message);
}

// T3-17 multi-issue
try {
  const poM = makeOrder(30);
  engine.issueMaterialsVariable(db, {
    orderId: poM.id,
    body: {
      date: DATE, qty_started: 30,
      materials: [{ product_id: P.p201, qty_actual: 20, reason: 'a' }],
    },
    userId: adminId,
  });
  engine.issueMaterialsVariable(db, {
    orderId: poM.id,
    body: {
      date: DATE, qty_started: 30,
      materials: [{ product_id: P.p201, qty_actual: 15, reason: 'b' }],
    },
    userId: adminId,
  });
  const va = variance.varianceAnalysis(db, poM.id);
  const fabricAgg = va.lines.find((l) => l.product_id === P.p201);
  ok('T3-17 چند حواله', fabricAgg && Math.abs(fabricAgg.qty_actual - 35) < 1e-6);
} catch (e) {
  ok('T3-17 چند حواله', false, e.message);
}

// T3-18 SP=0 → SP:=AP (explode treats 0 as missing via || fallback; zero product std too)
try {
  const poS = makeOrder(5);
  db.prepare("UPDATE bom_headers SET status='draft' WHERE id=?").run(b.id);
  db.prepare('UPDATE bom_lines SET std_cost_rial=0 WHERE bom_id=? AND component_product_id=?')
    .run(b.id, P.p203);
  db.prepare("UPDATE bom_headers SET status='active' WHERE id=?").run(b.id);
  db.prepare('UPDATE products SET std_cost_rial=0 WHERE id=?').run(P.p203);
  const issS = engine.issueMaterialsVariable(db, {
    orderId: poS.id,
    body: {
      date: DATE, qty_started: 5,
      materials: [{ product_id: P.p203, qty_actual: 1, reason: 'ok' }],
    },
    userId: adminId,
  });
  const ln = issS.lines[0];
  const warnTxt = JSON.stringify(issS.warnings || []);
  ok('T3-18 SP=0', ln.var_price_rial === 0 && warnTxt.includes('استاندارد'));
  db.prepare("UPDATE bom_headers SET status='draft' WHERE id=?").run(b.id);
  db.prepare('UPDATE bom_lines SET std_cost_rial=85000 WHERE bom_id=? AND component_product_id=?')
    .run(b.id, P.p203);
  db.prepare("UPDATE bom_headers SET status='active' WHERE id=?").run(b.id);
  db.prepare('UPDATE products SET std_cost_rial=85000 WHERE id=?').run(P.p203);
} catch (e) {
  ok('T3-18 SP=0', false, e.message);
}

// T3-19 BOM revision suggestion
try {
  for (let i = 0; i < 3; i++) {
    const ox = makeOrder(20);
    engine.issueMaterialsVariable(db, {
      orderId: ox.id,
      body: {
        date: DATE, qty_started: 20,
        materials: [{ product_id: P.p201, qty_actual: 40, reason: 'زیاد' }],
      },
      userId: adminId,
    });
    db.prepare("UPDATE production_orders SET status='completed' WHERE id=?").run(ox.id);
  }
  const sug = variance.checkBomRevisionSuggestion(db, P.p101);
  ok('T3-19 پیشنهاد بازنگری', sug.suggest === true && sug.suggestions.length > 0);
} catch (e) {
  ok('T3-19 پیشنهاد بازنگری', false, e.message);
}

// T3-20 fixed vs variable delta (~42800)
try {
  // reuse golden variable unit if available from earlier receipt
  const varUnit = db.prepare('SELECT unit_cost_rial FROM production_orders WHERE id=?').get(po.id)?.unit_cost_rial;
  const poF = makeOrder(300, 'fixed');
  db.prepare('UPDATE products SET stock=50, average_cost_rial=2100000 WHERE id=?').run(P.p101);
  // restore stock for materials used heavily
  for (const pid of [P.p201, P.p202, P.p203, P.p204, P.p205, P.p206]) {
    db.prepare('UPDATE products SET stock=5000 WHERE id=?').run(pid);
    db.prepare('UPDATE warehouse_stock SET qty=5000 WHERE product_id=? AND warehouse_id=?').run(pid, whRaw);
  }
  const rf = engine.postReceiptFixed(db, {
    orderId: poF.id,
    body: {
      date: DATE, qty_produced: 294, waste_normal: 4, waste_abnormal: 2,
      labor: LABOR, auto_labor: true,
      scrap: [{ product_id: P.p299, qty: 27, nrv_unit_rial: 120000 }],
    },
    userId: adminId,
  });
  if (varUnit) {
    eq('T3-20 اختلاف fixed/variable', Math.round(varUnit - rf.costs.unit_cost_rial), 42800, 500);
  } else {
    ok('T3-20 اختلاف fixed/variable', false, 'no variable unit');
  }
} catch (e) {
  ok('T3-20 اختلاف fixed/variable', false, e.message);
}

// T3-21 substitute
try {
  const poSub = makeOrder(10);
  const issSub = engine.issueMaterialsVariable(db, {
    orderId: poSub.id,
    body: {
      date: DATE, qty_started: 10,
      materials: [{
        product_id: P.p999, qty_actual: 5, reason: 'جایگزین',
        substitute_of_product_id: P.p201,
      }],
    },
    userId: adminId,
  });
  const row = db.prepare(`
    SELECT issue_type, qty_standard FROM production_material_issues
    WHERE order_id=? AND product_id=? ORDER BY id DESC LIMIT 1
  `).get(poSub.id, P.p999);
  ok('T3-21 جایگزین', row?.issue_type === 'substitute' && row.qty_standard > 0);
} catch (e) {
  ok('T3-21 جایگزین', false, e.message);
}

// T3-22 reverse
try {
  const poRev = makeOrder(5);
  engine.issueMaterialsVariable(db, {
    orderId: poRev.id,
    body: {
      date: DATE, qty_started: 5,
      materials: [{ product_id: P.p201, qty_actual: 8, reason: 'ok' }],
    },
    userId: adminId,
  });
  const stockBefore = db.prepare('SELECT stock FROM products WHERE id=?').get(P.p201).stock;
  const rev = engine.reverseOrder(db, poRev.id, adminId, 'تست');
  ok('T3-22 ابطال', rev.ok === true);
} catch (e) {
  ok('T3-22 ابطال', false, e.message);
}

// T3-23 issue after receipt
throws('T3-23 حواله بعد از رسید', () => {
  const poX = makeOrder(5);
  engine.issueMaterialsVariable(db, {
    orderId: poX.id,
    body: {
      date: DATE, qty_started: 5,
      materials: [{ product_id: P.p201, qty_actual: 8, reason: 'ok' }],
    },
    userId: adminId,
  });
  db.prepare('UPDATE products SET stock=50, average_cost_rial=2100000 WHERE id=?').run(P.p101);
  engine.postReceiptVariable(db, {
    orderId: poX.id,
    body: { date: DATE, qty_produced: 5, labor: LABOR, auto_labor: true },
    userId: adminId,
  });
  engine.issueMaterialsVariable(db, {
    orderId: poX.id,
    body: {
      date: DATE, qty_started: 5,
      materials: [{ product_id: P.p201, qty_actual: 1, reason: 'late' }],
    },
    userId: adminId,
  });
}, 'E_RECEIPT_EXISTS');

// T3-24 stripCostFields for operator-shaped payload
try {
  const sample = {
    ok: true,
    totals: { total_rial: 100, var_price_rial: 10 },
    lines: [{ amount_rial: 100, var_qty_rial: 5, name: 'x' }],
  };
  const stripped = stripCostFields(sample);
  const line0 = (stripped.lines && stripped.lines[0]) || {};
  ok('T3-24 حذف فیلد بها', line0.name === 'x' && line0.amount_rial == null && line0.var_qty_rial == null);
} catch (e) {
  ok('T3-24 حذف فیلد بها', false, e.message);
}

cleanup();
summary('P3 Variable');
