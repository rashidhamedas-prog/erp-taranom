/**
 * Sales return create / R13 reverse / in-place amend (same id).
 * Mirrors cutting-lay amend: reverse all create effects, then re-post.
 */
'use strict';

const { todayJalali } = require('../jalali');
const { createLedgerEntry } = require('../db');
const { postToLedger } = require('./ledger');
const {
  perpetualDocsEnabled, postSaleReturnStockMovements, reverseStockBySource,
  assertJournalIdempotent,
} = require('./sales-document');
const { recomputeInvoiceSettledBalances } = require('./invoice-payments');
const { parseQty } = require('./round3');
const {
  prorateLineDiscount, priorHeaderDiscConsumed, priorVatConsumed,
  computeReturnTotals, returnMoneyParts, rial,
} = require('./returns-discount');

function httpErr(status, message, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

function lineKey(r) {
  return r.variant_id ? `v:${r.variant_id}` : `p:${r.product_id}`;
}

/**
 * Build validated line rows + amounts (shared by create/amend).
 * @param {object} opts
 * @param {number|null} [opts.excludeReturnId] — when amending, exclude self from returned qty caps
 * @param {number} [opts.extraDiscAmt]
 * @param {number} [opts.extraDiscPct]
 */
function buildSalesReturnLines(db, {
  custId, invoiceId, rows, warehouseId, excludeReturnId = null,
  extraDiscAmt = 0, extraDiscPct = 0,
}) {
  if (!custId) throw httpErr(400, 'مشتری الزامی است', 'E_SR_CUST');

  let invoiceLineMap = null;
  const alreadyReturnedMap = {};
  let parentWhId = warehouseId ? parseInt(warehouseId, 10) : null;
  let invRow = null;
  let remainingGoodsOnInvoice = null;

  if (invoiceId) {
    invRow = db.prepare('SELECT * FROM invoices WHERE id=? AND cust_id=?').get(invoiceId, custId);
    if (!invRow) throw httpErr(400, 'فاکتور یافت نشد یا متعلق به این مشتری نیست', 'E_SR_INV');
    if (!parentWhId && invRow.warehouse_id) parentWhId = parseInt(invRow.warehouse_id, 10);
    invoiceLineMap = {};
    JSON.parse(invRow.rows || '[]').forEach((r) => {
      invoiceLineMap[lineKey(r)] = r;
    });
    const prior = db.prepare(
      "SELECT id, rows FROM sales_returns WHERE invoice_id=? AND COALESCE(status,'posted')<>'reversed'"
    ).all(invoiceId);
    for (const pr of prior) {
      if (excludeReturnId && Number(pr.id) === Number(excludeReturnId)) continue;
      JSON.parse(pr.rows || '[]').forEach((r) => {
        const k = lineKey(r);
        alreadyReturnedMap[k] = (alreadyReturnedMap[k] || 0) + r.qty;
      });
    }
    remainingGoodsOnInvoice = 0;
    Object.values(invoiceLineMap).forEach((ol) => {
      const key = lineKey(ol);
      const already = alreadyReturnedMap[key] || alreadyReturnedMap[`p:${ol.product_id}`] || 0;
      const remQty = Math.max(0, (Number(ol.qty) || 0) - already);
      if (remQty <= 0) return;
      const { discAmt } = prorateLineDiscount(ol, remQty, already);
      remainingGoodsOnInvoice += rial(remQty * (Number(ol.price) || 0) - discAmt);
    });
  }

  const built = [];
  let goodsAmountA = 0;
  let costAmount = 0;
  const { productUnitCostRial } = require('./inventory/product-unit-cost');

  for (const r of (rows || [])) {
    const pid = parseInt(r.product_id, 10);
    const prod = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
    if (!prod) continue;
    let qty = Math.max(0.001, parseQty(r.qty, 1));
    let price;
    let disc = 0;
    let discAmt = 0;
    let lineWh = r.warehouse_id ? parseInt(r.warehouse_id, 10) : null;
    let origLine = null;
    if (invoiceLineMap) {
      const key = r.variant_id ? `v:${r.variant_id}` : `p:${pid}`;
      origLine = invoiceLineMap[key] || invoiceLineMap[`p:${pid}`];
      if (!origLine) {
        throw httpErr(400, `کالای ${prod.name} در این فاکتور وجود ندارد`, 'E_SR_LINE');
      }
      const already = alreadyReturnedMap[key] || alreadyReturnedMap[`p:${pid}`] || 0;
      const maxReturnable = origLine.qty - already;
      if (qty > maxReturnable) {
        throw httpErr(400, `حداکثر مقدار قابل برگشت برای ${prod.name}: ${maxReturnable}`, 'E_SR_QTY');
      }
      price = origLine.price;
      const pr = prorateLineDiscount(origLine, qty, already);
      disc = pr.discPct;
      discAmt = pr.discAmt;
      if (!lineWh && origLine.warehouse_id) lineWh = parseInt(origLine.warehouse_id, 10);
    } else {
      price = parseFloat(r.price) || prod.price;
      disc = Number(r.disc) || 0;
      discAmt = r.disc_amt != null ? rial(r.disc_amt)
        : (r.disc_amount != null ? rial(r.disc_amount) : rial(qty * price * disc / 100));
    }
    const sum = rial(qty * price - discAmt);
    goodsAmountA += sum;
    const avgRial = productUnitCostRial(prod);
    costAmount += Math.round(qty * avgRial);
    built.push({
      product_id: pid,
      name: prod.name,
      qty,
      price,
      disc,
      disc_amt: discAmt,
      sum,
      warehouse_id: lineWh || parentWhId || null,
      unit_cost: avgRial,
      cost_rial: avgRial,
      variant_id: (origLine && origLine.variant_id) || r.variant_id || null,
      color_name: (origLine && (origLine.color_name || origLine.color)) || r.color_name || '',
      size_name: (origLine && origLine.size_name) || r.size_name || '',
    });
  }
  if (!built.length) throw httpErr(400, 'حداقل یک ردیف لازم است', 'E_SR_ROWS');

  const { settingFlag, invoiceNetBase, invoiceSourceVat } = require('./returns-posting');
  let totals;
  if (invoiceId && invRow) {
    const priorHdr = priorHeaderDiscConsumed(db, {
      table: 'sales_returns',
      invoiceCol: 'invoice_id',
      invoiceId,
      invoiceDiscAmt: invRow.disc_amt,
      invoiceSubtotal: invRow.subtotal,
      excludeReturnId,
    });
    const priorVat = priorVatConsumed(db, {
      table: 'sales_returns', invoiceCol: 'invoice_id', invoiceId, excludeReturnId,
    });
    totals = computeReturnTotals({
      goodsAmountA,
      invoiceDiscAmt: invRow.disc_amt,
      invoiceSubtotal: invRow.subtotal,
      priorHdrUsed: priorHdr,
      remainingGoodsOnInvoice,
      extraDiscAmt,
      extraDiscPct,
      sourceVat: invoiceSourceVat(invRow),
      sourceNetBase: invoiceNetBase(invRow),
      vatSettingOn: settingFlag(db, 'returns_reverse_vat', true),
      priorVatUsed: priorVat,
    });
  } else {
    totals = computeReturnTotals({
      goodsAmountA,
      invoiceDiscAmt: 0,
      invoiceSubtotal: 0,
      priorHdrUsed: 0,
      remainingGoodsOnInvoice: null,
      extraDiscAmt,
      extraDiscPct,
      sourceVat: 0,
      sourceNetBase: 0,
      vatSettingOn: false,
      priorVatUsed: 0,
    });
  }

  return {
    built,
    amount: totals.amount,
    goodsAmount: totals.goodsAmount,
    hdrDiscAmt: totals.hdrDiscAmt,
    extraDiscAmt: totals.extraDiscAmt,
    extraDiscPct: totals.extraDiscPct,
    vatAmount: totals.vatAmount,
    costAmount,
    parentWhId,
  };
}

/**
 * Post stock + customer_ledger + JE for an existing sales_returns row id.
 * Must run inside a transaction. Caller inserts/updates the header first.
 */
function postSalesReturnEffects(db, {
  retId, custId, invoiceId, date, note, built, amount, costAmount, parentWhId, userId,
  goodsAmount, hdrDiscAmt, extraDiscAmt, vatAmount: vatPrefill,
}) {
  let cost = costAmount;
  let stocked = null;
  if (perpetualDocsEnabled(db)) {
    stocked = postSaleReturnStockMovements(db, {
      rows: built,
      warehouseId: parentWhId,
      sourceType: 'sales_return',
      sourceId: retId,
      userId,
      date: date || todayJalali(),
      note: note || `برگشت از فروش #${retId}`,
    });
    if (stocked.costRial > 0) {
      cost = stocked.costRial;
      db.prepare('UPDATE sales_returns SET cost_amount=? WHERE id=?').run(cost, retId);
    }
  } else {
    for (const r of built) {
      db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(r.qty, r.product_id);
      db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)')
        .run(r.product_id, userId, r.qty, `برگشت از فروش #${retId}`);
    }
  }

  const vatAmount = vatPrefill != null ? rial(vatPrefill) : 0;
  const goods = goodsAmount != null ? rial(goodsAmount) : rial(amount);
  const hdr = rial(hdrDiscAmt);
  const extra = rial(extraDiscAmt);
  db.prepare(`
    UPDATE sales_returns SET vat_amount=?, goods_amount=?, hdr_disc_amt=?, extra_disc_amt=? WHERE id=?
  `).run(vatAmount, goods, hdr, extra, retId);
  const gross = rial(amount) + vatAmount;

  createLedgerEntry(db, {
    customer_id: custId,
    date: date || todayJalali(),
    entry_type: 'reversal',
    ref_type: 'sales_return',
    ref_id: retId,
    description: `برگشت از فروش #${retId}`,
    debit: 0,
    credit: gross,
    user_id: userId,
  });

  assertJournalIdempotent(db, 'sales_return', retId);
  const {
    buildSalesReturnJournalLines, costItemsFromMovements, costItemsFromLedger,
  } = require('./returns-posting');
  let costItems = [];
  if (stocked && stocked.movements) {
    costItems = costItemsFromMovements(stocked.movements);
  }
  if (!costItems.length || costItems.every((c) => c.warehouseId == null)) {
    const fromLed = costItemsFromLedger(db, 'sales_return', retId);
    if (fromLed.length) costItems = fromLed;
  }
  if (!costItems.length && cost > 0) {
    costItems = [{ warehouseId: parentWhId, amountRial: cost }];
  }
  const journalLines = buildSalesReturnJournalLines(db, {
    custId,
    amountNet: amount,
    goodsAmount: goods,
    hdrDiscAmt: hdr,
    extraDiscAmt: extra,
    vatAmount,
    costItems,
  });
  postToLedger(db, {
    sourceType: 'sales_return',
    sourceId: retId,
    date: date || todayJalali(),
    description: `برگشت از فروش #${retId}`,
    createdBy: userId,
    lines: journalLines,
  });

  return { vatAmount, costAmount: cost, gross };
}

