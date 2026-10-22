'use strict';
/**
 * In-place amend of posted purchase invoices (mirror of amend-invoice for AP).
 * Same purchase id/num; rewrite purchase JE; reverse+repost stock when stock_added=1;
 * rewrite invoice-time supplier_payments. Cancel/void still uses DELETE /purchases/:id.
 */
const { acct } = require('./coa-map');
const { rewriteJournalEntry } = require('./ledger');
const { rialToLedger } = require('./money');
const {
  postPurchaseStockMovements, perpetualDocsEnabled,
  allocateFreight, applyFreightToDocTotals, freightChargedToCounterparty,
} = require('./sales-document');
const {
  resolvePurchasePayments, applyPurchasePaySplits, persistPurchasePayPlan,
  headerPayTypeFromSplits, recomputePurchaseInvoiceSettledBalances,
} = require('./purchase-payments');
const { resolveCashPaid, assertCashBoxRequired } = require('./cash-on-document');
const { inventoryAccountForWarehouse, inventoryAmountLinesByWarehouse } = require('./inventory/ledger');
const { postToLedger } = require('./ledger');
const { todayJalali } = require('../jalali');
const { resolveCashAccount } = require('../db');

function httpErr(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function payableAcct(db, supplierId) {
  const s = supplierId ? db.prepare('SELECT coa_code FROM suppliers WHERE id=?').get(supplierId) : null;
  if (s && s.coa_code) {
    const a = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(s.coa_code);
    if (a) return a;
  }
  return acct(db, 'coa_payable');
}

function parseRows(raw) {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw || '[]'); } catch (_) { return []; }
}

function buildInventoryValuationRows(rows, documentDiscountRial, includeFreight) {
  const discount = Math.round(Number(documentDiscountRial) || 0);
  const total = rows.reduce((sum, row) => sum + Math.round(Number(row.sum) || 0), 0);
  let allocatedDiscount = 0;
  return rows.map((row, index) => {
    const lineValue = Math.round(Number(row.sum) || 0);
    const discountShare = index === rows.length - 1
      ? discount - allocatedDiscount
      : (total > 0 ? Math.round(discount * lineValue / total) : 0);
    allocatedDiscount += discountShare;
    const amountRial = lineValue - discountShare
      + (includeFreight ? Math.round(Number(row.allocated_freight) || 0) : 0);
    const qty = Number(row.qty) || 0;
    return {
      ...row,
      price_rial: qty > 0 ? Math.round(amountRial / qty) : Math.round(Number(row.price) || 0),
      amount_rial: amountRial,
    };
  });
}

function lineSig(r) {
  return [
    Number(r.product_id) || 0,
    Number(r.variant_id) || 0,
    Number(r.batch_id) || 0,
    Number(r.warehouse_id) || 0,
    Math.round((Number(r.qty) || 0) * 1000) / 1000,
  ].join('|');
}

function assertGrniQtyLocked(oldRows, newRows) {
  const a = (oldRows || []).map(lineSig).sort();
  const b = (newRows || []).map(lineSig).sort();
  if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
    throw httpErr(
      409,
      'فاکتور از رسید GRNI است — تغییر تعداد/کالا/انبار مجاز نیست؛ فقط فی، تخفیف، کرایه و تاریخ را عوض کنید یا فاکتور را ابطال کنید',
      'E_GRNI_QTY_LOCKED'
    );
  }
}

function isInvoiceTimePay(p) {
  return /هنگام فاکتور خرید/.test(String((p && p.note) || ''));
}

function listLivePays(db, purchaseId) {
  return db.prepare(`
    SELECT * FROM supplier_payments
    WHERE purchase_invoice_id=? AND COALESCE(status,'posted')<>'reversed'
    ORDER BY id ASC
  `).all(purchaseId);
}

function reverseOutboundChequesForPayment(db, pay, userId) {
  if (!pay || pay.pay_type !== 'cheque') return;
  try {
    const m = String(pay.note || '').match(/(\d{16})/);
    const sayadi = m ? m[1] : null;
    const rows = sayadi
      ? db.prepare(`
          SELECT id FROM cheque_records
          WHERE direction='out' AND sayadi=? AND COALESCE(record_status,'posted')<>'reversed'
        `).all(sayadi)
      : db.prepare(`
          SELECT id FROM cheque_records
          WHERE direction='out' AND party_id=? AND ABS(amount-?)<1
            AND COALESCE(record_status,'posted')<>'reversed'
          ORDER BY id DESC LIMIT 3
        `).all(pay.supplier_id, Math.round(Number(pay.amount) || 0));
    for (const r of rows) {
      db.prepare(`
        UPDATE cheque_records
        SET record_status='reversed', lifecycle_status='void',
            voided_at=strftime('%s','now'), voided_by=?
        WHERE id=?
      `).run(userId || null, r.id);
    }
  } catch (_) { /* optional columns */ }
}

