'use strict';
/**
 * Inventory reservation — soft-allocates available stock without moving it.
 * Available = on_hand - reserved_active.
 */
const { warehouseQty, invErr } = require('./ledger');

function nextRsvNo(db) {
  try {
    const { allocateNumber } = require('../../db');
    return allocateNumber(db, 'inventory_reservation', 'RSV');
  } catch (_) {
    return 'RSV-' + Date.now().toString(36).toUpperCase();
  }
}

function setting(db, key, fallback) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r?.value != null ? r.value : fallback;
}

function reservedQty(db, productId, warehouseId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(qty - qty_released - qty_consumed),0) as q
    FROM inventory_reservations
    WHERE product_id=? AND status='active'
      AND (? IS NULL OR warehouse_id=? OR warehouse_id IS NULL)
  `).get(productId, warehouseId, warehouseId);
  return Number(row?.q) || 0;
}

function availableQty(db, productId, warehouseId) {
  return Math.max(0, warehouseQty(db, productId, warehouseId) - reservedQty(db, productId, warehouseId));
}

function createReservation(db, {
  kind = 'sales', productId, warehouseId = null, qty,
  priority = 100, sourceType = '', sourceId = null, batchId = null,
  note = '', createdBy = null, ttlHours,
}) {
  const q = Number(qty) || 0;
  if (!productId || q <= 0) throw invErr('E_RSV_ARGS', 400);
  const avail = availableQty(db, productId, warehouseId);
  if (q > avail + 1e-9) {
    throw invErr('E_RSV_INSUFFICIENT', 409, { available: avail, needed: q });
  }
  const hours = ttlHours != null ? Number(ttlHours) : Number(setting(db, 'inventory_reservation_ttl_hours', '72'));
  const expiresAt = hours > 0 ? Math.floor(Date.now() / 1000) + Math.round(hours * 3600) : null;
  const no = nextRsvNo(db);
  const r = db.prepare(`
    INSERT INTO inventory_reservations (
      reservation_no, kind, product_id, warehouse_id, qty, priority, status,
      expires_at, source_type, source_id, batch_id, note, created_by
    ) VALUES (?,?,?,?,?,?,'active',?,?,?,?,?,?)
  `).run(
    no, kind, productId, warehouseId, q, priority,
    expiresAt, sourceType || '', sourceId, batchId, note || '', createdBy
  );
  return db.prepare('SELECT * FROM inventory_reservations WHERE id=?').get(r.lastInsertRowid);
}

function releaseReservation(db, id, qty = null) {
  const row = db.prepare('SELECT * FROM inventory_reservations WHERE id=?').get(id);
  if (!row) throw invErr('E_RSV_NOT_FOUND', 404);
  if (row.status !== 'active') throw invErr('E_RSV_NOT_ACTIVE', 409);
  const open = (Number(row.qty) || 0) - (Number(row.qty_released) || 0) - (Number(row.qty_consumed) || 0);
  const rel = qty == null ? open : Math.min(open, Number(qty) || 0);
  const newReleased = (Number(row.qty_released) || 0) + rel;
  const done = newReleased + (Number(row.qty_consumed) || 0) >= (Number(row.qty) || 0) - 1e-9;
  db.prepare(`
    UPDATE inventory_reservations SET qty_released=?, status=? WHERE id=?
  `).run(newReleased, done ? 'released' : 'active', id);
  return db.prepare('SELECT * FROM inventory_reservations WHERE id=?').get(id);
}

function consumeReservation(db, id, qty) {
  const row = db.prepare('SELECT * FROM inventory_reservations WHERE id=?').get(id);
  if (!row) throw invErr('E_RSV_NOT_FOUND', 404);
  if (row.status !== 'active') throw invErr('E_RSV_NOT_ACTIVE', 409);
  const open = (Number(row.qty) || 0) - (Number(row.qty_released) || 0) - (Number(row.qty_consumed) || 0);
  const take = Math.min(open, Number(qty) || 0);
  if (take <= 0) throw invErr('E_RSV_QTY', 400);
  const newCons = (Number(row.qty_consumed) || 0) + take;
  const done = newCons + (Number(row.qty_released) || 0) >= (Number(row.qty) || 0) - 1e-9;
  db.prepare(`
    UPDATE inventory_reservations SET qty_consumed=?, status=? WHERE id=?
  `).run(newCons, done ? 'consumed' : 'active', id);
  return { reservation: db.prepare('SELECT * FROM inventory_reservations WHERE id=?').get(id), qty: take };
}

function expireReservations(db) {
  const now = Math.floor(Date.now() / 1000);
  const r = db.prepare(`
    UPDATE inventory_reservations SET status='expired'
    WHERE status='active' AND expires_at IS NOT NULL AND expires_at < ?
  `).run(now);
  return r.changes;
}

function listReservations(db, { productId, warehouseId, status = 'active', kind, sourceType, sourceId } = {}) {
  const where = [];
  const params = [];
  if (productId) { where.push('product_id=?'); params.push(productId); }
  if (warehouseId) { where.push('warehouse_id=?'); params.push(warehouseId); }
  if (status) { where.push('status=?'); params.push(status); }
  if (kind) { where.push('kind=?'); params.push(kind); }
  if (sourceType) { where.push('source_type=?'); params.push(sourceType); }
  if (sourceId != null) { where.push('source_id=?'); params.push(+sourceId); }
  return db.prepare(`
    SELECT * FROM inventory_reservations
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY priority ASC, id DESC LIMIT 500
  `).all(...params);
}

// ── Sale context (NONTAX-P0-atp) ────────────────────────────────────────────────────────────────
// A firm-sale caller that knows its customer (invoice create/convert) wraps its stock posting in
// runWithSaleContext({ custId }, fn). Inside that synchronous scope consumeOpenReservationsForSale only
// consumes ORDER reservations that belong to that customer — the sale is their fulfilment — and leaves
// every other customer's soft-lock intact (the ATP gate already proved the sold units came from the
// unreserved pool). Outside the scope, and for callers that pass no custId, the legacy priority-FIFO
// behaviour is unchanged. better-sqlite3 is synchronous, so a module-level scope cannot interleave.
let saleContext = null;

function runWithSaleContext(ctx, fn) {
  const prev = saleContext;
  saleContext = ctx && typeof ctx === 'object' ? ctx : null;
  try { return fn(); } finally { saleContext = prev; }
}

function currentSaleContext() {
  return saleContext;
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

/**
 * Consume soft-locks when stock leaves via a firm sale.
 * With a customer (explicit custId or active sale context): only that customer's own order
 * reservations, by priority. Without: legacy FIFO by priority across all reservations.
 */
function consumeOpenReservationsForSale(db, { productId, warehouseId = null, qty, custId } = {}) {
  let need = Number(qty) || 0;
  if (!productId || need <= 0) return 0;
  const owner = custId != null && custId !== ''
    ? custId
    : (saleContext && saleContext.custId != null ? saleContext.custId : null);
  let rows;
  if (owner != null) {
    if (!tableExists(db, 'orders')) return 0;
    rows = db.prepare(`
      SELECT r.* FROM inventory_reservations r
      JOIN orders o ON o.id = r.source_id
      WHERE r.product_id=? AND r.status='active' AND r.source_type='order' AND o.cust_id=?
        AND (? IS NULL OR r.warehouse_id=? OR r.warehouse_id IS NULL)
      ORDER BY r.priority ASC, r.id ASC
    `).all(productId, owner, warehouseId, warehouseId);
  } else {
    rows = db.prepare(`
      SELECT * FROM inventory_reservations
      WHERE product_id=? AND status='active'
        AND (? IS NULL OR warehouse_id=? OR warehouse_id IS NULL)
      ORDER BY priority ASC, id ASC
    `).all(productId, warehouseId, warehouseId);
  }
  let taken = 0;
  for (const row of rows) {
    if (need <= 1e-9) break;
    const open = (Number(row.qty) || 0) - (Number(row.qty_released) || 0) - (Number(row.qty_consumed) || 0);
    if (open <= 1e-9) continue;
    const take = Math.min(open, need);
    consumeReservation(db, row.id, take);
    need -= take;
    taken += take;
  }
  return taken;
}

function releaseBySource(db, sourceType, sourceId) {
  const rows = listReservations(db, { sourceType, sourceId, status: 'active' });
  for (const row of rows) {
    try { releaseReservation(db, row.id); } catch (_) { /* already released */ }
  }
  return rows.length;
}

module.exports = {
  createReservation, releaseReservation, consumeReservation,
  expireReservations, listReservations, availableQty, reservedQty,
  consumeOpenReservationsForSale, releaseBySource,
  runWithSaleContext, currentSaleContext,
};
