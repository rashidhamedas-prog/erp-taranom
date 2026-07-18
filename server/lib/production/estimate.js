'use strict';
/**
 * Production Module 5 — Cost estimation (no ledger, no stock mutation)
 */
const { allocateNumber } = require('../../db');
const { todayJalali } = require('../../jalali');
const { resolveBom, explodeBom } = require('./bom');
const { rollUpBom, backwardQty } = require('./bom-advanced');
const { setting } = require('./costing');
const { err } = require('./posting');

function num(v) { return Number(v) || 0; }
function round2(n) { return Math.round(Number(n) * 100) / 100; }

function estimateCost(db, { productId, qty, period, date, bomId = null, priceBasis = 'average' }) {
  const targetDate = date || todayJalali();
  const prd = period || targetDate.slice(0, 7);
  const targetQty = num(qty) || 1;
  if (targetQty <= 0) throw err('E_QTY_INVALID', 422);

  const bom = resolveBom(db, {
    productId: Number(productId),
    date: targetDate,
    preferredBomId: bomId ? Number(bomId) : null,
  });

  let rollup;
  if (bom.has_routing) {
    rollup = rollUpBom(db, {
      bomId: bom.id,
      qtyTarget: targetQty,
      period: prd,
      priceBasis,
    });
  } else {
    const ex = explodeBom(db, { bomId: bom.id, qty: targetQty, priceBasis });
    const gross = ex.totals.total_rial;
    rollup = {
      qty_start: targetQty,
      total_yield_percent: bom.yield_percent || 100,
      breakdown: {
        material_rial: gross,
        packaging_rial: 0,
        labor_rial: 0,
        overhead_rial: 0,
        subcontract_rial: 0,
        gross_rial: gross,
        by_credit_rial: 0,
        net_rial: gross,
        unit_cost_rial: targetQty ? Math.round(gross / targetQty) : 0,
      },
      stages: [],
      outputs: [],
      warnings: [],
    };
  }

  const unitCost = rollup.breakdown.unit_cost_rial;
  const marginPct = parseFloat(setting(db, 'pricing_margin_percent', '35')) || 35;
  const markupPrice = Math.round(unitCost * (1 + marginPct / 100));
  const marginPrice = marginPct < 100 ? Math.round(unitCost / (1 - marginPct / 100)) : 0;
  const marginOnSale = round2((marginPct / (100 + marginPct)) * 100);

  const listPriceRial = num(db.prepare('SELECT price FROM products WHERE id=?')
    .get(productId)?.price) * 10
    || num(db.prepare('SELECT price_rial FROM products WHERE id=?').get(productId)?.price_rial)
    || markupPrice;

  const commissionPct = parseFloat(setting(db, 'rep_commission_percent', '4.5')) || 4.5;
  const base = listPriceRial || markupPrice;
  const breakeven = base > 0
    ? round2(100 * (1 - unitCost / (base * (1 - commissionPct / 100))))
    : 0;

  const scenarios = [0, 10, 15, 20].map(d => {
    const net = Math.round(base * (1 - d / 100));
    const comm = Math.round(net * commissionPct / 100);
    const prof = net - comm - unitCost;
    return {
      discount_pct: d,
      net_rial: net,
      commission_rial: comm,
      profit_rial: prof,
      margin_pct: net ? round2(prof / net * 100) : 0,
    };
  });

  return {
    product_id: Number(productId),
    bom_id: bom.id,
    bom_code: bom.code,
    qty_target: targetQty,
    qty_start: rollup.qty_start,
    total_yield_percent: rollup.total_yield_percent,
    period: prd,
    date: targetDate,
    price_basis: priceBasis,
    cost: {
      material_rial: rollup.breakdown.material_rial,
      packaging_rial: rollup.breakdown.packaging_rial,
      labor_rial: rollup.breakdown.labor_rial,
      overhead_rial: rollup.breakdown.overhead_rial,
      subcontract_rial: rollup.breakdown.subcontract_rial,
      gross_rial: rollup.breakdown.gross_rial,
      by_credit_rial: rollup.breakdown.by_credit_rial,
      net_rial: rollup.breakdown.net_rial,
      unit_cost_rial: unitCost,
    },
    pricing: {
      margin_percent: marginPct,
      markup_price_rial: markupPrice,
      margin_price_rial: marginPrice,
      margin_on_sale_pct: marginOnSale,
      suggested_price_rial: markupPrice,
      list_price_rial: listPriceRial,
    },
    discount_analysis: {
      commission_pct: commissionPct,
      breakeven_discount_pct: breakeven,
      scenarios,
    },
    stages: rollup.stages,
    outputs: rollup.outputs,
    warnings: rollup.warnings || [],
  };
}

function saveEstimate(db, params, userId) {
  const est = estimateCost(db, params);
  let code = '';
  try { code = allocateNumber(db, 'estimate', 'EST'); }
  catch { code = `EST-${Date.now()}`; }

  const id = db.prepare(`
    INSERT INTO production_estimates
      (code, title, estimate_type, product_id, bom_id, qty, price_basis,
       est_material_rial, est_packaging_rial, est_labor_rial, est_overhead_rial,
       est_subcontract_rial, est_total_rial, est_unit_rial, margin_percent,
       suggested_price_rial, date, status, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)
  `).run(
    code, params.title || `برآورد ${est.qty_target} عدد`,
    params.estimate_type || 'cost',
    est.product_id, est.bom_id, est.qty_target, est.price_basis,
    est.cost.material_rial, est.cost.packaging_rial, est.cost.labor_rial,
    est.cost.overhead_rial, est.cost.subcontract_rial, est.cost.net_rial,
    est.cost.unit_cost_rial, est.pricing.margin_percent,
    est.pricing.suggested_price_rial, est.date, userId
  ).lastInsertRowid;

  return { estimate_id: id, code, ...est };
}

module.exports = { estimateCost, saveEstimate, round2 };
