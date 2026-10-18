/**
 * Full cheque_records void — reverse lifecycle JEs newest-first, then opening (R13).
 *
 * Settlement reverse must call applyChequeLifecycleVoid *before* settlement GL so
 * notes receivable (1109) is restored from in_collection/cleared before
 * Dr AR / Cr 1109 undoes the original receipt.
 */
'use strict';

const { reverseJournalEntry } = require('./void-journal');
const { todayJalali } = require('../jalali');
const { acct } = require('./coa-map');
const { postToLedger } = require('./ledger');
const { audit } = require('../db');

/**
 * Soft-void bounce → clear → collection → opening JEs and mark the leaf reversed.
 * @param {object} opts
 * @param {boolean} [opts.skipSettlement]
 * @param {boolean} [opts.allowAlreadyReversed] — heal: leaf already reversed, JEs still live
 */
function applyChequeLifecycleVoid(db, row, user, opts) {
  const options = opts || {};
  if (!row || !row.id) return { lastReversal: null, changed: false, jeTouched: 0 };
  if (row.record_status === 'reversed' && !options.allowAlreadyReversed) {
    const err = new Error('این چک قبلاً ابطال شده است');
    err.status = 400;
    throw err;
  }

  const userId = user && user.id != null ? user.id : 0;
  let lastReversal = null;
  let jeTouched = 0;

  for (const col of ['bounced_je_id', 'cleared_je_id', 'collection_je_id']) {
    if (row[col]) {
      const before = db.prepare('SELECT id, status, deleted_at FROM journal_entries WHERE id=?').get(row[col]);
      const wasLive = before
        && !(Number(before.deleted_at || 0) > 0)
        && !['reversed', 'void'].includes(String(before.status || ''));
      lastReversal = reverseJournalEntry(db, row[col], {
        userId,
        reason: `ابطال چک ${row.cheque_number || row.id}`,
        sourceType: 'cheque_lifecycle_reversal',
      }) || lastReversal;
      if (wasLive) jeTouched += 1;
    }
  }

  if (row.journal_entry_id) {
    const { isOpeningCheque } = require('./cheque-party-books');
    if (isOpeningCheque(row)) {
      const chequeAccount = acct(db, row.direction === 'in' ? 'coa_cheques_receivable' : 'coa_cheques_payable');
      const openingAccount = acct(db, 'coa_opening_balance');
      const valueToman = Math.round(Number(row.amount)) / 10;
      const lines = row.direction === 'in'
        ? [
          { code: openingAccount.code, name: openingAccount.name, debit: valueToman, credit: 0 },
          { code: chequeAccount.code, name: chequeAccount.name, debit: 0, credit: valueToman },
        ]
        : [
          { code: chequeAccount.code, name: chequeAccount.name, debit: valueToman, credit: 0 },
          { code: openingAccount.code, name: openingAccount.name, debit: 0, credit: valueToman },
        ];
      lastReversal = postToLedger(db, {
        sourceType: 'opening_cheque_reversal', sourceId: row.id, date: todayJalali(),
        description: `ابطال چک اول دوره ${row.cheque_number || row.id}`, createdBy: userId, lines,
      });
      jeTouched += 1;
    } else {
      const before = db.prepare('SELECT id, status, deleted_at FROM journal_entries WHERE id=?').get(row.journal_entry_id);
      const wasLive = before
        && !(Number(before.deleted_at || 0) > 0)
        && !['reversed', 'void'].includes(String(before.status || ''));
      lastReversal = reverseJournalEntry(db, row.journal_entry_id, {
        userId,
        reason: `ابطال چک ${row.cheque_number || row.id}`,
        sourceType: 'cheque_in_reversal',
      }) || lastReversal;
      if (wasLive) jeTouched += 1;
    }
  }

  if (row.record_status !== 'reversed') {
    db.prepare(`
      UPDATE cheque_records SET
        record_status='reversed',
        reversal_journal_id=COALESCE(?, reversal_journal_id),
        reversed_at=COALESCE(reversed_at, strftime('%s','now')),
        reversed_by=COALESCE(reversed_by, ?),
        lifecycle_status='reversed',
        status=CASE
          WHEN status IS NULL OR status='' THEN 'ابطال‌شده'
          WHEN status LIKE '%ابطال%' THEN status
          ELSE status || ' (ابطال)'
        END
      WHERE id=?
    `).run(lastReversal, userId, row.id);
  } else {
    db.prepare(`
      UPDATE cheque_records SET
        lifecycle_status='reversed',
        reversed_at=COALESCE(reversed_at, strftime('%s','now')),
        reversed_by=COALESCE(reversed_by, ?),
        status=CASE
          WHEN status LIKE '%ابطال%' THEN status
          WHEN status IS NULL OR status='' THEN 'ابطال‌شده'
          ELSE status || ' (ابطال)'
        END
      WHERE id=?
    `).run(userId, row.id);
  }

  try {
    const { reverseChequeLedgerByRef } = require('./cheque-party-books');
    reverseChequeLedgerByRef(db, {
      chequeId: row.id,
      refTypes: ['cheque_endorse', 'cheque_in', 'cheque_bounce', 'cheque_pay'],
      date: todayJalali(),
      userId,
      descriptionPrefix: `ابطال چک ${row.cheque_number || row.id}`,
    });
  } catch (_) { /* optional */ }

  if (!options.skipSettlement) {
    const settlementId = Number(row.settlement_id) || 0;
    if (settlementId) {
      const settlement = db.prepare('SELECT * FROM settlements WHERE id=?').get(settlementId);
      if (settlement && settlement.status !== 'reversed') {
        const { reverseSettlementInTx } = require('./void-settlement');
        reverseSettlementInTx(db, settlement, userId, { skipChequeRecords: true });
        if (settlement.invoice_id) {
          try {
            const { recomputeInvoiceSettledBalances } = require('./invoice-payments');
            recomputeInvoiceSettledBalances(db, settlement.invoice_id);
          } catch (_) { /* optional */ }
        }
      }
    }
  }

  try { require('./cheque-due').syncSettlementChequeStatus(db, row.id); } catch (_) {}

  return { lastReversal, changed: true, jeTouched };
}

