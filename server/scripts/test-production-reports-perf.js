'use strict';
/** Smoke perf tests for production reports on seeded data */
const { ok, freshDb, summary } = require('./lib/test-harness');
const reports = require('../lib/production/reports');

console.log('\n══ Production Reports Perf ══\n');

const { db, cleanup } = freshDb();
const adminUser = { id: 1, role: 'admin' };
const PERIOD = '1405/04';
const SEED_N = 2000;

const productId = db.prepare(`
  INSERT INTO products (user_id, name, price, stock, item_type, is_manufactured, average_cost_rial)
  VALUES (1, 'Perf Seed Product', 0, 0, 'finished', 1, 2000000)
`).run().lastInsertRowid;

const insOrder = db.prepare(`
  INSERT INTO production_orders (
    order_no, product_id, analysis_type, qty_planned, qty_produced,
    qty_waste_normal, qty_waste_abnormal, date, period_label, status,
    material_cost_rial, labor_cost_rial, overhead_cost_rial, packaging_cost_rial,
    total_cost_rial, unit_cost_rial
  ) VALUES (?, ?, 'fixed', 100, 98, 1, 1, '1405/04/15', ?, 'completed',
    300000000, 200000000, 150000000, 10000000, 660000000, 6734694)
`);

const tx = db.transaction(() => {
  for (let i = 0; i < SEED_N; i++) {
    insOrder.run(`PO-PERF-${String(i).padStart(5, '0')}`, productId, PERIOD);
  }
});
tx();

ok(`seeded ${SEED_N} production_orders`, db.prepare('SELECT COUNT(*) c FROM production_orders').get().c >= SEED_N);

function timed(name, fn, limitMs) {
  const t0 = Date.now();
  const result = fn();
  const ms = Date.now() - t0;
  ok(`${name} < ${limitMs}ms (${ms}ms)`, ms < limitMs, `took ${ms}ms`);
  return { result, ms };
}

timed('dashboard PR-24', () => reports.runReport(db, {
  name: 'PR-24',
  params: { period: PERIOD },
  user: adminUser,
}), 2000);

timed('monthly-profit PR-23', () => reports.runReport(db, {
  name: 'PR-23',
  params: { period: PERIOD },
  user: adminUser,
}), 1500);

timed('wip PR-10', () => reports.runReport(db, {
  name: 'PR-10',
  params: {},
  user: adminUser,
}), 1000);

cleanup();
summary('Production Reports Perf');
