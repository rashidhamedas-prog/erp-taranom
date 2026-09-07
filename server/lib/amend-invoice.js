'use strict';
/**
 * In-place amend of posted normal invoices (user override of R13 for normal+proforma).
 * Same invoice id, same JE id, no reversal JE, no new sale JE.
 * Official/final stays locked. Cancel/void still uses voidInvoiceFully.
 */

const { acct } = require('./coa-map');
const { rewriteJournalEntry } = require('./ledger');
const {
  salesJournalLines, updateInvoiceCustomerLedger, receivableAcct,
} = require('./customer-books');
const {
  isFirmSale, invoiceTypeLabel, isFabricRollLine, perpetualDocsEnabled,
  applyHeaderWarehouseToLines, requireFirmHeaderWarehouse, assertWarehouseLines,
} = require('./sales-document');
const { applyStockDelta, postInventoryMovement } = require('./inventory/ledger');
const { persistInvoicePayPlan } = require('./invoice-payments');
const { rialToLedger } = require('./money');
const { resolveCashAccount } = require('../db');

function defaultVatExempt(type) {
  const t = String(type || '');
  return (t === 'normal' || t === 'proforma') ? 1 : 0;
}

function resolveVatExemptFlag(type, vatExempt, fallback) {
  if (vatExempt === undefined || vatExempt === null) {
    if (fallback !== undefined && fallback !== null) return Number(fallback) ? 1 : 0;
    return defaultVatExempt(type);
  }
  return Number(vatExempt) ? 1 : 0;
}

function httpErr(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function parseRows(raw) {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw || '[]'); } catch (_) { return []; }
}

function stockable(r) {
  return !!(r && r.row_type !== 'income' && r.item_kind !== 'service' && r.product_id);
}

function resolveLineWh(db, r, headerWh) {
  if (r && r.warehouse_id) return parseInt(r.warehouse_id, 10) || 0;
  if (headerWh) return parseInt(headerWh, 10) || 0;
  const prod = r && r.product_id
    ? db.prepare('SELECT warehouse_id FROM products WHERE id=?').get(r.product_id)
    : null;
  return prod && prod.warehouse_id ? Number(prod.warehouse_id) : 0;
}

function stockKey(db, r, headerWh) {
  const pid = Number(r.product_id) || 0;
  const wh = resolveLineWh(db, r, headerWh);
  const batch = Number(r.batch_id) || 0;
  const variant = Number(r.variant_id) || 0;
  return `${pid}|${wh}|${batch}|${variant}`;
}

function aggregateStock(db, rows, headerWh) {
  const map = new Map();
  for (const r of (rows || []).filter(stockable)) {
    const key = stockKey(db, r, headerWh);
    const prev = map.get(key);
    const qty = Number(r.qty) || 0;
    if (prev) {
      prev.qty += qty;
    } else {
      map.set(key, {
        qty,
        productId: Number(r.product_id),
        warehouseId: resolveLineWh(db, r, headerWh) || null,
        batchId: r.batch_id ? parseInt(r.batch_id, 10) : null,
        variantId: r.variant_id ? parseInt(r.variant_id, 10) : null,
        isFabric: isFabricRollLine(r),
        row: r,
      });
    }
  }
  return map;
}

function movementMatches(mv, meta) {
  if (Number(mv.product_id) !== Number(meta.productId)) return false;
  if (Number(mv.warehouse_id || 0) !== Number(meta.warehouseId || 0)) return false;
  if (Number(mv.batch_id || 0) !== Number(meta.batchId || 0)) return false;
  if (mv.variant_id != null && meta.variantId != null && Number(mv.variant_id) !== Number(meta.variantId)) {
    return false;
  }
  return true;
}

function takeMovements(unused, meta) {
  const taken = [];
  for (let i = unused.length - 1; i >= 0; i--) {
    if (movementMatches(unused[i], meta)) {
      taken.unshift(unused[i]);
      unused.splice(i, 1);
    }
  }
  return taken;
}

