'use strict';
/**
 * Production Module 3 — material variance helpers (ADR-011: memo only, no JE).
 */
const { explodeBom } = require('./bom');
const { setting } = require('./costing');
const { err } = require('./posting');

function num(v) { return Number(v) || 0; }

function round6(n) {
  return Math.round(Number(n) * 1e6) / 1e6;
}

/** Two-variance split: MPV=(AP−SP)×AQ, MQV=(AQ−SQ)×SP */
function computeVariance({ AQ, SQ, AP, SP }) {
  const aq = num(AQ);
  const sq = num(SQ);
  const ap = Math.round(num(AP));
  const sp = Math.round(num(SP));
  const varPrice = Math.round((ap - sp) * aq);
  const varQty = Math.round((aq - sq) * sp);
  const varTotal = varPrice + varQty;
  const pct = sq ? ((aq - sq) / sq) * 100 : (aq > 0 ? 100 : 0);
  return {
    varPrice,
    varQty,
    varTotal,
    pct,
    favorable: varTotal < 0,
    qty_variance: round6(aq - sq),
  };
}

function insertVarianceMemo(db, { period, orderId, productId, type, rial }) {
  if (!rial) return null;
  try {
    const info = db.prepare(`
      INSERT INTO production_variances
        (period_label, order_id, product_id, variance_type, amount_rial, status)
      VALUES (?,?,?,?,?,'memo')
    `).run(period, orderId, productId, type, Math.round(rial));
    return info.lastInsertRowid;
  } catch {
    return null;
  }
}

function varianceReasonThreshold(db) {
  const a = setting(db, 'production_variance_reason_pct', '');
  const b = setting(db, 'production_variance_reason_threshold_pct', '');
  const n = Number(a || b || '5');
  return Number.isFinite(n) ? n : 5;
}

function varianceAnalysis(db, orderId) {
  const po = db.prepare('SELECT * FROM production_orders WHERE id=?').get(orderId);
  if (!po) throw err('E_NOT_FOUND', 404);

  const lines = db.prepare(`
    SELECT product_id,
           SUM(qty_standard) AS qty_standard,
           SUM(qty_actual) AS qty_actual,
           SUM(std_amount_rial) AS std_amount_rial,
           SUM(amount_rial) AS amount_rial,
           SUM(var_price_rial) AS var_price_rial,
           SUM(var_qty_rial) AS var_qty_rial,
           MAX(std_cost_rial) AS std_cost_rial,
           AVG(unit_cost_rial) AS unit_cost_rial
    FROM production_material_issues
    WHERE order_id=? AND status='posted'
    GROUP BY product_id
  `).all(orderId);

  const enriched = lines.map((L) => {
    const p = db.prepare('SELECT name FROM products WHERE id=?').get(L.product_id);
    const varP = Math.round(num(L.var_price_rial));
    const varQ = Math.round(num(L.var_qty_rial));
    return {
      product_id: L.product_id,
      name: p?.name || '',
      qty_standard: num(L.qty_standard),
      qty_actual: num(L.qty_actual),
      std_cost_rial: Math.round(num(L.std_cost_rial)),
      unit_cost_rial: Math.round(num(L.unit_cost_rial)),
      std_amount_rial: Math.round(num(L.std_amount_rial)),
      amount_rial: Math.round(num(L.amount_rial)),
      var_price_rial: varP,
      var_qty_rial: varQ,
      var_total_rial: varP + varQ,
    };
  });

  const stdTotal = enriched.reduce((s, l) => s + l.std_amount_rial, 0);
  const actTotal = enriched.reduce((s, l) => s + l.amount_rial, 0);
  const varPrice = enriched.reduce((s, l) => s + l.var_price_rial, 0);
  const varQty = enriched.reduce((s, l) => s + l.var_qty_rial, 0);
  const varTotal = varPrice + varQty;

  let topCulprit = null;
  for (const l of enriched) {
    if (!topCulprit || Math.abs(l.var_qty_rial) > Math.abs(topCulprit.var_qty_rial)) topCulprit = l;
  }

  return {
    order_id: orderId,
    order_no: po.order_no,
    analysis_type: po.analysis_type,
    lines: enriched,
    totals: {
      std_total_rial: stdTotal,
      actual_total_rial: actTotal,
      var_price_rial: varPrice,
      var_qty_rial: varQty,
      var_total_rial: varTotal,
      pct: stdTotal ? (varTotal / stdTotal) * 100 : 0,
    },
    top_culprit: topCulprit,
    note: 'انحرافات اطلاعاتی هستند و سند حسابداری ندارند (ADR-011)',
  };
}

