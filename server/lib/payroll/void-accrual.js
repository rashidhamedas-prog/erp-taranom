'use strict';
/**
 * R13 void of a payroll accrual (the wage document), not a reverse voucher.
 *
 * Create effects: journal_entries(ref_type=payroll), payroll_payments + their JEs,
 * person_ledger (payroll / payment / legacy reversal offsets).
 * Cancel = reverse those in one transaction and keep the row with status=reversed.
 * Physical DELETE of posted payroll is forbidden (R12).
 */
const { reverseJournalEntry } = require('../void-journal');
const { listActivePayments, sumPaidRial } = require('./payments');

const FLAG = 'payroll_void_sync_v301';

const PL_REF_TYPES = [
  'payroll',
  'payroll_reversal',
  'payroll_void',
  'payroll_payment',
  'payroll_payment_reversal',
];

function listPayrollAccrualJournals(db, row) {
  const seen = new Set();
  const out = [];
  function add(id) {
    const n = Number(id);
    if (!n || seen.has(n)) return;
    const je = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(n);
    if (je) {
      seen.add(n);
      out.push(je);
    }
  }
  add(row && row.journal_entry_id);
  const refs = db.prepare(`
    SELECT id FROM journal_entries
    WHERE ref_type='payroll' AND ref_id=?
  `).all(row.id);
  for (const r of refs) add(r.id);
  return out;
}

function listPayrollPaymentJournals(db, row) {
  const seen = new Set();
  const out = [];
  function add(id) {
    const n = Number(id);
    if (!n || seen.has(n)) return;
    const je = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(n);
    if (je) {
      seen.add(n);
      out.push(je);
    }
  }
  if (row.payment_journal_id) add(row.payment_journal_id);
  try {
    const pays = db.prepare(
      'SELECT journal_id FROM payroll_payments WHERE payroll_record_id=?'
    ).all(row.id);
    for (const p of pays) add(p.journal_id);
  } catch (_) { /* table optional */ }
  const refs = db.prepare(`
    SELECT id FROM journal_entries
    WHERE ref_type='payroll_payment' AND ref_id=?
  `).all(row.id);
  for (const r of refs) add(r.id);
  return out;
}

function softVoidPayrollPersonLedger(db, row) {
  try {
    db.prepare(`
      UPDATE person_ledger SET deleted_at=strftime('%s','now')
      WHERE ref_id=? AND ref_type IN (${PL_REF_TYPES.map(() => '?').join(',')})
        AND COALESCE(deleted_at,0)=0
    `).run(row.id, ...PL_REF_TYPES);
  } catch (_) { /* older schemas without deleted_at */ }

  try {
    const pays = db.prepare('SELECT id FROM payroll_payments WHERE payroll_record_id=?').all(row.id);
    for (const p of pays) {
      db.prepare(`
        UPDATE person_ledger SET deleted_at=strftime('%s','now')
        WHERE ref_id=? AND ref_type IN ('payroll_payment','payroll_payment_reversal')
          AND COALESCE(deleted_at,0)=0
      `).run(p.id);
    }
  } catch (_) { /* payroll_payments optional */ }
}

function reopenPeriodIfEmpty(db, periodId) {
  if (!periodId) return;
  const left = db.prepare(`
    SELECT COUNT(*) c FROM payroll_records
    WHERE period_id=? AND COALESCE(status,'posted')<>'reversed'
  `).get(periodId).c;
  if (!left) {
    db.prepare(`
      UPDATE payroll_periods SET status='open', processed_at=NULL
      WHERE id=? AND status='processed'
    `).run(periodId);
  }
}

function markRecordReversed(db, row, userId) {
  db.prepare(`
    UPDATE payroll_records SET
      status='reversed',
      reversed_at=COALESCE(reversed_at, strftime('%s','now')),
      paid=0,
      paid_rial=0,
      payment_journal_id=NULL,
      paid_at=NULL
    WHERE id=?
  `).run(row.id);
  try {
    db.prepare('UPDATE payroll_records SET reversed_by=? WHERE id=?').run(userId || null, row.id);
  } catch (_) { /* column optional */ }
}

/** Reverse payment JEs + mark legs reversed without minting person_ledger offsets. */
function cascadeVoidPayments(db, row, userId) {
  try {
    const pays = db.prepare('SELECT * FROM payroll_payments WHERE payroll_record_id=?').all(row.id);
    for (const p of pays) {
      if (p.status !== 'reversed' && p.journal_id) {
        reverseJournalEntry(db, p.journal_id, {
          userId,
          reason: `ابطال پرداخت حقوق #${p.id}`,
          sourceType: 'payroll_payment_reversal',
        });
      }
      if (p.status !== 'reversed') {
        db.prepare(`
          UPDATE payroll_payments SET
            status='reversed',
            reversed_at=strftime('%s','now'),
            reversed_by=?,
            reversal_journal_id=NULL
          WHERE id=?
        `).run(userId || null, p.id);
      }
    }
  } catch (_) { /* payroll_payments optional */ }

  if (row.payment_journal_id) {
    reverseJournalEntry(db, row.payment_journal_id, {
      userId,
      reason: `ابطال پرداخت حقوق #${row.id}`,
      sourceType: 'payroll_payment_reversal',
    });
  }
}

