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
 *
 * Exception (v521): an original dated in a closed/locked fiscal year is never
 * touched — an opposite voucher (ref_type `<orig>_reversal_cv`) is posted in the
 * open period and linked via reversed_by_je_id / reverses_je_id.
 */
'use strict';

/** Fiscal year whose [start_date, end_date] contains `date` (latest start wins). */
function fiscalYearForDate(db, date) {
  const d = String(date || '').trim();
  if (!d) return null;
  let rows;
  try {
    rows = db.prepare(`
      SELECT id, label, start_date, end_date, status, closed_at
      FROM fiscal_years ORDER BY start_date DESC, id DESC
    `).all();
  } catch (_) {
    return null;
  }
  for (const fy of rows) {
    const s = String(fy.start_date || '');
    const e = String(fy.end_date || '');
    if (s && d < s) continue;
    if (e && d > e) continue;
    return fy;
  }
  return null;
}

/** Closed/locked fiscal year containing `date`, else null. */
function closedFiscalYearForDate(db, date) {
  const fy = fiscalYearForDate(db, date);
  if (fy && ['closed', 'locked'].includes(String(fy.status || ''))) return fy;
  return null;
}

function hasColumn(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  } catch (_) {
    return false;
  }
}

function ensureReversalLinkColumns(db) {
  if (!hasColumn(db, 'journal_entries', 'reversed_by_je_id')) {
    db.exec('ALTER TABLE journal_entries ADD COLUMN reversed_by_je_id INTEGER');
  }
  if (!hasColumn(db, 'journal_entries', 'reverses_je_id')) {
    db.exec('ALTER TABLE journal_entries ADD COLUMN reverses_je_id INTEGER');
  }
}

function isLiveEntry(db, id) {
  if (!id) return false;
  const r = db.prepare('SELECT status, deleted_at FROM journal_entries WHERE id=?').get(id);
  return !!r && !(Number(r.deleted_at || 0) > 0) && !['reversed', 'void'].includes(String(r.status || ''));
}

/**
 * Original lives in a closed/locked year: it stays untouched; an opposite voucher
 * is posted in the open period and the two are linked (reversed_by_je_id / reverses_je_id).
 */
function postClosedPeriodCounterVoucher(db, head, fy, { userId, date, reason } = {}) {
  ensureReversalLinkColumns(db);
  const lines = db.prepare(
    'SELECT * FROM journal_lines WHERE entry_id=? ORDER BY COALESCE(line_no,0), id'
  ).all(head.id);
  if (!lines.length) return null;
  const { jlDebitRial, jlCreditRial } = require('./money');
  const { postToLedger } = require('./ledger');
  const { todayJalali } = require('../jalali');
  const cvDate = date && !closedFiscalYearForDate(db, date) ? date : todayJalali();
  const swapped = lines.map((l) => ({
    code: l.account_code,
    name: l.account_name || l.account_code,
    debit: jlCreditRial(l) / 10,
    credit: jlDebitRial(l) / 10,
    description: l.description || '',
    detail_account_id: l.detail_account_id || null,
    cost_center_id: l.cost_center_id || null,
    project_id: l.project_id || null,
    tax_type: l.tax_type || null,
    tafsili2_code: l.tafsili2_code || null,
  }));
  const cvId = postToLedger(db, {
    sourceType: `${head.ref_type || 'journal'}_reversal_cv`,
    sourceId: head.ref_id != null ? head.ref_id : head.id,
    date: cvDate,
    description: `سند معکوس سند #${head.id} (دوره مالی بسته ${fy.label || fy.id})`
      + (reason ? ` — ${String(reason).slice(0, 120)}` : ''),
    createdBy: userId || null,
    lines: swapped,
    skipCcPolicy: true,
  });
  db.prepare('UPDATE journal_entries SET reversed_by_je_id=? WHERE id=?').run(cvId, head.id);
  db.prepare('UPDATE journal_entries SET reverses_je_id=? WHERE id=?').run(head.id, cvId);
  return head.id;
}

function reverseJournalEntry(db, jeId, { userId, date, reason, sourceType } = {}) {
  if (!jeId) return null;
  const origHead = db.prepare(`
    SELECT id, entry_date, ref_type, ref_id, description, status, deleted_at
    FROM journal_entries WHERE id=?
  `).get(jeId);
  if (!origHead) return null;

  const alreadyDead = Number(origHead.deleted_at || 0) > 0
    || ['reversed', 'void'].includes(String(origHead.status || ''));

  if (!alreadyDead) {
    if (hasColumn(db, 'journal_entries', 'reversed_by_je_id')) {
      const link = db.prepare('SELECT reversed_by_je_id FROM journal_entries WHERE id=?').get(jeId);
      if (link && link.reversed_by_je_id && isLiveEntry(db, link.reversed_by_je_id)) return null;
    }
    const closedFy = closedFiscalYearForDate(db, origHead.entry_date);
    if (closedFy) {
      return postClosedPeriodCounterVoucher(db, origHead, closedFy, { userId, date, reason });
    }
  }

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

  // v519: a voided document leaves no projection on sibling party books
  // (customer+supplier / supplier+person on one leaf). Native rows are retired
  // by the business void (party-ledger-retire); this covers the mirrors.
  retirePartyProjections(db, jeId, origHead, null);

  return alreadyDead ? null : jeId;
}

function retirePartyProjections(db, jeId, head, codes) {
  try {
    require('./party-leaf-sync').retireProjectionsForJournalEntry(db, jeId, head, codes);
  } catch (e) {
    if (db.inTransaction) throw e;
    console.error('party projections retire:', e.message);
  }
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
  let head = null;
  let codes = [];
  try {
    head = db.prepare('SELECT id, ref_type, ref_id FROM journal_entries WHERE id=?').get(jeId) || null;
    codes = db.prepare('SELECT DISTINCT account_code AS code FROM journal_lines WHERE entry_id=?')
      .all(jeId).map((r) => (r.code ? String(r.code) : '')).filter(Boolean);
  } catch (_) { /* nothing to retire */ }
  db.prepare('DELETE FROM journal_lines WHERE entry_id=?').run(jeId);
  db.prepare('DELETE FROM journal_entries WHERE id=?').run(jeId);
  if (head && codes.length) retirePartyProjections(db, jeId, head, codes);
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
  fiscalYearForDate,
  closedFiscalYearForDate,
  ensureReversalLinkColumns,
};
