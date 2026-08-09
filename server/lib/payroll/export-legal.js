'use strict';

/**
 * DRAFT legal payroll exports (P1-HR3).
 * Formats are provisional placeholders pending SSO / tax-expert sign-off.
 * Filenames and header comments intentionally include DRAFT.
 */

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => csvEscape(row[h])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function loadPeriodRecords(db, periodId) {
  const period = db.prepare('SELECT * FROM payroll_periods WHERE id=?').get(periodId);
  if (!period) throw new Error('دوره حقوق یافت نشد');
  const rows = db.prepare(`
    SELECT
      r.id AS record_id,
      p.personnel_code,
      p.national_id,
      p.insurance_id,
      p.tax_id,
      COALESCE(NULLIF(TRIM(p.first_name || ' ' || p.last_name), ''), p.name) AS full_name,
      r.gross_earnings_rial,
      r.insurance_base_rial,
      r.sso_employee_rial,
      r.sso_employer_rial,
      r.taxable_income_rial,
      r.income_tax_rial,
      r.net_pay_rial
    FROM payroll_records r
    JOIN persons p ON p.id = r.person_id
    WHERE r.period_id = ?
      AND COALESCE(r.status, 'posted') <> 'reversed'
    ORDER BY p.personnel_code, p.name, r.id
  `).all(periodId);
  return { period, rows };
}

/** @returns {string} CSV — DRAFT SSO insurance list */
function buildInsuranceListCsv(db, periodId) {
  const { period, rows } = loadPeriodRecords(db, periodId);
  const headers = [
    'period_label',
    'personnel_code',
    'national_id',
    'insurance_id',
    'full_name',
    'insurance_base_rial',
    'sso_employee_rial',
    'sso_employer_rial',
    'gross_earnings_rial',
  ];
  const data = rows.map(r => ({
    period_label: period.label,
    personnel_code: r.personnel_code || '',
    national_id: r.national_id || '',
    insurance_id: r.insurance_id || '',
    full_name: r.full_name || '',
    insurance_base_rial: r.insurance_base_rial || 0,
    sso_employee_rial: r.sso_employee_rial || 0,
    sso_employer_rial: r.sso_employer_rial || 0,
    gross_earnings_rial: r.gross_earnings_rial || 0,
  }));
  // Leading comment marks file as DRAFT (not final legal diskette format).
  return `# DRAFT payroll-insurance-list period=${period.id} — pending SSO expert\r\n` +
    toCsv(headers, data);
}

/** @returns {string} CSV — DRAFT salary-tax list */
function buildTaxDraftCsv(db, periodId) {
  const { period, rows } = loadPeriodRecords(db, periodId);
  const headers = [
    'period_label',
    'personnel_code',
    'national_id',
    'tax_id',
    'full_name',
    'taxable_income_rial',
    'income_tax_rial',
    'gross_earnings_rial',
    'net_pay_rial',
  ];
  const data = rows.map(r => ({
    period_label: period.label,
    personnel_code: r.personnel_code || '',
    national_id: r.national_id || '',
    tax_id: r.tax_id || '',
    full_name: r.full_name || '',
    taxable_income_rial: r.taxable_income_rial || 0,
    income_tax_rial: r.income_tax_rial || 0,
    gross_earnings_rial: r.gross_earnings_rial || 0,
    net_pay_rial: r.net_pay_rial || 0,
  }));
  return `# DRAFT payroll-tax-list period=${period.id} — pending tax expert\r\n` +
    toCsv(headers, data);
}

module.exports = { buildInsuranceListCsv, buildTaxDraftCsv };