/**
 * Full void of one payroll document. Caller should wrap in db.transaction.
 */
function voidPayrollAccrual(db, {
  row,
  userId,
  reason,
  cascadePayments = true,
  allowAlreadyReversed = true,
} = {}) {
  if (!row) throw Object.assign(new Error('یافت نشد'), { status: 404 });

  if (row.status === 'reversed' && !allowAlreadyReversed) {
    throw Object.assign(new Error('این رکورد قبلاً ابطال شده است'), { status: 400, code: 'E_PAYROLL_ALREADY_VOID' });
  }

  const paidLive = sumPaidRial(db, row.id);
  const activePays = listActivePayments(db, row.id);
  if (!cascadePayments && row.status !== 'reversed' && (paidLive > 0 || row.paid)) {
    throw Object.assign(new Error('حقوق دارای پرداخت فعال است — ابتدا ابطال پرداخت کنید'), {
      status: 400,
      code: 'E_PAYROLL_HAS_PAYMENT',
    });
  }

  if (cascadePayments && (activePays.length || row.paid || row.payment_journal_id)) {
    cascadeVoidPayments(db, row, userId);
  }

  for (const je of listPayrollAccrualJournals(db, row)) {
    reverseJournalEntry(db, je.id, {
      userId,
      reason: reason || `ابطال سند حقوق #${row.id}`,
      sourceType: 'payroll_reversal',
    });
  }
  // Any payment JE still alive (legacy / missed legs)
  for (const je of listPayrollPaymentJournals(db, row)) {
    reverseJournalEntry(db, je.id, {
      userId,
      reason: reason || `ابطال پرداخت حقوق #${row.id}`,
      sourceType: 'payroll_payment_reversal',
    });
  }

  softVoidPayrollPersonLedger(db, row);
  try {
    require('./advances').reverseAdvanceRecoveries(db, row.id);
  } catch (_) { /* advances optional on older DBs */ }
  try {
    require('./loans').reverseLoanRecoveries(db, row.id);
  } catch (_) { /* loans optional on older DBs */ }
  require('../commissions-multi').releaseFromPayroll(db, row.id);
  markRecordReversed(db, row, userId);
  reopenPeriodIfEmpty(db, row.period_id);
  return db.prepare('SELECT * FROM payroll_records WHERE id=?').get(row.id);
}

function backfillMissingJournalIds(db) {
  let n = 0;
  const missing = db.prepare(`
    SELECT id FROM payroll_records
    WHERE journal_entry_id IS NULL
  `).all();
  const upd = db.prepare('UPDATE payroll_records SET journal_entry_id=? WHERE id=?');
  for (const r of missing) {
    const je = db.prepare(`
      SELECT id FROM journal_entries
      WHERE ref_type='payroll' AND ref_id=?
      ORDER BY id DESC LIMIT 1
    `).get(r.id);
    if (je) {
      n += upd.run(je.id, r.id).changes;
    }
  }
  return n;
}

/**
 * Historical rows marked status=reversed without soft-voiding JE / original PL.
 * Idempotent via settings flag.
 */
function repairOrphanPayrollVoids(db) {
  const existing = db.prepare('SELECT value FROM settings WHERE key=?').get(FLAG);
  if (existing && existing.value === '1') return { skipped: true };

  let records = 0;
  let journals = 0;
  let ledger = 0;
  const run = db.transaction(() => {
    const linked = backfillMissingJournalIds(db);
    const reversed = db.prepare(`
      SELECT * FROM payroll_records WHERE status='reversed'
    `).all();
    for (const row of reversed) {
      records += 1;
      for (const je of listPayrollAccrualJournals(db, row)) {
        const dead = Number(je.deleted_at || 0) > 0
          || ['reversed', 'void'].includes(String(je.status || ''));
        reverseJournalEntry(db, je.id, {
          reason: `همگام‌سازی ابطال حقوق #${row.id}`,
          sourceType: 'payroll_reversal',
        });
        if (!dead) journals += 1;
      }
      for (const je of listPayrollPaymentJournals(db, row)) {
        const dead = Number(je.deleted_at || 0) > 0
          || ['reversed', 'void'].includes(String(je.status || ''));
        reverseJournalEntry(db, je.id, {
          reason: `همگام‌سازی ابطال پرداخت حقوق #${row.id}`,
          sourceType: 'payroll_payment_reversal',
        });
        if (!dead) journals += 1;
      }
      const before = db.prepare(`
        SELECT COUNT(*) c FROM person_ledger
        WHERE ref_id=? AND ref_type IN (${PL_REF_TYPES.map(() => '?').join(',')})
          AND COALESCE(deleted_at,0)=0
      `).get(row.id, ...PL_REF_TYPES).c;
      softVoidPayrollPersonLedger(db, row);
      ledger += before;
    }
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(FLAG, '1');
    return linked;
  });
  const linked = run();
  return { skipped: false, records, journals, ledger, linked };
}

module.exports = {
  FLAG,
  listPayrollAccrualJournals,
  voidPayrollAccrual,
  repairOrphanPayrollVoids,
  backfillMissingJournalIds,
  softVoidPayrollPersonLedger,
};
