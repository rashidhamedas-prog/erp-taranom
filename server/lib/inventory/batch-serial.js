'use strict';
/**
 * Batch (Lot) + Serial number management. FEFO-aware selection.
 */
const { invErr } = require('./ledger');

function nextNo(db, key, prefix) {
  try {
    const { allocateNumber } = require('../../db');
    return allocateNumber(db, key, prefix);
  } catch (_) {
    return prefix + '-' + Date.now().toString(36).toUpperCase();
  }
}

function createBatch(db, {
  productId, warehouseId = null, batchNo, supplierBatch = '',
  mfgDate = '', expiryDate = '', bestBefore = '', qualityGrade = '',
  qty = 0, note = '', createdBy = null,
}) {
  if (!productId) throw invErr('E_BATCH_ARGS', 400);
  const no = batchNo || nextNo(db, 'inventory_batch', 'LOT');
  const r = db.prepare(`
    INSERT INTO inventory_batches (
      batch_no, product_id, warehouse_id, supplier_batch,
      mfg_date, expiry_date, best_before, quality_grade,
      qty_on_hand, status, note, created_by
    ) VALUES (?,?,?,?,?,?,?,?,?,'active',?,?)
  `).run(
    no, productId, warehouseId, supplierBatch || '',
    mfgDate || '', expiryDate || '', bestBefore || '', qualityGrade || '',
    Number(qty) || 0, note || '', createdBy
  );
  return db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(r.lastInsertRowid);
}

function adjustBatchQty(db, batchId, delta) {
  const b = db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(batchId);
  if (!b) throw invErr('E_BATCH_NOT_FOUND', 404);
  const next = Math.max(0, (Number(b.qty_on_hand) || 0) + delta);
  db.prepare('UPDATE inventory_batches SET qty_on_hand=? WHERE id=?').run(next, batchId);
  if (next <= 0) {
    if (b.status === 'active') db.prepare("UPDATE inventory_batches SET status='empty' WHERE id=?").run(batchId);
  } else if (b.status === 'empty') {
    db.prepare("UPDATE inventory_batches SET status='active' WHERE id=?").run(batchId);
  }
  return next;
}

/** FEFO: earliest expiry first; null expiry last. */
function pickBatchesFefo(db, productId, warehouseId, qtyNeeded) {
  const rows = db.prepare(`
    SELECT * FROM inventory_batches
    WHERE product_id=? AND status='active' AND qty_on_hand>0
      AND (? IS NULL OR warehouse_id=? OR warehouse_id IS NULL)
    ORDER BY
      CASE WHEN expiry_date IS NULL OR expiry_date='' THEN 1 ELSE 0 END,
      expiry_date ASC, id ASC
  `).all(productId, warehouseId, warehouseId);
  let need = Number(qtyNeeded) || 0;
  const picks = [];
  for (const b of rows) {
    if (need <= 0) break;
    const take = Math.min(Number(b.qty_on_hand) || 0, need);
    if (take <= 0) continue;
    picks.push({ batch_id: b.id, batch_no: b.batch_no, qty: take, expiry_date: b.expiry_date });
    need -= take;
  }
  return { picks, shortfall: Math.max(0, need) };
}

function createSerial(db, {
  productId, warehouseId = null, serialNo, batchId = null,
  warrantyUntil = '', sourceType = '', sourceId = null, note = '', createdBy = null,
}) {
  if (!productId || !serialNo) throw invErr('E_SERIAL_ARGS', 400);
  const r = db.prepare(`
    INSERT INTO inventory_serials (
      serial_no, product_id, warehouse_id, batch_id, status,
      warranty_until, source_type, source_id, note, created_by
    ) VALUES (?,?,?,?,'available',?,?,?,?,?)
  `).run(
    String(serialNo).trim(), productId, warehouseId, batchId,
    warrantyUntil || '', sourceType || '', sourceId, note || '', createdBy
  );
  return db.prepare('SELECT * FROM inventory_serials WHERE id=?').get(r.lastInsertRowid);
}

function setSerialStatus(db, serialId, status, extra = {}) {
  const allowed = new Set(['available', 'reserved', 'sold', 'in_transit', 'scrapped', 'returned', 'repair']);
  if (!allowed.has(status)) throw invErr('E_SERIAL_STATUS', 400);
  const row = db.prepare('SELECT * FROM inventory_serials WHERE id=?').get(serialId);
  if (!row) throw invErr('E_SERIAL_NOT_FOUND', 404);
  db.prepare(`
    UPDATE inventory_serials SET status=?, warehouse_id=COALESCE(?,warehouse_id),
      owner_party_id=COALESCE(?,owner_party_id), note=COALESCE(?,note)
    WHERE id=?
  `).run(status, extra.warehouseId ?? null, extra.ownerPartyId ?? null, extra.note ?? null, serialId);
  return db.prepare('SELECT * FROM inventory_serials WHERE id=?').get(serialId);
}

function listBatches(db, { productId, warehouseId, status = 'active' } = {}) {
  const where = [];
  const params = [];
  if (productId) { where.push('product_id=?'); params.push(productId); }
  if (warehouseId) { where.push('warehouse_id=?'); params.push(warehouseId); }
  if (status) { where.push('status=?'); params.push(status); }
  const sql = `SELECT * FROM inventory_batches ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY expiry_date, id DESC LIMIT 500`;
  return db.prepare(sql).all(...params);
}

function listSerials(db, { productId, warehouseId, status } = {}) {
  const where = [];
  const params = [];
  if (productId) { where.push('product_id=?'); params.push(productId); }
  if (warehouseId) { where.push('warehouse_id=?'); params.push(warehouseId); }
  if (status) { where.push('status=?'); params.push(status); }
  const sql = `SELECT * FROM inventory_serials ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 500`;
  return db.prepare(sql).all(...params);
}

module.exports = {
  createBatch, adjustBatchQty, pickBatchesFefo, listBatches,
  createSerial, setSerialStatus, listSerials,
};
