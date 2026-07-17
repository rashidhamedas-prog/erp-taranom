'use strict';
/**
 * P2 — Fixed analysis tests (docs/Production/02-fixed-analysis.md §21)
 * Golden numbers from test-cases.md §10
 */
const { ok, eq, throws, freshDb, summary } = require('./lib/test-harness');
const bom = require('../lib/production/bom');
const engine = require('../lib/production/engine');
const { acct } = require('../lib/coa-map');

console.log('\n══ P2 Fixed Analysis Tests ══\n');

const { db, cleanup } = freshDb();
const adminId = 1;
const DATE = '1405/04/10';
const PERIOD = '1405/04';

function seedProducts() {
  const run = (name, avg, type, mfg, stock = 10000) => {
    const id = db.prepare(`
      INSERT INTO products (user_id, name, price, stock)
      VALUES (1,?,?,?)
    `).run(name, 0, stock).lastInsertRowid;
    db.prepare(`UPDATE products SET average_cost_rial=?, item_type=?, is_manufactured=?, std_cost_rial=? WHERE id=?`)
      .run(avg, type, mfg, avg, id);
    return id;
  };
  const p101 = run('مانتو کتان ترمه — سبز', 2100000, 'finished', 1, 50);
  const p201 = run('پارچه کتان ۱۴۰', 950000, 'raw', 0, 2000);
  const p202 = run('آستر ساده', 180000, 'raw', 0, 2000);
  const p203 = run('نخ دوخت', 85000, 'raw', 0, 2000);
  const p204 = run('دکمه چوبی', 12000, 'raw', 0, 20000);
  const p205 = run('لیبل ترنم', 6000, 'packaging', 0, 2000);
  const p206 = run('نایلون', 9000, 'packaging', 0, 2000);
  const p299 = run('خرده پارچه', 0, 'scrap', 0, 0);
  return { p101, p201, p202, p203, p204, p205, p206, p299 };
}

const P = seedProducts();

const whRaw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get()?.id
  || db.prepare('SELECT id FROM warehouses LIMIT 1').get()?.id;
const whFg = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get()?.id
  || db.prepare('SELECT id FROM warehouses LIMIT 1').get()?.id;
const whScrap = db.prepare("SELECT id FROM warehouses WHERE code='WH-SCRAP'").get()?.id || whRaw;
const cc30 = db.prepare("SELECT id FROM cost_centers WHERE code='CC-30'").get()?.id;

if (whRaw) db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_raw_id',?)").run(String(whRaw));
if (whFg) db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_fg_id',?)").run(String(whFg));
if (whScrap) db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_scrap_id',?)").run(String(whScrap));

// Sync warehouse_stock with product stock
for (const id of [P.p101, P.p201, P.p202, P.p203, P.p204, P.p205, P.p206, P.p299]) {
  const p = db.prepare('SELECT stock FROM products WHERE id=?').get(id);
  if (whRaw) {
    db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)')
      .run(id, whRaw, p.stock);
    db.prepare('UPDATE warehouse_stock SET qty=? WHERE product_id=? AND warehouse_id=?')
      .run(p.stock, id, whRaw);
  }
  if (whFg && id === P.p101) {
    db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)')
      .run(id, whFg, p.stock);
    db.prepare('UPDATE warehouse_stock SET qty=? WHERE product_id=? AND warehouse_id=?')
      .run(p.stock, id, whFg);
  }
}

function makeLines() {
  return [
    { component_product_id: P.p201, qty_per_base: 1.60, scrap_percent: 4, line_type: 'material' },
    { component_product_id: P.p202, qty_per_base: 0.35, scrap_percent: 3, line_type: 'material' },
    { component_product_id: P.p203, qty_per_base: 0.08, scrap_percent: 0, line_type: 'material' },
    { component_product_id: P.p204, qty_per_base: 6, scrap_percent: 2, line_type: 'material' },
    { component_product_id: P.p205, qty_per_base: 1, scrap_percent: 0, line_type: 'packaging' },
    { component_product_id: P.p206, qty_per_base: 1, scrap_percent: 0, line_type: 'packaging' },
  ];
}

const bom1 = bom.createBom(db, {
  product_id: P.p101, name: 'BOM ترمه', yield_percent: 97, base_qty: 1, lines: makeLines(),
}, adminId);
bom.activateBom(db, bom1.id, '1405/01/01', adminId);

if (cc30) {
  db.prepare(`
    INSERT OR REPLACE INTO cost_center_rates
      (cost_center_id, period_label, driver, total_rate_rial, fixed_rate_rial, status, is_estimated)
    VALUES (?,?,?,?,?,'active',0)
  `).run(cc30, PERIOD, 'output_qty', 150000, 150000);
}

