'use strict';
/**
 * Employee loans with fixed installments (وام اقساطی کارکنان).
 * Issue JE same as advance: Dr coa_employee_advance (1119) / Cr bank|cash
 * Monthly recovery on payroll process: Cr 1119 (same path as advances).
 * R13: void issue only if no recovery; void payroll reopens installments.
 */

const { postToLedger } = require('../ledger');
const { reverseJournalEntry } = require('../void-journal');
const { acct: coaAcct } = require('../coa-map');
const { todayJalali } = require('../../jalali');

function ensureLoansSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payroll_loans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL,
      principal_rial INTEGER NOT NULL DEFAULT 0,
      installment_count INTEGER NOT NULL DEFAULT 1,
      installment_rial INTEGER NOT NULL DEFAULT 0,
      recovered_rial INTEGER NOT NULL DEFAULT 0,
      pay_type TEXT DEFAULT 'cash',
      bank_id INTEGER,
      cash_box_id INTEGER,
      start_period_label TEXT DEFAULT '',
      date TEXT DEFAULT '',
      note TEXT DEFAULT '',
      journal_id INTEGER,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK(status IN ('open','closed','reversed')),
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      reversed_at INTEGER,
      reversed_by INTEGER,
      FOREIGN KEY(person_id) REFERENCES persons(id)
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_loans_person
      ON payroll_loans(person_id, status);

    CREATE TABLE IF NOT EXISTS payroll_loan_installments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loan_id INTEGER NOT NULL,
      seq INTEGER NOT NULL DEFAULT 1,
      due_period_label TEXT NOT NULL,
      amount_rial INTEGER NOT NULL DEFAULT 0,
      paid_rial INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','paid','partial','waived')),
      payroll_record_id INTEGER,
      paid_at INTEGER,
      FOREIGN KEY(loan_id) REFERENCES payroll_loans(id)
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_loan_inst_due
      ON payroll_loan_installments(due_period_label, status);
    CREATE INDEX IF NOT EXISTS idx_payroll_loan_inst_loan
      ON payroll_loan_installments(loan_id, seq);

    CREATE TABLE IF NOT EXISTS payroll_loan_recoveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loan_id INTEGER NOT NULL,
      installment_id INTEGER NOT NULL,
      payroll_record_id INTEGER NOT NULL,
      amount_rial INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(loan_id) REFERENCES payroll_loans(id),
      FOREIGN KEY(installment_id) REFERENCES payroll_loan_installments(id)
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_loan_recoveries_rec
      ON payroll_loan_recoveries(payroll_record_id);
    CREATE INDEX IF NOT EXISTS idx_payroll_loan_recoveries_inst
      ON payroll_loan_recoveries(installment_id);
  `);
}

function nextPeriodLabel(label, addMonths) {
  const m = String(label || '').match(/^(\d{4})\/(\d{1,2})/);
  if (!m) return label || '';
  let y = parseInt(m[1], 10);
  let mo = parseInt(m[2], 10) + (addMonths || 0);
  while (mo > 12) { mo -= 12; y += 1; }
  while (mo < 1) { mo += 12; y -= 1; }
  return `${y}/${String(mo).padStart(2, '0')}`;
}

function outstandingLoanRial(row) {
  if (!row || row.status === 'reversed' || row.status === 'closed') return 0;
  return Math.max(0, Math.round(Number(row.principal_rial) || 0) - Math.round(Number(row.recovered_rial) || 0));
}

function personLoanBalance(db, personId) {
  ensureLoansSchema(db);
  const rows = db.prepare(`
    SELECT * FROM payroll_loans WHERE person_id=? AND status='open' ORDER BY id ASC
  `).all(personId);
  return rows.reduce((s, r) => s + outstandingLoanRial(r), 0);
}

function dueInstallmentRial(db, personId, periodLabel) {
  ensureLoansSchema(db);
  const label = String(periodLabel || '').trim();
  if (!label) return 0;
  const row = db.prepare(`
    SELECT COALESCE(SUM(i.amount_rial - i.paid_rial), 0) AS due
    FROM payroll_loan_installments i
    JOIN payroll_loans l ON l.id=i.loan_id
    WHERE l.person_id=? AND l.status='open'
      AND i.status IN ('pending','partial')
      AND i.due_period_label <= ?
      AND (i.amount_rial - i.paid_rial) > 0
  `).get(personId, label);
  return Math.max(0, Math.round(Number(row?.due) || 0));
}

function listLoans(db, { person_id, limit } = {}) {
  ensureLoansSchema(db);
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  if (person_id) {
    return db.prepare(`
      SELECT l.*, p.name person_name,
             (l.principal_rial - l.recovered_rial) AS remaining_rial
      FROM payroll_loans l
      JOIN persons p ON p.id=l.person_id
      WHERE l.person_id=?
      ORDER BY l.id DESC LIMIT ?
    `).all(Number(person_id), lim);
  }
  return db.prepare(`
    SELECT l.*, p.name person_name,
           (l.principal_rial - l.recovered_rial) AS remaining_rial
    FROM payroll_loans l
    JOIN persons p ON p.id=l.person_id
    ORDER BY l.id DESC LIMIT ?
  `).all(lim);
}

function listLoanInstallments(db, loanId) {
  ensureLoansSchema(db);
  return db.prepare(`
    SELECT * FROM payroll_loan_installments WHERE loan_id=? ORDER BY seq ASC
  `).all(loanId);
}

function issueLoan(db, {
  person_id,
  principal_rial,
  installment_count,
  start_period_label,
  pay_type,
  bank_id,
  cash_box_id,
  date,
  note,
  userId,
  resolveCashAccount,
  createPersonLedgerEntry,
}) {
  ensureLoansSchema(db);
  const personId = Number(person_id);
  const person = db.prepare('SELECT * FROM persons WHERE id=? AND active=1').get(personId);
  if (!person) throw Object.assign(new Error('کارمند یافت نشد'), { status: 404 });
  const principal = Math.round(Number(principal_rial) || 0);
  const count = Math.max(1, Math.min(120, Math.round(Number(installment_count) || 1)));
  if (principal <= 0) {
    throw Object.assign(new Error('مبلغ وام باید بزرگ‌تر از صفر باشد'), { status: 400 });
  }
  const baseInst = Math.floor(principal / count);
  const remainder = principal - baseInst * count;
  const start = String(start_period_label || todayJalali().slice(0, 7)).trim();
  const advanceAcct = coaAcct(db, 'coa_employee_advance');
  const cash = resolveCashAccount(db, pay_type || 'cash', bank_id || null, cash_box_id || null);
  const payDate = date || todayJalali();

  return db.transaction(() => {
    const journalId = postToLedger(db, {
      date: payDate,
      description: `وام کارکنان ${person.name} (${principal.toLocaleString('fa-IR')} ریال / ${count} قسط)`,
      sourceType: 'payroll_loan',
      sourceId: 0,
      createdBy: userId,
      lines: [
        { ...advanceAcct, debit: principal / 10, credit: 0 },
        { code: cash.code, name: cash.name, debit: 0, credit: principal / 10 },
      ],
    });

    const info = db.prepare(`
      INSERT INTO payroll_loans
        (person_id, principal_rial, installment_count, installment_rial, recovered_rial,
         pay_type, bank_id, cash_box_id, start_period_label, date, note, journal_id, status, created_by)
      VALUES (?,?,?,?,0,?,?,?,?,?,?,?,'open',?)
    `).run(
      personId, principal, count, baseInst,
      pay_type || 'cash', bank_id || null, cash_box_id || null,
      start, payDate, note || '', journalId, userId
    );
    const loanId = info.lastInsertRowid;
    try {
      db.prepare('UPDATE journal_entries SET source_id=? WHERE id=?').run(loanId, journalId);
    } catch (_) { /* optional */ }

    const ins = db.prepare(`
      INSERT INTO payroll_loan_installments
        (loan_id, seq, due_period_label, amount_rial, paid_rial, status)
      VALUES (?,?,?,?,0,'pending')
    `);
    for (let i = 0; i < count; i++) {
      const amt = baseInst + (i === count - 1 ? remainder : 0);
      ins.run(loanId, i + 1, nextPeriodLabel(start, i), amt);
    }

    if (typeof createPersonLedgerEntry === 'function') {
      createPersonLedgerEntry(db, {
        person_id: personId,
        date: payDate,
        entry_type: 'payroll_loan',
        ref_type: 'payroll_loan',
        ref_id: loanId,
        description: `وام کارکنان ${count} قسط`,
        debit: principal,
        credit: 0,
        user_id: userId,
      });
    }

    return {
      id: loanId,
      journal_id: journalId,
      principal_rial: principal,
      installment_count: count,
      installment_rial: baseInst,
      remaining_rial: principal,
      person_id: personId,
      start_period_label: start,
    };
  })();
}

function allocateLoanRecovery(db, personId, periodLabel, requestedRial) {
  ensureLoansSchema(db);
  const want = Math.max(0, Math.round(Number(requestedRial) || 0));
  if (want <= 0) return { allocated_rial: 0, legs: [] };
  const label = String(periodLabel || '').trim();
  const installments = db.prepare(`
    SELECT i.*, l.id AS loan_id_ref
    FROM payroll_loan_installments i
    JOIN payroll_loans l ON l.id=i.loan_id
    WHERE l.person_id=? AND l.status='open'
      AND i.status IN ('pending','partial')
      AND (? = '' OR i.due_period_label <= ?)
      AND (i.amount_rial - i.paid_rial) > 0
    ORDER BY i.due_period_label ASC, i.seq ASC
  `).all(personId, label, label);

  let left = want;
  const legs = [];
  for (const row of installments) {
    if (left <= 0) break;
    const rem = Math.max(0, row.amount_rial - row.paid_rial);
    if (rem <= 0) continue;
    const take = Math.min(rem, left);
    legs.push({ loan_id: row.loan_id, installment_id: row.id, amount_rial: take });
    left -= take;
  }
  return { allocated_rial: want - left, legs };
}

function applyLoanRecoveries(db, payrollRecordId, legs) {
  if (!legs || !legs.length) return 0;
  let total = 0;
  const updInst = db.prepare(`
    UPDATE payroll_loan_installments SET
      paid_rial = paid_rial + ?,
      status = CASE
        WHEN paid_rial + ? >= amount_rial THEN 'paid'
        WHEN paid_rial + ? > 0 THEN 'partial'
        ELSE status
      END,
      payroll_record_id = COALESCE(payroll_record_id, ?),
      paid_at = CASE WHEN paid_rial + ? >= amount_rial THEN strftime('%s','now') ELSE paid_at END
    WHERE id=? AND status IN ('pending','partial')
  `);
  const updLoan = db.prepare(`
    UPDATE payroll_loans SET
      recovered_rial = recovered_rial + ?,
      status = CASE WHEN recovered_rial + ? >= principal_rial THEN 'closed' ELSE status END
    WHERE id=? AND status='open'
  `);
  const insRec = db.prepare(`
    INSERT INTO payroll_loan_recoveries (loan_id, installment_id, payroll_record_id, amount_rial)
    VALUES (?,?,?,?)
  `);
  for (const leg of legs) {
    const amt = Math.round(Number(leg.amount_rial) || 0);
    if (amt <= 0) continue;
    updInst.run(amt, amt, amt, payrollRecordId, amt, leg.installment_id);
    updLoan.run(amt, amt, leg.loan_id);
    insRec.run(leg.loan_id, leg.installment_id, payrollRecordId, amt);
    total += amt;
  }
  return total;
}

function reverseLoanRecoveries(db, payrollRecordId) {
  ensureLoansSchema(db);
  const slices = db.prepare(`
    SELECT * FROM payroll_loan_recoveries WHERE payroll_record_id=?
  `).all(payrollRecordId);
  if (slices.length) {
    for (const r of slices) {
      const amt = Math.round(Number(r.amount_rial) || 0);
      if (amt <= 0) continue;
      const inst = db.prepare('SELECT * FROM payroll_loan_installments WHERE id=?').get(r.installment_id);
      if (!inst) continue;
      const paid = Math.max(0, Math.round(Number(inst.paid_rial) || 0) - amt);
      const status = paid <= 0 ? 'pending' : (paid >= inst.amount_rial ? 'paid' : 'partial');
      const other = db.prepare(`
        SELECT payroll_record_id FROM payroll_loan_recoveries
        WHERE installment_id=? AND payroll_record_id!=?
        ORDER BY id DESC LIMIT 1
      `).get(r.installment_id, payrollRecordId);
      db.prepare(`
        UPDATE payroll_loan_installments SET
          paid_rial=?, status=?, payroll_record_id=?,
          paid_at=CASE WHEN ?='paid' THEN paid_at ELSE NULL END
        WHERE id=?
      `).run(paid, status, paid > 0 ? (other?.payroll_record_id || null) : null, status, r.installment_id);
      db.prepare(`
        UPDATE payroll_loans SET
          recovered_rial = CASE WHEN recovered_rial - ? < 0 THEN 0 ELSE recovered_rial - ? END,
          status = CASE
            WHEN status='reversed' THEN status
            WHEN recovered_rial - ? < principal_rial THEN 'open'
            ELSE status
          END
        WHERE id=?
      `).run(amt, amt, amt, r.loan_id);
    }
    db.prepare('DELETE FROM payroll_loan_recoveries WHERE payroll_record_id=?').run(payrollRecordId);
    return slices.length;
  }
  const rows = db.prepare(`
    SELECT * FROM payroll_loan_installments
    WHERE payroll_record_id=? AND paid_rial > 0
  `).all(payrollRecordId);
  if (!rows.length) return 0;
  for (const r of rows) {
    const amt = Math.round(Number(r.paid_rial) || 0);
    if (amt <= 0) continue;
    db.prepare(`
      UPDATE payroll_loan_installments SET
        paid_rial = 0, status='pending', payroll_record_id=NULL, paid_at=NULL
      WHERE id=?
    `).run(r.id);
    db.prepare(`
      UPDATE payroll_loans SET
        recovered_rial = CASE WHEN recovered_rial - ? < 0 THEN 0 ELSE recovered_rial - ? END,
        status = CASE
          WHEN status='reversed' THEN status
          WHEN recovered_rial - ? < principal_rial THEN 'open'
          ELSE status
        END
      WHERE id=?
    `).run(amt, amt, amt, r.loan_id);
  }
  return rows.length;
}

function voidLoan(db, loanId, userId) {
  ensureLoansSchema(db);
  const row = db.prepare('SELECT * FROM payroll_loans WHERE id=?').get(loanId);
  if (!row) throw Object.assign(new Error('وام یافت نشد'), { status: 404 });
  if (row.status === 'reversed') {
    throw Object.assign(new Error('این وام قبلاً ابطال شده است'), { status: 400 });
  }
  if (Math.round(Number(row.recovered_rial) || 0) > 0) {
    throw Object.assign(
      new Error('وام بازپرداخت‌شده قابل ابطال مستقیم نیست؛ ابتدا سند حقوق مرتبط را ابطال کنید'),
      { status: 409, code: 'E_LOAN_HAS_RECOVERY' }
    );
  }
  if (row.journal_id) {
    reverseJournalEntry(db, row.journal_id, {
      userId,
      reason: `ابطال وام #${row.id}`,
      sourceType: 'payroll_loan_reversal',
    });
  }
  db.prepare(`
    UPDATE payroll_loans SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=?
    WHERE id=?
  `).run(userId, loanId);
  db.prepare(`
    UPDATE payroll_loan_installments SET status='waived'
    WHERE loan_id=? AND status IN ('pending','partial')
  `).run(loanId);
  try {
    db.prepare(`
      UPDATE person_ledger SET deleted_at=strftime('%s','now')
      WHERE COALESCE(deleted_at,0)=0 AND ref_type='payroll_loan' AND ref_id=?
    `).run(loanId);
  } catch (_) { /* optional */ }
  return { ok: true, id: loanId };
}

module.exports = {
  ensureLoansSchema,
  nextPeriodLabel,
  outstandingLoanRial,
  personLoanBalance,
  dueInstallmentRial,
  listLoans,
  listLoanInstallments,
  issueLoan,
  allocateLoanRecovery,
  applyLoanRecoveries,
  reverseLoanRecoveries,
  voidLoan,
};
