'use strict';
/**
 * Overhead application for production orders.
 * Rate lookup + bootstrap + driver qty + apply (NO ledger posting here).
 */
const { allocateNumber } = require('../../db');
const { setting } = require('./costing');

const OH_DRIVERS = Object.freeze([
  'output_qty',
  'direct_labor_rial',
  'direct_labor_hours',
  'machine_hours',
  'material_rial',
  'manual',
]);
const OH_DRIVER_ALIASES = Object.freeze({
  labor_rial: 'direct_labor_rial',
  labor_hours: 'direct_labor_hours',
  hours: 'direct_labor_hours',
  qty: 'output_qty',
  output: 'output_qty',
});

function rateErr(code, status, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

function roundRial(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v);
}

function normalizeDriver(d) {
  const raw = String(d == null ? 'output_qty' : d).trim() || 'output_qty';
  const mapped = OH_DRIVER_ALIASES[raw] || raw;
  if (!OH_DRIVERS.includes(mapped)) {
    throw rateErr('E_BAD_DRIVER', 400, 'محرک سربار نامعتبر است');
  }
  return mapped;
}

function coerceDriver(d) {
  try {
    return normalizeDriver(d);
  } catch {
    return 'output_qty';
  }
}

function validatePeriodLabel(period) {
  const s = String(period || '').trim();
  const m = s.match(/^(\d{4})\/(\d{1,2})$/);
  if (!m) throw rateErr('E_PERIOD_FORMAT', 400, 'دوره باید به صورت ۱۴۰۵/۰۷ باشد');
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw rateErr('E_PERIOD_FORMAT', 400, 'ماه دوره نامعتبر است');
  return `${m[1]}/${String(month).padStart(2, '0')}`;
}

/**
 * Predetermined OAR (IAS 2 / absorption):
 *   fixed_rate = budget_fixed ÷ normal/budgeted driver qty
 *   var_rate   = budget_variable ÷ budgeted driver qty
 *   total_rate = fixed_rate + var_rate
 * Applied OH later = total_rate × actual driver qty.
 * Direct-rate entry: if only total is given, treat it as a single combined rate.
 */
function computePredeterminedRates(input = {}) {
  const budgetFixed = roundRial(input.budget_fixed_oh_rial);
  const budgetVar = roundRial(input.budget_var_oh_rial);
  const budgetQtyRaw = Number(input.budget_driver_qty);
  const budgetQty = Number.isFinite(budgetQtyRaw) ? budgetQtyRaw : 0;
  let fixed = roundRial(input.fixed_rate_rial);
  let variable = roundRial(input.var_rate_rial);
  let total = roundRial(input.total_rate_rial);
  const monthlyLabor = roundRial(input.monthly_labor_rate_rial);

  if (budgetFixed < 0 || budgetVar < 0 || budgetQty < 0 || fixed < 0 || variable < 0 || total < 0 || monthlyLabor < 0) {
    throw rateErr('E_NEGATIVE_RATE', 400, 'مبالغ و مقدار محرک نمی‌تواند منفی باشد');
  }

  const fromBudget = budgetQty > 0 && (budgetFixed > 0 || budgetVar > 0);
  if (fromBudget) {
    fixed = Math.round(budgetFixed / budgetQty);
    variable = Math.round(budgetVar / budgetQty);
    total = fixed + variable;
  } else {
    if (total <= 0 && (fixed > 0 || variable > 0)) total = fixed + variable;
    if (fixed <= 0 && variable <= 0 && total > 0) fixed = total;
    else if (fixed > 0 || variable > 0) total = fixed + variable;
  }

  return {
    budget_fixed_oh_rial: budgetFixed,
    budget_var_oh_rial: budgetVar,
    budget_driver_qty: budgetQty,
    fixed_rate_rial: fixed,
    var_rate_rial: variable,
    total_rate_rial: total,
    monthly_labor_rate_rial: monthlyLabor,
    from_budget: fromBudget,
  };
}

function looksLikePoolNotRate(driver, totalRate) {
  const d = coerceDriver(driver);
  const t = roundRial(totalRate);
  if (t < 20_000_000) return false;
  return d === 'direct_labor_rial' || d === 'material_rial' || d === 'output_qty';
}

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
    if (forPeriod) {
      forPeriod.driver = coerceDriver(forPeriod.driver);
      return forPeriod;
    }
  }

  const latest = db.prepare(`
    SELECT * FROM cost_center_rates
    WHERE cost_center_id=?
      AND status IN ('active','approved','draft','estimated')
    ORDER BY period_label DESC, ${RATE_STATUS_ORDER}
    LIMIT 1
  `).get(ccId);
  if (latest) {
    latest.driver = coerceDriver(latest.driver);
    return latest;
  }

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
    if (cc?.driver) driver = coerceDriver(cc.driver);
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
  const d = coerceDriver(driver);
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

  const driver = coerceDriver(rate.driver);
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
  normalizeDriver,
  coerceDriver,
  validatePeriodLabel,
  computePredeterminedRates,
  looksLikePoolNotRate,
  OH_DRIVERS,
};
