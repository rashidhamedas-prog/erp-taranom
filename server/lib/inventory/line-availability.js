'use strict';
/**
 * v580 Phase 1 (invoice-stock-display) — single server-side source of truth for the
 * «sellable quantity» shown on invoice lines (popover, row label, picker card, warnings).
 *
 *   available = on_hand − reserved + own_doc_qty
 *
 * READ-ONLY: never INSERT / UPDATE / seed. No new tables.
 *
 * on_hand layer == the layer shortage control enforces (verified against the code):
 *   • variant line → variant_warehouse_stock via movement.variantWarehouseQty
 *       (postInventoryMovement checks vws "whBefore", available-to-promise checks the same fn)
 *   • product line → warehouse_stock via ledger.warehouseQty
 *       (applyStockDelta / ATP / amend assertSaleIncreasesCovered use the same fn).
 *       warehouseQty keeps one legacy rule: a MISSING warehouse_stock row on the product's own
 *       header warehouse reads products.stock (same rule postSaleStockMovements seeds with).
 *       That case is flagged `legacy_header_fallback:true` so the UI can tell it apart.
 *   • product_variants.stock / products.stock are NEVER used for a specified warehouse
 *       (this is what produced 32/57 for product 131 — the default variant 412).
 *
 * reserved: inventory_reservations are product×warehouse (no variant column) — same
 *   reservation.reservedQty ATP uses. For variant rows `reserved_scope:'product'`.
 *
 * own_doc_qty: what the invoice being EDITED already took out of that product/variant×warehouse
 *   (stock_deducted=1, not proforma, not reversed/deleted). Server twin of the client
 *   captureInvoiceStockBaseline. Effective warehouse = row.warehouse_id || invoice.warehouse_id
 *   || product header warehouse (same resolution amend-invoice.resolveLineWh uses at posting).
 *
 * Consistency (read-only, never changes the number):
 *   kardex_qty (product×warehouse, Σ live ledger), movements_qty (Σ inventory_movements.qty_delta
 *   of that variant×warehouse), drift_product (warehouse_stock vs kardex), drift_variant
 *   (vws vs movements), drift (either), layer_note (Persian, '' when consistent).
 */
const { warehouseQty } = require('./ledger');
const { variantWarehouseQty } = require('./movement');

const EPS = 1e-6;
const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function toPosInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseRows(raw) {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw || '[]'); } catch (_) { return []; }
}

/** Per-call memo so a 100-item batch reads kardex / reservations once per product. */
function makeCtx(db, opts = {}) {
  return {
    db,
    warehouses: null,
    kardexByProduct: new Map(),
    ownDoc: undefined,
    excludeInvoiceId: toPosInt(opts.excludeInvoiceId),
    hasReservations: tableExists(db, 'inventory_reservations'),
    hasMovements: tableExists(db, 'inventory_movements'),
    hasVws: tableExists(db, 'variant_warehouse_stock'),
  };
}

function activeWarehouses(ctx, warehouseIds) {
  if (!ctx.warehouses) {
    ctx.warehouses = ctx.db.prepare(
      'SELECT id, name, COALESCE(allow_negative,0) AS allow_negative FROM warehouses WHERE active=1 ORDER BY id'
    ).all();
  }
  if (Array.isArray(warehouseIds) && warehouseIds.length) {
    const want = new Set(warehouseIds.map((w) => Number(w)).filter((w) => w > 0));
    return ctx.warehouses.filter((w) => want.has(Number(w.id)));
  }
  return ctx.warehouses;
}

function kardexFor(ctx, productId) {
  if (ctx.kardexByProduct.has(productId)) return ctx.kardexByProduct.get(productId);
  let map = null;
  try {
    const { buildLedgerValuationRows } = require('./valuation');
    map = new Map(buildLedgerValuationRows(ctx.db, { productId, skipDrift: true }).rows.map((r) => [Number(r.warehouse_id), r]));
  } catch (_) { map = null; }
  ctx.kardexByProduct.set(productId, map);
  return map;
}

/**
 * Lines of the invoice being edited that currently hold stock.
 * Returns { prod: Map('pid@wh'→qty), sku: Map('vid@wh'→qty) } or empty maps.
 */
function loadOwnDoc(ctx) {
  if (ctx.ownDoc !== undefined) return ctx.ownDoc;
  const empty = { prod: new Map(), sku: new Map(), counted: false };
  ctx.ownDoc = empty;
  const id = ctx.excludeInvoiceId;
  if (!id) return empty;
  const db = ctx.db;
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(id);
  if (!inv) return empty;
  if (!Number(inv.stock_deducted)) return empty;
  if (String(inv.type || '') === 'proforma') return empty;
  if (String(inv.status || '') === 'reversed') return empty;
  if (inv.deleted_at && Number(inv.deleted_at) !== 0) return empty;

  const headerWh = Number(inv.warehouse_id) || 0;
  const prodWh = db.prepare('SELECT warehouse_id FROM products WHERE id=?');
  const prod = new Map();
  const sku = new Map();
  for (const r of parseRows(inv.rows)) {
    // Same filter as the client baseline (income / fabric-roll / batch lines never counted).
    if (!r || r.row_type === 'income' || r.item_kind === 'service' || r.batch_id || r.is_fabric_roll) continue;
    const pid = Number(r.product_id) || 0;
    if (!pid) continue;
    let wh = Number(r.warehouse_id) || headerWh;
    if (!wh) {
      const p = prodWh.get(pid);
      wh = p && p.warehouse_id ? Number(p.warehouse_id) : 0;
    }
    if (!wh) continue;
    const qty = Number(r.qty) || 0;
    prod.set(`${pid}@${wh}`, (prod.get(`${pid}@${wh}`) || 0) + qty);
    const vid = Number(r.variant_id) || 0;
    if (vid) sku.set(`${vid}@${wh}`, (sku.get(`${vid}@${wh}`) || 0) + qty);
  }
  ctx.ownDoc = { prod, sku, counted: true };
  return ctx.ownDoc;
}

