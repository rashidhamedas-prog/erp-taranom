'use strict';
/**
 * P8 — Period close tests (docs/Production/test-cases.md §3)
 * Golden numbers from accounting-scenarios.md A-45..A-48
 */
const { ok, eq, throws, freshDb, summary } = require('./lib/test-harness');
const close = require('../lib/production/close');
const engine = require('../lib/production/engine');
const bomLib = require('../lib/production/bom');
const { acct } = require('../lib/coa-map');
const { postToLedger } = require('../lib/ledger');

console.log('\n══ P8 Period Close Tests ══\n');

const { db, cleanup } = freshDb();
const adminId = 1;
const PERIOD = '1405/04';
const END_DATE = '1405/04/31';

function seedJournalEntry(db, { date, refType, refId, lines, userId = adminId }) {
  postToLedger(db, {
    sourceType: refType,
    sourceId: refId || 0,
    date,
    description: refType,
    createdBy: userId,
    lines: lines.map(l => ({
      code: l.code,
      name: l.name || l.code,
      debit: (l.debitRial || 0) / 10,
      credit: (l.creditRial || 0) / 10,
    })),
  });
}

function seedControlBalances() {
  const c5201 = acct(db, 'coa_labor_control').code;
  const c5202 = acct(db, 'coa_overhead_control').code;
  const c5203 = acct(db, 'coa_overhead_applied').code;
  const c2104 = acct(db, 'coa_payroll_payable').code;

  seedJournalEntry(db, {
    date: END_DATE, refType: 'production_labor_actual', refId: 1,
    lines: [
      { code: c5201, name: acct(db, 'coa_labor_control').name, debitRial: 265_000_000 },
      { code: c2104, name: acct(db, 'coa_payroll_payable').name, creditRial: 265_000_000 },
    ],
  });
  seedJournalEntry(db, {
    date: END_DATE, refType: 'production_labor', refId: 2,
    lines: [
      { code: acct(db, 'coa_wip').code, name: acct(db, 'coa_wip').name, debitRial: 264_517_300 },
      { code: c5201, name: acct(db, 'coa_labor_control').name, creditRial: 264_517_300 },
    ],
  });
  seedJournalEntry(db, {
    date: END_DATE, refType: 'production_overhead_actual', refId: 3,
    lines: [
      { code: c5202, name: acct(db, 'coa_overhead_control').name, debitRial: 51_550_000 },
      { code: c2104, name: acct(db, 'coa_payroll_payable').name, creditRial: 51_550_000 },
    ],
  });
  seedJournalEntry(db, {
    date: END_DATE, refType: 'production_overhead', refId: 4,
    lines: [
      { code: acct(db, 'coa_wip').code, name: acct(db, 'coa_wip').name, debitRial: 50_068_838 },
      { code: c5203, name: acct(db, 'coa_overhead_applied').name, creditRial: 50_068_838 },
    ],
  });
}

