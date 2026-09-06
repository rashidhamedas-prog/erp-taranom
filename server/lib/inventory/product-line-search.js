'use strict';
/**
 * INV-03 — shared product search for warehouse receipt/issue/transfer lines.
 * q matches name / code / barcode / variant SKU. ATP uses availableQty.
 */

const { sqlTokenSearch } = require('../search-normalize');
const { listQueryPlan, listResponse } = require('../pagination');
const { addProductGroupVisibility, addCatalogAclFilter } = require('../product-visibility');

function skuSearchSql(db, search) {
  const hasPv = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='product_variants'"
  ).get();
  if (!hasPv || !String(search || '').trim()) return null;
  const tok = sqlTokenSearch(['pv.sku', 'pv.barcode'], search);
  if (!tok) return null;
  return {
    clause: `EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id=p.id AND COALESCE(pv.active,1)=1 AND (${tok.clause}))`,
    params: tok.params,
  };
}

function attachAvailableQty(db, rows, warehouseId) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const wh = warehouseId ? parseInt(warehouseId, 10) : NaN;
  if (!Number.isFinite(wh) || wh <= 0) return rows;
  try {
    const { availableQty, expireReservations } = require('./reservation');
    expireReservations(db);
    for (const row of rows) {
      row.available = availableQty(db, row.id, wh);
    }
  } catch (_) {
    for (const row of rows) {
      if (row.available == null) row.available = null;
    }
  }
  return rows;
}

function applyNameCodeBarcodeSkuSearch(db, where, params, rawQuery) {
  const q = String(rawQuery || '').trim();
  if (!q) return;
  const tok = sqlTokenSearch(['p.name', 'p.code', 'p.barcode'], q);
  const sku = skuSearchSql(db, q);
  if (tok && sku) {
    where.push(`((${tok.clause}) OR (${sku.clause}))`);
    params.push(...tok.params, ...sku.params);
  } else if (tok) {
    where.push(tok.clause);
    params.push(...tok.params);
  } else if (sku) {
    where.push(sku.clause);
    params.push(...sku.params);
  }
}

function searchWarehouseLineProducts(db, user, query = {}) {
  const where = [];
  const params = [];
  addProductGroupVisibility(user, where, params);
  addCatalogAclFilter(db, user, where, params);

  applyNameCodeBarcodeSkuSearch(db, where, params, query.q || query.search);

  const warehouseId = parseInt(query.warehouse_id, 10);
  const includeZero = String(query.include_zero != null ? query.include_zero : '1') !== '0';
  if (warehouseId && !includeZero) {
    where.push('EXISTS (SELECT 1 FROM warehouse_stock ws WHERE ws.product_id=p.id AND ws.warehouse_id=? AND ws.qty>0)');
    params.push(warehouseId);
  }

  const hasApproval = db.prepare('PRAGMA table_info(products)').all()
    .some(c => c.name === 'approval_status');
  if (hasApproval) {
    where.push("(p.approval_status IS NULL OR p.approval_status='' OR p.approval_status='approved')");
  }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const forcedQuery = {
    ...query,
    page: query.page != null ? query.page : '1',
    pageSize: query.pageSize != null ? query.pageSize : (query.limit != null ? query.limit : '20'),
  };
  const pq = listQueryPlan(forcedQuery);
  const total = db.prepare(`
    SELECT COUNT(*) AS c
    FROM products p
    LEFT JOIN product_categories pc ON pc.id=p.category_id
    ${whereSql}
  `).get(...params)?.c || 0;
  const rows = db.prepare(`
    SELECT p.id, p.code, p.name, p.barcode, p.unit, p.stock, p.category, p.warehouse_id
    FROM products p
    LEFT JOIN product_categories pc ON pc.id=p.category_id
    ${whereSql}
    ORDER BY p.name, p.id
    ${pq.limitSql}
  `).all(...params, ...pq.limitParams);

  if (warehouseId) attachAvailableQty(db, rows, warehouseId);

  return listResponse(rows, { page: pq.page, pageSize: pq.pageSize, total }, forcedQuery);
}

module.exports = {
  skuSearchSql,
  attachAvailableQty,
  applyNameCodeBarcodeSkuSearch,
  searchWarehouseLineProducts,
};