function adjustVariant(db, variantId, qtyDelta) {
  if (!variantId || !qtyDelta) return;
  try {
    require('./product-variants').adjustVariantStock(db, variantId, qtyDelta, 'delta');
  } catch (_) { /* variant may be gone */ }
}

function syncFabricAfterLedger(db, batchId) {
  if (!batchId) return;
  const { liveBatchMeters } = require('./inventory/fabric-rolls');
  const live = liveBatchMeters(db, batchId);
  if (live == null) return;
  const batch = db.prepare('SELECT status FROM inventory_batches WHERE id=?').get(batchId);
  if (!batch || batch.status === 'reversed') return;
  const next = Math.max(0, Number(live) || 0);
  const status = next <= 0 ? 'empty' : 'active';
  db.prepare('UPDATE inventory_batches SET qty_on_hand=?, status=? WHERE id=?').run(next, status, batchId);
}

function noteAmended(note) {
  const base = String(note || 'فروش').replace(/\s*—\s*اصلاح فاکتور\s*$/, '');
  return (base + ' — اصلاح فاکتور').slice(0, 240);
}

function postNewSaleLine(db, { meta, qty, sourceId, userId, date, num }) {
  const { availableBatchMeters, consumeFabricRollOnSale } = require('./inventory/fabric-rolls');
  if (meta.isFabric && meta.batchId) {
    const onHand = availableBatchMeters(db, meta.batchId);
    if (qty - onHand > 1e-9) {
      throw httpErr(409, `متر طاقه کافی نیست (مانده ${onHand}، نیاز ${qty})`, 'E_FABRIC_QTY');
    }
  }
  const mv = postInventoryMovement(db, {
    eventType: 'sale',
    productId: meta.productId,
    warehouseId: meta.warehouseId,
    qtyOut: qty,
    sourceType: 'invoice',
    sourceId,
    batchId: meta.batchId || null,
    date: date || '',
    note: `فروش ${num}`,
    createdBy: userId,
    updateAvg: false,
    allowNegative: !meta.isFabric,
  });
  if (meta.isFabric && meta.batchId) {
    consumeFabricRollOnSale(db, { batchId: meta.batchId, qty });
  }
  if (meta.variantId) adjustVariant(db, meta.variantId, -qty);
  return Math.round(Number(mv.amount_rial) || 0);
}

function updateMovementQty(db, mv, qtyOut) {
  const unit = Math.round(Number(mv.unit_cost_rial) || 0);
  const amt = Math.round(unit * qtyOut);
  db.prepare('UPDATE inventory_ledger SET qty_out=?, amount_rial=? WHERE id=?')
    .run(qtyOut, amt, mv.id);
  return amt;
}

function zeroMovement(db, mv) {
  db.prepare('UPDATE inventory_ledger SET qty_out=0, amount_rial=0, note=? WHERE id=?')
    .run(noteAmended(mv.note), mv.id);
}