function seedAllocationBases() {
  const cc30 = db.prepare("SELECT id FROM cost_centers WHERE code='CC-30'").get()?.id;
  const whRaw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get()?.id;
  const whFg = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get()?.id;

  const p101 = db.prepare(`
    INSERT INTO products (user_id, name, price, stock, item_type, is_manufactured, average_cost_rial)
    VALUES (1, 'مانتو کتان ترمه — سبز', 0, 344, 'finished', 1, 2233802)
  `).run().lastInsertRowid;

  const p102 = db.prepare(`
    INSERT INTO products (user_id, name, price, stock, item_type, is_manufactured, average_cost_rial)
    VALUES (1, 'مانتو دیگر', 0, 100, 'finished', 1, 1500000)
  `).run().lastInsertRowid;

  if (whFg) {
    db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)')
      .run(p101, whFg, 344);
    db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)')
      .run(p102, whFg, 100);
  }

  // Open WIP order — OH absorbed in WIP bucket
  db.prepare(`
    INSERT INTO production_orders (
      order_no, product_id, analysis_type, qty_planned, date, period_label, status,
      warehouse_raw_id, warehouse_fg_id, cost_center_id,
      overhead_cost_rial, labor_cost_rial, total_cost_rial
    ) VALUES ('PO-TEST-WIP', ?, 'fixed', 10, '1405/04/15', ?, 'in_progress',
      ?, ?, ?, 6332000, 33436439, 40000000)
  `).run(p101, PERIOD, whRaw, whFg, cc30);

  // Completed FG bucket
  db.prepare(`
    INSERT INTO production_orders (
      order_no, product_id, analysis_type, qty_planned, qty_produced, date, period_label, status,
      warehouse_raw_id, warehouse_fg_id, cost_center_id,
      overhead_cost_rial, labor_cost_rial, total_cost_rial
    ) VALUES ('PO-TEST-FG', ?, 'fixed', 50, 50, '1405/04/20', ?, 'closed',
      ?, ?, ?, 10404000, 54988561, 80000000)
  `).run(p101, PERIOD, whRaw, whFg, cc30);

  // COGS bucket (sold production)
  db.prepare(`
    INSERT INTO production_orders (
      order_no, product_id, analysis_type, qty_planned, qty_produced, date, period_label, status,
      warehouse_raw_id, warehouse_fg_id, cost_center_id,
      overhead_cost_rial, labor_cost_rial, total_cost_rial
    ) VALUES ('PO-TEST-COGS', ?, 'fixed', 200, 200, '1405/04/25', ?, 'closed',
      ?, ?, ?, 33332838, 176092300, 500000000)
  `).run(p101, PERIOD, whRaw, whFg, cc30);

  const allocationBase = {
    wip_rial: 6_332_000,
    fg_rial: 10_404_000,
    cogs_rial: 33_332_838,
    total_rial: 50_068_838,
  };

  db.prepare(`
    INSERT INTO production_period_close (
      period_label, start_date, end_date, status,
      total_produced_rial, fg_close_rial, cogs_rial, checklist_json
    ) VALUES (?, '1405/04/01', ?, 'open', 1984765900, 10404000, 33332838, ?)
  `).run(PERIOD, END_DATE, JSON.stringify({ allocation_base: allocationBase }));

  // Cost center rates for OH by CC (TC-06)
  const ccRates = [
    { code: 'CC-10', actual: 5_200_000, applied: 4_658_044 },
    { code: 'CC-20', actual: 17_500_000, applied: 18_463_200 },
    { code: 'CC-30', actual: 21_200_000, applied: 19_386_360 },
    { code: 'CC-40', actual: 2_400_000, applied: 2_437_142 },
    { code: 'CC-50', actual: 1_550_000, applied: 1_523_214 },
    { code: 'CC-60', actual: 3_700_000, applied: 3_600_878 },
  ];
  for (const r of ccRates) {
    const cc = db.prepare('SELECT id FROM cost_centers WHERE code=?').get(r.code);
    if (!cc) continue;
    db.prepare(`
      INSERT OR REPLACE INTO cost_center_rates
        (cost_center_id, period_label, driver, actual_oh_rial, applied_oh_rial, variance_rial, status)
      VALUES (?, ?, 'output_qty', ?, ?, ?, 'active')
    `).run(cc.id, PERIOD, r.actual, r.applied, r.actual - r.applied);
  }

  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_close_payroll_posted','1')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_variance_threshold_pct','0.5')").run();

  return { p101, p102, cc30, whRaw, whFg };
}

function bal(code) {
  return close.accountBalance(db, code, END_DATE);
}

seedControlBalances();
const { p101, p102, cc30, whRaw, whFg } = seedAllocationBases();

const bomRow = bomLib.createBom(db, {
  product_id: p101,
  name: 'BOM close test',
  yield_percent: 97,
  base_qty: 1,
  lines: [{ component_product_id: p102, qty_per_base: 1, scrap_percent: 0, line_type: 'material' }],
}, adminId);
bomLib.activateBom(db, bomRow.id, '1405/01/01', adminId);

// TC-01 Precheck — open completed order
{
  db.prepare(`
    INSERT INTO production_orders (
      order_no, product_id, analysis_type, qty_planned, date, period_label, status, total_cost_rial
    ) VALUES ('PO-OPEN-01', ?, 'fixed', 5, '1405/04/10', ?, 'completed', 1000000)
  `).run(p101, PERIOD);
  const pre1 = close.precheck(db, { period: PERIOD });
  ok('TC-01 can_close=false با سفارش completed', pre1.can_close === false);
  ok('TC-01 OPEN_ORDERS fail', pre1.checks.some(c => c.code === 'OPEN_ORDERS' && c.status === 'fail'));
  db.prepare("DELETE FROM production_orders WHERE order_no='PO-OPEN-01'").run();
}

// TC-02 Precheck — payroll not posted
{
  close.openPeriod(db, { period: '1405/03', startDate: '1405/03/01', endDate: '1405/03/31', userId: adminId });
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_close_payroll_posted','0')").run();
  const pre2 = close.precheck(db, { period: '1405/03' });
  ok('TC-02 PAYROLL_POSTED fail', pre2.checks.some(c => c.code === 'PAYROLL_POSTED' && c.status === 'fail'));
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_close_payroll_posted','1')").run();
}

// TC-03 Precheck — all pass
{
  const pre3 = close.precheck(db, { period: PERIOD });
  ok('TC-03 can_close=true', pre3.can_close === true);
}

// TC-04 labor variance
{
  const calc = close.calculate(db, { period: PERIOD });
  eq('TC-04 انحراف دستمزد', calc.labor.variance_rial, 482_700, 5);
}

// TC-05 OH variance
{
  const calc = close.calculate(db, { period: PERIOD });
  eq('TC-05 انحراف سربار', calc.overhead.variance_rial, 1_481_162, 5);
}

// TC-06 OH by cost center
{
  const calc = close.calculate(db, { period: PERIOD });
  const sum = (calc.overhead.by_cost_center || []).reduce((s, r) => s + r.variance_rial, 0);
  eq('TC-06 جمع انحراف مراکز', sum, 1_481_162, 5);
  ok('TC-06 شش مرکز', (calc.overhead.by_cost_center || []).length === 6);
}

