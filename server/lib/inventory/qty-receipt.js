'use strict';
/**
 * P7 — qty-only supplier receipt (رسید مقداری صندوقدار) + costing (ریالی‌سازی حسابدار).
 *
 * Receipt = a GRNI-class warehouse_docs row with qty_only=1. Stock enters the kardex at the
 * product's current average (provisional); with no average it enters at 0 and cost_pending=1.
 * GL follows the existing GRNI path of createWarehouseDoc (Dr inventory / Cr coa_grni at the
 * provisional value; nothing when the value is 0 or the warehouse is periodic).
 *
 * Costing reuses invoiceWarehouseGrni: purchase invoice (stock_added=0) clears GRNI → AP and
 * moves the kardex by a value-only row to the real price. Cancel paths (R13, no physical delete):
 *   - before costing: voidWarehouseDoc (kardex + GRNI JE reversed in one transaction)
 *   - after costing: void the purchase invoice (DELETE /api/purchases/:id) → JE reversed, value-only
 *     rows reversed, doc unlinked → back to «awaiting costing»; then the receipt itself may be voided.
 *
 * Cashier responses are whitelisted (no amount/cost/price keys); the P4 strip middleware on
 * /api/warehouses is a second layer.
 *
 * Audit (entity `qty_receipt`, inside the same transaction as the mutation): create / cost /
 * cost_reverse (written by unlinkWarehouseGrniOnPurchaseVoid) / reverse. Details carry rial
 * amounts; audit_log is readable only through admin-only APIs (/api/admin/audit, /api/activity-log)
 * and is central-only (not synced), so non-cost roles never receive them.
 */
const { getWarehouseDoc, createWarehouseDoc, voidWarehouseDocInTx } = require('../warehouse-docs');
const { invoiceWarehouseGrni } = require('../warehouse-grni-invoice');
const { audit } = require('../../db');

const AUDIT_ENTITY = 'qty_receipt';

/** cost_pending as at receipt time: any active line entered the kardex at 0. */
function provisionalCostPending(db, docId) {
  const zero = db.prepare(`
    SELECT COUNT(*) AS c FROM warehouse_moves
    WHERE doc_id=? AND COALESCE(status,'posted')<>'reversed' AND COALESCE(amount_rial,0)<=0
  `).get(docId).c;
  return zero > 0 ? 1 : 0;
}

function qrErr(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

function costingStatus(doc) {
  if (String(doc.status || 'posted') === 'reversed') return 'reversed';
  return doc.purchase_invoice_id ? 'costed' : 'awaiting_costing';
}

function loadQtyDoc(db, id) {
  const doc = getWarehouseDoc(db, id);
  if (!doc || doc.type !== 'receipt' || Number(doc.qty_only) !== 1) {
    throw qrErr(404, 'رسید مقداری یافت نشد', 'E_QTY_RECEIPT_NOT_FOUND');
  }
  return doc;
}

function supplierName(db, supplierId) {
  if (!supplierId) return '';
  const s = db.prepare('SELECT name FROM suppliers WHERE id=?').get(supplierId);
  return (s && s.name) || '';
}

function purchaseNum(db, purchaseId) {
  if (!purchaseId) return null;
  const p = db.prepare('SELECT num FROM purchase_invoices WHERE id=?').get(purchaseId);
  return (p && p.num) || null;
}

/** Response shape. withCost=false → whitelist with no monetary key at all. */
function presentQtyReceipt(db, doc, { withCost = false } = {}) {
  const base = {
    id: doc.id,
    num: doc.num,
    date: doc.date,
    status: doc.status || 'posted',
    costing_status: costingStatus(doc),
    qty_only: 1,
    warehouse_id: doc.to_warehouse_id,
    warehouse_name: doc.to_warehouse_name || '',
    supplier_id: doc.supplier_id || null,
    supplier_name: supplierName(db, doc.supplier_id),
    note: doc.note || '',
    line_count: doc.line_count,
    qty_total: doc.qty_total,
    created_by: doc.created_by,
    recorder: doc.recorder || '',
    created_at: doc.created_at,
    purchase_invoice_id: doc.purchase_invoice_id || null,
    purchase_invoice_num: purchaseNum(db, doc.purchase_invoice_id),
    lines: (doc.lines || []).filter((m) => String(m.status || 'posted') !== 'reversed' || doc.status === 'reversed')
      .map((m) => {
        const line = {
          move_id: m.id,
          line_no: m.line_no,
          product_id: m.product_id,
          product_name: m.product_name || '',
          product_code: m.product_code || '',
          unit: m.product_unit || '',
          variant_id: m.variant_id || null,
          color_name: m.color_name || '',
          size_name: m.size_name || '',
          variant_sku: m.variant_sku || '',
          product_label: m.product_label || m.product_name || '',
          qty: m.qty,
        };
        if (withCost) {
          line.unit_cost_rial = m.unit_cost_rial;
          line.amount_rial = m.amount_rial;
        }
        return line;
      }),
  };
  if (withCost) {
    base.cost_pending = Number(doc.cost_pending) === 1 ? 1 : 0;
    base.amount_rial_total = doc.amount_rial_total;
    base.je_id = doc.je_id || null;
  }
  return base;
}

function listQtyReceipts(db, { status = '', limit = 200, includeReversed = false } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);
  const where = ["d.type='receipt'", 'COALESCE(d.qty_only,0)=1'];
  if (!includeReversed) where.push("COALESCE(d.status,'posted')<>'reversed'");
  if (status === 'awaiting_costing') where.push('d.purchase_invoice_id IS NULL');
  if (status === 'costed') where.push('d.purchase_invoice_id IS NOT NULL');
  return db.prepare(`
    SELECT d.id FROM warehouse_docs d
    WHERE ${where.join(' AND ')}
    ORDER BY d.date DESC, d.id DESC
    LIMIT ?
  `).all(lim).map((r) => getWarehouseDoc(db, r.id));
}