function replaceSaleStockInPlace(db, { row, newRows, headerWh, userId, date, num }) {
  const perpetual = perpetualDocsEnabled(db);
  const oldAgg = aggregateStock(db, parseRows(row.rows), row.warehouse_id);
  const newAgg = aggregateStock(db, newRows, headerWh);
  const unused = perpetual
    ? db.prepare(`
        SELECT * FROM inventory_ledger
        WHERE source_type='invoice' AND source_id=?
          AND status='posted' AND COALESCE(reversed_of,0)=0
        ORDER BY id ASC
      `).all(row.id)
    : [];

  let cogsRial = 0;
  const used = new Map();
  const markWh = (whId) => {
    if (!whId) return;
    if (used.has(whId)) return;
    const wh = db.prepare('SELECT name FROM warehouses WHERE id=?').get(whId);
    used.set(whId, (wh && wh.name) || String(whId));
  };

  const keys = new Set([...oldAgg.keys(), ...newAgg.keys()]);
  for (const key of keys) {
    const old = oldAgg.get(key);
    const neu = newAgg.get(key);
    const meta = neu || old;
    const oldQty = old ? old.qty : 0;
    const newQty = neu ? neu.qty : 0;
    const delta = oldQty - newQty;
    markWh(meta.warehouseId);
    const mvs = takeMovements(unused, meta);

    if (meta.isFabric && meta.batchId && delta < -1e-9) {
      const { availableBatchMeters } = require('./inventory/fabric-rolls');
      const avail = availableBatchMeters(db, meta.batchId);
      if ((-delta) - avail > 1e-9) {
        throw httpErr(409, `متر طاقه کافی نیست (مانده ${avail}، نیاز ${-delta})`, 'E_FABRIC_QTY');
      }
    }

    if (old && neu) {
      if (!meta.isFabric && Math.abs(delta) > 1e-9) {
        applyStockDelta(db, {
          productId: meta.productId, warehouseId: meta.warehouseId,
          qtyDelta: delta, allowNegative: true,
        });
      }
      if (meta.variantId && Math.abs(delta) > 1e-9) adjustVariant(db, meta.variantId, delta);
      if (mvs.length) {
        cogsRial += updateMovementQty(db, mvs[0], newQty);
        for (let i = 1; i < mvs.length; i++) zeroMovement(db, mvs[i]);
        if (meta.isFabric && meta.batchId) syncFabricAfterLedger(db, meta.batchId);
      } else if (perpetual && newQty > 0 && Math.abs(oldQty) < 1e-9) {
        cogsRial += postNewSaleLine(db, { meta, qty: newQty, sourceId: row.id, userId, date, num });
      } else if (meta.isFabric && meta.batchId && Math.abs(delta) > 1e-9) {
        const { adjustBatchQty } = require('./inventory/batch-serial');
        adjustBatchQty(db, meta.batchId, delta);
      }
    } else if (old && !neu) {
      if (!meta.isFabric) {
        applyStockDelta(db, {
          productId: meta.productId, warehouseId: meta.warehouseId,
          qtyDelta: oldQty, allowNegative: true,
        });
      }
      if (meta.variantId) adjustVariant(db, meta.variantId, oldQty);
      if (mvs.length) {
        for (const mv of mvs) zeroMovement(db, mv);
        if (meta.isFabric && meta.batchId) syncFabricAfterLedger(db, meta.batchId);
      } else if (meta.isFabric && meta.batchId) {
        const { adjustBatchQty } = require('./inventory/batch-serial');
        adjustBatchQty(db, meta.batchId, oldQty);
      }
    } else if (neu && !old) {
      if (perpetual) {
        cogsRial += postNewSaleLine(db, { meta, qty: newQty, sourceId: row.id, userId, date, num });
      } else {
        if (!meta.isFabric) {
          applyStockDelta(db, {
            productId: meta.productId, warehouseId: meta.warehouseId,
            qtyDelta: -newQty, allowNegative: true,
          });
        }
        if (meta.isFabric && meta.batchId) {
          const { consumeFabricRollOnSale } = require('./inventory/fabric-rolls');
          consumeFabricRollOnSale(db, { batchId: meta.batchId, qty: newQty });
        }
        if (meta.variantId) adjustVariant(db, meta.variantId, -newQty);
      }
    }
  }

  for (const mv of unused) {
    const q = Number(mv.qty_out) || 0;
    if (q <= 0) continue;
    if (!mv.batch_id) {
      applyStockDelta(db, {
        productId: mv.product_id, warehouseId: mv.warehouse_id,
        qtyDelta: q, allowNegative: true,
      });
    }
    zeroMovement(db, mv);
    if (mv.batch_id) syncFabricAfterLedger(db, mv.batch_id);
  }

  return {
    cogsRial,
    usedWarehouses: [...used.entries()].map(([id, name]) => ({ id, name })),
  };
}