function snapshotState() {
  const stock = {};
  const avg = {};
  for (const id of [P.p101, P.p201, P.p202, P.p203, P.p204, P.p205, P.p206, P.p299]) {
    const p = db.prepare('SELECT stock, average_cost_rial FROM products WHERE id=?').get(id);
    stock[id] = Number(p.stock);
    avg[id] = Math.round(Number(p.average_cost_rial) || 0);
  }
  const ledger = {};
  for (const key of ['coa_wip', 'coa_raw_materials', 'coa_finished_goods', 'coa_abnormal_waste', 'coa_scrap_inventory']) {
    const a = acct(db, key);
    ledger[a.code] = engine.ledgerBalance(db, a.code);
  }
  return { stock, avg, ledger };
}

function jeDebit(accountCode, refType = null) {
  let sql = `
    SELECT COALESCE(SUM(COALESCE(jl.debit_rial, ROUND(jl.debit*10))),0) s
    FROM journal_lines jl
    JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0
  `;
  const params = [accountCode];
  if (refType) {
    sql += ' AND je.ref_type=?';
    params.push(refType);
  }
  return Math.round(Number(db.prepare(sql).get(...params).s) || 0);
}

function allJesBalanced() {
  const rows = db.prepare(`
    SELECT je.id,
      SUM(COALESCE(jl.debit_rial, ROUND(jl.debit*10))) d,
      SUM(COALESCE(jl.credit_rial, ROUND(jl.credit*10))) c
    FROM journal_entries je
    JOIN journal_lines jl ON jl.entry_id=je.id
    WHERE COALESCE(je.deleted_at,0)=0
      AND je.ref_type LIKE 'production%'
    GROUP BY je.id
  `).all();
  return rows.every(r => Math.abs(Number(r.d) - Number(r.c)) < 1);
}

const LABOR = [
  { method: 'piece', rate_rial: 250000 },
  { method: 'monthly', rate_rial: 40000 },
];
const SCRAP = [{ product_id: P.p299, qty: 27, nrv_unit_rial: 120000 }];
const RECEIPT_BODY = {
  date: DATE,
  qty_produced: 294,
  waste_normal: 4,
  waste_abnormal: 2,
  labor: LABOR,
  scrap: SCRAP,
  auto_labor: true,
};

let po;
let receipt;

// T2-01
try {
  po = engine.createOrder(db, {
    product_id: P.p101,
    qty_planned: 300,
    analysis_type: 'fixed',
    date: DATE,
    warehouse_raw_id: whRaw,
    warehouse_fg_id: whFg,
    cost_center_id: cc30,
  }, adminId);
  ok('T2-01 ایجاد سفارش', po.status === 'draft' && po.bom_id === bom1.id);
} catch (e) {
  ok('T2-01 ایجاد سفارش', false, e.message);
}

// T2-02
try {
  po = engine.releaseOrder(db, po.id, adminId);
  const resv = db.prepare('SELECT COUNT(*) c FROM production_reservations WHERE order_id=?').get(po.id).c;
  ok('T2-02 آزادسازی', po.status === 'released' && resv >= 6);
} catch (e) {
  ok('T2-02 آزادسازی', false, e.message);
}

const before = snapshotState();

// Lock FG opening inventory for golden moving-average
db.prepare('UPDATE products SET stock=50, average_cost_rial=2100000, cost=210000 WHERE id=?').run(P.p101);
if (whFg) {
  db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,50)').run(P.p101, whFg);
  db.prepare('UPDATE warehouse_stock SET qty=50 WHERE product_id=? AND warehouse_id=?').run(P.p101, whFg);
}

