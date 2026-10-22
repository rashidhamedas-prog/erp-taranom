'use strict';
/**
 * v525 — uniform stock-shortage payload.
 *
 * Every insufficient-stock error that reaches a client carries (status/message unchanged):
 *   code: existing code (E_NEGATIVE_STOCK, E_ATP_INSUFFICIENT, …) or E_INSUFFICIENT_STOCK
 *   shortages: [{ product_id, product_name, variant_id, variant_label, warehouse_id, warehouse_name,
 *                 available_qty, required_qty, shortfall_qty, on_hand_qty, reserved_qty, unit }]
 *
 * attach(err, db, rows) normalises the rows onto the error AND records them in the request
 * scope (AsyncLocalStorage). requestScope() + the res.json hook add `shortages` to any
 * 4xx JSON body with a shortage code that the route serialised without them — so routes
 * that only send { error, code } still deliver the structured payload (one place).
 */
const { AsyncLocalStorage } = require('async_hooks');

const SHORTAGE_CODES = new Set([
  'E_NEGATIVE_STOCK',
  'E_INSUFFICIENT_STOCK',
  'E_ATP_INSUFFICIENT',
  'E_BACKORDER_FORBIDDEN',
  'E_WH_INSUFFICIENT',
  'E_AMEND_PURCHASE_CONSUMED',
]);

const als = new AsyncLocalStorage();

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
}

