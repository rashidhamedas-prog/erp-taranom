'use strict';
/**
 * ADR-PARTY-001 — enforce parties.credit_limit (rial) on firm sales that raise AR.
 * limit <= 0 → unlimited. Exposure = max(0, canonical live customer balance) (v649).
 */

class PartyCreditError extends Error {
  constructor(message, code = 'E_CREDIT_LIMIT', extra = {}) {
    super(message);
    this.name = 'PartyCreditError';
    this.code = code;
    this.status = 409;
    Object.assign(this, extra);
  }
}

/**
 * v649 — exposure = max(0, canonical live balance) — same number as «صورت‌حساب مشتری»
 * (live customer_ledger + firm invoices missing from it). Create/convert call the
 * gate BEFORE inserting the invoice, and a proforma is not a firm sale, so the
 * missing-invoice add can never double-count the document being checked.
 */
function customerArExposureRial(db, customerId) {
  const { customerLiveBalanceRial } = require('./customer-books'); // lazy: avoid require cycle
  return Math.max(0, Math.round(Number(customerLiveBalanceRial(db, customerId)) || 0));
}

/**
 * P6: `customers.credit_limit_rial` (NULL = no per-customer ceiling → party/legacy limit applies;
 * a number — including 0 — IS the ceiling). Returns { limit, source } or null.
 */
function customerCeilingRial(db, customerId) {
  try {
    const r = db.prepare('SELECT credit_limit_rial FROM customers WHERE id=?').get(customerId);
    if (r && r.credit_limit_rial != null && r.credit_limit_rial !== '') {
      return Math.max(0, Math.round(Number(r.credit_limit_rial) || 0));
    }
  } catch (_) { /* column lags on very old DBs */ }
  return null;
}

function resolvePartyCreditLimitRial(db, customerId) {
  let c;
  try {
    c = db.prepare('SELECT id, party_id, credit_limit FROM customers WHERE id=?').get(customerId);
  } catch (_) {
    c = db.prepare('SELECT id, party_id FROM customers WHERE id=?').get(customerId);
  }
  if (!c) {
    throw new PartyCreditError('مشتری یافت نشد', 'E_CUSTOMER_NOT_FOUND');
  }
  const ceiling = customerCeilingRial(db, customerId);
  if (ceiling != null) return ceiling;
  if (c.party_id) {
    const p = db.prepare('SELECT credit_limit FROM parties WHERE id=?').get(c.party_id);
    const fromParty = Math.round(Number(p?.credit_limit) || 0);
    if (fromParty > 0) return fromParty;
  }
  return Math.round(Number(c.credit_limit) || 0);
}

/** Unpaid portion of this invoice that will sit on AR after create/convert. */
function invoiceArDeltaRial(finalRial, payPlan, storedPayType) {
  const finalAmt = Math.round(Number(finalRial) || 0);
  if (finalAmt <= 0) return 0;
  const splits = (payPlan && payPlan.splits) || [];
  if (splits.length) {
    const paid = splits.reduce((s, x) => s + Math.round(Number(x.amount) || 0), 0);
    return Math.max(0, finalAmt - paid);
  }
  const pt = String(storedPayType || 'cash');
  if (pt === 'credit') return finalAmt;
  return 0;
}

/**
 * @param {number} additionalRial — new AR from this document (rial)
 */
function assertPartyCreditLimitOk(db, customerId, additionalRial) {
  const add = Math.round(Number(additionalRial) || 0);
  if (!(add > 0)) return;
  const limit = resolvePartyCreditLimitRial(db, customerId);
  const ownCeiling = customerCeilingRial(db, customerId) != null;
  if (!ownCeiling && !(limit > 0)) return; // legacy: 0 = unlimited
  const used = customerArExposureRial(db, customerId);
  const available = limit - used;
  if (add > available) {
    const err = new PartyCreditError(
      `سقف اعتبار مشتری تمام شده است (سقف ${limit.toLocaleString('fa-IR')} ریال؛ مانده مصرف‌شده ${used.toLocaleString('fa-IR')}؛ این سند ${add.toLocaleString('fa-IR')})`,
      'E_CREDIT_LIMIT',
      {
        credit_limit_rial: limit, used_rial: used, additional_rial: add, available_rial: Math.max(0, available),
        limit, balance: used,
      }
    );
    // P6 contract: per-customer ceiling answers 422 {limit, balance}; legacy party limit stays 409.
    if (ownCeiling) err.status = 422;
    throw err;
  }
}

module.exports = {
  PartyCreditError,
  customerArExposureRial,
  customerCeilingRial,
  resolvePartyCreditLimitRial,
  invoiceArDeltaRial,
  assertPartyCreditLimitOk,
};
