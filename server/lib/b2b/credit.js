'use strict';

/**
 * B2B credit engine — reserve / release / consume.
 * available = limit - used - reserved
 *
 * Concurrent safety: callers run inside db.transaction() (BEGIN IMMEDIATE in
 * better-sqlite3). We SELECT company state, recompute from ledger, then UPDATE
 * the company row (optimistic touch) before inserting the ledger line so a
 * racing writer cannot commit an overlapping over-reserve.
 */

class CreditError extends Error {
  constructor(message, code = 'CREDIT_ERROR') {
    super(message);
    this.name = 'CreditError';
    this.code = code;
  }
}

function sumKinds(db, companyId) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN kind='reserve' THEN delta_rial ELSE 0 END), 0) AS reserved_in,
      COALESCE(SUM(CASE WHEN kind='release' THEN delta_rial ELSE 0 END), 0) AS released,
      COALESCE(SUM(CASE WHEN kind='consume' THEN delta_rial ELSE 0 END), 0) AS consumed
    FROM b2b_credit_ledger
    WHERE company_id=?
  `).get(companyId);
  const reservedIn = Math.max(0, Math.round(Number(row?.reserved_in) || 0));
  const released = Math.max(0, Math.round(Number(row?.released) || 0));
  const consumed = Math.max(0, Math.round(Number(row?.consumed) || 0));
  const reserved = Math.max(0, reservedIn - released - consumed);
  const used = consumed;
  return { reserved, used, reservedIn, released, consumed };
}

function getCompanyLocked(db, companyId, { requireActive = true } = {}) {
  const company = db.prepare(`
    SELECT id, customer_id, name, credit_limit_rial, active
    FROM b2b_companies WHERE id=?
  `).get(companyId);
  if (!company) {
    throw new CreditError('شرکت B2B یافت نشد', 'COMPANY_NOT_FOUND');
  }
  if (requireActive && !company.active) {
    throw new CreditError('شرکت B2B فعال یافت نشد', 'COMPANY_INACTIVE');
  }
  return company;
}

function touchCompany(db, company) {
  // SELECT-then-UPDATE: serialize writers on this row; reject if limit changed mid-flight.
  const upd = db.prepare(`
    UPDATE b2b_companies
    SET credit_limit_rial=credit_limit_rial
    WHERE id=? AND active=1 AND credit_limit_rial=?
  `).run(company.id, company.credit_limit_rial);
  if (upd.changes !== 1) {
    throw new CreditError('تداخل همزمانی اعتبار — دوباره تلاش کنید', 'CREDIT_CONFLICT');
  }
}

function getCreditSnapshot(db, companyId) {
  const company = getCompanyLocked(db, companyId, { requireActive: false });
  const { reserved, used } = sumKinds(db, companyId);
  const limit = Math.max(0, Math.round(Number(company.credit_limit_rial) || 0));
  const available = company.active ? (limit - used - reserved) : 0;
  return {
    company_id: company.id,
    customer_id: company.customer_id,
    name: company.name,
    active: !!company.active,
    credit_limit_rial: limit,
    used_rial: used,
    reserved_rial: reserved,
    available_rial: available,
  };
}

function assertPositiveAmount(amountRial) {
  const amount = Math.round(Number(amountRial) || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new CreditError('مبلغ اعتبار نامعتبر است', 'INVALID_AMOUNT');
  }
  return amount;
}

function insertLedger(db, companyId, orderId, deltaRial, kind) {
  const ins = db.prepare(`
    INSERT INTO b2b_credit_ledger (company_id, order_id, delta_rial, kind)
    VALUES (?,?,?,?)
  `).run(companyId, orderId || null, deltaRial, kind);
  return ins.lastInsertRowid;
}

function reservedForOrder(db, companyId, orderId) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN kind='reserve' THEN delta_rial ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN kind='release' THEN delta_rial ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN kind='consume' THEN delta_rial ELSE 0 END), 0) AS open_reserved
    FROM b2b_credit_ledger
    WHERE company_id=? AND order_id=?
  `).get(companyId, orderId);
  return Math.max(0, Math.round(Number(row?.open_reserved) || 0));
}

/**
 * Hold credit for an open portal order. Must run inside db.transaction().
 */
function reserveCredit(db, { companyId, orderId, amountRial }) {
  const amount = assertPositiveAmount(amountRial);
  const company = getCompanyLocked(db, companyId);
  const { reserved, used } = sumKinds(db, companyId);
  const limit = Math.max(0, Math.round(Number(company.credit_limit_rial) || 0));
  const available = limit - used - reserved;
  if (amount > available) {
    throw new CreditError(
      `اعتبار کافی نیست (موجود: ${available.toLocaleString('fa-IR')} ریال)`,
      'INSUFFICIENT_CREDIT'
    );
  }
  touchCompany(db, company);
  const ledgerId = insertLedger(db, companyId, orderId, amount, 'reserve');
  return { ledgerId, amount, available_after: available - amount };
}

/**
 * Release previously reserved credit (cancel / reduce). Must run inside db.transaction().
 */
function releaseCredit(db, { companyId, orderId, amountRial }) {
  const company = getCompanyLocked(db, companyId);
  let amount;
  if (amountRial == null) {
    amount = reservedForOrder(db, companyId, orderId);
    if (amount <= 0) return { ledgerId: null, amount: 0, skipped: true };
  } else {
    amount = assertPositiveAmount(amountRial);
  }
  const open = reservedForOrder(db, companyId, orderId);
  if (amount > open) {
    throw new CreditError('مبلغ آزادسازی بیشتر از رزرو سفارش است', 'RELEASE_EXCEEDS_RESERVE');
  }
  touchCompany(db, company);
  const ledgerId = insertLedger(db, companyId, orderId, amount, 'release');
  return { ledgerId, amount };
}

/**
 * Convert reserved credit into used (fulfill / final invoice). Must run inside db.transaction().
 */
function consumeCredit(db, { companyId, orderId, amountRial }) {
  const amount = assertPositiveAmount(amountRial);
  const company = getCompanyLocked(db, companyId);
  const open = reservedForOrder(db, companyId, orderId);
  if (amount > open) {
    throw new CreditError('مبلغ مصرف بیشتر از رزرو سفارش است', 'CONSUME_EXCEEDS_RESERVE');
  }
  touchCompany(db, company);
  const ledgerId = insertLedger(db, companyId, orderId, amount, 'consume');
  return { ledgerId, amount };
}

module.exports = {
  CreditError,
  getCreditSnapshot,
  reserveCredit,
  releaseCredit,
  consumeCredit,
  reservedForOrder,
  sumKinds,
};
