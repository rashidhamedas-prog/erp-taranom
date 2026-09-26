/**
 * Bank reconciliation bridge.
 * Timing items (outstanding checks, deposits in transit) explain the
 * statement-vs-book gap and do not post. Bank charges and deposit interest
 * post to the bank's own subsidiary on close. Unclassified leftovers block close.
 */
'use strict';

const { acct } = require('./coa-map');
const { rialToLedger, SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('./money');

const ITEM_KINDS = new Set([
  'unclassified',
  'outstanding_check',
  'deposit_in_transit',
  'bank_charge',
  'bank_interest',
  'book_error',
]);

const TIMING_KINDS = new Set(['outstanding_check', 'deposit_in_transit']);
const POSTING_KINDS = new Set(['bank_charge', 'bank_interest', 'book_error']);

function normalizeKind(kind) {
  const k = String(kind || 'unclassified');
  return ITEM_KINDS.has(k) ? k : 'unclassified';
}

function assertJalaliDate(d) {
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(String(d || '').trim())) {
    const err = new Error('تاریخ باید به صورت YYYY/MM/DD باشد');
    err.status = 400;
    throw err;
  }
  return String(d).trim();
}

function assertRialBank(bank) {
  if (!bank) {
    const err = new Error('بانک یافت نشد');
    err.status = 400;
    throw err;
  }
  const cur = String(bank.currency || 'IRR').toUpperCase();
  if (Number(bank.is_foreign) === 1 || (cur !== 'IRR' && cur !== 'IRT' && cur !== 'TMN')) {
    const err = new Error('تطبیق ریالی فقط برای حساب بانک ریالی است');
    err.status = 400;
    throw err;
  }
  return bank;
}

function bankGlCode(bank) {
  if (bank && bank.coa_code) return String(bank.coa_code);
  return '1102-' + bank.id;
}

function computeBookBalance(db, bankId, asOfDate) {
  const bank = db.prepare('SELECT id, coa_code FROM banks WHERE id=?').get(bankId);
  if (!bank) return 0;
  const code = bankGlCode(bank);
  const row = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}), 0) bal
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE (jl.account_code = ? OR jl.account_code LIKE ?)
      AND COALESCE(je.deleted_at, 0) = 0
      AND COALESCE(je.status, 'posted') NOT IN ('reversed', 'void')
      AND (? = '' OR je.entry_date <= ?)
  `).get(code, code + '-%', asOfDate || '', asOfDate || '');
  return Math.round(row?.bal || 0);
}

function resolveBankPostingAccount(db, bankId) {
  const bank = db.prepare('SELECT id, name, coa_code, is_foreign, currency FROM banks WHERE id=?').get(bankId);
  assertRialBank(bank);
  const code = bankGlCode(bank);
  let acc = db.prepare('SELECT code, name FROM chart_of_accounts WHERE code=?').get(code);
  if (!acc) {
    const err = new Error('حساب تفصیلی این بانک در دفتر کل نیست؛ ابتدا کد حساب بانک را وصل کنید');
    err.status = 400;
    throw err;
  }
  return { bank, account: acc };
}

function ensureBankReconAccounts(db) {
  const rows = [
    ['6115', 'کارمزد خدمات بانکی', 'expense', '6000', 2],
    ['4115', 'سود سپرده بانکی', 'revenue', '4000', 2],
  ];
  const cols = db.prepare('PRAGMA table_info(chart_of_accounts)').all().map((c) => c.name);
  const hasLevel = cols.includes('level');
  const hasActive = cols.includes('is_active');
  const ins = hasLevel
    ? db.prepare(`INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level${hasActive ? ',is_active' : ''}) VALUES (?,?,?,?,?${hasActive ? ',1' : ''})`)
    : db.prepare(`INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code${hasActive ? ',is_active' : ''}) VALUES (?,?,?,?${hasActive ? ',1' : ''})`);
  for (const [code, name, type, parent, level] of rows) {
    if (hasLevel) ins.run(code, name, type, parent, level);
    else ins.run(code, name, type, parent);
  }
}

/**
 * @param {number} statementBalance
 * @param {number} bookBalance
 * @param {Array} items active recon items (voided rows already removed)
 */
function computeBridge(statementBalance, bookBalance, items) {
  let depositsInTransit = 0;
  let outstandingChecks = 0;
  let bankCharges = 0;
  let bankInterest = 0;
  let bookError = 0;
  let unclassified = 0;
  for (const it of items || []) {
    if (Number(it.matched)) continue;
    if (Number(it.voided)) continue;
    const kind = normalizeKind(it.item_kind);
    const abs = Math.abs(Math.round(Number(it.amount_rial) || 0));
    if (!abs) continue;
    if (kind === 'deposit_in_transit') depositsInTransit += abs;
    else if (kind === 'outstanding_check') outstandingChecks += abs;
    else if (kind === 'bank_charge') bankCharges += abs;
    else if (kind === 'bank_interest') bankInterest += abs;
    else if (kind === 'book_error') bookError += Math.round(Number(it.amount_rial) || 0);
    else unclassified += abs;
  }
  const statement = Math.round(Number(statementBalance) || 0);
  const book = Math.round(Number(bookBalance) || 0);
  const adjustedStatement = statement + depositsInTransit - outstandingChecks;
  const adjustedBook = book + bankInterest - bankCharges + bookError;
  const unexplained = adjustedStatement - adjustedBook;
  return {
    statement_balance_rial: statement,
    book_balance_rial: book,
    deposits_in_transit_rial: depositsInTransit,
    outstanding_checks_rial: outstandingChecks,
    bank_charges_rial: bankCharges,
    bank_interest_rial: bankInterest,
    book_error_rial: bookError,
    unclassified_rial: unclassified,
    adjusted_statement_rial: adjustedStatement,
    adjusted_book_rial: adjustedBook,
    unexplained_rial: unexplained,
    can_close: unclassified === 0 && unexplained === 0,
  };
}

function adjustmentLines(db, bankAccount, items) {
  ensureBankReconAccounts(db);
  const fee = acct(db, 'coa_bank_fee');
  const interest = acct(db, 'coa_bank_interest');
  const lines = [];
  for (const it of items || []) {
    if (Number(it.matched) || Number(it.voided)) continue;
    const kind = normalizeKind(it.item_kind);
    if (!POSTING_KINDS.has(kind)) continue;
    const signed = Math.round(Number(it.amount_rial) || 0);
    const abs = Math.abs(signed);
    if (!abs) continue;
    const amt = rialToLedger(abs);
    if (kind === 'bank_charge' || (kind === 'book_error' && signed < 0)) {
      lines.push({ code: fee.code, name: fee.name, debit: amt, credit: 0 });
      lines.push({ code: bankAccount.code, name: bankAccount.name, debit: 0, credit: amt });
    } else if (kind === 'bank_interest' || (kind === 'book_error' && signed > 0)) {
      lines.push({ code: bankAccount.code, name: bankAccount.name, debit: amt, credit: 0 });
      lines.push({ code: interest.code, name: interest.name, debit: 0, credit: amt });
    }
  }
  return lines;
}

module.exports = {
  ITEM_KINDS,
  TIMING_KINDS,
  POSTING_KINDS,
  normalizeKind,
  assertJalaliDate,
  assertRialBank,
  bankGlCode,
  computeBookBalance,
  resolveBankPostingAccount,
  ensureBankReconAccounts,
  computeBridge,
  adjustmentLines,
};