/**
 * Cashier receipt. Any client-sent cost/price is ignored (unit cost = current average or 0).
 * body: { warehouse_id, supplier_id, date?, note?, lines:[{product_id, variant_id?, qty}] }
 */
function createQtyReceipt(db, body, user) {
  const b = body || {};
  const warehouseId = parseInt(b.warehouse_id || b.to_warehouse_id, 10);
  if (!warehouseId) throw qrErr(400, 'انبار مقصد الزامی است', 'E_QTY_RECEIPT_WAREHOUSE');
  const supplierId = parseInt(b.supplier_id, 10);
  if (!supplierId) throw qrErr(400, 'تأمین‌کننده الزامی است', 'E_QTY_RECEIPT_SUPPLIER');
  if (!db.prepare('SELECT id FROM suppliers WHERE id=?').get(supplierId)) {
    throw qrErr(404, 'تأمین‌کننده یافت نشد', 'E_QTY_RECEIPT_SUPPLIER');
  }
  const rawLines = Array.isArray(b.lines) ? b.lines : [];
  if (!rawLines.length) throw qrErr(400, 'حداقل یک ردیف کالا لازم است', 'E_QTY_RECEIPT_LINES');
  const lines = rawLines.map((l) => ({
    product_id: l && l.product_id,
    variant_id: l && l.variant_id,
    qty: l && l.qty,
  }));
  return db.transaction(() => {
    const created = createWarehouseDoc(db, {
      type: 'receipt',
      receipt_class: 'grni',
      warehouse_id: warehouseId,
      supplier_id: supplierId,
      date: b.date,
      note: b.note || '',
      lines,
    }, user, { outerTx: true });
    const costPending = provisionalCostPending(db, created.id);
    db.prepare('UPDATE warehouse_docs SET qty_only=1, cost_pending=? WHERE id=?')
      .run(costPending, created.id);
    const doc = getWarehouseDoc(db, created.id);
    audit(user && user.id, 'create', AUDIT_ENTITY, doc.id,
      `ثبت رسید مقداری ${doc.num}: تأمین‌کننده #${supplierId} (${supplierName(db, supplierId)})، انبار #${warehouseId}، `
      + `${doc.line_count} ردیف / ${doc.qty_total} عدد، بهای موقت ${Math.round(Number(doc.amount_rial_total) || 0)} ریال، `
      + `GRNI JE #${doc.je_id || '-'}، cost_pending=${costPending}`);
    return { ...created, doc };
  })();
}

