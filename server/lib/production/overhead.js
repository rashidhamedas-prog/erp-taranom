'use strict';
/**
 * Overhead application for production orders.
 * Rate lookup + bootstrap + driver qty + apply (NO ledger posting here).
 */
const { allocateNumber } = require('../../db');
const { setting } = require('./costing');

/** Status preference: active/approved before draft/estimated. */
const RATE_STATUS_ORDER = `
  CASE status
    WHEN 'active' THEN 0
    WHEN 'approved' THEN 1
    WHEN 'draft' THEN 2
    WHEN 'estimated' THEN 3
    ELSE 9
  END
`;

/**
 * Subtract N months from a Jalali period label "YYYY/MM".
 * Returns { year, month } or null.
 */
function shiftJalaliPeriod(period, deltaMonths) {
  if (!period || typeof period !== 'string') return null;
  const m = String(period).trim().match(/^(\d{4})\/(\d{1,2})/);
  if (!m) return null;
  let y = Number(m[1]);
  let mo = Number(m[2]);
  if (!y || !mo || mo < 1 || mo > 12) return null;
  let idx = y * 12 + (mo - 1) + deltaMonths;
  if (idx < 0) return null;
  y = Math.floor(idx / 12);
  mo = (idx % 12) + 1;
  return { year: y, month: mo, label: `${y}/${String(mo).padStart(2, '0')}` };
}

function periodStartDate(period) {
  const p = shiftJalaliPeriod(period, 0);
  if (!p) return null;
  return `${p.label}/01`;
}

/**
 * getOverheadRate — prefer active/approved then draft/estimated for period;
 * else latest usable rate; else bootstrap estimated rate for the period.
 */
function getOverheadRate(db, ccId, period) {
  if (!ccId) return null;

  if (period) {
    const forPeriod = db.prepare(`
      SELECT * FROM cost_center_rates
      WHERE cost_center_id=? AND period_label=?
        AND status IN ('active','approved','draft','estimated')
      ORDER BY ${RATE_STATUS_ORDER}
      LIMIT 1
    `).get(ccId, period);
    if (forPeriod) return forPeriod;
  }

  const latest = db.prepare(`
    SELECT * FROM cost_center_rates
    WHERE cost_center_id=?
      AND status IN ('active','approved','draft','estimated')
    ORDER BY period_label DESC, ${RATE_STATUS_ORDER}
    LIMIT 1
  `).get(ccId);
  if (latest) return latest;

  return bootstrapRate(db, ccId, period || '');
}

/**
 * bootstrapRate — average overhead-tagged expenses over N prior months.
 * CRITICAL: expense_payments.amount is toman → ×10 to rial (doc §20 / §02.6).
 */
function bootstrapRate(db, ccId, period, months) {
  const nMonths = Math.max(
    1,
    Number(months != null ? months : setting(db, 'production_oh_bootstrap_months', '3')) || 3
  );

  // Driver from cost center when available
  let driver = 'output_qty';
  try {
    const cc = db.prepare('SELECT driver FROM cost_centers WHERE id=?').get(ccId);
    if (cc?.driver) driver = String(cc.driver);
  } catch { /* ignore */ }

  // Window: [period − N months, month before period]
  // e.g. period 1405/04, N=3 → 1405/01/01 .. < 1405/04/01
  const start = shiftJalaliPeriod(period, -nMonths);
  const periodFrom = start ? `${start.label}/01` : null;
  const periodToExclusive = periodStartDate(period);

  let poolRial = 0;
  let qty = 0;

  try {
    // Prefer CC-scoped + unassigned overhead tags; fall back to all tagged if empty.
    const dateClause = (periodFrom && periodToExclusive)
      ? ' AND date >= ? AND date < ?'
      : '';
    const dateParams = (periodFrom && periodToExclusive)
      ? [periodFrom, periodToExclusive]
      : [];

    const scoped = db.prepare(`
      SELECT COALESCE(SUM(amount),0) s FROM expense_payments
      WHERE COALESCE(is_overhead,0)=1
        AND COALESCE(status,'posted')<>'reversed'
        AND (cost_center_id = ? OR cost_center_id IS NULL)
        ${dateClause}
    `).get(ccId, ...dateParams);
    let poolToman = Number(scoped?.s) || 0;

    if (poolToman <= 0) {
      const all = db.prepare(`
        SELECT COALESCE(SUM(amount),0) s FROM expense_payments
        WHERE COALESCE(is_overhead,0)=1
          AND COALESCE(status,'posted')<>'reversed'
          ${dateClause}
      `).get(...dateParams);
      poolToman = Number(all?.s) || 0;
    }

    // ⚠️ amount is toman → rial
    poolRial = Math.round(poolToman * 10);
  } catch { /* column/table may not exist */ }

  try {
    const dateClause = (periodFrom && periodToExclusive)
      ? ' AND date >= ? AND date < ?'
      : '';
    const dateParams = (periodFrom && periodToExclusive)
      ? [periodFrom, periodToExclusive]
      : [];
    const q = db.prepare(`
      SELECT COALESCE(SUM(qty_produced),0) s FROM production_orders
      WHERE cost_center_id=?
        AND status IN ('completed','closed')
        ${dateClause}
    `).get(ccId, ...dateParams);
    qty = Number(q?.s) || 0;
  } catch { /* ignore */ }

  const totalRate = qty > 0 ? Math.round(poolRial / qty) : 0;
  const note = `Bootstrap ${nMonths} ماه`;

  const existing = db.prepare(`
    SELECT * FROM cost_center_rates
    WHERE cost_center_id=? AND period_label=?
  `).get(ccId, period);

  if (existing) {
    db.prepare(`
      UPDATE cost_center_rates SET
        driver=?,
        total_rate_rial=?,
        fixed_rate_rial=?,
        var_rate_rial=0,
        status='estimated',
        is_estimated=1,
        note=?
      WHERE id=?
    `).run(driver, totalRate, totalRate, note, existing.id);
    return db.prepare('SELECT * FROM cost_center_rates WHERE id=?').get(existing.id);
  }

  const info = db.prepare(`
    INSERT INTO cost_center_rates
      (cost_center_id, period_label, driver, total_rate_rial, fixed_rate_rial,
       var_rate_rial, status, is_estimated, note)
    VALUES (?,?,?,?,?,0,'estimated',1,?)
  `).run(ccId, period, driver, totalRate, totalRate, note);

  return db.prepare('SELECT * FROM cost_center_rates WHERE id=?').get(info.lastInsertRowid);
}

