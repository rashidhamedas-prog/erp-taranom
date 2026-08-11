'use strict';
/**
 * Stock + moving-average helpers for production.
 */
const { err } = require('./posting');

function setting(db, key, fallback = '') {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r?.value != null ? r.value : fallback;
}

function allowNegative(db) {
  return setting(db, 'production_allow_negative_stock', '0') === '1';
}

function getWhQty(db, productId, warehouseId) {
  if (!warehouseId) {
    const p = db.prepare('SELECT stock FROM products WHERE id=?').get(productId);
    return Number(p?.stock) || 0;
  }
  const ws = db.prepare(
    'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
  ).get(productId, warehouseId);
  if (ws) return Number(ws.qty) || 0;
  const p = db.prepare('SELECT stock FROM products WHERE id=?').get(productId);
  return Number(p?.stock) || 0;
}

function ensureWhRow(db, productId, warehouseId) {
  if (!warehouseId) return;
  db.prepare(
    'INSERT OR IGNORE INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,0)'
  ).run(productId, warehouseId);
}

/**
 * Issue (consume) stock. Throws E_NEGATIVE_STOCK unless allow-negative setting.
 */
function issueFromStock(db, { productId, warehouseId, qty, userId, note }) {
  const q = Number(qty) || 0;
  if (q <= 0) return { ok: true, qty: 0 };

  const prod = db.prepare('SELECT id, stock, name FROM products WHERE id=?').get(productId);
  if (!prod) throw err('E_NOT_FOUND', 404, { productId });

  // Prefer products.stock as source of truth; keep warehouse_stock in sync
  const avail = Number(prod.stock) || 0;
  if (avail + 1e-9 < q && !allowNegative(db)) {
    throw err('E_NEGATIVE_STOCK', 409, {
      product_id: productId,
      name: prod.name,
      available: avail,
      needed: q,
    });
  }

  db.prepare('UPDATE products SET stock = stock - ? WHERE id=?').run(q, productId);
  if (warehouseId) {
    ensureWhRow(db, productId, warehouseId);
    // Keep warehouse row aligned with products.stock before deduct (avoids stale 0 rows)
    const cur = db.prepare(
      'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
    ).get(productId, warehouseId);
    if (cur && Number(cur.qty) + 1e-9 < q) {
      db.prepare(
        'UPDATE warehouse_stock SET qty=? WHERE product_id=? AND warehouse_id=?'
      ).run(avail, productId, warehouseId);
    }
    db.prepare(
      'UPDATE warehouse_stock SET qty = qty - ? WHERE product_id=? AND warehouse_id=?'
    ).run(q, productId, warehouseId);
  }
  db.prepare(
    'INSERT INTO stock_logs (product_id, user_id, change, note) VALUES (?,?,?,?)'
  ).run(productId, userId || null, -q, note || 'مصرف تولید');

  return { ok: true, qty: q, remaining: avail - q };
}

/**
 * Receive finished goods / scrap and update moving average.
 * amountRial is total receipt value in rials.
 */
function updateMovingAverage(db, { productId, warehouseId, qtyIn, amountRial, userId, note }) {
  const qty = Number(qtyIn) || 0;
  const amt = Math.round(Number(amountRial) || 0);
  const prod = db.prepare('SELECT stock, average_cost_rial, cost FROM products WHERE id=?').get(productId);
  if (!prod) throw err('E_NOT_FOUND', 404, { productId });

  const prevQty = Number(prod.stock) || 0;
  const prevAvg = Math.round(Number(prod.average_cost_rial) || 0);
  const prevVal = Math.round(prevQty * prevAvg);
  const newQty = prevQty + qty;
  let newAvg = prevAvg;
  if (newQty > 0) {
    newAvg = Math.round((prevVal + amt) / newQty);
  }

  db.prepare(`
    UPDATE products SET
      stock = ?,
      average_cost_rial = ?,
      cost = ?,
      last_prod_cost_rial = ?
    WHERE id=?
  `).run(
    newQty,
    newAvg,
    newAvg,
    qty > 0 ? Math.round(amt / qty) : 0,
    productId
  );

  if (warehouseId) {
    ensureWhRow(db, productId, warehouseId);
    db.prepare(
      'UPDATE warehouse_stock SET qty = qty + ? WHERE product_id=? AND warehouse_id=?'
    ).run(qty, productId, warehouseId);
  }

  if (qty) {
    db.prepare(
      'INSERT INTO stock_logs (product_id, user_id, change, note) VALUES (?,?,?,?)'
    ).run(productId, userId || null, qty, note || 'رسید تولید');
  }

  return { prev_qty: prevQty, prev_avg: prevAvg, new_qty: newQty, new_avg: newAvg };
}

