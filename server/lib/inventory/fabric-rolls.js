'use strict';
/**
 * PROD-01 — fabric roll receipt on WH-RAW only (ADR-007 Accepted).
 * FG stays without Lot/Serial. No Bin. Stock only via inventory ledger.
 */

const { todayJalali } = require('../../jalali');
const { acct } = require('../coa-map');
const { rialToLedger, assertSafeRial } = require('../money');
const { assertJournalIdempotent } = require('../sales-document');
const { postInventoryMovement, reverseInventoryMovement, invErr } = require('./ledger');
const { createBatch, adjustBatchQty } = require('./batch-serial');

/**
 * Authoritative roll meters = tagged ledger inbound − outbound.
 *
 * IMPORTANT — reverseInventoryMovement both:
 *   1) marks the original row status='reversed', and
 *   2) posts an opposite 'reversal' row (still status='posted').
 * Summing only status='posted' therefore double-counts every void
 * (exclude original out AND add reversal in). Balance must include ALL
 * ledger rows for the batch; status is UI metadata, not a qty filter.
 *
 * Purchase identity used to be attached AFTER the receipt movement, so the
 * inbound row often has batch_id NULL. Reconstruct inbound from qty_received
 * (or cached on-hand + already-tagged outbound) so a later sale does not see
 * "0 inbound − this sale" and reject a valid remaining roll.
 */
function liveBatchMeters(db, batchId) {
  const id = Number(batchId);
  if (!id) return null;
  const batch = db.prepare(
    'SELECT qty_on_hand, qty_received FROM inventory_batches WHERE id=?'
  ).get(id);
  if (!batch) return null;
  const agg = db.prepare(`
    SELECT
      COALESCE(SUM(qty_in),0) AS qty_in,
      COALESCE(SUM(qty_out),0) AS qty_out,
      COUNT(*) AS n
    FROM inventory_ledger
    WHERE batch_id=?
  `).get(id);
  if (!agg || !Number(agg.n)) return null;
  const taggedIn = Number(agg.qty_in) || 0;
  const taggedOut = Number(agg.qty_out) || 0;
  if (taggedIn > 0) return taggedIn - taggedOut;
  const received = Number(batch.qty_received);
  const cached = Number(batch.qty_on_hand) || 0;
  const inbound = (Number.isFinite(received) && received > 0)
    ? received
    : (cached + taggedOut);
  return inbound - taggedOut;
}

/**
 * Fabric warehouse_stock is a denormalized cache of Σ live batch meters.
 * Untagged production issues can drain the product bucket while rolls still
 * hold meters — realign the cache from batch ledgers before consume/sale.
 */
function syncFabricProductWarehouse(db, productId, warehouseId) {
  const pid = Number(productId);
  const wid = Number(warehouseId);
  if (!pid || !wid) return null;
  const batches = db.prepare(`
    SELECT id FROM inventory_batches
    WHERE product_id=? AND warehouse_id=?
      AND COALESCE(kind,'generic') IN ('fabric','attr')
      AND COALESCE(status,'') <> 'reversed'
  `).all(pid, wid);
  let expected = 0;
  for (const b of batches) {
    const live = liveBatchMeters(db, b.id);
    if (live != null && Number.isFinite(live)) expected += Math.max(0, live);
  }
  const { warehouseQty, ensureWhRow } = require('./ledger');
  ensureWhRow(db, pid, wid);
  const current = warehouseQty(db, pid, wid);
  const delta = expected - current;
  if (Math.abs(delta) < 1e-6) return { expected, current, delta: 0 };
  db.prepare(
    'UPDATE warehouse_stock SET qty=? WHERE product_id=? AND warehouse_id=?'
  ).run(expected, pid, wid);
  const total = db.prepare(
    'SELECT COALESCE(SUM(qty),0) AS s FROM warehouse_stock WHERE product_id=?'
  ).get(pid);
  db.prepare('UPDATE products SET stock=? WHERE id=?').run(Number(total.s) || 0, pid);
  return { expected, current, delta };
}

function healAllFabricWarehouseStock(db) {
  const pairs = db.prepare(`
    SELECT DISTINCT product_id, warehouse_id
    FROM inventory_batches
    WHERE COALESCE(kind,'generic') IN ('fabric','attr')
      AND COALESCE(status,'') <> 'reversed'
      AND product_id IS NOT NULL AND warehouse_id IS NOT NULL
  `).all();
  let n = 0;
  for (const p of pairs) {
    const r = syncFabricProductWarehouse(db, p.product_id, p.warehouse_id);
    if (r && Math.abs(r.delta) > 1e-6) n += 1;
  }
  return n;
}

function healUntaggedBatchReceipt(db, batchId) {
  const id = Number(batchId);
  if (!id) return 0;
  const batch = db.prepare(
    'SELECT id, ledger_id, source_type, source_id, product_id FROM inventory_batches WHERE id=?'
  ).get(id);
  if (!batch) return 0;
  let n = 0;
  if (batch.ledger_id) {
    n += db.prepare(
      'UPDATE inventory_ledger SET batch_id=? WHERE id=? AND (batch_id IS NULL OR batch_id=0)'
    ).run(id, batch.ledger_id).changes || 0;
  }
  if (batch.source_type && batch.source_id && batch.product_id) {
    n += db.prepare(`
      UPDATE inventory_ledger SET batch_id=?
      WHERE source_type=? AND source_id=? AND product_id=?
        AND qty_in>0 AND (batch_id IS NULL OR batch_id=0) AND status='posted'
    `).run(id, batch.source_type, batch.source_id, batch.product_id).changes || 0;
  }
  return n;
}