function reverseSupplierPaymentInTx(db, pay, userId, date, reason) {
  if (!pay || pay.status === 'reversed') return;
  const { retireSupplierLedgerByRef } = require('./party-ledger-retire');
  retireSupplierLedgerByRef(db, {
    refTypes: ['supplier_payment'],
    refId: pay.id,
    supplierId: pay.supplier_id,
  });
  let cash = resolveCashAccount(db, pay.pay_type, pay.bank_id, pay.cash_box_id);
  const overrideCode = String(pay.account_code || '').trim();
  if (overrideCode) {
    const acctRow = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(overrideCode);
    if (acctRow) cash = { code: acctRow.code, name: acctRow.name };
  }
  const payable = payableAcct(db, pay.supplier_id);
  const { outboundPaymentReversalLines } = require('./payment-bank-fee');
  const { lines } = outboundPaymentReversalLines(db, {
    amount: pay.amount, feeRial: pay.fee_rial || 0, dest: payable, cash,
    feeCostCenterId: pay.fee_cost_center_id || null,
  });
  const when = date || todayJalali();
  const reversalId = postToLedger(db, {
    sourceType: 'supplier_payment_reversal', sourceId: pay.id,
    date: when,
    description: reason || `ابطال پرداخت به تأمین‌کننده #${pay.id}`,
    createdBy: userId,
    lines,
  });
  try {
    db.prepare(`
      UPDATE journal_entries SET status='reversed'
      WHERE ref_type='supplier_payment' AND ref_id=? AND COALESCE(deleted_at,0)=0 AND id<>?
    `).run(pay.id, reversalId);
  } catch (_) { /* older DBs */ }
  db.prepare(`
    UPDATE supplier_payments
    SET status='reversed', reversal_journal_id=?, reversed_at=strftime('%s','now'), reversed_by=?
    WHERE id=?
  `).run(reversalId, userId, pay.id);
  reverseOutboundChequesForPayment(db, pay, userId);
}

function updatePurchaseSupplierLedger(db, {
  supplierId, date, invId, num, final, userId,
}) {
  const row = db.prepare(`
    SELECT id FROM supplier_ledger
    WHERE ref_type IN ('purchase','purchase_invoice') AND ref_id=? AND entry_type='purchase'
    LIMIT 1
  `).get(invId);
  const desc = `فاکتور خرید ${num}`;
  if (row) {
    db.prepare(`
      UPDATE supplier_ledger
      SET supplier_id=?, date=?, description=?, debit=0, credit=?, user_id=?
      WHERE id=?
    `).run(supplierId, date || '', desc, final, userId || null, row.id);
    try {
      require('./party-leaf-sync').afterPartyBookInsert(db, {
        kind: 'supplier', entityId: supplierId, date, entry_type: 'purchase',
        ref_type: 'purchase', ref_id: invId, description: desc, debit: 0, credit: final, user_id: userId,
      });
    } catch (_) { /* leaf sync optional */ }
  } else {
    db.prepare(`
      INSERT INTO supplier_ledger
        (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(supplierId, date || '', 'purchase', 'purchase', invId, desc, 0, final, userId || null);
    try {
      require('./party-leaf-sync').afterPartyBookInsert(db, {
        kind: 'supplier', entityId: supplierId, date, entry_type: 'purchase',
        ref_type: 'purchase', ref_id: invId, description: desc, debit: 0, credit: final, user_id: userId,
      });
    } catch (_) { /* optional */ }
  }
}

function buildDirectPurchaseJeLines(db, {
  supplierId, whId, priced, netBeforeVat, vatAmount, final,
}) {
  const vatRec = acct(db, 'coa_vat_receivable');
  const payable = payableAcct(db, supplierId);
  let invGroups = inventoryAmountLinesByWarehouse(db, priced.map((r) => ({
    warehouseId: r.warehouse_id || whId,
    amountRial: r.amount_rial,
  })));
  if (!invGroups.length) {
    const fallback = inventoryAccountForWarehouse(db, whId);
    invGroups = [{ code: fallback.code, name: fallback.name, amountRial: netBeforeVat }];
  } else {
    const sumInv = invGroups.reduce((s, g) => s + g.amountRial, 0);
    const drift = Math.round(netBeforeVat) - sumInv;
    if (drift !== 0) invGroups[invGroups.length - 1].amountRial += drift;
  }
  const jLines = invGroups.map((g) => ({
    code: g.code, name: g.name, debit: rialToLedger(g.amountRial), credit: 0,
  }));
  if (vatAmount > 0) {
    jLines.push({
      code: vatRec.code, name: vatRec.name,
      debit: rialToLedger(vatAmount), credit: 0, description: 'مالیات خرید',
    });
  }
  jLines.push({
    code: payable.code, name: payable.name, debit: 0, credit: rialToLedger(final),
  });
  return jLines;
}

function reverseGrniRevalsKeepLink(db, purchaseId, userId, reason) {
  const { reverseInventoryMovement } = require('./inventory/ledger');
  const { bumpOpenLayersValue } = require('./inventory/landed-cost');
  const { catalogCostFromAvgRial } = require('./inventory/product-unit-cost');
  const leds = db.prepare(`
    SELECT id, product_id, warehouse_id, amount_rial FROM inventory_ledger
    WHERE source_type='warehouse_grni_reval' AND source_id=? AND COALESCE(status,'posted')='posted'
  `).all(purchaseId);
  for (const led of leds) {
    const share = Math.round(Number(led.amount_rial) || 0);
    if (share) {
      // Header avg is reduced by value when the ledger row is reversed below.
      bumpOpenLayersValue(db, {
        productId: led.product_id,
        warehouseId: led.warehouse_id || null,
        amountRial: -share,
        sourceType: 'warehouse_grni_reval_void',
        sourceId: purchaseId,
      });
    }
    reverseInventoryMovement(db, led.id, {
      createdBy: userId,
      note: reason || `اصلاح تعدیل بهای GRNI فاکتور #${purchaseId}`,
    });
  }
  return leds.length;
}