/**
 * Reverse stock, JE (soft-void), customer_ledger, allocations.
 * Does NOT set sales_returns.status — caller chooses void vs amend.
 */
function reverseSalesReturnEffects(db, row, userId, reason) {
  const {
    buildSalesReturnJournalLines, costItemsFromLedger,
  } = require('./returns-posting');

  let costItems = costItemsFromLedger(db, 'sales_return', row.id);
  if (!costItems.length && Number(row.cost_amount) > 0) {
    costItems = [{ warehouseId: null, amountRial: Math.round(Number(row.cost_amount) || 0) }];
  }

  if (perpetualDocsEnabled(db)) {
    const reversed = reverseStockBySource(db, 'sales_return', row.id, {
      createdBy: userId,
      date: todayJalali(),
      note: reason || `ابطال برگشت از فروش #${row.id}`,
    });
    try {
      require('./inventory/movement').reverseStockDocument(db, {
        docType: 'sale_return_sku',
        docId: row.id,
        userId,
        note: `ابطال رنگ×سایز برگشت از فروش #${row.id}`,
        applyHeaderStock: false,
      });
    } catch (_) { /* older returns have no sku layer */ }
    if (!reversed.length) {
      const invRows = JSON.parse(row.rows || '[]');
      for (const r of invRows) {
        db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(r.qty, r.product_id);
        db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)')
          .run(r.product_id, userId, -r.qty, reason || `ابطال برگشت از فروش #${row.id}`);
      }
    }
  } else {
    const invRows = JSON.parse(row.rows || '[]');
    for (const r of invRows) {
      db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(r.qty, r.product_id);
      db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)')
        .run(r.product_id, userId, -r.qty, reason || `ابطال برگشت از فروش #${row.id}`);
    }
  }

  const parts = returnMoneyParts(row);
  const { amountNet, vatAmount, gross, goodsAmount, hdrDiscAmt, extraDiscAmt } = parts;

  createLedgerEntry(db, {
    customer_id: row.cust_id,
    date: todayJalali(),
    entry_type: 'reversal',
    ref_type: 'sales_return_reversal',
    ref_id: row.id,
    description: reason || `ابطال برگشت از فروش #${row.id}`,
    debit: gross,
    credit: 0,
    user_id: userId,
  });

  const journalLines = buildSalesReturnJournalLines(db, {
    custId: row.cust_id,
    amountNet,
    goodsAmount,
    hdrDiscAmt,
    extraDiscAmt,
    vatAmount,
    costItems,
    reverse: true,
  });
  // v285+: *_reversal soft-voids original JE (no paired voucher).
  const reversalId = postToLedger(db, {
    sourceType: 'sales_return_reversal',
    sourceId: row.id,
    date: todayJalali(),
    description: reason || `ابطال برگشت از فروش #${row.id}`,
    createdBy: userId,
    lines: journalLines,
  });

  try {
    const { reverseAllocationsForReturn, SIDE_SALES } = require('./return-credit-allocate');
    reverseAllocationsForReturn(db, SIDE_SALES, row.id, userId);
  } catch (_) { /* older DBs */ }

  return { reversalId, gross, invoiceId: row.invoice_id };
}