function receiveScrap(db, {
  productId, qty, unitRial, warehouseId, userId, orderId, date, period, nrvAmount,
}) {
  const q = Number(qty) || 0;
  const unit = Math.round(Number(unitRial) || 0);
  const amt = nrvAmount != null ? Math.round(nrvAmount) : Math.round(q * unit);
  if (q <= 0) return { amount_rial: 0 };

  const prod = db.prepare('SELECT id, stock, average_cost_rial FROM products WHERE id=?').get(productId);
  if (!prod) throw err('E_NOT_FOUND', 404, { productId });

  // Scrap stock uses NRV as cost basis (replace avg if first entry, else weighted)
  const prevQty = Number(prod.stock) || 0;
  const prevAvg = Math.round(Number(prod.average_cost_rial) || 0);
  const newQty = prevQty + q;
  const newAvg = newQty > 0 ? Math.round((prevQty * prevAvg + amt) / newQty) : unit;

  db.prepare(`
    UPDATE products SET stock=?, average_cost_rial=?, cost=? WHERE id=?
  `).run(newQty, newAvg, newAvg, productId);

  if (warehouseId) {
    ensureWhRow(db, productId, warehouseId);
    db.prepare(
      'UPDATE warehouse_stock SET qty = qty + ? WHERE product_id=? AND warehouse_id=?'
    ).run(q, productId, warehouseId);
  }
  db.prepare(
    'INSERT INTO stock_logs (product_id, user_id, change, note) VALUES (?,?,?,?)'
  ).run(productId, userId || null, q, `ضایعات قابل فروش — سفارش ${orderId || ''}`);

  return { amount_rial: amt, unit_rial: unit, qty: q, date, period };
}

function restoreStock(db, { productId, warehouseId, qty, userId, note }) {
  const q = Number(qty) || 0;
  if (q <= 0) return;
  db.prepare('UPDATE products SET stock = stock + ? WHERE id=?').run(q, productId);
  if (warehouseId) {
    ensureWhRow(db, productId, warehouseId);
    db.prepare(
      'UPDATE warehouse_stock SET qty = qty + ? WHERE product_id=? AND warehouse_id=?'
    ).run(q, productId, warehouseId);
  }
  db.prepare(
    'INSERT INTO stock_logs (product_id, user_id, change, note) VALUES (?,?,?,?)'
  ).run(productId, userId || null, q, note || 'برگشت موجودی تولید');
}

/**
 * Recalculate average after returning materials (undo issue).
 * Restores qty at the unitCost that was issued (does not change avg of remaining).
 */
function recalcAvgOnReturn(db, { productId, warehouseId, qty, unitCostRial, userId, note }) {
  const q = Number(qty) || 0;
  const unit = Math.round(Number(unitCostRial) || 0);
  if (q <= 0) return;
  const amt = Math.round(q * unit);
  updateMovingAverage(db, {
    productId,
    warehouseId,
    qtyIn: q,
    amountRial: amt,
    userId,
    note: note || 'برگشت مواد به انبار',
  });
}

module.exports = {
  issueFromStock,
  updateMovingAverage,
  receiveScrap,
  restoreStock,
  recalcAvgOnReturn,
  getWhQty,
  setting,
};