function availableBatchMeters(db, batchId) {
  healUntaggedBatchReceipt(db, batchId);
  const live = liveBatchMeters(db, batchId);
  if (live != null) return live;
  const row = db.prepare('SELECT qty_on_hand FROM inventory_batches WHERE id=?').get(Number(batchId));
  return Number(row?.qty_on_hand) || 0;
}

function normalizeFabricColor(raw) {
  return String(raw == null ? '' : raw)
    .trim()
    // ZWNJ often stands in for a space (سورمه‌ای ≈ سورمه ای) — treat as whitespace.
    .replace(/\u200c/g, ' ')
    .replace(/[\u064A\u0649]/g, '\u06cc')
    .replace(/\u0643/g, '\u06a9')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Soft key for clothing colors where و / نیم‌فاصله / فاصله عوض می‌شود ولی معنی یکی است.
 * مثال واقعی تولید: طاقه/لایه «سورمه ای» vs master «سرمه‌ای» (بدون و).
 */
function fabricColorMatchKey(raw) {
  return normalizeFabricColor(raw)
    .replace(/\u0648/g, '') // و اختیاری (سورمه ↔ سرمه)
    .replace(/\s+/g, '');
}

function colorsMatch(a, b) {
  const na = normalizeFabricColor(a);
  const nb = normalizeFabricColor(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return fabricColorMatchKey(na) === fabricColorMatchKey(nb);
}

function applyLiveRollQty(db, r) {
  if (!r || !r.id) return r;
  healUntaggedBatchReceipt(db, r.id);
  const live = liveBatchMeters(db, r.id);
  if (live == null) {
    r.qty_live = Number(r.qty_on_hand) || 0;
    return r;
  }
  const liveQty = Math.max(0, live);
  if (Math.abs(liveQty - (Number(r.qty_on_hand) || 0)) > 1e-6) {
    db.prepare('UPDATE inventory_batches SET qty_on_hand=? WHERE id=?').run(liveQty, r.id);
    r.qty_on_hand = liveQty;
  } else {
    r.qty_on_hand = liveQty;
  }
  if (liveQty > 1e-9 && r.status === 'empty') {
    db.prepare("UPDATE inventory_batches SET status='active' WHERE id=?").run(r.id);
    r.status = 'active';
  } else if (liveQty <= 1e-9 && r.status === 'active') {
    db.prepare("UPDATE inventory_batches SET status='empty' WHERE id=?").run(r.id);
    r.status = 'empty';
  }
  r.qty_live = liveQty;
  return r;
}

function listFabricCirculation(db, query = {}) {
  // Include reversed originals + reversal children so running meters net correctly
  // (see liveBatchMeters). UI can style status=reversed rows.
  // Default kind=fabric keeps cutting/legacy callers safe; UI passes kind=all.
  const params = [];
  const where = [trackedKindSql(parseTrackedKinds(query), params)];
  if (query.batch_id) { where.push('l.batch_id=?'); params.push(Number(query.batch_id)); }
  if (query.product_id) { where.push('b.product_id=?'); params.push(Number(query.product_id)); }
  if (query.q) {
    where.push('(b.batch_no LIKE ? OR IFNULL(p.name,\'\') LIKE ? OR IFNULL(b.color,\'\') LIKE ?)');
    const like = `%${String(query.q).trim()}%`;
    params.push(like, like, like);
  }
  if (query.from) { where.push('l.date>=?'); params.push(String(query.from)); }
  if (query.to) { where.push('l.date<=?'); params.push(String(query.to)); }
  const rows = db.prepare(`
    SELECT l.id, l.date, l.event_type, l.qty_in, l.qty_out, l.note, l.source_type, l.source_id,
           l.status AS ledger_status, l.reversed_of, l.batch_id, b.batch_no, b.color, b.pattern,
           p.name AS product_name, w.name AS warehouse_name, u.name AS user_name
    FROM inventory_ledger l
    JOIN inventory_batches b ON b.id = l.batch_id
    LEFT JOIN products p ON p.id = b.product_id
    LEFT JOIN warehouses w ON w.id = l.warehouse_id
    LEFT JOIN users u ON u.id = l.created_by
    WHERE ${where.join(' AND ')}
    ORDER BY l.date ASC, l.id ASC
    LIMIT 2000
  `).all(...params);
  const runByBatch = new Map();
  for (const r of rows) {
    const bid = r.batch_id || 0;
    const prev = runByBatch.get(bid) || 0;
    const next = prev + (Number(r.qty_in) || 0) - (Number(r.qty_out) || 0);
    runByBatch.set(bid, next);
    r.running_meters = next;
  }
  return { rows };
}

function httpErr(status, message, code, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function requireRawWarehouse(db, warehouseId) {
  const wh = db.prepare('SELECT * FROM warehouses WHERE id=?').get(Number(warehouseId));
  if (!wh) throw httpErr(400, 'انبار یافت نشد', 'E_FABRIC_WH');
  const code = String(wh.code || '');
  const type = String(wh.warehouse_type || wh.kind || '');
  const isRaw = code === 'WH-RAW' || type === 'raw_material' || type === 'raw';
  if (!isRaw) {
    throw httpErr(400, 'دریافت مواد با ویژگی فقط در انبار مواد اولیه (WH-RAW) ثبت می‌شود', 'E_FABRIC_WH_RAW');
  }
  return wh;
}

function isMeterProductUnit(unit) {
  const s = String(unit == null ? '' : unit).trim().toLowerCase();
  return /متر|meter|metre|\bm\b/.test(s) || s === 'm';
}

/** Tracked receipt kinds on WH-RAW (ADR-007: fabric + similar attributed materials). */
const TRACKED_KINDS = new Set(['fabric', 'attr']);

function parseTrackedKinds(query = {}) {
  const raw = String(query.kind || query.kinds || 'fabric').trim().toLowerCase();
  if (!raw || raw === 'fabric') return ['fabric'];
  if (raw === 'attr' || raw === 'attributed') return ['attr'];
  if (raw === 'all' || raw === 'tracked' || raw === 'material') return ['fabric', 'attr'];
  const parts = raw.split(/[,|]+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (p === 'fabric' || p === 'attr') out.push(p);
    else if (p === 'attributed') out.push('attr');
  }
  return out.length ? [...new Set(out)] : ['fabric'];
}

function trackedKindSql(kinds, params) {
  const list = (kinds || []).filter((k) => TRACKED_KINDS.has(k));
  if (!list.length) {
    params.push('fabric');
    return "COALESCE(b.kind,'generic')=?";
  }
  if (list.length === 1) {
    params.push(list[0]);
    return "COALESCE(b.kind,'generic')=?";
  }
  params.push(...list);
  return `COALESCE(b.kind,'generic') IN (${list.map(() => '?').join(',')})`;
}

/**
 * profile: fabric | attr | auto
 * fabric = طاقه متری (برش/فروش طاقه) — رنگ اجباری، واحد متر
 * attr = مواد با ویژگی (رنگ/طرح/درجه اختیاری) — هر واحد کالا، خارج از لایه‌چینی
 */
function resolveReceiptProfile(prod, body = {}) {
  const explicit = String(body.profile || body.kind || body.receipt_kind || '').trim().toLowerCase();
  if (explicit === 'fabric' || explicit === 'roll' || explicit === 'طاقه') return 'fabric';
  if (explicit === 'attr' || explicit === 'attributed' || explicit === 'generic_attr' || explicit === 'مواد') {
    return 'attr';
  }
  if (isMeterProductUnit(prod && prod.unit)) return 'fabric';
  return 'attr';
}

function normUnit(v, { allowAny = false } = {}) {
  const s = String(v == null ? 'm' : v).trim().toLowerCase();
  if (s === '' || s === 'm' || s === 'meter' || s === 'metre' || s === 'متر') return 'm';
  if (allowAny) {
    const raw = String(v == null ? '' : v).trim();
    return raw || 'pcs';
  }
  throw httpErr(400, 'واحد طاقه باید متر باشد', 'E_FABRIC_UNIT');
}

function assertTrackedBatch(row, { forUpdate = false } = {}) {
  if (!row || !TRACKED_KINDS.has(String(row.kind || ''))) {
    throw httpErr(404, forUpdate ? 'ردیف دریافت مواد یافت نشد' : 'طاقه/بچ ویژگی یافت نشد', 'E_FABRIC_ROLL');
  }
  return row;
}

function payableAcct(db, supplierId) {
  if (supplierId) {
    const s = db.prepare('SELECT coa_code FROM suppliers WHERE id=?').get(supplierId);
    if (s && s.coa_code) {
      const a = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(s.coa_code);
      if (a) return a;
    }
  }
  return acct(db, 'coa_payable');
}

function supplierDetailId(db, supplierId) {
  if (!supplierId) return null;
  try {
    const s = db.prepare('SELECT party_id FROM suppliers WHERE id=?').get(supplierId);
    if (!s || !s.party_id) return null;
    const party = db.prepare('SELECT detail_account_id FROM parties WHERE id=?').get(s.party_id);
    if (party && party.detail_account_id) return party.detail_account_id;
  } catch (_) { /* parties.detail_account_id may be absent */ }
  return null;
}

function postSupplierLedger(db, { supplier_id, date, entry_type, ref_id, description, debit, credit, user_id }) {
  db.prepare(`
    INSERT INTO supplier_ledger
      (supplier_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    supplier_id, date || '', entry_type, 'fabric_roll', ref_id || null,
    description || '', debit || 0, credit || 0, user_id || null
  );
}

function listFabricRolls(db, query = {}) {
  // Default kind=fabric — production cutting / invoice roll pickers must not see attr lots.
  const params = [];
  const where = [trackedKindSql(parseTrackedKinds(query), params)];
  if (query.product_id) { where.push('b.product_id=?'); params.push(Number(query.product_id)); }
  if (query.warehouse_id) { where.push('b.warehouse_id=?'); params.push(Number(query.warehouse_id)); }
  if (query.status) { where.push('b.status=?'); params.push(String(query.status)); }
  else { where.push("COALESCE(b.status,'active') <> 'reversed'"); }
  if (query.color) {
    where.push("IFNULL(b.color,'') LIKE ?");
    params.push('%' + String(query.color).trim() + '%');
  }
  if (query.width_cm != null && query.width_cm !== '' && Number(query.width_cm) > 0) {
    where.push('(b.width_cm=? OR IFNULL(b.width_cm,0)=0)');
    params.push(Math.round(Number(query.width_cm)));
  }
  if (query.q) {
    where.push("(b.batch_no LIKE ? OR IFNULL(p.name,'') LIKE ? OR IFNULL(b.color,'') LIKE ?)");
    const like = '%' + String(query.q).trim() + '%';
    params.push(like, like, like);
  }
  const rows = db.prepare(`
    SELECT b.*, p.name AS product_name, w.code AS warehouse_code, w.name AS warehouse_name,
           s.name AS supplier_name
    FROM inventory_batches b
    LEFT JOIN products p ON p.id = b.product_id
    LEFT JOIN warehouses w ON w.id = b.warehouse_id
    LEFT JOIN suppliers s ON s.id = b.supplier_id
    WHERE ${where.join(' AND ')}
    ORDER BY b.id DESC
    LIMIT 500
  `).all(...params);
  const wantColor = query.color ? normalizeFabricColor(query.color) : '';
  const minLive = query.min_qty != null && query.min_qty !== '' ? Number(query.min_qty) : null;
  const out = [];
  for (const r of rows) {
    applyLiveRollQty(db, r);
    if (wantColor && !colorsMatch(r.color, query.color)) continue;
    const live = Number(r.qty_live != null ? r.qty_live : r.qty_on_hand) || 0;
    if (minLive != null && live + 1e-9 < minLive) continue;
    const meters = Number(r.qty_received != null ? r.qty_received : r.qty_on_hand) || 0;
    const unit = Math.round(Number(r.unit_cost_rial) || 0);
    r.amount_rial = assertSafeRial(Math.round(unit * meters), 'fabric list amount');
    out.push(r);
  }
  return out;
}

function productUnitCostRial(prod) {
  return require('./product-unit-cost').productUnitCostRial(prod);
}

function fabricLineFields(r) {
  const batchId = r && r.batch_id ? parseInt(r.batch_id, 10) : null;
  const color = String((r && r.color) || '').trim();
  const pattern = String((r && (r.pattern || r.design)) || '').trim();
  const widthCm = Math.round(Number(r && r.width_cm) || 0);
  const explicit = !!(r && (r.is_fabric_roll || batchId || color || pattern || widthCm));
  return {
    batch_id: Number.isFinite(batchId) && batchId > 0 ? batchId : null,
    is_fabric_roll: explicit ? 1 : 0,
    color,
    pattern,
    width_cm: widthCm,
    roll_no: String((r && (r.roll_no || r.batch_no)) || '').trim(),
    unit_cost_rial: Math.round(Number(r && r.unit_cost_rial) || 0),
  };
}

function warehouseIsRaw(db, warehouseId) {
  if (!warehouseId) return false;
  try {
    const wh = db.prepare('SELECT code, warehouse_type, kind FROM warehouses WHERE id=?').get(Number(warehouseId));
    if (!wh) return false;
    const code = String(wh.code || '');
    const type = String(wh.warehouse_type || wh.kind || '');
    return code === 'WH-RAW' || type === 'raw_material' || type === 'raw';
  } catch (_) {
    return false;
  }
}

function isFabricPurchaseLine(db, row, warehouseId) {
  if (!row || !row.product_id) return false;
  const f = fabricLineFields(row);
  if (f.is_fabric_roll || f.batch_id) return true;
  try {
    const prod = db.prepare('SELECT unit FROM products WHERE id=?').get(row.product_id);
    const unit = String(prod && prod.unit || '').toLowerCase();
    const meter = /متر|meter|metre|\bm\b/.test(unit);
    return meter && warehouseIsRaw(db, warehouseId);
  } catch (_) {
    return false;
  }
}

function attachFabricIdentityOnPurchase(db, {
  row, movement, supplierId, user, date, warehouseId, sourceId,
}) {
  if (!row || !row.product_id) return null;
  const f = fabricLineFields(row);
  const meters = Number(row.qty) || 0;
  if (!(meters > 0)) return null;
  const prod = db.prepare('SELECT * FROM products WHERE id=?').get(row.product_id);
  if (!prod) return null;
  const unitCost = f.unit_cost_rial || Math.round(Number(row.price) || 0) || productUnitCostRial(prod);
  const color = f.color || 'نامشخص';
  const batch = createBatch(db, {
    productId: row.product_id,
    warehouseId,
    batchNo: f.roll_no || undefined,
    qty: 0,
    note: `فاکتور خرید — طاقه ${color}`,
    createdBy: user && user.id,
  });
  db.prepare(`
    UPDATE inventory_batches
    SET kind='fabric', color=?, pattern=?, width_cm=?, unit='m', unit_cost_rial=?,
        supplier_id=?, qty_received=?, qty_on_hand=?, ledger_id=?, source_type='purchase', source_id=?
    WHERE id=?
  `).run(
    color, f.pattern, f.width_cm, unitCost,
    supplierId || null, meters, meters, movement && movement.id || null,
    sourceId || null, batch.id
  );
  if (movement && movement.id) {
    db.prepare(
      'UPDATE inventory_ledger SET batch_id=? WHERE id=? AND (batch_id IS NULL OR batch_id=0)'
    ).run(batch.id, movement.id);
  }
  return db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(batch.id);
}

// Availability is asserted BEFORE the sale ledger row in postSaleStockMovements /
// assertWarehouseLines. After that row is posted, live meters already include
// this sale's qty_out. Do not re-check remaining vs requested (that rejected
// valid sales when the purchase receipt was not tagged with batch_id).
function consumeFabricRollOnSale(db, { batchId, qty }) {
  const id = Number(batchId);
  const meters = Number(qty) || 0;
  if (!id || !(meters > 0)) return;
  const row = db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(id);
  if (!row || row.kind !== 'fabric') {
    throw httpErr(400, 'طاقه انتخاب‌شده معتبر نیست', 'E_FABRIC_ROLL');
  }
  if (row.status === 'reversed') {
    throw httpErr(409, 'این طاقه ابطال شده است', 'E_FABRIC_REVERSED');
  }
  const liveAfter = liveBatchMeters(db, id);
  if (liveAfter != null) {
    if (Math.abs(liveAfter - (Number(row.qty_on_hand) || 0)) > 1e-6) {
      db.prepare('UPDATE inventory_batches SET qty_on_hand=? WHERE id=?').run(liveAfter, id);
    }
    return;
  }
  const onHand = Number(row.qty_on_hand) || 0;
  if (meters - onHand > 1e-9) {
    throw httpErr(409, `متر طاقه ${row.batch_no} کافی نیست (مانده ${onHand})`, 'E_FABRIC_QTY');
  }
  adjustBatchQty(db, id, -meters);
}

function reverseFabricIdentitiesBySource(db, sourceType, sourceId) {
  const rows = db.prepare(`
    SELECT id FROM inventory_batches
    WHERE source_type=? AND source_id=? AND COALESCE(kind,'generic')='fabric'
      AND COALESCE(status,'')<>'reversed'
  `).all(String(sourceType), Number(sourceId));
  for (const r of rows) {
    db.prepare(`
      UPDATE inventory_batches
      SET status='reversed', qty_on_hand=0, reversed_at=strftime('%s','now')
      WHERE id=?
    `).run(r.id);
  }
  return rows.length;
}

function restoreFabricQtyFromLedgerRows(db, rows) {
  for (const r of rows || []) {
    const bid = Number(r.batch_id);
    const q = Number(r.qty_out) || 0;
    if (bid && q > 0) {
      try { adjustBatchQty(db, bid, q); } catch (_) { /* batch may be gone */ }
    }
  }
}

function receiveFabricRoll(db, body, user) {
  const key = String(body.idempotency_key || '').trim();
  if (!key) {
    throw httpErr(400, 'کلید تکرارناپذیر الزامی است', 'E_FABRIC_IDEMPOTENCY');
  }
  const existing = db.prepare('SELECT * FROM inventory_batches WHERE idempotency_key=?').get(key);
  if (existing) return existing;
  const productId = Number(body.product_id);
  if (!productId) throw httpErr(400, 'کالا الزامی است', 'E_FABRIC_PRODUCT');
  const prod = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!prod) throw httpErr(404, 'کالا یافت نشد', 'E_FABRIC_PRODUCT');

  const profile = resolveReceiptProfile(prod, body);
  const wh = requireRawWarehouse(db, body.warehouse_id);
  let color = String(body.color || '').trim();
  const pattern = String(body.pattern || body.design || '').trim();
  const qualityGrade = String(body.quality_grade || body.grade || '').trim();
  const widthCm = Math.round(Number(body.width_cm) || 0);
  if (widthCm < 0) throw httpErr(400, 'عرض نامعتبر است', 'E_FABRIC_WIDTH');

  let qty;
  let unit;
  if (profile === 'fabric') {
    if (!color) throw httpErr(400, 'رنگ طاقه الزامی است', 'E_FABRIC_COLOR');
    qty = Number(body.meters != null ? body.meters : body.qty);
    if (!(qty > 0) || !Number.isFinite(qty)) {
      throw httpErr(400, 'متراژ باید بزرگ‌تر از صفر باشد', 'E_FABRIC_METERS');
    }
    unit = normUnit(body.unit);
  } else {
    // attr: color optional (empty → «—» for display); any product unit on WH-RAW
    if (!color) color = '—';
    qty = Number(body.qty != null ? body.qty : body.meters);
    if (!(qty > 0) || !Number.isFinite(qty)) {
      throw httpErr(400, 'مقدار باید بزرگ‌تر از صفر باشد', 'E_FABRIC_METERS');
    }
    const fromBody = body.unit != null && String(body.unit).trim() !== ''
      ? body.unit
      : (prod.unit || 'pcs');
    unit = normUnit(fromBody, { allowAny: true });
  }

  let unitCost = Math.round(Number(body.unit_cost_rial) || 0);
  if (unitCost < 0) throw httpErr(400, 'بهای واحد نامعتبر است', 'E_FABRIC_COST');
  if (!unitCost) unitCost = productUnitCostRial(prod);
  const amount = assertSafeRial(Math.round(unitCost * qty), 'fabric amount');
  const supplierId = body.supplier_id ? Number(body.supplier_id) : 0;
  if (amount > 0 && !supplierId) {
    throw httpErr(400, 'برای دریافت با بها، تأمین‌کننده الزامی است', 'E_FABRIC_SUPPLIER');
  }
  if (supplierId) {
    const sup = db.prepare('SELECT id FROM suppliers WHERE id=?').get(supplierId);
    if (!sup) throw httpErr(400, 'تأمین‌کننده نامعتبر است', 'E_FABRIC_SUPPLIER');
  }
  const date = String(body.date || todayJalali()).trim();
  const rollNo = String(body.roll_no || body.batch_no || '').trim();
  const kind = profile === 'fabric' ? 'fabric' : 'attr';
  const label = kind === 'fabric' ? 'طاقه' : 'بچ مواد';
  const qtyLabel = kind === 'fabric' ? `${qty} متر` : `${qty} ${unit}`;
  const noteExtra = qualityGrade ? ` · درجه ${qualityGrade}` : '';
  const userNote = String(body.note || '').trim();

  const { postToLedger } = require('../ledger');
  const invAcct = acct(db, 'coa_raw_materials');
  const payAcct = payableAcct(db, supplierId);

  let out;
  try {
    out = db.transaction(() => {
    const raced = db.prepare('SELECT * FROM inventory_batches WHERE idempotency_key=?').get(key);
    if (raced) return { existing: raced };
    let batch;
    try {
      // createBatch forbids inventing qty — qty enters via ledger + qty_on_hand below.
      batch = createBatch(db, {
        productId,
        warehouseId: wh.id,
        batchNo: rollNo || undefined,
        supplierBatch: String(body.supplier_batch || '').trim(),
        qty: 0,
        note: userNote || (qualityGrade ? `درجه: ${qualityGrade}` : ''),
        createdBy: user.id,
      });
    } catch (e) {
      if (/UNIQUE/i.test(String(e && e.message))) {
        throw httpErr(409, `شماره ${label} تکراری است`, 'E_FABRIC_DUP_ROLL');
      }
      throw e;
    }
    try {
      db.prepare(`
        UPDATE inventory_batches
        SET kind=?, color=?, pattern=?, width_cm=?, unit=?, unit_cost_rial=?,
            supplier_id=?, qty_received=?, qty_on_hand=?, idempotency_key=?,
            quality_grade=COALESCE(?, quality_grade)
        WHERE id=?
      `).run(
        kind, color, pattern, widthCm, unit, unitCost,
        supplierId || null, qty, qty, key,
        qualityGrade || null, batch.id
      );
    } catch (e) {
      if (/UNIQUE/i.test(String(e && e.message))) {
        throw httpErr(409, 'این دریافت قبلاً ثبت شده است', 'E_FABRIC_IDEMPOTENT');
      }
      throw e;
    }

    const led = postInventoryMovement(db, {
      eventType: 'receipt',
      productId,
      warehouseId: wh.id,
      qtyIn: qty,
      unitCostRial: unitCost,
      amountRial: amount,
      sourceType: 'fabric_roll',
      sourceId: batch.id,
      batchId: batch.id,
      date,
      note: `دریافت ${label} ${batch.batch_no} — ${color}${noteExtra}`,
      createdBy: user.id,
    });

    let journalId = null;
    if (amount > 0) {
      assertJournalIdempotent(db, 'fabric_roll', batch.id);
      journalId = postToLedger(db, {
        sourceType: 'fabric_roll',
        sourceId: batch.id,
        date,
        description: `دریافت ${label} ${batch.batch_no} — ${qtyLabel}`,
        createdBy: user.id,
        lines: [
          { code: invAcct.code, name: invAcct.name, debit: rialToLedger(amount), credit: 0 },
          {
            code: payAcct.code,
            name: payAcct.name,
            debit: 0,
            credit: rialToLedger(amount),
            detail_account_id: supplierDetailId(db, supplierId),
          },
        ],
      });
      if (supplierId) {
        postSupplierLedger(db, {
          supplier_id: supplierId,
          date,
          entry_type: 'purchase',
          ref_id: batch.id,
          description: `دریافت ${label} ${batch.batch_no} — ${qtyLabel}`,
          debit: 0,
          credit: amount,
          user_id: user.id,
        });
      }
    }
    db.prepare('UPDATE inventory_batches SET ledger_id=?, journal_id=? WHERE id=?')
      .run(led.id, journalId, batch.id);
    return { batchId: batch.id, ledgerId: led.id, journalId };
    })();
  } catch (e) {
    if (e && e.code === 'E_FABRIC_IDEMPOTENT') {
      const again = db.prepare('SELECT * FROM inventory_batches WHERE idempotency_key=?').get(key);
      if (again) return again;
    }
    throw e;
  }
  if (out.existing) return out.existing;

  return db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(out.batchId);
}

function voidFabricRoll(db, id, user, { reason } = {}) {
  let row = db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(Number(id));
  assertTrackedBatch(row);
  if (row.status === 'reversed') throw httpErr(409, 'این دریافت قبلاً ابطال شده است', 'E_FABRIC_REVERSED');
  row = applyLiveRollQty(db, row);
  if (!rollUnused(row)) {
    throw httpErr(409, 'این ردیف مصرف شده است؛ ابتدا مصرف را برگردانید', 'E_FABRIC_CONSUMED');
  }
  const onHand = Number(row.qty_on_hand) || 0;

  const { reverseJournalEntry } = require('../void-journal');
  db.transaction(() => {
    if (row.ledger_id) {
      reverseInventoryMovement(db, row.ledger_id, {
        createdBy: user.id,
        note: reason || 'ابطال دریافت طاقه',
      });
    }
    let revJe = null;
    if (row.journal_id) {
      revJe = reverseJournalEntry(db, row.journal_id, {
        userId: user.id,
        reason: reason || 'ابطال دریافت طاقه',
        sourceType: 'fabric_roll_reversal',
      });
    }
    const amount = assertSafeRial(
      Math.round((Number(row.unit_cost_rial) || 0) * (Number(row.qty_received || row.qty_on_hand) || 0)),
      'fabric void amount'
    );
    if (row.supplier_id && amount > 0) {
      // v373: retire supplier books — no hollow reverse lines.
      const { retireSupplierLedgerByRef } = require('../party-ledger-retire');
      retireSupplierLedgerByRef(db, {
        refTypes: ['fabric_roll'],
        refId: row.id,
        supplierId: row.supplier_id,
      });
    }
    adjustBatchQty(db, row.id, -onHand);
    db.prepare(`
      UPDATE inventory_batches
      SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=?, reversal_journal_id=?
      WHERE id=?
    `).run(user.id, revJe, row.id);
  })();
  return db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(Number(id));
}

/** Live meters (after heal) equal received — safe for void / financial amend. */
function rollUnused(row) {
  const live = Number(row.qty_live != null ? row.qty_live : row.qty_on_hand) || 0;
  const received = Number(row.qty_received != null ? row.qty_received : row.qty_on_hand) || 0;
  return Math.abs(live - received) <= 1e-9;
}

function updateFabricRoll(db, id, body, user) {
  let row = db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(Number(id));
  assertTrackedBatch(row, { forUpdate: true });
  if (row.status === 'reversed') throw httpErr(409, 'ردیف ابطال‌شده قابل ویرایش نیست', 'E_FABRIC_REVERSED');
  row = applyLiveRollQty(db, row);

  const isFabric = String(row.kind) === 'fabric';
  let color = String(body.color != null ? body.color : row.color || '').trim();
  if (isFabric && !color) throw httpErr(400, 'رنگ طاقه الزامی است', 'E_FABRIC_COLOR');
  if (!isFabric && !color) color = '—';
  const pattern = String(body.pattern != null ? body.pattern : row.pattern || '').trim();
  const widthCm = body.width_cm != null ? Math.round(Number(body.width_cm) || 0) : (Number(row.width_cm) || 0);
  const oldMeters = Number(row.qty_received != null ? row.qty_received : row.qty_on_hand) || 0;
  const meters = body.meters != null || body.qty != null
    ? Number(body.meters != null ? body.meters : body.qty)
    : oldMeters;
  if (!(meters > 0) || !Number.isFinite(meters)) {
    throw httpErr(400, isFabric ? 'متراژ باید بزرگ‌تر از صفر باشد' : 'مقدار باید بزرگ‌تر از صفر باشد', 'E_FABRIC_METERS');
  }
  let unitCost = body.unit_cost_rial != null
    ? Math.round(Number(body.unit_cost_rial) || 0)
    : Math.round(Number(row.unit_cost_rial) || 0);
  if (unitCost < 0) throw httpErr(400, 'بهای واحد نامعتبر است', 'E_FABRIC_COST');
  if (!unitCost) {
    const prod = db.prepare('SELECT * FROM products WHERE id=?').get(row.product_id);
    unitCost = productUnitCostRial(prod);
  }
  const supplierId = body.supplier_id != null
    ? (body.supplier_id ? Number(body.supplier_id) : 0)
    : (row.supplier_id || 0);
  const amount = assertSafeRial(Math.round(unitCost * meters), 'fabric update amount');
  if (amount > 0 && !supplierId) {
    throw httpErr(400, 'برای دریافت با بها، تأمین‌کننده الزامی است', 'E_FABRIC_SUPPLIER');
  }
  const date = String(body.date || todayJalali()).trim();
  const rollNo = String(body.roll_no != null ? body.roll_no : row.batch_no || '').trim();
  const oldAmount = assertSafeRial(
    Math.round((Number(row.unit_cost_rial) || 0) * oldMeters),
    'fabric old amount'
  );
  const financialChanged = amount !== oldAmount
    || Number(supplierId || 0) !== Number(row.supplier_id || 0)
    || Math.abs(meters - oldMeters) > 1e-9;
  const fromPurchase = String(row.source_type || '') === 'purchase';

  if (financialChanged) {
    if (fromPurchase) {
      throw httpErr(
        409,
        'متر/بها/تأمین‌کننده طاقهٔ ناشی از فاکتور خرید را از همان فاکتور اصلاح کنید',
        'E_FABRIC_PURCHASE_AMEND'
      );
    }
    if (!rollUnused(row)) {
      throw httpErr(
        409,
        'برای تغییر متر/بها/تأمین‌کننده طاقه باید مصرف‌نشده باشد؛ رنگ/طرح/عرض/شماره را می‌توانید ویرایش کنید',
        'E_FABRIC_CONSUMED'
      );
    }
  }

  const { postToLedger } = require('../ledger');
  const { reverseJournalEntry } = require('../void-journal');
  const invAcct = acct(db, 'coa_raw_materials');
  const payAcct = payableAcct(db, supplierId);

  db.transaction(() => {
    if (financialChanged) {
      if (row.ledger_id) {
        reverseInventoryMovement(db, row.ledger_id, {
          createdBy: user.id,
          note: 'ویرایش دریافت طاقه',
        });
      }
      if (row.journal_id) {
        reverseJournalEntry(db, row.journal_id, {
          userId: user.id,
          reason: 'ویرایش دریافت طاقه',
          sourceType: 'fabric_roll_reversal',
        });
      }
      if (row.supplier_id && oldAmount > 0) {
        const { retireSupplierLedgerByRef } = require('../party-ledger-retire');
        retireSupplierLedgerByRef(db, {
          refTypes: ['fabric_roll'],
          refId: row.id,
          supplierId: row.supplier_id,
        });
      }
    }

    if (financialChanged) {
      const qtyDelta = meters - (Number(row.qty_on_hand) || 0);
      if (qtyDelta) adjustBatchQty(db, row.id, qtyDelta);
    }
    if (rollNo && rollNo !== row.batch_no) {
      try {
        db.prepare('UPDATE inventory_batches SET batch_no=? WHERE id=?').run(rollNo, row.id);
      } catch (e) {
        if (/UNIQUE/i.test(String(e && e.message))) {
          throw httpErr(409, 'شماره طاقه تکراری است', 'E_FABRIC_DUP_ROLL');
        }
        throw e;
      }
    }
    if (financialChanged) {
      db.prepare(`
        UPDATE inventory_batches
        SET color=?, pattern=?, width_cm=?, unit_cost_rial=?, supplier_id=?, qty_received=?
        WHERE id=?
      `).run(color, pattern, widthCm, unitCost, supplierId || null, meters, row.id);
    } else {
      db.prepare(`
        UPDATE inventory_batches
        SET color=?, pattern=?, width_cm=?
        WHERE id=?
      `).run(color, pattern, widthCm, row.id);
    }

    if (financialChanged) {
      const led = postInventoryMovement(db, {
        eventType: 'receipt',
        productId: row.product_id,
        warehouseId: row.warehouse_id,
        qtyIn: meters,
        unitCostRial: unitCost,
        amountRial: amount,
        sourceType: 'fabric_roll',
        sourceId: row.id,
        batchId: row.id,
        date,
        note: `ویرایش طاقه ${rollNo || row.batch_no} — ${color}`,
        createdBy: user.id,
      });
      let journalId = null;
      if (amount > 0) {
        journalId = postToLedger(db, {
          sourceType: 'fabric_roll_edit',
          sourceId: row.id,
          date,
          description: `ویرایش طاقه ${rollNo || row.batch_no} — ${meters} متر`,
          createdBy: user.id,
          lines: [
            { code: invAcct.code, name: invAcct.name, debit: rialToLedger(amount), credit: 0 },
            {
              code: payAcct.code,
              name: payAcct.name,
              debit: 0,
              credit: rialToLedger(amount),
              detail_account_id: supplierDetailId(db, supplierId),
            },
          ],
        });
        if (supplierId) {
          postSupplierLedger(db, {
            supplier_id: supplierId,
            date,
            entry_type: 'purchase',
            ref_id: row.id,
            description: `ویرایش طاقه ${rollNo || row.batch_no} — ${meters} متر`,
            debit: 0,
            credit: amount,
            user_id: user.id,
          });
        }
      }
      db.prepare('UPDATE inventory_batches SET ledger_id=?, journal_id=? WHERE id=?')
        .run(led.id, journalId, row.id);
      try {
        syncFabricProductWarehouse(db, row.product_id, row.warehouse_id);
      } catch (_) { /* heal best-effort */ }
    }
  })();

  return applyLiveRollQty(db, db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(Number(id)));
}

module.exports = {
  normalizeFabricColor,
  fabricColorMatchKey,
  colorsMatch,
  listFabricRolls,
  listFabricCirculation,
  liveBatchMeters,
  availableBatchMeters,
  syncFabricProductWarehouse,
  healAllFabricWarehouseStock,
  healUntaggedBatchReceipt,
  applyLiveRollQty,
  receiveFabricRoll,
  voidFabricRoll,
  updateFabricRoll,
  rollUnused,
  requireRawWarehouse,
  resolveReceiptProfile,
  isMeterProductUnit,
  parseTrackedKinds,
  TRACKED_KINDS,
  fabricLineFields,
  isFabricPurchaseLine,
  attachFabricIdentityOnPurchase,
  consumeFabricRollOnSale,
  reverseFabricIdentitiesBySource,
  restoreFabricQtyFromLedgerRows,
  productUnitCostRial,
  invErr,
};
