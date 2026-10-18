/**
 * Return discounts (Iran 1405 / Moadian-aligned + ERPNext proportional header).
 * Line price & line discount locked from reference; header disc_amt prorated by qty;
 * optional extra document discount on the return itself.
 *
 * Money: integer rial. amount (persisted) = net after all discounts (before VAT).
 */
'use strict';

const { parseMoneyInput } = require('./money');

function rial(n) {
  if (typeof n === 'string' && /[,\u066C\u060C]/.test(n)) {
    return Math.round(parseMoneyInput(n) || 0);
  }
  return Math.round(Number(n) || 0);
}

function lineOrigDiscAmt(origLine) {
  if (!origLine) return 0;
  const fixed = origLine.disc_amt != null ? origLine.disc_amt
    : (origLine.disc_amount != null ? origLine.disc_amount : null);
  if (fixed != null && Number(fixed) > 0) return rial(fixed);
  const qty = Number(origLine.qty) || 0;
  const price = Number(origLine.price) || 0;
  const disc = Number(origLine.disc) || 0;
  if (qty > 0 && price > 0 && disc > 0) return rial(qty * price * disc / 100);
  return 0;
}

/**
 * Proportional line discount with remainder on last slice of the line.
 * @returns {{ discAmt: number, discPct: number }}
 */
function prorateLineDiscount(origLine, qtyReturned, qtyAlreadyReturned) {
  const Q = Number(origLine.qty) || 0;
  const D = lineOrigDiscAmt(origLine);
  const q = Number(qtyReturned) || 0;
  const prior = Number(qtyAlreadyReturned) || 0;
  const price = Number(origLine.price) || 0;
  const discPct = Number(origLine.disc) || 0;
  if (Q <= 0 || q <= 0 || D <= 0) {
    return { discAmt: 0, discPct };
  }
  const remainingQty = Math.max(0, Q - prior);
  const alreadyDisc = Math.min(D, rial(D * prior / Q));
  let discAmt;
  if (q + 1e-9 >= remainingQty) {
    discAmt = Math.max(0, D - alreadyDisc);
  } else {
    discAmt = rial(D * q / Q);
  }
  if (!discPct && price > 0 && q > 0) {
    const gross = q * price;
    return { discAmt, discPct: gross > 0 ? Math.round((discAmt / gross) * 10000) / 100 : 0 };
  }
  return { discAmt, discPct };
}

/**
 * Prior returns' consumed header discount for one source invoice.
 * Legacy returns (no hdr_disc_amt): estimate as disc_amt × (return goods / invoice subtotal).
 */
function priorHeaderDiscConsumed(db, {
  table, invoiceCol, invoiceId, invoiceDiscAmt, invoiceSubtotal, excludeReturnId = null,
}) {
  const H0 = rial(invoiceDiscAmt);
  const B = rial(invoiceSubtotal);
  if (H0 <= 0 || B <= 0) return 0;
  const rows = db.prepare(
    `SELECT id, amount, goods_amount, hdr_disc_amt, rows FROM ${table}
     WHERE ${invoiceCol}=? AND COALESCE(status,'posted')<>'reversed'`
  ).all(invoiceId);
  let used = 0;
  for (const pr of rows) {
    if (excludeReturnId && Number(pr.id) === Number(excludeReturnId)) continue;
    if (pr.hdr_disc_amt != null && pr.hdr_disc_amt !== '') {
      used += rial(pr.hdr_disc_amt);
      continue;
    }
    const goods = rial(pr.goods_amount) || rial(pr.amount);
    used += rial(H0 * goods / B);
  }
  return Math.min(H0, used);
}

/**
 * Allocate header discount share for this return from goods net A.
 * Caps by remaining header discount; remainder absorbed when returning all leftover goods.
 */
function allocateHeaderDiscount({
  invoiceDiscAmt, invoiceSubtotal, goodsAmountA, priorHdrUsed, remainingGoodsOnInvoice,
}) {
  const H0 = rial(invoiceDiscAmt);
  const B = rial(invoiceSubtotal);
  const A = rial(goodsAmountA);
  if (H0 <= 0 || B <= 0 || A <= 0) return 0;
  const remainingH = Math.max(0, H0 - rial(priorHdrUsed));
  if (remainingH <= 0) return 0;
  let share = rial(H0 * A / B);
  share = Math.min(share, remainingH);
  const remGoods = Number(remainingGoodsOnInvoice);
  if (Number.isFinite(remGoods) && remGoods > 0 && A + 1e-6 >= remGoods) {
    share = remainingH;
  }
  return Math.min(share, A);
}

/**
 * Resolve extra discount: amount wins over pct (invoice UX parity).
 * Cap at maxBase = A - H.
 */
