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
  postPurchaseStockMovements, reverseStockBySource, perpetualDocsEnabled,
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
      const prod = db.prepare('SELECT stock, average_cost_rial FROM products WHERE id=?').get(led.product_id);
      if (prod) {
        const stock = Number(prod.stock) || 0;
        if (stock > 0) {
          const prevAvg = Math.round(Number(prod.average_cost_rial) || 0);
          const newAvg = Math.max(0, Math.round((stock * prevAvg - share) / stock));
          db.prepare('UPDATE products SET average_cost_rial=?, cost=? WHERE id=?')
            .run(newAvg, catalogCostFromAvgRial(newAvg), led.product_id);
        }
      }
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
    const prod = db.prepare('SELECT stock, average_cost_rial FROM products WHERE id=?').get(r.product_id);
    if (prod) {
      const stock = Number(prod.stock) || 0;
      if (stock > 0) {
        const prevAvg = Math.round(Number(prod.average_cost_rial) || 0);
        const newAvg = Math.max(0, Math.round((stock * prevAvg + part) / stock));
        db.prepare('UPDATE products SET average_cost_rial=?, cost=? WHERE id=?')
          .run(newAvg, catalogCostFromAvgRial(newAvg), r.product_id);
      }
    }
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

function replacePurchaseStock(db, {
  row, priced, whId, userId, date, num, supplierId,
}) {
  if (!row.stock_added) return;
  if (perpetualDocsEnabled(db)) {
    reverseStockBySource(db, 'purchase', row.id, {
      createdBy: userId, date, note: `اصلاح فاکتور خرید ${num} — بازگشت موجودی`,
    });
    try {
      require('./inventory/movement').reverseStockDocument(db, {
        docType: 'purchase_sku',
        docId: row.id,
        userId,
        note: `اصلاح فاکتور خرید ${num} — بازگشت رنگ×سایز`,
        applyHeaderStock: false,
      });
    } catch (_) { /* no sku layer */ }
    postPurchaseStockMovements(db, {
      rows: priced, warehouseId: whId, sourceType: 'purchase', sourceId: row.id,
      userId, date, note: `خرید ${num}`, supplierId,
    });
  } else {
    const { reverseStockDocument, postStockMovement } = require('./inventory/movement');
    reverseStockDocument(db, {
      docType: 'purchase', docId: row.id, userId,
      note: `اصلاح فاکتور خرید ${num} — بازگشت موجودی`,
    });
    let lineIdx = 0;
    for (const r of priced) {
      const rowWh = r.warehouse_id || whId;
      postStockMovement(db, {
        productId: r.product_id,
        variantId: r.variant_id || null,
        warehouseId: rowWh || null,
        qtyDelta: Number(r.qty) || 0,
        docType: 'purchase',
        docId: row.id,
        docLine: lineIdx,
        userId,
        note: `افزودن موجودی از اصلاح فاکتور خرید ${num}`,
        allowNegative: true,
      });
      lineIdx += 1;
      try {
        const fabric = require('./inventory/fabric-rolls');
        if (fabric.isFabricPurchaseLine(db, r, rowWh)) {
          fabric.attachFabricIdentityOnPurchase(db, {
            row: r, movement: null, supplierId,
            user: { id: userId }, date, warehouseId: rowWh, sourceId: row.id,
          });
        }
      } catch (e) {
        if (e && e.code && String(e.code).startsWith('E_FABRIC')) throw e;
      }
    }
  }
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
