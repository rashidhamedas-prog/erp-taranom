'use strict';
/**
 * P4 — field-level cost visibility (RBAC `cost_visibility:view`).
 *
 * Roles without the permission (cashier/store_retail, sales, …) never receive
 * purchase cost, average/unit cost, margin, profit, COGS or landed-cost keys
 * in API JSON — stripped recursively by a response middleware mounted per
 * route prefix (no per-route edits → no overlap with catalog/products work).
 *
 * Complements (does not replace) lib/catalog-cost-policy.js (R11) and
 * lib/production/access.js (production_cost). Selling prices stay visible.
 */
const { hasPermission } = require('./rbac');

/** Keys containing "cost" that are NOT monetary cost (cost centers, method labels…). */
const COST_SAFE = /cost_?(center|centre|cc|sheet|type|code|id|name|account|basis|mode|method|policy|ing|element|owner|label|group)|costing|cost_?centers?/i;
/** Any key containing cost / margin / profit / cogs / landed (camel or snake). */
const COST_KEY_GLOBAL = /cost|margin|profit|cogs|landed/i;
/** Exact extra keys (purchase / opening price). */
const COST_KEY_EXACT = /^(purchase_price(_rial)?|opening_price(_rial)?|buy_price(_rial)?)$/i;

/** Extra keys hidden only under stock-valuation prefixes (kardex amounts, valuation totals). */
const STOCK_VALUE_KEY = /^(amount_rial|value_rial|total_value_rial|stock_value_rial|inventory_value_rial|balance_value_rial|balance_amount_rial)$/i;
/** Purchase-document line pricing (price in purchases/receipts is cost, not sale price). */
const PURCHASE_PRICE_KEY = /^(price|price_rial|unit_price|unit_price_rial|sum|line_total|line_amount)$/i;

const STOCK_VALUE_PREFIXES = ['/api/inventory', '/api/inventory-valuation', '/api/warehouses'];
const PURCHASE_PREFIXES = ['/api/purchases'];

/** @returns {{stockValue:boolean, purchasePrice:boolean}} */
function scopeFor(path) {
  const p = String(path || '').split('?')[0];
  const hit = (list) => list.some((x) => p === x || p.startsWith(x + '/'));
  return { stockValue: hit(STOCK_VALUE_PREFIXES) || /\/kardex(\/|$)/i.test(p), purchasePrice: hit(PURCHASE_PREFIXES) };
}

function isCostKey(key, scope) {
  const k = String(key);
  if (COST_KEY_EXACT.test(k)) return true;
  if (COST_KEY_GLOBAL.test(k) && !COST_SAFE.test(k)) return true;
  if (scope && scope.stockValue && STOCK_VALUE_KEY.test(k)) return true;
  if (scope && scope.purchasePrice && PURCHASE_PRICE_KEY.test(k)) return true;
  return false;
}

/** Recursive copy without cost keys (arrays/objects; Buffers & Dates untouched). */
function stripCostVisibility(payload, scope) {
  if (Array.isArray(payload)) return payload.map((x) => stripCostVisibility(x, scope));
  if (payload && typeof payload === 'object' && !(payload instanceof Date) && !Buffer.isBuffer(payload)) {
    const out = {};
    for (const [k, v] of Object.entries(payload)) {
      if (isCostKey(k, scope)) continue;
      out[k] = stripCostVisibility(v, scope);
    }
    return out;
  }
  return payload;
}

/** admin/accounting by default; override via role_permission_defaults / user_permissions. */
function canSeeCostVisibility(db, user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  try { return hasPermission(db, user, 'cost_visibility', 'view'); } catch (_) { return false; }
}

/** API-key callers (api_v1) have no user: cost only with an explicit `cost` scope. */
function apiKeyCanSeeCost(apiKey) {
  return String((apiKey && apiKey.scopes) || '').split(',').map((s) => s.trim()).includes('cost');
}

/** Drop cost-ish columns from export rows (Persian headers). `entity` limits value columns. */
const EXPORT_COST_LABEL = /بها|قیمت خرید|سود|حاشیه|بهره‌وری/;
const EXPORT_COST_SAFE = /عنصر|مرکز هزینه|هزینه\/شناسه|روش/;
function stripCostExportRows(rows, entity) {
  const e = String(entity || '');
  const moneyToo = e.startsWith('warehouse-') || e === 'purchases' || e === 'purchase-returns';
  const dropLabel = (label) => {
    const l = String(label);
    if (EXPORT_COST_SAFE.test(l)) return false;
    if (EXPORT_COST_LABEL.test(l)) return true;
    if (moneyToo && /^(مبلغ|قیمت واحد|جمع) ?\(ریال\)$/.test(l.trim())) return true;
    return false;
  };
  return (rows || []).map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row || {})) if (!dropLabel(k)) out[k] = v;
    return out;
  });
}

/**
 * Express middleware: wraps res.json. `req.user` is resolved lazily (routers attach
 * auth per route, after this middleware runs). Mount with app.use(prefix, costVisibilityStrip()).
 */
function costVisibilityStrip(getDb) {
  return function costVisibilityMw(req, res, next) {
    const origJson = res.json.bind(res);
    res.json = function costStrippedJson(body) {
      try {
        const db = (typeof getDb === 'function' ? getDb() : null) || require('../db').getDB();
        const allowed = req.user ? canSeeCostVisibility(db, req.user)
          : (req.apiKey ? apiKeyCanSeeCost(req.apiKey) : true); // unauthenticated → nothing sensitive anyway
        if (!allowed && body && typeof body === 'object') {
          res.setHeader('X-Cost-Redacted', '1');
          return origJson(stripCostVisibility(body, scopeFor(req.baseUrl + (req.path || ''))));
        }
      } catch (e) {
        // fail-closed for authenticated non-allowed callers is handled above; on lookup error keep body
        if (req.user && req.user.role !== 'admin') {
          return origJson(stripCostVisibility(body, scopeFor(req.baseUrl + (req.path || ''))));
        }
      }
      return origJson(body);
    };
    next();
  };
}

/** Prefixes where the middleware is mounted in server.js (documented + asserted in tests). */
const COST_STRIP_PREFIXES = [
  '/api/products', '/api/product-variants', '/api/inventory', '/api/inventory-valuation',
  '/api/warehouses', '/api/purchases', '/api/store', '/api/pos',
  '/api/reports', '/api/adv-reports', '/api/excel', '/api/v1',
];

module.exports = {
  stripCostVisibility, isCostKey, scopeFor, canSeeCostVisibility, apiKeyCanSeeCost,
  stripCostExportRows, costVisibilityStrip, COST_STRIP_PREFIXES,
};
