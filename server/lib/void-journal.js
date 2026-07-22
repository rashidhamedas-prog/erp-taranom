/**
 * Reverse a posted journal entry by swapping debit/credit lines (R12).
 */
const { postToLedger } = require('./ledger');
const { todayJalali } = require('../jalali');

function reverseJournalEntry(db, jeId, { userId, date, reason, sourceType } = {}) {
  if (!jeId) return null;
  const dup = db.prepare(`
    SELECT id FROM journal_entries
    WHERE COALESCE(deleted_at,0)=0 AND description LIKE ?
    LIMIT 1
  `).get(`ابطال سند #${jeId}%`);
  if (dup) return dup.id;

  const orig = db.prepare(`
    SELECT jl.*, je.ref_type, je.ref_id, je.description
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.entry_id = ? AND COALESCE(je.deleted_at,0)=0
    ORDER BY jl.line_no, jl.id
  `).all(jeId);
  if (!orig.length) return null;

  const revSource = sourceType || ((orig[0].ref_type || 'journal') + '_reversal');
  return postToLedger(db, {
    sourceType: revSource,
    sourceId: orig[0].ref_id,
    date: date || todayJalali(),
    description: `ابطال سند #${jeId} — ${orig[0].description || ''}${reason ? ' — ' + reason : ''}`,
    createdBy: userId,
    lines: orig.map(l => ({
      code: l.account_code,
      name: l.account_name,
      debit: (Number(l.credit_rial) || Math.round((Number(l.credit) || 0) * 10)) / 10,
      credit: (Number(l.debit_rial) || Math.round((Number(l.debit) || 0) * 10)) / 10,
      description: `ابطال — ${l.description || ''}`,
      detail_account_id: l.detail_account_id || null,
    })),
  });
}

module.exports = { reverseJournalEntry };
