'use strict';
/**
 * Salary rulings (حکم حقوقی) — multi-ruling per person with issue + effective dates.
 * Basis for a payroll period = latest active ruling overlapping the period.
 */

function ensureColumn(db, table, name, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function dropUniquePersonYear(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='salary_structures'").get();
  if (!row?.sql) return;
  if (!/UNIQUE\s*\(\s*person_id\s*,\s*fiscal_year\s*\)/i.test(row.sql)) return;
  const tmp = 'salary_structures__multi';
  // ALTER TABLE … RENAME leaves the name quoted in sqlite_master ("salary_structures").
  const nameRe = /CREATE TABLE(?: IF NOT EXISTS)?\s+(?:"salary_structures"|`salary_structures`|\[salary_structures\]|salary_structures\b)/i;
  if (!nameRe.test(row.sql)) {
    console.error('dropUniquePersonYear salary_structures: unrecognised CREATE TABLE header');
    return;
  }
  const createSql = row.sql
    .replace(nameRe, `CREATE TABLE ${tmp}`)
    .replace(/,?\s*UNIQUE\s*\(\s*person_id\s*,\s*fiscal_year\s*\)/i, '');
  const cols = db.prepare('PRAGMA table_info(salary_structures)').all().map(c => `"${c.name}"`);
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    db.transaction(() => {
      db.exec(`DROP TABLE IF EXISTS ${tmp}`);
      db.exec(createSql);
      db.exec(`INSERT INTO ${tmp} (${cols.join(',')}) SELECT ${cols.join(',')} FROM salary_structures`);
      db.exec('DROP TABLE salary_structures');
      db.exec(`ALTER TABLE ${tmp} RENAME TO salary_structures`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_salary_structures_person_year ON salary_structures(person_id, fiscal_year)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_salary_structures_person_eff ON salary_structures(person_id, effective_from, id)`);
    })();
  } catch (e) {
    try { db.exec(`DROP TABLE IF EXISTS ${tmp}`); } catch (_) {}
    console.error('dropUniquePersonYear salary_structures', e.message);
  } finally {
    db.exec('PRAGMA foreign_keys=ON');
  }
}

function initSalaryRulingExtras(db) {
  dropUniquePersonYear(db);
  ensureColumn(db, 'salary_structures', 'issue_date', 'TEXT');
  ensureColumn(db, 'salary_structures', 'ruling_no', 'TEXT');
  ensureColumn(db, 'salary_structures', 'arrears_note', 'TEXT');
  // Backfill issue_date from effective_from / created
  db.prepare(`
    UPDATE salary_structures
    SET issue_date = COALESCE(NULLIF(issue_date,''), NULLIF(effective_from,''), printf('%04d/01/01', fiscal_year))
    WHERE issue_date IS NULL OR issue_date=''
  `).run();
  db.prepare(`
    UPDATE salary_structures
    SET effective_from = COALESCE(NULLIF(effective_from,''), NULLIF(issue_date,''), printf('%04d/01/01', fiscal_year))
    WHERE effective_from IS NULL OR effective_from=''
  `).run();

  ensureColumn(db, 'payroll_records', 'salary_structure_id', 'INTEGER');
  ensureColumn(db, 'payroll_records', 'arrears_rial', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'payroll_records', 'structure_snapshot_json', 'TEXT');
}

function periodHasPostedPayroll(db, personId, periodId) {
  const row = db.prepare(`
    SELECT id FROM payroll_records
    WHERE person_id=? AND period_id=? AND COALESCE(status,'posted')<>'reversed'
    LIMIT 1
  `).get(personId, periodId);
  return !!row;
}

function personHasPayrollInMonth(db, personId, year, monthNo) {
  const row = db.prepare(`
    SELECT r.id
    FROM payroll_records r
    JOIN payroll_periods p ON p.id=r.period_id
    WHERE r.person_id=? AND p.fiscal_year=? AND p.month_no=?
      AND COALESCE(r.status,'posted')<>'reversed'
    LIMIT 1
  `).get(personId, year, monthNo);
  return !!row;
}

function parseJalaliYearMonth(dateStr) {
  const s = String(dateStr || '');
  const m = s.match(/^(\d{4})\/(\d{1,2})/);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]) };
}

/**
 * Months that already have a live payroll document for this person cannot host
 * a new ruling's issue or effective start.
 */
function assertRulingDatesAllowed(db, personId, issueDate, effectiveFrom, excludeRulingId) {
  for (const d of [issueDate, effectiveFrom]) {
    const ym = parseJalaliYearMonth(d);
    if (!ym) continue;
    if (personHasPayrollInMonth(db, personId, ym.year, ym.month)) {
      const locked = db.prepare(`
        SELECT r.id FROM payroll_records r
        JOIN payroll_periods p ON p.id=r.period_id
        WHERE r.person_id=? AND p.fiscal_year=? AND p.month_no=?
          AND COALESCE(r.status,'posted')<>'reversed'
          ${excludeRulingId ? 'AND COALESCE(r.salary_structure_id,0)<>?' : ''}
        LIMIT 1
      `).get(...(excludeRulingId
        ? [personId, ym.year, ym.month, excludeRulingId]
        : [personId, ym.year, ym.month]));
      if (locked) {
        throw Object.assign(
          new Error(`ماه ${ym.year}/${String(ym.month).padStart(2, '0')} سند حقوق دارد؛ حکم جدید با صدور/اجرا در این ماه مجاز نیست`),
          { status: 409, code: 'E_PAYROLL_MONTH_LOCKED' }
        );
      }
    }
  }
}

/**
 * Block mutating an existing ruling if any overlapping month already has payroll.
 */
function assertRulingMutable(db, ruling) {
  if (!ruling) return;
  const from = ruling.effective_from || ruling.issue_date;
  const to = ruling.effective_to || null;
  const rows = db.prepare(`
    SELECT r.id, p.label
    FROM payroll_records r
    JOIN payroll_periods p ON p.id=r.period_id
    WHERE r.person_id=?
      AND COALESCE(r.status,'posted')<>'reversed'
      AND (
        r.salary_structure_id=?
        OR (
          p.start_date >= COALESCE(?, p.start_date)
          AND p.start_date <= COALESCE(?, p.start_date)
        )
      )
    LIMIT 1
  `).get(ruling.person_id, ruling.id, from || '0000/01/01', to || '9999/12/29');
  if (rows) {
    throw Object.assign(
      new Error(`حکم قابل تغییر نیست؛ سند حقوق دوره «${rows.label}» ثبت شده است`),
      { status: 409, code: 'E_RULING_LOCKED_BY_PAYROLL' }
    );
  }
}

/**
 * Latest active ruling overlapping [period.start_date, period.end_date].
 */
function resolveActiveRuling(db, personId, period) {
  const start = period.start_date;
  const end = period.end_date;
  const year = period.fiscal_year;
  let structure = db.prepare(`
    SELECT * FROM salary_structures
    WHERE person_id=? AND active=1
      AND (effective_from IS NULL OR effective_from='' OR effective_from <= ?)
      AND (effective_to IS NULL OR effective_to='' OR effective_to >= ?)
    ORDER BY COALESCE(effective_from,'') DESC, COALESCE(issue_date,'') DESC, id DESC
    LIMIT 1
  `).get(personId, end, start);

  if (!structure) {
    // Fallback: same fiscal year without date overlap (legacy rows)
    structure = db.prepare(`
      SELECT * FROM salary_structures
      WHERE person_id=? AND fiscal_year=? AND active=1
      ORDER BY COALESCE(effective_from,'') DESC, id DESC
      LIMIT 1
    `).get(personId, year);
  }
  return structure || null;
}

/**
 * Unpaid months from effective_from up to (but not including) current period
 * where no payroll_record exists — for arrears bundled with the ruling.
 */
function computeArrearsMonths(db, personId, ruling, currentPeriod) {
  if (!ruling?.effective_from || !ruling?.issue_date) return [];
  if (String(ruling.issue_date) <= String(ruling.effective_from)) return [];
  const startYm = parseJalaliYearMonth(ruling.effective_from);
  const curYm = { year: currentPeriod.fiscal_year, month: currentPeriod.month_no };
  if (!startYm) return [];
  const months = [];
  let y = startYm.year;
  let m = startYm.month;
  while (y < curYm.year || (y === curYm.year && m < curYm.month)) {
    if (!personHasPayrollInMonth(db, personId, y, m)) {
      months.push({ year: y, month: m, label: `${y}/${String(m).padStart(2, '0')}` });
    }
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    if (months.length > 24) break;
  }
  return months;
}

module.exports = {
  initSalaryRulingExtras,
  resolveActiveRuling,
  assertRulingDatesAllowed,
  assertRulingMutable,
  periodHasPostedPayroll,
  personHasPayrollInMonth,
  computeArrearsMonths,
  parseJalaliYearMonth,
};
