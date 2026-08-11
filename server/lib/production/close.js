'use strict';
/**
 * P8 — Period close + variance proration (ADR-005)
 * PRD-21 / PRD-22 / PRD-23
 */
const { audit } = require('../../db');
const { acct } = require('../coa-map');
const { todayJalali } = require('../../jalali');
const { assertFiscalYearWritable } = require('../fiscal-period');
const {
  dr, cr, postEvent, reverseEvent, postCloseLabor, postCloseOverhead, postAllocation, err,
} = require('./posting');
const { setting } = require('./costing');

const CONTROL_KEYS = [
  'coa_labor_control', 'coa_overhead_control', 'coa_overhead_applied',
  'coa_var_labor_rate', 'coa_var_labor_eff', 'coa_var_oh_budget', 'coa_var_oh_volume',
];

function safeJson(s) {
  if (!s) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
}

function periodEndDate(period, row) {
  if (row?.end_date) return row.end_date;
  const parts = String(period || '').split('/');
  if (parts.length >= 2) {
    const m = Number(parts[1]);
    const days = [1, 3, 5, 7, 8, 10, 12].includes(m) ? 31 : [4, 6, 9, 11].includes(m) ? 30 : 29;
    return `${parts[0]}/${parts[1].padStart(2, '0')}/${days}`;
  }
  return `${period}/31`;
}

function getPeriodRow(db, period) {
  return db.prepare('SELECT * FROM production_period_close WHERE period_label=?').get(period);
}

function requireOpenPeriod(db, period, { autoOpen = true } = {}) {
  let row = getPeriodRow(db, period);
  if (!row && autoOpen) {
    openPeriod(db, { period });
    row = getPeriodRow(db, period);
  }
  if (!row) throw err('E_NOT_FOUND', 404, { period });
  if (row.status === 'closed') throw err('E_ALREADY_CLOSED', 409, { period });
  return row;
}

function accountCode(db, keyOrCode) {
  if (String(keyOrCode).startsWith('coa_')) return acct(db, keyOrCode).code;
  return String(keyOrCode);
}

/** Net debit balance (debit − credit) for account through asOfDate. */
function accountBalance(db, accountKeyOrCode, asOfDate) {
  const code = accountCode(db, accountKeyOrCode);
  const params = [code];
  let dateSql = '';
  if (asOfDate) {
    dateSql = ' AND je.entry_date <= ?';
    params.push(asOfDate);
  }
  const r = db.prepare(`
    SELECT
      COALESCE(SUM(COALESCE(NULLIF(jl.debit_rial,0), ROUND(jl.debit), 0)), 0) -
      COALESCE(SUM(COALESCE(NULLIF(jl.credit_rial,0), ROUND(jl.credit), 0)), 0) bal
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.account_code = ? AND COALESCE(je.deleted_at, 0) = 0
    ${dateSql}
  `).get(...params);
  return Math.round(Number(r?.bal) || 0);
}

function enrichPct(base) {
  const wip = Math.round(Number(base.wip_rial) || 0);
  const fg = Math.round(Number(base.fg_rial) || 0);
  const cogs = Math.round(Number(base.cogs_rial) || 0);
  const total = Math.round(Number(base.total_rial) || (wip + fg + cogs));
  const pct = (n) => (total ? Math.round(n * 10000 / total) / 100 : 0);
  return {
    wip_rial: wip, fg_rial: fg, cogs_rial: cogs, total_rial: total,
    wip_pct: pct(wip), fg_pct: pct(fg), cogs_pct: pct(cogs),
  };
}

function laborBaseFromOh(ohBase, laborAppliedTotal) {
  const total = ohBase.total_rial || 0;
  const applied = Math.round(Number(laborAppliedTotal) || 0);
  if (!total || !applied) {
    return enrichPct({ wip_rial: 0, fg_rial: 0, cogs_rial: applied, total_rial: applied });
  }
  const wip = Math.round(applied * ohBase.wip_rial / total);
  const fg = Math.round(applied * ohBase.fg_rial / total);
  const cogs = applied - wip - fg;
  return enrichPct({ wip_rial: wip, fg_rial: fg, cogs_rial: cogs, total_rial: applied });
}