function applyGrniValueVariance(db, {
  rows, provisionalTotal, delta, purchaseId, warehouseId, date, userId, jeId,
}) {
  if (!delta) return;
  const { postInventoryMovement } = require('./inventory/ledger');
  const { bumpOpenLayersValue } = require('./inventory/landed-cost');
  const { catalogCostFromAvgRial } = require('./inventory/product-unit-cost');
  const baseSum = provisionalTotal > 0
    ? provisionalTotal
    : rows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
  let left = delta;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let part;
    if (i === rows.length - 1) part = left;
    else if (provisionalTotal > 0) {
      part = Math.round(delta * ((Number(r.provisional_rial) || 0) / baseSum));
    } else {
      part = Math.round(delta * ((Number(r.qty) || 0) / baseSum));
    }
    left -= part;
    if (!part) continue;
    const wh = r.warehouse_id || warehouseId;
    postInventoryMovement(db, {
      eventType: 'adjustment',
      productId: r.product_id,
      warehouseId: wh,
      qtyIn: 0,
      qtyOut: 0,
      unitCostRial: Math.abs(part),
      amountRial: part,
      sourceType: 'warehouse_grni_reval',
      sourceId: purchaseId,
      date,
      note: `تعدیل بهای GRNI → فاکتور خرید #${purchaseId}`,
      createdBy: userId,
      updateAvg: false,
      skipStock: true,
      valueOnly: true,
    });
    // Header avg already moved by value inside postInventoryMovement (valueOnly row).
    bumpOpenLayersValue(db, {
      productId: r.product_id,
      warehouseId: wh || null,
      amountRial: part,
      sourceType: 'warehouse_grni_reval',
      sourceId: purchaseId,
    });
  }
  if (jeId) {
    db.prepare(`
      UPDATE inventory_ledger SET je_id=?
      WHERE source_type='warehouse_grni_reval' AND source_id=? AND COALESCE(status,'posted')='posted'
    `).run(jeId, purchaseId);
  }
}

function buildGrniJeLines(db, {
  supplierId, warehouseId, provisionalTotal, netBeforeVat, vatAmount, final, costCenterId, supplierName,
}) {
  const grni = acct(db, 'coa_grni');
  const ap = payableAcct(db, supplierId);
  const invAcct = inventoryAccountForWarehouse(db, warehouseId);
  const delta = netBeforeVat - provisionalTotal;
  const jeLines = [];
  if (provisionalTotal > 0) {
    jeLines.push({
      code: grni.code, name: grni.name,
      debit: rialToLedger(provisionalTotal), credit: 0,
      description: 'تسویه GRNI رسید انبار',
    });
  }
  if (delta > 0) {
    jeLines.push({
      code: invAcct.code, name: invAcct.name,
      debit: rialToLedger(delta), credit: 0,
      description: 'مابه‌التفاوت بهای فاکتور نسبت به رسید',
      cost_center_id: costCenterId,
    });
  } else if (delta < 0) {
    jeLines.push({
      code: invAcct.code, name: invAcct.name,
      debit: 0, credit: rialToLedger(-delta),
      description: 'مابه‌التفاوت بهای فاکتور نسبت به رسید',
      cost_center_id: costCenterId,
    });
  }
  if (vatAmount > 0) {
    const vatRec = acct(db, 'coa_vat_receivable');
    jeLines.push({
      code: vatRec.code, name: vatRec.name,
      debit: rialToLedger(vatAmount), credit: 0, description: 'VAT خرید',
    });
  }
  jeLines.push({
    code: ap.code, name: ap.name,
    debit: 0, credit: rialToLedger(final),
    description: `بدهی تأمین‌کننده ${supplierName || ''}`,
  });
  return { jeLines, delta, provisionalTotal };
}

const QTY_EPS = 1e-6;

function stockKeyOf(productId, warehouseId) {
  return `${Number(productId) || 0}|${Number(warehouseId) || 0}`;
}

function isFabricLine(db, r, whId) {
  try {
    return require('./inventory/fabric-rolls').isFabricPurchaseLine(db, r, whId);
  } catch (_) {
    return false;
  }
}

function fmtQtyFa(n) {
  const v = Math.round((Number(n) || 0) * 1000) / 1000;
  return v.toLocaleString('fa-IR');
}

function productName(db, productId, fallback) {
  const p = db.prepare('SELECT name FROM products WHERE id=?').get(productId);
  return (p && p.name) || fallback || `کالا #${productId}`;
}

function warehouseName(db, warehouseId) {
  if (!warehouseId) return 'انبار پیش‌فرض';
  const w = db.prepare('SELECT name FROM warehouses WHERE id=?').get(warehouseId);
  return (w && w.name) || `انبار #${warehouseId}`;
}

/** Posted receipt rows of this purchase, grouped by product×warehouse (signed qty + value). */
function aggregatePurchaseLedger(db, purchaseId) {
  const rows = db.prepare(`
    SELECT * FROM inventory_ledger
    WHERE source_type='purchase' AND source_id=? AND status='posted' AND COALESCE(reversed_of,0)=0
    ORDER BY id ASC
  `).all(purchaseId);
  const map = new Map();
  for (const l of rows) {
    const key = stockKeyOf(l.product_id, l.warehouse_id);
    if (!map.has(key)) {
      map.set(key, {
        key, productId: Number(l.product_id), warehouseId: l.warehouse_id || null,
        qty: 0, value: 0, rows: [], hasBatch: false,
      });
    }
    const g = map.get(key);
    const qIn = Number(l.qty_in) || 0;
    const qOut = Number(l.qty_out) || 0;
    const amt = Math.round(Number(l.amount_rial) || 0);
    g.qty += qIn - qOut;
    g.value += qOut > 0 && qIn === 0 ? -amt : amt;
    g.rows.push(l);
    if (l.batch_id) g.hasBatch = true;
  }
  return map;
}

