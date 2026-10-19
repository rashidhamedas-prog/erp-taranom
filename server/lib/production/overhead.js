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
 * Direct-entry reconcile.
 * rate_touch=total → نرخ کل (ستونی که جدول نشان می‌دهد) منبع است.
 * rate_touch=parts → ثابت+متغیر منبع است.
 * بدون touch: اگر فقط ثابت پر باشد و با نرخ کل فرق کند، نرخ کل می‌ماند
 * (ذخیرهٔ قبلی ثابت را برابر کل کپی می‌کرد و ویرایش کل را دور می‌ریخت).
 */
function reconcileDirectRates(fixed, variable, total, touch) {
  const f = fixed > 0 ? fixed : 0;
  const v = variable > 0 ? variable : 0;
  const t = total > 0 ? total : 0;
  const sum = f + v;
  if (touch === 'parts') return { fixed: f, variable: v, total: sum };
  if (touch === 'total') {
    if (v > 0 && f > 0 && sum > 0 && t > 0) {
      const nf = Math.round(f * (t / sum));
      return { fixed: nf, variable: t - nf, total: t };
    }
    if (v > 0 && f <= 0) return { fixed: 0, variable: t, total: t };
    return { fixed: t, variable: 0, total: t };
  }
  if (t > 0 && v <= 0 && f > 0 && t !== f) return { fixed: t, variable: 0, total: t };
  if (t <= 0 && sum > 0) return { fixed: f, variable: v, total: sum };
  if (f <= 0 && v <= 0 && t > 0) return { fixed: t, variable: 0, total: t };
  if (sum > 0 && t > 0 && sum !== t) return { fixed: f, variable: v, total: sum };
  return { fixed: f, variable: v, total: t > 0 ? t : sum };
}

/**
 * Predetermined OAR (IAS 2 / absorption):
 *   fixed_rate = budget_fixed ÷ normal/budgeted driver qty
 *   var_rate   = budget_variable ÷ budgeted driver qty
 *   total_rate = fixed_rate + var_rate
 * Applied OH later = total_rate × actual driver qty.
 * Direct-rate entry: if only total is given, treat it as a single combined rate.
 * A stored total that differs from the budget-derived rate is a manual override
 * and must survive the next read (enrich) and the next save.
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
  const touch = String(input.rate_touch || '');

  if (budgetFixed < 0 || budgetVar < 0 || budgetQty < 0 || fixed < 0 || variable < 0 || total < 0 || monthlyLabor < 0) {
    throw rateErr('E_NEGATIVE_RATE', 400, 'مبالغ و مقدار محرک نمی‌تواند منفی باشد');
  }

  const fromBudget = budgetQty > 0 && (budgetFixed > 0 || budgetVar > 0);
  let usedBudget = false;
  if (fromBudget && touch !== 'total' && touch !== 'parts') {
    const dFixed = Math.round(budgetFixed / budgetQty);
    const dVar = Math.round(budgetVar / budgetQty);
    const dTotal = dFixed + dVar;
    const manual = touch !== 'budget' && total > 0 && total !== dTotal;
    if (!manual) {
      fixed = dFixed;
      variable = dVar;
      total = dTotal;
      usedBudget = true;
    } else {
      const kept = reconcileDirectRates(fixed, variable, total, 'total');
      fixed = kept.fixed;
      variable = kept.variable;
      total = kept.total;
    }
  } else {
    const kept = reconcileDirectRates(fixed, variable, total, touch);
    fixed = kept.fixed;
    variable = kept.variable;
    total = kept.total;
  }

  return {
    budget_fixed_oh_rial: budgetFixed,
    budget_var_oh_rial: budgetVar,
    budget_driver_qty: budgetQty,
    fixed_rate_rial: fixed,
    var_rate_rial: variable,
    total_rate_rial: total,
    monthly_labor_rate_rial: monthlyLabor,
    absorb_pct: bodyAbsorbPct(input),
    from_budget: usedBudget,
  };
}

function bodyAbsorbPct(input) {
  if (input.absorb_pct == null || input.absorb_pct === '') return 100;
  return clampAbsorbPct(input.absorb_pct);
}

function looksLikePoolNotRate(driver, totalRate) {
  const d = coerceDriver(driver);
  const t = roundRial(totalRate);
  if (t < 20_000_000) return false;
  return d === 'direct_labor_rial' || d === 'material_rial' || d === 'output_qty';
}

function clampAbsorbPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 100;
  if (n < 0 || n > 100) {
    throw rateErr('E_ABSORB_PCT', 400, 'درصد جذب باید بین ۰ و ۱۰۰ باشد');
  }
  return Math.round(n * 100) / 100;
}

function absorbMultiplier(rate) {
  const raw = rate && rate.absorb_pct != null ? Number(rate.absorb_pct) : 100;
  if (!Number.isFinite(raw)) return 1;
  return Math.min(100, Math.max(0, raw)) / 100;
}

/** مراکز سراسری تولید (کارگاه). دفتر توزیع / اداری / فروش داخل بها نمی‌آیند. */
function listPlantCostCenters(db) {
  return db.prepare(`
    SELECT * FROM cost_centers
    WHERE COALESCE(active,1)=1 AND entity='workshop'
    ORDER BY COALESCE(seq,0), id
  `).all();
}

