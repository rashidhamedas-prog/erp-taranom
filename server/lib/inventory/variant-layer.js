'use strict';
/**
 * Variant-layer mismatch (phantom-sale guard) — READ-ONLY, never writes.
 *
 * Per product × warehouse, a mismatch is:
 *   • the product has active colour×size matrix variants (movement.hasActiveMatrixVariants), AND
 *   • no active matrix SKU has variant_warehouse_stock qty > 0 at that warehouse
 *     (same SKU filter as movement.expandLivePack: pv.active=1, non-default, active colour/size), AND
 *   • the product layer (ledger.warehouseQty) still shows qty > 0 there.
 *
 * Such stock cannot be sold honestly: every colour/size reads 0 while the product total says
 * otherwise. Shared by line-availability (display flag) and available-to-promise (blocking gate).
 */
const { round3 } = require('../round3');

const EPS = 1e-9;

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

/**
 * @returns {{ mismatch:boolean, has_matrix:boolean, stocked_sku_count:number|null, product_wh_qty:number|null }}
 *   stocked_sku_count / product_wh_qty are null when the product has no matrix (or no warehouse given).
 */
function variantLayerMismatch(db, productId, warehouseId) {
  const pid = parseInt(productId, 10);
  const whId = parseInt(warehouseId, 10);
  const none = { mismatch: false, has_matrix: false, stocked_sku_count: null, product_wh_qty: null };
  if (!(pid > 0) || !(whId > 0)) return none;
  const { hasActiveMatrixVariants } = require('./movement');
  if (!hasActiveMatrixVariants(db, pid)) return none;
  if (!tableExists(db, 'variant_warehouse_stock')) return { ...none, has_matrix: true };

  // qty >= 0.0005 ⇔ round3(qty) > 0, i.e. expandLivePack would count the SKU as stocked.
  const row = db.prepare(`
    SELECT COUNT(*) AS c
    FROM product_variants pv
    LEFT JOIN product_colors pc ON pc.id = pv.color_id
    LEFT JOIN product_sizes ps ON ps.id = pv.size_id
    JOIN variant_warehouse_stock vws ON vws.variant_id = pv.id AND vws.warehouse_id = ?
    WHERE pv.product_id=? AND pv.active=1 AND COALESCE(pv.is_default,0)=0
      AND (pv.color_id IS NULL OR COALESCE(pc.active,1)=1)
      AND (pv.size_id IS NULL OR COALESCE(ps.active,1)=1)
      AND COALESCE(vws.qty,0) >= 0.0005
  `).get(whId, pid);
  const stockedSkuCount = Number(row && row.c) || 0;
  const { warehouseQty } = require('./ledger');
  const productWhQty = round3(warehouseQty(db, pid, whId));
  return {
    mismatch: stockedSkuCount === 0 && productWhQty > EPS,
    has_matrix: true,
    stocked_sku_count: stockedSkuCount,
    product_wh_qty: productWhQty,
  };
}

module.exports = { variantLayerMismatch };
