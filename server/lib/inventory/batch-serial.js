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
  // Lot qty must enter via warehouse receipt / fabric receive — never invent stock here.
  if (Number(qty) > 0) {
    throw invErr('E_BATCH_QTY_VIA_RECEIPT', 400, {
      message: 'مقدار بچ فقط از رسید انبار یا دریافت طاقه ثبت می‌شود',
    });
  }
  const no = batchNo || nextNo(db, 'inventory_batch', 'LOT');
  const r = db.prepare(`
    INSERT INTO inventory_batches (
      batch_no, product_id, warehouse_id, supplier_batch,
      mfg_date, expiry_date, best_before, quality_grade,
      qty_on_hand, status, note, created_by, kind
    ) VALUES (?,?,?,?,?,?,?,?,0,'active',?,?,'generic')
  `).run(
    no, productId, warehouseId, supplierBatch || '',
    mfgDate || '', expiryDate || '', bestBefore || '', qualityGrade || '',
    note || '', createdBy
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

const SPLIT_SKIP_COLS = new Set([
  'id', 'batch_no', 'warehouse_id', 'qty_on_hand', 'status', 'created_at', 'idempotency_key',
  'ledger_id', 'journal_id', 'reversed_at', 'reversed_by', 'reversal_journal_id',
  'source_type', 'source_id', 'qty_received', 'entry_qty',
]);

/**
 * Warehouse-to-warehouse transfer of a lot (Phase 2, v575).
 * - qty >= on-hand  → whole lot moves (warehouse_id UPDATE, same row, no split).
 * - qty <  on-hand  → SPLIT: source keeps (on-hand − qty); destination gets a NEW lot row
 *   (copy of the source attributes, batch_no `<src>-W<destWh>`), or tops up an existing
 *   destination lot created by an earlier split of the same source.
 * Must run inside the caller's transaction. Returns { sourceBatchId, destBatchId, split }.
 */
function splitBatchForTransfer(db, {
  batchId, productId, qty, fromWarehouseId, toWarehouseId, createdBy = null,
}) {
  const b = db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(batchId);
  if (!b) throw invErr('E_BATCH_NOT_FOUND', 404);
  const q = Number(qty) || 0;
  if (q <= 0) throw invErr('E_INV_QTY', 400);
  if (productId && Number(b.product_id) !== Number(productId)) {
    throw invErr('E_BATCH_PRODUCT_MISMATCH', 400, { message: 'بچ انتخاب‌شده متعلق به این کالا نیست' });
  }
  if (b.warehouse_id != null && fromWarehouseId && Number(b.warehouse_id) !== Number(fromWarehouseId)) {
    throw invErr('E_BATCH_WAREHOUSE_MISMATCH', 400, { message: 'بچ انتخاب‌شده در انبار مبدأ نیست' });
  }
  const onHand = Number(b.qty_on_hand) || 0;
  if (q > onHand + 1e-9) {
    throw invErr('E_BATCH_QTY_SHORT', 400, {
      message: `موجودی بچ ${b.batch_no} کافی نیست (موجود: ${onHand})`,
    });
  }

  if (q >= onHand - 1e-9) {
    db.prepare('UPDATE inventory_batches SET warehouse_id=? WHERE id=?').run(toWarehouseId, batchId);
    return { sourceBatchId: batchId, destBatchId: batchId, split: false };
  }

  // Reuse a destination lot from an earlier split of the same source, else create one.
  const destNo = `${b.batch_no}-W${toWarehouseId}`;
  let dest = db.prepare(
    'SELECT * FROM inventory_batches WHERE product_id=? AND batch_no=?'
  ).get(b.product_id, destNo);
  if (dest && Number(dest.warehouse_id) !== Number(toWarehouseId)) {
    // Same name but elsewhere (unusual): fall through to a uniquely suffixed new lot.
    dest = null;
  }
  let destId;
  if (dest) {
    adjustBatchQty(db, dest.id, q);
    destId = dest.id;
  } else {
    let no = destNo;
    for (let i = 2; db.prepare('SELECT 1 FROM inventory_batches WHERE product_id=? AND batch_no=?').get(b.product_id, no); i++) {
      no = `${destNo}-${i}`;
    }
    const cols = db.prepare('PRAGMA table_info(inventory_batches)').all().map((c) => c.name);
    const copy = cols.filter((c) => !SPLIT_SKIP_COLS.has(c));
    const names = [...copy, 'batch_no', 'warehouse_id', 'qty_on_hand', 'status'];
    const vals = [...copy.map((c) => b[c]), no, toWarehouseId, q, 'active'];
    if (cols.includes('qty_received')) { names.push('qty_received'); vals.push(q); }
    if (cols.includes('source_type')) { names.push('source_type'); vals.push('batch_split'); }
    if (cols.includes('source_id')) { names.push('source_id'); vals.push(b.id); }
    if (cols.includes('created_by') && createdBy != null) {
      const i = names.indexOf('created_by');
      if (i >= 0) vals[i] = createdBy;
    }
    const r = db.prepare(
      `INSERT INTO inventory_batches (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`
    ).run(...vals);
    destId = r.lastInsertRowid;
  }
  adjustBatchQty(db, batchId, -q);
  return { sourceBatchId: batchId, destBatchId: destId, split: true };
}

/**
 * Undo splitBatchForTransfer (void of a transfer line). `destBatchId` is the lot that
 * received the stock (taken from the transfer_in ledger row).
 */
function unsplitBatchForTransfer(db, {
  sourceBatchId, destBatchId, qty, fromWarehouseId,
}) {
  if (!sourceBatchId) return;
  if (!destBatchId || Number(destBatchId) === Number(sourceBatchId)) {
    if (fromWarehouseId) {
      db.prepare('UPDATE inventory_batches SET warehouse_id=? WHERE id=?').run(fromWarehouseId, sourceBatchId);
    }
    return;
  }
  const q = Number(qty) || 0;
  adjustBatchQty(db, destBatchId, -q);
  adjustBatchQty(db, sourceBatchId, q);
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

function listBatches(db, { productId, warehouseId, status = 'active', kind } = {}) {
  const where = [];
  const params = [];
  if (productId) { where.push('product_id=?'); params.push(productId); }
  if (warehouseId) { where.push('warehouse_id=?'); params.push(warehouseId); }
  if (status) { where.push('status=?'); params.push(status); }
  // Generic Lot UI must not mix tracked WH-RAW receipts (fabric + attr).
  if (kind) { where.push("COALESCE(kind,'generic')=?"); params.push(kind); }
  else { where.push("COALESCE(kind,'generic') NOT IN ('fabric','attr')"); }
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
  splitBatchForTransfer, unsplitBatchForTransfer,
  createSerial, setSerialStatus, listSerials,
};