// T2-03..T2-12 golden receipt
try {
  receipt = engine.postReceiptFixed(db, { orderId: po.id, body: RECEIPT_BODY, userId: adminId });
  const issues = db.prepare(`
    SELECT * FROM production_material_issues WHERE order_id=? AND issue_type='backflush'
  `).all(po.id);
  ok('T2-03 Backflush کامل', issues.length === 6);

  const fabric = issues.find(i => i.product_id === P.p201);
  eq('T2-04 مقدار پارچه', fabric?.qty_actual, 515.4639, 0.0001);

  const wipCode = acct(db, 'coa_wip').code;
  eq('T2-05 مبلغ سند PRD-01', jeDebit(wipCode, 'production_material_issue'), 539242632, 0);

  const normalWaste = db.prepare(`
    SELECT je_id FROM production_waste WHERE order_id=? AND waste_type='normal'
  `).get(po.id);
  ok('T2-06 ضایعات عادی بدون سند', !normalWaste?.je_id);

  eq('T2-07 ضایعات غیرعادی', jeDebit(acct(db, 'coa_abnormal_waste').code), 4474951, 0);
  eq('T2-08 ضایعات قابل فروش', jeDebit(acct(db, 'coa_scrap_inventory').code), 3240000, 0);
  const scrapStock = db.prepare('SELECT stock FROM products WHERE id=?').get(P.p299);
  ok('T2-08b موجودی خرده', Math.abs(Number(scrapStock.stock) - 27) < 0.001);

  eq('T2-09 WIP صفر', engine.wipResidual(db, po.id), 0, 5);
  eq('T2-10 بهای واحد', receipt.costs.unit_cost_rial, 2256897, 0);

  // Ensure baseline for moving average (guard against migration side-effects)
  const rc = db.prepare('SELECT * FROM production_receipts WHERE order_id=?').get(po.id);
  eq('T2-11a مبلغ رسید', rc.amount_rial, 663527681, 0);
  eq('T2-11b prev_qty', rc.prev_stock_qty, 50, 0);
  eq('T2-11c prev_avg', rc.prev_avg_rial, 2100000, 0);
  eq('T2-11 میانگین FG', rc.new_avg_rial, 2234092, 0);
  const fg = db.prepare('SELECT average_cost_rial, stock FROM products WHERE id=?').get(P.p101);
  eq('T2-11d میانگین در کالا', fg.average_cost_rial, 2234092, 0);
  ok('T2-11e موجودی FG', Math.abs(Number(fg.stock) - 344) < 0.001);

  ok('T2-12 تراز همه اسناد', allJesBalanced());
} catch (e) {
  ok('T2-03..12 رسید طلایی', false, e.stack || e.message);
  console.error(e);
}

// T2-29 close + T2-19 reverse immediately (before other tests mutate stock/ledger)
try {
  const closed = engine.closeOrder(db, po.id, adminId);
  ok('T2-29 بستن سفارش', closed.status === 'closed');
  engine.reopenOrder(db, po.id, adminId);
} catch (e) {
  ok('T2-29 بستن سفارش', false, e.message);
}

try {
  db.prepare(`UPDATE production_orders SET status='completed' WHERE id=?`).run(po.id);
  engine.reverseOrder(db, po.id, adminId, 'تست ابطال');
  const after = snapshotState();
  eq('T2-19c موجودی پارچه', after.stock[P.p201], before.stock[P.p201], 0.01);
  eq('T2-19d موجودی آستر', after.stock[P.p202], before.stock[P.p202], 0.01);
  eq('T2-19e موجودی FG', after.stock[P.p101], before.stock[P.p101], 0.01);
  eq('T2-19f میانگین FG', after.avg[P.p101], before.avg[P.p101], 0);
  eq('T2-19h مانده 1111', after.ledger['1111'], before.ledger['1111'], 5);
  eq('T2-19i مانده 1110', after.ledger['1110'], before.ledger['1110'], 5);
  eq('T2-19j مانده 1104', after.ledger['1104'], before.ledger['1104'], 5);
  ok('T2-19 ابطال کامل', true);
} catch (e) {
  ok('T2-19 ابطال کامل', false, e.message);
}

// T2-13 waste exceeds
throws('T2-13 ضایعات بیش از شروع', () => {
  const po2 = engine.createOrder(db, {
    product_id: P.p101, qty_planned: 10, date: DATE, cost_center_id: cc30,
    warehouse_raw_id: whRaw, warehouse_fg_id: whFg,
  }, adminId);
  engine.releaseOrder(db, po2.id, adminId);
  engine.postReceiptFixed(db, {
    orderId: po2.id,
    body: { date: DATE, qty_produced: 1, waste_normal: 400, labor: LABOR },
    userId: adminId,
  });
}, 'E_WASTE_EXCEEDS_STARTED');

