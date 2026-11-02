'use strict';
/**
 * P9 — Production reports (read-only SELECT)
 * docs/Production/06-production-reports.md
 */
const crypto = require('crypto');
const { acct } = require('../coa-map');
const { jeNotDraftFor } = require('../je-live');
const { hasPermission } = require('../rbac');
const { todayJalali, nowHHMM, addDaysToJalali } = require('../../jalali');
const close = require('./close');
const { err } = require('./posting');
const {
  canSeeCost, stripCostFields, costCenterFilter, ccSqlFilter,
} = require('./access');

const PERIOD_RE = /^\d{4}\/\d{2}$/;

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** Missing period → current Jalali YYYY/MM; invalid format still 422. */
function resolvePeriod(period) {
  const raw = (period == null || period === '') ? todayJalali().slice(0, 7) : String(period).trim();
  if (!PERIOD_RE.test(raw)) throw err('E_INVALID_PERIOD', 422, { period: raw });
  return raw;
}

function periodRange(period) {
  const resolved = resolvePeriod(period);
  const parts = resolved.split('/');
  const y = parts[0];
  const m = Number(parts[1]);
  const days = [1, 3, 5, 7, 8, 10, 12].includes(m) ? 31 : [4, 6, 9, 11].includes(m) ? 30 : 29;
  const mm = String(m).padStart(2, '0');
  return { from: `${y}/${mm}/01`, to: `${y}/${mm}/${days}` };
}

function prevPeriod(period) {
  const [y, m] = String(period).split('/').map(Number);
  if (m <= 1) return `${y - 1}/12`;
  return `${y}/${String(m - 1).padStart(2, '0')}`;
}

function periodStatus(db, period) {
  const row = db.prepare('SELECT status FROM production_period_close WHERE period_label=?').get(period);
  return row?.status || 'open';
}

function isPeriodOpen(db, period) {
  return periodStatus(db, period) !== 'closed';
}

function wipAccountCode(db) {
  return acct(db, 'coa_wip').code;
}

function ledgerBalance(db, accountKey, asOfDate) {
  return close.accountBalance(db, accountKey, asOfDate);
}

function sumOrderWip(db) {
  const r = db.prepare('SELECT COALESCE(SUM(wip_rial), 0) s FROM v_wip_by_order').get();
  return Math.round(Number(r?.s) || 0);
}

function validateReportParams(params = {}) {
  if (params.period && !PERIOD_RE.test(params.period)) {
    throw err('E_INVALID_PERIOD', 422, { period: params.period });
  }
  if (params.from && params.to && params.from > params.to) {
    throw err('E_DATE_RANGE', 422);
  }
  const page = params.page ? Number(params.page) : 1;
  const limit = params.limit ? Number(params.limit) : 100;
  if (page < 1 || limit < 1 || limit > 500) throw err('E_PAGINATION', 422);
}

function countRows(out) {
  if (!out) return 0;
  if (Array.isArray(out)) return out.length;
  if (Array.isArray(out.rows)) return out.rows.length;
  if (Array.isArray(out.data)) return out.data.length;
  if (out.data && typeof out.data === 'object') return Object.keys(out.data).length;
  return 0;
}

function emptyMessage(period) {
  return period
    ? `تولیدی در دوره ${period} ثبت نشده`
    : 'داده‌ای برای نمایش وجود ندارد';
}

// ─── Report implementations ───────────────────────────────────────────────

