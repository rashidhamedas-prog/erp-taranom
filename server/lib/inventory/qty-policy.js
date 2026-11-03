'use strict';
/**
 * Inventory quantity policy — apparel/piece vs continuous (fabric meters).
 *
 * Invariant:
 * - Matrix SKUs (color×size) and piece units (عدد, …) → INTEGER qty only.
 * - Continuous units (متر, کیلو, …) → REAL with round3 (≤3 decimals).
 *
 * Prevents Update-11 D1 float policy + VWS scale-heal from leaving
 * fractional "pairs of pants" in the ledger.
 */
const { round3, parseQty } = require('../round3');
const { matchText, policyForProduct } = require('../uom');

const CONTINUOUS_UNIT_RE = /متر|یارد|کیلو|kg|گرم|g\b|لیتر|liter|yard|yards|\byd\b|\bm\b|ثانیه|ساعت|roll|طاقه|نوار|پارچه/i;
const PIECE_UNIT_RE = /^(عدد|pcs?|piece|ea|each|جفت|دست|بسته|پک)?$/i;

function tableExists(db, name) {
  try {
    return !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
    ).get(name);
  } catch (_) {
    return false;
  }
}

function hasActiveMatrixVariants(db, productId) {
  if (!productId || !tableExists(db, 'product_variants')) return false;
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM product_variants
    WHERE product_id=? AND active=1 AND COALESCE(is_default,0)=0
  `).get(productId);
  return (Number(row && row.c) || 0) > 0;
}

function productUnit(db, productId) {
  if (!productId || !tableExists(db, 'products')) return '';
  const row = db.prepare('SELECT unit FROM products WHERE id=?').get(productId);
  return row ? String(row.unit || '').trim() : '';
}

/**
 * True when qty must be a whole number (no fractions).
 * Matrix apparel always integer. Continuous unit keywords stay decimal.
 * Default for this clothing ERP: integer when unit empty/عدد.
 */
function requiresIntegerQty(db, productId, unitHint) {
  if (productId && hasActiveMatrixVariants(db, productId)) return true;
  if (db && unitHint != null && String(unitHint).trim()) {
    try {
      const matched = matchText(db, unitHint);
      if (matched) return (matched.dimension || 'count') === 'count';
    } catch (_) { /* catalog not ready */ }
  }
  if (db && productId) {
    try {
      const pol = policyForProduct(db, productId);
      if (pol.known) return pol.dimension === 'count';
    } catch (_) { /* catalog not ready */ }
  }
  const unit = String(unitHint != null ? unitHint : productUnit(db, productId) || '').trim();
  if (CONTINUOUS_UNIT_RE.test(unit)) return false;
  if (!unit || PIECE_UNIT_RE.test(unit)) return true;
  return false;
}

function isIntegerQty(n) {
  const x = Number(n);
  return Number.isFinite(x) && Math.abs(x - Math.round(x)) < 1e-9;
}

/** Normalize for write: integer clamp or round3. */
function normalizeStockQty(qty, opts = {}) {
  const integer = !!opts.integer;
  if (integer) {
    const n = Math.round(Number(qty));
    if (!Number.isFinite(n)) return Math.round(Number(opts.fallback) || 0);
    return n;
  }
  return parseQty(qty, opts.fallback != null ? opts.fallback : 0);
}

/**
 * Parse API/UI qty with product policy.
 * @throws if opts.strict and integer required but value has fraction
 */
function parseStockQty(qty, opts = {}) {
  const integer = opts.integer != null
    ? !!opts.integer
    : (opts.db && opts.productId
      ? requiresIntegerQty(opts.db, opts.productId, opts.unit)
      : false);
  if (integer && opts.strict) {
    const raw = parseQty(qty, opts.fallback != null ? opts.fallback : 0);
    if (!isIntegerQty(raw)) {
      const e = new Error('موجودی کالای قطعه‌ای باید عدد صحیح باشد');
      e.status = 400;
      e.code = 'E_QTY_NOT_INTEGER';
      e.qty = raw;
      throw e;
    }
  }
  return normalizeStockQty(qty, { integer, fallback: opts.fallback });
}

/**
 * Largest-remainder integer allocation.
 * weights[i] ≥ 0; returns integers summing exactly to `total`.
 */
function allocateIntegers(weights, total) {
  const n = weights.length;
  const t = Math.round(Number(total) || 0);
  if (n === 0) return [];
  if (t <= 0) return weights.map(() => 0);
  const w = weights.map((x) => Math.max(0, Number(x) || 0));
  const sumW = w.reduce((a, b) => a + b, 0);
  if (sumW <= 0) {
    const out = weights.map(() => 0);
    out[0] = t;
    return out;
  }
  const raw = w.map((x) => (x / sumW) * t);
  const floors = raw.map((x) => Math.floor(x));
  let rem = t - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = floors.slice();
  for (let k = 0; k < rem; k++) out[order[k].i] += 1;
  return out;
}

/**
 * One-shot heal: piece/matrix stock figures must not be fractional.
 *
 * The v238 float reconcile (`qty * global/sum` via round3) once rewrote apparel caches into
 * fractions (14 → 6.462). SSOT: the caches are derived from the live inventory_ledger, so the
 * heal re-derives every piece product whose cached figure is fractional (stock-cache.js is the
 * only writer). A fraction that is in the ledger itself is data — it is reported, never rounded
 * here (fixing it needs an adjustment document).
 *
 * Idempotent via settings key apparel_qty_ledger_heal_v1.
 */
function healApparelIntegerStock(db) {
  if (!tableExists(db, 'settings')) {
    return { skipped: true, reason: 'no_settings' };
  }
  const flag = db.prepare("SELECT value FROM settings WHERE key='apparel_qty_ledger_heal_v1'").get();
  if (flag && String(flag.value) === '1') return { already: true };
  if (!tableExists(db, 'products')) return { skipped: true, reason: 'no_products' };
  if (!tableExists(db, 'inventory_ledger')) return { skipped: true, reason: 'no_ledger' };

  const dirty = new Set();
  const frac = (sql) => {
    try { for (const r of db.prepare(sql).all()) dirty.add(Number(r.id)); } catch (_) { /* optional table */ }
  };
  frac('SELECT id FROM products WHERE ABS(stock - ROUND(stock)) > 0.0001');
  if (tableExists(db, 'warehouse_stock')) {
    frac('SELECT DISTINCT product_id AS id FROM warehouse_stock WHERE ABS(qty - ROUND(qty)) > 0.0001');
  }
  if (tableExists(db, 'product_variants')) {
    frac('SELECT DISTINCT product_id AS id FROM product_variants WHERE ABS(stock - ROUND(stock)) > 0.0001');
    if (tableExists(db, 'variant_warehouse_stock')) {
      frac(`SELECT DISTINCT pv.product_id AS id FROM variant_warehouse_stock vws
        JOIN product_variants pv ON pv.id=vws.variant_id WHERE ABS(vws.qty - ROUND(vws.qty)) > 0.0001`);
    }
  }
  const productIds = [...dirty].filter((id) => requiresIntegerQty(db, id));
  const ledgerFractional = [];
  const tx = db.transaction(() => {
    if (productIds.length) require('./stock-cache').rebuildAllStockCaches(db, { productIds });
    for (const id of productIds) {
      const p = db.prepare('SELECT stock FROM products WHERE id=?').get(id);
      if (p && !isIntegerQty(p.stock)) ledgerFractional.push(id);
    }
    db.prepare(
      "INSERT OR REPLACE INTO settings (key,value) VALUES ('apparel_qty_ledger_heal_v1','1')"
    ).run();
  });
  tx();

  return { productsRebuilt: productIds.length, ledgerFractional };
}

module.exports = {
  CONTINUOUS_UNIT_RE,
  PIECE_UNIT_RE,
  requiresIntegerQty,
  hasActiveMatrixVariants,
  isIntegerQty,
  normalizeStockQty,
  parseStockQty,
  allocateIntegers,
  healApparelIntegerStock,
  round3,
  parseQty,
};