// T2-14 negative stock
throws('T2-14 موجودی منفی', () => {
  db.prepare('UPDATE products SET stock=1 WHERE id=?').run(P.p202);
  if (whRaw) db.prepare('UPDATE warehouse_stock SET qty=1 WHERE product_id=? AND warehouse_id=?').run(P.p202, whRaw);
  const po3 = engine.createOrder(db, {
    product_id: P.p101, qty_planned: 300, date: DATE, cost_center_id: cc30,
    warehouse_raw_id: whRaw, warehouse_fg_id: whFg,
  }, adminId);
  engine.releaseOrder(db, po3.id, adminId);
  try {
    engine.postReceiptFixed(db, {
      orderId: po3.id,
      body: { ...RECEIPT_BODY, scrap: [] },
      userId: adminId,
    });
  } finally {
    db.prepare('UPDATE products SET stock=2000 WHERE id=?').run(P.p202);
    if (whRaw) db.prepare('UPDATE warehouse_stock SET qty=2000 WHERE product_id=? AND warehouse_id=?').run(P.p202, whRaw);
  }
}, 'E_NEGATIVE_STOCK');

// T2-15 zero avg
throws('T2-15 میانگین صفر', () => {
  db.prepare('UPDATE products SET average_cost_rial=0 WHERE id=?').run(P.p203);
  const po4 = engine.createOrder(db, {
    product_id: P.p101, qty_planned: 10, date: DATE, cost_center_id: cc30,
    warehouse_raw_id: whRaw, warehouse_fg_id: whFg,
  }, adminId);
  engine.releaseOrder(db, po4.id, adminId);
  try {
    engine.postReceiptFixed(db, {
      orderId: po4.id,
      body: {
        date: DATE, qty_produced: 10, waste_normal: 0, waste_abnormal: 0,
        labor: LABOR, auto_labor: true,
      },
      userId: adminId,
    });
  } finally {
    db.prepare('UPDATE products SET average_cost_rial=85000 WHERE id=?').run(P.p203);
  }
}, 'E_ZERO_AVG_COST');

// T2-17 period closed
throws('T2-17 دوره بسته', () => {
  try {
    db.prepare(`DELETE FROM production_period_close WHERE period_label='1405/05'`).run();
  } catch { /* ignore */ }
  db.prepare(`
    INSERT INTO production_period_close (period_label, start_date, end_date, status, closed_at)
    VALUES ('1405/05','1405/05/01','1405/05/31','closed', strftime('%s','now'))
  `).run();
  const po5 = engine.createOrder(db, {
    product_id: P.p101, qty_planned: 5, date: '1405/05/01', cost_center_id: cc30,
    warehouse_raw_id: whRaw, warehouse_fg_id: whFg,
  }, adminId);
  engine.releaseOrder(db, po5.id, adminId);
  engine.postReceiptFixed(db, {
    orderId: po5.id,
    body: {
      date: '1405/05/01', qty_produced: 5, labor: LABOR, auto_labor: true,
    },
    userId: adminId,
  });
}, 'E_PERIOD_CLOSED');

// T2-30 fixed no manual qty — need a fresh released order
throws('T2-30 مصرف دستی ممنوع', () => {
  const poX = engine.createOrder(db, {
    product_id: P.p101, qty_planned: 5, date: DATE, cost_center_id: cc30,
    warehouse_raw_id: whRaw, warehouse_fg_id: whFg,
  }, adminId);
  engine.releaseOrder(db, poX.id, adminId);
  engine.postReceiptFixed(db, {
    orderId: poX.id,
    body: { qty_produced: 1, materials: [{ product_id: P.p201, qty: 1 }] },
    userId: adminId,
  });
}, 'E_FIXED_NO_MANUAL_QTY');

// T2-16 bootstrap overhead
try {
  const cc = db.prepare("SELECT id FROM cost_centers WHERE code='CC-40'").get()?.id;
  if (cc) {
    db.prepare('DELETE FROM cost_center_rates WHERE cost_center_id=?').run(cc);
    const po6 = engine.createOrder(db, {
      product_id: P.p101, qty_planned: 5, date: DATE, cost_center_id: cc,
      warehouse_raw_id: whRaw, warehouse_fg_id: whFg,
    }, adminId);
    engine.releaseOrder(db, po6.id, adminId);
    const r = engine.postReceiptFixed(db, {
      orderId: po6.id,
      body: {
        date: DATE, qty_produced: 5, waste_normal: 0, waste_abnormal: 0,
        labor: [{ method: 'piece', rate_rial: 1000 }], auto_labor: true,
      },
      userId: adminId,
    });
    const rate = db.prepare('SELECT is_estimated FROM cost_center_rates WHERE cost_center_id=? ORDER BY id DESC LIMIT 1').get(cc);
    ok('T2-16 Bootstrap سربار', rate && Number(rate.is_estimated) === 1 && r.ok);
  } else {
    ok('T2-16 Bootstrap سربار', true, 'skip — no CC-40');
  }
} catch (e) {
  ok('T2-16 Bootstrap سربار', false, e.message);
}

cleanup();
summary('P2 Fixed');