function ordersList(db, { status, from, to, productId, page = 1, limit = 100, ccFilter } = {}) {
  const cc = ccSqlFilter(ccFilter);
  const params = [];
  let where = ' WHERE 1=1';
  if (status) { where += ' AND po.status=?'; params.push(status); }
  if (from) { where += ' AND po.date>=?'; params.push(from); }
  if (to) { where += ' AND po.date<=?'; params.push(to); }
  if (productId) { where += ' AND po.product_id=?'; params.push(Number(productId)); }
  where += cc.sql;
  params.push(...cc.params);

  const total = db.prepare(`
    SELECT COUNT(*) c FROM production_orders po ${where}
  `).get(...params)?.c || 0;

  const offset = (Number(page) - 1) * Number(limit);
  const rows = db.prepare(`
    SELECT po.id, po.order_no, po.product_id, p.name AS product_name,
           po.date, po.period_label, po.status, po.analysis_type,
           po.qty_planned, po.qty_produced, po.total_cost_rial, po.unit_cost_rial
    FROM production_orders po
    JOIN products p ON p.id = po.product_id
    ${where}
    ORDER BY po.date DESC, po.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, Number(limit), offset);

  return {
    data: { rows },
    totals: { count: total, qty_planned: rows.reduce((s, r) => s + Number(r.qty_planned || 0), 0) },
    meta: { row_count: rows.length, empty: !rows.length, message: rows.length ? null : emptyMessage() },
  };
}

function costSheet(db, { orderId }) {
  if (orderId == null || orderId === '') throw err('E_ORDER_REQUIRED', 422);
  const oid = Number(orderId);
  if (!Number.isFinite(oid) || oid <= 0) throw err('E_ORDER_REQUIRED', 422);

  const order = db.prepare(`
    SELECT *
    FROM production_orders WHERE id=?
  `).get(oid);
  if (!order) throw err('E_NOT_FOUND', 404, { orderId: oid });

  let summary = null;
  try {
    summary = db.prepare('SELECT * FROM v_order_cost_summary WHERE order_id=?').get(oid);
  } catch { /* view may be missing */ }
  if (!summary) {
    const denom = Number(order.qty_produced) + Number(order.qty_waste_normal) + Number(order.qty_waste_abnormal);
    summary = {
      order_id: oid,
      order_no: order.order_no,
      status: order.status,
      product_id: order.product_id,
      period_label: order.period_label,
      total_cost_rial: Math.round(Number(order.total_cost_rial) || 0),
      unit_cost_rial: Math.round(Number(order.unit_cost_rial) || 0),
      yield_pct: denom > 0 ? round2(Number(order.qty_produced) * 100 / denom) : 0,
    };
  }

  let stages = [];
  try {
    stages = db.prepare(`
      SELECT s.seq, cc.code AS cc_code, cc.name AS cc_name,
             s.product_scope, s.scoped_product_id, sp.name AS scoped_product_name,
             s.qty_in, s.qty_out, s.material_in_rial, s.material_added_rial,
             s.labor_rial, s.subcontract_rial, s.overhead_rial, s.cost_out_rial
      FROM production_order_stages s
      JOIN cost_centers cc ON cc.id = s.cost_center_id
      LEFT JOIN products sp ON sp.id = s.scoped_product_id
      WHERE s.order_id = ? AND s.status <> 'skipped'
      ORDER BY s.seq
    `).all(oid);
  } catch { stages = []; }

  let prevCost = 0;
  const stagesVa = stages.map(s => {
    const costOut = Math.round(Number(s.cost_out_rial) || 0);
    const va = costOut - prevCost;
    prevCost = costOut;
    const pct = summary.total_cost_rial
      ? round2(va * 100 / summary.total_cost_rial) : 0;
    return { ...s, value_added_rial: va, value_added_pct: pct };
  });

  let wip = null;
  try {
    wip = db.prepare('SELECT wip_rial FROM v_wip_by_order WHERE order_id=?').get(oid);
  } catch { wip = null; }

  let journals = [];
  try {
    journals = db.prepare(`
      SELECT je.id, je.entry_date, je.description, je.voucher_number, je.ref_type,
             SUM(COALESCE(NULLIF(jl.debit_rial,0), ROUND(jl.debit), 0)) AS total_debit_rial
      FROM journal_entries je
      JOIN journal_lines jl ON jl.entry_id = je.id
      WHERE je.ref_type LIKE 'production_%' AND je.ref_id = ?
        AND COALESCE(je.deleted_at, 0) = 0 AND ${jeNotDraftFor(db)}
      GROUP BY je.id ORDER BY je.id
    `).all(oid);
  } catch { journals = []; }

  let products = [];
  try {
    const { orderFgPlanRows } = require('./bom');
    const plan = orderFgPlanRows(db, order);
    if (plan.length > 1) {
      const total = Math.round(Number(summary.total_cost_rial) || 0);
      // P2 — همان تسهیم رسید نهایی: پارچه از cutting_batch_allocations، مراحل اختصاصی مستقیم، باقی به سهم
      const { splitOrderCost } = require('./order-cost-split');
      const pctSum = plan.reduce((s, p) => s + (Number(p.cost_share_percent) || 0), 0);
      const qtySum = plan.reduce((s, p) => s + (Number(p.qty_planned) || 0), 0) || 1;
      const byQty = !!require('./bom').orderBomPeerLines(order) || Math.abs(pctSum - 100) > 0.01;
      const split = splitOrderCost(db, order, {
        total,
        products: plan.map((p) => ({
          product_id: p.product_id,
          pct: byQty ? ((Number(p.qty_planned) || 0) / qtySum) * 100 : p.cost_share_percent,
        })),
        residueProductId: order.product_id,
      });
      const byPid = new Map(split.rows.map((r) => [r.product_id, r]));
      const useAlloc = split.fabric_source === 'shared_cut_alloc';
      products = plan.map((p) => {
        const qty = Number(p.qty_planned) || 0;
        const s = byPid.get(Number(p.product_id)) || { fabric_rial: 0, exclusive_rial: 0, shared_rial: 0, amount_rial: 0 };
        const cost = s.amount_rial;
        return {
          product_id: p.product_id,
          product_name: p.product_name,
          qty_planned: qty,
          cost_share_percent: total > 0 ? Math.round((cost * 10000) / total) / 100 : (Number(p.cost_share_percent) || 0),
          cost_share_source: useAlloc ? 'shared_cut_alloc' : 'bom_percent',
          allocated_fabric_rial: useAlloc ? s.fabric_rial : null,
          exclusive_rial: s.exclusive_rial,
          shared_rial: s.shared_rial,
          cost_rial: cost,
          unit_cost_rial: qty > 0 ? Math.round(cost / qty) : 0,
        };
      });
    }
  } catch { products = []; }
  if (!summary.product_name) {
    summary.product_name = db.prepare('SELECT name FROM products WHERE id=?').get(order.product_id)?.name || '';
  }
  if (summary.qty_planned == null) summary.qty_planned = order.qty_planned;
  summary.products = products;

  const wipRial = Math.round(Number(wip?.wip_rial) || 0);
  const balanced = Math.abs(wipRial) <= 5 || summary.status === 'closed';
  const cutting = costSheetCuttingAudit(db, order, summary);

  return {
    data: {
      summary,
      stages: stagesVa,
      journals,
      wip_rial: wipRial,
      balanced,
      /** WIP residual only — not “production complete”. Use cost_final. */
      cutting,
      incomplete: !!cutting.incomplete,
      incomplete_reasons: cutting.incomplete_reasons,
      cost_final: !!cutting.cost_final,
    },
    totals: {
      total_cost_rial: summary.total_cost_rial,
      unit_cost_rial: summary.unit_cost_rial,
      yield_pct: summary.yield_pct,
      cost_final: !!cutting.cost_final,
    },
    meta: {
      empty: !stagesVa.length && !journals.length,
      message: cutting.incomplete
        ? (cutting.incomplete_reasons[0] && cutting.incomplete_reasons[0].message) || null
        : null,
    },
  };
}

/**
 * v467 — بهای نهایی فقط وقتی لایه‌چینی (و PACK در صورت تولید FG) برای مسیر پارچهٔ متری
 * ثبت شده و ضایعات/انحراف لایه در برگه قابل مشاهده است.
 * سفارش بدون پارچهٔ متری: همیشه cost_final از نظر برش.
 */
function costSheetCuttingAudit(db, order, summary) {
  const empty = {
    requires_fabric_cutting: false,
    lay_count: 0,
    cutting_lay_qty: 0,
    cutting_pack_qty: 0,
    actual_meters: 0,
    matrix_meters: 0,
    fabric_variance_m: 0,
    waste_normal_m: 0,
    waste_abnormal_m: 0,
    lay_amount_rial: 0,
    lay_waste_rial: 0,
    order_abnormal_waste_rial: Math.round(Number(order.abnormal_waste_rial) || 0),
    incomplete: false,
    incomplete_reasons: [],
    cost_final: true,
  };
  let gate = { requires_fabric_cutting: false, cutting_lay_qty: 0, cutting_pack_qty: 0 };
  try {
    const cutting = require('./cutting');
    gate = cutting.fabricCuttingGateInfo(db, order);
  } catch {
    return empty;
  }

  let lays = [];
  try {
    lays = db.prepare(`
      SELECT COALESCE(actual_meters,0) AS actual_meters,
             COALESCE(matrix_meters,0) AS matrix_meters,
             COALESCE(waste_normal_m,0) AS waste_normal_m,
             COALESCE(waste_abnormal_m,0) AS waste_abnormal_m,
             COALESCE(amount_rial,0) AS amount_rial,
             COALESCE(waste_amount_rial,0) AS waste_amount_rial,
             COALESCE(qty_pieces,0) AS qty_pieces
      FROM cutting_lays
      WHERE production_order_id=? AND COALESCE(status,'posted')<>'reversed'
    `).all(Number(order.id));
  } catch { lays = []; }

  const agg = lays.reduce((a, l) => {
    a.actual_meters += Number(l.actual_meters) || 0;
    a.matrix_meters += Number(l.matrix_meters) || 0;
    a.waste_normal_m += Number(l.waste_normal_m) || 0;
    a.waste_abnormal_m += Number(l.waste_abnormal_m) || 0;
    a.lay_amount_rial += Math.round(Number(l.amount_rial) || 0);
    a.lay_waste_rial += Math.round(Number(l.waste_amount_rial) || 0);
    a.qty_pieces += Number(l.qty_pieces) || 0;
    return a;
  }, {
    actual_meters: 0, matrix_meters: 0, waste_normal_m: 0, waste_abnormal_m: 0,
    lay_amount_rial: 0, lay_waste_rial: 0, qty_pieces: 0,
  });

  const reasons = [];
  if (gate.requires_fabric_cutting) {
    if (!lays.length) {
      reasons.push({
        code: 'E_COST_NO_LAY',
        message: 'سفارش پارچهٔ متری دارد ولی لایه‌چینی ثبت نشده — ضایعات و انحراف برش در بها نیست؛ برگه موقت است و بهای نهایی صادر نمی‌شود.',
      });
    } else {
      const produced = Number(order.qty_produced) || 0;
      if (produced > 0 && Number(gate.cutting_lay_qty) + 1e-9 < produced) {
        reasons.push({
          code: 'E_COST_LAY_QTY',
          message: `تعداد قطعهٔ لایه‌چینی (${gate.cutting_lay_qty}) از تولید ثبت‌شده (${produced}) کمتر است — لایه‌چینی کامل نیست.`,
        });
      }
      if (produced > 0 && Number(gate.cutting_pack_qty) + 1e-9 < produced) {
        reasons.push({
          code: 'E_COST_NO_PACK',
          message: `بعد از لایه‌چینی، PACK برای حداقل ${produced} عدد لازم است (فعلی: ${gate.cutting_pack_qty}) تا بهای محصول فروش‌پذیر نهایی شود.`,
        });
      }
    }
  }

  const incomplete = reasons.length > 0;
  return {
    requires_fabric_cutting: !!gate.requires_fabric_cutting,
    lay_count: lays.length,
    cutting_lay_qty: Number(gate.cutting_lay_qty) || 0,
    cutting_pack_qty: Number(gate.cutting_pack_qty) || 0,
    actual_meters: round2(agg.actual_meters),
    matrix_meters: round2(agg.matrix_meters),
    fabric_variance_m: round2(agg.actual_meters - agg.matrix_meters),
    waste_normal_m: round2(agg.waste_normal_m),
    waste_abnormal_m: round2(agg.waste_abnormal_m),
    lay_amount_rial: agg.lay_amount_rial,
    lay_waste_rial: agg.lay_waste_rial,
    order_abnormal_waste_rial: Math.round(Number(order.abnormal_waste_rial) || 0),
    incomplete,
    incomplete_reasons: reasons,
    cost_final: !incomplete,
  };
}

function kanban(db, { ccFilter } = {}) {
  const cc = ccSqlFilter(ccFilter, 's.cost_center_id');
  const stages = db.prepare(`
    SELECT s.id AS stage_id, s.order_id, s.seq, s.status, s.qty_in, s.qty_out,
           s.product_scope, s.scoped_product_id, sp.name AS scoped_product_name,
           po.order_no, po.qty_planned, po.product_id, po.bom_id, po.fg_plan_json,
           p.name AS product_name,
           cc.code AS cc_code, cc.name AS cc_name
    FROM production_order_stages s
    JOIN production_orders po ON po.id = s.order_id
    JOIN products p ON p.id = po.product_id
    LEFT JOIN products sp ON sp.id = s.scoped_product_id
    JOIN cost_centers cc ON cc.id = s.cost_center_id
    WHERE po.status IN ('released', 'in_progress', 'completed')
      AND s.status IN ('pending', 'in_progress', 'done', 'blocked')
      ${cc.sql}
    ORDER BY cc.seq, s.seq, po.date
  `).all(...cc.params);

  const planCache = new Map();
  try {
    const { orderFgPlanRows } = require('./bom');
    for (const s of stages) {
      if (!planCache.has(s.order_id)) {
        let plan = [];
        try {
          if (s.bom_id) plan = orderFgPlanRows(db, s);
        } catch { plan = []; }
        planCache.set(s.order_id, plan.length > 1 ? plan.map(p => ({
          product_id: p.product_id,
          product_name: p.product_name,
          qty_planned: p.qty_planned,
        })) : []);
      }
      s.fg_plan = planCache.get(s.order_id);
      s.is_multiproduct = s.fg_plan.length > 1;
      delete s.fg_plan_json;
    }
  } catch { /* plan stays off the card; the stage qty is still there */ }

  const columns = {};
  for (const s of stages) {
    const key = s.cc_code || 'unknown';
    if (!columns[key]) columns[key] = { cc_code: s.cc_code, cc_name: s.cc_name, cards: [] };
    if (s.status === 'in_progress' || s.status === 'blocked') {
      columns[key].cards.push(s);
    }
  }

  return {
    data: { columns: Object.values(columns), all_stages: stages },
    totals: { open_orders: new Set(stages.map(s => s.order_id)).size },
  };
}

function wipReport(db, { date } = {}) {
  const asOf = date || todayJalali();
  const wipCode = wipAccountCode(db);

  const ledgerWip = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(NULLIF(jl.debit_rial,0), ROUND(jl.debit), 0)), 0) -
           COALESCE(SUM(COALESCE(NULLIF(jl.credit_rial,0), ROUND(jl.credit), 0)), 0) bal
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.account_code = ? AND je.entry_date <= ?
      AND COALESCE(je.deleted_at, 0) = 0 AND ${jeNotDraftFor(db)}
  `).get(wipCode, asOf)?.bal || 0;

  const rows = db.prepare(`
    SELECT po.id AS order_id, po.order_no, p.name AS product_name, po.status,
           po.qty_planned, po.qty_produced, po.date AS start_date,
           COALESCE(v.wip_rial, 0) AS wip_rial,
           (SELECT COUNT(*) FROM production_order_stages WHERE order_id = po.id AND status = 'done') AS stages_done,
           (SELECT COUNT(*) FROM production_order_stages WHERE order_id = po.id) AS stages_total
    FROM production_orders po
    JOIN products p ON p.id = po.product_id
    LEFT JOIN v_wip_by_order v ON v.order_id = po.id
    WHERE po.status IN ('released', 'in_progress', 'completed')
       OR COALESCE(v.wip_rial, 0) <> 0
    ORDER BY wip_rial DESC
  `).all();

  const sumOrders = rows.reduce((s, r) => s + Math.round(Number(r.wip_rial) || 0), 0);
  const diff = Math.round(Number(ledgerWip) - sumOrders);
  const warnings = [];
  if (Math.abs(diff) > 5) {
    warnings.push({ code: 'W_LEDGER_MISMATCH', diff_rial: diff, ledger_rial: Math.round(ledgerWip), orders_rial: sumOrders });
  }

  return {
    data: { rows, as_of: asOf, ledger_wip_rial: Math.round(Number(ledgerWip)), orders_wip_rial: sumOrders },
    totals: { wip_rial: sumOrders, ledger_rial: Math.round(Number(ledgerWip)), diff_rial: diff },
    warnings,
    reconcile: () => ({ ledger: Math.round(Number(ledgerWip)), calculated: sumOrders, diff }),
  };
}

