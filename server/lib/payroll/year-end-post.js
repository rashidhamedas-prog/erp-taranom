'use strict';
/**
 * Post year-end eidi/severance with reserve release.
 * If monthly accruals exist for the person/year, release 2110/2111 first;
 * only the shortfall hits expense accounts (avoids double-count).
 */

const { postToLedger } = require('../ledger');
const { acct: coaAcct } = require('../coa-map');
const { resolvePersonPayableAccount } = require('./person-account');
const { todayJalali } = require('../../jalali');

function ensureYearEndReleaseColumns(db) {
  const cols = db.prepare('PRAGMA table_info(payroll_monthly_accruals)').all().map(c => c.name);
  if (!cols.includes('released_year_end_id')) {
    db.exec('ALTER TABLE payroll_monthly_accruals ADD COLUMN released_year_end_id INTEGER');
  }
  if (!cols.includes('released_at')) {
    db.exec('ALTER TABLE payroll_monthly_accruals ADD COLUMN released_at INTEGER');
  }
}

function unreleasedAccruals(db, personId, fiscalYear) {
  ensureYearEndReleaseColumns(db);
  return db.prepare(`
    SELECT * FROM payroll_monthly_accruals
    WHERE person_id=?
      AND period_label LIKE ?
      AND released_year_end_id IS NULL
    ORDER BY id ASC
  `).all(personId, `${fiscalYear}/%`);
}

function sumUnreleased(db, personId, fiscalYear) {
  const rows = unreleasedAccruals(db, personId, fiscalYear);
  let eidi = 0;
  let severance = 0;
  for (const r of rows) {
    eidi += Math.round(Number(r.eidi_rial) || 0);
    severance += Math.round(Number(r.severance_rial) || 0);
  }
  return { eidi_rial: eidi, severance_rial: severance, rows };
}

/**
 * Build JE lines + mark accruals released. Must run inside a transaction.
 */
function postYearEndWithReserveRelease(db, {
  row,
  person,
  date,
  userId,
  createPersonLedgerEntry,
}) {
  ensureYearEndReleaseColumns(db);
  const payable = resolvePersonPayableAccount(db, person);
  const reserved = sumUnreleased(db, row.person_id, row.fiscal_year);
  const eidi = Math.round(Number(row.eidi_rial) || 0);
  const severance = Math.round(Number(row.severance_rial) || 0);
  const tax = Math.round(Number(row.income_tax_rial) || 0);
  const net = Math.round(Number(row.net_pay_rial) || 0);

  const releaseEidi = Math.min(eidi, reserved.eidi_rial);
  const releaseSev = Math.min(severance, reserved.severance_rial);
  const expEidi = Math.max(0, eidi - releaseEidi);
  const expSev = Math.max(0, severance - releaseSev);

  const lines = [];
  if (releaseEidi > 0) {
    lines.push({ ...coaAcct(db, 'coa_eidi_payable'), debit: releaseEidi / 10, credit: 0 });
  }
  if (releaseSev > 0) {
    lines.push({ ...coaAcct(db, 'coa_severance_payable'), debit: releaseSev / 10, credit: 0 });
  }
  if (expEidi > 0) {
    lines.push({ ...coaAcct(db, 'coa_eidi_expense'), debit: expEidi / 10, credit: 0 });
  }
  if (expSev > 0) {
    lines.push({ ...coaAcct(db, 'coa_severance_expense'), debit: expSev / 10, credit: 0 });
  }
  lines.push({ code: payable.code, name: payable.name, debit: 0, credit: net / 10 });
  if (tax > 0) {
    lines.push({ ...coaAcct(db, 'coa_payroll_tax_payable'), debit: 0, credit: tax / 10 });
  }

  const payDate = date || todayJalali();
  const journalId = postToLedger(db, {
    sourceType: 'payroll_year_end',
    sourceId: row.id,
    date: payDate,
    description: `عیدی و سنوات ${row.person_name || person.name} سال ${row.fiscal_year}`
      + (releaseEidi + releaseSev > 0 ? ' (آزادسازی ذخیره ماهانه)' : ''),
    createdBy: userId,
    lines,
  });

  db.prepare(`
    UPDATE payroll_year_end_bonuses SET status='posted', journal_entry_id=?, posted_at=strftime('%s','now') WHERE id=?
  `).run(journalId, row.id);

  if (reserved.rows.length && (releaseEidi > 0 || releaseSev > 0)) {
    const mark = db.prepare(`
      UPDATE payroll_monthly_accruals
      SET released_year_end_id=?, released_at=strftime('%s','now')
      WHERE id=?
    `);
    for (const r of reserved.rows) mark.run(row.id, r.id);
  }

  createPersonLedgerEntry(db, {
    person_id: row.person_id,
    date: payDate,
    entry_type: 'payroll_year_end',
    ref_type: 'payroll_year_end',
    ref_id: row.id,
    description: `عیدی و سنوات ${row.fiscal_year}`,
    debit: 0,
    credit: net / 10,
    user_id: userId,
  });

  return {
    journal_id: journalId,
    released_eidi_rial: releaseEidi,
    released_severance_rial: releaseSev,
    expense_eidi_rial: expEidi,
    expense_severance_rial: expSev,
  };
}

module.exports = {
  ensureYearEndReleaseColumns,
  unreleasedAccruals,
  sumUnreleased,
  postYearEndWithReserveRelease,
};
