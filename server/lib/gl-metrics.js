'use strict';
/**
 * Audit 7A — GL dashboard metrics.
 *
 * glControlGrossByLeaf folds every leaf (distinct journal_lines.account_code under a
 * control prefix) SEPARATELY, so a supplier with a debit balance (advance paid) never
 * silently cancels another supplier's payable (and likewise for customers).
 *
 *   gross  = Σ of leaves whose balance is on the account's normal side
 *   contra = Σ |leaves| whose balance is on the opposite side (advances)
 *   net    = gross − contra   (signed — never clamped to zero)
 */
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('./money');
const { DELETED_FILTER } = require('./ledger');

/** Same liveness rule as routes/accounting.js JE_ALIVE (reversed/void are dead unless paired). */
const JE_ALIVE = `${DELETED_FILTER} AND (
  COALESCE(je.status,'posted') NOT IN ('reversed','void')
  OR EXISTS (
    SELECT 1 FROM journal_entries _rev
    WHERE COALESCE(_rev.deleted_at,0)=0
      AND _rev.description LIKE ('ابطال سند #' || je.id || '%')
  )
)`;

/** Trial balance = live AND approved/posted (drafts excluded). */
const JE_APPROVED = `(COALESCE(je.status,'approved') IN ('approved','posted'))`;

function glControlGrossByLeaf(db, prefix, { asOf, debitNormal } = {}) {
  const params = [String(prefix || '') + '%'];
  let asOfSql = '';
  if (asOf) {
    asOfSql = ' AND je.entry_date <= ?';
    params.push(asOf);
  }
  const rows = db.prepare(`
    SELECT jl.account_code AS code,
      COALESCE(SUM(${SQL_JL_DEBIT_RIAL}), 0) AS debit,
      COALESCE(SUM(${SQL_JL_CREDIT_RIAL}), 0) AS credit
    FROM journal_lines jl
    JOIN journal_entries je ON jl.entry_id = je.id
    WHERE jl.account_code LIKE ?
      AND ${JE_ALIVE}
      ${asOfSql}
    GROUP BY jl.account_code
  `).all(...params);
  let gross = 0;
  let contra = 0;
  for (const r of rows) {
    const d = Number(r.debit) || 0;
    const c = Number(r.credit) || 0;
    const signed = debitNormal ? (d - c) : (c - d);
    if (signed > 0) gross += signed;
    else if (signed < 0) contra += -signed;
  }
  return { gross, contra, net: gross - contra };
}

/** Number of live approved entries whose own debit ≠ credit by ≥ 1 rial. */
function unbalancedEntryCount(db, { from, to } = {}) {
  const params = [];
  let dateSql = '';
  if (from) { dateSql += ' AND je.entry_date >= ?'; params.push(from); }
  if (to) { dateSql += ' AND je.entry_date <= ?'; params.push(to); }
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT jl.entry_id
      FROM journal_lines jl JOIN journal_entries je ON jl.entry_id = je.id
      WHERE ${JE_ALIVE} AND ${JE_APPROVED}
        ${dateSql}
      GROUP BY jl.entry_id
      HAVING ABS(COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) - COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0)) >= 1
    )
  `).get(...params);
  return Number(row && row.n) || 0;
}

module.exports = { glControlGrossByLeaf, unbalancedEntryCount, JE_ALIVE, JE_APPROVED };
