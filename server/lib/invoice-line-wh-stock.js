'use strict';
/**
 * Pure helpers — per-line warehouse stock warnings for the invoice cart (no DB / no DOM).
 * Each XWH-SHARED block is a VERBATIM copy of the same block in server/public/app.js;
 * scripts/test-invoice-line-wh-stock.js asserts byte parity. Edit both together.
 *
 * v583 (Phase 2): stockCache: { 'pid:vid': { [warehouseId]: { on_hand, reserved, own, available, drift, note } } }
 *   (vid = 0 for non-variant). `available` comes from POST /api/inventory/line-availability/batch and
 *   ALREADY includes the edited invoice's own quantity (add-back is server-side). A bare number per
 *   warehouse is still accepted (legacy) and treated as available.
 * collectInvoiceStockWarnings(cart, { headerWh, stockCache, heldFn(kind,id,wh), warehouseName(id), variantLabel(color,size), findProduct(id) })
 *   heldFn is ONLY a fallback while the cache for that product/SKU has not loaded (never added on top of `available`).
 */

/* XWH-SHARED:invLineStockKey */
function invLineStockKey(pid, vid) {
  const p = Number(pid);
  const pSafe = Number.isFinite(p) ? p : 0;
  if (vid == null || vid === '') return String(pSafe) + ':0';
  const v = Number(vid);
  return String(pSafe) + ':' + (Number.isFinite(v) ? String(v) : String(vid));
}
/* /XWH-SHARED */

/* XWH-SHARED:invEffectiveLineWh */
function invEffectiveLineWh(row, headerWh) {
  const raw = row && row.warehouse_id != null && row.warehouse_id !== ''
    ? Number(row.warehouse_id)
    : 0;
  if (Number.isFinite(raw) && raw > 0) return raw;
  const h = Number(headerWh);
  if (Number.isFinite(h) && h > 0) return h;
  return null;
}
/* /XWH-SHARED */

