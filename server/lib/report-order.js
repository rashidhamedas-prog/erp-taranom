'use strict';

/**
 * One chronology for every dated report.
 * Business date first (Jalali, padded or not), then created_at, then id.
 * A running balance is only meaningful after this sort — same rule as a
 * subsidiary ledger (posting date, then a stable tie-break).
 */

function reportDateKey(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/);
  if (!m) return s;
  return m[1] + m[2].padStart(2, '0') + m[3].padStart(2, '0');
}

function tieValue(row, key) {
  if (!row) return 0;
  const n = Number(row[key]);
  return Number.isFinite(n) ? n : 0;
}

function compareReportChronology(a, b, opts = {}) {
  const dateField = opts.date || 'date';
  const dir = opts.dir === 'desc' ? -1 : 1;
  const ka = reportDateKey(a && a[dateField]);
  const kb = reportDateKey(b && b[dateField]);
  if (ka !== kb) return ka < kb ? -dir : dir;
  const ties = opts.ties || ['created_at', 'id'];
  for (const key of ties) {
    const va = tieValue(a, key);
    const vb = tieValue(b, key);
    if (va !== vb) return va < vb ? -dir : dir;
  }
  return 0;
}

function sortReportRows(rows, opts) {
  if (!Array.isArray(rows) || rows.length < 2) return rows || [];
  rows.sort((a, b) => compareReportChronology(a, b, opts));
  return rows;
}

function sumDebitCredit(rows) {
  let totalDebit = 0;
  let totalCredit = 0;
  for (const e of rows || []) {
    totalDebit += Math.round(Number(e.debit) || 0);
    totalCredit += Math.round(Number(e.credit) || 0);
  }
  return { totalDebit, totalCredit };
}

module.exports = {
  reportDateKey,
  compareReportChronology,
  sortReportRows,
  sumDebitCredit,
};