function allocationBase(db, { period }) {
  const row = getPeriodRow(db, period);
  const checklist = safeJson(row?.checklist_json) || {};
  if (checklist.allocation_base) return enrichPct(checklist.allocation_base);

  const endDate = periodEndDate(period, row);

  const wipOh = Math.round(Number(db.prepare(`
    SELECT COALESCE(SUM(overhead_cost_rial), 0) s
    FROM production_orders
    WHERE period_label = ? AND status IN ('released', 'in_progress')
  `).get(period)?.s) || 0);

  let fgOh = Math.round(Number(row?.fg_close_rial) || 0);
  if (!fgOh) {
    fgOh = Math.round(Number(db.prepare(`
      SELECT COALESCE(SUM(overhead_cost_rial), 0) s
      FROM production_orders
      WHERE period_label = ? AND status IN ('completed', 'closed')
    `).get(period)?.s) || 0);
  }

  const appliedOh = Math.abs(Math.min(0, accountBalance(db, 'coa_overhead_applied', endDate)))
    || Math.round(Number(db.prepare(`
      SELECT COALESCE(SUM(overhead_cost_rial), 0) s FROM production_orders WHERE period_label = ?
    `).get(period)?.s) || 0);

  let cogsOh = Math.round(Number(row?.cogs_rial) || 0);
  if (!cogsOh && appliedOh) {
    cogsOh = Math.max(0, appliedOh - wipOh - fgOh);
  }
  if (!cogsOh && !wipOh && !fgOh && appliedOh) {
    cogsOh = appliedOh;
  }

  const total = wipOh + fgOh + cogsOh;
  return enrichPct({ wip_rial: wipOh, fg_rial: fgOh, cogs_rial: cogsOh, total_rial: total });
}

function prorateVariance(varianceRial, base) {
  const v = Math.round(Number(varianceRial) || 0);
  const total = Math.round(Number(base?.total_rial) || 0)
    || Math.round((Number(base?.wip_rial) || 0) + (Number(base?.fg_rial) || 0) + (Number(base?.cogs_rial) || 0));
  if (!v || !total) {
    return { wip_rial: 0, fg_rial: 0, cogs_rial: v, total_rial: v };
  }
  const wip = Math.round(v * (Number(base.wip_rial) || 0) / total);
  const fg = Math.round(v * (Number(base.fg_rial) || 0) / total);
  const cogs = v - wip - fg;
  return { wip_rial: wip, fg_rial: fg, cogs_rial: cogs, total_rial: v };
}

function directCogsAllocation(varianceRial) {
  const v = Math.round(Number(varianceRial) || 0);
  return { wip_rial: 0, fg_rial: 0, cogs_rial: v, total_rial: v };
}

function computeVariances(db, period, endDate) {
  const laborBal = accountBalance(db, 'coa_labor_control', endDate);
  const ohControlBal = accountBalance(db, 'coa_overhead_control', endDate);
  const ohAppliedBal = accountBalance(db, 'coa_overhead_applied', endDate);
  const ohAppliedRial = Math.abs(Math.min(0, ohAppliedBal));
  const ohVariance = ohControlBal + ohAppliedBal;

  return {
    labor: {
      actual_rial: null,
      applied_rial: null,
      variance_rial: laborBal,
      favorable: laborBal < 0,
      control_balance_rial: laborBal,
    },
    overhead: {
      actual_rial: ohControlBal,
      applied_rial: ohAppliedRial,
      variance_rial: ohVariance,
      favorable: ohVariance < 0,
      control_balance_rial: ohControlBal,
      applied_balance_rial: ohAppliedBal,
    },
    total_variance_rial: laborBal + ohVariance,
  };
}