function varianceMatrix(db, { period, ccFilter } = {}) {
  period = resolvePeriod(period);
  const cc = ccSqlFilter(ccFilter);
  const params = [period, ...cc.params];
  const rows = db.prepare(`
    SELECT v.variance_type, v.cost_center_id, cc.code AS cc_code, cc.name AS cc_name,
           s.seq AS stage_seq,
           SUM(v.amount_rial) AS amount_rial,
           COUNT(DISTINCT v.order_id) AS order_count
    FROM production_variances v
    LEFT JOIN cost_centers cc ON cc.id = v.cost_center_id
    LEFT JOIN production_order_stages s ON s.id = v.stage_id
    WHERE v.period_label = ? ${cc.sql.replace(/cost_center_id/g, 'v.cost_center_id')}
    GROUP BY v.variance_type, v.cost_center_id, s.seq
    ORDER BY cc.code, v.variance_type
  `).all(...params);

  const matrix = {};
  for (const r of rows) {
    const ccKey = r.cc_code || 'unknown';
    if (!matrix[ccKey]) matrix[ccKey] = { cc_code: r.cc_code, cc_name: r.cc_name, types: {} };
    matrix[ccKey].types[r.variance_type] = Math.round(Number(r.amount_rial) || 0);
  }

  return {
    data: { matrix: Object.values(matrix), rows },
    totals: { total_rial: rows.reduce((s, r) => s + Math.round(Number(r.amount_rial) || 0), 0) },
  };
}