function buildPerpetualCogsLines(db, cogsRial) {
  const amt = Math.round(Number(cogsRial) || 0);
  if (amt <= 0) return [];
  const cogs = acct(db, 'coa_cogs');
  let invAcct;
  try { invAcct = acct(db, 'coa_inventory'); } catch (_) { invAcct = acct(db, 'coa_finished_goods'); }
  const L = rialToLedger(amt);
  return [
    { code: cogs.code, name: cogs.name, debit: L, credit: 0 },
    { code: invAcct.code, name: invAcct.name, debit: 0, credit: L },
  ];
}

function buildLegacyCogsLines(db, rows) {
  const { parseQty } = require('./round3');
  const lines = [];
  let total = 0;
  for (const r of rows || []) {
    if (!r.product_id) continue;
    const p = db.prepare('SELECT cost,average_cost_rial,coa_code,name FROM products WHERE id=?').get(r.product_id);
    if (!p || !p.coa_code) continue;
    const unitRial = Number(p.average_cost_rial) > 0 ? Number(p.average_cost_rial) : (Number(p.cost) || 0);
    const amtRial = Math.round(unitRial * (parseQty(r.qty) || 0));
    if (amtRial <= 0) continue;
    const amt = rialToLedger(amtRial);
    total += amt;
    lines.push({ code: p.coa_code, name: p.name, debit: 0, credit: amt });
  }
  if (!total) return [];
  const cogs = acct(db, 'coa_cogs');
  lines.unshift({ code: cogs.code, name: cogs.name, debit: total, credit: 0 });
  return lines;
}

function rewriteCogsInPlace(db, { row, num, date, userId, rows, cogsRial }) {
  const perpetual = perpetualDocsEnabled(db);
  const lines = perpetual
    ? buildPerpetualCogsLines(db, cogsRial)
    : buildLegacyCogsLines(db, rows);
  const rewritten = rewriteJournalEntry(db, {
    sourceType: 'invoice_cogs', sourceId: row.id,
    date: date || '',
    description: `بهای تمام‌شده فاکتور ${num}`,
    createdBy: userId,
    lines,
  });
  return rewritten;
}

function isInvoiceTimeSettlement(s) {
  return String((s && s.note) || '').includes('هنگام فاکتور');
}

function listLiveSettlements(db, invoiceId) {
  return db.prepare(`
    SELECT * FROM settlements
    WHERE invoice_id=? AND COALESCE(status,'posted')<>'reversed'
    ORDER BY id ASC
  `).all(invoiceId);
}