function ohByCostCenter(db, period, endDate) {
  const code5202 = acct(db, 'coa_overhead_control').code;
  const code5203 = acct(db, 'coa_overhead_applied').code;
  const rows = db.prepare(`
    SELECT cc.id, cc.code, cc.name,
      COALESCE(SUM(CASE WHEN jl.account_code = ? THEN
        COALESCE(NULLIF(jl.debit_rial,0), ROUND(jl.debit), 0) - COALESCE(NULLIF(jl.credit_rial,0), ROUND(jl.credit), 0)
      ELSE 0 END), 0) actual_rial,
      COALESCE(SUM(CASE WHEN jl.account_code = ? THEN
        COALESCE(NULLIF(jl.credit_rial,0), ROUND(jl.credit), 0) - COALESCE(NULLIF(jl.debit_rial,0), ROUND(jl.debit), 0)
      ELSE 0 END), 0) applied_rial
    FROM cost_centers cc
    LEFT JOIN journal_lines jl ON jl.detail_account_id = cc.coa_tafsili_oh OR jl.detail_account_id = cc.code
    LEFT JOIN journal_entries je ON je.id = jl.entry_id
      AND je.entry_date <= ? AND COALESCE(je.deleted_at, 0) = 0
      AND jl.account_code IN (?, ?)
    WHERE cc.is_stage = 1
    GROUP BY cc.id
    HAVING ABS(actual_rial) > 0 OR ABS(applied_rial) > 0
    ORDER BY cc.seq
  `).all(code5202, code5203, endDate, code5202, code5203);

  if (!rows.length) {
    return db.prepare(`
      SELECT cc.id, cc.code, cc.name,
        COALESCE(r.actual_oh_rial, 0) actual_rial,
        COALESCE(r.applied_oh_rial, 0) applied_rial,
        COALESCE(r.variance_rial, 0) variance_rial
      FROM cost_center_rates r
      JOIN cost_centers cc ON cc.id = r.cost_center_id
      WHERE r.period_label = ? AND (r.actual_oh_rial <> 0 OR r.applied_oh_rial <> 0)
      ORDER BY cc.seq
    `).all(period).map(r => ({
      cc: `${r.code} ${r.name}`,
      cost_center_id: r.id,
      actual_rial: Math.round(Number(r.actual_rial) || 0),
      applied_rial: Math.round(Number(r.applied_rial) || 0),
      variance_rial: Math.round(Number(r.variance_rial) || (Number(r.actual_rial) - Number(r.applied_rial))),
    }));
  }

  return rows.map(r => ({
    cc: `${r.code} ${r.name}`,
    cost_center_id: r.id,
    actual_rial: Math.round(Number(r.actual_rial) || 0),
    applied_rial: Math.round(Number(r.applied_rial) || 0),
    variance_rial: Math.round((Number(r.actual_rial) || 0) - (Number(r.applied_rial) || 0)),
  }));
}

function productionCostRial(db, period, row) {
  if (row?.total_produced_rial) return Math.round(Number(row.total_produced_rial));
  const r = db.prepare(`
    SELECT COALESCE(SUM(total_cost_rial), 0) s
    FROM production_orders WHERE period_label = ?
  `).get(period);
  return Math.round(Number(r?.s) || 0);
}

function buildAllocation(variances, ohBase, laborBase, method) {
  const prorate = method === 'direct_cogs' ? directCogsAllocation : prorateVariance;
  const laborAlloc = prorate(variances.labor.variance_rial, laborBase);
  const ohAlloc = prorate(variances.overhead.variance_rial, ohBase);
  return {
    labor: laborAlloc,
    overhead: ohAlloc,
    total: {
      total_rial: laborAlloc.total_rial + ohAlloc.total_rial,
      wip_rial: laborAlloc.wip_rial + ohAlloc.wip_rial,
      fg_rial: laborAlloc.fg_rial + ohAlloc.fg_rial,
      cogs_rial: laborAlloc.cogs_rial + ohAlloc.cogs_rial,
    },
  };
}