function pick(...vals) {
  for (const v of vals) if (v != null && v !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function lookups(db, productId, variantId, warehouseId) {
  const out = { product_name: '', unit: '', warehouse_name: '', variant_label: '' };
  if (!db) return out;
  try {
    const p = db.prepare('SELECT name, unit FROM products WHERE id=?').get(productId);
    if (p) { out.product_name = p.name || ''; out.unit = p.unit || ''; }
  } catch (_) { /* ignore */ }
  if (warehouseId) {
    try {
      const w = db.prepare('SELECT name FROM warehouses WHERE id=?').get(warehouseId);
      if (w) out.warehouse_name = w.name || '';
    } catch (_) { /* ignore */ }
  }
  if (variantId) {
    try {
      const v = db.prepare(`
        SELECT pv.sku, pc.name AS color_name, ps.name AS size_name
        FROM product_variants pv
        LEFT JOIN product_colors pc ON pc.id = pv.color_id
        LEFT JOIN product_sizes ps ON ps.id = pv.size_id
        WHERE pv.id=?
      `).get(variantId);
      if (v) out.variant_label = [v.color_name, v.size_name].filter(Boolean).join('/') || v.sku || '';
    } catch (_) { /* ignore */ }
  }
  return out;
}

/**
 * Normalise one shortage from any legacy shape:
 *  ledger/movement { product_id, warehouse_id, available, needed }
 *  ATP            { product_id, variant_id, warehouse_id, atp, requested, short_by, on_hand, reserved }
 *  amend-purchase { product_id, warehouse_id, available, oldQty, minQty, name, whName }
 *  this module    { productId, variantId, warehouseId, available, required }
 */
function normalizeOne(db, s) {
  if (!s || typeof s !== 'object') return null;
  const productId = Number(s.product_id != null ? s.product_id : s.productId) || null;
  if (!productId) return null;
  const variantId = Number(s.variant_id != null ? s.variant_id : s.variantId) || null;
  const warehouseId = Number(s.warehouse_id != null ? s.warehouse_id : s.warehouseId) || null;
  const available = pick(s.available_qty, s.atp, s.available, s.on_hand);
  let required = pick(s.required_qty, s.requested, s.needed, s.required);
  let shortfall = pick(s.shortfall_qty, s.short_by, s.shortfall);
  if (required == null && s.oldQty != null && s.minQty != null) {
    // amend purchase: reducing a receipt by (oldQty − newQty) needs that much on hand
    required = pick(Number(s.oldQty) - Number(s.newQty || 0));
  }
  if (shortfall == null && required != null && available != null) shortfall = Math.max(0, required - available);
  const names = lookups(db, productId, variantId, warehouseId);
  return {
    product_id: productId,
    product_name: s.product_name || names.product_name || s.name || `کالا #${productId}`,
    variant_id: variantId,
    variant_label: s.variant_label || s.variantLabel || names.variant_label || '',
    warehouse_id: warehouseId,
    warehouse_name: s.warehouse_name || s.warehouseName || s.whName || names.warehouse_name || '',
    available_qty: num(available),
    required_qty: num(required),
    shortfall_qty: num(shortfall),
    on_hand_qty: num(pick(s.on_hand_qty, s.on_hand)),
    reserved_qty: num(pick(s.reserved_qty, s.reserved)),
    unit: s.unit || names.unit || '',
  };
}

function normalize(db, rows) {
  return (Array.isArray(rows) ? rows : [rows]).map((r) => normalizeOne(db, r)).filter(Boolean);
}

function remember(list) {
  const store = als.getStore();
  if (store && list && list.length) store.shortages = list;
}

/** Attach normalised shortages to an error (keeps its code; adds E_INSUFFICIENT_STOCK only when none). */
function attach(err, db, rows) {
  if (!err) return err;
  try {
    const list = normalize(db, rows);
    if (list.length) {
      err.shortages = list;
      if (!err.code) err.code = 'E_INSUFFICIENT_STOCK';
      remember(list);
    }
  } catch (_) { /* payload enrichment must never mask the original error */ }
  return err;
}

/** Structured list for an error already thrown by a legacy helper (own fields or e.shortages). */
function fromError(db, e) {
  if (!e) return [];
  if (Array.isArray(e.shortages) && e.shortages.length) {
    const already = e.shortages[0] && e.shortages[0].shortfall_qty !== undefined && e.shortages[0].product_name !== undefined;
    return already ? e.shortages : normalize(db, e.shortages);
  }
  if (e.product_id != null && (e.available != null || e.needed != null)) return normalize(db, [e]);
  const x = e.extra; // production posting.err(code, status, extra)
  if (x && x.product_id != null && (x.available != null || x.needed != null)) return normalize(db, [x]);
  return [];
}

function isShortageBody(body) {
  if (!body || typeof body !== 'object') return false;
  if (SHORTAGE_CODES.has(String(body.code || ''))) return true;
  const msg = String(body.error || '');
  return /^E_NEGATIVE_STOCK/.test(msg) || /موجودی[^]*کافی نیست|موجودی انبار منفی/.test(msg);
}

/**
 * Fallback for pre-checks that throw a plain message (no helper): rebuild the shortage from the
 * request lines ({product_id, qty, variant_id} or lines[]) against live warehouse quantities.
 * Only lines whose live quantity is below the requested qty are reported (inferred: true).
 */
function inferFromRequest(req) {
  const b = req && req.body;
  if (!b || typeof b !== 'object') return [];
  const headerWh = Number(b.from_warehouse_id || b.warehouse_id || b.source_warehouse_id) || null;
  const lines = Array.isArray(b.lines) ? b.lines : (b.product_id != null ? [b] : []);
  if (!lines.length || lines.length > 50) return [];
  let db;
  try { db = require('../../db').getDB(); } catch (_) { return []; }
  const L = require('./ledger');
  const M = require('./movement');
  const need = new Map();
  for (const l of lines) {
    const productId = Number(l && l.product_id) || 0;
    const qty = Number(l && (l.qty != null ? l.qty : l.quantity)) || 0;
    if (!productId || !(qty > 0)) continue;
    const warehouseId = Number(l.from_warehouse_id || l.warehouse_id) || headerWh;
    const variantId = Number(l.variant_id) || null;
    const k = `${productId}|${variantId || 0}|${warehouseId || 0}`;
    const cur = need.get(k) || { product_id: productId, variant_id: variantId, warehouse_id: warehouseId, needed: 0 };
    cur.needed += qty;
    need.set(k, cur);
  }
  const rows = [];
  for (const n of need.values()) {
    let available;
    try {
      available = n.variant_id
        ? M.variantWarehouseQty(db, n.variant_id, n.warehouse_id)
        : L.warehouseQty(db, n.product_id, n.warehouse_id);
    } catch (_) { continue; }
    if (available + 1e-9 < n.needed) rows.push({ ...n, available });
  }
  return normalize(db, rows).map((r) => ({ ...r, inferred: true }));
}

/**
 * Express middleware: request scope + res.json hook. Only 4xx bodies that are shortage errors
 * and carry no `shortages` are enriched; status, message and code are never changed
 * (code is added as E_INSUFFICIENT_STOCK only when the body had none).
 */
function requestScope(req, res, next) {
  als.run({}, () => {
    const orig = res.json.bind(res);
    res.json = function (body) {
      try {
        const store = als.getStore();
        if (res.statusCode >= 400 && res.statusCode < 500 && store
          && body && typeof body === 'object' && !Array.isArray(body) && !Array.isArray(body.shortages)
          && isShortageBody(body)) {
          const list = store.shortages || inferFromRequest(req);
          if (list && list.length) {
            body = { ...body, shortages: list };
            if (!body.code) body.code = 'E_INSUFFICIENT_STOCK';
          }
        }
      } catch (_) { /* never break a response */ }
      return orig(body);
    };
    next();
  });
}

module.exports = {
  SHORTAGE_CODES,
  normalize,
  attach,
  fromError,
  isShortageBody,
  inferFromRequest,
  requestScope,
};