function aggregatePricedRows(db, priced, whId) {
  const map = new Map();
  for (const r of priced || []) {
    if (!r || !r.product_id) continue;
    const wh = r.warehouse_id ? parseInt(r.warehouse_id, 10) : (whId || null);
    const key = stockKeyOf(r.product_id, wh);
    if (!map.has(key)) {
      map.set(key, {
        key, productId: Number(r.product_id), warehouseId: wh || null,
        qty: 0, value: 0, rows: [], fabric: false, name: r.name || '',
      });
    }
    const g = map.get(key);
    g.qty += Number(r.qty) || 0;
    g.value += Math.round(Number(r.amount_rial) || 0);
    g.rows.push(r);
    if (isFabricLine(db, r, wh)) g.fabric = true;
  }
  return map;
}

function fabricBatchesOf(db, purchaseId, productId, warehouseId) {
  return db.prepare(`
    SELECT * FROM inventory_batches
    WHERE source_type='purchase' AND source_id=? AND product_id=?
      AND COALESCE(warehouse_id,0)=COALESCE(?,0)
      AND COALESCE(kind,'generic')='fabric' AND COALESCE(status,'')<>'reversed'
  `).all(purchaseId, productId, warehouseId || null);
}

function fabricBatchConsumed(db, batch) {
  const received = Number(batch.qty_received) || 0;
  let onHand = Number(batch.qty_on_hand) || 0;
  try {
    const live = require('./inventory/fabric-rolls').liveBatchMeters(db, batch.id);
    if (live != null) onHand = Number(live) || 0;
  } catch (_) { /* older DBs */ }
  return received - onHand > QTY_EPS;
}

function throwConsumedShortages(shortages) {
  const msg = shortages.map((s) => (
    `کاهش «${s.name}» در «${s.whName}» ممکن نیست: از ${fmtQtyFa(s.oldQty)} واحد این خرید فقط `
    + `${fmtQtyFa(Math.max(0, s.available))} واحد در انبار مانده و بقیه مصرف/فروخته شده — `
    + `حداقل تعداد قابل ثبت ${fmtQtyFa(s.minQty)} است`
  )).join(' | ');
  const err = httpErr(409, msg, 'E_AMEND_PURCHASE_CONSUMED');
  err.shortages = shortages;
  throw err;
}

/**
 * Reductions only: units of this purchase that already left the warehouse cannot be un-received.
 * Unchanged qty or increases never need stock.
 */
function assertReductionsCovered(db, plans) {
  const { warehouseQty, allowNegative } = require('./inventory/ledger');
  const shortages = [];
  const productDelta = new Map();
  for (const p of plans) {
    productDelta.set(p.productId, (productDelta.get(p.productId) || 0) + p.dQ);
  }
  for (const p of plans) {
    if (p.dQ >= -QTY_EPS) continue;
    if (allowNegative(db, p.warehouseId)) continue;
    const whAvail = warehouseQty(db, p.productId, p.warehouseId);
    const prod = db.prepare('SELECT stock FROM products WHERE id=?').get(p.productId);
    const prodAvail = Number(prod && prod.stock) || 0;
    const whShort = whAvail + p.dQ < -QTY_EPS;
    const prodShort = prodAvail + (productDelta.get(p.productId) || 0) < -QTY_EPS;
    if (whShort || prodShort) {
      const available = whShort ? whAvail : prodAvail;
      shortages.push({
        product_id: p.productId,
        warehouse_id: p.warehouseId,
        name: productName(db, p.productId, p.name),
        whName: warehouseName(db, p.warehouseId),
        oldQty: p.oldQty,
        newQty: p.newQty,
        available,
        minQty: Math.max(0, p.oldQty - Math.max(0, available)),
      });
    }
  }
  if (shortages.length) throwConsumedShortages(shortages);
}

/**
 * Net-delta sync of an inventory_movements document (variant layer or legacy header).
 * Deltas use fresh doc_line numbers so void (reverseStockDocument) still reverses them.
 */
function syncMovementDoc(db, {
  docType, docId, desired, applyHeaderStock, userId, note,
}) {
  const { postStockMovement } = require('./inventory/movement');
  const current = db.prepare(`
    SELECT product_id, variant_id, warehouse_id, SUM(qty_delta) AS q
    FROM inventory_movements
    WHERE doc_id=? AND doc_type IN (?, ?)
    GROUP BY product_id, COALESCE(variant_id,0), COALESCE(warehouse_id,0)
  `).all(docId, docType, `${docType}_void`);
  const keyOf = (p, v, w) => `${Number(p) || 0}|${Number(v) || 0}|${Number(w) || 0}`;
  const merged = new Map();
  for (const c of current) {
    if (!applyHeaderStock && !c.variant_id) continue;
    merged.set(keyOf(c.product_id, c.variant_id, c.warehouse_id), {
      productId: c.product_id, variantId: c.variant_id || null, warehouseId: c.warehouse_id || null,
      cur: Number(c.q) || 0, want: 0,
    });
  }
  for (const d of desired) {
    const k = keyOf(d.productId, d.variantId, d.warehouseId);
    if (!merged.has(k)) {
      merged.set(k, {
        productId: d.productId, variantId: d.variantId || null, warehouseId: d.warehouseId || null,
        cur: 0, want: 0,
      });
    }
    merged.get(k).want += Number(d.qty) || 0;
  }
  let nextLine = Number(db.prepare(`
    SELECT COALESCE(MAX(doc_line),-1)+1 AS n FROM inventory_movements
    WHERE doc_id=? AND doc_type IN (?, ?)
  `).get(docId, docType, `${docType}_void`).n) || 0;
  for (const m of merged.values()) {
    const delta = m.want - m.cur;
    if (Math.abs(delta) <= QTY_EPS) continue;
    try {
      postStockMovement(db, {
        productId: m.productId,
        variantId: m.variantId,
        warehouseId: m.warehouseId,
        qtyDelta: delta,
        docType,
        docId,
        docLine: nextLine,
        userId,
        note,
        allowNegative: true,
        applyHeaderStock: !!applyHeaderStock,
        writeStockLog: !!applyHeaderStock,
      });
      nextLine += 1;
    } catch (e) {
      if (!applyHeaderStock && e && ['E_VARIANT_INACTIVE', 'E_VARIANT_NOT_FOUND'].includes(e.code)) continue;
      throw e;
    }
  }
}

