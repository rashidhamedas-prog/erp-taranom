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
 *
 * Fix 7A supplier-per-leaf: suppliers whose coa_code sits outside coa_payable (e.g.
 * under 110601) are folded into totalPayable / supplierAdvances via
 * supplierPayableGrossByLeaf, and books_mismatch_ap is per-supplier leaf vs ledger.
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

function glControlGrossByLeaf(db, prefix, { asOf, debitNormal, excludeCodes } = {}) {
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
  const exclude = excludeCodes instanceof Set
    ? excludeCodes
    : new Set((excludeCodes || []).map((c) => String(c)));
  let gross = 0;
  let contra = 0;
  for (const r of rows) {
    if (exclude.size && exclude.has(String(r.code))) continue;
    const d = Number(r.debit) || 0;
    const c = Number(r.credit) || 0;
    const signed = debitNormal ? (d - c) : (c - d);
    if (signed > 0) gross += signed;
    else if (signed < 0) contra += -signed;
  }
  return { gross, contra, net: gross - contra };
}

/**
 * Leaf codes that appear on BOTH a supplier and a customer (shared dual-role leaf).
 * Those leaves belong on the AP fold once; they must not also inflate AR advances.
 */
function dualPartySupplierCustomerLeaves(db) {
  try {
    return db.prepare(`
      SELECT DISTINCT TRIM(s.coa_code) AS code
      FROM suppliers s
      JOIN customers c ON TRIM(c.coa_code) = TRIM(s.coa_code)
      WHERE s.coa_code IS NOT NULL AND TRIM(s.coa_code) <> ''
        AND c.coa_code IS NOT NULL AND TRIM(c.coa_code) <> ''
    `).all().map((r) => String(r.code));
  } catch (_) {
    return [];
  }
}

/**
 * Payable gross/contra: every leaf under payablePrefix, plus each supplier's own
 * coa_code leaf when it sits outside that prefix. Each account_code counted once.
 * Credit-normal (payable positive → gross; debit/advance → contra).
 */
function supplierPayableGrossByLeaf(db, payablePrefix, { asOf } = {}) {
  const prefix = String(payablePrefix || '');
  const like = prefix + '%';
  const params = [];
  let asOfSql = '';
  if (asOf) {
    asOfSql = ' AND je.entry_date <= ?';
    params.push(asOf);
  }
  params.push(like, like);
  const rows = db.prepare(`
    SELECT jl.account_code AS code,
      COALESCE(SUM(${SQL_JL_DEBIT_RIAL}), 0) AS debit,
      COALESCE(SUM(${SQL_JL_CREDIT_RIAL}), 0) AS credit
    FROM journal_lines jl
    JOIN journal_entries je ON jl.entry_id = je.id
    WHERE ${JE_ALIVE}
      ${asOfSql}
      AND (
        jl.account_code LIKE ?
        OR jl.account_code IN (
          SELECT TRIM(s.coa_code) FROM suppliers s
          WHERE s.coa_code IS NOT NULL AND TRIM(s.coa_code) <> ''
            AND TRIM(s.coa_code) NOT LIKE ?
        )
      )
    GROUP BY jl.account_code
  `).all(...params);
  let gross = 0;
  let contra = 0;
  for (const r of rows) {
    const d = Number(r.debit) || 0;
    const c = Number(r.credit) || 0;
    const signed = c - d;
    if (signed > 0) gross += signed;
    else if (signed < 0) contra += -signed;
  }
  return { gross, contra, net: gross - contra };
}

/**
 * Per-supplier books vs own GL leaf (account_code = coa_code exactly — never LIKE parent).
 * Signed credit-normal: payable positive, advance/debit negative.
 * Returns one row per supplier that has a coa_code (even when both sides are zero).
 */
function supplierBooksByLeaf(db, { asOf } = {}) {
  let suppliers = [];
  try {
    suppliers = db.prepare(`
      SELECT id, name, TRIM(coa_code) AS coa_code
      FROM suppliers
      WHERE coa_code IS NOT NULL AND TRIM(coa_code) <> ''
      ORDER BY id
    `).all();
  } catch (_) {
    return [];
  }
  if (!suppliers.length) return [];

  const ledParams = [];
  let ledAsOf = '';
  if (asOf) { ledAsOf = ' WHERE date <= ?'; ledParams.push(asOf); }
  const ledRows = db.prepare(`
    SELECT supplier_id,
      COALESCE(SUM(credit), 0) AS credit,
      COALESCE(SUM(debit), 0) AS debit
    FROM supplier_ledger
    ${ledAsOf}
    GROUP BY supplier_id
  `).all(...ledParams);
  const ledById = new Map();
  for (const r of ledRows) {
    ledById.set(Number(r.supplier_id), Math.round((Number(r.credit) || 0) - (Number(r.debit) || 0)));
  }

  const codes = [...new Set(suppliers.map((s) => String(s.coa_code)))];
  const glByCode = new Map();
  if (codes.length) {
    const ph = codes.map(() => '?').join(',');
    const glParams = [...codes];
    let glAsOf = '';
    if (asOf) { glAsOf = ' AND je.entry_date <= ?'; glParams.push(asOf); }
    const glRows = db.prepare(`
      SELECT jl.account_code AS code,
        COALESCE(SUM(${SQL_JL_DEBIT_RIAL}), 0) AS debit,
        COALESCE(SUM(${SQL_JL_CREDIT_RIAL}), 0) AS credit
      FROM journal_lines jl
      JOIN journal_entries je ON jl.entry_id = je.id
      WHERE jl.account_code IN (${ph})
        AND ${JE_ALIVE}
        ${glAsOf}
      GROUP BY jl.account_code
    `).all(...glParams);
    for (const g of glRows) {
      glByCode.set(String(g.code), Math.round((Number(g.credit) || 0) - (Number(g.debit) || 0)));
    }
  }

  return suppliers.map((s) => {
    const ledger = ledById.get(Number(s.id)) || 0;
    const gl = glByCode.get(String(s.coa_code)) || 0;
    return {
      id: Number(s.id),
      name: s.name || '',
      coa_code: s.coa_code,
      ledger,
      gl,
      delta: ledger - gl,
    };
  });
}

/** Up to `limit` suppliers whose |ledger − gl| > 1, largest abs delta first. */
function supplierBooksMismatchList(db, { asOf, limit } = {}) {
  const max = Number(limit) > 0 ? Number(limit) : 8;
  const all = supplierBooksByLeaf(db, { asOf });
  const out = all.filter((r) => Math.abs(Number(r.delta) || 0) > 1);
  out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { count: out.length, rows: out.slice(0, max) };
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

module.exports = {
  glControlGrossByLeaf,
  supplierPayableGrossByLeaf,
  supplierBooksByLeaf,
  supplierBooksMismatchList,
  dualPartySupplierCustomerLeaves,
  unbalancedEntryCount,
  JE_ALIVE,
  JE_APPROVED,
};