function previewEntries(db, variances, allocation) {
  const laborV = variances.labor.variance_rial;
  const ohV = variances.overhead.variance_rial;
  const ohApplied = variances.overhead.applied_rial;
  const entries = [];

  if (laborV) {
    entries.push({
      event: 'PRD-21',
      description: 'بستن انحراف دستمزد',
      lines: laborV > 0
        ? [{ code: acct(db, 'coa_var_labor_rate').code, debit_rial: Math.abs(laborV) },
          { code: acct(db, 'coa_labor_control').code, credit_rial: Math.abs(laborV) }]
        : [{ code: acct(db, 'coa_labor_control').code, debit_rial: Math.abs(laborV) },
          { code: acct(db, 'coa_var_labor_rate').code, credit_rial: Math.abs(laborV) }],
    });
  }

  if (ohApplied) {
    entries.push({
      event: 'PRD-22',
      description: 'انتقال سربار جذب‌شده',
      lines: [
        { code: acct(db, 'coa_overhead_applied').code, debit_rial: ohApplied },
        { code: acct(db, 'coa_overhead_control').code, credit_rial: ohApplied },
      ],
    });
  }

  if (ohV) {
    entries.push({
      event: 'PRD-22',
      description: 'بستن انحراف سربار',
      lines: ohV > 0
        ? [{ code: acct(db, 'coa_var_oh_volume').code, debit_rial: Math.abs(ohV) },
          { code: acct(db, 'coa_overhead_control').code, credit_rial: Math.abs(ohV) }]
        : [{ code: acct(db, 'coa_overhead_control').code, debit_rial: Math.abs(ohV) },
          { code: acct(db, 'coa_var_oh_volume').code, credit_rial: Math.abs(ohV) }],
    });
  }

  const tot = allocation.total;
  if (tot.total_rial) {
    const lines = [];
    if (tot.wip_rial) lines.push({ code: acct(db, 'coa_wip').code, debit_rial: tot.wip_rial });
    if (tot.fg_rial) lines.push({ code: acct(db, 'coa_finished_goods').code, debit_rial: tot.fg_rial });
    if (tot.cogs_rial) lines.push({ code: acct(db, 'coa_cogs').code, debit_rial: tot.cogs_rial });
    if (allocation.labor.total_rial) {
      lines.push({ code: acct(db, 'coa_var_labor_rate').code, credit_rial: Math.abs(allocation.labor.total_rial) });
    }
    if (allocation.overhead.total_rial) {
      lines.push({ code: acct(db, 'coa_var_oh_volume').code, credit_rial: Math.abs(allocation.overhead.total_rial) });
    }
    entries.push({ event: 'PRD-23', description: 'تسهیم انحراف', lines });
  }

  return entries;
}

function previewFgAverages(db, { fgShareRial }) {
  const share = Math.round(Number(fgShareRial) || 0);
  if (!share) return [];

  const products = db.prepare(`
    SELECT id, name, stock, average_cost_rial
    FROM products
    WHERE COALESCE(stock, 0) > 0 AND COALESCE(item_type, 'finished') IN ('finished', 'product')
  `).all();

  const totalValue = products.reduce(
    (s, p) => s + (Number(p.stock) || 0) * (Math.round(Number(p.average_cost_rial) || 0)),
    0,
  );

  return products.map((p) => {
    const stock = Number(p.stock) || 0;
    const oldAvg = Math.round(Number(p.average_cost_rial) || 0);
    const val = stock * oldAvg;
    const portion = totalValue > 0 ? val / totalValue : (1 / Math.max(products.length, 1));
    const delta = Math.round(share * portion);
    const newAvg = stock > 0 ? Math.round((val + delta) / stock) : oldAvg;
    return { product_id: p.id, name: p.name, old_avg_rial: oldAvg, delta_rial: delta, new_avg_rial: newAvg };
  });
}

function updateFgAverages(db, { fgShareRial, period }) {
  const preview = previewFgAverages(db, { fgShareRial, period });
  for (const u of preview) {
    if (u.delta_rial) {
      db.prepare('UPDATE products SET average_cost_rial = ? WHERE id = ?').run(u.new_avg_rial, u.product_id);
    }
  }
  return preview;
}