function recomputeAfterSalesReturn(db, rowOrInvoiceId, returnId) {
  const invoiceId = typeof rowOrInvoiceId === 'object'
    ? rowOrInvoiceId.invoice_id
    : rowOrInvoiceId;
  if (invoiceId) {
    recomputeInvoiceSettledBalances(db, invoiceId);
    return;
  }
  try {
    const all = db.prepare(`
      SELECT DISTINCT invoice_id FROM return_credit_allocations
      WHERE side='sales' AND return_id=?
    `).all(returnId);
    for (const a of all) recomputeInvoiceSettledBalances(db, a.invoice_id);
  } catch (_) { /* ignore */ }
}

function autoAllocateSalesReturn(db, retId, userId) {
  try {
    const { autoAllocateIfEnabled, SIDE_SALES } = require('./return-credit-allocate');
    autoAllocateIfEnabled(db, { side: SIDE_SALES, returnId: retId, userId });
  } catch (e) {
    console.warn('sales-return auto-allocate:', e && e.message);
  }
}

/**
 * Create posted sales return. Returns id.
 */
function createSalesReturn(db, body, user) {
  const custId = parseInt(body.cust_id, 10);
  const invoiceId = body.invoice_id ? parseInt(body.invoice_id, 10) : null;
  const date = body.date || todayJalali();
  const note = body.note || '';
  const reasonCode = String(body.reason_code || '').trim().slice(0, 40);
  const builtPack = buildSalesReturnLines(db, {
    custId,
    invoiceId,
    rows: body.rows,
    warehouseId: body.warehouse_id,
    extraDiscAmt: body.extra_disc_amt != null ? body.extra_disc_amt : body.disc_extra_amt,
    extraDiscPct: body.extra_disc_pct != null ? body.extra_disc_pct : body.disc_extra_pct,
  });
  const {
    built, amount, costAmount, parentWhId,
    goodsAmount, hdrDiscAmt, extraDiscAmt, extraDiscPct, vatAmount,
  } = builtPack;

  const retId = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO sales_returns (
        user_id,cust_id,invoice_id,date,note,rows,amount,cost_amount,reason_code,
        goods_amount,hdr_disc_amt,extra_disc_amt,extra_disc_pct,vat_amount
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      user.id, custId, invoiceId || null, date, note, JSON.stringify(built), amount, costAmount, reasonCode,
      goodsAmount, hdrDiscAmt, extraDiscAmt, extraDiscPct || 0, vatAmount
    );
    const id = result.lastInsertRowid;
    postSalesReturnEffects(db, {
      retId: id,
      custId,
      invoiceId,
      date,
      note: `برگشت از فروش #${id}`,
      built,
      amount,
      costAmount,
      parentWhId,
      userId: user.id,
      goodsAmount,
      hdrDiscAmt,
      extraDiscAmt,
      vatAmount,
    });
    return id;
  })();

  if (invoiceId) recomputeInvoiceSettledBalances(db, invoiceId);
  else autoAllocateSalesReturn(db, retId, user.id);

  return { id: retId, amount, goods_amount: goodsAmount, hdr_disc_amt: hdrDiscAmt, extra_disc_amt: extraDiscAmt };
}

