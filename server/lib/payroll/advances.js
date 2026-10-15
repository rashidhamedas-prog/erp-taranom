'use strict';
/**
 * Employee salary advances / loans (مساعده کارکنان).
 * Issue: Dr employee_advance (1120) / Cr bank|cash
 * Recovery on payroll: Cr employee_advance (reduces net via other_deductions path split)
 * R13 void of issue when unrecovered.
 */

const { postToLedger } = require('../ledger');
const { reverseJournalEntry } = require('../void-journal');
const { acct: coaAcct } = require('../coa-map');
const { todayJalali } = require('../../jalali');

function ensureAdvancesSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payroll_advances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL,
      amount_rial INTEGER NOT NULL DEFAULT 0,
      recovered_rial INTEGER NOT NULL DEFAULT 0,
      pay_type TEXT DEFAULT 'cash',
      bank_id INTEGER,
      cash_box_id INTEGER,
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
    CREATE INDEX IF NOT EXISTS idx_payroll_advances_person
      ON payroll_advances(person_id, status);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS payroll_advance_recoveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      advance_id INTEGER NOT NULL,
      payroll_record_id INTEGER NOT NULL,
      amount_rial INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(advance_id) REFERENCES payroll_advances(id),
      FOREIGN KEY(payroll_record_id) REFERENCES payroll_records(id)
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_advance_recoveries_rec
      ON payroll_advance_recoveries(payroll_record_id);
  `);
}

function outstandingRial(row) {
  if (!row || row.status === 'reversed' || row.status === 'closed') return 0;
  return Math.max(0, Math.round(Number(row.amount_rial) || 0) - Math.round(Number(row.recovered_rial) || 0));
}

function personAdvanceBalance(db, personId) {
  const rows = db.prepare(`
    SELECT * FROM payroll_advances
    WHERE person_id=? AND status='open'
    ORDER BY id ASC
  `).all(personId);
  return rows.reduce((s, r) => s + outstandingRial(r), 0);
}

function listAdvances(db, { person_id, limit } = {}) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  if (person_id) {
    return db.prepare(`
      SELECT a.*, p.name person_name,
             (a.amount_rial - a.recovered_rial) AS remaining_rial
      FROM payroll_advances a
      JOIN persons p ON p.id=a.person_id
      WHERE a.person_id=?
      ORDER BY a.id DESC LIMIT ?
    `).all(Number(person_id), lim);
  }
  return db.prepare(`
    SELECT a.*, p.name person_name,
           (a.amount_rial - a.recovered_rial) AS remaining_rial
    FROM payroll_advances a
    JOIN persons p ON p.id=a.person_id
    ORDER BY a.id DESC LIMIT ?
  `).all(lim);
}

function issueAdvance(db, {
  person_id,
  amount_rial,
  pay_type,
  bank_id,
  cash_box_id,
  date,
  note,
  userId,
  resolveCashAccount,
  createPersonLedgerEntry,
}) {
  const personId = Number(person_id);
  const person = db.prepare('SELECT * FROM persons WHERE id=? AND active=1').get(personId);
  if (!person) throw Object.assign(new Error('کارمند یافت نشد'), { status: 404 });
  const amount = Math.round(Number(amount_rial) || 0);
  if (amount <= 0) {
    throw Object.assign(new Error('مبلغ مساعده باید بزرگ‌تر از صفر باشد'), { status: 400 });
  }
  const advanceAcct = coaAcct(db, 'coa_employee_advance');
  const cash = resolveCashAccount(db, pay_type || 'cash', bank_id || null, cash_box_id || null);
  const payDate = date || todayJalali();

  const journalId = postToLedger(db, {
    date: payDate,
    description: `مساعده حقوق ${person.name} (${amount.toLocaleString('fa-IR')} ریال)`,
    sourceType: 'payroll_advance',
    sourceId: 0,
    createdBy: userId,
    lines: [
      { ...advanceAcct, debit: amount / 10, credit: 0 },
      { code: cash.code, name: cash.name, debit: 0, credit: amount / 10 },
    ],
  });

  const info = db.prepare(`
    INSERT INTO payroll_advances
      (person_id, amount_rial, recovered_rial, pay_type, bank_id, cash_box_id, date, note, journal_id, status, created_by)
    VALUES (?,?,0,?,?,?,?,?,?,'open',?)
  `).run(personId, amount, pay_type || 'cash', bank_id || null, cash_box_id || null, payDate, note || '', journalId, userId);
  const id = info.lastInsertRowid;
  try {
    db.prepare('UPDATE journal_entries SET source_id=? WHERE id=?').run(id, journalId);
  } catch (_) { /* optional */ }

  if (typeof createPersonLedgerEntry === 'function') {
    createPersonLedgerEntry(db, {
      person_id: personId,
      date: payDate,
      entry_type: 'payroll_advance',
      ref_type: 'payroll_advance',
      ref_id: id,
      description: `مساعده حقوق`,
      debit: amount,
      credit: 0,
      user_id: userId,
    });
  }

  return { id, journal_id: journalId, amount_rial: amount, remaining_rial: amount, person_id: personId };
}

/**
 * Allocate recovery across open advances (FIFO). Returns allocated total and per-advance rows.
 * Does NOT post JE — caller includes Cr employee_advance on payroll accrual JE.
 */
function allocateAdvanceRecovery(db, personId, requestedRial) {
  const want = Math.max(0, Math.round(Number(requestedRial) || 0));
  if (want <= 0) return { allocated_rial: 0, legs: [] };
  const open = db.prepare(`
    SELECT * FROM payroll_advances WHERE person_id=? AND status='open' ORDER BY id ASC
  `).all(personId);
  let left = want;
  const legs = [];
  for (const row of open) {
    if (left <= 0) break;
    const rem = outstandingRial(row);
    if (rem <= 0) continue;
    const take = Math.min(rem, left);
    legs.push({ advance_id: row.id, amount_rial: take });
    left -= take;
  }
  const allocated = want - left;
  return { allocated_rial: allocated, legs };
}

function applyAdvanceRecoveries(db, payrollRecordId, personId, legs) {
  if (!legs || !legs.length) return 0;
  void personId;
  let total = 0;
  const upd = db.prepare(`
    UPDATE payroll_advances SET
      recovered_rial = recovered_rial + ?,
      status = CASE WHEN recovered_rial + ? >= amount_rial THEN 'closed' ELSE status END
    WHERE id=? AND status='open'
  `);
  const ins = db.prepare(`
    INSERT INTO payroll_advance_recoveries (advance_id, payroll_record_id, amount_rial)
    VALUES (?,?,?)
  `);
  for (const leg of legs) {
    const amt = Math.round(Number(leg.amount_rial) || 0);
    if (amt <= 0) continue;
    upd.run(amt, amt, leg.advance_id);
    ins.run(leg.advance_id, payrollRecordId, amt);
    total += amt;
  }
  return total;
}

/** Undo recoveries when payroll accrual is R13-voided (reopen advances). */
function reverseAdvanceRecoveries(db, payrollRecordId) {
  const rows = db.prepare(`
    SELECT * FROM payroll_advance_recoveries WHERE payroll_record_id=?
  `).all(payrollRecordId);
  if (!rows.length) return 0;
  const upd = db.prepare(`
    UPDATE payroll_advances SET
      recovered_rial = CASE
        WHEN recovered_rial - ? < 0 THEN 0 ELSE recovered_rial - ?
      END,
      status = CASE
        WHEN status='reversed' THEN status
        WHEN recovered_rial - ? < amount_rial THEN 'open'
        ELSE status
      END
    WHERE id=?
  `);
  for (const r of rows) {
    const amt = Math.round(Number(r.amount_rial) || 0);
    if (amt <= 0) continue;
    upd.run(amt, amt, amt, r.advance_id);
  }
  db.prepare('DELETE FROM payroll_advance_recoveries WHERE payroll_record_id=?').run(payrollRecordId);
  return rows.length;
}

function voidAdvance(db, advanceId, userId, createPersonLedgerEntry) {
  const row = db.prepare('SELECT * FROM payroll_advances WHERE id=?').get(advanceId);
  if (!row) throw Object.assign(new Error('مساعده یافت نشد'), { status: 404 });
  if (row.status === 'reversed') {
    throw Object.assign(new Error('این مساعده قبلاً ابطال شده است'), { status: 400 });
  }
  if (Math.round(Number(row.recovered_rial) || 0) > 0) {
    throw Object.assign(
      new Error('مساعدهٔ بازپرداخت‌شده قابل ابطال مستقیم نیست؛ ابتدا سند حقوق مرتبط را ابطال کنید'),
      { status: 409, code: 'E_ADVANCE_HAS_RECOVERY' }
    );
  }
  if (row.journal_id) {
    reverseJournalEntry(db, row.journal_id, {
      userId,
      reason: `ابطال مساعده #${row.id}`,
      sourceType: 'payroll_advance_reversal',
    });
  }
  db.prepare(`
    UPDATE payroll_advances SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=?
    WHERE id=?
  `).run(userId, advanceId);
  try {
    db.prepare(`
      UPDATE person_ledger SET deleted_at=strftime('%s','now')
      WHERE COALESCE(deleted_at,0)=0 AND ref_type='payroll_advance' AND ref_id=?
    `).run(advanceId);
  } catch (_) { /* optional */ }
  void createPersonLedgerEntry;
  return { ok: true, id: advanceId };
}

module.exports = {
  ensureAdvancesSchema,
  outstandingRial,
  personAdvanceBalance,
  listAdvances,
  issueAdvance,
  allocateAdvanceRecovery,
  applyAdvanceRecoveries,
  reverseAdvanceRecoveries,
  voidAdvance,
};
