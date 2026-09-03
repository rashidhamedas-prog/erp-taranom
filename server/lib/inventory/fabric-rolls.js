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

function liveBatchMeters(db, batchId) {
  const id = Number(batchId);
  if (!id) return null;
  const row = db.prepare(`
    SELECT COALESCE(SUM(qty_in),0) - COALESCE(SUM(qty_out),0) AS qty
    FROM inventory_ledger
    WHERE batch_id=? AND status='posted'
  `).get(id);
  if (!row) return null;
  const has = db.prepare(`
    SELECT 1 FROM inventory_ledger WHERE batch_id=? AND status='posted' LIMIT 1
  `).get(id);
  if (!has) return null;
  return Number(row.qty) || 0;
}

function applyLiveRollQty(db, r) {
  if (!r || !r.id) return r;
  const live = liveBatchMeters(db, r.id);
  if (live == null) {
    r.qty_live = Number(r.qty_on_hand) || 0;
    return r;
  }
  if (Math.abs(live - (Number(r.qty_on_hand) || 0)) > 1e-6) {
    db.prepare('UPDATE inventory_batches SET qty_on_hand=? WHERE id=?').run(live, r.id);
    r.qty_on_hand = live;
  } else {
    r.qty_on_hand = live;
  }
  r.qty_live = live;
  return r;
}