function overheadVariance(db, { period } = {}) {
  period = resolvePeriod(period);
  const { from, to } = periodRange(period);
  const ohCtrl = acct(db, 'coa_overhead_control').code;
  const ohApplied = acct(db, 'coa_overhead_applied').code;

  const rows = db.prepare(`
    SELECT cc.id, cc.code, cc.name, cc.coa_tafsili_oh,
           r.driver, r.budget_fixed_oh_rial, r.budget_var_oh_rial,
           r.budget_driver_qty, r.total_rate_rial, r.is_estimated,
           COALESCE(r.actual_oh_rial, 0) AS rate_actual_oh_rial,
           COALESCE(r.applied_oh_rial, 0) AS rate_applied_oh_rial,
           COALESCE(r.variance_rial, 0) AS rate_variance_rial
    FROM cost_centers cc
    LEFT JOIN cost_center_rates r ON r.cost_center_id = cc.id AND r.period_label = ?
    WHERE cc.kind = 'production' AND cc.active = 1
    ORDER BY cc.seq
  `).all(period);

  const enriched = rows.map(r => {
    let actualOh = Math.round(Number(r.rate_actual_oh_rial) || 0);
    let appliedOh = Math.round(Number(r.rate_applied_oh_rial) || 0);
    if (!actualOh && r.coa_tafsili_oh) {
      actualOh = Math.round(Number(db.prepare(`
        SELECT COALESCE(SUM(COALESCE(NULLIF(jl.debit_rial,0), ROUND(jl.debit), 0)), 0) -
               COALESCE(SUM(COALESCE(NULLIF(jl.credit_rial,0), ROUND(jl.credit), 0)), 0) bal
        FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE jl.account_code = ? AND jl.detail_account_id = ?
          AND je.entry_date BETWEEN ? AND ? AND COALESCE(je.deleted_at, 0) = 0 AND ${jeNotDraftFor(db)}
      `).get(ohCtrl, r.coa_tafsili_oh, from, to)?.bal) || 0);
    }
    if (!appliedOh && r.coa_tafsili_oh) {
      appliedOh = Math.round(Number(db.prepare(`
        SELECT COALESCE(SUM(COALESCE(NULLIF(jl.credit_rial,0), ROUND(jl.credit), 0)), 0) -
               COALESCE(SUM(COALESCE(NULLIF(jl.debit_rial,0), ROUND(jl.debit), 0)), 0) bal
        FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE jl.account_code = ? AND jl.detail_account_id = ?
          AND je.entry_date BETWEEN ? AND ? AND COALESCE(je.deleted_at, 0) = 0 AND ${jeNotDraftFor(db)}
      `).get(ohApplied, r.coa_tafsili_oh, from, to)?.bal) || 0);
    }
    const variance = actualOh - appliedOh;
    return {
      ...r,
      budget_total_rial: Math.round(Number(r.budget_fixed_oh_rial) || 0) + Math.round(Number(r.budget_var_oh_rial) || 0),
      actual_oh_rial: actualOh,
      applied_oh_rial: appliedOh,
      variance_rial: variance,
    };
  });

  const totalVar = enriched.reduce((s, r) => s + r.variance_rial, 0);
  return {
    data: { rows: enriched, period, from, to },
    totals: {
      actual_rial: enriched.reduce((s, r) => s + r.actual_oh_rial, 0),
      applied_rial: enriched.reduce((s, r) => s + r.applied_oh_rial, 0),
      variance_rial: totalVar,
    },
  };
}

function wasteAnalysis(db, { period, ccId, type, ccFilter } = {}) {
  period = resolvePeriod(period);
  const cc = ccSqlFilter(ccFilter);
  const params = [period];
  let where = ' WHERE w.period_label = ?';
  if (ccId) { where += ' AND w.cost_center_id=?'; params.push(Number(ccId)); }
  if (type) { where += ' AND w.waste_type=?'; params.push(type); }
  where += cc.sql.replace(/cost_center_id/g, 'w.cost_center_id');
  params.push(...cc.params);

  const rows = db.prepare(`
    SELECT w.*, cc.code AS cc_code, cc.name AS cc_name, p.name AS product_name
    FROM production_waste w
    LEFT JOIN cost_centers cc ON cc.id = w.cost_center_id
    LEFT JOIN products p ON p.id = w.product_id
    ${where}
    ORDER BY w.date DESC
  `).all(...params);

  return {
    data: { rows },
    totals: {
      qty: rows.reduce((s, r) => s + Number(r.qty || 0), 0),
      cost_rial: rows.reduce((s, r) => s + Math.round(Number(r.cost_rial || r.amount_rial) || 0), 0),
    },
    meta: { empty: !rows.length, message: rows.length ? null : emptyMessage(period) },
  };
}

function yieldAnalysis(db, { period, productId, ccFilter } = {}) {
  period = resolvePeriod(period);
  const cc = ccSqlFilter(ccFilter, 's.cost_center_id');
  const params = [period];
  let where = ' WHERE po.period_label = ?';
  if (productId) { where += ' AND po.product_id=?'; params.push(Number(productId)); }
  where += cc.sql;
  params.push(...cc.params);

  const rows = db.prepare(`
    SELECT s.seq, cc.code AS cc_code, cc.name AS cc_name,
           SUM(s.qty_in) AS qty_in, SUM(s.qty_out) AS qty_out,
           CASE WHEN SUM(s.qty_in) > 0
                THEN ROUND(SUM(s.qty_out) * 100.0 / SUM(s.qty_in), 2) ELSE NULL END AS yield_pct
    FROM production_order_stages s
    JOIN production_orders po ON po.id = s.order_id
    JOIN cost_centers cc ON cc.id = s.cost_center_id
    ${where} AND s.status <> 'skipped'
    GROUP BY s.seq, cc.code, cc.name
    ORDER BY s.seq
  `).all(...params);

  const orderYield = db.prepare(`
    SELECT po.id, po.order_no, v.yield_pct
    FROM production_orders po
    JOIN v_order_cost_summary v ON v.order_id = po.id
    WHERE po.period_label = ? AND po.status IN ('completed', 'closed')
  `).all(period);

  return {
    data: { by_stage: rows, by_order: orderYield },
    totals: {
      avg_yield_pct: orderYield.length
        ? round2(orderYield.reduce((s, r) => s + Number(r.yield_pct || 0), 0) / orderYield.length)
        : null,
    },
  };
}

function periodCost(db, { period, compare } = {}) {
  period = resolvePeriod(period);
  const cur = db.prepare(`
    SELECT
      COALESCE(SUM(material_cost_rial), 0) material_rial,
      COALESCE(SUM(packaging_cost_rial), 0) packaging_rial,
      COALESCE(SUM(labor_cost_rial), 0) labor_rial,
      COALESCE(SUM(subcontract_cost_rial), 0) subcontract_rial,
      COALESCE(SUM(overhead_cost_rial), 0) overhead_rial,
      COALESCE(SUM(total_cost_rial), 0) total_rial,
      COALESCE(SUM(qty_produced), 0) qty_produced
    FROM production_orders
    WHERE period_label = ? AND status IN ('completed', 'closed')
  `).get(period);

  let prev = null;
  if (compare === 'prev' || compare === 'previous') {
    prev = db.prepare(`
      SELECT COALESCE(SUM(total_cost_rial), 0) total_rial,
             COALESCE(SUM(qty_produced), 0) qty_produced
      FROM production_orders
      WHERE period_label = ? AND status IN ('completed', 'closed')
    `).get(prevPeriod(period));
  }

  return {
    data: { current: cur, previous: prev, period },
    totals: {
      total_rial: Math.round(Number(cur?.total_rial) || 0),
      unit_cost_rial: cur?.qty_produced
        ? Math.round(Number(cur.total_rial) / Number(cur.qty_produced)) : 0,
    },
  };
}

