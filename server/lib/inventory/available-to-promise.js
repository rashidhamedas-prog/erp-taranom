'use strict';
/**
 * Available-to-promise (ATP) gate for firm sales — NONTAX-P0-atp.
 *
 *   ATP(warehouse, SKU) = on_hand − active reservations − committed demand not yet deducted
 *
 * Quantity layers — ALWAYS the layer the sale itself posts to, so the check and the movement
 * can never disagree:
 *   - line WITH variant_id    → variant_warehouse_stock(variant, warehouse); missing row = 0 (no global
 *                               fallback — same rule as movement.variantWarehouseQty / expandLivePack);
 *                               product_variants.stock only when the line has no warehouse at all.
 *   - line WITHOUT variant_id → warehouse_stock(product, warehouse) with the legacy seed rule of
 *                               ledger.warehouseQty (missing row ⇒ products.stock counts on the product's
 *                               home warehouse, 0 elsewhere).
 *   Pack / colour×size lines are variant lines: they are checked on the variant row, and additionally
 *   bounded by the product×warehouse promise below — never a second header decrement.
 *
 * Reservations (inventory_reservations) are product×warehouse scoped (no variant column). They are
 * therefore applied at the product×warehouse level: Σ requested(all variants + plain lines of the
 * product in that warehouse) ≤ product_on_hand − reserved_for_others − committed_product.
 * "reserved_for_others" excludes active order reservations that belong to the SAME customer the
 * invoice is for (the sale is the fulfilment of that reservation; the perpetual path consumes it via
 * consumeOpenReservationsForSale). Conservative by design: a product-level reservation blocks every
 * colour/size for other customers until it is released, consumed or expires.
 *
 * Committed-but-not-deducted demand = firm invoices (type normal|final, not reversed/deleted) with
 * stock_deducted=0 AND fulfillment_state IN ('backorder','provisional') — i.e. sales this gate itself
 * accepted without moving stock. Proformas are never demand; invoices with stock_deducted=1 already
 * reduced on_hand.
 *
 * Policy (decideSaleFulfillment):
 *   - default              : any shortage ⇒ 409 E_ATP_INSUFFICIENT (Persian message), nothing written.
 *   - warehouse allow_negative=1 or settings.inventory_allow_negative='1' ⇒ that warehouse is exempt
 *     (explicit admin configuration, same switch warehouse issue/transfer documents honour).
 *   - body.backorder === true AND role admin|accounting ⇒ whole invoice becomes 'backorder':
 *     accepted, NO stock movement, stock_deducted stays 0. Other roles asking for backorder ⇒ 403.
 *   - device (SYNC_ROLE=device) or header x-offline-provisional: '1' ⇒ 'provisional': ATP still checked,
 *     NO local stock movement, stock_deducted stays 0. Central acceptance happens when the sync engine
 *     replays the captured POST (method/path/body only — the header is not replayed), so central runs the
 *     normal deduct path against its own on_hand and conflicts surface in the sync review queue.
 *
 * This module never writes. Callers MUST invoke it INSIDE the same db.transaction() that posts the
 * stock movement (better-sqlite3 is synchronous and SQLite serialises writers, so two sales cannot both
 * see the last unit as available and both commit).
 *
 * Historical negative balances are left untouched: an existing negative on_hand simply yields ATP ≤ 0
 * and blocks further firm sales of that SKU until a counted stocktake / adjustment corrects it.
 */
const { round3 } = require('../round3');
const { warehouseQty } = require('./ledger');
const { reservedQty } = require('./reservation');
const { FULFILLMENT_STATES, hasColumn, tableExists } = require('./atp-schema');

const BACKORDER_ROLES = new Set(['admin', 'accounting']);
const EPS = 1e-9;

function atpErr(code, status, message, extra) {
  const e = new Error(message || code);
  e.code = code;
  e.status = status || 409;
  if (extra) Object.assign(e, extra);
  return e;
}

function isFabricRollLine(r) {
  if (!r) return false;
  if (r.is_fabric_roll) return true;
  const bid = parseInt(r.batch_id, 10);
  return Number.isFinite(bid) && bid > 0;
}

/** Stocked product lines only — services/income rows and fabric rolls (metre-checked elsewhere) are out. */
function stockedLines(rows) {
  return (rows || []).filter((r) => {
    if (!r || !r.product_id) return false;
    if (r.row_type === 'income' || r.item_kind === 'service') return false;
    if (isFabricRollLine(r)) return false;
    return true;
  });
}