function checkBomRevisionSuggestion(db, fgProductId, { minOrders = 3, minPct = 5 } = {}) {
  const orders = db.prepare(`
    SELECT id, bom_id, qty_planned FROM production_orders
    WHERE product_id=? AND analysis_type IN ('variable','variable_adv')
      AND status IN ('completed','closed','in_progress')
    ORDER BY id DESC
    LIMIT ?
  `).all(fgProductId, minOrders);

  if (orders.length < minOrders) {
    return { suggest: false, reason: 'insufficient_orders', orders: orders.length };
  }

  const byComponent = {};
  for (const o of orders) {
    const rows = db.prepare(`
      SELECT product_id, SUM(qty_standard) AS sq, SUM(qty_actual) AS aq
      FROM production_material_issues
      WHERE order_id=? AND status='posted' AND qty_actual > 0
      GROUP BY product_id
    `).all(o.id);
    for (const r of rows) {
      const sq = num(r.sq);
      const aq = num(r.aq);
      if (!sq) continue;
      const pct = ((aq - sq) / sq) * 100;
      if (!byComponent[r.product_id]) byComponent[r.product_id] = [];
      byComponent[r.product_id].push({
        order_id: o.id, bom_id: o.bom_id, pct, sq, aq, qty_planned: num(o.qty_planned),
      });
    }
  }

  const suggestions = [];
  for (const [productId, samples] of Object.entries(byComponent)) {
    if (samples.length < minOrders) continue;
    const recent = samples.slice(0, minOrders);
    const signs = recent.map((s) => Math.sign(s.pct) || 0);
    const allSame = signs.every((s) => s === signs[0] && s !== 0);
    const allAbove = recent.every((s) => Math.abs(s.pct) > minPct);
    if (!allSame || !allAbove) continue;

    const avgFactor = recent.reduce((s, x) => s + (x.aq / x.sq), 0) / recent.length;
    const bomId = recent[0].bom_id;
    let currentQty = null;
    try {
      const bl = db.prepare(`
        SELECT qty_per_base FROM bom_lines WHERE bom_id=? AND component_product_id=?
      `).get(bomId, Number(productId));
      currentQty = bl ? num(bl.qty_per_base) : null;
    } catch { /* ignore */ }

    const suggestedQty = currentQty != null
      ? Math.round(currentQty * avgFactor * 1000) / 1000
      : null;
    const prod = db.prepare('SELECT name FROM products WHERE id=?').get(Number(productId));
    suggestions.push({
      fg_product_id: fgProductId,
      component_product_id: Number(productId),
      component_name: prod?.name || '',
      bom_id: bomId,
      current_qty_per_base: currentQty,
      suggested_qty: suggestedQty,
      avg_factor: Math.round(avgFactor * 10000) / 10000,
      samples: recent,
      event: 'production.bom.suggest_revision',
    });
  }

  return { suggest: suggestions.length > 0, suggestions };
}

function listBomRevisionSuggestions(db, { productId = null, limit = 50 } = {}) {
  const where = productId
    ? "WHERE po.product_id=? AND po.analysis_type IN ('variable','variable_adv')"
    : "WHERE po.analysis_type IN ('variable','variable_adv')";
  const params = productId ? [Number(productId)] : [];
  const fgs = db.prepare(`
    SELECT DISTINCT po.product_id AS id FROM production_orders po
    ${where} ORDER BY po.id DESC LIMIT ?
  `).all(...params, Number(limit) || 50);

  const out = [];
  for (const fg of fgs) {
    const r = checkBomRevisionSuggestion(db, fg.id);
    if (r.suggest) out.push(...r.suggestions);
  }
  return { rows: out, count: out.length };
}

function varianceTrend(db, { productId = null, periods = 6 } = {}) {
  const lim = Math.min(Number(periods) || 6, 24);
  let sql = `
    SELECT mi.period_label,
           SUM(mi.var_price_rial) AS var_price_rial,
           SUM(mi.var_qty_rial) AS var_qty_rial,
           SUM(mi.var_price_rial + mi.var_qty_rial) AS var_total_rial,
           SUM(mi.std_amount_rial) AS std_amount_rial,
           COUNT(DISTINCT mi.order_id) AS orders
    FROM production_material_issues mi
    JOIN production_orders po ON po.id = mi.order_id
    WHERE mi.status='posted'
  `;
  const params = [];
  if (productId) {
    sql += ' AND po.product_id=?';
    params.push(Number(productId));
  }
  sql += ' GROUP BY mi.period_label ORDER BY mi.period_label DESC LIMIT ?';
  params.push(lim);
  const rows = db.prepare(sql).all(...params).reverse();
  return { rows, count: rows.length };
}

function standardMapFromBom(db, po, qtyStarted) {
  let sizeBreakdown = null;
  if (po.size_breakdown) {
    if (typeof po.size_breakdown === 'object') sizeBreakdown = po.size_breakdown;
    else {
      try { sizeBreakdown = JSON.parse(po.size_breakdown); } catch { sizeBreakdown = null; }
    }
  }
  const ex = explodeBom(db, {
    bomId: po.bom_id,
    qty: qtyStarted,
    sizeBreakdown,
    priceBasis: 'std',
  });
  const std = {};
  for (const L of ex.lines) {
    std[L.product_id] = {
      qty: L.qty_final,
      price: L.unit_cost_rial,
      kind: L.line_kind,
      bom_line_id: L.bom_line_id,
    };
  }
  return { std, explode: ex };
}

module.exports = {
  computeVariance,
  insertVarianceMemo,
  varianceReasonThreshold,
  varianceAnalysis,
  checkBomRevisionSuggestion,
  listBomRevisionSuggestions,
  varianceTrend,
  standardMapFromBom,
  round6,
};
