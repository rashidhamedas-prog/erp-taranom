'use strict';
/**
 * Pure helpers — per-line warehouse stock warnings for the invoice cart (no DB / no DOM).
 * Each XWH-SHARED block is a VERBATIM copy of the same block in server/public/app.js;
 * scripts/test-invoice-line-wh-stock.js asserts byte parity. Edit both together.
 *
 * stockCache: { 'pid:vid': { [warehouseId]: qty } }  (vid = 0 for non-variant)
 * collectInvoiceStockWarnings(cart, { headerWh, stockCache, heldFn(kind,id,wh), warehouseName(id), variantLabel(color,size), findProduct(id) })
 *   kind 'product' → heldFn('product', productId, wh); kind 'sku' → heldFn('sku', variantId, wh)
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

/* XWH-SHARED:invLineAvail */
function invLineAvail(row, headerWh, stockCache) {
  if (!row) return 0;
  const wh = invEffectiveLineWh(row, headerWh);
  if (!wh) return 0;
  const cache = stockCache || {};
  const key = invLineStockKey(row.product_id, row.variant_id);
  const map = cache[key];
  if (map && map[wh] != null) return Number(map[wh]) || 0;
  if (map && map[String(wh)] != null) return Number(map[String(wh)]) || 0;
  return 0;
}
/* /XWH-SHARED */

/* XWH-SHARED:collectInvoiceStockWarnings */
function collectInvoiceStockWarnings(cart, opts) {
  const o = opts || {};
  const headerWh = o.headerWh;
  const stockCache = o.stockCache || {};
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
    let avail = invLineAvail(sample, headerWh, stockCache);
    if (!(stockCache[invLineStockKey(g.product_id, null)] || stockCache[invLineStockKey(g.product_id, 0)])) {
      const p = findProduct(g.product_id);
      if (p && Number(headerWh) === Number(g.warehouse_id)) {
        avail = Number(p.wh_qty != null ? p.wh_qty : (p.stock || 0)) || 0;
      }
    }
    avail += Number(heldFn('product', g.product_id, g.warehouse_id)) || 0;
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
    let avail = invLineAvail(sample, headerWh, stockCache);
    avail += Number(heldFn('sku', g.variant_id, g.warehouse_id)) || 0;
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
  invLineAvail,
  collectInvoiceStockWarnings,
};