function listFabricCirculation(db, query = {}) {
  const where = ["COALESCE(b.kind,'generic')='fabric'", "l.status='posted'"];
  const params = [];
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
           l.batch_id, b.batch_no, b.color, b.pattern, p.name AS product_name,
           w.name AS warehouse_name, u.name AS user_name
    FROM inventory_ledger l
    JOIN inventory_batches b ON b.id = l.batch_id
    LEFT JOIN products p ON p.id = b.product_id
    LEFT JOIN warehouses w ON w.id = l.warehouse_id
    LEFT JOIN users u ON u.id = l.created_by
    WHERE ${where.join(' AND ')}
    ORDER BY l.date ASC, l.id ASC
    LIMIT 2000
  `).all(...params);
  let run = 0;
  for (const r of rows) {
    run += (Number(r.qty_in) || 0) - (Number(r.qty_out) || 0);
    r.running_meters = run;
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
    throw httpErr(400, 'طاقه پارچه فقط در انبار مواد اولیه (WH-RAW) ثبت می‌شود', 'E_FABRIC_WH_RAW');
  }
  return wh;
}

function normUnit(v) {
  const s = String(v == null ? 'm' : v).trim().toLowerCase();
  if (s === '' || s === 'm' || s === 'meter' || s === 'metre' || s === 'متر') return 'm';
  throw httpErr(400, 'واحد طاقه باید متر باشد', 'E_FABRIC_UNIT');
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
  const where = ["COALESCE(b.kind,'generic')='fabric'"];
  const params = [];
  if (query.product_id) { where.push('b.product_id=?'); params.push(Number(query.product_id)); }
  if (query.warehouse_id) { where.push('b.warehouse_id=?'); params.push(Number(query.warehouse_id)); }
  if (query.status) { where.push('b.status=?'); params.push(String(query.status)); }
  else { where.push("COALESCE(b.status,'active') <> 'reversed'"); }
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
  for (const r of rows) {
    applyLiveRollQty(db, r);
    const meters = Number(r.qty_received != null ? r.qty_received : r.qty_on_hand) || 0;
    const unit = Math.round(Number(r.unit_cost_rial) || 0);
    r.amount_rial = assertSafeRial(Math.round(unit * meters), 'fabric list amount');
  }
  return rows;
}

function productUnitCostRial(prod) {
  const avg = Math.round(Number(prod && prod.average_cost_rial) || 0);
  if (avg > 0) return avg;
  const c = Math.round(Number(prod && prod.cost) || 0);
  if (c >= 1000) return c;
  return Math.round(c * 10);
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
    qty: meters,
    note: `فاکتور خرید — طاقه ${color}`,
    createdBy: user && user.id,
  });
  db.prepare(`
    UPDATE inventory_batches
    SET kind='fabric', color=?, pattern=?, width_cm=?, unit='m', unit_cost_rial=?,
        supplier_id=?, qty_received=?, ledger_id=?, source_type='purchase', source_id=?
    WHERE id=?
  `).run(
    color, f.pattern, f.width_cm, unitCost,
    supplierId || null, meters, movement && movement.id || null,
    sourceId || null, batch.id
  );
  return db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(batch.id);
}

// ORDER OF OPERATIONS (fabric sale): postSaleStockMovements posts the sale's
// inventory_ledger qty_out row *before* calling this function, so liveBatchMeters
// here already reflects the balance AFTER this sale. Re-checking `meters > live`
// would double-count the sale (subtract the meters twice) and wrongly reject a
// valid remaining sale — that was the "-20 مانده" bug. Availability is therefore
// asserted BEFORE the ledger post in postSaleStockMovements. Here we only
// reconstruct onHandBefore = liveAfter + meters to guard against a true
// pre-existing oversell, then sync the cached qty_on_hand to the live balance.
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
    // Ledger already includes this sale's qty_out → reconstruct the pre-sale balance.
    const onHandBefore = liveAfter + meters;
    if (meters - onHandBefore > 1e-9) {
      // Only a genuine oversell (pre-sale balance was already insufficient) fails.
      throw httpErr(409, `متر طاقه ${row.batch_no} کافی نیست (مانده ${onHandBefore})`, 'E_FABRIC_QTY');
    }
    // Sync cached qty_on_hand to the authoritative post-sale live balance.
    if (Math.abs(liveAfter - (Number(row.qty_on_hand) || 0)) > 1e-6) {
      db.prepare('UPDATE inventory_batches SET qty_on_hand=? WHERE id=?').run(liveAfter, id);
    }
    return;
  }
  // No live ledger info (batch never posted a ledger row): decrement cached qty.
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

  const wh = requireRawWarehouse(db, body.warehouse_id);
  const color = String(body.color || '').trim();
  if (!color) throw httpErr(400, 'رنگ طاقه الزامی است', 'E_FABRIC_COLOR');
  const pattern = String(body.pattern || body.design || '').trim();
  const widthCm = Math.round(Number(body.width_cm) || 0);
  if (widthCm < 0) throw httpErr(400, 'عرض نامعتبر است', 'E_FABRIC_WIDTH');
  const meters = Number(body.meters != null ? body.meters : body.qty);
  if (!(meters > 0) || !Number.isFinite(meters)) throw httpErr(400, 'متراژ باید بزرگ‌تر از صفر باشد', 'E_FABRIC_METERS');
  const unit = normUnit(body.unit);
  let unitCost = Math.round(Number(body.unit_cost_rial) || 0);
  if (unitCost < 0) throw httpErr(400, 'بهای واحد نامعتبر است', 'E_FABRIC_COST');
  if (!unitCost) unitCost = productUnitCostRial(prod);
  const amount = assertSafeRial(Math.round(unitCost * meters), 'fabric amount');
  const supplierId = body.supplier_id ? Number(body.supplier_id) : 0;
  if (amount > 0 && !supplierId) {
    throw httpErr(400, 'برای طاقه با بها، تأمین‌کننده الزامی است', 'E_FABRIC_SUPPLIER');
  }
  if (supplierId) {
    const sup = db.prepare('SELECT id FROM suppliers WHERE id=?').get(supplierId);
    if (!sup) throw httpErr(400, 'تأمین‌کننده نامعتبر است', 'E_FABRIC_SUPPLIER');
  }
  const date = String(body.date || todayJalali()).trim();
  const rollNo = String(body.roll_no || body.batch_no || '').trim();

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
      batch = createBatch(db, {
        productId,
        warehouseId: wh.id,
        batchNo: rollNo || undefined,
        supplierBatch: String(body.supplier_batch || '').trim(),
        qty: meters,
        note: String(body.note || '').trim(),
        createdBy: user.id,
      });
    } catch (e) {
      if (/UNIQUE/i.test(String(e && e.message))) {
        throw httpErr(409, 'شماره طاقه تکراری است', 'E_FABRIC_DUP_ROLL');
      }
      throw e;
    }
    try {
      db.prepare(`
        UPDATE inventory_batches
        SET kind='fabric', color=?, pattern=?, width_cm=?, unit=?, unit_cost_rial=?,
            supplier_id=?, qty_received=?, idempotency_key=?
        WHERE id=?
      `).run(
        color, pattern, widthCm, unit, unitCost,
        supplierId || null, meters, key, batch.id
      );
    } catch (e) {
      if (/UNIQUE/i.test(String(e && e.message))) {
        throw httpErr(409, 'این طاقه قبلاً ثبت شده است', 'E_FABRIC_IDEMPOTENT');
      }
      throw e;
    }

    const led = postInventoryMovement(db, {
      eventType: 'receipt',
      productId,
      warehouseId: wh.id,
      qtyIn: meters,
      unitCostRial: unitCost,
      amountRial: amount,
      sourceType: 'fabric_roll',
      sourceId: batch.id,
      batchId: batch.id,
      date,
      note: `دریافت طاقه ${batch.batch_no} — ${color}`,
      createdBy: user.id,
    });

    let journalId = null;
    if (amount > 0) {
      assertJournalIdempotent(db, 'fabric_roll', batch.id);
      journalId = postToLedger(db, {
        sourceType: 'fabric_roll',
        sourceId: batch.id,
        date,
        description: `دریافت طاقه ${batch.batch_no} — ${meters} متر`,
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
          description: `دریافت طاقه ${batch.batch_no} — ${meters} متر`,
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
  const row = db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(Number(id));
  if (!row || row.kind !== 'fabric') throw httpErr(404, 'طاقه یافت نشد', 'E_FABRIC_ROLL');
  if (row.status === 'reversed') throw httpErr(409, 'این طاقه قبلاً ابطال شده است', 'E_FABRIC_REVERSED');
  const onHand = Number(row.qty_on_hand) || 0;
  const received = Number(row.qty_received || row.qty_on_hand) || 0;
  if (Math.abs(onHand - received) > 1e-9) {
    throw httpErr(409, 'طاقه مصرف شده است؛ ابتدا مصرف را برگردانید', 'E_FABRIC_CONSUMED');
  }

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
      postSupplierLedger(db, {
        supplier_id: row.supplier_id,
        date: todayJalali(),
        entry_type: 'reversal',
        ref_id: row.id,
        description: reason || `ابطال دریافت طاقه ${row.batch_no}`,
        debit: amount,
        credit: 0,
        user_id: user.id,
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

function rollUnused(row) {
  const onHand = Number(row.qty_on_hand) || 0;
  const received = Number(row.qty_received || row.qty_on_hand) || 0;
  return Math.abs(onHand - received) <= 1e-9;
}

function updateFabricRoll(db, id, body, user) {
  const row = db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(Number(id));
  if (!row || row.kind !== 'fabric') throw httpErr(404, 'طاقه یافت نشد', 'E_FABRIC_ROLL');
  if (row.status === 'reversed') throw httpErr(409, 'طاقه ابطال‌شده قابل ویرایش نیست', 'E_FABRIC_REVERSED');
  if (!rollUnused(row)) {
    throw httpErr(409, 'طاقه مصرف شده است؛ ابتدا مصرف را برگردانید', 'E_FABRIC_CONSUMED');
  }

  const color = String(body.color != null ? body.color : row.color || '').trim();
  if (!color) throw httpErr(400, 'رنگ طاقه الزامی است', 'E_FABRIC_COLOR');
  const pattern = String(body.pattern != null ? body.pattern : row.pattern || '').trim();
  const widthCm = body.width_cm != null ? Math.round(Number(body.width_cm) || 0) : (Number(row.width_cm) || 0);
  const meters = body.meters != null || body.qty != null
    ? Number(body.meters != null ? body.meters : body.qty)
    : Number(row.qty_received || row.qty_on_hand) || 0;
  if (!(meters > 0) || !Number.isFinite(meters)) throw httpErr(400, 'متراژ باید بزرگ‌تر از صفر باشد', 'E_FABRIC_METERS');
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
    throw httpErr(400, 'برای طاقه با بها، تأمین‌کننده الزامی است', 'E_FABRIC_SUPPLIER');
  }
  const date = String(body.date || todayJalali()).trim();
  const rollNo = String(body.roll_no != null ? body.roll_no : row.batch_no || '').trim();
  const oldAmount = assertSafeRial(
    Math.round((Number(row.unit_cost_rial) || 0) * (Number(row.qty_received || row.qty_on_hand) || 0)),
    'fabric old amount'
  );
  const financialChanged = amount !== oldAmount || Number(supplierId || 0) !== Number(row.supplier_id || 0)
    || meters !== (Number(row.qty_received || row.qty_on_hand) || 0);

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
        postSupplierLedger(db, {
          supplier_id: row.supplier_id,
          date,
          entry_type: 'reversal',
          ref_id: row.id,
          description: `ویرایش طاقه ${row.batch_no} — برگشت بها`,
          debit: oldAmount,
          credit: 0,
          user_id: user.id,
        });
      }
    }

    const qtyDelta = meters - (Number(row.qty_on_hand) || 0);
    if (qtyDelta) adjustBatchQty(db, row.id, qtyDelta);
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
    db.prepare(`
      UPDATE inventory_batches
      SET color=?, pattern=?, width_cm=?, unit_cost_rial=?, supplier_id=?, qty_received=?
      WHERE id=?
    `).run(color, pattern, widthCm, unitCost, supplierId || null, meters, row.id);

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
    }
  })();

  return db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(Number(id));
}

module.exports = {
  listFabricRolls,
  listFabricCirculation,
  liveBatchMeters,
  applyLiveRollQty,
  receiveFabricRoll,
  voidFabricRoll,
  updateFabricRoll,
  requireRawWarehouse,
  fabricLineFields,
  isFabricPurchaseLine,
  attachFabricIdentityOnPurchase,
  consumeFabricRollOnSale,
  reverseFabricIdentitiesBySource,
  restoreFabricQtyFromLedgerRows,
  productUnitCostRial,
  invErr,
};
