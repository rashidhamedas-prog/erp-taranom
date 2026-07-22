/**
 * Full cheque_records void — reverse lifecycle JEs newest-first, then opening (R13).
 */
const { reverseJournalEntry } = require('./void-journal');
const { todayJalali } = require('../jalali');
const { acct } = require('./coa-map');
const { postToLedger } = require('./ledger');
const { audit } = require('../db');

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

  let lastReversal = null;
  db.transaction(() => {
    // Newest lifecycle first: bounce → clear → collection → opening
    for (const col of ['bounced_je_id', 'cleared_je_id', 'collection_je_id']) {
      if (row[col]) {
        lastReversal = reverseJournalEntry(db, row[col], {
          userId: user.id,
          reason: `ابطال چک ${row.cheque_number || row.id}`,
          sourceType: 'cheque_lifecycle_reversal',
        }) || lastReversal;
      }
    }

    if (row.journal_entry_id) {
      // Prefer explicit opening reverse (same as legacy DELETE)
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
        description: `ابطال چک اول دوره ${row.cheque_number || row.id}`, createdBy: user.id, lines,
      });
    }

    db.prepare(`
      UPDATE cheque_records SET
        record_status='reversed',
        reversal_journal_id=?,
        reversed_at=strftime('%s','now'),
        reversed_by=?,
        lifecycle_status='reversed',
        status=CASE WHEN status IS NULL OR status='' THEN 'ابطال‌شده' ELSE status || ' (ابطال)' END
      WHERE id=?
    `).run(lastReversal, user.id, row.id);
  })();

  audit(user.id, 'reverse', 'cheque_record', row.id, `ابطال کامل چک ${row.cheque_number || row.id}`);
  return { ok: true };
}

module.exports = { voidChequeRecord };
