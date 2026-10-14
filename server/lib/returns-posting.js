/**
 * Sales / purchase return journal builders (RETURNS-ADR-005 P1).
 * Linked returns optionally reverse proportional VAT; inventory uses typed WH COA.
 */
const { acct } = require('./coa-map');
const { rialToLedger } = require('./money');
const { inventoryAmountLinesByWarehouse } = require('./inventory/ledger');
const { assertJournalLinesBalanced } = require('./customer-books');

function settingFlag(db, key, defaultOn = true) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (!row || row.value == null || row.value === '') return !!defaultOn;
  const v = String(row.value).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function effectiveRialAmount(primary, rialCol) {
  const rial = Math.round(Number(rialCol) || 0);
  if (rial > 0) return rial;
  return Math.round(Number(primary) || 0);
}

function proportionalVat(sourceVat, returnedNet, sourceNet) {
  const sn = Math.round(Number(sourceNet) || 0);
  const rn = Math.round(Number(returnedNet) || 0);
  const sv = Math.round(Number(sourceVat) || 0);
  if (sn <= 0 || rn <= 0 || sv <= 0) return 0;
  const ratio = Math.min(1, rn / sn);
  return Math.round(sv * ratio);
}

/** VAT on source invoice/purchase (prefers *_rial columns when set). */
function invoiceSourceVat(inv) {
  if (!inv) return 0;
  return effectiveRialAmount(inv.vat_amount, inv.vat_amount_rial);
}

/** Net base for VAT ratio: prefer (final - vat), else subtotal - disc. */
function invoiceNetBase(inv) {
  if (!inv) return 0;
  const final = effectiveRialAmount(inv.final, inv.final_rial);
  const vat = invoiceSourceVat(inv);
  if (final > 0 && final >= vat) return final - vat;
  const sub = Math.round(Number(inv.subtotal) || 0);
  const disc = Math.round(Number(inv.disc_amt) || 0);
  return Math.max(0, sub - disc);
}

function receivableAcct(db, custId) {
  const c = custId ? db.prepare('SELECT coa_code FROM customers WHERE id=?').get(custId) : null;
  if (c && c.coa_code) {
    const a = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(c.coa_code);
    if (a) return a;
  }
  return acct(db, 'coa_receivable');
}

function payableAcct(db, supplierId) {
  const s = supplierId ? db.prepare('SELECT coa_code FROM suppliers WHERE id=?').get(supplierId) : null;
  if (s && s.coa_code) {
    const a = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(s.coa_code);
    if (a) return a;
  }
  return acct(db, 'coa_payable');
}

/**
 * @param {object} opts
 * @param {number} opts.custId
 * @param {number} opts.amountNet — persisted amount (= goods − header − extra); AR credit base
 * @param {number} [opts.goodsAmount] — Dr sales-return (defaults to amountNet + hdr + extra)
 * @param {number} [opts.hdrDiscAmt] — Cr sales discount (invoice header share)
 * @param {number} [opts.extraDiscAmt] — Cr sales discount (return-level extra)
 * @param {number} [opts.vatAmount]
 * @param {{ warehouseId?: number|null, amountRial: number }[]} [opts.costItems]
 * @param {boolean} [opts.reverse] — void mirror
 */
function buildSalesReturnJournalLines(db, opts = {}) {
  const reverse = !!opts.reverse;
  const hdrDisc = Math.round(Number(opts.hdrDiscAmt) || 0);
  const extraDisc = Math.round(Number(opts.extraDiscAmt) || 0);
  const discTotal = hdrDisc + extraDisc;
  const amountNet = Math.round(Number(opts.amountNet) || 0);
  const goodsAmount = opts.goodsAmount != null
    ? Math.round(Number(opts.goodsAmount) || 0)
    : (amountNet + discTotal);
  const vatAmount = Math.round(Number(opts.vatAmount) || 0);
  const gross = amountNet + vatAmount;
  const L = rialToLedger;
  const salesReturn = acct(db, 'coa_sales_return');
  const salesDisc = acct(db, 'coa_sales_discount');
  const cogs = acct(db, 'coa_cogs');
  const vatPay = acct(db, 'coa_vat_payable');
  const recv = receivableAcct(db, opts.custId);
  const lines = [];

  if (!reverse) {
    if (goodsAmount > 0) {
      lines.push({ code: salesReturn.code, name: salesReturn.name, debit: L(goodsAmount), credit: 0, description: 'برگشت از فروش' });
    }
    if (vatAmount > 0) {
      lines.push({ code: vatPay.code, name: vatPay.name, debit: L(vatAmount), credit: 0, description: 'معکوس VAT برگشت فروش' });
    }
    if (gross > 0) {
      lines.push({ code: recv.code, name: recv.name, debit: 0, credit: L(gross) });
    }
    if (discTotal > 0) {
      lines.push({
        code: salesDisc.code, name: salesDisc.name, debit: 0, credit: L(discTotal),
        description: hdrDisc && extraDisc
          ? `برگشت تخفیف فاکتور ${hdrDisc} + تخفیف کلی برگشت ${extraDisc}`
          : (hdrDisc ? 'برگشت تخفیف سرفاکتور فروش' : 'تخفیف کلی برگشت از فروش'),
      });
    }
    for (const il of inventoryAmountLinesByWarehouse(db, opts.costItems || [])) {
      lines.push({ code: il.code, name: il.name, debit: L(il.amountRial), credit: 0, description: 'ورود موجودی برگشت فروش' });
      lines.push({ code: cogs.code, name: cogs.name, debit: 0, credit: L(il.amountRial), description: 'معکوس بهای تمام‌شده' });
    }
  } else {
    for (const il of inventoryAmountLinesByWarehouse(db, opts.costItems || [])) {
      lines.push({ code: cogs.code, name: cogs.name, debit: L(il.amountRial), credit: 0, description: 'ابطال معکوس COGS برگشت' });
      lines.push({ code: il.code, name: il.name, debit: 0, credit: L(il.amountRial), description: 'ابطال ورود موجودی برگشت' });
    }
    if (discTotal > 0) {
      lines.push({
        code: salesDisc.code, name: salesDisc.name, debit: L(discTotal), credit: 0,
        description: 'ابطال تخفیف برگشت فروش',
      });
    }
    if (gross > 0) {
      lines.push({ code: recv.code, name: recv.name, debit: L(gross), credit: 0 });
    }
    if (vatAmount > 0) {
      lines.push({ code: vatPay.code, name: vatPay.name, debit: 0, credit: L(vatAmount), description: 'ابطال معکوس VAT' });
    }
    if (goodsAmount > 0) {
      lines.push({ code: salesReturn.code, name: salesReturn.name, debit: 0, credit: L(goodsAmount), description: 'ابطال برگشت از فروش' });
    }
  }
  return assertJournalLinesBalanced(lines, reverse ? 'ابطال برگشت از فروش' : 'برگشت از فروش');
}