function resolveExtraDiscount({ extraDiscAmt, extraDiscPct, maxBase }) {
  const cap = Math.max(0, rial(maxBase));
  let X = 0;
  // Prefer digit-strip parse so "1,000,000" from UI is not Number→NaN / parseFloat→1.
  const amt = (typeof extraDiscAmt === 'string')
    ? parseMoneyInput(extraDiscAmt)
    : Number(extraDiscAmt);
  const pct = Number(extraDiscPct);
  if (Number.isFinite(amt) && amt > 0) {
    X = rial(amt);
  } else if (Number.isFinite(pct) && pct > 0 && cap > 0) {
    X = rial(cap * pct / 100);
  }
  if (X > cap) {
    const e = new Error('تخفیف کلی برگشت بیشتر از مبلغ خالص پس از تخفیف فاکتور است');
    e.status = 400;
    e.code = 'E_RET_EXTRA_DISC';
    throw e;
  }
  return { extraAmt: X, extraPct: (Number.isFinite(pct) && pct > 0) ? pct : (cap > 0 ? Math.round((X / cap) * 10000) / 100 : 0) };
}

/**
 * VAT base for linked return after discounts (goods net − header − extra).
 * Prefer proportional on (final−vat) using post-discount net so header disc is not over-VAT'd.
 */
function computeReturnVat({
  settingOn, sourceVat, sourceNetBase, returnedNetAfterAllDisc, remainingVat = null,
}) {
  if (!settingOn) return 0;
  const sn = rial(sourceNetBase);
  const rn = rial(returnedNetAfterAllDisc);
  const sv = rial(sourceVat);
  if (sn <= 0 || rn <= 0 || sv <= 0) return 0;
  let v = Math.round(sv * Math.min(1, rn / sn));
  if (remainingVat != null && Number.isFinite(Number(remainingVat))) {
    v = Math.min(v, Math.max(0, rial(remainingVat)));
  }
  return v;
}

function priorVatConsumed(db, {
  table, invoiceCol, invoiceId, excludeReturnId = null,
}) {
  const rows = db.prepare(
    `SELECT id, vat_amount FROM ${table}
     WHERE ${invoiceCol}=? AND COALESCE(status,'posted')<>'reversed'`
  ).all(invoiceId);
  let used = 0;
  for (const pr of rows) {
    if (excludeReturnId && Number(pr.id) === Number(excludeReturnId)) continue;
    used += rial(pr.vat_amount);
  }
  return used;
}

/**
 * Build totals from line goods net A + invoice header + extra.
 */
function computeReturnTotals({
  goodsAmountA,
  invoiceDiscAmt,
  invoiceSubtotal,
  priorHdrUsed,
  remainingGoodsOnInvoice,
  extraDiscAmt,
  extraDiscPct,
  sourceVat,
  sourceNetBase,
  vatSettingOn,
  priorVatUsed,
}) {
  const A = rial(goodsAmountA);
  const H = allocateHeaderDiscount({
    invoiceDiscAmt,
    invoiceSubtotal,
    goodsAmountA: A,
    priorHdrUsed,
    remainingGoodsOnInvoice,
  });
  const { extraAmt: X, extraPct } = resolveExtraDiscount({
    extraDiscAmt,
    extraDiscPct,
    maxBase: A - H,
  });
  const N = Math.max(0, A - H - X);
  const remainingVat = sourceVat != null
    ? Math.max(0, rial(sourceVat) - rial(priorVatUsed))
    : null;
  const V = computeReturnVat({
    settingOn: vatSettingOn,
    sourceVat,
    sourceNetBase,
    returnedNetAfterAllDisc: N,
    remainingVat,
  });
  return {
    goodsAmount: A,
    hdrDiscAmt: H,
    extraDiscAmt: X,
    extraDiscPct: extraPct,
    amount: N,
    vatAmount: V,
    gross: N + V,
  };
}

/** Read persisted money parts (legacy-safe). */
function returnMoneyParts(row) {
  const amount = rial(row && row.amount);
  const vat = rial(row && row.vat_amount);
  const hdr = rial(row && row.hdr_disc_amt);
  const extra = rial(row && row.extra_disc_amt);
  const goods = (row && row.goods_amount != null && row.goods_amount !== '')
    ? rial(row.goods_amount)
    : (amount + hdr + extra);
  return {
    goodsAmount: goods,
    hdrDiscAmt: hdr,
    extraDiscAmt: extra,
    amountNet: amount,
    vatAmount: vat,
    gross: amount + vat,
    discTotal: hdr + extra,
  };
}

module.exports = {
  rial,
  lineOrigDiscAmt,
  prorateLineDiscount,
  priorHeaderDiscConsumed,
  allocateHeaderDiscount,
  resolveExtraDiscount,
  computeReturnVat,
  priorVatConsumed,
  computeReturnTotals,
  returnMoneyParts,
};
