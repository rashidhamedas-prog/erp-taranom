'use strict';
/**
 * Overhead application for production orders.
 */
const { allocateNumber } = require('../../db');
const { setting } = require('./costing');

function getOverheadRate(db, ccId, period) {
  if (!ccId) return null;
  let rate = db.prepare(`
    SELECT * FROM cost_center_rates
    WHERE cost_center_id=? AND period_label=? AND status IN ('active','approved','draft','estimated')
    ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END
    LIMIT 1
  `).get(ccId, period);

  if (!rate) {
    rate = db.prepare(`
      SELECT * FROM cost_center_rates
      WHERE cost_center_id=? AND status IN ('active','approved','draft','estimated')
      ORDER BY period_label DESC LIMIT 1
    `).get(ccId);
  }

  if (!rate) {
    return bootstrapRate(db, ccId, period);
  }
  return rate;
}

function bootstrapRate(db, ccId, period) {
  const months = Number(setting(db, 'production_oh_bootstrap_months', '3')) || 3;
  // Best-effort: if no history, return zero estimated rate
  let pool = 0;
  let qty = 0;
  try {
    const exp = db.prepare(`
      SELECT COALESCE(SUM(amount),0) s FROM expense_payments
      WHERE COALESCE(is_overhead,0)=1
    `).get();
    pool = Math.round((Number(exp?.s) || 0) * 10); // toman → rial
  } catch { /* column may not exist */ }
  try {
    const q = db.prepare(`
      SELECT COALESCE(SUM(qty_produced),0) s FROM production_orders
      WHERE cost_center_id=? AND status IN ('completed','closed')
    `).get(ccId);
    qty = Number(q?.s) || 0;
  } catch { /* ignore */ }

  const totalRate = qty > 0 ? Math.round(pool / qty) : 0;
  const info = db.prepare(`
    INSERT INTO cost_center_rates
      (cost_center_id, period_label, driver, total_rate_rial, fixed_rate_rial,
       status, is_estimated, note)
    VALUES (?,?,?,?,?,'estimated',1,?)
  `).run(
    ccId,
    period,
    'output_qty',
    totalRate,
    totalRate,
    `Bootstrap ${months} ماه`
  );
  return db.prepare('SELECT * FROM cost_center_rates WHERE id=?').get(info.lastInsertRowid);
}

function computeDriverQty(db, { driver, po, qtyStarted, laborRial, matRial }) {
  const d = driver || 'output_qty';
  switch (d) {
    case 'output_qty':
      return Number(qtyStarted) || 0;
    case 'direct_labor_rial':
      return (Number(laborRial) || 0) / 1_000_000;
    case 'direct_labor_hours': {
      const r = db.prepare(`
        SELECT COALESCE(SUM(hours),0) h FROM production_labor_entries
        WHERE order_id=? AND status='posted'
      `).get(po.id);
      return Number(r?.h) || 0;
    }
    case 'machine_hours': {
      try {
        const ops = db.prepare(`
          SELECT COALESCE(SUM(machine_minutes),0) m FROM bom_operations WHERE bom_id=?
        `).get(po.bom_id);
        return ((Number(ops?.m) || 0) * (Number(qtyStarted) || 0)) / 60;
      } catch {
        return 0;
      }
    }
    case 'material_rial':
      return (Number(matRial) || 0) / 1_000_000;
    case 'manual':
      return Number(po.manual_driver_qty) || 0;
    default:
      return Number(qtyStarted) || 0;
  }
}

function applyOverhead(db, { po, qtyStarted, laborRial, matRial, date, period, userId, stageId = null }) {
  if (!po.cost_center_id) {
    return { amount_rial: 0, driver: null, driver_qty: 0, rate_rial: 0, is_estimated: 0, id: null };
  }
  const rate = getOverheadRate(db, po.cost_center_id, period);
  if (!rate) {
    return { amount_rial: 0, driver: null, driver_qty: 0, rate_rial: 0, is_estimated: 1, id: null };
  }

  const driver = rate.driver || 'output_qty';
  const driverQty = computeDriverQty(db, { driver, po, qtyStarted, laborRial, matRial });
  const rateRial = Math.round(Number(rate.total_rate_rial) || 0);
  const amount = Math.round(rateRial * driverQty);

  let docNo = '';
  try {
    docNo = allocateNumber(db, 'overhead_apply', 'OH');
  } catch {
    docNo = `OH-${Date.now()}`;
  }

  const id = db.prepare(`
    INSERT INTO production_overhead_applications
      (doc_no, order_id, stage_id, cost_center_id, rate_id, driver, driver_qty,
       fixed_rate_rial, var_rate_rial, rate_rial, amount_rial,
       date, period_label, status, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'posted',?)
  `).run(
    docNo, po.id, stageId, po.cost_center_id, rate.id, driver, driverQty,
    Math.round(Number(rate.fixed_rate_rial) || 0),
    Math.round(Number(rate.var_rate_rial) || 0),
    rateRial, amount, date, period, userId
  ).lastInsertRowid;

  try {
    db.prepare(`
      UPDATE cost_center_rates SET
        applied_oh_rial = COALESCE(applied_oh_rial,0) + ?,
        actual_driver_qty = COALESCE(actual_driver_qty,0) + ?
      WHERE id=?
    `).run(amount, driverQty, rate.id);
  } catch { /* ignore */ }

  return {
    id,
    amount_rial: amount,
    driver,
    driver_qty: driverQty,
    rate_rial: rateRial,
    is_estimated: Number(rate.is_estimated) || 0,
    rate_id: rate.id,
  };
}

module.exports = { getOverheadRate, computeDriverQty, applyOverhead, bootstrapRate };
