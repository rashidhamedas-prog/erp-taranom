'use strict';
/**
 * Cash / immediate-pay helpers for sales invoices and purchase invoices.
 * Amounts are INTEGER rial. Overpay and missing cash box are HTTP 400.
 */

const IMMEDIATE_PAY = new Set(['cash', 'cheque', 'bank', 'bank_transfer']);

function moneyRial(v) {
  return Math.max(0, Math.round(Number(v) || 0));
}

function normalizePayType(pt) {
  const t = String(pt || '').trim();
  if (t === 'bank') return 'bank_transfer';
  return t;
}

function isImmediatePayType(pt) {
  const t = normalizePayType(pt);
  return IMMEDIATE_PAY.has(t) || t === 'bank';
}

/**
 * Resolve how much of `invoiceFinal` is paid immediately from the request body.
 * Empty/0 pay_amount on cash/cheque/bank means paid = final (full immediate).
 */
function resolveCashPaid(body, invoiceFinal) {
  const final = moneyRial(invoiceFinal);
  const b = body || {};
  const payType = normalizePayType(b.pay_type);
  const declared = b.pay_amount != null && b.pay_amount !== '' ? moneyRial(b.pay_amount) : null;
  let paid = 0;
  if (declared != null && declared > 0) paid = declared;
  else if (isImmediatePayType(payType)) paid = final;
  if (paid > final + 0.5) {
    const e = new Error('مبلغ پرداخت از مبلغ سند بیشتر است');
    e.status = 400;
    e.code = 'E_CASH_OVER_INVOICE';
    throw e;
  }
  return { paid, remainder: Math.max(0, final - paid), payType };
}

function assertCashBoxRequired(payType, cashBoxId) {
  if (normalizePayType(payType) === 'cash' && !cashBoxId) {
    const e = new Error('برای پرداخت نقدی انتخاب صندوق الزامی است');
    e.status = 400;
    e.code = 'E_CASH_BOX_REQUIRED';
    throw e;
  }
}

module.exports = {
  moneyRial,
  resolveCashPaid,
  assertCashBoxRequired,
  isImmediatePayType,
  IMMEDIATE_PAY,
};
