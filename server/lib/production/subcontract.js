'use strict';
/**
 * Subcontract out/in — PRD-13 / PRD-14
 */
const { allocateNumber } = require('../../db');
const { todayJalali } = require('../../jalali');
const { dr, cr, plug, postEvent, err } = require('./posting');

function num(v) { return Number(v) || 0; }

function getStage(db, orderId, stageId) {
  const st = db.prepare(`
    SELECT s.*, po.order_no, po.product_id, po.coa_wip_tafsili, po.warehouse_raw_id
    FROM production_order_stages s
    JOIN production_orders po ON po.id = s.order_id
    WHERE s.id=? AND s.order_id=?
  `).get(stageId, orderId);
  if (!st) throw err('E_NOT_FOUND', 404);
  return st;
}

function unitCostIn(stage) {
  const qi = num(stage.qty_in);
  if (!qi) return 0;
  return Math.round(num(stage.material_in_rial) / qi);
}

function sendToSubcontractor(db, { orderId, stageId, body, userId }) {
  return db.transaction(() => {
    const stage = getStage(db, orderId, stageId);
    if (!stage.is_subcontract) throw err('E_NOT_SUBCONTRACT', 422);
    if (stage.status !== 'in_progress') throw err('E_INVALID_STATUS', 409, { status: stage.status });

    const qty = num(body.qty != null ? body.qty : stage.qty_in);
    if (qty <= 0) throw err('E_QTY_INVALID', 422);
    if (qty > num(stage.qty_in) + 1e-9) throw err('E_QTY_EXCEEDS_STAGE', 422);

    const sent = db.prepare(`
      SELECT COALESCE(SUM(qty),0) s FROM production_subcontract
      WHERE order_id=? AND stage_id=? AND direction='out' AND status='posted'
    `).get(orderId, stageId);
    if (num(sent?.s) > 0) throw err('E_ALREADY_SENT', 409);

    const supplierId = body.supplier_id || stage.supplier_id;
    if (!supplierId) throw err('E_SUPPLIER_REQUIRED', 422);

    const unitCost = unitCostIn(stage);
    const amount = Math.round(unitCost * qty);
    const date = body.date || todayJalali();
    const period = date.slice(0, 7);

    let docNo = '';
    try { docNo = allocateNumber(db, 'subcontract', 'SC'); }
    catch { docNo = `SC-${Date.now()}`; }

    const subId = db.prepare(`
      INSERT INTO production_subcontract
        (doc_no, order_id, stage_id, supplier_id, direction, product_id,
         qty, unit_cost_rial, amount_rial, warehouse_id, date, period_label, status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'posted',?)
    `).run(
      docNo, orderId, stageId, supplierId, 'out', stage.product_id,
      qty, unitCost, amount, stage.warehouse_raw_id, date, period, userId
    ).lastInsertRowid;

    const je = postEvent(db, {
      event: 'PRD-13',
      sourceId: subId,
      date,
      description: `ارسال به پیمانکار — ${stage.order_no} مرحله ${stage.seq}`,
      createdBy: userId,
      lines: plug([
        dr(db, 'coa_subcontract_inventory', amount),
        cr(db, 'coa_wip', amount, stage.coa_wip_tafsili),
      ]),
    });
    if (je) {
      db.prepare('UPDATE production_subcontract SET je_id=? WHERE id=?').run(je.je_id, subId);
    }

    return {
      ok: true,
      subcontract_id: subId,
      qty,
      amount_rial: amount,
      journal_entry: je,
    };
  })();
}