function toId(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function keyOf(productId, variantId, warehouseId) {
  return `${productId}|${variantId || 0}|${warehouseId || 0}`;
}

function productKeyOf(productId, warehouseId) {
  return `${productId}|*|${warehouseId || 0}`;
}

/** Same switch invoices.js / warehouse docs use: warehouse flag OR global inventory_allow_negative. */
function salesAllowsNegative(db, warehouseId) {
  if (warehouseId) {
    try {
      const wh = db.prepare('SELECT allow_negative FROM warehouses WHERE id=?').get(warehouseId);
      if (wh && Number(wh.allow_negative)) return true;
    } catch (_) { /* no warehouses table on very old DBs */ }
  }
  try {
    const g = db.prepare("SELECT value FROM settings WHERE key='inventory_allow_negative'").get();
    return !!(g && String(g.value) === '1');
  } catch (_) {
    return false;
  }
}

/**
 * On-hand on the exact layer the sale posts to.
 * @returns {{ qty:number, layer:'variant_warehouse'|'variant'|'warehouse'|'product' }}
 */
function layerOnHand(db, { productId, variantId, warehouseId }) {
  if (variantId) {
    if (warehouseId && tableExists(db, 'variant_warehouse_stock')) {
      const row = db.prepare(
        'SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?'
      ).get(variantId, warehouseId);
      return { qty: row ? round3(Number(row.qty) || 0) : 0, layer: 'variant_warehouse' };
    }
    const v = db.prepare('SELECT stock FROM product_variants WHERE id=?').get(variantId);
    return { qty: round3(Number(v && v.stock) || 0), layer: 'variant' };
  }
  return {
    qty: round3(warehouseQty(db, productId, warehouseId)),
    layer: warehouseId ? 'warehouse' : 'product',
  };
}

/** Active order reservations of the invoice's own customer — the sale is their fulfilment. */
function reservedForSameCustomer(db, productId, warehouseId, custId) {
  if (!custId) return 0;
  if (!tableExists(db, 'inventory_reservations') || !tableExists(db, 'orders')) return 0;
  const row = db.prepare(`
    SELECT COALESCE(SUM(r.qty - r.qty_released - r.qty_consumed), 0) AS q
    FROM inventory_reservations r
    JOIN orders o ON o.id = r.source_id
    WHERE r.product_id=? AND r.status='active' AND r.source_type='order'
      AND (? IS NULL OR r.warehouse_id=? OR r.warehouse_id IS NULL)
      AND o.cust_id=?
  `).get(productId, warehouseId, warehouseId, custId);
  return Math.max(0, Number(row && row.q) || 0);
}

function reservedForOthers(db, productId, warehouseId, custId) {
  if (!tableExists(db, 'inventory_reservations')) return 0;
  const total = Number(reservedQty(db, productId, warehouseId)) || 0;
  const own = reservedForSameCustomer(db, productId, warehouseId, custId);
  return round3(Math.max(0, total - own));
}

/**
 * Firm invoices accepted without a stock movement (backorder / provisional).
 * @returns {Map<string, number>} key → qty, for both SKU keys and product keys.
 */
function committedDemand(db, { excludeInvoiceId = null } = {}) {
  const out = new Map();
  if (!tableExists(db, 'invoices') || !hasColumn(db, 'invoices', 'fulfillment_state')) return out;
  const where = [
    "type IN ('normal','final')",
    'COALESCE(stock_deducted,0)=0',
    `fulfillment_state IN ('${FULFILLMENT_STATES.BACKORDER}','${FULFILLMENT_STATES.PROVISIONAL}')`,
  ];
  if (hasColumn(db, 'invoices', 'deleted_at')) where.push('COALESCE(deleted_at,0)=0');
  if (hasColumn(db, 'invoices', 'status')) where.push("COALESCE(status,'posted') NOT IN ('reversed','void')");
  const params = [];
  if (excludeInvoiceId != null) { where.push('id<>?'); params.push(excludeInvoiceId); }
  const invoices = db.prepare(
    `SELECT id, warehouse_id, rows FROM invoices WHERE ${where.join(' AND ')}`
  ).all(...params);
  for (const inv of invoices) {
    let rows = [];
    try { rows = JSON.parse(inv.rows || '[]'); } catch (_) { rows = []; }
    for (const r of stockedLines(rows)) {
      const productId = toId(r.product_id);
      const variantId = toId(r.variant_id);
      const warehouseId = toId(r.warehouse_id) || toId(inv.warehouse_id);
      const qty = round3(Number(r.qty) || 0);
      if (!productId || qty <= 0) continue;
      const k = keyOf(productId, variantId, warehouseId);
      const pk = productKeyOf(productId, warehouseId);
      out.set(k, round3((out.get(k) || 0) + qty));
      out.set(pk, round3((out.get(pk) || 0) + qty));
    }
  }
  return out;
}

function describe(db, productId, variantId, warehouseId) {
  let name = `کالا #${productId}`;
  let variantLabel = '';
  let warehouseName = warehouseId ? `#${warehouseId}` : '';
  try {
    const p = db.prepare('SELECT name FROM products WHERE id=?').get(productId);
    if (p && p.name) name = p.name;
  } catch (_) { /* ignore */ }
  if (variantId) {
    try {
      const v = db.prepare(`
        SELECT pv.sku, pc.name AS color_name, ps.name AS size_name
        FROM product_variants pv
        LEFT JOIN product_colors pc ON pc.id = pv.color_id
        LEFT JOIN product_sizes ps ON ps.id = pv.size_id
        WHERE pv.id=?
      `).get(variantId);
      if (v) variantLabel = [v.color_name, v.size_name].filter(Boolean).join('/') || v.sku || `واریانت #${variantId}`;
    } catch (_) {
      variantLabel = `واریانت #${variantId}`;
    }
  }
  if (warehouseId) {
    try {
      const w = db.prepare('SELECT name FROM warehouses WHERE id=?').get(warehouseId);
      if (w && w.name) warehouseName = w.name;
    } catch (_) { /* ignore */ }
  }
  return { name, variantLabel, warehouseName };
}

function shortageMessage(s) {
  const who = `«${s.name}${s.variant_label ? ' — ' + s.variant_label : ''}»`;
  const where = s.warehouse_name ? ` در انبار «${s.warehouse_name}»` : '';
  return `موجودی قابل تعهد ${who}${where} کافی نیست — قابل تعهد: ${s.atp}، درخواست: ${s.requested}`
    + ` (موجود: ${s.on_hand}، رزرو دیگران: ${s.reserved}، تعهد ثبت‌شدهٔ قبلی: ${s.committed})`;
}

/**
 * Evaluate ATP for a set of invoice lines. Pure read.
 * @param {object} db
 * @param {Array}  rows               built invoice rows
 * @param {number|null} headerWarehouseId
 * @param {object} [opts]
 * @param {number|null} [opts.custId]           invoice customer — own order reservations are not "others"
 * @param {number|null} [opts.excludeInvoiceId] current invoice id (already inserted) to skip in committed demand
 * @returns {{ shortages: Array, checked: Array }}
 */
function evaluateAvailableToPromise(db, rows, headerWarehouseId, opts = {}) {
  const custId = toId(opts.custId);
  const headerWh = toId(headerWarehouseId);
  const lines = stockedLines(rows);
  const checked = [];
  const shortages = [];
  if (!lines.length) return { shortages, checked };

  const committed = committedDemand(db, { excludeInvoiceId: opts.excludeInvoiceId });

  // Aggregate requested qty per SKU key and per product×warehouse key (two lines of one SKU add up).
  const skuReq = new Map();
  const prodReq = new Map();
  for (const r of lines) {
    const productId = toId(r.product_id);
    const variantId = toId(r.variant_id);
    let warehouseId = toId(r.warehouse_id) || headerWh;
    if (!warehouseId) {
      try {
        const p = db.prepare('SELECT warehouse_id FROM products WHERE id=?').get(productId);
        warehouseId = toId(p && p.warehouse_id);
      } catch (_) { warehouseId = null; }
    }
    const qty = round3(Number(r.qty) || 0);
    if (!productId || qty <= 0) continue;
    const k = keyOf(productId, variantId, warehouseId);
    const cur = skuReq.get(k) || { productId, variantId, warehouseId, qty: 0 };
    cur.qty = round3(cur.qty + qty);
    skuReq.set(k, cur);
    const pk = productKeyOf(productId, warehouseId);
    const pcur = prodReq.get(pk) || { productId, warehouseId, qty: 0 };
    pcur.qty = round3(pcur.qty + qty);
    prodReq.set(pk, pcur);
  }

  const negOkCache = new Map();
  const negOk = (whId) => {
    const k = whId || 0;
    if (!negOkCache.has(k)) negOkCache.set(k, salesAllowsNegative(db, whId));
    return negOkCache.get(k);
  };

  // 1) product × warehouse promise: on_hand − reserved_for_others − committed_product ≥ requested_product
  const productShort = new Set();
  for (const [pk, p] of prodReq) {
    const onHand = round3(warehouseQty(db, p.productId, p.warehouseId));
    const reserved = reservedForOthers(db, p.productId, p.warehouseId, custId);
    const committedQty = round3(committed.get(pk) || 0);
    const atp = round3(onHand - reserved - committedQty);
    const entry = {
      scope: 'product',
      product_id: p.productId,
      variant_id: null,
      warehouse_id: p.warehouseId,
      on_hand: onHand,
      reserved,
      committed: committedQty,
      atp,
      requested: p.qty,
      short_by: round3(Math.max(0, p.qty - atp)),
      bypassed: false,
    };
    if (p.qty > atp + EPS) {
      if (negOk(p.warehouseId)) entry.bypassed = true;
      else {
        Object.assign(entry, describe(db, p.productId, null, p.warehouseId));
        shortages.push(entry);
        productShort.add(pk);
      }
    }
    checked.push(entry);
  }

  // 2) exact layer the movement writes (variant row for colour/size & pack lines, warehouse row otherwise)
  for (const [k, s] of skuReq) {
    if (!s.variantId) continue; // plain line: layer == product×warehouse, already covered above
    const { qty: onHand, layer } = layerOnHand(db, s);
    const committedQty = round3(committed.get(k) || 0);
    const atp = round3(onHand - committedQty);
    const entry = {
      scope: layer,
      product_id: s.productId,
      variant_id: s.variantId,
      warehouse_id: s.warehouseId,
      on_hand: onHand,
      reserved: 0,
      committed: committedQty,
      atp,
      requested: s.qty,
      short_by: round3(Math.max(0, s.qty - atp)),
      bypassed: false,
    };
    if (s.qty > atp + EPS) {
      if (negOk(s.warehouseId)) entry.bypassed = true;
      else {
        // Reported even when the product×warehouse promise already failed — it is the row the user picked.
        Object.assign(entry, describe(db, s.productId, s.variantId, s.warehouseId));
        shortages.push(entry);
      }
    }
    checked.push(entry);
  }

  // Variant shortages first (most specific), then product-level ones.
  shortages.sort((a, b) => (a.variant_id ? 0 : 1) - (b.variant_id ? 0 : 1));
  return { shortages, checked, productShort: [...productShort] };
}

/** Throws 409 E_ATP_INSUFFICIENT on any shortage; returns the evaluation otherwise. */
function assertAvailableToPromise(db, rows, headerWarehouseId, opts = {}) {
  const result = evaluateAvailableToPromise(db, rows, headerWarehouseId, opts);
  if (result.shortages.length) {
    throw atpErr('E_ATP_INSUFFICIENT', 409, shortageMessage(result.shortages[0]), {
      shortages: result.shortages,
    });
  }
  return result;
}

function isBackorderRequested(body) {
  const v = body && body.backorder;
  return v === true || v === 1 || v === '1' || v === 'true';
}

function canAuthorizeBackorder(role) {
  return BACKORDER_ROLES.has(String(role || ''));
}

/** Device build or an explicit offline-provisional request: never firm-deduct locally. */
function isProvisionalRequest(req, isDeviceFn) {
  let device = false;
  try { device = typeof isDeviceFn === 'function' ? !!isDeviceFn() : false; } catch (_) { device = false; }
  const hdr = req && typeof req.get === 'function'
    ? req.get('x-offline-provisional')
    : (req && req.headers ? req.headers['x-offline-provisional'] : undefined);
  return device || String(hdr || '') === '1';
}

/**
 * Decide how a firm sale is fulfilled. Call INSIDE the sale transaction, BEFORE posting stock.
 * @returns {{ mode:'deduct'|'backorder'|'provisional', fulfillment_state:string, shortages:Array, checked:Array }}
 * @throws 409 E_ATP_INSUFFICIENT | 403 E_BACKORDER_FORBIDDEN
 */
function decideSaleFulfillment(db, {
  rows, headerWarehouseId, custId = null, excludeInvoiceId = null,
  backorderRequested = false, role = '', provisional = false,
}) {
  const { shortages, checked } = evaluateAvailableToPromise(db, rows, headerWarehouseId, { custId, excludeInvoiceId });
  let mode = provisional ? 'provisional' : 'deduct';
  if (shortages.length) {
    if (backorderRequested && canAuthorizeBackorder(role)) {
      mode = 'backorder';
    } else if (backorderRequested) {
      throw atpErr('E_BACKORDER_FORBIDDEN', 403,
        'ثبت فروش بدون موجودی (بک‌اوردر) فقط برای مدیر یا حسابدار مجاز است — ' + shortageMessage(shortages[0]),
        { shortages });
    } else {
      throw atpErr('E_ATP_INSUFFICIENT', 409, shortageMessage(shortages[0]), { shortages });
    }
  }
  const fulfillment_state = mode === 'deduct' ? FULFILLMENT_STATES.DEDUCTED : mode;
  return { mode, fulfillment_state, shortages, checked };
}

module.exports = {
  FULFILLMENT_STATES,
  BACKORDER_ROLES,
  evaluateAvailableToPromise,
  assertAvailableToPromise,
  decideSaleFulfillment,
  committedDemand,
  layerOnHand,
  reservedForOthers,
  salesAllowsNegative,
  isBackorderRequested,
  canAuthorizeBackorder,
  isProvisionalRequest,
  shortageMessage,
  stockedLines,
};
