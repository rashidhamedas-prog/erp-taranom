'use strict';
/**
 * Production stock helpers — route qty through inventory ledger (F01/F16).
 * Never rewrite warehouse_stock from products.stock to mask a shortage.
 */
const { err } = require('./posting');
const {
  postInventoryMovement,
  warehouseQty,
  ensureWhRow,
} = require('../inventory/ledger');

function setting(db, key, fallback = '') {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r?.value != null ? r.value : fallback;
}

function allowNegative(db) {
  return setting(db, 'production_allow_negative_stock', '0') === '1';
}

function getWhQty(db, productId, warehouseId) {
  return warehouseQty(db, productId, warehouseId);
}

function avgUnitRial(db, productId) {
  const { productUnitCostRial } = require('../inventory/product-unit-cost');
  const prod = db.prepare('SELECT average_cost_rial, cost FROM products WHERE id=?').get(productId);
  return productUnitCostRial(prod);
}

/**
 * Issue (consume) stock via inventory ledger. Throws E_NEGATIVE_STOCK unless allow-negative.
 */
function issueFromStock(db, {
  productId, warehouseId, qty, userId, note, variantId, variantLines, sizeBreakdown, color,
  sourceType, sourceId, date,
}) {
  const q = Number(qty) || 0;
  if (q <= 0) return { ok: true, qty: 0, variantLines: [] };

  const { resolveApparelLines } = require('../inventory/apparel-lines');
  const apparelLines = resolveApparelLines(db, {
    productId, qty: q, variantId, variantLines, sizeBreakdown, color,
  });

  const prod = db.prepare('SELECT id, stock, name, average_cost_rial FROM products WHERE id=?').get(productId);
  if (!prod) throw err('E_NOT_FOUND', 404, { productId });

  const avail = warehouseId
    ? getWhQty(db, productId, warehouseId)
    : (Number(prod.stock) || 0);
  if (avail + 1e-9 < q && !allowNegative(db)) {
    throw err('E_NEGATIVE_STOCK', 409, {
      product_id: productId,
      warehouse_id: warehouseId || null,
      name: prod.name,
      available: avail,
      needed: q,
    });
  }

  const unit = avgUnitRial(db, productId);
  const led = postInventoryMovement(db, {
    eventType: 'production_issue',
    productId,
    warehouseId: warehouseId || null,
    qtyOut: q,
    unitCostRial: unit,
    amountRial: Math.round(unit * q),
    sourceType: sourceType || 'production_issue',
    sourceId: sourceId || null,
    date: date || '',
    note: note || 'مصرف تولید',
    createdBy: userId || null,
    updateAvg: false,
    allowNegative: allowNegative(db),
  });

  return {
    ok: true,
    qty: q,
    remaining: avail - q,
    variantLines: apparelLines,
    ledger_id: led.id,
    unit_cost_rial: led.unit_cost_rial,
    amount_rial: led.amount_rial,
  };
}

/**
 * Receive finished goods / scrap and update moving average via inventory ledger.
 */
function updateMovingAverage(db, {
  productId, warehouseId, qtyIn, amountRial, userId, note, sourceType, sourceId, date,
}) {
  const qty = Number(qtyIn) || 0;
  const amt = Math.round(Number(amountRial) || 0);
  const prod = db.prepare('SELECT stock, average_cost_rial, cost FROM products WHERE id=?').get(productId);
  if (!prod) throw err('E_NOT_FOUND', 404, { productId });

  const prevQty = Number(prod.stock) || 0;
  const prevAvg = Math.round(Number(prod.average_cost_rial) || 0);
  if (!(qty > 0)) {
    return { prev_qty: prevQty, prev_avg: prevAvg, new_qty: prevQty, new_avg: prevAvg };
  }

  const unit = Math.round(amt / qty);
  const led = postInventoryMovement(db, {
    eventType: 'production_receipt',
    productId,
    warehouseId: warehouseId || null,
    qtyIn: qty,
    unitCostRial: unit,
    amountRial: amt,
    sourceType: sourceType || 'production_receipt',
    sourceId: sourceId || null,
    date: date || '',
    note: note || 'رسید تولید',
    createdBy: userId || null,
    updateAvg: true,
  });

  const after = db.prepare('SELECT stock, average_cost_rial FROM products WHERE id=?').get(productId);
  return {
    prev_qty: prevQty,
    prev_avg: prevAvg,
    new_qty: Number(after?.stock) || 0,
    new_avg: Math.round(Number(after?.average_cost_rial) || 0),
    ledger_id: led.id,
  };
}

