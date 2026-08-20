'use strict';
/**
 * PROD-01 — fabric roll receipt on WH-RAW only (ADR-007 Accepted).
 * FG stays without Lot/Serial. No Bin. Stock only via inventory ledger.
 */

const { todayJalali } = require('../../jalali');
const { acct } = require('../coa-map');
const { rialToLedger, assertSafeRial } = require('../money');
const { postInventoryMovement, reverseInventoryMovement, invErr } = require('./ledger');
const { createBatch, adjustBatchQty } = require('./batch-serial');

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

function supplierDetailId(db, supplierId) {
  if (!supplierId) return null;
  try {
    const party = db.prepare('SELECT detail_account_id FROM parties WHERE id=?').get(supplierId);
    if (party && party.detail_account_id) return party.detail_account_id;
  } catch (_) { /* parties.detail_account_id may be absent */ }
  return null;
}

function listFabricRolls(db, query = {}) {
  const where = ["COALESCE(b.kind,'generic')='fabric'"];
  const params = [];
  if (query.product_id) { where.push('b.product_id=?'); params.push(Number(query.product_id)); }
  if (query.warehouse_id) { where.push('b.warehouse_id=?'); params.push(Number(query.warehouse_id)); }
  if (query.status) { where.push('b.status=?'); params.push(String(query.status)); }
  else { where.push("COALESCE(b.status,'active') <> 'reversed'"); }
  return db.prepare(`
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
}

function receiveFabricRoll(db, body, user) {
  const key = String(body.idempotency_key || '').trim();
  if (key) {
    const existing = db.prepare('SELECT * FROM inventory_batches WHERE idempotency_key=?').get(key);
    if (existing) throw httpErr(409, 'این طاقه قبلاً ثبت شده است', 'E_FABRIC_IDEMPOTENT', { id: existing.id });
  }
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
  const unitCost = Math.round(Number(body.unit_cost_rial) || 0);
  if (unitCost < 0) throw httpErr(400, 'بهای واحد نامعتبر است', 'E_FABRIC_COST');
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
  const payAcct = acct(db, 'coa_payable');

  const out = db.transaction(() => {
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
    db.prepare(`
      UPDATE inventory_batches
      SET kind='fabric', color=?, pattern=?, width_cm=?, unit=?, unit_cost_rial=?,
          supplier_id=?, qty_received=?, idempotency_key=?
      WHERE id=?
    `).run(
      color, pattern, widthCm, unit, unitCost,
      supplierId || null, meters, key || null, batch.id
    );

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
    }
    db.prepare('UPDATE inventory_batches SET ledger_id=?, journal_id=? WHERE id=?')
      .run(led.id, journalId, batch.id);
    return { batchId: batch.id, ledgerId: led.id, journalId };
  })();

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
    adjustBatchQty(db, row.id, -onHand);
    db.prepare(`
      UPDATE inventory_batches
      SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=?, reversal_journal_id=?
      WHERE id=?
    `).run(user.id, revJe, row.id);
  })();
  return db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(Number(id));
}

module.exports = {
  listFabricRolls,
  receiveFabricRoll,
  voidFabricRoll,
  requireRawWarehouse,
  invErr,
};