/**
 * computeDriverQty — supports output_qty, direct_labor_rial (/1e6),
 * direct_labor_hours, machine_hours, material_rial (/1e6), manual.
 *
 * machine_hours: prefer ctx.machineMinutes (minutes→/60), else
 * ops[].machine_minutes_per_unit × qty / 60. Do not use a bare
 * machine_minutes column alone.
 */
function computeDriverQty(db, ctx = {}) {
  const {
    driver,
    po,
    qtyStarted,
    laborRial,
    matRial,
    machineMinutes,
    ops,
    laborHours,
    manualDriverQty,
  } = ctx;
  const d = driver || 'output_qty';
  const qty = Number(qtyStarted) || 0;

  switch (d) {
    case 'output_qty':
      return qty;

    case 'direct_labor_rial':
      return (Number(laborRial) || 0) / 1_000_000;

    case 'direct_labor_hours': {
      if (laborHours != null && laborHours !== '') {
        return Number(laborHours) || 0;
      }
      if (po?.id) {
        try {
          const r = db.prepare(`
            SELECT COALESCE(SUM(hours),0) h FROM production_labor_entries
            WHERE order_id=? AND status='posted'
          `).get(po.id);
          const h = Number(r?.h) || 0;
          if (h > 0) return h;
        } catch { /* ignore */ }
      }
      if (Array.isArray(ops) && ops.length) {
        let hours = 0;
        for (const op of ops) {
          hours += (
            ((Number(op.setup_minutes) || 0) + (Number(op.run_minutes_per_unit) || 0) * qty) / 60
          ) * (Number(op.crew_size) || 1);
        }
        return hours;
      }
      return 0;
    }

    case 'machine_hours': {
      if (machineMinutes != null && machineMinutes !== '') {
        return (Number(machineMinutes) || 0) / 60;
      }
      if (Array.isArray(ops) && ops.length) {
        let mins = 0;
        for (const op of ops) {
          mins += (Number(op.machine_minutes_per_unit) || 0) * qty;
        }
        return mins / 60;
      }
      if (po?.bom_id) {
        try {
          const row = db.prepare(`
            SELECT COALESCE(SUM(machine_minutes_per_unit),0) m
            FROM bom_operations WHERE bom_id=?
          `).get(po.bom_id);
          return ((Number(row?.m) || 0) * qty) / 60;
        } catch {
          return 0;
        }
      }
      return 0;
    }

    case 'material_rial':
      return (Number(matRial) || 0) / 1_000_000;

    case 'manual':
      return Number(
        manualDriverQty != null ? manualDriverQty : po?.manual_driver_qty
      ) || 0;

    default:
      return qty;
  }
}

/**
 * applyOverhead — insert production_overhead_applications, update rate applied
 * totals. INTEGER rial. allocateNumber for doc. NO ledger posting.
 */
function applyOverhead(db, {
  po,
  qtyStarted,
  laborRial,
  matRial,
  date,
  period,
  userId,
  stageId = null,
  machineMinutes,
  ops,
  laborHours,
  manualDriverQty,
} = {}) {
  if (!po?.cost_center_id) {
    return { amount_rial: 0, driver: null, driver_qty: 0, rate_rial: 0, is_estimated: 0, id: null };
  }

  const rate = getOverheadRate(db, po.cost_center_id, period);
  if (!rate) {
    return { amount_rial: 0, driver: null, driver_qty: 0, rate_rial: 0, is_estimated: 1, id: null };
  }

  const driver = rate.driver || 'output_qty';
  const driverQty = computeDriverQty(db, {
    driver, po, qtyStarted, laborRial, matRial, machineMinutes, ops, laborHours, manualDriverQty,
  });
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
  } catch { /* ignore older schemas */ }

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

module.exports = {
  getOverheadRate,
  bootstrapRate,
  computeDriverQty,
  applyOverhead,
};
