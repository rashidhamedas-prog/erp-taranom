'use strict';
/**
 * FIXTURE-ONLY helper for the minimal in-memory DBs used by the legacy variant/pack tests.
 *
 * P1 made production `applyStockMatrix` structure-only (quantities move through
 * manualAdjust.postAdjust → kardex + JE). Those fixtures have no ledger/journal tables, so they
 * seed cache layers (vws / product_variants.stock / warehouse_stock / products.stock) directly —
 * exactly what the old applyStockMatrix did — after building the matrix structure through the
 * real service. Never import this from production code.
 */
const S = require('../../lib/product-variants/service');

function seedMatrixQty(db, productId, cells, opts = {}) {
  const list = Array.isArray(cells) ? cells : [];
  const base = S.applyStockMatrix(db, productId, list, opts);
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  const warehouseId = base.warehouse_id
    || (product.warehouse_id ? parseInt(product.warehouse_id, 10) : null);
  const hasVws = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='variant_warehouse_stock'").get();
  const find = db.prepare(`
    SELECT * FROM product_variants WHERE product_id=? AND color_id=? AND size_id=? AND active=1 LIMIT 1
  `);
  const updated = [];
  // Stock single source: on a real schema (inventory_ledger present) every cell is a LEDGER document
  // (signed 'adjustment' to the target) — the caches are derived. The direct cache seeding below is kept
  // ONLY for the legacy minimal in-memory DBs that have no ledger table.
  const hasLedger = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inventory_ledger'").get();
  if (hasLedger) {
    const { setStock } = require('../lib/stock-fixture');
    for (const cell of list) {
      const qty = Math.round(Number(cell.qty) || 0);
      const row = find.get(productId, Number(cell.color_id), Number(cell.size_id));
      if (!row || !warehouseId) continue;
      setStock(db, { productId, variantId: row.id, warehouseId, target: qty, note: 'matrix seed' });
      updated.push({ id: row.id, warehouse_qty: qty });
    }
    S.afterVariantStockWrite(db, productId);
    const stockNow = Number((db.prepare('SELECT stock FROM products WHERE id=?').get(productId) || {}).stock) || 0;
    const liveL = db.prepare(`
      SELECT COUNT(*) AS c FROM (
        SELECT color_id FROM product_variants
        WHERE product_id=? AND COALESCE(is_default,0)=0 AND COALESCE(active,1)=1 AND color_id IS NOT NULL
        GROUP BY color_id HAVING COALESCE(SUM(stock),0) > 0.0000001
      )
    `).get(productId).c;
    db.prepare('UPDATE products SET colors=? WHERE id=?').run(Math.max(1, Number(liveL) || 0), productId);
    return {
      product_id: productId,
      stock: stockNow,
      warehouse_id: warehouseId || null,
      updated,
      pack: S.packSizeFor(db, productId),
      variants: S.listVariants(db, productId, { include_default: false }),
    };
  }
  for (const cell of list) {
    const qty = Math.round(Number(cell.qty) || 0);
    const row = find.get(productId, Number(cell.color_id), Number(cell.size_id));
    if (!row) continue;
    if (hasVws && warehouseId) {
      db.prepare(`
        INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,?)
        ON CONFLICT(variant_id, warehouse_id) DO UPDATE SET qty=excluded.qty
      `).run(row.id, warehouseId, qty);
      const sum = db.prepare('SELECT COALESCE(SUM(qty),0) AS s FROM variant_warehouse_stock WHERE variant_id=?').get(row.id);
      db.prepare('UPDATE product_variants SET stock=? WHERE id=?').run(Math.round(Number(sum.s) || 0), row.id);
      updated.push({ id: row.id, warehouse_qty: qty });
    } else {
      db.prepare('UPDATE product_variants SET stock=? WHERE id=?').run(qty, row.id);
      updated.push({ id: row.id, stock: qty });
    }
  }
  let productStock = 0;
  if (hasVws) {
    const byWh = db.prepare(`
      SELECT vws.warehouse_id AS warehouse_id, COALESCE(SUM(vws.qty),0) AS qty
      FROM variant_warehouse_stock vws JOIN product_variants pv ON pv.id=vws.variant_id
      WHERE pv.product_id=? AND COALESCE(pv.is_default,0)=0 AND pv.active=1
      GROUP BY vws.warehouse_id
    `).all(productId);
    for (const w of byWh) {
      const q = Math.round(Number(w.qty) || 0);
      productStock += q;
      db.prepare(`
        INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)
        ON CONFLICT(product_id, warehouse_id) DO UPDATE SET qty=excluded.qty
      `).run(productId, w.warehouse_id, q);
    }
  } else {
    productStock = updated.reduce((a, u) => a + (Number(u.stock) || 0), 0);
  }
  S.afterVariantStockWrite(db, productId);
  db.prepare('UPDATE products SET stock=? WHERE id=?').run(productStock, productId);
  const live = db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT color_id FROM product_variants
      WHERE product_id=? AND COALESCE(is_default,0)=0 AND COALESCE(active,1)=1 AND color_id IS NOT NULL
      GROUP BY color_id HAVING COALESCE(SUM(stock),0) > 0.0000001
    )
  `).get(productId).c;
  db.prepare('UPDATE products SET colors=? WHERE id=?').run(Math.max(1, Number(live) || 0), productId);
  return {
    product_id: productId,
    stock: productStock,
    warehouse_id: warehouseId || null,
    updated,
    pack: S.packSizeFor(db, productId),
    variants: S.listVariants(db, productId, { include_default: false }),
  };
}

module.exports = { seedMatrixQty };