function appliedLaborRial(db, period, endDate, row) {
  const code = acct(db, 'coa_labor_control').code;
  const start = row?.start_date || `${period}/01`;
  const r = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(NULLIF(jl.credit_rial,0), ROUND(jl.credit), 0)), 0) s
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.account_code = ? AND je.ref_type = 'production_labor'
      AND je.entry_date >= ? AND je.entry_date <= ?
      AND COALESCE(je.deleted_at, 0) = 0
  `).get(code, start, endDate);
  const fromJe = Math.round(Number(r?.s) || 0);
  if (fromJe) return fromJe;
  return Math.round(Number(db.prepare(`
    SELECT COALESCE(SUM(labor_cost_rial), 0) s FROM production_orders WHERE period_label = ?
  `).get(period)?.s) || 0);
}

function assertControlsZero(db, { period, asOfDate }) {
  const row = getPeriodRow(db, period);
  const end = asOfDate || periodEndDate(period, row);
  const bad = [];
  for (const key of CONTROL_KEYS) {
    const bal = accountBalance(db, key, end);
    if (Math.abs(bal) > 5) bad.push({ key, code: acct(db, key).code, balance_rial: bal });
  }
  if (bad.length) {
    throw err('E_CONTROL_NOT_ZERO', 409, { period, accounts: bad });
  }
  return { ok: true };
}

/** Ensure period row exists (auto-open) — UI can call precheck without prior /open */
function ensurePeriodRow(db, period, userId = null) {
  let row = getPeriodRow(db, period);
  if (!row) {
    openPeriod(db, { period, userId });
    row = getPeriodRow(db, period);
  }
  if (!row) throw err('E_NOT_FOUND', 404, { period });
  return row;
}

function precheck(db, { period }) {
  const row = ensurePeriodRow(db, period);
  const endDate = periodEndDate(period, row);
  const checks = [];

  const openOrders = db.prepare(`
    SELECT po.id, po.order_no, COALESCE(v.wip_rial, 0) wip_rial
    FROM production_orders po
    LEFT JOIN v_wip_by_order v ON v.order_id = po.id
    WHERE po.period_label = ? AND po.status = 'completed'
  `).all(period);

  checks.push({
    code: 'OPEN_ORDERS',
    status: openOrders.length ? 'fail' : 'pass',
    severity: 'error',
    message: openOrders.length
      ? `${openOrders.length} سفارش completed هنوز بسته نشده`
      : 'همه سفارش‌ها بسته شده ✅',
    items: openOrders.map(o => ({ order_no: o.order_no, wip_rial: Math.round(Number(o.wip_rial) || 0) })),
  });

  const payrollPosted = db.prepare(`
    SELECT COUNT(*) c FROM journal_entries
    WHERE ref_type = 'production_labor_actual' AND entry_date <= ?
      AND entry_date >= ? AND COALESCE(deleted_at, 0) = 0
  `).get(endDate, row.start_date || `${period}/01`);
  const payrollCount = Number(payrollPosted?.c) || 0;
  const payrollSetting = setting(db, 'production_close_payroll_posted', '');
  const payrollOk = payrollCount > 0 || payrollSetting === '1';
  checks.push({
    code: 'PAYROLL_POSTED',
    status: payrollOk ? 'pass' : 'fail',
    severity: 'error',
    message: payrollOk ? 'حقوق ثبت شده ✅' : 'حقوق ماه هنوز ثبت نشده',
  });

  const ohActual = db.prepare(`
    SELECT COUNT(*) c FROM journal_entries
    WHERE ref_type = 'production_overhead_actual' AND entry_date <= ?
      AND entry_date >= ? AND COALESCE(deleted_at, 0) = 0
  `).get(endDate, row.start_date || `${period}/01`);
  const ohCount = Number(ohActual?.c) || 0;
  const lastOh = db.prepare(`
    SELECT MAX(entry_date) d FROM journal_entries
    WHERE ref_type = 'production_overhead_actual' AND entry_date <= ?
      AND COALESCE(deleted_at, 0) = 0
  `).get(endDate)?.d;
  checks.push({
    code: 'OVERHEAD_POSTED',
    status: ohCount ? 'pass' : 'warn',
    severity: ohCount ? 'error' : 'warning',
    message: ohCount
      ? `سربار واقعی ثبت شده ✅${lastOh ? ` — آخرین ${lastOh}` : ''}`
      : 'سربار واقعی ثبت نشده — ممکن است ناقص باشد',
  });

  checks.push({
    code: 'STOCKTAKING',
    status: 'warn',
    severity: 'warning',
    message: 'انبارگردانی این ماه — بررسی دستی',
  });

  const rates = db.prepare(`
    SELECT COUNT(DISTINCT cost_center_id) c FROM cost_center_rates WHERE period_label = ?
  `).get(period);
  const rateCount = Number(rates?.c) || 0;
  checks.push({
    code: 'RATES_DEFINED',
    status: rateCount >= 1 ? 'pass' : 'fail',
    severity: 'error',
    message: rateCount >= 1 ? `نرخ سربار ${rateCount} مرکز تعریف شده ✅` : 'نرخ سربار تعریف نشده',
  });

  const fy = assertFiscalYearWritable(db, endDate);
  checks.push({
    code: 'FISCAL_YEAR_OPEN',
    status: fy.ok ? 'pass' : 'fail',
    severity: 'error',
    message: fy.ok ? 'سال مالی باز است ✅' : (fy.error || 'سال مالی بسته است'),
  });

  const canClose = checks.every(c => c.status !== 'fail');
  return { period, can_close: canClose, checks };
}

function calculate(db, { period, method: methodOverride }) {
  const row = requireOpenPeriod(db, period);
  const endDate = periodEndDate(period, row);
  const variances = computeVariances(db, period, endDate);
  const ohBase = allocationBase(db, { period });
  const laborApplied = appliedLaborRial(db, period, endDate, row);
  const checklist = safeJson(row.checklist_json) || {};
  const laborBase = checklist.labor_allocation_base
    ? enrichPct(checklist.labor_allocation_base)
    : laborBaseFromOh(ohBase, laborApplied || ohBase.total_rial);

  const thresholdPct = Number(setting(db, 'production_variance_threshold_pct', '0.5'));
  const productionCost = productionCostRial(db, period, row);
  const thresholdRial = Math.round(productionCost * thresholdPct / 100);
  const belowThreshold = Math.abs(variances.total_variance_rial) < thresholdRial;
  const methodAuto = belowThreshold ? 'direct_cogs' : 'proration';
  const method = methodOverride || methodAuto;

  const allocation = buildAllocation(variances, ohBase, laborBase, method);
  const preview_entries = previewEntries(db, variances, allocation);
  const fg_avg_updates = previewFgAverages(db, { fgShareRial: allocation.total.fg_rial, period });

  const result = {
    period,
    labor: {
      ...variances.labor,
      variance_rial: variances.labor.variance_rial,
    },
    overhead: {
      ...variances.overhead,
      variance_rial: variances.overhead.variance_rial,
      by_cost_center: ohByCostCenter(db, period, endDate),
    },
    total_variance_rial: variances.total_variance_rial,
    materiality: {
      production_cost_rial: productionCost,
      threshold_pct: thresholdPct,
      threshold_rial: thresholdRial,
      below_threshold: belowThreshold,
      method_auto: methodAuto,
    },
    method,
    allocation_base: ohBase,
    labor_allocation_base: laborBase,
    allocation,
    preview_entries,
    fg_avg_updates_preview: fg_avg_updates,
  };

  db.prepare(`
    UPDATE production_period_close SET
      total_labor_rial = ?,
      total_oh_actual_rial = ?,
      total_oh_applied_rial = ?,
      total_variance_rial = ?,
      variance_to_wip_rial = ?,
      variance_to_fg_rial = ?,
      variance_to_cogs_rial = ?,
      wip_close_rial = ?,
      fg_close_rial = ?,
      cogs_rial = ?,
      total_produced_rial = ?,
      method = ?,
      threshold_pct = ?,
      checklist_json = ?
    WHERE id = ?
  `).run(
    variances.labor.variance_rial,
    variances.overhead.actual_rial,
    variances.overhead.applied_rial,
    variances.total_variance_rial,
    allocation.total.wip_rial,
    allocation.total.fg_rial,
    allocation.total.cogs_rial,
    ohBase.wip_rial,
    ohBase.fg_rial,
    ohBase.cogs_rial,
    productionCost,
    method,
    thresholdPct,
    JSON.stringify({ ...checklist, last_calculate: result }),
    row.id,
  );

  return result;
}

function execute(db, { period, method, userId, date }) {
  return db.transaction(() => {
    const row = requireOpenPeriod(db, period);
    const pre = precheck(db, { period });
    if (!pre.can_close) throw err('E_PRECHECK_FAILED', 422, { checks: pre.checks });

    const calc = calculate(db, { period, method: method || undefined });
    const useMethod = method || calc.method;
    const endDate = date || periodEndDate(period, row);
    const variances = computeVariances(db, period, endDate);
    const ohBase = allocationBase(db, { period });
    const checklist = safeJson(row.checklist_json) || {};
    const laborApplied = appliedLaborRial(db, period, endDate, row);
    const laborBase = checklist.labor_allocation_base
      ? enrichPct(checklist.labor_allocation_base)
      : laborBaseFromOh(ohBase, laborApplied || ohBase.total_rial);
    const allocation = buildAllocation(variances, ohBase, laborBase, useMethod);

    const journal_entries = [];
    const closeId = row.id;

    const j21 = postCloseLabor(db, {
      closeId, date: endDate, userId, controlBalance: variances.labor.variance_rial,
    });
    if (j21) journal_entries.push({ event: 'PRD-21', ...j21 });

    const j22 = postCloseOverhead(db, {
      closeId, date: endDate, userId,
      appliedRial: variances.overhead.applied_rial,
      varianceRial: variances.overhead.variance_rial,
    });
    journal_entries.push(...j22.map(j => ({ event: 'PRD-22', ...j })));

    const j23 = postAllocation(db, {
      closeId, date: endDate, userId, allocation,
    });
    if (j23) journal_entries.push({ event: 'PRD-23', ...j23 });

    const fgUpdates = updateFgAverages(db, { fgShareRial: allocation.total.fg_rial, period });

    assertControlsZero(db, { period, asOfDate: endDate });

    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      UPDATE production_period_close SET
        status = 'closed',
        closed_by = ?,
        closed_at = ?,
        je_id = ?,
        total_variance_rial = ?,
        variance_to_wip_rial = ?,
        variance_to_fg_rial = ?,
        variance_to_cogs_rial = ?,
        method = ?,
        checklist_json = ?
      WHERE id = ?
    `).run(
      userId || null,
      now,
      journal_entries[journal_entries.length - 1]?.je_id || null,
      variances.total_variance_rial,
      allocation.total.wip_rial,
      allocation.total.fg_rial,
      allocation.total.cogs_rial,
      useMethod,
      JSON.stringify({
        ...checklist,
        journal_entries: journal_entries.map(j => ({ event: j.event, je_id: j.je_id })),
        fg_avg_updates: fgUpdates,
      }),
      row.id,
    );

    audit(userId, 'approve', 'production_period_close', row.id,
      `بستن دوره ${period} — انحراف ${variances.total_variance_rial.toLocaleString()} تسهیم شد`);

    return {
      ok: true,
      period,
      status: 'closed',
      closed_at: now,
      closed_by: userId,
      method: useMethod,
      journal_entries,
      allocation,
      fg_avg_updates: fgUpdates,
      checks: {
        labor_control_zero: accountBalance(db, 'coa_labor_control', endDate) === 0,
        overhead_control_zero: accountBalance(db, 'coa_overhead_control', endDate) === 0,
        overhead_applied_zero: accountBalance(db, 'coa_overhead_applied', endDate) === 0,
        variance_accounts_zero: CONTROL_KEYS.slice(3).every(k => Math.abs(accountBalance(db, k, endDate)) <= 5),
      },
    };
  })();
}

