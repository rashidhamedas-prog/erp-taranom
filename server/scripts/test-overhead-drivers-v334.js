'use strict';
/**
 * Option-1 overhead drivers: BOM ops wiring, manual_driver_qty, R13 counters.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-jwt-secret-overhead-drivers-v334-dummy-key-32';

const { ok, eq, freshDb, summary } = require('./lib/test-harness');
const oh = require('../lib/production/overhead');

console.log('\n══ Overhead drivers v334 ══\n');

const ops = [{
  setup_minutes: 30,
  run_minutes_per_unit: 6,
  crew_size: 2,
  machine_minutes_per_unit: 3,
}];

eq('hours from ops', oh.computeDriverQty(null, {
  driver: 'direct_labor_hours', qtyStarted: 10, ops,
}), ((30 + 6 * 10) / 60) * 2, 1e-9);

eq('machine from ops', oh.computeDriverQty(null, {
  driver: 'machine_hours', qtyStarted: 10, ops,
}), (3 * 10) / 60, 1e-9);

eq('manual from ctx', oh.computeDriverQty(null, {
  driver: 'manual', qtyStarted: 10, manualDriverQty: 7.5,
}), 7.5, 1e-9);

eq('manual from po', oh.computeDriverQty(null, {
  driver: 'manual', po: { manual_driver_qty: 4 },
}), 4, 1e-9);

eq('output qty', oh.computeDriverQty(null, {
  driver: 'output_qty', qtyStarted: 12,
}), 12, 0);

eq('material /1e6', oh.computeDriverQty(null, {
  driver: 'material_rial', matRial: 5_000_000,
}), 5, 1e-9);

try {
  const { db, cleanup } = freshDb();
  ok('manual_driver_qty column', !!db.prepare(
    "SELECT 1 FROM pragma_table_info('production_orders') WHERE name='manual_driver_qty'"
  ).get());

  const PERIOD = '1405/07';
  const cc = db.prepare("SELECT id FROM cost_centers WHERE code='CC-30' OR is_stage=0 LIMIT 1").get();
  ok('has cost center', !!cc?.id);
  const ccId = cc.id;

  db.prepare(`
    INSERT INTO cost_center_rates
      (cost_center_id, period_label, driver, total_rate_rial, fixed_rate_rial, var_rate_rial,
       absorb_pct, status, applied_oh_rial, actual_driver_qty)
    VALUES (?,?,?,?,?,?,100,'active',0,0)
  `).run(ccId, PERIOD, 'output_qty', 1000, 1000, 0);
  const rateId = db.prepare('SELECT id FROM cost_center_rates WHERE cost_center_id=? AND period_label=?')
    .get(ccId, PERIOD).id;

  let product = db.prepare('SELECT id FROM products LIMIT 1').get();
  if (!product) {
    const info = db.prepare(
      "INSERT INTO products (user_id,name,price,stock) VALUES (1,'تست OH v334',0,0)"
    ).run();
    product = { id: info.lastInsertRowid };
    try { db.prepare('UPDATE products SET is_manufactured=1 WHERE id=?').run(product.id); } catch { /* optional col */ }
  }
  ok('has product', !!product?.id);

  let bomId = null;
  try {
    const bom = db.prepare('SELECT id FROM bom_headers LIMIT 1').get();
    bomId = bom?.id || null;
  } catch { /* ignore */ }

  const poInfo = db.prepare(`
    INSERT INTO production_orders
      (order_no, product_id, bom_id, analysis_type, qty_planned, cost_center_id,
       status, date, period_label, manual_driver_qty)
    VALUES ('PO-V334',?,?, 'fixed', 10, ?, 'released', '1405/07/01', ?, 0)
  `).run(product.id, bomId, ccId, PERIOD);
  const poId = poInfo.lastInsertRowid;
  const po = db.prepare('SELECT * FROM production_orders WHERE id=?').get(poId);

  const applied = oh.applyOverhead(db, {
    po, qtyStarted: 10, laborRial: 0, matRial: 0,
    date: '1405/07/01', period: PERIOD, userId: 1,
  });
  eq('applied amount 1000×10', applied.amount_rial, 10000, 0);
  const after = db.prepare('SELECT applied_oh_rial, actual_driver_qty FROM cost_center_rates WHERE id=?').get(rateId);
  eq('counter applied', after.applied_oh_rial, 10000, 0);
  eq('counter driver qty', after.actual_driver_qty, 10, 0);

  const rows = db.prepare('SELECT * FROM production_overhead_applications WHERE order_id=?').all(poId);
  oh.reverseAppliedOverheadCounters(db, rows);
  const undone = db.prepare('SELECT applied_oh_rial, actual_driver_qty FROM cost_center_rates WHERE id=?').get(rateId);
  eq('R13 counter amount 0', undone.applied_oh_rial, 0, 0);
  eq('R13 counter qty 0', undone.actual_driver_qty, 0, 0);

  db.prepare('UPDATE production_orders SET manual_driver_qty=3 WHERE id=?').run(poId);
  const po2 = db.prepare('SELECT * FROM production_orders WHERE id=?').get(poId);
  db.prepare(`UPDATE cost_center_rates SET driver='manual', applied_oh_rial=0, actual_driver_qty=0 WHERE id=?`).run(rateId);
  const man = oh.applyOverhead(db, {
    po: po2, qtyStarted: 10, laborRial: 0, matRial: 0,
    date: '1405/07/01', period: PERIOD, userId: 1,
  });
  eq('manual driver qty from PO', man.driver_qty, 3, 1e-9);
  eq('manual applied 1000×3', man.amount_rial, 3000, 0);

  if (bomId) {
    try {
      db.prepare(`
        INSERT INTO bom_operations
          (bom_id, seq, operation_name, cost_center_id, setup_minutes, run_minutes_per_unit,
           crew_size, machine_minutes_per_unit, overhead_driver)
        VALUES (?,?, 'دوخت', ?, 0, 12, 1, 6, 'machine_hours')
      `).run(bomId, 10, ccId);
    } catch { /* may already exist / schema variant */ }
    const opsLoaded = oh.loadBomOps(db, bomId);
    ok('loadBomOps', Array.isArray(opsLoaded));
    if (opsLoaded.length) {
      db.prepare(`UPDATE cost_center_rates SET driver='machine_hours', total_rate_rial=6000, applied_oh_rial=0, actual_driver_qty=0 WHERE id=?`).run(rateId);
      const po3 = db.prepare('SELECT * FROM production_orders WHERE id=?').get(poId);
      const mh = oh.applyOverhead(db, {
        po: po3, qtyStarted: 10, laborRial: 0, matRial: 0,
        date: '1405/07/01', period: PERIOD, userId: 1,
      });
      const expectQty = opsLoaded.reduce((s, o) => s + (Number(o.machine_minutes_per_unit) || 0) * 10, 0) / 60;
      eq('machine hours via BOM ops', mh.driver_qty, expectQty, 1e-6);
    }
  }

  cleanup();
} catch (e) {
  if (/bindings|better-sqlite3/i.test(String(e.message || e))) {
    ok('sqlite ABI skip (Node24 host) — run on Iran', true);
  } else {
    console.error('DB suite failed:', e);
    ok('db suite', false, e.stack || e.message);
  }
}

summary();
