'use strict';
/**
 * Direct labor posting for production.
 * Amount math mirrors bom-advanced.stageLabor (§5.1) — NO ledger posting here.
 */
const { allocateNumber } = require('../../db');

function laborErr(code, status = 422, extra = {}) {
  const e = new Error(code);
  e.code = code;
  e.status = status;
  e.extra = extra;
  return e;
}

/**
 * Compute labor amount (INTEGER rial) from method + inputs.
 * @returns {{ amount: number, hours: number, rate: number }}
 */
function computeLaborAmount({
  method = 'piece',
  qty = 0,
  hours = 0,
  rateRial = 0,
  setupMinutes,
  runMinutesPerUnit,
  crewSize,
} = {}) {
  const m = String(method || 'piece').toLowerCase();
  const rate = Math.round(Number(rateRial) || 0);
  const q = Number(qty) || 0;

  if (m === 'contract') {
    return { amount: 0, hours: 0, rate };
  }

  if (m === 'hourly' || m === 'hours') {
    // Prefer setup/run formula when timing fields are present (bom_operations path).
    // If only hours are supplied (laborSpecs), use hours as-is.
    const hasTiming = setupMinutes != null || runMinutesPerUnit != null;
    let h = Number(hours) || 0;

    if (hasTiming) {
      const run = Number(runMinutesPerUnit) || 0;
      if (!(run > 0)) throw laborErr('E_NO_RUN_TIME', 422);
      const crew = (crewSize == null || crewSize === '') ? 1 : Number(crewSize);
      if (!Number.isFinite(crew) || crew <= 0) throw laborErr('E_CREW_ZERO', 422);
      const mins = (Number(setupMinutes) || 0) + run * q;
      h = (mins / 60) * crew;
    }

    return { amount: Math.round(rate * h), hours: h, rate };
  }

  if (m === 'piece') {
    if (!(rate > 0)) throw laborErr('E_LABOR_RATE_ZERO', 422);
    return { amount: Math.round(rate * q), hours: Number(hours) || 0, rate };
  }

  if (m === 'monthly') {
    // rate comes from caller (typically cost_center_rates.monthly_labor_rate_rial)
    return { amount: Math.round(rate * q), hours: Number(hours) || 0, rate };
  }

  // unknown method — best-effort qty×rate
  return {
    amount: Math.round((q || Number(hours) || 0) * rate),
    hours: Number(hours) || 0,
    rate,
  };
}

function lookupMonthlyLaborRate(db, costCenterId, period) {
  if (!costCenterId) return 0;
  try {
    const rate = db.prepare(`
      SELECT monthly_labor_rate_rial FROM cost_center_rates
      WHERE cost_center_id=? AND period_label=? AND status IN ('active','approved','draft','estimated')
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END
      LIMIT 1
    `).get(costCenterId, period)
      || db.prepare(`
        SELECT monthly_labor_rate_rial FROM cost_center_rates
        WHERE cost_center_id=? AND COALESCE(monthly_labor_rate_rial,0)>0
        ORDER BY period_label DESC LIMIT 1
      `).get(costCenterId);
    return Math.round(Number(rate?.monthly_labor_rate_rial) || 0);
  } catch {
    return 0;
  }
}

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
  setupMinutes, runMinutesPerUnit, crewSize,
}) {
  const computed = computeLaborAmount({
    method,
    qty,
    hours,
    rateRial,
    setupMinutes,
    runMinutesPerUnit,
    crewSize,
  });
  const rate = computed.rate;
  const amount = computed.amount;
  const hoursOut = computed.hours;

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
    Number(qty) || 0, hoursOut, Number(stdHours) || 0,
    rate, Math.round(Number(stdRateRial) || 0), amount, stdAmt,
    amount - stdAmt, 0, date, period, note, userId
  ).lastInsertRowid;

  return { id, amount_rial: amount, method, qty, hours: hoursOut, rate_rial: rate };
}

/**
 * Auto-post labor from body.labor rates × qtyStarted, or bom_operations (§5.1).
 * body.labor = [{ method:'piece', rate_rial:250000 }, { method:'monthly', rate_rial:40000 }]
 */
function autoPostLabor(db, { po, qtyStarted, date, period, userId, laborSpecs = null }) {
  let total = 0;
  const specs = laborSpecs || [];

  if (specs.length) {
    for (const s of specs) {
      const method = s.method || 'piece';
      if (method === 'contract') continue;

      const r = postLabor(db, {
        orderId: po.id,
        costCenterId: s.cost_center_id || po.cost_center_id,
        method,
        qty: qtyStarted,
        hours: s.hours || 0,
        rateRial: s.rate_rial != null ? s.rate_rial : (s.rateRial || 0),
        personId: s.person_id || null,
        setupMinutes: s.setup_minutes != null ? s.setup_minutes : s.setupMinutes,
        runMinutesPerUnit: s.run_minutes_per_unit != null ? s.run_minutes_per_unit : s.runMinutesPerUnit,
        crewSize: s.crew_size != null ? s.crew_size : s.crewSize,
        date, period, userId,
        note: s.note || 'جذب خودکار دستمزد',
      });
      total += r.amount_rial;
    }
    return total;
  }

  // From bom_operations if present — piece/hourly/monthly/contract per §5.1
  let opsPosted = false;
  try {
    if (po.bom_id) {
      const ops = db.prepare(`
        SELECT * FROM bom_operations WHERE bom_id=? ORDER BY seq
      `).all(po.bom_id);

      if (ops.length) {
        opsPosted = true;
        for (const op of ops) {
          const method = op.labor_method || 'piece';
          if (method === 'contract') continue; // subcontract handled elsewhere

          let rateRial = Math.round(Number(op.labor_rate_rial) || 0);
          if (method === 'monthly') {
            rateRial = lookupMonthlyLaborRate(db, op.cost_center_id || po.cost_center_id, period);
            if (!(rateRial > 0)) continue;
          }

          const r = postLabor(db, {
            orderId: po.id,
            costCenterId: op.cost_center_id || po.cost_center_id,
            method,
            qty: qtyStarted,
            rateRial,
            setupMinutes: op.setup_minutes,
            runMinutesPerUnit: op.run_minutes_per_unit,
            crewSize: op.crew_size,
            date, period, userId,
            note: `عملیات ${op.operation_name || op.name || op.seq}`,
          });
          total += r.amount_rial;
        }
      }
    }
  } catch (e) {
    // Re-throw validation errors from computeLaborAmount; swallow missing-table / empty
    if (e && e.code && String(e.code).startsWith('E_')) throw e;
    /* bom_operations may be empty / missing */
  }

  // Fallback: monthly_labor_rate_rial from cost_center_rates for the period
  if (!opsPosted && !total && po.cost_center_id) {
    const ml = lookupMonthlyLaborRate(db, po.cost_center_id, period);
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
  }

  return total;
}

module.exports = { sumLabor, postLabor, autoPostLabor, computeLaborAmount };