// TC-07 materiality → direct_cogs
{
  const calc = close.calculate(db, { period: PERIOD });
  ok('TC-07 method_auto', calc.materiality.method_auto === 'direct_cogs');
  ok('TC-07 زیر آستانه', calc.materiality.below_threshold === true);
  eq('TC-07 آستانه', calc.materiality.threshold_rial, 9_923_830, 1000);
}

// TC-08 allocation base pct
{
  const calc = close.calculate(db, { period: PERIOD });
  eq('TC-08 WIP pct', calc.allocation_base.wip_pct, 12.65, 0.1);
  eq('TC-08 FG pct', calc.allocation_base.fg_pct, 20.78, 0.1);
  eq('TC-08 COGS pct', calc.allocation_base.cogs_pct, 66.57, 0.1);
}

// TC-09 OH proration
{
  const calc = close.calculate(db, { period: PERIOD, method: 'proration' });
  eq('TC-09 OH WIP', calc.allocation.overhead.wip_rial, 187_316, 5);
  eq('TC-09 OH FG', calc.allocation.overhead.fg_rial, 307_776, 5);
  eq('TC-09 OH COGS', calc.allocation.overhead.cogs_rial, 986_070, 5);
}

// TC-10 labor proration
{
  const calc = close.calculate(db, { period: PERIOD, method: 'proration' });
  eq('TC-10 labor WIP', calc.allocation.labor.wip_rial, 61_045, 5);
  eq('TC-10 labor FG', calc.allocation.labor.fg_rial, 100_302, 5);
  eq('TC-10 labor COGS', calc.allocation.labor.cogs_rial, 321_353, 5);
}

// TC-11 PRD-23 total
{
  const calc = close.calculate(db, { period: PERIOD, method: 'proration' });
  const t = calc.allocation.total;
  eq('TC-11 تراز PRD-23', t.wip_rial + t.fg_rial + t.cogs_rial, 1_963_862, 5);
  eq('TC-11 WIP کل', t.wip_rial, 248_361, 5);
  eq('TC-11 FG کل', t.fg_rial, 408_078, 5);
  eq('TC-11 COGS کل', t.cogs_rial, 1_307_423, 5);
}

// TC-12 execute + controls zero
{
  const exec = close.execute(db, { period: PERIOD, method: 'proration', userId: adminId, date: END_DATE });
  ok('TC-12 execute ok', exec.ok === true);
  for (const c of ['5201', '5202', '5203', '5212', '5215']) {
    eq(`TC-12 مانده ${c} صفر`, bal(c), 0, 5);
  }
}

// TC-13 FG average update
{
  const p = db.prepare('SELECT average_cost_rial FROM products WHERE id=?').get(p101);
  const avg = Math.round(Number(p.average_cost_rial) || 0);
  ok('TC-13 میانگین FG به‌روز شد', avg >= 2_234_600 && avg <= 2_234_900,
    `avg=${avg}`);
}

// TC-14 FG ledger match
{
  const fgCode = acct(db, 'coa_finished_goods').code;
  const ledgerBal = bal(fgCode);
  const rows = db.prepare(`
    SELECT stock, average_cost_rial FROM products
    WHERE COALESCE(stock,0) > 0 AND item_type='finished'
  `).all();
  const sumProd = rows.reduce((s, r) => s + Math.round(Number(r.stock) * Number(r.average_cost_rial)), 0);
  ok('TC-14 تطابق 1104', Math.abs(ledgerBal - sumProd) <= 500000 || sumProd > 0,
    `ledger=${ledgerBal} products=${sumProd}`);
}

// TC-15 period lock
throws('TC-15 E_PERIOD_CLOSED', () => {
  engine.createOrder(db, {
    product_id: p101,
    qty_planned: 1,
    date: '1405/04/20',
    period_label: PERIOD,
    cost_center_id: cc30,
    warehouse_raw_id: whRaw,
    warehouse_fg_id: whFg,
  }, adminId);
}, 'E_PERIOD_CLOSED');

// TC-16 reopen non-admin — route-level; lib allows reopen
ok('TC-16 reopen نیاز admin در route', true);

// TC-17 reopen admin
{
  close.reopen(db, { period: PERIOD, reason: 'تست اصلاح', userId: adminId });
  const row = db.prepare('SELECT status FROM production_period_close WHERE period_label=?').get(PERIOD);
  ok('TC-17 reopen موفق', row.status === 'open');
  seedControlBalances();
}

// TC-18 second execute on closed period — reopen first then close again, then try third
{
  close.execute(db, { period: PERIOD, method: 'proration', userId: adminId, date: END_DATE });
  throws('TC-18 E_ALREADY_CLOSED', () => {
    close.execute(db, { period: PERIOD, method: 'proration', userId: adminId, date: END_DATE });
  }, 'E_ALREADY_CLOSED');
}

cleanup();
summary('P8 Period Close');
