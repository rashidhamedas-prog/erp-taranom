'use strict';
/**
 * Cost layers — supports Moving Average (default / ADR-003) + FIFO / Specific.
 * Layers are append-only; consumption reduces qty_remaining.
 */

function invErr(code, status, extra) {
  const e = new Error(code);
  e.code = code;
  e.status = status || 400;
  if (extra) Object.assign(e, extra);
  return e;
}

function applyCostLayerIn(db, {
  productId, warehouseId = null, batchId = null,
  qty, unitCostRial, amountRial, sourceType = '', sourceId = null, ledgerId = null,
}) {
  const q = Number(qty) || 0;
  if (q <= 0) return null;
  const unit = Math.round(Number(unitCostRial) || 0);
  const amt = amountRial != null ? Math.round(Number(amountRial) || 0) : Math.round(unit * q);
  const r = db.prepare(`
    INSERT INTO inventory_cost_layers (
      product_id, warehouse_id, batch_id, qty_remaining, unit_cost_rial, amount_rial,
      source_type, source_id, ledger_id, status
    ) VALUES (?,?,?,?,?,?,?,?,?,'open')
  `).run(
    productId, warehouseId, batchId, q, unit, amt,
    sourceType, sourceId, ledgerId
  );
  return { id: r.lastInsertRowid, qty: q, unit_cost_rial: unit, amount_rial: amt };
}

/**
 * Consume layers FIFO (or by batch for specific). Returns total amount_rial.
 */
function applyCostLayerOut(db, { productId, warehouseId = null, qty, method = 'fifo', batchId = null }) {
  const need = Number(qty) || 0;
  if (need <= 0) return { amountRial: 0, layers: [] };

  let sql = `
    SELECT * FROM inventory_cost_layers
    WHERE product_id=? AND status='open' AND qty_remaining>0
  `;
  const params = [productId];
  if (warehouseId != null) { sql += ' AND (warehouse_id=? OR warehouse_id IS NULL)'; params.push(warehouseId); }
  if (method === 'specific' && batchId) { sql += ' AND batch_id=?'; params.push(batchId); }
  sql += ' ORDER BY id ASC';

  const layers = db.prepare(sql).all(...params);
  let remain = need;
  let amount = 0;
  const used = [];
  const upd = db.prepare(`
    UPDATE inventory_cost_layers SET qty_remaining=?, amount_rial=?, status=? WHERE id=?
  `);

  for (const layer of layers) {
    if (remain <= 1e-9) break;
    const take = Math.min(Number(layer.qty_remaining) || 0, remain);
    if (take <= 0) continue;
    const unit = Math.round(Number(layer.unit_cost_rial) || 0);
    const takeAmt = Math.round(unit * take);
    amount += takeAmt;
    const left = (Number(layer.qty_remaining) || 0) - take;
    const leftAmt = Math.round(unit * left);
    upd.run(left, leftAmt, left <= 1e-9 ? 'closed' : 'open', layer.id);
    used.push({ layer_id: layer.id, qty: take, unit_cost_rial: unit, amount_rial: takeAmt });
    remain -= take;
  }

  if (remain > 1e-6) {
    // Fallback: use product average for uncovered qty (avoids hard fail on legacy stock)
    const p = db.prepare('SELECT average_cost_rial FROM products WHERE id=?').get(productId);
    const avg = Math.round(Number(p?.average_cost_rial) || 0);
    amount += Math.round(avg * remain);
    used.push({ layer_id: null, qty: remain, unit_cost_rial: avg, amount_rial: Math.round(avg * remain), fallback: true });
    remain = 0;
  }

  return { amountRial: amount, layers: used };
}

/**
 * Recalculate product moving average from open layers (optional repair).
 */
function recalculateMovingAverageFromLayers(db, productId) {
  const rows = db.prepare(`
    SELECT qty_remaining, unit_cost_rial FROM inventory_cost_layers
    WHERE product_id=? AND status='open' AND qty_remaining>0
  `).all(productId);
  let qty = 0, val = 0;
  for (const r of rows) {
    const q = Number(r.qty_remaining) || 0;
    qty += q;
    val += Math.round(q * (Number(r.unit_cost_rial) || 0));
  }
  const avg = qty > 0 ? Math.round(val / qty) : 0;
  db.prepare('UPDATE products SET average_cost_rial=?, cost=? WHERE id=?').run(avg, avg, productId);
  return { qty, avg_cost_rial: avg };
}

module.exports = {
  applyCostLayerIn,
  applyCostLayerOut,
  recalculateMovingAverageFromLayers,
  invErr,
};
