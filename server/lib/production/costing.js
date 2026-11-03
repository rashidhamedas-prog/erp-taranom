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
const {
  postLedgerByVariant,
  ledgerGroupIds,
  reverseLedgerGroup,
} = require('../inventory/apparel-lines');

/** Colour×size lines of a stock change ([] for a non-matrix product); throws E_VARIANT_REQUIRED when a matrix product has none. */
function ledgerLines(db, { productId, qty, variantId, variantLines, sizeBreakdown, color }) {
  const { resolveApparelLines } = require('../inventory/apparel-lines');
  return resolveApparelLines(db, { productId, qty, variantId, variantLines, sizeBreakdown, color });
}

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
    const extra = {
      product_id: productId,
      warehouse_id: warehouseId || null,
      name: prod.name,
      available: avail,
      needed: q,
    };
    throw require('../inventory/shortage-error').attach(err('E_NEGATIVE_STOCK', 409, extra), db, [extra]);
  }

  const unit = avgUnitRial(db, productId);
  const led = postLedgerByVariant(db, {
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
  }, apparelLines);

  return {
    ok: true,
    qty: q,
    remaining: avail - q,
    variantLines: apparelLines,
    ledger_id: led.id,
    ledger_ids: led.ids,
    unit_cost_rial: led.unit_cost_rial,
    amount_rial: led.amount_rial,
  };
}

/**
 * Receive finished goods / scrap and update moving average via inventory ledger.
 * Matrix FG: one receipt row per colour×size (variantLines = the receipt's resolved fgLines).
 */