function variantDesired(db, priced, whId) {
  const out = [];
  for (const r of priced || []) {
    if (!r || !r.product_id || !r.variant_id) continue;
    const wh = r.warehouse_id ? parseInt(r.warehouse_id, 10) : (whId || null);
    if (isFabricLine(db, r, wh)) continue;
    out.push({ productId: Number(r.product_id), variantId: Number(r.variant_id), warehouseId: wh, qty: Number(r.qty) || 0 });
  }
  return out;
}

/**
 * Perpetual amend = net delta vs the receipt already on the books.
 * Unchanged lines post nothing; qty up → extra receipt; qty down → issue (only if still on hand);
 * price change → value-only revaluation. Fabric rolls are re-created only when untouched.
 */
function replacePurchaseStockPerpetual(db, {
  row, priced, whId, userId, date, num, supplierId,
}) {
  const { postInventoryMovement, reverseInventoryMovement } = require('./inventory/ledger');
  const { bumpOpenLayersValue } = require('./inventory/landed-cost');
  const { catalogCostFromAvgRial } = require('./inventory/product-unit-cost');

  const oldAgg = aggregatePurchaseLedger(db, row.id);
  const newAgg = aggregatePricedRows(db, priced, whId);
  const keys = new Set([...oldAgg.keys(), ...newAgg.keys()]);

  const oldFabricKeys = new Set();
  for (const r of parseRows(row.rows)) {
    const wh = r.warehouse_id ? parseInt(r.warehouse_id, 10) : (row.warehouse_id || null);
    if (r.product_id && isFabricLine(db, r, wh)) oldFabricKeys.add(stockKeyOf(r.product_id, wh));
  }

  const plans = [];
  const fabricRebuild = [];
  for (const key of keys) {
    const o = oldAgg.get(key);
    const n = newAgg.get(key);
    const meta = n || o;
    const oldQty = o ? o.qty : 0;
    const newQty = n ? n.qty : 0;
    const plan = {
      key,
      productId: meta.productId,
      warehouseId: meta.warehouseId,
      name: (n && n.name) || '',
      oldQty,
      newQty,
      oldValue: o ? o.value : 0,
      newValue: n ? n.value : 0,
      dQ: newQty - oldQty,
      oldRows: o ? o.rows : [],
      newRows: n ? n.rows : [],
    };
    const fabric = (n && n.fabric) || (o && o.hasBatch) || oldFabricKeys.has(key);
    const oldLines = o ? o.rows.filter((l) => (Number(l.qty_in) || 0) > 0).length : 0;
    const sameShape = Math.abs(plan.dQ) <= QTY_EPS && oldLines === (n ? n.rows.length : 0);
    if (fabric && !sameShape) {
      const batches = fabricBatchesOf(db, row.id, plan.productId, plan.warehouseId);
      const used = batches.filter((b) => fabricBatchConsumed(db, b));
      if (used.length) {
        throw httpErr(
          409,
          `طاقه‌های «${productName(db, plan.productId, plan.name)}» از این خرید برش/مصرف شده‌اند `
          + `(${used.map((b) => b.batch_no || b.id).join('، ')}) — تغییر متراژ یا تعداد طاقه مجاز نیست؛ `
          + 'فقط فی، تخفیف، کرایه و تاریخ قابل اصلاح است',
          'E_AMEND_FABRIC_CONSUMED'
        );
      }
      plan.batches = batches;
      fabricRebuild.push(plan);
    } else {
      plan.fabricSame = fabric;
      plans.push(plan);
    }
  }

  assertReductionsCovered(db, plans);

  const touched = new Map();
  const touch = (pid) => {
    if (touched.has(pid)) return touched.get(pid);
    const p = db.prepare('SELECT stock, average_cost_rial FROM products WHERE id=?').get(pid);
    const t = {
      stock0: Number(p && p.stock) || 0,
      avg0: Math.round(Number(p && p.average_cost_rial) || 0),
      oldValue: 0,
      newValue: 0,
      changed: false,
    };
    touched.set(pid, t);
    return t;
  };

  for (const p of [...plans, ...fabricRebuild]) {
    const t = touch(p.productId);
    t.oldValue += p.oldValue;
    t.newValue += p.newValue;
  }

  for (const p of fabricRebuild) {
    touch(p.productId).changed = true;
    for (const l of p.oldRows) {
      reverseInventoryMovement(db, l.id, {
        createdBy: userId, date, note: `اصلاح فاکتور خرید ${num} — جایگزینی طاقه`,
      });
    }
    for (const b of p.batches) {
      db.prepare(`
        UPDATE inventory_batches SET status='reversed', qty_on_hand=0, reversed_at=strftime('%s','now')
        WHERE id=?
      `).run(b.id);
    }
    if (p.newRows.length) {
      postPurchaseStockMovements(db, {
        rows: p.newRows, warehouseId: p.warehouseId, sourceType: 'purchase', sourceId: row.id,
        userId, date, note: `خرید ${num}`, supplierId,
      });
    }
  }

  const ordered = [...plans].sort((a, b) => b.dQ - a.dQ);
  for (const p of ordered) {
    let booked = p.oldValue;
    if (p.dQ > QTY_EPS) {
      const unit = p.newQty > 0 ? Math.round(p.newValue / p.newQty) : 0;
      const mv = postInventoryMovement(db, {
        eventType: 'purchase',
        productId: p.productId,
        warehouseId: p.warehouseId,
        qtyIn: p.dQ,
        unitCostRial: unit,
        amountRial: Math.round(unit * p.dQ),
        sourceType: 'purchase',
        sourceId: row.id,
        date,
        note: `اصلاح فاکتور خرید ${num} — افزایش تعداد`,
        createdBy: userId,
        updateAvg: true,
      });
      booked += Math.round(Number(mv.amount_rial) || 0);
      touch(p.productId).changed = true;
    } else if (p.dQ < -QTY_EPS) {
      const unit = p.oldQty > 0 ? Math.round(p.oldValue / p.oldQty) : 0;
      const mv = postInventoryMovement(db, {
        eventType: 'purchase',
        productId: p.productId,
        warehouseId: p.warehouseId,
        qtyOut: -p.dQ,
        unitCostRial: unit,
        amountRial: Math.round(unit * -p.dQ),
        sourceType: 'purchase',
        sourceId: row.id,
        date,
        note: `اصلاح فاکتور خرید ${num} — کاهش تعداد`,
        createdBy: userId,
        updateAvg: false,
      });
      booked -= Math.round(Number(mv.amount_rial) || 0);
      touch(p.productId).changed = true;
    }
    const reval = Math.round(p.newValue - booked);
    if (reval !== 0) {
      postInventoryMovement(db, {
        eventType: 'adjustment',
        productId: p.productId,
        warehouseId: p.warehouseId,
        qtyIn: 0,
        qtyOut: 0,
        unitCostRial: Math.abs(reval),
        amountRial: reval,
        sourceType: 'purchase',
        sourceId: row.id,
        date,
        note: `اصلاح فاکتور خرید ${num} — تعدیل بها`,
        createdBy: userId,
        updateAvg: false,
        skipStock: true,
        valueOnly: true,
      });
      if (reval > 0) {
        bumpOpenLayersValue(db, {
          productId: p.productId,
          warehouseId: p.warehouseId || null,
          amountRial: reval,
          sourceType: 'purchase_amend_reval',
          sourceId: row.id,
        });
      }
      touch(p.productId).changed = true;
    }
    if (p.fabricSame && p.newQty > QTY_EPS) {
      try {
        db.prepare(`
          UPDATE inventory_batches SET unit_cost_rial=?
          WHERE source_type='purchase' AND source_id=? AND product_id=?
            AND COALESCE(kind,'generic')='fabric' AND COALESCE(status,'')<>'reversed'
        `).run(Math.round(p.newValue / p.newQty), row.id, p.productId);
      } catch (_) { /* optional columns */ }
    }
  }

  // Moving average as if this purchase had always carried the amended qty/value.
  // The rows above already move the header by value; any residual (rounding / fabric
  // rebuild) is posted as a value-only ledger row — never a raw avg overwrite.
  for (const [pid, t] of touched) {
    if (!t.changed) continue;
    const p = db.prepare('SELECT stock, average_cost_rial FROM products WHERE id=?').get(pid);
    const stock1 = Number(p && p.stock) || 0;
    if (stock1 <= QTY_EPS) continue;
    const target = Math.round(t.stock0 * t.avg0) - t.oldValue + t.newValue;
    const current = Math.round(stock1 * Math.round(Number(p.average_cost_rial) || 0));
    const residual = Math.max(0, target) - current;
    if (Math.abs(residual) >= Math.max(1, Math.round(stock1))) {
      require('./inventory/valuation').postValueAdjustment(db, {
        productId: pid,
        warehouseId: whId || null,
        deltaRial: residual,
        date,
        sourceType: 'purchase',
        sourceId: row.id,
        note: `اصلاح فاکتور خرید ${num} — هم‌ترازی میانگین`,
        createdBy: userId,
        eventType: 'adjustment',
      });
    }
  }

  syncMovementDoc(db, {
    docType: 'purchase_sku',
    docId: row.id,
    desired: variantDesired(db, priced, whId),
    applyHeaderStock: false,
    userId,
    note: `اصلاح فاکتور خرید ${num} / رنگ×سایز`,
  });
}

