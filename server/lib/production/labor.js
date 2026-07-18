'use strict';
/**
 * Direct labor posting for production.
 */
const { allocateNumber } = require('../../db');

function sumLabor(db, orderId) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(amount_rial),0) s FROM production_labor_entries
    WHERE order_id=? AND status='posted'
  `).get(orderId);
  return Math.round(Number(r?.s) || 0);
}

function postLabor(db, {
  orderId, costCenterId, method = 'piece', qty = 0, hours = 0,
  rateRial = 0, personId = null, date, period, userId, note = '', stageId = null,
  stdRateRial = 0, stdHours = 0,
}) {
  const rate = Math.round(Number(rateRial) || 0);
  let amount = 0;
  if (method === 'hourly' || method === 'hours') {
    amount = Math.round((Number(hours) || 0) * rate);
  } else if (method === 'monthly' || method === 'piece' || method === 'contract') {
    amount = Math.round((Number(qty) || 0) * rate);
  } else {
    amount = Math.round((Number(qty) || Number(hours) || 0) * rate);
  }

  let docNo = '';
  try {
    docNo = allocateNumber(db, 'labor_entry', 'LB');
  } catch {
    docNo = `LB-${Date.now()}`;
  }

  const stdAmt = Math.round((Number(stdHours) || Number(qty) || 0) * (Number(stdRateRial) || rate));
  const id = db.prepare(`
    INSERT INTO production_labor_entries
      (doc_no, order_id, stage_id, cost_center_id, person_id, method,
       qty, hours, std_hours, rate_rial, std_rate_rial, amount_rial, std_amount_rial,
       var_rate_rial, var_eff_rial, date, period_label, status, note, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'posted',?,?)
  `).run(
    docNo, orderId, stageId, costCenterId, personId, method,
    Number(qty) || 0, Number(hours) || 0, Number(stdHours) || 0,
    rate, Math.round(Number(stdRateRial) || 0), amount, stdAmt,
    amount - stdAmt, 0, date, period, note, userId
  ).lastInsertRowid;

  return { id, amount_rial: amount, method, qty, hours, rate_rial: rate };
}

/**
 * Auto-post labor from body.labor rates × qtyStarted, or bom_operations.
 * body.labor = [{ method:'piece', rate_rial:250000 }, { method:'monthly', rate_rial:40000 }]
 */
function autoPostLabor(db, { po, qtyStarted, date, period, userId, laborSpecs = null }) {
  let total = 0;
  const specs = laborSpecs || [];

  if (specs.length) {
    for (const s of specs) {
      const r = postLabor(db, {
        orderId: po.id,
        costCenterId: po.cost_center_id,
        method: s.method || 'piece',
        qty: qtyStarted,
        hours: s.hours || 0,
        rateRial: s.rate_rial || s.rateRial || 0,
        personId: s.person_id || null,
        date, period, userId,
        note: s.note || 'جذب خودکار دستمزد',
      });
      total += r.amount_rial;
    }
    return total;
  }

  // From bom_operations if present
  try {
    const ops = db.prepare(`
      SELECT * FROM bom_operations WHERE bom_id=? ORDER BY seq
    `).all(po.bom_id);
    for (const op of ops) {
      const rate = Math.round(Number(op.labor_rate_rial) || 0);
      if (!rate) continue;
      const r = postLabor(db, {
        orderId: po.id,
        costCenterId: op.cost_center_id || po.cost_center_id,
        method: op.labor_method || 'piece',
        qty: qtyStarted,
        hours: ((Number(op.labor_minutes) || 0) * qtyStarted) / 60,
        rateRial: rate,
        date, period, userId,
        note: `عملیات ${op.name || op.seq}`,
      });
      total += r.amount_rial;
    }
  } catch { /* bom_operations may be empty */ }

  // Fallback: monthly_labor_rate_rial from cost_center_rates for the period
  if (!total && po.cost_center_id) {
    try {
      const rate = db.prepare(`
        SELECT monthly_labor_rate_rial FROM cost_center_rates
        WHERE cost_center_id=? AND period_label=? AND status IN ('active','approved','draft','estimated')
        ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END
        LIMIT 1
      `).get(po.cost_center_id, period)
        || db.prepare(`
          SELECT monthly_labor_rate_rial FROM cost_center_rates
          WHERE cost_center_id=? AND COALESCE(monthly_labor_rate_rial,0)>0
          ORDER BY period_label DESC LIMIT 1
        `).get(po.cost_center_id);
      const ml = Math.round(Number(rate?.monthly_labor_rate_rial) || 0);
      if (ml > 0) {
        const r = postLabor(db, {
          orderId: po.id,
          costCenterId: po.cost_center_id,
          method: 'monthly',
          qty: qtyStarted,
          rateRial: ml,
          date, period, userId,
          note: 'دستمزد از نرخ مرکز هزینه',
        });
        total += r.amount_rial;
      }
    } catch { /* ignore */ }
  }

  return total;
}

module.exports = { sumLabor, postLabor, autoPostLabor };