/** Void before costing (R13 full reverse; the costed case is refused by voidWarehouseDocInTx). */
function voidQtyReceipt(db, id, user, { reason } = {}) {
  return db.transaction(() => {
    const doc = loadQtyDoc(db, id);
    if (doc.purchase_invoice_id) {
      throw qrErr(400, `رسید ${doc.num} ریالی شده است — ابتدا فاکتور خرید ${purchaseNum(db, doc.purchase_invoice_id) || ''} را ابطال کنید`, 'E_WH_GRNI_LINKED');
    }
    const why = reason || `ابطال رسید مقداری ${doc.num}`;
    const out = voidWarehouseDocInTx(db, doc.id, user, { reason: why });
    db.prepare('UPDATE warehouse_docs SET cost_pending=0 WHERE id=?').run(doc.id);
    audit(user && user.id, 'reverse', AUDIT_ENTITY, doc.id,
      `ابطال رسید مقداری ${doc.num}: ${out.count} ردیف / ${doc.qty_total} عدد از کاردکس برگشت، `
      + `بهای موقت ${Math.round(Number(doc.amount_rial_total) || 0)} ریال، GRNI JE #${doc.je_id || '-'} معکوس — ${why}`);
    return out;
  })();
}

/**
 * Costing (ریالی‌سازی). body: { rows:[{move_id, price}], date?, disc?, disc_amt?, vat_exempt?, vat_rate?, note? }
 * Every active line needs an explicit unit price (rial, ≥0). Returns the purchase invoice.
 */
function costQtyReceipt(db, id, body, user) {
  const doc = loadQtyDoc(db, id);
  if (doc.status === 'reversed') throw qrErr(400, 'رسید ابطال شده است', 'E_QTY_RECEIPT_REVERSED');
  if (doc.purchase_invoice_id) throw qrErr(409, `رسید ${doc.num} قبلاً ریالی شده است`, 'E_WH_GRNI_BILLED');
  const b = body || {};
  const byMove = new Map();
  for (const r of (Array.isArray(b.rows) ? b.rows : [])) {
    const mid = parseInt(r && (r.move_id || r.warehouse_move_id), 10);
    if (mid) byMove.set(mid, r);
  }
  const active = (doc.lines || []).filter((m) => String(m.status || 'posted') !== 'reversed');
  const rows = active.map((m) => {
    const r = byMove.get(Number(m.id));
    const raw = r ? (r.price != null ? r.price : r.unit_price_rial) : null;
    const price = Number(raw);
    if (raw == null || raw === '' || !Number.isFinite(price) || price < 0) {
      throw qrErr(400, `فی خرید ردیف «${m.product_label || m.product_name || m.product_id}» را وارد کنید`, 'E_QTY_RECEIPT_PRICE');
    }
    return { move_id: m.id, price: Math.round(price) };
  });
  return db.transaction(() => {
    const inv = invoiceWarehouseGrni(db, {
      warehouse_doc_ids: [doc.id],
      supplier_id: doc.supplier_id,
      date: b.date,
      rows,
      disc: b.disc,
      disc_amt: b.disc_amt,
      vat_exempt: b.vat_exempt,
      vat_rate: b.vat_rate,
      note: b.note || `ریالی‌سازی رسید مقداری ${doc.num}`,
      cost_center_id: b.cost_center_id,
    }, user);
    db.prepare('UPDATE warehouse_docs SET cost_pending=0 WHERE id=?').run(doc.id);
    const reval = db.prepare(`
      SELECT COALESCE(SUM(amount_rial),0) AS s FROM inventory_ledger
      WHERE source_type='warehouse_grni_reval' AND source_id=? AND COALESCE(status,'posted')='posted'
    `).get(inv.id).s;
    const je = db.prepare(`
      SELECT id FROM journal_entries WHERE ref_type='purchase' AND ref_id=? AND COALESCE(deleted_at,0)=0 ORDER BY id LIMIT 1
    `).get(inv.id);
    audit(user && user.id, 'cost', AUDIT_ENTITY, doc.id,
      `ریالی‌سازی رسید مقداری ${doc.num} → فاکتور خرید ${inv.num} (#${inv.id})، JE #${je ? je.id : '-'}: `
      + `مبلغ ${Math.round(Number(inv.final) || 0)} ریال (VAT ${Math.round(Number(inv.vat_amount) || 0)})، `
      + `تسویهٔ GRNI ${Math.round(Number(doc.amount_rial_total) || 0)}، تعدیل ارزش کاردکس ${Math.round(Number(reval) || 0)} ریال`);
    return inv;
  })();
}

module.exports = {
  createQtyReceipt,
  listQtyReceipts,
  loadQtyDoc,
  presentQtyReceipt,
  costQtyReceipt,
  voidQtyReceipt,
  costingStatus,
};