function receiveFromSubcontractor(db, { orderId, stageId, body, userId }) {
  return db.transaction(() => {
    const stage = getStage(db, orderId, stageId);
    if (!stage.is_subcontract) throw err('E_NOT_SUBCONTRACT', 422);

    const outRow = db.prepare(`
      SELECT * FROM production_subcontract
      WHERE order_id=? AND stage_id=? AND direction='out' AND status='posted'
      ORDER BY id DESC LIMIT 1
    `).get(orderId, stageId);

    const qtySent = outRow ? num(outRow.qty) : num(stage.qty_in);
    const qtyReceived = num(body.qty_received != null ? body.qty_received : body.qty);
    const qtyWaste = num(body.qty_waste);
    const qtyLost = num(body.qty_lost);
    if (qtyReceived <= 0) throw err('E_QTY_INVALID', 422);

    const op = stage.operation_id
      ? db.prepare('SELECT * FROM bom_operations WHERE id=?').get(stage.operation_id)
      : db.prepare(`
          SELECT * FROM bom_operations WHERE bom_id=(
            SELECT bom_id FROM production_orders WHERE id=?
          ) AND cost_center_id=? ORDER BY seq LIMIT 1
        `).get(orderId, stage.cost_center_id);

    const feeUnit = Math.round(num(body.fee_unit_rial != null ? body.fee_unit_rial : op?.subcontract_fee_rial));
    const feeRial = Math.round(feeUnit * qtyReceived);
    const vatRial = Math.round(num(body.vat_rial) || 0);
    const date = body.date || todayJalali();
    const period = date.slice(0, 7);

    const returnUnit = outRow ? num(outRow.unit_cost_rial) : unitCostIn(stage);
    const amountReturned = Math.round(returnUnit * qtyReceived);
    const amountLost = Math.round(returnUnit * qtyLost);
    const invClear = amountReturned + amountLost;

    let docNo = '';
    try { docNo = allocateNumber(db, 'subcontract', 'SC'); }
    catch { docNo = `SC-${Date.now()}-IN`; }

    const supplierId = body.supplier_id || stage.supplier_id || outRow?.supplier_id;
    if (!supplierId) throw err('E_SUPPLIER_REQUIRED', 422);

    const subId = db.prepare(`
      INSERT INTO production_subcontract
        (doc_no, order_id, stage_id, supplier_id, direction, product_id,
         qty, qty_returned, qty_lost, unit_cost_rial, amount_rial,
         fee_unit_rial, fee_amount_rial, vat_rial, date, period_label, status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'posted',?)
    `).run(
      docNo, orderId, stageId, supplierId, 'in', stage.product_id,
      qtySent, qtyReceived, qtyLost, returnUnit, amountReturned,
      feeUnit, feeRial, vatRial, date, period, userId
    ).lastInsertRowid;

    const lines = plug([
      dr(db, 'coa_wip', amountReturned + feeRial, stage.coa_wip_tafsili),
      cr(db, 'coa_subcontract_inventory', invClear),
      cr(db, 'coa_payable', feeRial + vatRial),
    ]);
    if (vatRial) {
      lines.splice(1, 0, dr(db, 'coa_vat_receivable', vatRial));
    }

    const je = postEvent(db, {
      event: 'PRD-14',
      sourceId: subId,
      date,
      description: `دریافت از پیمانکار — ${stage.order_no} مرحله ${stage.seq}`,
      createdBy: userId,
      lines,
    });
    if (je) {
      db.prepare('UPDATE production_subcontract SET je_id=? WHERE id=?').run(je.je_id, subId);
    }

    let lostJe = null;
    if (amountLost > 0) {
      lostJe = postEvent(db, {
        event: 'PRD-09',
        sourceId: subId,
        date,
        description: `کسری نزد پیمانکار — ${stage.order_no}`,
        createdBy: userId,
        lines: [
          dr(db, 'coa_abnormal_waste', amountLost),
          cr(db, 'coa_subcontract_inventory', amountLost),
        ],
      });
    }

    db.prepare(`
      UPDATE production_orders SET subcontract_cost_rial = subcontract_cost_rial + ?
      WHERE id=?
    `).run(feeRial, orderId);

    return {
      ok: true,
      subcontract_id: subId,
      qty_sent: qtySent,
      qty_received: qtyReceived,
      qty_waste: qtyWaste,
      qty_lost: qtyLost,
      fee_rial: feeRial,
      vat_rial: vatRial,
      amount_returned_rial: amountReturned,
      amount_lost_rial: amountLost,
      journal_entries: [je, lostJe].filter(Boolean),
    };
  })();
}

module.exports = { sendToSubcontractor, receiveFromSubcontractor };