function stdVsActual(db, { period, productId } = {}) {
  period = resolvePeriod(period);
  const params = [period];
  let where = ' WHERE period_label = ? AND status IN (\'completed\', \'closed\')';
  if (productId) { where += ' AND product_id=?'; params.push(Number(productId)); }

  const rows = db.prepare(`
    SELECT id AS order_id, order_no, product_id, qty_produced,
           std_total_rial, std_unit_rial, total_cost_rial, unit_cost_rial,
           (total_cost_rial - std_total_rial) AS variance_rial,
           CASE WHEN std_unit_rial > 0
                THEN ROUND((unit_cost_rial - std_unit_rial) * 100.0 / std_unit_rial, 2)
                ELSE NULL END AS variance_pct
    FROM production_orders ${where}
    ORDER BY order_no
  `).all(...params);

  return { data: { rows }, totals: { count: rows.length } };
}

function unitCostTrend(db, { productId, months = 6 } = {}) {
  const n = Math.min(Math.max(Number(months) || 6, 1), 24);
  const params = [];
  let where = ` WHERE pr.qty > 0`;
  if (productId) { where += ' AND pr.product_id=?'; params.push(Number(productId)); }

  const rows = db.prepare(`
    SELECT pr.period_label, pr.product_id, p.name AS product_name,
           SUM(pr.qty) AS qty,
           CASE WHEN SUM(pr.qty) > 0
                THEN ROUND(SUM(pr.amount_rial) * 1.0 / SUM(pr.qty)) ELSE 0 END AS unit_cost_rial
    FROM production_receipts pr
    JOIN products p ON p.id = pr.product_id
    ${where}
    GROUP BY pr.period_label, pr.product_id
    ORDER BY pr.period_label DESC
    LIMIT ?
  `).all(...params, n);

  return { data: { series: rows.reverse() }, totals: { points: rows.length } };
}

function materialUsage(db, { period, ccFilter } = {}) {
  period = resolvePeriod(period);
  const cc = ccSqlFilter(ccFilter);
  const params = [period, ...cc.params];
  // مصرف واقعی از qty_actual (ستون qty در جدول وجود ندارد)
  const rows = db.prepare(`
    SELECT mi.product_id, p.name AS product_name,
           SUM(mi.qty_actual) AS qty, SUM(mi.amount_rial) AS amount_rial
    FROM production_material_issues mi
    JOIN products p ON p.id = mi.product_id
    WHERE mi.period_label = ?
      AND COALESCE(mi.status, 'posted') = 'posted'
      ${cc.sql.replace(/cost_center_id/g, 'mi.cost_center_id')}
    GROUP BY mi.product_id
    ORDER BY amount_rial DESC
  `).all(...params);

  return {
    data: { rows },
    totals: { amount_rial: rows.reduce((s, r) => s + Math.round(Number(r.amount_rial) || 0), 0) },
    meta: { empty: !rows.length, message: rows.length ? null : emptyMessage(period) },
  };
}

function bottleneck(db, { period } = {}) {
  period = resolvePeriod(period);
  const rows = db.prepare(`
    SELECT cc.code, cc.name, cc.capacity_units,
           COUNT(DISTINCT s.order_id) AS orders,
           SUM(CASE WHEN s.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
           SUM(CASE WHEN s.status = 'done' THEN 1 ELSE 0 END) AS done_count,
           CASE WHEN cc.capacity_units > 0
                THEN ROUND(COUNT(*) * 100.0 / cc.capacity_units, 1) ELSE NULL END AS load_pct
    FROM production_order_stages s
    JOIN cost_centers cc ON cc.id = s.cost_center_id
    JOIN production_orders po ON po.id = s.order_id
    WHERE po.period_label = ? AND s.status <> 'skipped'
    GROUP BY cc.id
    ORDER BY CASE WHEN load_pct IS NULL THEN 1 ELSE 0 END, load_pct DESC, cc.seq
  `).all(period);

  const bottleneckCc = rows.find(r => r.load_pct >= 80) || rows[0] || null;
  return { data: { rows, bottleneck: bottleneckCc }, totals: { centers: rows.length } };
}

function productProfitability(db, { period } = {}) {
  period = resolvePeriod(period);
  const rows = db.prepare(`
    SELECT po.product_id, p.name AS product_name,
           SUM(po.qty_produced) AS qty_produced,
           SUM(po.total_cost_rial) AS production_cost_rial,
           COALESCE(p.price, 0) * 10 AS list_price_rial
    FROM production_orders po
    JOIN products p ON p.id = po.product_id
    WHERE po.period_label = ? AND po.status IN ('completed', 'closed')
    GROUP BY po.product_id
  `).all(period);

  const enriched = rows.map(r => {
    const revenue = Math.round(Number(r.list_price_rial) * Number(r.qty_produced));
    const cost = Math.round(Number(r.production_cost_rial) || 0);
    return {
      ...r,
      revenue_rial: revenue,
      profit_rial: revenue - cost,
      margin_pct: revenue ? round2((revenue - cost) * 100 / revenue) : null,
    };
  });

  return {
    data: { rows: enriched },
    totals: { profit_rial: enriched.reduce((s, r) => s + r.profit_rial, 0) },
  };
}