/**
 * Purchase return: Dr AP (gross) [/ Dr adj for extra] / Cr Inv (landed net) / Cr VAT receivable.
 * amountNet = goods − header − extra (AP debit base). Inventory credits goods − header.
 */
function buildPurchaseReturnJournalLines(db, opts = {}) {
  const reverse = !!opts.reverse;
  const hdrDisc = Math.round(Number(opts.hdrDiscAmt) || 0);
  const extraDisc = Math.round(Number(opts.extraDiscAmt) || 0);
  const amountNet = Math.round(Number(opts.amountNet) || 0);
  const goodsAmount = opts.goodsAmount != null
    ? Math.round(Number(opts.goodsAmount) || 0)
    : (amountNet + hdrDisc + extraDisc);
  const invAmount = opts.inventoryAmount != null
    ? Math.round(Number(opts.inventoryAmount) || 0)
    : Math.max(0, goodsAmount - hdrDisc);
  const vatAmount = Math.round(Number(opts.vatAmount) || 0);
  const gross = amountNet + vatAmount;
  const L = rialToLedger;
  const payable = payableAcct(db, opts.supplierId);
  const vatRec = acct(db, 'coa_vat_receivable');
  const adj = acct(db, 'coa_adjustment');
  const invLines = inventoryAmountLinesByWarehouse(db, opts.costItems || [{ warehouseId: opts.warehouseId, amountRial: invAmount }]);
  const lines = [];

  if (!reverse) {
    if (gross > 0) {
      lines.push({ code: payable.code, name: payable.name, debit: L(gross), credit: 0, description: 'برگشت از خرید' });
    }
    if (extraDisc > 0) {
      lines.push({
        code: adj.code, name: adj.name, debit: L(extraDisc), credit: 0,
        description: 'تخفیف کلی برگشت از خرید',
      });
    }
    for (const il of invLines) {
      lines.push({ code: il.code, name: il.name, debit: 0, credit: L(il.amountRial), description: 'خروج موجودی برگشت خرید' });
    }
    if (vatAmount > 0) {
      lines.push({ code: vatRec.code, name: vatRec.name, debit: 0, credit: L(vatAmount), description: 'معکوس VAT خرید' });
    }
  } else {
    if (vatAmount > 0) {
      lines.push({ code: vatRec.code, name: vatRec.name, debit: L(vatAmount), credit: 0, description: 'ابطال معکوس VAT خرید' });
    }
    for (const il of invLines) {
      lines.push({ code: il.code, name: il.name, debit: L(il.amountRial), credit: 0, description: 'ابطال خروج موجودی برگشت' });
    }
    if (extraDisc > 0) {
      lines.push({
        code: adj.code, name: adj.name, debit: 0, credit: L(extraDisc),
        description: 'ابطال تخفیف کلی برگشت خرید',
      });
    }
    if (gross > 0) {
      lines.push({ code: payable.code, name: payable.name, debit: 0, credit: L(gross), description: 'ابطال برگشت از خرید' });
    }
  }
  return assertJournalLinesBalanced(lines, reverse ? 'ابطال برگشت از خرید' : 'برگشت از خرید');
}

function costItemsFromMovements(movements) {
  return (movements || []).map((mv) => ({
    warehouseId: mv.warehouse_id != null ? mv.warehouse_id : mv.warehouseId,
    amountRial: Math.round(Number(mv.amount_rial != null ? mv.amount_rial : mv.amountRial) || 0),
  })).filter((x) => x.amountRial > 0);
}

function costItemsFromLedger(db, sourceType, sourceId) {
  const rows = db.prepare(`
    SELECT warehouse_id, amount_rial FROM inventory_ledger
    WHERE source_type=? AND source_id=? AND status='posted' AND COALESCE(reversed_of,0)=0
  `).all(sourceType, sourceId);
  return rows.map((r) => ({
    warehouseId: r.warehouse_id,
    amountRial: Math.round(Number(r.amount_rial) || 0),
  })).filter((x) => x.amountRial > 0);
}

module.exports = {
  settingFlag,
  proportionalVat,
  effectiveRialAmount,
  invoiceSourceVat,
  invoiceNetBase,
  buildSalesReturnJournalLines,
  buildPurchaseReturnJournalLines,
  costItemsFromMovements,
  costItemsFromLedger,
};