function appliedOverheadRial(rate, driverQty) {
  const rateRial = roundRial(rate && rate.total_rate_rial);
  const qty = Number(driverQty) || 0;
  return Math.round(rateRial * qty * absorbMultiplier(rate));
}

function appliedMonthlyLaborRial(rate, qty) {
  const unit = roundRial(rate && rate.monthly_labor_rate_rial);
  const q = Number(qty) || 0;
  return Math.round(unit * q * absorbMultiplier(rate));
}

/**
 * New cutting room with only a monthly wage: IAS 2 uses intended/normal
 * capacity (PwC FAQ 25.21.1), not actual ramp-up. Default 22×8h×80% and
 * Taranom routing 1.2 min/unit + 30 min setup/day.
 */
function estimateCuttingCapacity(input = {}) {
  const wage = roundRial(input.wage_rial);
  const days = Math.max(1, Number(input.days) || 22);
  const hoursPerDay = Math.max(0.5, Number(input.hours_per_day) || 8);
  const efficiencyPct = Math.min(100, Math.max(1, Number(input.efficiency_pct) || 80));
  const run = Number(input.minutes_per_unit) > 0 ? Number(input.minutes_per_unit) : 1.2;
  const setup = Math.max(0, Number(input.setup_minutes_per_day) || 30);
  const availableHours = days * hoursPerDay * (efficiencyPct / 100);
  const productiveMinutes = Math.max(0, availableHours * 60 - setup * days);
  const qty = run > 0 ? productiveMinutes / run : 0;
  return {
    available_hours: Math.round(availableHours * 100) / 100,
    normal_qty: Math.round(qty * 100) / 100,
    monthly_labor_rate_rial: qty > 0 ? Math.round(wage / qty) : 0,
    hour_rate_rial: availableHours > 0 ? Math.round(wage / availableHours) : 0,
    wage_rial: wage,
    days,
    hours_per_day: hoursPerDay,
    efficiency_pct: efficiencyPct,
    minutes_per_unit: run,
  };
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
/** Derive total/fixed/var from budget when total_rate_rial was left 0 in the rate form. */
function enrichOverheadRate(row) {
  if (!row) return null;
  let computed;
  try {
    computed = computePredeterminedRates(row);
  } catch {
    computed = null;
  }
  const out = { ...row };
  out.driver = coerceDriver(row.driver);
  if (computed) {
    out.fixed_rate_rial = computed.fixed_rate_rial;
    out.var_rate_rial = computed.var_rate_rial;
    out.total_rate_rial = computed.total_rate_rial;
    out.from_budget = !!computed.from_budget;
    if (row.absorb_pct == null || row.absorb_pct === '') out.absorb_pct = 100;
    else {
      try { out.absorb_pct = clampAbsorbPct(row.absorb_pct); } catch { out.absorb_pct = 100; }
    }
  } else if (out.absorb_pct == null || out.absorb_pct === '') {
    out.absorb_pct = 100;
  }
  return out;
}

function getOverheadRate(db, ccId, period) {
  if (!ccId) return null;

  let periodNorm = '';
  if (period) {
    try { periodNorm = validatePeriodLabel(period); } catch { periodNorm = String(period).trim(); }
  }

  if (periodNorm) {
    const forPeriod = db.prepare(`
      SELECT * FROM cost_center_rates
      WHERE cost_center_id=? AND period_label=?
        AND status IN ('active','approved','draft','estimated')
      ORDER BY ${RATE_STATUS_ORDER}
      LIMIT 1
    `).get(ccId, periodNorm);
    if (forPeriod) return enrichOverheadRate(forPeriod);
  }

  const latest = db.prepare(`
    SELECT * FROM cost_center_rates
    WHERE cost_center_id=?
      AND status IN ('active','approved','draft','estimated')
    ORDER BY period_label DESC, ${RATE_STATUS_ORDER}
    LIMIT 1
  `).get(ccId);
  if (latest) return enrichOverheadRate(latest);

  return enrichOverheadRate(bootstrapRate(db, ccId, periodNorm || period || ''));
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
function loadBomOps(db, bomId) {
  if (!db || !bomId) return [];
  try {
    return db.prepare('SELECT * FROM bom_operations WHERE bom_id=? ORDER BY seq').all(bomId);
  } catch {
    return [];
  }
}

/** Build applyOverhead ctx: BOM ops + optional receipt overrides + PO manual qty. */
function buildApplyCtx(db, po, extras = {}) {
  const ops = Array.isArray(extras.ops) && extras.ops.length
    ? extras.ops
    : loadBomOps(db, po?.bom_id);
  const manual = extras.manualDriverQty != null && extras.manualDriverQty !== ''
    ? Number(extras.manualDriverQty)
    : (po?.manual_driver_qty != null ? Number(po.manual_driver_qty) : 0);
  return {
    ops,
    machineMinutes: extras.machineMinutes,
    laborHours: extras.laborHours,
    manualDriverQty: Number.isFinite(manual) ? manual : 0,
  };
}

function bumpRateApplied(db, rateId, amountRial, driverQty) {
  if (!rateId) return;
  try {
    db.prepare(`
      UPDATE cost_center_rates SET
        applied_oh_rial = COALESCE(applied_oh_rial,0) + ?,
        actual_driver_qty = COALESCE(actual_driver_qty,0) + ?
      WHERE id=?
    `).run(Math.round(Number(amountRial) || 0), Number(driverQty) || 0, rateId);
  } catch { /* older schema */ }
}

/** R13 — undo rate counters when OH applications are reversed. */
function reverseAppliedOverheadCounters(db, ohRows) {
  for (const o of ohRows || []) {
    if (!o || !o.rate_id) continue;
    const amt = Math.round(Number(o.amount_rial) || 0);
    const dq = Number(o.driver_qty) || 0;
    try {
      db.prepare(`
        UPDATE cost_center_rates SET
          applied_oh_rial = MAX(0, COALESCE(applied_oh_rial,0) - ?),
          actual_driver_qty = MAX(0, COALESCE(actual_driver_qty,0) - ?)
        WHERE id=?
      `).run(amt, dq, o.rate_id);
    } catch { /* older schema */ }
  }
}

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

  const ctx = buildApplyCtx(db, po, { ops, machineMinutes, laborHours, manualDriverQty });
  const driver = coerceDriver(rate.driver);
  const driverQty = computeDriverQty(db, {
    driver,
    po,
    qtyStarted,
    laborRial,
    matRial,
    machineMinutes: ctx.machineMinutes,
    ops: ctx.ops,
    laborHours: ctx.laborHours,
    manualDriverQty: ctx.manualDriverQty,
  });
  const rateRial = Math.round(Number(rate.total_rate_rial) || 0);
  const amount = appliedOverheadRial(rate, driverQty);

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

  bumpRateApplied(db, rate.id, amount, driverQty);

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

function plantDriverQty(driver, ctx) {
  const d = coerceDriver(driver || 'output_qty');
  if (d === 'output_qty') return Number(ctx.qty) || 0;
  if (d === 'direct_labor_rial') return (Number(ctx.laborRial) || 0) / 1e6;
  if (d === 'material_rial') return (Number(ctx.matRial) || 0) / 1e6;
  if (d === 'manual') return Number(ctx.manual) || 0;
  return 0;
}

/** سربار کارگاه، یک‌بار. دفتر توزیع جذب نمی‌شود. مرکز روی مسیر سفارش رد می‌شود. */
function postPlantOverhead(db, ctx) {
  const po = ctx.po;
  const skip = new Set((ctx.skipCcIds || []).map((id) => Number(id)));
  if (po.cost_center_id) skip.add(Number(po.cost_center_id));
  const lines = [];
  let total = 0;
  for (const cc of listPlantCostCenters(db)) {
    if (skip.has(Number(cc.id))) continue;
    const rate = getOverheadRate(db, cc.id, ctx.period);
    if (!rate) continue;
    const driver = coerceDriver(rate.driver || cc.driver || 'output_qty');
    const driverQty = plantDriverQty(driver, ctx);
    const amount = appliedOverheadRial(rate, driverQty);
    if (!(amount > 0)) continue;
    let docNo = '';
    try { docNo = allocateNumber(db, 'overhead_apply', 'OH'); }
    catch { docNo = `OH-${Date.now()}`; }
    const id = db.prepare(`
      INSERT INTO production_overhead_applications
        (doc_no, order_id, stage_id, cost_center_id, rate_id, driver, driver_qty,
         fixed_rate_rial, var_rate_rial, rate_rial, amount_rial,
         date, period_label, status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'posted',?)
    `).run(
      docNo, po.id, ctx.stageId || null, cc.id, rate.id, driver, driverQty,
      Math.round(Number(rate.fixed_rate_rial) || 0),
      Math.round(Number(rate.var_rate_rial) || 0),
      Math.round(Number(rate.total_rate_rial) || 0),
      amount, ctx.date, ctx.period, ctx.userId
    ).lastInsertRowid;
    bumpRateApplied(db, rate.id, amount, driverQty);
    lines.push({ id, amount_rial: amount, cost_center_id: cc.id, name: cc.name });
    total += amount;
  }
  return { amount_rial: total, lines };
}

module.exports = {
  listPlantCostCenters,
  postPlantOverhead,
  getOverheadRate,
  bootstrapRate,
  computeDriverQty,
  applyOverhead,
  loadBomOps,
  buildApplyCtx,
  bumpRateApplied,
  reverseAppliedOverheadCounters,
  normalizeDriver,
  coerceDriver,
  validatePeriodLabel,
  computePredeterminedRates,
  looksLikePoolNotRate,
  clampAbsorbPct,
  appliedOverheadRial,
  appliedMonthlyLaborRial,
  estimateCuttingCapacity,
  OH_DRIVERS,
};