function monthlyProfit(db, { period } = {}) {
  period = resolvePeriod(period);
  const { from, to } = periodRange(period);
  const row = db.prepare('SELECT * FROM production_period_close WHERE period_label=?').get(period);

  const bal = (key) => {
    const code = acct(db, key).code;
    return Math.round(Number(db.prepare(`
      SELECT COALESCE(SUM(COALESCE(NULLIF(jl.debit_rial,0), ROUND(jl.debit), 0)), 0) -
             COALESCE(SUM(COALESCE(NULLIF(jl.credit_rial,0), ROUND(jl.credit), 0)), 0) b
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.account_code = ? AND je.entry_date BETWEEN ? AND ?
        AND COALESCE(je.deleted_at, 0) = 0 AND ${jeNotDraftFor(db)}
    `).get(code, from, to)?.b) || 0);
  };

  const balAt = (key, date) => ledgerBalance(db, key, date);

  const salesGross = -bal('coa_sales');
  const discount = bal('coa_sales_discount');
  const salesNet = salesGross - discount;

  const prod = db.prepare(`
    SELECT COALESCE(SUM(material_cost_rial), 0) material_rial,
           COALESCE(SUM(packaging_cost_rial), 0) packaging_rial,
           COALESCE(SUM(labor_cost_rial), 0) labor_rial,
           COALESCE(SUM(subcontract_cost_rial), 0) subcontract_rial,
           COALESCE(SUM(overhead_cost_rial), 0) overhead_rial,
           COALESCE(SUM(total_cost_rial), 0) total_rial
    FROM production_orders
    WHERE period_label = ? AND status IN ('completed', 'closed')
  `).get(period);

  const fgOpen = balAt('coa_finished_goods', addDaysToJalali(from, -1));
  const fgClose = balAt('coa_finished_goods', to);
  const wipOpen = balAt('coa_wip', addDaysToJalali(from, -1));
  const wipClose = balAt('coa_wip', to);
  const cogsLedger = bal('coa_cogs');

  const periodRow = db.prepare('SELECT * FROM production_period_close WHERE period_label=?').get(period);

  const variances = db.prepare(`
    SELECT variance_type,
           SUM(amount_rial) total_rial,
           SUM(alloc_wip_rial) wip_rial,
           SUM(alloc_fg_rial) fg_rial,
           SUM(alloc_cogs_rial) cogs_rial
    FROM production_variances
    WHERE period_label = ? AND status = 'allocated'
    GROUP BY variance_type
  `).all(period);

  let varToCogs = variances.reduce((s, v) => s + Math.round(Number(v.cogs_rial) || 0), 0);
  let varianceRows = variances;

  if (!varianceRows.length && periodRow?.status === 'closed') {
    varToCogs = Math.round(Number(periodRow.variance_to_cogs_rial) || 0);
    varianceRows = [
      {
        variance_type: 'overhead',
        total_rial: Math.round(Number(periodRow.total_variance_rial) || 0),
        wip_rial: Math.round(Number(periodRow.variance_to_wip_rial) || 0),
        fg_rial: Math.round(Number(periodRow.variance_to_fg_rial) || 0),
        cogs_rial: varToCogs,
      },
    ];
  }
  const cogsStandard = cogsLedger - varToCogs;

  const abnormalWaste = bal('coa_abnormal_waste');
  const reworkCost = bal('coa_rework_cost');

  const grossProfit = salesNet - cogsLedger;
  const opProfit = grossProfit - abnormalWaste - reworkCost;

  const checks = {
    labor_control_zero: Math.abs(balAt('coa_labor_control', to)) <= 5,
    overhead_control_zero: Math.abs(balAt('coa_overhead_control', to)) <= 5,
    overhead_applied_zero: Math.abs(balAt('coa_overhead_applied', to)) <= 5,
    fg_matches_ledger: true,
    wip_matches_ledger: Math.abs(wipClose - sumOrderWip(db)) <= 5,
    cogs_matches_ledger: true,
  };

  return {
    data: {
      period,
      period_status: row?.status || 'open',
      closed_at: row?.closed_at || null,
      sales: { gross_rial: salesGross, discount_rial: discount, net_rial: salesNet },
      production: prod,
      inventory: {
        fg_open_rial: fgOpen, fg_close_rial: fgClose,
        wip_open_rial: wipOpen, wip_close_rial: wipClose,
      },
      cogs: {
        standard_rial: cogsStandard,
        variance_rial: varToCogs,
        total_rial: cogsLedger,
      },
      variances: varianceRows,
      period_expenses: {
        abnormal_waste_rial: abnormalWaste,
        rework_rial: reworkCost,
      },
      checks,
    },
    totals: {
      gross_profit_rial: grossProfit,
      gross_margin_pct: salesNet ? round2(grossProfit / salesNet * 100) : 0,
      operating_profit_rial: opProfit,
      operating_margin_pct: salesNet ? round2(opProfit / salesNet * 100) : 0,
    },
  };
}

const DASH_CACHE = new Map();

function dashboard(db, { period } = {}) {
  period = resolvePeriod(period);
  const key = `dash:${period}`;
  const cached = DASH_CACHE.get(key);
  if (cached && Date.now() - cached.at < 300_000) return cached.data;

  const prev = prevPeriod(period);
  const kpiSql = `
    SELECT COALESCE(SUM(qty_produced), 0) qty,
           CASE WHEN SUM(qty_produced) > 0
                THEN ROUND(SUM(total_cost_rial) * 1.0 / SUM(qty_produced)) ELSE 0 END unit_cost,
           COALESCE(SUM(abnormal_waste_rial), 0) abnormal,
           CASE WHEN SUM(qty_produced + qty_waste_normal + qty_waste_abnormal) > 0
                THEN ROUND(SUM(qty_produced) * 100.0
                     / SUM(qty_produced + qty_waste_normal + qty_waste_abnormal), 2) ELSE 0 END yield
    FROM production_orders WHERE period_label = ? AND status IN ('completed', 'closed')`;

  const cur = db.prepare(kpiSql).get(period) || {};
  const old = db.prepare(kpiSql).get(prev) || {};
  const delta = (a, b) => (b ? round2((Number(a) - Number(b)) / Number(b) * 100) : 0);

  let wipRows = { c: 0, s: 0 };
  try {
    wipRows = db.prepare(`
      SELECT COUNT(*) c, COALESCE(SUM(wip_rial), 0) s FROM v_wip_by_order WHERE wip_rial > 0
    `).get() || wipRows;
  } catch { /* view may be missing on fresh boot */ }

  let oh = { totals: { variance_rial: 0 } };
  let vm = { data: { matrix: [] } };
  let costMix = {};
  let trend = { data: { series: [] } };
  let mp = { totals: { gross_margin_pct: 0, gross_profit_rial: 0 } };
  try { oh = overheadVariance(db, { period }); } catch { /* empty period ok */ }
  try { vm = varianceMatrix(db, { period }); } catch { /* empty */ }
  try { costMix = periodCost(db, { period }).data?.current || {}; } catch { /* empty */ }
  try { trend = unitCostTrend(db, { months: 6 }); } catch { /* empty */ }
  try { mp = monthlyProfit(db, { period }); } catch { /* ledger/CoA gaps */ }

  let openOrders = [];
  try {
    openOrders = db.prepare(`
      SELECT po.id, po.order_no, p.name AS product_name, po.qty_planned, po.status, po.date
      FROM production_orders po JOIN products p ON p.id = po.product_id
      WHERE po.status IN ('released', 'in_progress') ORDER BY po.date LIMIT 20
    `).all();
  } catch { openOrders = []; }

  const data = {
    period,
    kpis: {
      produced: { value: cur.qty || 0, delta_pct: delta(cur.qty, old.qty) },
      unit_cost: { value_rial: cur.unit_cost || 0, delta_pct: delta(cur.unit_cost, old.unit_cost) },
      yield: { value_pct: cur.yield || 0, delta_pct: delta(cur.yield, old.yield) },
      abnormal: { value_rial: cur.abnormal || 0, delta_pct: delta(cur.abnormal, old.abnormal) },
      wip: { value_rial: Math.round(Number(wipRows?.s) || 0), orders: wipRows?.c || 0 },
      oh_variance: { value_rial: oh.totals?.variance_rial || 0 },
      gross_margin: {
        value_pct: mp.totals?.gross_margin_pct || 0,
        profit_rial: mp.totals?.gross_profit_rial || 0,
      },
    },
    trends: { unit_cost: trend },
    variances: vm.data?.matrix || [],
    alerts: [],
    open_orders: openOrders,
    cost_mix: costMix,
  };

  if (Math.abs(cur.abnormal || 0) > 0 && delta(cur.abnormal, old.abnormal) > 20) {
    data.alerts.push({ level: 'warning', message: 'رشد ضایعات غیرعادی' });
  }

  DASH_CACHE.set(key, { at: Date.now(), data });
  return { data, totals: data.kpis };
}

function reconciliation(db, { date } = {}) {
  const asOf = date || todayJalali();
  const rows = [];

  const check = (label, ledgerKey, calcFn) => {
    const ledger = ledgerBalance(db, ledgerKey, asOf);
    const calc = calcFn();
    rows.push({
      label,
      ledger_rial: ledger,
      calculated_rial: calc,
      diff_rial: ledger - calc,
      ok: Math.abs(ledger - calc) <= 5,
    });
  };

  check('کالای در جریان ساخت', 'coa_wip', () => sumOrderWip(db));

  check('موجودی کالای ساخته‌شده', 'coa_finished_goods', () => {
    const prods = db.prepare(`
      SELECT stock, average_cost_rial FROM products
      WHERE COALESCE(stock, 0) > 0 AND item_type = 'finished'
    `).all();
    return prods.reduce((s, r) => s + Math.round(Number(r.stock) * Number(r.average_cost_rial)), 0);
  });

  // ADR-003 / P3: control accounts should be ~0 after a clean period close
  for (const [label, key] of [
    ['کنترل دستمزد ۵۲۰۱', 'coa_labor_control'],
    ['کنترل سربار ۵۲۰۲', 'coa_overhead_control'],
    ['سربار جذب‌شده ۵۲۰۳', 'coa_overhead_applied'],
  ]) {
    const bal = ledgerBalance(db, key, asOf);
    rows.push({
      label,
      ledger_rial: bal,
      calculated_rial: 0,
      diff_rial: bal,
      ok: Math.abs(bal) <= 5,
      note: 'پس از بستن دوره باید ≈۰ باشد',
    });
  }

  return {
    data: { rows, as_of: asOf },
    totals: { mismatches: rows.filter(r => !r.ok).length },
  };
}