function reservedFor(ctx, productId, whId) {
  if (!ctx.hasReservations) return 0;
  try {
    const { reservedQty } = require('./reservation');
    return round3(reservedQty(ctx.db, productId, whId));
  } catch (_) { return 0; }
}

function movementsQty(ctx, variantId, whId) {
  if (!ctx.hasMovements) return null;
  const row = ctx.db.prepare(
    'SELECT COALESCE(SUM(qty_delta),0) AS q FROM inventory_movements WHERE variant_id=? AND warehouse_id=?'
  ).get(variantId, whId);
  return round3(Number(row && row.q) || 0);
}

function lineAvailabilityWith(ctx, { productId, variantId = null, warehouseIds = null }) {
  const db = ctx.db;
  const pid = toPosInt(productId);
  const vid = toPosInt(variantId);
  if (!pid) return [];
  const isVariant = !!vid;
  const kardex = kardexFor(ctx, pid);
  const own = loadOwnDoc(ctx);
  const productRow = db.prepare('SELECT warehouse_id, stock FROM products WHERE id=?').get(pid);
  const wsHas = db.prepare('SELECT 1 FROM warehouse_stock WHERE product_id=? AND warehouse_id=?');

  return activeWarehouses(ctx, warehouseIds).map((w) => {
    const whId = Number(w.id);
    const productWhQty = round3(warehouseQty(db, pid, whId));
    const legacyFallback = !wsHas.get(pid, whId)
      && !!productRow && Number(productRow.warehouse_id) === whId && productWhQty !== 0;

    const onHand = isVariant ? round3(variantWarehouseQty(db, vid, whId)) : productWhQty;
    const reserved = reservedFor(ctx, pid, whId);
    const ownDocQty = round3(own.counted
      ? (isVariant ? own.sku.get(`${vid}@${whId}`) : own.prod.get(`${pid}@${whId}`)) || 0
      : 0);
    const available = round3(onHand - reserved + ownDocQty);

    const k = kardex ? (kardex.get(whId) || null) : null;
    const kardexQty = kardex ? round3(k ? k.ledger_qty : 0) : null;
    const driftProduct = kardexQty != null && Math.abs(productWhQty - kardexQty) > EPS;
    const mvQty = isVariant ? movementsQty(ctx, vid, whId) : null;
    const driftVariant = isVariant && mvQty != null && Math.abs(onHand - mvQty) > EPS;

    const notes = [];
    if (driftProduct) notes.push(`⚠ ناهمخوان با کاردکس (موجودی انبار ${productWhQty}، کاردکس ${kardexQty})`);
    if (driftVariant) notes.push(`⚠ موجودی رنگ/سایز بدون سند حرکت کامل (موجودی ${onHand}، جمع حرکت‌ها ${mvQty})`);
    if (legacyFallback) notes.push('موجودی از سربرگ کالا خوانده شد (ردیف انبار ثبت نشده)');

    return {
      warehouse_id: whId,
      name: String(w.name || ''),
      allow_negative: Number(w.allow_negative) ? 1 : 0,
      source: isVariant ? 'vws' : 'warehouse_stock',
      on_hand: onHand,
      reserved,
      reserved_scope: isVariant ? 'product' : 'product_warehouse',
      own_doc_qty: ownDocQty,
      available,
      product_wh_qty: productWhQty,
      kardex_qty: kardexQty,
      kardex_value_rial: k ? k.ledger_value_rial : (kardex ? 0 : null),
      weighted_avg_unit_rial: k ? k.weighted_avg_unit_rial : (kardex ? 0 : null),
      movements_qty: mvQty,
      drift_qty: kardexQty != null ? round3(productWhQty - kardexQty) : null,
      drift_product: driftProduct,
      drift_variant: driftVariant,
      drift: driftProduct || driftVariant,
      legacy_header_fallback: legacyFallback,
      layer_note: notes.join(' | '),
    };
  });
}

/**
 * @param {object} db
 * @param {{productId:number, variantId?:number|null, warehouseIds?:number[], excludeInvoiceId?:number}} args
 * @returns {Array} one entry per active warehouse (or the requested subset)
 */
function lineAvailability(db, args = {}) {
  return lineAvailabilityWith(makeCtx(db, { excludeInvoiceId: args.excludeInvoiceId }), args);
}

/** items: [{product_id, variant_id}] → [{product_id, variant_id, warehouses}] sharing one memo. */
function lineAvailabilityBatch(db, items, opts = {}) {
  const ctx = makeCtx(db, opts);
  const out = [];
  for (const it of items || []) {
    const productId = toPosInt(it && it.product_id);
    if (!productId) continue;
    const variantId = toPosInt(it && it.variant_id);
    out.push({
      product_id: productId,
      variant_id: variantId,
      warehouses: lineAvailabilityWith(ctx, { productId, variantId, warehouseIds: opts.warehouseIds }),
    });
  }
  return out;
}

module.exports = { lineAvailability, lineAvailabilityBatch };
