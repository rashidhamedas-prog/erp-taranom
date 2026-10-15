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
      r.insurance_exempt_rial,
      r.sso_employee_rial,
      r.sso_employer_rial,
      r.sso_employer_base_rial,
      r.sso_unemployment_rial,
      r.working_days_x100,
      r.taxable_income_rial,
      r.income_tax_rial,
      r.net_pay_rial,
      r.settlement_mode
    FROM payroll_records r
    JOIN persons p ON p.id = r.person_id
    WHERE r.period_id = ?
      AND COALESCE(r.status, 'posted') <> 'reversed'
    ORDER BY p.personnel_code, p.name, r.id
  `).all(periodId);
  const statutory = rows.filter(r => r.settlement_mode !== 'manual_exempt');
  return { period, rows: statutory, excluded: rows.length - statutory.length };
}

function enrichSsoSplit(r) {
  const emp = Math.round(Number(r.sso_employee_rial) || 0);
  const employerTotal = Math.round(Number(r.sso_employer_rial) || 0);
  const empBase = r.sso_employer_base_rial != null
    ? Math.round(Number(r.sso_employer_base_rial) || 0)
    : Math.round(employerTotal * 2000 / 2300);
  const unemployment = r.sso_unemployment_rial != null
    ? Math.round(Number(r.sso_unemployment_rial) || 0)
    : Math.max(0, employerTotal - empBase);
  return {
    sso_employee_7pct_rial: emp,
    sso_employer_20pct_rial: empBase,
    sso_unemployment_3pct_rial: unemployment,
    sso_total_rial: emp + employerTotal,
  };
}

/** @returns {string} CSV — DRAFT SSO insurance list */
function buildInsuranceListCsv(db, periodId) {
  const { period, rows, excluded } = loadPeriodRecords(db, periodId);
  const headers = [
    'period_label',
    'personnel_code',
    'national_id',
    'insurance_id',
    'full_name',
    'working_days',
    'insurance_base_rial',
    'insurance_exempt_rial',
    'sso_employee_7pct_rial',
    'sso_employer_20pct_rial',
    'sso_unemployment_3pct_rial',
    'sso_employer_total_rial',
    'sso_total_rial',
    'gross_earnings_rial',
  ];
  const data = rows.map(r => {
    const split = enrichSsoSplit(r);
    return {
      period_label: period.label,
      personnel_code: r.personnel_code || '',
      national_id: r.national_id || '',
      insurance_id: r.insurance_id || '',
      full_name: r.full_name || '',
      working_days: r.working_days_x100 != null
        ? (Number(r.working_days_x100) / 100).toFixed(2)
        : '',
      insurance_base_rial: r.insurance_base_rial || 0,
      insurance_exempt_rial: r.insurance_exempt_rial || 0,
      sso_employee_7pct_rial: split.sso_employee_7pct_rial,
      sso_employer_20pct_rial: split.sso_employer_20pct_rial,
      sso_unemployment_3pct_rial: split.sso_unemployment_3pct_rial,
      sso_employer_total_rial: r.sso_employer_rial || 0,
      sso_total_rial: split.sso_total_rial,
      gross_earnings_rial: r.gross_earnings_rial || 0,
    };
  });
  // Leading comment marks file as DRAFT (not final legal diskette format).
  return `# DRAFT payroll-insurance-list period=${period.id} — pending SSO expert; excluded_manual_exempt=${excluded}; cols=7/20/3 split\r\n` +
    toCsv(headers, data);
}

/** @returns {string} CSV — DRAFT salary-tax list */
function buildTaxDraftCsv(db, periodId) {
  const { period, rows, excluded } = loadPeriodRecords(db, periodId);
  const headers = [
    'period_label',
    'personnel_code',
    'national_id',
    'tax_id',
    'full_name',
    'working_days',
    'taxable_income_rial',
    'income_tax_rial',
    'gross_earnings_rial',
    'net_pay_rial',
    'sso_employee_7pct_rial',
  ];
  const data = rows.map(r => {
    const split = enrichSsoSplit(r);
    return {
      period_label: period.label,
      personnel_code: r.personnel_code || '',
      national_id: r.national_id || '',
      tax_id: r.tax_id || '',
      full_name: r.full_name || '',
      working_days: r.working_days_x100 != null
        ? (Number(r.working_days_x100) / 100).toFixed(2)
        : '',
      taxable_income_rial: r.taxable_income_rial || 0,
      income_tax_rial: r.income_tax_rial || 0,
      gross_earnings_rial: r.gross_earnings_rial || 0,
      net_pay_rial: r.net_pay_rial || 0,
      sso_employee_7pct_rial: split.sso_employee_7pct_rial,
    };
  });
  return `# DRAFT payroll-tax-list period=${period.id} — pending tax expert; excluded_manual_exempt=${excluded}\r\n` +
    toCsv(headers, data);
}

module.exports = { buildInsuranceListCsv, buildTaxDraftCsv };