/** Legacy (non-perpetual) header stock lives in inventory_movements doc 'purchase'. */
function replacePurchaseStockLegacy(db, {
  row, priced, whId, userId, date, num, supplierId,
}) {
  const before = new Map();
  for (const m of db.prepare(`
    SELECT product_id, warehouse_id, SUM(qty_delta) AS q FROM inventory_movements
    WHERE doc_id=? AND doc_type IN ('purchase','purchase_void')
    GROUP BY product_id, COALESCE(warehouse_id,0)
  `).all(row.id)) {
    before.set(stockKeyOf(m.product_id, m.warehouse_id), Number(m.q) || 0);
  }
  const newAgg = aggregatePricedRows(db, priced, whId);
  const keys = new Set([...before.keys(), ...newAgg.keys()]);
  const plans = [];
  for (const key of keys) {
    const n = newAgg.get(key);
    const [pid, wh] = key.split('|').map(Number);
    const oldQty = before.get(key) || 0;
    const newQty = n ? n.qty : 0;
    plans.push({
      key, productId: pid, warehouseId: wh || null, name: (n && n.name) || '',
      oldQty, newQty, dQ: newQty - oldQty,
    });
  }
  assertReductionsCovered(db, plans);

  const desired = (priced || []).filter((r) => r && r.product_id).map((r) => ({
    productId: Number(r.product_id),
    variantId: r.variant_id ? Number(r.variant_id) : null,
    warehouseId: r.warehouse_id ? parseInt(r.warehouse_id, 10) : (whId || null),
    qty: Number(r.qty) || 0,
  }));
  syncMovementDoc(db, {
    docType: 'purchase',
    docId: row.id,
    desired,
    applyHeaderStock: true,
    userId,
    note: `اصلاح فاکتور خرید ${num}`,
  });

  for (const p of plans) {
    if (p.oldQty > QTY_EPS || p.newQty <= QTY_EPS) continue;
    const n = newAgg.get(p.key);
    if (!n || !n.fabric) continue;
    const fabric = require('./inventory/fabric-rolls');
    for (const r of n.rows) {
      fabric.attachFabricIdentityOnPurchase(db, {
        row: r, movement: null, supplierId,
        user: { id: userId }, date, warehouseId: p.warehouseId, sourceId: row.id,
      });
    }
  }
}