function rewriteInvoiceTimeSettlements(db, {
  row, payPlan, custId, date, userId, num, body,
}) {
  const live = listLiveSettlements(db, row.id);
  const invoiceTime = live.filter(isInvoiceTimeSettlement);
  const later = live.filter((s) => !isInvoiceTimeSettlement(s));
  const splits = (payPlan && payPlan.splits) || [];

  if (later.length && Number(custId) !== Number(row.cust_id)) {
    throw httpErr(409, 'این فاکتور تسویه بعدی دارد؛ تغییر مشتری مجاز نیست', 'E_AMEND_CUST_SETTLED');
  }

  if (splits.length !== invoiceTime.length) {
    if (splits.length === 0 && invoiceTime.length === 0) return;
    throw httpErr(
      409,
      'تعداد اقساط پرداخت هنگام فاکتور تغییر کرده است؛ برای تغییر تعداد قسط، فاکتور را ابطال و دوباره ثبت کنید',
      'E_AMEND_SPLIT_COUNT'
    );
  }

  for (let i = 0; i < splits.length; i++) {
    const s = splits[i];
    const sett = invoiceTime[i];
    const amountRial = Math.round(Number(s.amount) || 0);
    const payType = s.pay_type;
    const chequeInfo = s.cheque_info || (body && body.cheque_info) || '';
    const chequeDue = s.cheque_due || (body && body.cheque_due_date) || '';
    const note = s.note || `دریافت هنگام فاکتور ${num}` + (splits.length > 1 ? ` — قسط ${i + 1}` : '');
    const settNote = chequeInfo ? `${note}${note ? ' — ' : ''}${chequeInfo}` : note;
    db.prepare(`
      UPDATE settlements
      SET cust_id=?, amount=?, amount_rial=?, pay_type=?, date=?, note=?,
          bank_id=?, cash_box_id=?, check_category_id=?, cheque_due=?
      WHERE id=?
    `).run(
      custId, amountRial, amountRial, payType, date || '', settNote,
      s.bank_id || null, s.cash_box_id || null, s.check_category_id || null,
      chequeDue, sett.id
    );
    db.prepare(`
      UPDATE customer_ledger
      SET customer_id=?, date=?, description=?, debit=0, credit=?
      WHERE ref_type='settlement' AND ref_id=? AND entry_type='settlement'
    `).run(
      custId, date || '',
      `تسویه هنگام فاکتور — ${amountRial.toLocaleString('fa-IR')} ریال`,
      amountRial, sett.id
    );
    const cash = resolveCashAccount(db, payType, s.bank_id, s.cash_box_id);
    const recv = receivableAcct(db, custId);
    const jeId = rewriteJournalEntry(db, {
      sourceType: 'settlement', sourceId: sett.id,
      date: date || '',
      description: `تسویه هنگام فاکتور`,
      createdBy: userId,
      lines: [
        { code: cash.code, name: cash.name, debit: rialToLedger(amountRial), credit: 0 },
        { code: recv.code, name: recv.name, debit: 0, credit: rialToLedger(amountRial) },
      ],
    });
    if (!jeId) {
      throw httpErr(409, 'سند تسویه هنگام فاکتور پیدا نشد', 'E_AMEND_SETTLEMENT_JE');
    }
  }
}

function rewriteCommissionInPlace(db, { row, invLike, userId, date }) {
  const existing = db.prepare(`
    SELECT id FROM journal_entries
    WHERE ref_type='commission_accrual_invoice' AND ref_id=?
      AND COALESCE(deleted_at,0)=0
      AND COALESCE(status,'posted') NOT IN ('reversed','void')
    LIMIT 1
  `).get(row.id);
  if (!existing) return null;
  const { computeSingleInvoiceCommission } = require('./rep-ledger');
  const amount = Math.round(Number(computeSingleInvoiceCommission(db, invLike)) || 0);
  const expense = acct(db, 'coa_rep_commission_expense');
  const payable = acct(db, 'coa_rep_commission_payable');
  const L = rialToLedger(amount);
  const lines = amount > 0
    ? [
      { code: expense.code, name: expense.name, debit: L, credit: 0 },
      { code: payable.code, name: payable.name, debit: 0, credit: L },
    ]
    : [];
  rewriteJournalEntry(db, {
    sourceType: 'commission_accrual_invoice', sourceId: row.id,
    date: date || '',
    description: `تعهد انگیزه فروش — فاکتور ${invLike.num}`,
    createdBy: userId,
    lines,
  });
  db.prepare(`
    UPDATE rep_ledger
    SET credit=?, date=?, description=?
    WHERE ref_type='invoice' AND ref_id=? AND entry_type='commission_accrual'
  `).run(amount, date || '', `تعهد انگیزه فاکتور ${invLike.num}`, row.id);
  return existing.id;
}

/**
 * Amend a posted normal invoice in place. Caller should run inside db.transaction.
 */
