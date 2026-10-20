/**
 * Void a posted journal entry WITHOUT creating a separate «سند ابطالی».
 *
 * Policy (v285+): mark the original JE as reversed + soft-deleted so trial
 * balance / books that filter deleted_at or status exclude it. No paired
 * reverse voucher is posted. Historical reverse vouchers are purged by
 * purgeHistoricalReversalDocs().
 *
 * Return value: original jeId when this call soft-voided a live entry;
 * null if missing or already voided. No paired reverse voucher id.
 * Business rows keep status='reversed'.
 */
'use strict';

function reverseJournalEntry(db, jeId, { userId, date, reason, sourceType } = {}) {
  if (!jeId) return null;
  const origHead = db.prepare(`
    SELECT id, ref_type, ref_id, description, status, deleted_at
    FROM journal_entries WHERE id=?
  `).get(jeId);
  if (!origHead) return null;

  const alreadyDead = Number(origHead.deleted_at || 0) > 0
    || ['reversed', 'void'].includes(String(origHead.status || ''));

  // Soft-void original — never insert a reverse JE.
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE journal_entries
    SET status='reversed',
        deleted_at=COALESCE(NULLIF(deleted_at,0), ?),
        description=CASE
          WHEN description LIKE '%[ابطال]%' THEN description
          ELSE description || ' [ابطال]' || ?
        END
    WHERE id=?
  `).run(
    now,
    reason ? ` — ${String(reason).slice(0, 120)}` : '',
    jeId
  );

  // Drop any existing paired reverse vouchers for this original (legacy R12).
  purgeReverseVouchersForOriginal(db, jeId, origHead);

  return alreadyDead ? null : jeId;
}

function purgeReverseVouchersForOriginal(db, originalId, origHead) {
  const likeDesc = `ابطال سند #${originalId}%`;
  const rows = db.prepare(`
    SELECT id FROM journal_entries
    WHERE id<>?
      AND (
        description LIKE ?
        OR (ref_type LIKE '%\\_reversal' ESCAPE '\\' AND ref_id=? AND ref_type NOT LIKE 'payroll_payment%')
        OR (ref_type = ? AND ref_id = ?)
      )
  `).all(
    originalId,
    likeDesc,
    origHead?.ref_id ?? null,
    origHead?.ref_type ? `${origHead.ref_type}_reversal` : '__none__',
    origHead?.ref_id ?? null
  );
  for (const r of rows) hardDeleteJournalEntry(db, r.id);
}

function hardDeleteJournalEntry(db, jeId) {
  if (!jeId) return;
  db.prepare('DELETE FROM journal_lines WHERE entry_id=?').run(jeId);
  db.prepare('DELETE FROM journal_entries WHERE id=?').run(jeId);
}

/**
 * One-shot / boot-safe: remove all standalone reverse vouchers and soft-void
 * their originals so the ledger stays balanced without «سند ابطالی».
 * Idempotent.
 */
function purgeHistoricalReversalDocs(db) {
  const reverses = db.prepare(`
    SELECT id, ref_type, ref_id, description, status, deleted_at
    FROM journal_entries
    WHERE COALESCE(deleted_at,0)=0
      AND (
        ref_type LIKE '%\\_reversal' ESCAPE '\\'
        OR description LIKE 'ابطال سند #%'
      )
  `).all();

  let purged = 0;
  let originalsVoided = 0;
  const tx = db.transaction(() => {
    for (const rev of reverses) {
      let originalId = null;
      const m = String(rev.description || '').match(/ابطال سند #(\d+)/);
      if (m) originalId = Number(m[1]);
      if (!originalId && rev.ref_type && String(rev.ref_type).endsWith('_reversal') && rev.ref_id) {
        const baseType = String(rev.ref_type).replace(/_reversal$/, '');
        const orig = db.prepare(`
          SELECT id FROM journal_entries
          WHERE ref_type=? AND ref_id=? AND id<>?
            AND COALESCE(status,'posted') NOT IN ('reversed','void')
          ORDER BY id DESC LIMIT 1
        `).get(baseType, rev.ref_id, rev.id)
          || db.prepare(`
            SELECT id FROM journal_entries
            WHERE ref_type=? AND ref_id=? AND id<>?
            ORDER BY id DESC LIMIT 1
          `).get(baseType, rev.ref_id, rev.id);
        if (orig) originalId = orig.id;
      }
      if (originalId) {
        const o = db.prepare('SELECT id, status, deleted_at FROM journal_entries WHERE id=?').get(originalId);
        if (o && !(Number(o.deleted_at || 0) > 0 && ['reversed', 'void'].includes(String(o.status || '')))) {
          const now = Math.floor(Date.now() / 1000);
          db.prepare(`
            UPDATE journal_entries
            SET status='reversed', deleted_at=COALESCE(NULLIF(deleted_at,0), ?)
            WHERE id=?
          `).run(now, originalId);
          originalsVoided += 1;
        }
      }
      hardDeleteJournalEntry(db, rev.id);
      purged += 1;
    }

    // Also soft-void any still-alive JE marked reversed without deleted_at
    // (legacy reverseJournalEntry left deleted_at NULL).
    const legacy = db.prepare(`
      SELECT id FROM journal_entries
      WHERE COALESCE(status,'') IN ('reversed','void')
        AND COALESCE(deleted_at,0)=0
    `).all();
    const now = Math.floor(Date.now() / 1000);
    for (const row of legacy) {
      db.prepare('UPDATE journal_entries SET deleted_at=? WHERE id=?').run(now, row.id);
      originalsVoided += 1;
    }
  });
  tx();
  return { purged, originalsVoided };
}

module.exports = {
  reverseJournalEntry,
  purgeHistoricalReversalDocs,
  hardDeleteJournalEntry,
};