function replacePurchaseStock(db, opts) {
  if (!opts.row.stock_added) return;
  if (perpetualDocsEnabled(db)) replacePurchaseStockPerpetual(db, opts);
  else replacePurchaseStockLegacy(db, opts);
}

function rewriteInvoiceTimePays(db, {
  row, payPlan, supplierId, date, userId, num, body,
}) {
  const live = listLivePays(db, row.id);
  const invoiceTime = live.filter(isInvoiceTimePay);
  const later = live.filter((p) => !isInvoiceTimePay(p));
  const splits = (payPlan && payPlan.splits) || [];

  if (later.length) {
    if (Number(supplierId) !== Number(row.supplier_id)) {
      throw httpErr(409, 'این فاکتور پرداخت بعدی دارد؛ تغییر تأمین‌کننده مجاز نیست', 'E_AMEND_SUP_SETTLED');
    }
    if (splits.length !== invoiceTime.length) {
      throw httpErr(
        409,
        'این فاکتور پرداخت جدا از ثبت دارد؛ ابتدا آن پرداخت‌ها را ابطال کنید یا ساختار پرداخت هنگام فاکتور را عوض نکنید',
        'E_AMEND_SPLIT_COUNT'
      );
    }
  }

  for (const p of invoiceTime) {
    reverseSupplierPaymentInTx(db, p, userId, date, 'اصلاح فاکتور خرید — بازنویسی پرداخت هنگام فاکتور');
  }
  if (splits.length) {
    applyPurchasePaySplits(db, {
      purchaseId: row.id, supplierId, date, splits, userId, num,
      chequeHeader: body,
    });
  } else {
    recomputePurchaseInvoiceSettledBalances(db, row.id);
  }
}

/**
 * Amend a posted purchase invoice in place. Caller must run inside db.transaction.
 */