function amendPostedInvoiceInPlace(db, {
  row, built, totals, freightAdj, req, body, newType, whId, ccId, payPlan,
  journalOpts, freightRial, freight_type, allocMethod, storedPayType, skipInvoiceCash,
  salesChannel,
}) {
  if (!row) throw httpErr(404, 'یافت نشد');
  if (row.type === 'final') {
    throw httpErr(409, 'فاکتور رسمی ثبت‌شده قفل است؛ برای اصلاح، آن را ابطال کنید', 'E_FINAL_LOCKED');
  }
  if (isFirmSale(newType) && newType !== 'normal') {
    throw httpErr(409, 'تبدیل فاکتور معمولی به رسمی فقط از عملیات «تبدیل» انجام می‌شود', 'E_CONVERT_ONLY');
  }
  if (newType !== 'normal' || row.type !== 'normal') {
    throw httpErr(409, 'تغییر نوع فاکتور معمولی از این مسیر مجاز نیست', 'E_TYPE_LOCKED');
  }
  if (row.status === 'reversed' || (row.deleted_at && Number(row.deleted_at) !== 0)) {
    throw httpErr(400, 'این فاکتور ابطال یا حذف شده و قابل ویرایش نیست', 'E_INVOICE_DEAD');
  }

  const activeReturns = db.prepare(
    "SELECT COUNT(*) AS c FROM sales_returns WHERE invoice_id=? AND COALESCE(status,'posted')<>'reversed'"
  ).get(row.id).c;
  if (activeReturns > 0) {
    throw httpErr(400, `این فاکتور ${activeReturns} مرجوعی فروش فعال دارد — ابتدا مرجوعی را ابطال کنید`);
  }

  const { assertInvoiceEditableForMoadian } = require('./moadian/invoice-hooks');
  assertInvoiceEditableForMoadian(row);

  const user = (req && req.user) || {};
  const userId = user.id;
  const b = body || {};
  const custId = b.cust_id != null && b.cust_id !== '' ? parseInt(b.cust_id, 10) : row.cust_id;
  const entryDate = b.date || row.date || '';
  const { subtotal, discAmt, vatAmount, vatRate } = totals;
  const { final, netBeforeVat } = freightAdj;
  const discPct = parseFloat(b.disc != null ? b.disc : row.disc) || 0;
  const vatFlag = resolveVatExemptFlag(newType, b.vat_exempt, row.vat_exempt);

  let firmWh = whId;
  firmWh = requireFirmHeaderWarehouse(firmWh);
  applyHeaderWarehouseToLines(built.rows, firmWh, {
    force: user.role === 'field_sales' || user.role === 'inside_sales',
  });
  assertWarehouseLines(db, built.rows, firmWh, { requirePositive: true, allowNegativeProduct: true });

  const stocked = replaceSaleStockInPlace(db, {
    row, newRows: built.rows, headerWh: firmWh,
    userId, date: entryDate, num: row.num,
  });

  if (perpetualDocsEnabled(db)) {
    rewriteCogsInPlace(db, {
      row, num: row.num, date: entryDate, userId,
      rows: built.rows, cogsRial: stocked.cogsRial,
    });
  } else {
    const on = db.prepare("SELECT value FROM settings WHERE key='feature_cogs_voucher'").get();
    if (on && on.value === '1') {
      rewriteCogsInPlace(db, {
        row, num: row.num, date: entryDate, userId,
        rows: built.rows, cogsRial: stocked.cogsRial,
      });
    }
  }

  const jeId = rewriteJournalEntry(db, {
    sourceType: 'invoice', sourceId: row.id,
    date: entryDate,
    description: `${invoiceTypeLabel(newType)} ${row.num}${freightRial ? ' (با کرایه حمل)' : ''}`,
    createdBy: userId,
    lines: salesJournalLines(db, custId, {
      subtotal, discAmt, final, vatAmount, netBeforeVat,
    }, false, journalOpts),
  });
  if (!jeId) {
    throw httpErr(409, 'سند فروش این فاکتور پیدا نشد', 'E_AMEND_SALE_JE');
  }

  updateInvoiceCustomerLedger(db, {
    customerId: custId, date: entryDate, invId: row.id, num: row.num,
    invType: newType, final, userId,
    payType: skipInvoiceCash ? 'credit' : storedPayType,
    skipImmediatePayment: skipInvoiceCash,
  });

  persistInvoicePayPlan(db, row.id, payPlan, b);
  rewriteInvoiceTimeSettlements(db, {
    row, payPlan, custId, date: entryDate, userId, num: row.num, body: b,
  });

  const invLike = {
    ...row,
    rows: JSON.stringify(built.rows),
    final,
    pay_type: storedPayType,
    cust_id: custId,
    date: entryDate,
    num: row.num,
    user_id: row.user_id,
  };
  rewriteCommissionInPlace(db, { row, invLike, userId, date: entryDate });

  const moadianType = b.moadian_invoice_type != null && b.moadian_invoice_type !== ''
    ? (parseInt(b.moadian_invoice_type, 10) || 1)
    : (row.moadian_invoice_type != null ? row.moadian_invoice_type : 1);

  let ownerUserId = row.user_id;
  let sellerName = row.seller_name || '';
  let sellerPhone = row.seller_phone || '';
  if ((user.role === 'admin' || user.role === 'accounting') && b.expert_user_id) {
    const eu = db.prepare('SELECT id,name,phone FROM users WHERE id=? AND active=1').get(parseInt(b.expert_user_id, 10));
    if (eu) {
      ownerUserId = eu.id;
      sellerName = eu.name || '';
      sellerPhone = eu.phone || '';
    }
  }

  const channel = salesChannel != null && salesChannel !== ''
    ? salesChannel
    : (row.sales_channel || '');

  db.prepare(`
    UPDATE invoices SET cust_id=?,type=?,date=?,note=?,rows=?,subtotal=?,disc=?,disc_amt=?,final=?,vat_amount=?,vat_rate=?,
      subtotal_rial=?,final_rial=?,vat_amount_rial=?,pay_type=?,cheque_duration=?,cheque_due_date=?,cheque_info=?,stock_deducted=1,
      sales_channel=?,lead_source=?,campaign=?,bank_id=?,cash_box_id=?,check_category_id=?,warehouse_id=?,freight_amount=?,freight_type=?,freight_alloc_method=?,vat_exempt=?,cost_center_id=?,moadian_invoice_type=?,
      user_id=?,seller_name=?,seller_phone=?
    WHERE id=?
  `).run(
    custId, newType, entryDate, b.note != null ? b.note : (row.note || ''),
    JSON.stringify(built.rows), subtotal, discPct, discAmt, final,
    vatAmount, vatRate, Math.round(subtotal), Math.round(final), Math.round(vatAmount),
    storedPayType || row.pay_type || 'cash',
    b.cheque_duration != null ? b.cheque_duration : (row.cheque_duration || ''),
    b.cheque_due_date != null ? b.cheque_due_date : (row.cheque_due_date || ''),
    b.cheque_info != null ? b.cheque_info : (row.cheque_info || ''),
    channel,
    b.lead_source != null ? b.lead_source : (row.lead_source || ''),
    b.campaign != null ? b.campaign : (row.campaign || ''),
    b.bank_id != null && b.bank_id !== '' ? b.bank_id : (row.bank_id || null),
    b.cash_box_id != null && b.cash_box_id !== '' ? b.cash_box_id : (row.cash_box_id || null),
    b.check_category_id != null && b.check_category_id !== '' ? b.check_category_id : (row.check_category_id || null),
    firmWh, freightRial, freight_type || '',
    allocMethod, vatFlag, ccId, moadianType,
    ownerUserId, sellerName, sellerPhone,
    row.id
  );

  return {
    id: row.id,
    journal_id: jeId,
    amended: true,
    usedWarehouses: stocked.usedWarehouses || [],
  };
}

module.exports = {
  defaultVatExempt,
  resolveVatExemptFlag,
  amendPostedInvoiceInPlace,
  replaceSaleStockInPlace,
};