function cycleTime(db, { period, productId } = {}) {
  period = resolvePeriod(period);
  const params = [period];
  let where = ' WHERE po.period_label = ?';
  if (productId) { where += ' AND po.product_id=?'; params.push(Number(productId)); }

  const rows = db.prepare(`
    SELECT s.seq, cc.code, cc.name,
           AVG(CASE WHEN s.started_at IS NOT NULL AND s.ended_at IS NOT NULL
               THEN (s.ended_at - s.started_at) / 86400.0 ELSE NULL END) AS avg_days
    FROM production_order_stages s
    JOIN production_orders po ON po.id = s.order_id
    JOIN cost_centers cc ON cc.id = s.cost_center_id
    ${where} AND s.status = 'done'
    GROUP BY s.seq, cc.code, cc.name
    ORDER BY s.seq
  `).all(...params);

  return { data: { rows }, totals: { stages: rows.length } };
}

function reworkReport(db, { period } = {}) {
  period = resolvePeriod(period);
  const rows = db.prepare(`
    SELECT r.*, po.order_no, cc.code AS cc_code
    FROM production_rework r
    LEFT JOIN production_orders po ON po.id = r.order_id
    LEFT JOIN cost_centers cc ON cc.id = r.cost_center_id
    WHERE r.period_label = ?
    ORDER BY r.date DESC
  `).all(period);

  return {
    data: { rows },
    totals: {
      count: rows.length,
      cost_rial: rows.reduce((s, r) => s + Math.round(Number(r.cost_rial || r.amount_rial) || 0), 0),
    },
  };
}

function costCenterPerformance(db, { period, ccFilter } = {}) {
  period = resolvePeriod(period);
  const cc = ccSqlFilter(ccFilter, 's.cost_center_id');
  const rows = db.prepare(`
    SELECT cc.code, cc.name,
           COUNT(DISTINCT s.order_id) AS orders,
           SUM(s.qty_out) AS qty_out,
           SUM(s.labor_rial) AS labor_rial,
           SUM(s.overhead_rial) AS overhead_rial
    FROM production_order_stages s
    JOIN production_orders po ON po.id = s.order_id
    JOIN cost_centers cc ON cc.id = s.cost_center_id
    WHERE po.period_label = ? ${cc.sql}
    GROUP BY cc.id ORDER BY cc.seq
  `).all(period, ...cc.params);

  return { data: { rows }, totals: { centers: rows.length } };
}

function materialVariance(db, { period, productId } = {}) {
  period = resolvePeriod(period);
  const params = [period];
  let where = ' WHERE v.period_label = ? AND v.variance_type LIKE \'material%\'';
  if (productId) { where += ' AND po.product_id=?'; params.push(Number(productId)); }

  const rows = db.prepare(`
    SELECT v.*, po.order_no, p.name AS product_name
    FROM production_variances v
    JOIN production_orders po ON po.id = v.order_id
    LEFT JOIN products p ON p.id = po.product_id
    ${where}
    ORDER BY ABS(v.amount_rial) DESC
  `).all(...params);

  return { data: { rows }, totals: { total_rial: rows.reduce((s, r) => s + Math.round(Number(r.amount_rial) || 0), 0) } };
}

function varianceReasons(db, { period } = {}) {
  period = resolvePeriod(period);
  const rows = db.prepare(`
    SELECT COALESCE(mi.reason_code, mi.note, 'سایر') AS reason,
           SUM(COALESCE(v.amount_rial, 0)) AS amount_rial,
           COUNT(*) AS cnt
    FROM production_material_issues mi
    LEFT JOIN production_variances v ON v.order_id = mi.order_id AND v.period_label = mi.period_label
    WHERE mi.period_label = ?
    GROUP BY reason ORDER BY amount_rial DESC
  `).all(period);

  const total = rows.reduce((s, r) => s + Math.abs(Math.round(Number(r.amount_rial) || 0)), 0) || 1;
  let cum = 0;
  const enriched = rows.map(r => {
    const amt = Math.abs(Math.round(Number(r.amount_rial) || 0));
    const pct = round2(amt * 100 / total);
    cum += pct;
    return { ...r, amount_rial: amt, pct, cumulative_pct: round2(cum) };
  });

  return { data: { rows: enriched }, totals: { total_rial: total } };
}

function subcontractorPerformance(db, { period } = {}) {
  period = resolvePeriod(period);
  const rows = db.prepare(`
    SELECT s.name AS supplier_name,
           COUNT(DISTINCT sc.order_id) AS orders,
           SUM(CASE WHEN sc.direction = 'out' THEN sc.qty ELSE 0 END) AS qty_sent,
           SUM(CASE WHEN sc.direction = 'in' THEN sc.qty ELSE 0 END) AS qty_received,
           SUM(COALESCE(sc.qty_lost, 0)) AS qty_lost,
           SUM(COALESCE(sc.fee_amount_rial, 0)) AS fee_rial
    FROM production_subcontract sc
    LEFT JOIN suppliers s ON s.id = sc.supplier_id
    WHERE sc.period_label = ? AND sc.status = 'posted'
    GROUP BY sc.supplier_id ORDER BY fee_rial DESC
  `).all(period);

  return { data: { rows }, totals: { fee_rial: rows.reduce((s, r) => s + Math.round(Number(r.fee_rial) || 0), 0) } };
}

function orderLedger(db, { orderId } = {}) {
  if (!orderId) throw err('E_ORDER_REQUIRED', 422);
  return costSheet(db, { orderId });
}

function valueAdded(db, { orderId } = {}) {
  const sheet = costSheet(db, { orderId });
  return {
    data: { stages: sheet.data.stages, order_id: Number(orderId) },
    totals: { stages: sheet.data.stages.length },
  };
}

// ─── Registry ───────────────────────────────────────────────────────────────