function reopen(db, { period, reason, userId }) {
  return db.transaction(() => {
    const row = getPeriodRow(db, period);
    if (!row) throw err('E_NOT_FOUND', 404, { period });
    if (row.status !== 'closed') throw err('E_NOT_CLOSED', 409, { period });

    const checklist = safeJson(row.checklist_json) || {};
    const jeList = checklist.journal_entries || [];
    const revDate = todayJalali();

    for (const j of jeList) {
      if (j.je_id) reverseEvent(db, { jeId: j.je_id, reason, userId, date: revDate });
    }
    if (row.je_id && !jeList.some(j => j.je_id === row.je_id)) {
      reverseEvent(db, { jeId: row.je_id, reason, userId, date: revDate });
    }
    if (row.reversed_je_id) {
      /* already reversed */
    }

    const fgUpdates = checklist.fg_avg_updates || [];
    for (const u of fgUpdates) {
      if (u.old_avg_rial != null) {
        db.prepare('UPDATE products SET average_cost_rial = ? WHERE id = ?')
          .run(u.old_avg_rial, u.product_id);
      }
    }

    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      UPDATE production_period_close SET
        status = 'open',
        reopened_by = ?,
        reopened_at = ?,
        reopen_reason = ?,
        reversed_je_id = ?
      WHERE id = ?
    `).run(userId || null, now, reason || '', row.je_id || null, row.id);

    audit(userId, 'update', 'production_period_close', row.id,
      `بازکردن دوره ${period} — دلیل: ${reason || ''}`);

    try {
      db.prepare(`
        INSERT INTO app_notifications (user_id, title, body, type, created_at)
        VALUES (?, ?, ?, 'production', ?)
      `).run(
        userId || null,
        `بازکردن دوره ${period}`,
        reason || '',
        now,
      );
    } catch { /* optional table */ }

    return { ok: true, period, status: 'open', reopened_at: now, reason };
  })();
}

function openPeriod(db, { period, startDate, endDate, userId }) {
  const existing = getPeriodRow(db, period);
  if (existing) return existing;
  const start = startDate || `${period}/01`;
  const end = endDate || periodEndDate(period, null);
  const r = db.prepare(`
    INSERT INTO production_period_close (period_label, start_date, end_date, status, note)
    VALUES (?, ?, ?, 'open', '')
  `).run(period, start, end);
  audit(userId, 'create', 'production_period_close', r.lastInsertRowid, `باز کردن دوره ${period}`);
  return getPeriodRow(db, period);
}

function listPeriods(db) {
  return db.prepare(`
    SELECT * FROM production_period_close ORDER BY period_label DESC
  `).all();
}

function getPeriodStatus(db, period) {
  const row = ensurePeriodRow(db, period);
  const checklist = safeJson(row.checklist_json) || {};
  return { ...row, last_calculate: checklist.last_calculate || null };
}

function getVariances(db, period) {
  const row = getPeriodRow(db, period);
  if (!row) throw err('E_NOT_FOUND', 404, { period });
  const endDate = periodEndDate(period, row);
  const variances = computeVariances(db, period, endDate);
  return {
    period,
    ...variances,
    by_cost_center: ohByCostCenter(db, period, endDate),
    stored: {
      total_variance_rial: row.total_variance_rial,
      variance_to_wip_rial: row.variance_to_wip_rial,
      variance_to_fg_rial: row.variance_to_fg_rial,
      variance_to_cogs_rial: row.variance_to_cogs_rial,
    },
  };
}

function getJournal(db, period) {
  const row = getPeriodRow(db, period);
  if (!row) throw err('E_NOT_FOUND', 404, { period });
  const checklist = safeJson(row.checklist_json) || {};
  const ids = (checklist.journal_entries || []).map(j => j.je_id).filter(Boolean);
  if (!row.je_id) {
    /* no-op */
  } else if (!ids.includes(row.je_id)) ids.push(row.je_id);

  if (!ids.length) return { period, entries: [] };

  const placeholders = ids.map(() => '?').join(',');
  const entries = db.prepare(`
    SELECT je.* FROM journal_entries je
    WHERE je.id IN (${placeholders}) AND COALESCE(je.deleted_at, 0) = 0
    ORDER BY je.id
  `).all(...ids);

  return {
    period,
    entries: entries.map(e => ({
      ...e,
      lines: db.prepare(`
        SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY line_no, id
      `).all(e.id),
    })),
  };
}

module.exports = {
  precheck,
  calculate,
  execute,
  reopen,
  openPeriod,
  allocationBase,
  prorateVariance,
  updateFgAverages,
  assertControlsZero,
  accountBalance,
  listPeriods,
  getPeriodStatus,
  getVariances,
  getJournal,
};
