'use strict';
/**
 * Test fixture helper — stock single source of truth.
 * Tests must create stock the way production does: a LEDGER document (inventory_ledger row via
 * postInventoryMovement), never by INSERT/UPDATE into warehouse_stock / variant_warehouse_stock /
 * products.stock / product_variants.stock (those are derived caches, rebuilt from the ledger).
 */

/**
 * Receipt `qty` of a product (optionally one variant) into a warehouse.
 * @returns {object} postInventoryMovement result
 */
function seedStock(db, {
  productId, variantId = null, warehouseId, qty, unitCostRial = 1000, date = '1405/01/01', note = 'fixture receipt', sourceId = null,
}) {
  const { postInventoryMovement } = require('../../lib/inventory/ledger');
  return postInventoryMovement(db, {
    eventType: 'receipt',
    productId: Number(productId),
    warehouseId: Number(warehouseId),
    qtyIn: Number(qty),
    variantId: variantId ? Number(variantId) : undefined,
    unitCostRial,
    sourceType: 'test_fixture',
    sourceId,
    date,
    note,
    updateAvg: true,
    allowZeroCost: true,
  });
}

/**
 * Move the derived on-hand of (product[, variant], warehouse) to `target` by posting a signed
 * 'adjustment' ledger row (the document equivalent of a stock-take correction).
 * @returns {number} the delta posted (0 = nothing to do)
 */
function setStock(db, {
  productId, variantId = null, warehouseId, target, date = '1405/01/01', note = 'fixture adjust',
}) {
  const { postInventoryMovement } = require('../../lib/inventory/ledger');
  const current = qtyOf(db, { productId, variantId, warehouseId });
  const delta = Number(target) - current;
  if (Math.abs(delta) < 1e-9) return 0;
  postInventoryMovement(db, {
    eventType: 'adjustment',
    productId: Number(productId),
    warehouseId: Number(warehouseId),
    qty: delta,
    variantId: variantId ? Number(variantId) : undefined,
    sourceType: 'test_fixture_adjust',
    sourceId: null,
    date,
    note,
    updateAvg: false,
    allowNegative: true,
    allowZeroCost: true,
  });
  return delta;
}

/** Raw (non-ledger) cache read for assertions: the derived figure from the ledger. */
function qtyOf(db, { productId, variantId = null, warehouseId = null }) {
  return require('../../lib/inventory/stock-cache').derivedQty(db, {
    productId: Number(productId),
    variantId: variantId ? Number(variantId) : undefined,
    warehouseId: warehouseId ? Number(warehouseId) : null,
  });
}

module.exports = { seedStock, setStock, qtyOf };
