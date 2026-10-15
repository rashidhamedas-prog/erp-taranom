'use strict';
/**
 * Remit payroll liabilities: SSO (2105) and income tax (2106) to bank/cash.
 * Accrual already credited these; remittance clears the payable.
 * R13: void = soft-reverse JE + mark remittance reversed.
 */

const { postToLedger } = require('../ledger');
const { reverseJournalEntry } = require('../void-journal');
const { acct: coaAcct } = require('../coa-map');
const { todayJalali } = require('../../jalali');

function ensureRemittanceSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payroll_remittances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK(kind IN ('sso','tax')),
      amount_rial INTEGER NOT NULL DEFAULT 0,
      pay_type TEXT DEFAULT 'bank',
      bank_id INTEGER,
      cash_box_id INTEGER,
      date TEXT DEFAULT '',
      note TEXT DEFAULT '',
      period_label TEXT DEFAULT '',
      journal_id INTEGER,
      status TEXT NOT NULL DEFAULT 'posted'
        CHECK(status IN ('posted','reversed')),
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      reversed_at INTEGER,
      reversed_by INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_remittances_kind
      ON payroll_remittances(kind, status, date);
  `);
}

function liabilityBalanceRial(db, coaKey) {
  const acct = coaAcct(db, coaKey);
  const row = db.prepare(`
    SELECT COALESCE(SUM(jl.credit_rial),0) - COALESCE(SUM(jl.debit_rial),0) AS bal
    FROM journal_lines jl
    JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.account_code=?
      AND COALESCE(je.status,'posted') NOT IN ('reversed','void','cancelled')
      AND COALESCE(je.deleted_at,0)=0
  `).get(acct.code);
  return Math.max(0, Math.round(Number(row && row.bal) || 0));
}

function remittanceBalances(db) {
  return {
    sso_payable_rial: liabilityBalanceRial(db, 'coa_sso_payable'),
    tax_payable_rial: liabilityBalanceRial(db, 'coa_payroll_tax_payable'),
  };
}

function postRemittance(db, {
  kind,
  amount_rial,
  pay_type,
  bank_id,
  cash_box_id,
  date,
  note,
  period_label,
  userId,
  resolveCashAccount,
}) {
  const k = String(kind || '');
  if (k !== 'sso' && k !== 'tax') {
    throw Object.assign(new Error('نوع باید بیمه یا مالیات باشد'), { status: 400, code: 'E_REMIT_KIND' });
  }
  const amount = Math.round(Number(amount_rial) || 0);
  if (amount <= 0) {
    throw Object.assign(new Error('مبلغ باید بزرگ‌تر از صفر باشد'), { status: 400, code: 'E_REMIT_AMOUNT' });
  }
  const balances = remittanceBalances(db);
  const outstanding = k === 'sso' ? balances.sso_payable_rial : balances.tax_payable_rial;
  if (amount > outstanding + 1) {
    throw Object.assign(
      new Error(`مبلغ از مانده ${k === 'sso' ? 'بیمه' : 'مالیات'} (${outstanding.toLocaleString('fa-IR')} ریال) بیشتر است`),
      { status: 400, code: 'E_REMIT_OVER' }
    );
  }
  const liabilityKey = k === 'sso' ? 'coa_sso_payable' : 'coa_payroll_tax_payable';
  const liability = coaAcct(db, liabilityKey);
  const cash = resolveCashAccount(db, pay_type || 'bank', bank_id || null, cash_box_id || null);
  const payDate = date || todayJalali();
  const label = k === 'sso' ? 'بیمه تأمین اجتماعی' : 'مالیات حقوق';
  const sourceType = k === 'sso' ? 'payroll_sso_remittance' : 'payroll_tax_remittance';

  const journalId = postToLedger(db, {
    date: payDate,
    description: `پرداخت ${label}${period_label ? ` — ${period_label}` : ''} (${amount.toLocaleString('fa-IR')} ریال)`,
    sourceType,
    sourceId: 0,
    createdBy: userId,
    lines: [
      { ...liability, debit: amount / 10, credit: 0 },
      { code: cash.code, name: cash.name, debit: 0, credit: amount / 10 },
    ],
  });

  const info = db.prepare(`
    INSERT INTO payroll_remittances
      (kind, amount_rial, pay_type, bank_id, cash_box_id, date, note, period_label, journal_id, status, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,'posted',?)
  `).run(
    k, amount, pay_type || 'bank', bank_id || null, cash_box_id || null,
    payDate, note || '', period_label || '', journalId, userId
  );
  const id = info.lastInsertRowid;
  if (journalId) {
    try {
      db.prepare('UPDATE journal_entries SET source_id=? WHERE id=?').run(id, journalId);
    } catch (_) { /* optional */ }
  }
  return { id, journal_id: journalId, amount_rial: amount, kind: k, date: payDate, ...remittanceBalances(db) };
}

function voidRemittance(db, remittanceId, userId) {
  const row = db.prepare('SELECT * FROM payroll_remittances WHERE id=?').get(remittanceId);
  if (!row) throw Object.assign(new Error('سند پرداخت یافت نشد'), { status: 404 });
  if (row.status === 'reversed') {
    throw Object.assign(new Error('این سند قبلاً ابطال شده است'), { status: 400 });
  }
  if (row.journal_id) {
    reverseJournalEntry(db, row.journal_id, {
      userId,
      reason: `ابطال پرداخت ${row.kind === 'sso' ? 'بیمه' : 'مالیات حقوق'} #${row.id}`,
      sourceType: row.kind === 'sso' ? 'payroll_sso_remittance_reversal' : 'payroll_tax_remittance_reversal',
    });
  }
  db.prepare(`
    UPDATE payroll_remittances SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=?
    WHERE id=?
  `).run(userId, remittanceId);
  return { ok: true, id: remittanceId, ...remittanceBalances(db) };
}

function listRemittances(db, { kind, limit } = {}) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  if (kind === 'sso' || kind === 'tax') {
    return db.prepare(`
      SELECT * FROM payroll_remittances WHERE kind=? ORDER BY id DESC LIMIT ?
    `).all(kind, lim);
  }
  return db.prepare(`
    SELECT * FROM payroll_remittances ORDER BY id DESC LIMIT ?
  `).all(lim);
}

module.exports = {
  ensureRemittanceSchema,
  remittanceBalances,
  liabilityBalanceRial,
  postRemittance,
  voidRemittance,
  listRemittances,
};
