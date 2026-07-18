'use strict';
/**
 * Production RBAC helpers — cost visibility + cost-center scoping (permissions.md §6.2)
 */
const { hasPermission } = require('../rbac');
const { err } = require('./posting');

const COST_KEY = /(_rial|_toman|unit_cost|std_cost|var_price|var_qty|var_total|_amount)$/i;
const COST_BLOCKS = new Set([
  'cost', 'costs', 'pricing', 'breakdown', 'standard', 'variance',
  'discount_analysis', 'totals_cost', 'allocation', 'production',
  'cogs', 'period_expenses', 'variances',
]);

function canSeeCost(db, user) {
  if (!user) return false;
  return hasPermission(db, user, 'production_cost', 'view');
}

function stripCostFields(obj) {
  if (Array.isArray(obj)) return obj.map(stripCostFields);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (COST_KEY.test(k)) continue;
      if (COST_BLOCKS.has(k)) continue;
      out[k] = stripCostFields(v);
    }
    return out;
  }
  return obj;
}

function userCostCenterRows(db, userId) {
  return db.prepare(
    'SELECT cost_center_id, can_view, can_post FROM user_cost_centers WHERE user_id=?'
  ).all(userId);
}

/** null = no restriction (all cost centers allowed) */
function costCenterFilter(db, userId) {
  const rows = userCostCenterRows(db, userId).filter(r => r.can_view);
  if (!rows.length) return null;
  return rows.map(r => r.cost_center_id);
}

function assertUserCostCenter(db, userId, ccId, { requirePost = true } = {}) {
  const rows = userCostCenterRows(db, userId);
  if (!rows.length) return true;
  const row = rows.find(r => r.cost_center_id === ccId);
  if (!row) {
    const cc = db.prepare('SELECT name, code FROM cost_centers WHERE id=?').get(ccId);
    throw err('E_FORBIDDEN_CC', 403, { cc: cc?.name || cc?.code || ccId });
  }
  if (requirePost && !row.can_post) {
    throw err('E_FORBIDDEN_CC', 403, { cc: ccId });
  }
  return true;
}

function ccSqlFilter(ccFilter, column = 'cost_center_id') {
  if (!ccFilter || !ccFilter.length) return { sql: '', params: [] };
  const ph = ccFilter.map(() => '?').join(',');
  return { sql: ` AND ${column} IN (${ph})`, params: [...ccFilter] };
}

function applyCostPolicy(db, user, data, { hideProfit = false } = {}) {
  let out = data;
  if (!canSeeCost(db, user)) {
    out = stripCostFields(out);
  }
  if (hideProfit && out && typeof out === 'object') {
    const clone = JSON.parse(JSON.stringify(out));
    if (clone.data?.kpis?.gross_margin) delete clone.data.kpis.gross_margin;
    if (clone.kpis?.gross_margin) delete clone.kpis.gross_margin;
    return clone;
  }
  return out;
}

module.exports = {
  canSeeCost,
  stripCostFields,
  costCenterFilter,
  assertUserCostCenter,
  ccSqlFilter,
  applyCostPolicy,
  COST_KEY,
  COST_BLOCKS,
};