function receiveScrap(db, {
  productId, qty, unitRial, warehouseId, userId, orderId, date, period, nrvAmount,
  variantId, variantLines, sizeBreakdown, color,
}) {
  const q = Number(qty) || 0;
  const unit = Math.round(Number(unitRial) || 0);
  const amt = nrvAmount != null ? Math.round(nrvAmount) : Math.round(q * unit);
  if (q <= 0) return { amount_rial: 0 };

  const { resolveApparelLines, postApparelLines } = require('../inventory/apparel-lines');
  const apparelLines = resolveApparelLines(db, {
    productId, qty: q, variantId, variantLines, sizeBreakdown, color,
  });

  const prod = db.prepare('SELECT id FROM products WHERE id=?').get(productId);
  if (!prod) throw err('E_NOT_FOUND', 404, { productId });

  postInventoryMovement(db, {
    eventType: 'scrap',
    productId,
    warehouseId: warehouseId || null,
    qtyIn: q,
    unitCostRial: unit,
    amountRial: amt,
    sourceType: 'production_scrap',
    sourceId: orderId || null,
    date: date || '',
    note: `ضایعات قابل فروش — سفارش ${orderId || ''}`,
    createdBy: userId || null,
    updateAvg: true,
  });

  if (orderId && apparelLines.length) {
    postApparelLines(db, {
      productId, warehouseId, lines: apparelLines,
      docType: 'production_scrap', docId: orderId, docLineStart: productId,
      userId, note: `ضایعات قابل فروش — سفارش ${orderId || ''}`,
      sign: 1, allowNegative: true,
    });
  }

  return { amount_rial: amt, unit_rial: unit, qty: q, date, period, variantLines: apparelLines };
}

/**
 * Pull a posted receipt back out of stock through the ledger (R12 reverse).
 * prevAvgRial restores the pre-receipt moving average snapshot.
 */
function reverseReceiptStock(db, {
  productId, warehouseId, qty, unitCostRial, amountRial, prevAvgRial,
  userId, note, sourceType, sourceId, date, eventType,
}) {
  const q = Number(qty) || 0;
  if (q <= 0) return;
  const unit = unitCostRial != null ? Math.round(Number(unitCostRial) || 0) : avgUnitRial(db, productId);
  const led = postInventoryMovement(db, {
    eventType: eventType || 'production_receipt_reversal',
    productId,
    warehouseId: warehouseId || null,
    qtyOut: q,
    unitCostRial: unit,
    amountRial: amountRial != null ? Math.round(Number(amountRial) || 0) : Math.round(unit * q),
    sourceType: sourceType || 'production_receipt_reversal',
    sourceId: sourceId || null,
    date: date || '',
    note: note || 'ابطال رسید تولید',
    createdBy: userId || null,
    updateAvg: false,
  });
  if (prevAvgRial != null) {
    const prev = Math.round(Number(prevAvgRial) || 0);
    const { catalogCostFromAvgRial } = require('../inventory/product-unit-cost');
    db.prepare('UPDATE products SET average_cost_rial=?, cost=? WHERE id=?')
      .run(prev, catalogCostFromAvgRial(prev), productId);
  }
  return led;
}

function restoreStock(db, { productId, warehouseId, qty, userId, note, sourceType, sourceId, date, unitCostRial }) {
  const q = Number(qty) || 0;
  if (q <= 0) return;
  const unit = unitCostRial != null ? Math.round(Number(unitCostRial) || 0) : avgUnitRial(db, productId);
  postInventoryMovement(db, {
    eventType: 'production_return',
    productId,
    warehouseId: warehouseId || null,
    qtyIn: q,
    unitCostRial: unit,
    amountRial: Math.round(unit * q),
    sourceType: sourceType || 'production_material_return',
    sourceId: sourceId || null,
    date: date || '',
    note: note || 'برگشت موجودی تولید',
    createdBy: userId || null,
    updateAvg: true,
  });
}

function recalcAvgOnReturn(db, { productId, warehouseId, qty, unitCostRial, userId, note }) {
  const q = Number(qty) || 0;
  const unit = Math.round(Number(unitCostRial) || 0);
  if (q <= 0) return;
  restoreStock(db, {
    productId,
    warehouseId,
    qty: q,
    userId,
    note: note || 'برگشت مواد به انبار',
    unitCostRial: unit,
  });
}

module.exports = {
  issueFromStock,
  updateMovingAverage,
  receiveScrap,
  restoreStock,
  reverseReceiptStock,
  recalcAvgOnReturn,
  setting,
  getWhQty,
  ensureWhRow,
  allowNegative,
};