function amendPostedPurchaseInPlace(db, {
  row, built, totals, freightAdj, body, whId, ccId, payPlan,
  freightRial, freight_type, allocMethod, storedPayType, userId,
}) {
  if (!row) throw httpErr(404, 'یافت نشد');
  if (row.status === 'reversed' || (row.deleted_at && Number(row.deleted_at) !== 0)) {
    throw httpErr(400, 'این فاکتور خرید ابطال شده و قابل ویرایش نیست', 'E_PURCHASE_DEAD');
  }

  const activeReturns = db.prepare(
    "SELECT COUNT(*) AS c FROM purchase_returns WHERE purchase_invoice_id=? AND COALESCE(status,'posted')<>'reversed'"
  ).get(row.id).c;
  if (activeReturns > 0) {
    throw httpErr(400, `این فاکتور ${activeReturns} برگشت از خرید فعال دارد — ابتدا برگشت را ابطال کنید`);
  }

  const b = body || {};
  const supplierId = b.supplier_id != null && b.supplier_id !== ''
    ? parseInt(b.supplier_id, 10)
    : row.supplier_id;
  if (!supplierId) throw httpErr(400, 'تأمین‌کننده الزامی است');
  const entryDate = b.date || row.date || todayJalali();
  const { subtotal, discAmt, vatAmount, vatRate } = totals;
  const { final, netBeforeVat } = freightAdj;
  const discPct = parseFloat(b.disc != null ? b.disc : row.disc) || 0;
  const vatFlag = b.vat_exempt != null ? (b.vat_exempt ? 1 : 0) : (Number(row.vat_exempt) ? 1 : 0);
  const headerWh = whId != null ? whId : (row.warehouse_id || null);
  if (headerWh) {
    for (const r of built.rows) {
      if (!r.warehouse_id) r.warehouse_id = headerWh;
    }
  }

  const isGrni = !Number(row.stock_added)
    || !!db.prepare('SELECT 1 AS ok FROM warehouse_docs WHERE purchase_invoice_id=? LIMIT 1').get(row.id);

  if (isGrni) {
    assertGrniQtyLocked(parseRows(row.rows), built.rows);
  }

  const includeFreight = freightChargedToCounterparty(freight_type);
  const priced = buildInventoryValuationRows(built.rows, discAmt, includeFreight);

  if (!isGrni) {
    replacePurchaseStock(db, {
      row, priced, whId: headerWh, userId, date: entryDate, num: row.num, supplierId,
    });
  }

  let jeId;
  if (isGrni) {
    const docs = db.prepare(`
      SELECT d.*, COALESCE(d.amount_rial_total,0) AS amount_rial_total
      FROM warehouse_docs d WHERE d.purchase_invoice_id=?
    `).all(row.id);
    let provisionalTotal = 0;
    for (const d of docs) {
      const lines = db.prepare(`
        SELECT COALESCE(SUM(amount_rial),0) s FROM warehouse_moves
        WHERE doc_id=? AND COALESCE(status,'posted')='posted'
      `).get(d.id);
      provisionalTotal += Math.round(Number(d.amount_rial_total) || Number(lines && lines.s) || 0);
    }
    if (!provisionalTotal) {
      provisionalTotal = built.rows.reduce((s, r) => s + Math.round(Number(r.provisional_rial) || 0), 0);
    }
    reverseGrniRevalsKeepLink(db, row.id, userId, `اصلاح فاکتور خرید ${row.num}`);
    const sup = db.prepare('SELECT name FROM suppliers WHERE id=?').get(supplierId);
    const { jeLines, delta } = buildGrniJeLines(db, {
      supplierId,
      warehouseId: headerWh || row.warehouse_id,
      provisionalTotal,
      netBeforeVat,
      vatAmount,
      final,
      costCenterId: ccId,
      supplierName: (sup && sup.name) || '',
    });
    jeId = rewriteJournalEntry(db, {
      sourceType: 'purchase', sourceId: row.id,
      date: entryDate,
      description: `فاکتور خرید از رسید انبار GRNI ${row.num}`,
      createdBy: userId,
      costCenterId: ccId || null,
      lines: jeLines,
    });
    if (!jeId) throw httpErr(409, 'سند خرید این فاکتور پیدا نشد', 'E_AMEND_PURCHASE_JE');
    applyGrniValueVariance(db, {
      rows: built.rows,
      provisionalTotal,
      delta,
      purchaseId: row.id,
      warehouseId: headerWh || row.warehouse_id,
      date: entryDate,
      userId,
      jeId,
    });
  } else {
    const jLines = buildDirectPurchaseJeLines(db, {
      supplierId, whId: headerWh, priced, netBeforeVat, vatAmount, final,
    });
    jeId = rewriteJournalEntry(db, {
      sourceType: 'purchase', sourceId: row.id,
      date: entryDate,
      description: `فاکتور خرید ${row.num}${freightRial ? ' (با کرایه حمل)' : ''}`,
      createdBy: userId,
      costCenterId: ccId || null,
      lines: jLines,
    });
    if (!jeId) throw httpErr(409, 'سند خرید این فاکتور پیدا نشد', 'E_AMEND_PURCHASE_JE');
  }

  updatePurchaseSupplierLedger(db, {
    supplierId, date: entryDate, invId: row.id, num: row.num, final, userId,
  });

  persistPurchasePayPlan(db, row.id, payPlan, b);
  if (!isGrni) {
    rewriteInvoiceTimePays(db, {
      row, payPlan, supplierId, date: entryDate, userId, num: row.num, body: b,
    });
  } else if ((payPlan.splits || []).length) {
    throw httpErr(409, 'فاکتور GRNI فقط نسیه است؛ پرداخت هنگام فاکتور را جدا ثبت کنید', 'E_GRNI_PAY');
  }

  const payAmountRial = (payPlan.splits || []).length
    ? payPlan.splits.reduce((a, s) => a + s.amount, 0)
    : 0;
  const chqDur = storedPayType === 'cheque' ? String(b.cheque_duration != null ? b.cheque_duration : (row.cheque_duration || '')) : '';
  const chqDue = storedPayType === 'cheque' ? String(b.cheque_due_date != null ? b.cheque_due_date : (row.cheque_due_date || '')) : '';
  const chqInfo = storedPayType === 'cheque' ? String(b.cheque_info != null ? b.cheque_info : (row.cheque_info || '')) : '';

  db.prepare(`
    UPDATE purchase_invoices SET
      supplier_id=?, date=?, note=?, rows=?, subtotal=?, disc=?, disc_amt=?, final=?,
      vat_amount=?, vat_rate=?, pay_type=?, cheque_duration=?, cheque_due_date=?, cheque_info=?,
      bank_id=?, check_category_id=?, cash_box_id=?, warehouse_id=?,
      freight_amount=?, freight_type=?, freight_alloc_method=?, vat_exempt=?, cost_center_id=?,
      pay_amount_rial=?, stock_added=?
    WHERE id=?
  `).run(
    supplierId, entryDate, b.note != null ? b.note : (row.note || ''),
    JSON.stringify(built.rows), subtotal, discPct, discAmt, final,
    vatAmount, vatRate, storedPayType || row.pay_type || 'credit',
    chqDur, chqDue, chqInfo,
    b.bank_id != null && b.bank_id !== '' ? b.bank_id : (row.bank_id || null),
    b.check_category_id != null && b.check_category_id !== '' ? b.check_category_id : (row.check_category_id || null),
    b.cash_box_id != null && b.cash_box_id !== '' ? b.cash_box_id : (row.cash_box_id || null),
    headerWh, freightRial, freight_type || '',
    allocMethod, vatFlag, ccId,
    payAmountRial,
    isGrni ? 0 : 1,
    row.id
  );

  return { id: row.id, journal_id: jeId, amended: true, grni: !!isGrni };
}

module.exports = {
  amendPostedPurchaseInPlace,
  buildInventoryValuationRows,
  isInvoiceTimePay,
  listLivePays,
  reverseSupplierPaymentInTx,
  httpErr,
  allocateFreight,
  applyFreightToDocTotals,
  resolvePurchasePayments,
  headerPayTypeFromSplits,
  resolveCashPaid,
  assertCashBoxRequired,
};