function updateMovingAverage(db, {
  productId, warehouseId, qtyIn, amountRial, userId, note, sourceType, sourceId, date,
  variantId, variantLines, sizeBreakdown, color,
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

  const lines = ledgerLines(db, { productId, qty, variantId, variantLines, sizeBreakdown, color });
  const unit = Math.round(amt / qty);
  const led = postLedgerByVariant(db, {
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
  }, lines);

  const after = db.prepare('SELECT stock, average_cost_rial FROM products WHERE id=?').get(productId);
  return {
    prev_qty: prevQty,
    prev_avg: prevAvg,
    new_qty: Number(after?.stock) || 0,
    new_avg: Math.round(Number(after?.average_cost_rial) || 0),
    ledger_id: led.id,
    ledger_ids: led.ids,
    variantLines: lines,
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

  postLedgerByVariant(db, {
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
  }, apparelLines);

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
 * Find the posted FG production_receipt ledger row for an order/receipt.
 * Finalize stamps source_id=orderId + note «تولید PO-…».
 */
/**
 * Candidates newest first; a matrix posting is several rows (one per colour×size), so the qty
 * test is on the whole posting group. Returns the first candidate whose group carries q
 * (any qty when q ≤ 0), or null.
 */
function pickLedgerGroup(db, rows, q, col, accept = () => true) {
  const visited = new Set();
  for (const row of rows) {
    if (visited.has(Number(row.id)) || !accept(row)) continue;
    const ids = ledgerGroupIds(db, row.id);
    ids.forEach((id) => visited.add(id));
    if (!(q > 0)) return row;
    const sum = ids.reduce((acc, id) => {
      const r = db.prepare(`SELECT ${col} AS q FROM inventory_ledger WHERE id=?`).get(id);
      return acc + (Number(r && r.q) || 0);
    }, 0);
    if (Math.abs(sum - q) < 1e-4) return row;
  }
  return null;
}

function findProductionReceiptLedger(db, {
  productId, orderId, orderNo, warehouseId, qty,
}) {
  if (!productId) return null;
  const q = Number(qty) || 0;
  if (orderId != null) {
    const byOrder = db.prepare(`
      SELECT * FROM inventory_ledger
      WHERE product_id=? AND status='posted' AND event_type='production_receipt'
        AND COALESCE(source_type,'') IN ('production_receipt','')
        AND source_id=?
      ORDER BY id DESC
    `).all(productId, orderId);
    if (byOrder.length) return pickLedgerGroup(db, byOrder, q, 'qty_in') || byOrder[0];
  }
  if (orderNo) {
    const byNote = db.prepare(`
      SELECT * FROM inventory_ledger
      WHERE product_id=? AND status='posted' AND event_type='production_receipt'
        AND note LIKE ?
      ORDER BY id DESC LIMIT 1
    `).get(productId, `%${orderNo}%`);
    if (byNote) return byNote;
  }
  if (q > 0 && warehouseId) {
    const recent = db.prepare(`
      SELECT * FROM inventory_ledger
      WHERE product_id=? AND warehouse_id=? AND status='posted'
        AND event_type='production_receipt' AND qty_in > 0 AND qty_in <= ? + 0.0001
      ORDER BY id DESC LIMIT 200
    `).all(productId, warehouseId, q);
    return pickLedgerGroup(db, recent, q, 'qty_in');
  }
  return null;
}

/**
 * Pull a posted receipt back out of stock through the ledger (R12 reverse).
 * Prefer reverseInventoryMovement so the original row becomes status=reversed
 * (operational kardex can hide the pair). Fallback posts a legacy outbound
 * only when the original ledger row cannot be found.
 * The average is re-computed by value by the ledger reversal (prevAvgRial kept for API compat).
 */
function reverseReceiptStock(db, {
  productId, warehouseId, qty, unitCostRial, amountRial, prevAvgRial,
  userId, note, sourceType, sourceId, date, eventType,
  orderId, orderNo,
}) {
  const q = Number(qty) || 0;
  if (q <= 0) return;
  const { softRetireLedgerRow } = require('../inventory/ledger');
  const voidNote = note || (orderNo ? `ابطال رسید ${orderNo}` : 'ابطال رسید تولید');

  // sourceId from reverseOrder used to be production_receipts.id; finalize uses orderId.
  const orig = findProductionReceiptLedger(db, {
    productId,
    orderId: orderId != null ? orderId : sourceId,
    orderNo,
    warehouseId,
    qty: q,
  }) || (orderId == null && sourceId != null
    ? findProductionReceiptLedger(db, { productId, orderId: sourceId, orderNo, warehouseId, qty: q })
    : null);

  let led;
  if (orig) {
    // Every colour×size row of the receipt is reversed (a non-matrix receipt is one row).
    const revs = reverseLedgerGroup(db, orig.id, {
      createdBy: userId || null,
      date: date || '',
      note: voidNote,
    });
    // Stock already undone by the reversal movement. Soft-retire the reverse
    // row too so kardex economic stream drops the pair once (not twice).
    for (const rev of revs) {
      if (rev && rev.id) softRetireLedgerRow(db, rev.id, { note: voidNote });
    }
    led = revs[0];
    if (led && led.id) led = db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(led.id) || led;
  } else {
    const unit = unitCostRial != null ? Math.round(Number(unitCostRial) || 0) : avgUnitRial(db, productId);
    led = postInventoryMovement(db, {
      eventType: eventType || 'production_receipt_reversal',
      productId,
      warehouseId: warehouseId || null,
      qtyOut: q,
      unitCostRial: unit,
      amountRial: amountRial != null ? Math.round(Number(amountRial) || 0) : Math.round(unit * q),
      sourceType: sourceType || 'production_receipt_reversal',
      sourceId: sourceId || orderId || null,
      date: date || '',
      note: voidNote,
      createdBy: userId || null,
      updateAvg: false,
    });
  }
  // prevAvgRial is ignored: the reversal row re-averages by value inside the ledger.
  // Restoring the receipt-time snapshot would discard every movement since the receipt.
  void prevAvgRial;
  return led;
}

/**
 * Find the posted stage-issue ledger row (مرحله N / حواله مرحله N / مصرف).
 * issueFromStock stamps source_id=orderId; notes carry the PO token.
 */
function findProductionIssueLedger(db, {
  productId, orderId, orderNo, warehouseId, qty, stageSeq,
}) {
  if (!productId) return null;
  const q = Number(qty) || 0;
  if (orderId != null) {
    const candidates = db.prepare(`
      SELECT * FROM inventory_ledger
      WHERE product_id=? AND status='posted' AND event_type='production_issue'
        AND COALESCE(source_type,'') IN ('production_issue','')
        AND source_id=?
      ORDER BY id DESC
    `).all(productId, orderId);
    const hit = pickLedgerGroup(db, candidates, q, 'qty_out', (row) => {
      if (stageSeq != null && !String(row.note || '').includes(`مرحله ${stageSeq}`)) return false;
      return !(warehouseId && row.warehouse_id && Number(row.warehouse_id) !== Number(warehouseId));
    });
    if (hit) return hit;
    if (candidates.length && ledgerGroupIds(db, candidates[0].id).length === candidates.length) return candidates[0];
  }
  if (orderNo) {
    const like = stageSeq != null
      ? `%مرحله ${stageSeq}%${orderNo}%`
      : `%${orderNo}%`;
    const byNote = db.prepare(`
      SELECT * FROM inventory_ledger
      WHERE product_id=? AND status='posted' AND event_type='production_issue'
        AND note LIKE ?
      ORDER BY id DESC LIMIT 1
    `).get(productId, like);
    if (byNote) return byNote;
  }
  return null;
}

/**
 * Reverse a stage material issue through the ledger (R12). Prefer marking the
 * original production_issue reversed. Fallback posts a return twin only when
 * the original cannot be found (legacy path).
 */
function reverseIssueStock(db, {
  productId, warehouseId, qty, unitCostRial, userId, note, date,
  orderId, orderNo, stageSeq, sourceId, variantId, variantLines,
}) {
  const q = Number(qty) || 0;
  if (q <= 0) return null;
  const { softRetireLedgerRow } = require('../inventory/ledger');
  const voidNote = note || (orderNo
    ? `ابطال مرحله${stageSeq != null ? ` ${stageSeq}` : ''} — ${orderNo}`
    : 'ابطال حواله تولید');
  const orig = findProductionIssueLedger(db, {
    productId,
    orderId: orderId != null ? orderId : null,
    orderNo,
    warehouseId,
    qty: q,
    stageSeq,
  });
  if (orig) {
    const revs = reverseLedgerGroup(db, orig.id, {
      createdBy: userId || null,
      date: date || '',
      note: voidNote,
    });
    for (const rev of revs) {
      if (rev && rev.id) softRetireLedgerRow(db, rev.id, { note: voidNote });
    }
    return revs[0] || null;
  }
  restoreStock(db, {
    productId,
    warehouseId,
    qty: q,
    unitCostRial,
    userId,
    note: voidNote,
    sourceType: 'production_material_return',
    sourceId: sourceId || null,
    date,
    variantId,
    variantLines,
  });
  return null;
}

function restoreStock(db, {
  productId, warehouseId, qty, userId, note, sourceType, sourceId, date, unitCostRial,
  variantId, variantLines, sizeBreakdown, color,
}) {
  const q = Number(qty) || 0;
  if (q <= 0) return;
  const lines = ledgerLines(db, { productId, qty: q, variantId, variantLines, sizeBreakdown, color });
  const unit = unitCostRial != null ? Math.round(Number(unitCostRial) || 0) : avgUnitRial(db, productId);
  postLedgerByVariant(db, {
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
  }, lines);
}

function recalcAvgOnReturn(db, {
  productId, warehouseId, qty, unitCostRial, userId, note, variantId, variantLines,
}) {
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
    variantId,
    variantLines,
  });
}

module.exports = {
  issueFromStock,
  updateMovingAverage,
  receiveScrap,
  restoreStock,
  findProductionReceiptLedger,
  findProductionIssueLedger,
  reverseIssueStock,
  reverseReceiptStock,
  recalcAvgOnReturn,
  setting,
  avgUnitRial,
  getWhQty,
  ensureWhRow,
  allowNegative,
};