/**
 * Void (soft) — status=reversed.
 */
function voidSalesReturn(db, id, user) {
  const row = db.prepare('SELECT * FROM sales_returns WHERE id=?').get(id);
  if (!row) throw httpErr(404, 'یافت نشد', 'E_SR_NOT_FOUND');
  if (row.status === 'reversed') throw httpErr(400, 'این برگشت فروش قبلاً ابطال شده است', 'E_SR_REVERSED');

  db.transaction(() => {
    const { reversalId } = reverseSalesReturnEffects(
      db, row, user.id, `ابطال برگشت از فروش #${row.id}`
    );
    db.prepare(
      "UPDATE sales_returns SET status='reversed',reversal_journal_id=?,reversed_at=strftime('%s','now'),reversed_by=? WHERE id=?"
    ).run(reversalId, user.id, row.id);
  })();

  recomputeAfterSalesReturn(db, row, row.id);
  return { ok: true };
}

/**
 * R13 Edit ⇒ reverse create effects, then re-post on the same id.
 * Customer is immutable (AR party lock).
 */
function updateSalesReturn(db, id, body, user) {
  const row = db.prepare('SELECT * FROM sales_returns WHERE id=?').get(Number(id));
  if (!row) throw httpErr(404, 'یافت نشد', 'E_SR_NOT_FOUND');
  if (row.status === 'reversed') {
    throw httpErr(409, 'برگشت ابطال‌شده قابل ویرایش نیست', 'E_SR_REVERSED');
  }

  const custId = Number(row.cust_id);
  if (body.cust_id != null && Number(body.cust_id) !== custId) {
    throw httpErr(400, 'مشتری برگشت قابل تغییر نیست — ابطال و ثبت جدید کنید', 'E_SR_CUST_LOCKED');
  }

  const invoiceId = body.invoice_id !== undefined
    ? (body.invoice_id ? parseInt(body.invoice_id, 10) : null)
    : (row.invoice_id || null);
  const date = body.date || row.date || todayJalali();
  const note = body.note != null ? String(body.note) : (row.note || '');
  const reasonCode = body.reason_code != null
    ? String(body.reason_code || '').trim().slice(0, 40)
    : String(row.reason_code || '').trim().slice(0, 40);

  const builtPack = buildSalesReturnLines(db, {
    custId,
    invoiceId,
    rows: body.rows,
    warehouseId: body.warehouse_id !== undefined ? body.warehouse_id : null,
    excludeReturnId: row.id,
    extraDiscAmt: body.extra_disc_amt != null ? body.extra_disc_amt
      : (body.disc_extra_amt != null ? body.disc_extra_amt : row.extra_disc_amt),
    extraDiscPct: body.extra_disc_pct != null ? body.extra_disc_pct
      : (body.disc_extra_pct != null ? body.disc_extra_pct : row.extra_disc_pct),
  });
  const {
    built, amount, costAmount, parentWhId,
    goodsAmount, hdrDiscAmt, extraDiscAmt, extraDiscPct, vatAmount,
  } = builtPack;

  const oldInvoiceId = row.invoice_id || null;

  db.transaction(() => {
    reverseSalesReturnEffects(db, row, user.id, body.reason || `ویرایش برگشت از فروش #${row.id}`);

    db.prepare(`
      UPDATE sales_returns SET
        invoice_id=?, date=?, note=?, rows=?, amount=?, cost_amount=?, reason_code=?,
        status='posted', reversed_at=NULL, reversed_by=NULL, reversal_journal_id=NULL,
        vat_amount=?, goods_amount=?, hdr_disc_amt=?, extra_disc_amt=?, extra_disc_pct=?
      WHERE id=?
    `).run(
      invoiceId || null, date, note, JSON.stringify(built), amount, costAmount, reasonCode,
      vatAmount, goodsAmount, hdrDiscAmt, extraDiscAmt, extraDiscPct || 0,
      row.id
    );

    postSalesReturnEffects(db, {
      retId: row.id,
      custId,
      invoiceId,
      date,
      note: `برگشت از فروش #${row.id}`,
      built,
      amount,
      costAmount,
      parentWhId,
      userId: user.id,
      goodsAmount,
      hdrDiscAmt,
      extraDiscAmt,
      vatAmount,
    });
  })();

  if (oldInvoiceId) recomputeInvoiceSettledBalances(db, oldInvoiceId);
  if (invoiceId && Number(invoiceId) !== Number(oldInvoiceId || 0)) {
    recomputeInvoiceSettledBalances(db, invoiceId);
  } else if (invoiceId) {
    recomputeInvoiceSettledBalances(db, invoiceId);
  } else {
    recomputeAfterSalesReturn(db, { invoice_id: null }, row.id);
    autoAllocateSalesReturn(db, row.id, user.id);
  }

  return { id: row.id, amount, ok: true };
}

function returnedQtyMapForInvoice(db, invoiceId, excludeReturnId = null) {
  const alreadyReturned = {};
  db.prepare(
    "SELECT id, rows FROM sales_returns WHERE invoice_id=? AND COALESCE(status,'posted')<>'reversed'"
  ).all(invoiceId).forEach((pr) => {
    if (excludeReturnId && Number(pr.id) === Number(excludeReturnId)) return;
    JSON.parse(pr.rows || '[]').forEach((r) => {
      const k = lineKey(r);
      alreadyReturned[k] = (alreadyReturned[k] || 0) + r.qty;
    });
  });
  return alreadyReturned;
}

module.exports = {
  buildSalesReturnLines,
  createSalesReturn,
  voidSalesReturn,
  updateSalesReturn,
  reverseSalesReturnEffects,
  postSalesReturnEffects,
  returnedQtyMapForInvoice,
  lineKey,
};
