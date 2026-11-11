'use strict';

/**
 * Live color×size stock report for the warehouse reports section.
 * Warehouse rows win over variant.stock so the same pieces are not counted twice.
 * If a product already sits in a warehouse, missing color×size rows are qty 0
 * so a broken size run stays visible.
 */

function tableExists(db, table) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(table);
}

function columnSet(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

function n3(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function parseId(value) {
  if (value == null || value === '') return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseLow(value) {
  if (value == null || value === '') return 2;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 2;
  return n3(n);
}

function sqlExpr(cols, alias, name, fallback) {
  return cols.has(name) ? `${alias}.${name}` : fallback;
}

function unitCostOf(row) {
  const variantCost = Number(row.variant_cost) || 0;
  if (variantCost > 0) return Math.round(variantCost);
  return Math.round(Number(row.product_cost) || 0);
}

function unitPriceOf(row) {
  const variantRial = Math.round(Number(row.variant_price_rial) || 0);
  if (variantRial > 0) return variantRial;
  const variantPrice = Math.round(Number(row.variant_price) || 0);
  if (variantPrice > 0) return variantPrice;
  const productRial = Math.round(Number(row.product_price_rial) || 0);
  if (productRial > 0) return productRial;
  return Math.round(Number(row.product_price) || 0);
}

function loadOptions(db) {
  const empty = { warehouses: [], products: [], colors: [], sizes: [], categories: [] };
  if (!tableExists(db, 'product_variants') || !tableExists(db, 'products')) return empty;

  const whCols = columnSet(db, 'warehouses');
  let warehouses = [];
  if (whCols.size) {
    const activeSql = whCols.has('active') ? ' WHERE active=1' : '';
    warehouses = db.prepare(
      `SELECT id, name${whCols.has('code') ? ', code' : ''} FROM warehouses${activeSql} ORDER BY name`
    ).all();
  }

  const colors = tableExists(db, 'product_colors')
    ? db.prepare(`
        SELECT id, name, COALESCE(hex,'') AS hex, COALESCE(sort_order,0) AS sort_order
        FROM product_colors
        ${columnSet(db, 'product_colors').has('active') ? 'WHERE active=1' : ''}
        ORDER BY sort_order, name
      `).all()
    : [];

  const sizes = tableExists(db, 'product_sizes')
    ? db.prepare(`
        SELECT id, name, COALESCE(sort_order,0) AS sort_order
        FROM product_sizes
        ${columnSet(db, 'product_sizes').has('active') ? 'WHERE active=1' : ''}
        ORDER BY sort_order, name
      `).all()
    : [];

  const vCols = columnSet(db, 'product_variants');
  const where = ['1=1'];
  if (vCols.has('active')) where.push('v.active=1');
  if (vCols.has('is_default')) where.push('v.is_default=0');
  if (vCols.has('color_id')) where.push('v.color_id IS NOT NULL');
  if (vCols.has('size_id')) where.push('v.size_id IS NOT NULL');
  const products = db.prepare(`
    SELECT DISTINCT p.id, COALESCE(p.code,'') AS code, p.name
    FROM products p
    JOIN product_variants v ON v.product_id=p.id
    WHERE ${where.join(' AND ')}
    ORDER BY p.name
  `).all();

  const pCols = columnSet(db, 'products');
  const hasCats = tableExists(db, 'product_categories') && pCols.has('category_id');
  const catExpr = hasCats
    ? "COALESCE(pcat.name, p.category, '')"
    : (pCols.has('category') ? "COALESCE(p.category, '')" : "''");
  const catJoin = hasCats ? 'LEFT JOIN product_categories pcat ON pcat.id=p.category_id' : '';
  const categories = db.prepare(`
    SELECT DISTINCT ${catExpr} AS name
    FROM products p
    JOIN product_variants v ON v.product_id=p.id
    ${catJoin}
    WHERE ${where.join(' AND ')}
    ORDER BY name
  `).all().filter((row) => String(row.name || '').trim());

  return { warehouses, products, colors, sizes, categories };
}

function loadVariantRows(db) {
  if (!tableExists(db, 'product_variants') || !tableExists(db, 'products')) return [];
  const vCols = columnSet(db, 'product_variants');
  const pCols = columnSet(db, 'products');
  const where = ['1=1'];
  if (vCols.has('active')) where.push('v.active=1');
  if (vCols.has('is_default')) where.push('v.is_default=0');
  if (vCols.has('color_id')) where.push('v.color_id IS NOT NULL');
  if (vCols.has('size_id')) where.push('v.size_id IS NOT NULL');

  const hasCats = tableExists(db, 'product_categories') && pCols.has('category_id');
  const catExpr = hasCats
    ? "COALESCE(pcat.name, p.category, '')"
    : (pCols.has('category') ? "COALESCE(p.category, '')" : "''");
  const catJoin = hasCats ? 'LEFT JOIN product_categories pcat ON pcat.id=p.category_id' : '';
  const colorJoin = tableExists(db, 'product_colors')
    ? 'LEFT JOIN product_colors c ON c.id=v.color_id'
    : '';
  const sizeJoin = tableExists(db, 'product_sizes')
    ? 'LEFT JOIN product_sizes s ON s.id=v.size_id'
    : '';

  return db.prepare(`
    SELECT
      v.id AS variant_id,
      ${sqlExpr(vCols, 'v', 'sku', "''")} AS sku,
      ${sqlExpr(vCols, 'v', 'stock', '0')} AS variant_stock,
      ${sqlExpr(vCols, 'v', 'cost', '0')} AS variant_cost,
      ${sqlExpr(vCols, 'v', 'price', '0')} AS variant_price,
      ${sqlExpr(vCols, 'v', 'price_rial', '0')} AS variant_price_rial,
      ${sqlExpr(vCols, 'v', 'color_id', 'NULL')} AS color_id,
      ${sqlExpr(vCols, 'v', 'size_id', 'NULL')} AS size_id,
      p.id AS product_id,
      ${sqlExpr(pCols, 'p', 'code', "''")} AS product_code,
      p.name AS product_name,
      ${sqlExpr(pCols, 'p', 'cost', '0')} AS product_cost,
      ${sqlExpr(pCols, 'p', 'price', '0')} AS product_price,
      ${sqlExpr(pCols, 'p', 'price_rial', '0')} AS product_price_rial,
      ${sqlExpr(pCols, 'p', 'warehouse_id', 'NULL')} AS product_warehouse_id,
      ${catExpr} AS category_name,
      ${colorJoin ? "COALESCE(c.name,'')" : "''"} AS color_name,
      ${colorJoin ? "COALESCE(c.hex,'')" : "''"} AS color_hex,
      ${colorJoin ? 'COALESCE(c.sort_order,0)' : '0'} AS color_sort,
      ${sizeJoin ? "COALESCE(s.name,'')" : "''"} AS size_name,
      ${sizeJoin ? 'COALESCE(s.sort_order,0)' : '0'} AS size_sort
    FROM product_variants v
    JOIN products p ON p.id=v.product_id
    ${catJoin}
    ${colorJoin}
    ${sizeJoin}
    WHERE ${where.join(' AND ')}
  `).all();
}

/**
 * Stock maps for the colour report:
 *   attributed  — live ledger rows with variant_id (source of truth for totals)
 *   cacheOnly   — VWS fallback for variants that have ZERO live attributed rows
 *   unattributed — live ledger Σ with variant_id NULL/≤0 per product×warehouse
 */
function loadStockMaps(db) {
  const attributed = new Map();
  const cacheOnly = new Map();
  const unattributed = new Map();
  const hasAttributed = new Set();
  if (tableExists(db, 'inventory_ledger') && columnSet(db, 'inventory_ledger').has('variant_id')) {
    const { LEDGER_LIVE_SQL } = require('./layer-reconcile');
    const lRows = db.prepare(`
      SELECT product_id, variant_id, warehouse_id,
        SUM(COALESCE(qty_in,0) - COALESCE(qty_out,0)) AS qty
      FROM inventory_ledger
      WHERE (${LEDGER_LIVE_SQL}) AND warehouse_id IS NOT NULL
      GROUP BY product_id, variant_id, warehouse_id
    `).all();
    for (const row of lRows) {
      const wh = Number(row.warehouse_id);
      const qty = Number(row.qty) || 0;
      const vid = row.variant_id != null && Number(row.variant_id) > 0 ? Number(row.variant_id) : null;
      if (vid) {
        hasAttributed.add(vid);
        if (!attributed.has(vid)) attributed.set(vid, []);
        attributed.get(vid).push({ warehouse_id: wh, qty, source: 'ledger' });
      } else {
        const k = `${Number(row.product_id)}:${wh}`;
        unattributed.set(k, n3((unattributed.get(k) || 0) + qty));
      }
    }
  }
  if (tableExists(db, 'variant_warehouse_stock')) {
    const rows = db.prepare(
      'SELECT variant_id, warehouse_id, qty FROM variant_warehouse_stock'
    ).all();
    for (const row of rows) {
      const id = Number(row.variant_id);
      if (hasAttributed.has(id)) continue;
      if (!cacheOnly.has(id)) cacheOnly.set(id, []);
      cacheOnly.get(id).push({
        warehouse_id: Number(row.warehouse_id),
        qty: Number(row.qty) || 0,
        source: 'cache',
      });
    }
  }
  return { attributed, cacheOnly, unattributed };
}

/** @deprecated use loadStockMaps — kept for callers that expect the old Map shape */
function loadVws(db) {
  const { attributed, cacheOnly } = loadStockMaps(db);
  const map = new Map();
  for (const [vid, rows] of attributed) map.set(vid, rows);
  for (const [vid, rows] of cacheOnly) {
    if (!map.has(vid)) map.set(vid, rows);
  }
  return map;
}

function warehouseNames(db) {
  const map = new Map();
  if (!tableExists(db, 'warehouses')) return map;
  for (const row of db.prepare('SELECT id, name FROM warehouses').all()) {
    map.set(Number(row.id), row.name || ('انبار ' + row.id));
  }
  return map;
}

function makeCell(row, warehouseId, qty, whName, extra) {
  const q = n3(qty);
  const unitCost = unitCostOf(row);
  const unitPrice = unitPriceOf(row);
  const whId = Number(warehouseId) || 0;
  const cell = {
    variant_id: Number(row.variant_id),
    sku: row.sku || '',
    product_id: Number(row.product_id),
    code: row.product_code || '',
    name: row.product_name || '',
    category: row.category_name || '',
    warehouse_id: whId,
    warehouse_name: whId ? (whName.get(whId) || ('انبار ' + whId)) : 'تخصیص‌نیافته',
    color_id: Number(row.color_id) || 0,
    color_name: row.color_name || 'بدون رنگ',
    color_hex: row.color_hex || '',
    color_sort: Number(row.color_sort) || 0,
    size_id: Number(row.size_id) || 0,
    size_name: row.size_name || 'بدون سایز',
    size_sort: Number(row.size_sort) || 0,
    qty: q,
    unit_cost_rial: unitCost,
    unit_price_rial: unitPrice,
    amount_rial: Math.round(q * unitCost),
    sales_value_rial: Math.round(q * unitPrice),
    source: 'ledger',
  };
  if (extra && typeof extra === 'object') Object.assign(cell, extra);
  return cell;
}

function buildCells(variants, stockMaps, whName, warehouseFilter) {
  const attributed = stockMaps.attributed || new Map();
  const cacheOnly = stockMaps.cacheOnly || new Map();
  const unattributed = stockMaps.unattributed || new Map();
  const byProduct = new Map();
  for (const row of variants) {
    const id = Number(row.product_id);
    if (!byProduct.has(id)) byProduct.set(id, []);
    byProduct.get(id).push(row);
  }
  const cells = [];
  for (const list of byProduct.values()) {
    const pid = Number(list[0].product_id);
    const touched = new Set();
    for (const row of list) {
      const vid = Number(row.variant_id);
      for (const stock of (attributed.get(vid) || cacheOnly.get(vid) || [])) {
        if (stock.warehouse_id) touched.add(stock.warehouse_id);
      }
    }
    for (const [k, q] of unattributed) {
      if (Math.abs(Number(q) || 0) < 1e-9) continue;
      const [p, w] = k.split(':').map(Number);
      if (p === pid && w) touched.add(w);
    }
    const home = Number(list[0].product_warehouse_id) || 0;
    let warehouses;
    if (warehouseFilter) {
      if (touched.has(warehouseFilter) || (!touched.size && home === warehouseFilter)) {
        warehouses = [warehouseFilter];
      } else continue;
    } else if (touched.size) {
      warehouses = [...touched];
    } else {
      warehouses = [home];
    }
    const useHeader = touched.size === 0;
    for (const row of list) {
      const vid = Number(row.variant_id);
      const attrRows = attributed.get(vid) || null;
      const cacheRows = !attrRows ? (cacheOnly.get(vid) || null) : null;
      const byWh = new Map((attrRows || cacheRows || []).map((stock) => [stock.warehouse_id, stock]));
      const source = attrRows ? 'ledger' : (cacheRows ? 'cache' : 'ledger');
      for (const whId of warehouses) {
        let qty;
        if (useHeader) qty = Number(row.variant_stock) || 0;
        else if (byWh.has(whId)) qty = byWh.get(whId).qty;
        else qty = 0;
        cells.push(makeCell(row, whId, qty, whName, { source }));
      }
    }
    const unitCost = unitCostOf(list[0]);
    const unitPrice = unitPriceOf(list[0]);
    for (const whId of warehouses) {
      const uq = unattributed.get(`${pid}:${whId}`);
      if (uq == null || Math.abs(Number(uq) || 0) < 1e-9) continue;
      const q = n3(uq);
      cells.push({
        variant_id: 0,
        sku: '',
        product_id: pid,
        code: list[0].product_code || '',
        name: list[0].product_name || '',
        category: list[0].category_name || '',
        warehouse_id: whId,
        warehouse_name: whName.get(whId) || ('انبار ' + whId),
        color_id: 0,
        color_name: 'بدون رنگ/سایز',
        color_hex: '',
        color_sort: 9999,
        size_id: 0,
        size_name: 'بدون رنگ/سایز',
        size_sort: 9999,
        qty: q,
        unit_cost_rial: unitCost,
        unit_price_rial: unitPrice,
        amount_rial: Math.round(q * unitCost),
        sales_value_rial: Math.round(q * unitPrice),
        source: 'ledger',
        unattributed: true,
      });
    }
  }
  return cells;
}

function cellHay(cell) {
  return [
    cell.code, cell.name, cell.category, cell.sku,
    cell.color_name, cell.size_name, cell.warehouse_name,
  ].join(' ').toLowerCase();
}

function applyFilters(cells, filters, opts) {
  const ignoreSize = opts && opts.ignoreSize;
  const q = String(filters.q || '').trim().toLowerCase();
  return cells.filter((cell) => {
    if (filters.productId && cell.product_id !== filters.productId) return false;
    if (filters.category && cell.category !== filters.category) return false;
    if (filters.colorId && cell.color_id !== filters.colorId) return false;
    if (!ignoreSize && filters.sizeId && cell.size_id !== filters.sizeId) return false;
    if (q && !cellHay(cell).includes(q)) return false;
    return true;
  });
}

function bySize(a, b) {
  return (a.size_sort - b.size_sort) || String(a.size_name).localeCompare(String(b.size_name), 'fa') || (a.size_id - b.size_id);
}

function summarize(cells, lowQty) {
  let totalQty = 0;
  let cost = 0;
  let sales = 0;
  let low = 0;
  let cacheOnlyQty = 0;
  let unattributedQty = 0;
  const unattributedProducts = new Set();
  const colors = new Set();
  const sizes = new Set();
  const products = new Set();
  const skuQty = new Map();
  const colorMap = new Map();
  const sizeMap = new Map();
  const productMap = new Map();

  for (const cell of cells) {
    const qty = Number(cell.qty) || 0;
    const isCache = cell.source === 'cache';
    const isUnattr = !!cell.unattributed;
    if (isCache) {
      cacheOnlyQty = n3(cacheOnlyQty + qty);
      continue; // display-only — not in totals / by_*
    }
    totalQty += qty;
    if (isUnattr) {
      unattributedQty = n3(unattributedQty + qty);
      unattributedProducts.add(cell.product_id);
    } else {
      skuQty.set(cell.variant_id, (skuQty.get(cell.variant_id) || 0) + qty);
    }
    if (qty > 0 || isUnattr) {
      if (qty > 0) {
        cost += cell.amount_rial;
        sales += cell.sales_value_rial;
      }
      colors.add(cell.color_id);
      sizes.add(cell.size_id);
      products.add(cell.product_id);
      if (qty > 0 && qty <= lowQty) low += 1;
    }

    if (!colorMap.has(cell.color_id)) {
      colorMap.set(cell.color_id, {
        color_id: cell.color_id, name: cell.color_name, hex: cell.color_hex,
        sort: cell.color_sort, qty: 0, sku_count: 0, sales_value_rial: 0,
        unattributed: isUnattr,
      });
    }
    const color = colorMap.get(cell.color_id);
    color.qty = n3(color.qty + qty);
    if (qty > 0 || isUnattr) {
      color.sku_count += 1;
      if (qty > 0) color.sales_value_rial += cell.sales_value_rial;
    }

    if (!sizeMap.has(cell.size_id)) {
      sizeMap.set(cell.size_id, {
        size_id: cell.size_id, name: cell.size_name, sort: cell.size_sort,
        qty: 0, sku_count: 0, unattributed: isUnattr,
      });
    }
    const size = sizeMap.get(cell.size_id);
    size.qty = n3(size.qty + qty);
    if (qty > 0 || isUnattr) size.sku_count += 1;

    if (!productMap.has(cell.product_id)) {
      productMap.set(cell.product_id, {
        product_id: cell.product_id, code: cell.code, name: cell.name, category: cell.category,
        qty: 0, sales_value_rial: 0, amount_rial: 0,
        colors: new Set(), sizes: new Set(), sku_count: 0,
      });
    }
    const product = productMap.get(cell.product_id);
    product.qty = n3(product.qty + qty);
    if (qty > 0 || isUnattr) {
      if (qty > 0) {
        product.sales_value_rial += cell.sales_value_rial;
        product.amount_rial += cell.amount_rial;
      }
      product.colors.add(cell.color_id);
      product.sizes.add(cell.size_id);
      if (!isUnattr && qty > 0) product.sku_count += 1;
    }
  }

  let skuIn = 0;
  let skuZero = 0;
  for (const qty of skuQty.values()) {
    if (qty > 0) skuIn += 1;
    else skuZero += 1;
  }

  const keepAgg = (row) => Math.abs(Number(row.qty) || 0) > 1e-9;
  const byColor = [...colorMap.values()]
    .filter(keepAgg)
    .sort((a, b) => b.qty - a.qty || a.sort - b.sort);
  const bySize = [...sizeMap.values()]
    .filter(keepAgg)
    .sort((a, b) => b.qty - a.qty || a.sort - b.sort);
  const byProduct = [...productMap.values()]
    .filter(keepAgg)
    .map((row) => ({
      product_id: row.product_id,
      code: row.code,
      name: row.name,
      category: row.category,
      qty: row.qty,
      sales_value_rial: row.sales_value_rial,
      amount_rial: row.amount_rial,
      color_count: row.colors.size,
      size_count: row.sizes.size,
      sku_count: row.sku_count,
    }))
    .sort((a, b) => b.qty - a.qty || String(a.name).localeCompare(String(b.name), 'fa'));

  return {
    kpis: {
      total_qty: n3(totalQty),
      cost_value_rial: Math.round(cost),
      sales_value_rial: Math.round(sales),
      color_count: colors.size,
      size_count: sizes.size,
      product_count: products.size,
      sku_in_stock: skuIn,
      sku_zero: skuZero,
      low_count: low,
      low_qty: lowQty,
      cache_only_qty: n3(cacheOnlyQty),
      unattributed_qty: n3(unattributedQty),
      unattributed_products: unattributedProducts.size,
    },
    by_color: byColor,
    by_size: bySize,
    by_product: byProduct,
  };
}

function findGaps(cells) {
  const sizesByProduct = new Map();
  for (const cell of cells) {
    if (!sizesByProduct.has(cell.product_id)) sizesByProduct.set(cell.product_id, new Map());
    const sizes = sizesByProduct.get(cell.product_id);
    if (!sizes.has(cell.size_id)) {
      sizes.set(cell.size_id, {
        size_id: cell.size_id, size_name: cell.size_name, size_sort: cell.size_sort,
      });
    }
  }
  const groups = new Map();
  for (const cell of cells) {
    const key = cell.warehouse_id + '|' + cell.product_id + '|' + cell.color_id;
    if (!groups.has(key)) {
      groups.set(key, {
        product_id: cell.product_id,
        code: cell.code,
        name: cell.name,
        warehouse_id: cell.warehouse_id,
        warehouse_name: cell.warehouse_name,
        color_id: cell.color_id,
        color_name: cell.color_name,
        color_hex: cell.color_hex,
        bySize: new Map(),
      });
    }
    const group = groups.get(key);
    group.bySize.set(cell.size_id, n3((group.bySize.get(cell.size_id) || 0) + (Number(cell.qty) || 0)));
  }

  const gaps = [];
  for (const group of groups.values()) {
    const universe = [...sizesByProduct.get(group.product_id).values()].sort(bySize);
    const inStock = [];
    const missing = [];
    for (const size of universe) {
      const qty = group.bySize.get(size.size_id) || 0;
      if (qty > 0) inStock.push({ size_id: size.size_id, size_name: size.size_name, qty });
      else missing.push({ size_id: size.size_id, size_name: size.size_name });
    }
    if (!inStock.length || !missing.length) continue;
    gaps.push({
      product_id: group.product_id,
      code: group.code,
      name: group.name,
      warehouse_id: group.warehouse_id,
      warehouse_name: group.warehouse_name,
      color_id: group.color_id,
      color_name: group.color_name,
      color_hex: group.color_hex,
      qty: n3(inStock.reduce((sum, size) => sum + size.qty, 0)),
      in_stock: inStock,
      missing,
    });
  }
  gaps.sort((a, b) => b.missing.length - a.missing.length || b.qty - a.qty || String(a.name).localeCompare(String(b.name), 'fa'));
  return gaps;
}

/**
 * v577 Phase 4 — product × warehouse layer comparison for the variant report.
 * Declared source for the product-warehouse total = kardex (Σ inventory_ledger);
 * the variant grid itself stays vws (ledger.variant_id is not complete yet).
 * Never writes. Returns no layers when ledger data is unavailable.
 */
function buildLayerDrift(db, cellsAll, cellsShown, warehouseId) {
  let val;
  try {
    val = require('./valuation').buildLedgerValuationRows(db, { warehouseId: warehouseId || undefined });
  } catch (_) {
    return { layers: [], available: false };
  }
  const shown = new Set(cellsShown.map((c) => c.product_id + ':' + c.warehouse_id));
  const variantQty = new Map();
  const unattrQty = new Map();
  for (const cell of cellsAll) {
    if (cell.source === 'cache') continue; // display-only; not part of kardex invariant
    const k = cell.product_id + ':' + cell.warehouse_id;
    if (!shown.has(k)) continue;
    variantQty.set(k, n3((variantQty.get(k) || 0) + (Number(cell.qty) || 0)));
    if (cell.unattributed) {
      unattrQty.set(k, n3((unattrQty.get(k) || 0) + (Number(cell.qty) || 0)));
    }
  }
  const ledgerByKey = new Map(val.rows.map((r) => [r.product_id + ':' + r.warehouse_id, r]));
  const layers = [];
  for (const [k, vq] of variantQty) {
    const [pid, wid] = k.split(':').map(Number);
    const r = ledgerByKey.get(k) || null;
    const kardexQty = r ? r.ledger_qty : 0;
    const diff = n3(vq - kardexQty);
    layers.push({
      product_id: pid,
      warehouse_id: wid,
      variant_qty: vq,
      kardex_qty: n3(kardexQty),
      kardex_value_rial: r ? r.ledger_value_rial : 0,
      ws_qty: r ? r.ws_qty : null,
      unattributed_qty: unattrQty.get(k) || 0,
      drift_qty: diff,
      drift: Math.abs(diff) > 1e-6,
      ws_vs_vws: !!(r && r.flags.drift_ws_vws),
    });
  }
  layers.sort((a, b) => (a.product_id - b.product_id) || (a.warehouse_id - b.warehouse_id));
  return { layers, available: true };
}

function buildVariantStockReport(db, query) {
  const src = query || {};
  const filters = {
    warehouseId: parseId(src.warehouse_id),
    productId: parseId(src.product_id),
    category: String(src.category || '').trim(),
    colorId: parseId(src.color_id),
    sizeId: parseId(src.size_id),
    q: String(src.q || '').trim(),
    lowQty: parseLow(src.low_qty),
  };
  const options = loadOptions(db);
  const variants = loadVariantRows(db);
  const stockMaps = loadStockMaps(db);
  const cellsAll = buildCells(variants, stockMaps, warehouseNames(db), filters.warehouseId);
  const forGaps = applyFilters(cellsAll.filter((c) => !c.unattributed && c.source !== 'cache'), filters, { ignoreSize: true });
  const cells = applyFilters(cellsAll, filters);
  const summary = summarize(cells, filters.lowQty);
  const gaps = findGaps(forGaps);
  const layerInfo = buildLayerDrift(db, cellsAll, cells, filters.warehouseId);
  const driftKeys = new Set(layerInfo.layers.filter((l) => l.drift).map((l) => l.product_id + ':' + l.warehouse_id));
  for (const cell of cells) cell.layer_drift = driftKeys.has(cell.product_id + ':' + cell.warehouse_id);
  summary.kpis.layer_drift_count = driftKeys.size;
  const gapByProduct = new Map();
  for (const gap of gaps) gapByProduct.set(gap.product_id, (gapByProduct.get(gap.product_id) || 0) + 1);
  summary.by_product.forEach((row) => {
    row.gap_count = gapByProduct.get(row.product_id) || 0;
  });
  summary.kpis.gap_count = gaps.length;
  summary.kpis.gap_missing = gaps.reduce((sum, gap) => sum + gap.missing.length, 0);

  const payload = {
    filters: {
      warehouse_id: filters.warehouseId,
      product_id: filters.productId,
      category: filters.category,
      color_id: filters.colorId,
      size_id: filters.sizeId,
      q: filters.q,
      low_qty: filters.lowQty,
    },
    notes: {
      as_of: 'live',
      size_filter_ignored_for: ['matrix', 'gaps'],
      source: 'ledger',
      warehouse_total_source: 'kardex',
      drift_available: layerInfo.available,
    },
    layers: layerInfo.layers,
    options,
    kpis: summary.kpis,
    by_color: summary.by_color,
    by_size: summary.by_size,
    by_product: summary.by_product,
    gaps,
    cells,
  };
  if (filters.sizeId) payload.matrix_cells = forGaps;
  return payload;
}

module.exports = { buildVariantStockReport, loadStockMaps, loadVws };
