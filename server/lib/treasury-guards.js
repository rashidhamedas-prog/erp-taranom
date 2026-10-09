'use strict';
/**
 * Treasury professional guards (ADR-TREASURY-001 Option 1).
 * - Active bank/cash on mutating ops
 * - IBAN (شبا) normalize + validate when provided
 * - Bank overdraft_limit_rial (NULL=unlimited, 0=no negative, >0=floor −limit)
 * - Cash float_ceiling_rial on inbound transfers (NULL=unlimited)
 */

const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('./money');

function httpErr(status, message, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

function normalizeSheba(raw) {
  let s = String(raw || '').replace(/\s+/g, '').toUpperCase();
  s = s.replace(/[^\dA-Z]/g, '');
  if (/^\d{24}$/.test(s)) s = 'IR' + s;
  return s;
}

function assertValidSheba(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const n = normalizeSheba(s);
  if (!/^IR\d{24}$/.test(n)) {
    throw httpErr(400, 'شبا باید به صورت IR و ۲۴ رقم باشد', 'E_SHEBA');
  }
  return n;
}

function glBalanceOnCode(db, accountCode) {
  const code = String(accountCode || '').trim();
  if (!code) return 0;
  try {
    const row = db.prepare(`
      SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}), 0) AS bal
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.account_code = ?
        AND COALESCE(je.deleted_at,0)=0
        AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
    `).get(code);
    return Math.round(Number(row && row.bal) || 0);
  } catch (_) {
    return 0;
  }
}

function bankJoinCode(bank) {
  const code = String(bank && bank.coa_code || '').trim();
  return code || ('1102-' + bank.id);
}

function cashJoinCode(box) {
  const code = String(box && box.coa_code || '').trim();
  return code || ('1101-' + box.id);
}

function assertActiveBank(db, bankId, { allowNull = false } = {}) {
  if (bankId == null || bankId === '') {
    if (allowNull) return null;
    throw httpErr(400, 'بانک را انتخاب کنید', 'E_BANK');
  }
  const bank = db.prepare('SELECT * FROM banks WHERE id=?').get(bankId);
  if (!bank) throw httpErr(400, 'بانک یافت نشد', 'E_BANK');
  if (!Number(bank.active)) throw httpErr(400, 'این بانک غیرفعال است', 'E_BANK_INACTIVE');
  return bank;
}

function assertActiveCashBox(db, cashBoxId, { allowNull = false } = {}) {
  if (cashBoxId == null || cashBoxId === '') {
    if (allowNull) return null;
    throw httpErr(400, 'صندوق را انتخاب کنید', 'E_CASH_BOX');
  }
  const box = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(cashBoxId);
  if (!box) throw httpErr(400, 'صندوق یافت نشد', 'E_CASH_BOX');
  if (!Number(box.active)) throw httpErr(400, 'این صندوق غیرفعال است', 'E_CASH_INACTIVE');
  return box;
}

/**
 * Before crediting a bank (outflow), ensure live balance − outRial stays within overdraft policy.
 */
function assertBankOverdraftOk(db, bankId, outRial) {
  const out = Math.round(Number(outRial) || 0);
  if (out <= 0 || !bankId) return;
  const bank = db.prepare('SELECT * FROM banks WHERE id=?').get(bankId);
  if (!bank) return;
  if (bank.overdraft_limit_rial == null || bank.overdraft_limit_rial === '') return;
  const limit = Math.max(0, Math.round(Number(bank.overdraft_limit_rial) || 0));
  const bal = glBalanceOnCode(db, bankJoinCode(bank));
  const after = bal - out;
  const floor = -limit;
  if (after < floor) {
    throw httpErr(
      409,
      limit === 0
        ? `مانده بانک «${bank.name}» کافی نیست (مانده ${bal.toLocaleString('fa-IR')} ریال)`
        : `برداشت از سقف اضافه برداشت بانک «${bank.name}» بیشتر است`,
      'E_OVERDRAFT'
    );
  }
}

/**
 * Before debiting a cash box (inflow transfer), ensure live balance + inRial ≤ float_ceiling when set.
 */
function assertCashFloatCeilingOk(db, cashBoxId, inRial) {
  const inn = Math.round(Number(inRial) || 0);
  if (inn <= 0 || !cashBoxId) return;
  const box = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(cashBoxId);
  if (!box) return;
  if (box.float_ceiling_rial == null || box.float_ceiling_rial === '') return;
  const ceiling = Math.max(0, Math.round(Number(box.float_ceiling_rial) || 0));
  const bal = glBalanceOnCode(db, cashJoinCode(box));
  if (bal + inn > ceiling) {
    throw httpErr(
      409,
      `مانده صندوق «${box.name}» از سقف تنخواه/نقد (${ceiling.toLocaleString('fa-IR')} ریال) بیشتر می‌شود`,
      'E_FLOAT_CEILING'
    );
  }
}

module.exports = {
  normalizeSheba,
  assertValidSheba,
  glBalanceOnCode,
  bankJoinCode,
  cashJoinCode,
  assertActiveBank,
  assertActiveCashBox,
  assertBankOverdraftOk,
  assertCashFloatCeilingOk,
  httpErr,
};