function voidChequeRecord(db, chequeId, user) {
  const row = db.prepare('SELECT * FROM cheque_records WHERE id=?').get(chequeId);
  if (!row) {
    const err = new Error('یافت نشد');
    err.status = 404;
    throw err;
  }
  if (row.record_status === 'reversed') {
    const err = new Error('این چک قبلاً ابطال شده است');
    err.status = 400;
    throw err;
  }

  db.transaction(() => {
    applyChequeLifecycleVoid(db, row, user, { skipSettlement: false });
  })();

  audit(user.id, 'reverse', 'cheque_record', row.id, `ابطال کامل چک ${row.cheque_number || row.id}`);
  return { ok: true };
}

function healOrphanReversedChequeLifecycleJes(db) {
  if (!db) return { skipped: true };
  const FLAG = 'orphan_cheque_lifecycle_void_v453';
  try {
    const done = db.prepare('SELECT value FROM settings WHERE key=?').get(FLAG);
    if (done && done.value === '1') return { skipped: true };
  } catch (_) {
    return { skipped: true, reason: 'no_settings' };
  }

  let orphans = [];
  try {
    orphans = db.prepare(`
      SELECT cr.*
      FROM cheque_records cr
      WHERE COALESCE(cr.record_status,'posted')='reversed'
        AND (
          (COALESCE(cr.cleared_je_id,0)>0 AND EXISTS (
            SELECT 1 FROM journal_entries je WHERE je.id=cr.cleared_je_id
              AND COALESCE(je.deleted_at,0)=0
              AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
          ))
          OR (COALESCE(cr.collection_je_id,0)>0 AND EXISTS (
            SELECT 1 FROM journal_entries je WHERE je.id=cr.collection_je_id
              AND COALESCE(je.deleted_at,0)=0
              AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
          ))
          OR (COALESCE(cr.bounced_je_id,0)>0 AND EXISTS (
            SELECT 1 FROM journal_entries je WHERE je.id=cr.bounced_je_id
              AND COALESCE(je.deleted_at,0)=0
              AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
          ))
        )
    `).all();
  } catch (e) {
    return { skipped: true, reason: e.message };
  }

  let fixed = 0;
  let jeTouched = 0;
  const run = db.transaction(() => {
    for (const row of orphans) {
      const r = applyChequeLifecycleVoid(db, row, { id: 0 }, {
        skipSettlement: true,
        allowAlreadyReversed: true,
      });
      if (r && r.changed) fixed += 1;
      if (r && r.jeTouched) jeTouched += r.jeTouched;
    }
    db.prepare("INSERT INTO settings (key,value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value='1'")
      .run(FLAG);
  });
  run();
  if (fixed) {
    console.log(`✅ orphan_cheque_lifecycle_void_v453: fixed=${fixed} jeTouched=${jeTouched}`);
  }
  return { skipped: false, fixed, jeTouched, orphanCount: orphans.length };
}

module.exports = {
  voidChequeRecord,
  applyChequeLifecycleVoid,
  healOrphanReversedChequeLifecycleJes,
};
