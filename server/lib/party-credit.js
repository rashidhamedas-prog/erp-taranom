'use strict';
/**
 * ADR-PARTY-001 — enforce parties.credit_limit (rial) on firm sales that raise AR.
 * limit <= 0 → unlimited. Exposure = max(0, customer_ledger debit−credit).
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

function customerArExposureRial(db, customerId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS bal
    FROM customer_ledger WHERE customer_id=?
  `).get(customerId);
  return Math.max(0, Math.round(Number(row?.bal) || 0));
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
  if (!(limit > 0)) return;
  const used = customerArExposureRial(db, customerId);
  const available = limit - used;
  if (add > available) {
    throw new PartyCreditError(
      `سقف اعتبار مشتری تمام شده است (سقف ${limit.toLocaleString('fa-IR')} ریال؛ مانده مصرف‌شده ${used.toLocaleString('fa-IR')}؛ این سند ${add.toLocaleString('fa-IR')})`,
      'E_CREDIT_LIMIT',
      { credit_limit_rial: limit, used_rial: used, additional_rial: add, available_rial: Math.max(0, available) }
    );
  }
}

module.exports = {
  PartyCreditError,
  customerArExposureRial,
  resolvePartyCreditLimitRial,
  invoiceArDeltaRial,
  assertPartyCreditLimitOk,
};
