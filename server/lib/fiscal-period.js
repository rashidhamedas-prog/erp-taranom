// Fiscal year helpers — maps spec fiscal_periods → fiscal_years table.

function getActiveFiscalYearId(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key='active_fiscal_year_id'").get();
  if (row?.value) return parseInt(row.value, 10) || null;
  const fy = db.prepare("SELECT id FROM fiscal_years WHERE status='open' ORDER BY id DESC LIMIT 1").get();
  return fy?.id || null;
}

function getActiveFiscalYear(db) {
  const id = getActiveFiscalYearId(db);
  if (!id) return null;
  return db.prepare('SELECT * FROM fiscal_years WHERE id=?').get(id) || null;
}

function assertFiscalYearWritable(db, entryDate) {
  const fy = getActiveFiscalYear(db);
  if (!fy) return { ok: true };
  if (fy.status === 'locked') {
    return { ok: false, error: 'سال مالی فعال قفل است — سند جدید مجاز نیست' };
  }
  if (fy.end_date && entryDate && entryDate > fy.end_date) {
    return { ok: false, error: 'تاریخ سند خارج از سال مالی فعال است' };
  }
  if (fy.start_date && entryDate && entryDate < fy.start_date) {
    return { ok: false, error: 'تاریخ سند قبل از شروع سال مالی فعال است' };
  }
  return { ok: true, fiscalYearId: fy.id };
}

function resolveFiscalYearForDate(db, entryDate) {
  const rows = db.prepare("SELECT * FROM fiscal_years WHERE status IN ('open','closed') ORDER BY start_date DESC").all();
  for (const fy of rows) {
    const start = fy.start_date || '';
    const end = fy.end_date || '9999/99/99';
    if (entryDate >= start && entryDate <= end) return fy.id;
  }
  return getActiveFiscalYearId(db);
}

module.exports = {
  getActiveFiscalYearId,
  getActiveFiscalYear,
  assertFiscalYearWritable,
  resolveFiscalYearForDate,
};