/* XWH-SHARED:invLineStockEntry */
function invLineStockEntry(row, headerWh, stockCache) {
  if (!row) return null;
  const wh = invEffectiveLineWh(row, headerWh);
  if (!wh) return null;
  const cache = stockCache || {};
  const map = cache[invLineStockKey(row.product_id, row.variant_id)];
  if (!map) return null;
  const e = map[wh] != null ? map[wh] : map[String(wh)];
  if (e == null) return null;
  if (typeof e === 'object') {
    return {
      on_hand: Number(e.on_hand) || 0,
      reserved: Number(e.reserved) || 0,
      own: Number(e.own) || 0,
      available: Number(e.available) || 0,
      drift: !!e.drift,
      note: String(e.note || ''),
      drift_variant: !!e.drift_variant,
      info: String(e.info || ''),
      mismatch: !!e.mismatch,
      mismatch_blocking: e.mismatch_blocking != null ? !!e.mismatch_blocking : !!e.mismatch,
      allow_negative: Number(e.allow_negative) ? 1 : 0,
      block_note: String(e.block_note || ''),
      stocked_sku_count: e.stocked_sku_count != null ? Number(e.stocked_sku_count) : null,
    };
  }
  const n = Number(e) || 0;
  return {
    on_hand: n, reserved: 0, own: 0, available: n, drift: false, note: '',
    drift_variant: false, info: '', mismatch: false, mismatch_blocking: false, allow_negative: 0,
    block_note: '', stocked_sku_count: null,
  };
}
/* /XWH-SHARED */
/* XWH-SHARED:invLineAvail */
function invLineAvail(row, headerWh, stockCache) {
  const e = invLineStockEntry(row, headerWh, stockCache);
  return e ? e.available : 0;
}
/* /XWH-SHARED */
/* XWH-SHARED:invGroupStockAt */
function invGroupStockAt(rows, whId, stockCache, variantLabel) {
  const wh = Number(whId) || 0;
  const labelFn = typeof variantLabel === 'function' ? variantLabel : function () { return ''; };
  const order = [];
  const by = {};
  (rows || []).forEach(function (r) {
    if (!r) return;
    const key = invLineStockKey(r.product_id, r.variant_id);
    if (!by[key]) {
      by[key] = {
        key: key,
        product_id: Number(r.product_id) || 0,
        variant_id: Number(r.variant_id) || null,
        label: labelFn(r.color_name || r.color, r.size_name) || '',
        need: 0,
      };
      order.push(key);
    }
    by[key].need += Number(r.qty) || 0;
  });
  let shortN = 0;
  let unknownN = 0;
  let drift = false;
  let mismatch = false;
  let mismatchBlocking = false;
  let mismatchNote = '';
  const skus = order.map(function (key) {
    const g = by[key];
    const e = wh
      ? invLineStockEntry({ product_id: g.product_id, variant_id: g.variant_id, warehouse_id: wh }, wh, stockCache)
      : null;
    const known = !!e;
    const short = known && g.need > e.available + 1e-9;
    if (!known) unknownN += 1;
    if (short) shortN += 1;
    if (known && e.drift) drift = true;
    if (known && e.mismatch) {
      mismatch = true;
      if (e.mismatch_blocking) mismatchBlocking = true;
      if (!mismatchNote) mismatchNote = e.block_note;
    }
    return {
      key: g.key,
      variant_id: g.variant_id,
      label: g.label,
      need: g.need,
      known: known,
      available: known ? e.available : null,
      on_hand: known ? e.on_hand : null,
      reserved: known ? e.reserved : 0,
      own: known ? e.own : 0,
      drift: known ? e.drift : false,
      note: known ? e.note : '',
      drift_variant: known ? e.drift_variant : false,
      info: known ? e.info : '',
      mismatch: known ? e.mismatch : false,
      mismatch_blocking: known ? !!e.mismatch_blocking : false,
      block_note: known ? e.block_note : '',
      short: short,
    };
  });
  return {
    warehouse_id: wh,
    skus: skus,
    shortN: shortN,
    unknownN: unknownN,
    drift: drift,
    mismatch: mismatch,
    mismatchBlocking: mismatchBlocking,
    mismatchNote: mismatchNote,
    // warn-only mismatch (allow_negative=1) does not flip ok / block save
    ok: skus.length > 0 && shortN === 0 && unknownN === 0 && !mismatchBlocking,
  };
}
/* /XWH-SHARED */
/* XWH-SHARED:invGroupStockStatus */
function invGroupStockStatus(info) {
  if (!info || !info.skus || !info.skus.length) return { mode: 'unknown', low: false };
  if (info.skus.length === 1) {
    const s = info.skus[0];
    if (!s.known) return { mode: 'unknown', low: false };
    return { mode: 'num', value: s.available, low: !!s.short };
  }
  if (info.shortN > 0) return { mode: 'short', n: info.shortN, low: true };
  if (info.unknownN > 0) return { mode: 'unknown', low: false };
  return { mode: 'ok', low: false };
}
/* /XWH-SHARED */
/* XWH-SHARED:invCardAvail */
function invCardAvail(productId, whId, stockCache, fallbackWhQty, heldQty, cartQty) {
  const e = invLineStockEntry({ product_id: productId, variant_id: null, warehouse_id: whId }, whId, stockCache);
  const base = e ? e.available : (Number(fallbackWhQty) || 0) + (Number(heldQty) || 0);
  return {
    base: base,
    available: base - (Number(cartQty) || 0),
    from_cache: !!e,
    drift: !!(e && e.drift),
    note: e ? e.note : '',
    info: e ? e.info : '',
    mismatch: !!(e && e.mismatch),
    mismatch_blocking: !!(e && e.mismatch_blocking),
    block_note: e ? e.block_note : '',
  };
}
/* /XWH-SHARED */
/* XWH-SHARED:invOtherWhQty */
function invOtherWhQty(productId, headerWh, whIds, stockCache) {
  let sum = 0;
  (whIds || []).forEach(function (id) {
    if (Number(id) === Number(headerWh)) return;
    const e = invLineStockEntry({ product_id: productId, variant_id: null, warehouse_id: id }, id, stockCache);
    if (e && e.available > 0) sum += e.available;
  });
  return sum;
}
/* /XWH-SHARED */
/* XWH-SHARED:collectInvoiceStockWarnings */
function collectInvoiceStockWarnings(cart, opts) {
  const o = opts || {};
  const headerWh = o.headerWh;
  const stockCache = o.stockCache || {};
  // v583: heldFn is ONLY a fallback while the server availability (already includes the edited
  // invoice's own quantity) has not loaded yet — never added on top of a cached `available`.
  const heldFn = typeof o.heldFn === 'function'
    ? o.heldFn
    : function () { return 0; };
  const warehouseName = typeof o.warehouseName === 'function'
    ? o.warehouseName
    : function (id) { return 'انبار ' + id; };
  const variantLabel = typeof o.variantLabel === 'function'
    ? o.variantLabel
    : function () { return ''; };
  const findProduct = typeof o.findProduct === 'function'
    ? o.findProduct
    : function () { return null; };

  const issues = [];
  const byProd = {};
  const bySku = {};

  (cart || []).forEach(function (r) {
    if (!r || r.row_type === 'income' || r.batch_id || r.is_fabric_roll) return;
    const pid = Number(r.product_id);
    if (!Number.isFinite(pid)) return;
    const qty = Number(r.qty) || 0;
    const wh = invEffectiveLineWh(r, headerWh);
    if (!wh) return;
    const pk = String(pid) + '@' + String(wh);
    if (!byProd[pk]) {
      byProd[pk] = {
        product_id: pid,
        warehouse_id: wh,
        name: r.name || '',
        qty: 0,
      };
    }
    byProd[pk].qty += qty;
    if (!byProd[pk].name && r.name) byProd[pk].name = r.name;

    if (r.variant_id != null && r.variant_id !== '') {
      const vid = String(r.variant_id);
      const sk = vid + '@' + String(wh);
      if (!bySku[sk]) {
        const sku = variantLabel(r.color_name || r.color, r.size_name);
        bySku[sk] = {
          variant_id: Number(r.variant_id) || r.variant_id,
          product_id: pid,
          warehouse_id: wh,
          name: (r.name || '') + (sku ? (' — ' + sku) : ''),
          qty: 0,
        };
      }
      bySku[sk].qty += qty;
    }
  });

  Object.keys(byProd).forEach(function (pk) {
    const g = byProd[pk];
    const sample = { product_id: g.product_id, warehouse_id: g.warehouse_id, variant_id: null };
    const pe = invLineStockEntry(sample, headerWh, stockCache);
    if (pe && pe.mismatch) {
      const mWhName = warehouseName(g.warehouse_id) || ('انبار ' + g.warehouse_id);
      const mBase = g.name || (findProduct(g.product_id) && findProduct(g.product_id).name) || 'کالا';
      issues.push({
        kind: 'variant_layer_mismatch',
        blocking: !!pe.mismatch_blocking,
        product_id: g.product_id,
        warehouse_id: g.warehouse_id,
        name: mBase + ' (' + mWhName + ')',
        wh_name: mWhName,
        need: g.qty,
        avail: pe.available,
        after: pe.available - g.qty,
        note: pe.block_note,
      });
    }
    let avail;
    if (pe) {
      avail = pe.available;
    } else {
      avail = 0;
      const p = findProduct(g.product_id);
      if (p && Number(headerWh) === Number(g.warehouse_id)) {
        avail = Number(p.wh_qty != null ? p.wh_qty : (p.stock || 0)) || 0;
      }
      avail += Number(heldFn('product', g.product_id, g.warehouse_id)) || 0;
    }
    if (g.qty > avail + 1e-9) {
      const whName = warehouseName(g.warehouse_id) || ('انبار ' + g.warehouse_id);
      const baseName = g.name || (findProduct(g.product_id) && findProduct(g.product_id).name) || 'کالا';
      issues.push({
        kind: 'product',
        product_id: g.product_id,
        warehouse_id: g.warehouse_id,
        name: baseName + ' (' + whName + ')',
        wh_name: whName,
        need: g.qty,
        avail: avail,
        after: avail - g.qty,
      });
    }
  });

  Object.keys(bySku).forEach(function (sk) {
    const g = bySku[sk];
    const sample = {
      product_id: g.product_id,
      warehouse_id: g.warehouse_id,
      variant_id: g.variant_id,
    };
    const se = invLineStockEntry(sample, headerWh, stockCache);
    let avail;
    if (se) {
      avail = se.available;
    } else {
      avail = Number(heldFn('sku', g.variant_id, g.warehouse_id)) || 0;
    }
    if (g.qty > avail + 1e-9) {
      const whName = warehouseName(g.warehouse_id) || ('انبار ' + g.warehouse_id);
      issues.push({
        kind: 'sku',
        product_id: g.product_id,
        variant_id: g.variant_id,
        warehouse_id: g.warehouse_id,
        name: (g.name || 'SKU') + ' (' + whName + ')',
        wh_name: whName,
        need: g.qty,
        avail: avail,
        after: avail - g.qty,
      });
    }
  });

  return issues;
}
/* /XWH-SHARED */

module.exports = {
  invLineStockKey,
  invEffectiveLineWh,
  invLineStockEntry,
  invLineAvail,
  invGroupStockAt,
  invGroupStockStatus,
  invCardAvail,
  invOtherWhQty,
  collectInvoiceStockWarnings,
};