const REPORTS = {
  'PR-01': {
    code: 'PR-01', title: 'لیست سفارش‌های تولید', requiresCost: false,
    run: (db, p) => ordersList(db, p),
  },
  'PR-02': {
    code: 'PR-02', title: 'برگه بهای تمام‌شده', requiresCost: true,
    run: (db, p) => costSheet(db, { orderId: p.order_id || p.orderId }),
  },
  'PR-03': {
    code: 'PR-03', title: 'تابلوی وضعیت خط تولید', requiresCost: false,
    run: (db, p) => kanban(db, p),
  },
  'PR-04': {
    code: 'PR-04', title: 'دفتر سفارش', requiresCost: true,
    run: (db, p) => orderLedger(db, { orderId: p.order_id || p.orderId }),
  },
  'PR-05': {
    code: 'PR-05', title: 'زمان چرخه', requiresCost: false,
    run: (db, p) => cycleTime(db, p),
  },
  'PR-06': {
    code: 'PR-06', title: 'تحلیل بهای دوره', requiresCost: true,
    run: (db, p) => periodCost(db, p),
  },
  'PR-07': {
    code: 'PR-07', title: 'روند بهای واحد', requiresCost: true,
    run: (db, p) => unitCostTrend(db, { productId: p.product_id || p.productId, months: p.months }),
  },
  'PR-08': {
    code: 'PR-08', title: 'مقایسه استاندارد و واقعی', requiresCost: true,
    run: (db, p) => stdVsActual(db, p),
  },
  'PR-09': {
    code: 'PR-09', title: 'ارزش افزوده مرحله‌ای', requiresCost: true,
    run: (db, p) => valueAdded(db, { orderId: p.order_id || p.orderId }),
  },
  'PR-10': {
    code: 'PR-10', title: 'مانده WIP', requiresCost: true, reconcile: true,
    run: (db, p) => wipReport(db, p),
    reconcileFn: (db, p) => {
      const r = wipReport(db, p);
      return { ledger: r.data.ledger_wip_rial, calculated: r.data.orders_wip_rial, diff: r.totals.diff_rial };
    },
  },
  'PR-11': {
    code: 'PR-11', title: 'ماتریس انحراف', requiresCost: true,
    run: (db, p) => varianceMatrix(db, p),
  },
  'PR-12': {
    code: 'PR-12', title: 'انحراف مواد', requiresCost: true,
    run: (db, p) => materialVariance(db, p),
  },
  'PR-13': {
    code: 'PR-13', title: 'پارتو دلایل انحراف', requiresCost: true,
    run: (db, p) => varianceReasons(db, p),
  },
  'PR-14': {
    code: 'PR-14', title: 'کسر/اضافه جذب سربار', requiresCost: true,
    run: (db, p) => overheadVariance(db, p),
  },
  'PR-15': {
    code: 'PR-15', title: 'تحلیل ضایعات', requiresCost: true,
    run: (db, p) => wasteAnalysis(db, p),
  },
  'PR-16': {
    code: 'PR-16', title: 'بهره‌وری', requiresCost: false,
    run: (db, p) => yieldAnalysis(db, p),
  },
  'PR-17': {
    code: 'PR-17', title: 'دوباره‌کاری', requiresCost: true,
    run: (db, p) => reworkReport(db, p),
  },
  'PR-18': {
    code: 'PR-18', title: 'عملکرد مراکز هزینه', requiresCost: true,
    run: (db, p) => costCenterPerformance(db, p),
  },
  'PR-19': {
    code: 'PR-19', title: 'گلوگاه', requiresCost: false,
    run: (db, p) => bottleneck(db, p),
  },
  'PR-20': {
    code: 'PR-20', title: 'مصرف مواد', requiresCost: true,
    run: (db, p) => materialUsage(db, p),
  },
  'PR-21': {
    code: 'PR-21', title: 'عملکرد پیمانکاران', requiresCost: true,
    run: (db, p) => subcontractorPerformance(db, p),
  },
  'PR-22': {
    code: 'PR-22', title: 'سودآوری محصول', requiresCost: true,
    run: (db, p) => productProfitability(db, p),
  },
  'PR-23': {
    code: 'PR-23', title: 'سود دقیق ماهانه', requiresCost: true,
    allowedRoles: ['admin', 'accounting'],
    run: (db, p) => monthlyProfit(db, p),
  },
  'PR-24': {
    code: 'PR-24', title: 'داشبورد تولید', requiresCost: false, hideProfitForRoles: ['production_manager', 'sales_manager'],
    run: (db, p) => dashboard(db, p),
  },
  'PR-99': {
    code: 'PR-99', title: 'گزارش مغایرت', requiresCost: true, allowedRoles: ['admin', 'accounting'],
    run: (db, p) => reconciliation(db, p),
  },
};

function catalog() {
  return Object.values(REPORTS).map(r => ({
    code: r.code,
    title: r.title,
    requires_cost: !!r.requiresCost,
  }));
}

function assertReportAccess(db, user, spec) {
  if (!hasPermission(db, user, 'production_reports', 'view')) {
    throw err('E_FORBIDDEN', 403);
  }
  if (spec.requiresCost && !canSeeCost(db, user)) {
    throw err('E_FORBIDDEN', 403);
  }
  if (spec.allowedRoles && !spec.allowedRoles.includes(user.role) && user.role !== 'admin') {
    throw err('E_FORBIDDEN', 403);
  }
}

function runReport(db, { name, params = {}, user }) {
  const t0 = Date.now();
  const spec = REPORTS[name];
  if (!spec) throw err('E_NOT_FOUND', 404, { name });

  assertReportAccess(db, user, spec);
  // Period-scoped reports (and payload meta) default to current Jalali YYYY/MM.
  const paramsWithPeriod = {
    ...params,
    period: (params.period == null || params.period === '')
      ? todayJalali().slice(0, 7)
      : params.period,
  };
  validateReportParams(paramsWithPeriod);

  const ccFilter = costCenterFilter(db, user.id);
  const runParams = { ...paramsWithPeriod, ccFilter };

  const result = spec.run(db, runParams);
  const warnings = [...(result.warnings || [])];

  if (spec.reconcile && spec.reconcileFn) {
    const r = spec.reconcileFn(db, runParams);
    if (Math.abs(r.diff) > 5) {
      warnings.push(`مغایرت ${r.diff} ریال با دفتر کل`);
    }
  }

  if (paramsWithPeriod.period && isPeriodOpen(db, paramsWithPeriod.period)) {
    warnings.push(`دوره ${paramsWithPeriod.period} هنوز بسته نشده — اعداد موقتی هستند`);
  }

  let payload = {
    report: name,
    title: spec.title,
    period: paramsWithPeriod.period || null,
    generated_at: `${todayJalali()} ${nowHHMM()}`,
    filters: paramsWithPeriod,
    ...result,
  };

  if (!canSeeCost(db, user)) {
    payload = stripCostFields(payload);
  }
  if (spec.hideProfitForRoles && spec.hideProfitForRoles.includes(user.role)) {
    if (payload.data?.kpis?.gross_margin) delete payload.data.kpis.gross_margin;
  }

  const dur = Date.now() - t0;
  payload.meta = {
    ...(payload.meta || {}),
    row_count: countRows(result),
    duration_ms: dur,
    period_status: paramsWithPeriod.period ? periodStatus(db, paramsWithPeriod.period) : null,
    ledger_reconciled: !warnings.some(w => String(w).includes('مغایرت') || w?.code === 'W_LEDGER_MISMATCH'),
    cost_hidden: !canSeeCost(db, user),
  };
  payload.warnings = warnings;

  return payload;
}

function tableChecksum(db, tables) {
  const h = crypto.createHash('sha256');
  for (const t of tables) {
    const rows = db.prepare(`SELECT * FROM ${t}`).all();
    h.update(t + JSON.stringify(rows));
  }
  return h.digest('hex');
}

module.exports = {
  REPORTS,
  catalog,
  runReport,
  ordersList,
  costSheet,
  kanban,
  wipReport,
  varianceMatrix,
  overheadVariance,
  wasteAnalysis,
  yieldAnalysis,
  periodCost,
  stdVsActual,
  unitCostTrend,
  materialUsage,
  bottleneck,
  productProfitability,
  monthlyProfit,
  dashboard,
  reconciliation,
  cycleTime,
  reworkReport,
  costCenterPerformance,
  materialVariance,
  varianceReasons,
  subcontractorPerformance,
  orderLedger,
  valueAdded,
  tableChecksum,
  periodRange,
  periodStatus,
};
