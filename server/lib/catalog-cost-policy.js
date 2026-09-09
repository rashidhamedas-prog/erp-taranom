'use strict';
/**
 * R11 — catalog/sales cost policy.
 * Selling price stays; inventory/production cost never leaves the server
 * for roles without production_cost.view (field_sales, inside_sales, …).
 * Do not reuse production stripCostFields here: that regex also drops
 * commercial keys like disc_amount / freight_amount which sales must see.
 */
const { canSeeCost } = require('./production/access');

const COST_KEY = /^(cost|average_cost_rial|std_cost_rial|last_prod_cost_rial|unit_cost_rial|std_unit_rial|avg_cost_after_rial|amount_rial)$/i;

function stripCatalogCost(obj) {
  if (Array.isArray(obj)) return obj.map(stripCatalogCost);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (COST_KEY.test(k)) continue;
      out[k] = stripCatalogCost(v);
    }
    return out;
  }
  return obj;
}

function applyCatalogCostPolicy(db, user, data) {
  if (canSeeCost(db, user)) return data;
  return stripCatalogCost(data);
}

module.exports = { stripCatalogCost, applyCatalogCostPolicy };
