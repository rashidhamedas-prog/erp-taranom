'use strict';
/**
 * P9 — Production reports tests (docs/Production/06-production-reports.md §14)
 */
const crypto = require('crypto');
const { ok, eq, freshDb, summary } = require('./lib/test-harness');
const reports = require('../lib/production/reports');
const close = require('../lib/production/close');
const bomLib = require('../lib/production/bom');
const { acct } = require('../lib/coa-map');
const { postToLedger } = require('../lib/ledger');
const { stripCostFields } = require('../lib/production/access');
const { hasPermission } = require('../lib/rbac');

console.log('\n══ P9 Production Reports Tests ══\n');

const { db, cleanup } = freshDb();
const adminUser = { id: 1, role: 'admin' };
const salesUser = { id: 2, role: 'field_sales' };
const PERIOD = '1405/04';
const END_DATE = '1405/04/31';

db.prepare('INSERT INTO users (id, username, password, name, role) VALUES (2,?,?,?,?)')
  .run('sales1', 'x', 'ویزیتور', 'field_sales');

function seedJournalEntry({ date, refType, refId, lines, userId = 1 }) {
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

function seedCloseScenario() {
  const c5201 = acct(db, 'coa_labor_control').code;
  const c5202 = acct(db, 'coa_overhead_control').code;
  const c5203 = acct(db, 'coa_overhead_applied').code;
  const c2104 = acct(db, 'coa_payroll_payable').code;

  const cc30 = db.prepare("SELECT id FROM cost_centers WHERE code='CC-30'").get()?.id;
  const whRaw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get()?.id;
  const whFg = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get()?.id;

  const p101 = db.prepare(`
    INSERT INTO products (user_id, name, price, stock, item_type, is_manufactured, average_cost_rial)
    VALUES (1, 'مانتو کتان ترمه — سبز', 0, 344, 'finished', 1, 2233802)
  `).run().lastInsertRowid;

  seedJournalEntry({
    date: END_DATE, refType: 'production_labor_actual', refId: 1,
    lines: [
      { code: c5201, debitRial: 265_000_000, name: '5201' },
      { code: c2104, creditRial: 265_000_000, name: '2104' },
    ],
  });
  seedJournalEntry({
    date: END_DATE, refType: 'production_overhead_actual', refId: 3,
    lines: [
      { code: c5202, debitRial: 51_550_000 },
      { code: c2104, creditRial: 51_550_000 },
    ],
  });

  db.prepare(`
    INSERT INTO production_orders (
      order_no, product_id, analysis_type, qty_planned, date, period_label, status,
      warehouse_raw_id, warehouse_fg_id, cost_center_id,
      overhead_cost_rial, labor_cost_rial, total_cost_rial
    ) VALUES ('PO-TEST-WIP', ?, 'fixed', 10, '1405/04/15', ?, 'in_progress',
      ?, ?, ?, 6332000, 33436439, 40000000)
  `).run(p101, PERIOD, whRaw, whFg, cc30);

  const wipOrderId = db.prepare("SELECT id FROM production_orders WHERE order_no='PO-TEST-WIP'").get()?.id;

  seedJournalEntry({
    date: END_DATE, refType: 'production_labor', refId: wipOrderId,
    lines: [
      { code: acct(db, 'coa_wip').code, debitRial: 264_517_300 },
      { code: c5201, creditRial: 264_517_300 },
    ],
  });
  seedJournalEntry({
    date: END_DATE, refType: 'production_overhead', refId: wipOrderId,
    lines: [
      { code: acct(db, 'coa_wip').code, debitRial: 50_068_838 },
      { code: c5203, creditRial: 50_068_838 },
    ],
  });

  db.prepare(`
    INSERT INTO production_orders (
      order_no, product_id, analysis_type, qty_planned, qty_produced, date, period_label, status,
      warehouse_raw_id, warehouse_fg_id, cost_center_id,
      overhead_cost_rial, labor_cost_rial, total_cost_rial
    ) VALUES ('PO-TEST-FG', ?, 'fixed', 50, 50, '1405/04/20', ?, 'closed',
      ?, ?, ?, 10404000, 54988561, 80000000)
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

  const ccRates = [
    { code: 'CC-10', actual: 5_200_000, applied: 4_658_044 },
    { code: 'CC-20', actual: 17_500_000, applied: 18_463_200 },
    { code: 'CC-30', actual: 21_200_000, applied: 19_386_360 },
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
  return { p101, cc30 };
}

function hasRialKeys(obj) {
  return JSON.stringify(obj).includes('_rial');
}

function tableChecksum(tables) {
  const h = crypto.createHash('sha256');
  for (const t of tables) {
    h.update(t + JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()));
  }
  return h.digest('hex');
}

seedCloseScenario();

// T6-01 report runs
{
  const cat = reports.catalog();
  ok('T6-01 catalog ≥ 20 reports', cat.length >= 20);
  const dash = reports.runReport(db, { name: 'PR-24', params: { period: PERIOD }, user: adminUser });
  ok('T6-01 dashboard runs', !!dash.data?.kpis);
}

// T6-02 WIP reconcile
{
  const wip = reports.runReport(db, { name: 'PR-10', params: { date: END_DATE }, user: adminUser });
  eq('T6-02 WIP diff ≤ 5', Math.abs(wip.totals.diff_rial || 0), 0, 5);
}

// Execute close then monthly profit controls
{
  close.execute(db, { period: PERIOD, method: 'proration', userId: 1, date: END_DATE });
  const mp = reports.runReport(db, { name: 'PR-23', params: { period: PERIOD }, user: adminUser });

  ok('T6-06 labor control zero', mp.data.checks.labor_control_zero === true);
  ok('T6-06 overhead control zero', mp.data.checks.overhead_control_zero === true);
  ok('T6-06 overhead applied zero', mp.data.checks.overhead_applied_zero === true);

  const cogsLedger = close.accountBalance(db, 'coa_cogs', END_DATE);
  const varCogs = (mp.data.variances || []).reduce((s, v) => s + Math.round(Number(v.cogs_rial) || 0), 0);
  if (cogsLedger > 0 && mp.data.cogs.total_rial > 0) {
    eq('T6-05 COGS from report', mp.data.cogs.total_rial, cogsLedger, 5);
  } else {
    const closeCogs = db.prepare('SELECT variance_to_cogs_rial FROM production_period_close WHERE period_label=?').get(PERIOD);
    const allocCogs = Math.round(Number(closeCogs?.variance_to_cogs_rial) || varCogs);
    ok('T6-05 variance COGS alloc > 0', allocCogs > 0);
    eq('T6-05 variance COGS alloc', allocCogs, 1_307_423, 5000);
  }

  const fgLedger = close.accountBalance(db, 'coa_finished_goods', END_DATE);
  ok('T6-04 FG inventory present', typeof mp.data.inventory.fg_close_rial === 'number');

  const grossFromReport = mp.totals.gross_profit_rial;
  const grossCalc = mp.data.sales.net_rial - mp.data.cogs.total_rial;
  eq('T6-03 gross profit reconcile', grossFromReport, grossCalc, 5);
}

// T6-07 overhead variance total
{
  close.reopen(db, { period: PERIOD, reason: 'تست گزارش', userId: 1 });
  const oh = reports.runReport(db, { name: 'PR-14', params: { period: PERIOD }, user: adminUser });
  ok('T6-07 OH variance rows', (oh.data.rows || []).length >= 3);
}

// T6-12 READ-ONLY checksum
{
  const before = tableChecksum(['production_orders', 'journal_entries']);
  reports.runReport(db, { name: 'PR-23', params: { period: PERIOD }, user: adminUser });
  reports.runReport(db, { name: 'PR-10', params: { date: END_DATE }, user: adminUser });
  reports.runReport(db, { name: 'PR-24', params: { period: PERIOD }, user: adminUser });
  const after = tableChecksum(['production_orders', 'journal_entries']);
  ok('T6-12 checksum identical', before === after);
}

// T6-20 strip cost for operator (no production_cost)
{
  const opUser = { id: 3, role: 'production_operator' };
  db.prepare('INSERT OR IGNORE INTO users (id, username, password, name, role) VALUES (?,?,?,?,?)')
    .run(3, 'op1', 'x', 'اپراتور', 'production_operator');
  const r = reports.runReport(db, { name: 'PR-01', params: {}, user: opUser });
  ok('T6-20 operator response no _rial', !hasRialKeys(r));
  const hidden = reports.runReport(db, { name: 'PR-01', params: {}, user: adminUser });
  const stripped = stripCostFields(hidden);
  ok('T6-20 stripCostFields removes _rial', !hasRialKeys(stripped));
}

// Additional coverage
{
  ok('PR-11 variance matrix', reports.runReport(db, { name: 'PR-11', params: { period: PERIOD }, user: adminUser }).report === 'PR-11');
  ok('PR-15 waste empty ok', reports.runReport(db, { name: 'PR-15', params: { period: PERIOD }, user: adminUser }).meta.row_count >= 0);
  ok('PR-99 reconciliation', Array.isArray(reports.runReport(db, { name: 'PR-99', params: { date: END_DATE }, user: adminUser }).data.rows));
  ok('PR-02 needs order', (() => {
    try { reports.runReport(db, { name: 'PR-02', params: {}, user: adminUser }); return false; }
    catch (e) { return String(e.code).includes('E_ORDER'); }
  })());
  eq('PR-14 partial variance sum', reports.overheadVariance(db, { period: PERIOD }).totals.variance_rial, 1_481_162, 500000);
}

// T6 catalog PR-23 / PR-24
{
  const codes = reports.catalog().map(c => c.code);
  ok('T6 catalog PR-23', codes.includes('PR-23'));
  ok('T6 catalog PR-24', codes.includes('PR-24'));
  ok('T6 catalog PR-01..24 complete', Array.from({ length: 24 }, (_, i) =>
    `PR-${String(i + 1).padStart(2, '0')}`).every(c => codes.includes(c)));
}

// T6 empty period — no error, empty meta
{
  const emptyPeriod = '1400/01';
  const waste = reports.runReport(db, { name: 'PR-15', params: { period: emptyPeriod }, user: adminUser });
  ok('T6 empty period PR-15 ok', waste.report === 'PR-15');
  ok('T6 empty period rows=0', (waste.data?.rows || []).length === 0);
  ok('T6 empty period meta.empty', waste.meta?.empty === true || waste.meta?.row_count === 0);

  const dashEmpty = reports.runReport(db, { name: 'PR-24', params: { period: emptyPeriod }, user: adminUser });
  const yld = dashEmpty.data?.kpis?.yield?.value_pct;
  ok('T6 empty yield not NaN', yld === 0 || yld === null || Number.isFinite(yld));
  ok('T6 empty yield no NaN literal', !Number.isNaN(Number(yld)));
}

cleanup();
summary('P9 Production Reports');
