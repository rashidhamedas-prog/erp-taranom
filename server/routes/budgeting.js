const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting, requirePermission } = require('../middleware/auth');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');
const { JE_NOT_DRAFT } = require('../lib/je-live');
const { g2j, j2g } = require('../jalali');

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

function asciiDigits(s) {
  return String(s == null ? '' : s)
    .replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)));
}

/**
 * First standalone 4-digit Jalali year (13xx / 14xx) in free text.
 * '1405' → '1405'; '1405/01' → '1405'; 'سال مالی ۱۴۰۵' → '1405'; '2026' / 'abc' / '14051' → null.
 */
function jalaliYearInText(text) {
  const m = asciiDigits(text).match(/(?<!\d)(1[34]\d{2})(?!\d)/);
  return m ? m[1] : null;
}

/**
 * Resolve the Jalali year whose GL actuals a budget is compared against.
 * Precedence: the selected fiscal period row (fiscal_years.start_date, then its label) → budget.year_label.
 * The Gregorian clock is NEVER used as a fallback (the old `getFullYear()+621` produced e.g. 2647 and
 * silently rendered an all-zero "actual" column). Missing / malformed / conflicting years are reported
 * as a data-quality error for the caller to answer 422.
 * Returns { ok:true, year, source, fiscal_period } | { ok:false, error }.
 * Note: budget months are Jalali calendar months of `year`; a fiscal period that does not start on
 * 01/01 is still read by its starting Jalali year (non-calendar fiscal years are not modelled here).
 */
function resolveBudgetJalaliYear(db, budget) {
  const labelRaw = String((budget && budget.year_label) || '').trim();
  const labelYear = labelRaw ? jalaliYearInText(labelRaw) : null;
  if (labelRaw && !labelYear) {
    return {
      ok: false,
      error: `برچسب سال بودجه «${labelRaw}» سال شمسی معتبر نیست؛ سال را چهاررقمی وارد کنید (مثلاً ۱۴۰۵)`,
    };
  }
  let fiscalPeriod = null;
  let periodYear = null;
  if (budget && budget.fiscal_year_id) {
    try {
      fiscalPeriod = db.prepare('SELECT id, label, start_date, end_date, status FROM fiscal_years WHERE id=?')
        .get(budget.fiscal_year_id) || null;
    } catch (_) {
      fiscalPeriod = null; // table absent on exotic builds → fall back to the label
    }
    if (fiscalPeriod) {
      periodYear = jalaliYearInText(asciiDigits(fiscalPeriod.start_date).slice(0, 4))
        || jalaliYearInText(fiscalPeriod.label);
    }
  }
  if (periodYear && labelYear && periodYear !== labelYear) {
    return {
      ok: false,
      error: `سال دورهٔ مالی انتخاب‌شده (${periodYear}) با برچسب سال بودجه (${labelYear}) هم‌خوان نیست`,
    };
  }
  if (periodYear) {
    return {
      ok: true,
      year: periodYear,
      source: 'fiscal_period',
      fiscal_period: {
        id: fiscalPeriod.id,
        label: fiscalPeriod.label,
        start_date: fiscalPeriod.start_date,
        end_date: fiscalPeriod.end_date,
      },
    };
  }
  if (labelYear) return { ok: true, year: labelYear, source: 'year_label', fiscal_period: null };
  return {
    ok: false,
    error: 'سال مالی بودجه مشخص نیست؛ برچسب سال (مثلاً ۱۴۰۵) یا دورهٔ مالی معتبر برای بودجه تعیین کنید',
  };
}

/**
 * Jalali month (1..12) of a GL entry_date **within** `year`, or null when the date is not in that year.
 * Accepts 'YYYY/MM/DD' (also unpadded or Persian digits) and, defensively, ISO Gregorian
 * 'YYYY-MM-DD' which is converted with g2j — so 2026-03-21 lands in 1405/01, never in a
 * Gregorian-shifted month 12 of the previous year.
 */
function jalaliMonthInYear(entryDate, year) {
  const s = asciiDigits(entryDate).trim();
  let m = s.match(/^(\d{4})[/-](\d{1,2})(?:[/-](\d{1,2}))?/);
  if (m && /^1[34]\d{2}$/.test(m[1])) {
    if (m[1] !== String(year)) return null;
    const month = parseInt(m[2], 10);
    return month >= 1 && month <= 12 ? month : null;
  }
  m = s.match(/^((?:19|20)\d{2})-(\d{2})-(\d{2})$/);
  if (m) {
    const [jy, jm] = g2j(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
    return String(jy) === String(year) ? jm : null;
  }
  return null;
}

/** ISO Gregorian bounds of a Jalali year (used only to pick up ISO-stored entry_dates). */
function gregorianBoundsOfJalaliYear(year) {
  const y = parseInt(year, 10);
  const pad = (n) => String(n).padStart(2, '0');
  const [gy1, gm1, gd1] = j2g(y, 1, 1);
  const [gy2, gm2, gd2] = j2g(y + 1, 1, 1);
  const start = `${gy1}-${pad(gm1)}-${pad(gd1)}`;
  const end = `${gy2}-${pad(gm2)}-${pad(gd2)}`; // exclusive
  return { start, end };
}

function permit(action) {
  return (req, res, next) => {
    if (req.user?.role === 'admin' || req.user?.role === 'accounting') return next();
    return requirePermission('budgeting', action)(req, res, next);
  };
}

router.get('/', auth, permit('view'), (req, res) => {
  const db = getDB();
  const where = [], params = [];
  if (req.query.status) { where.push('status=?'); params.push(req.query.status); }
  if (req.query.year_label) { where.push('year_label=?'); params.push(req.query.year_label); }
  res.json(db.prepare(`
    SELECT b.*, (SELECT COUNT(*) FROM budget_lines bl WHERE bl.budget_id=b.id) line_count
    FROM budgets b
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY b.id DESC
  `).all(...params));
});

router.get('/:id', auth, permit('view'), (req, res) => {
  const db = getDB();
  const budget = db.prepare('SELECT * FROM budgets WHERE id=?').get(req.params.id);
  if (!budget) return res.status(404).json({ error: 'یافت نشد' });
  const lines = db.prepare('SELECT * FROM budget_lines WHERE budget_id=? ORDER BY month, account_code').all(budget.id);
  res.json({ ...budget, lines });
});

router.post('/', auth, permit('create'), (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) throw new Error('نام بودجه الزامی است');
    const db = getDB();
    const r = db.prepare(`
      INSERT INTO budgets (name, fiscal_year_id, year_label, status, notes, created_by)
      VALUES (?,?,?,?,?,?)
    `).run(
      b.name, b.fiscal_year_id || null, b.year_label || '', b.status || 'draft',
      b.notes || '', req.user.id
    );
    audit(req.user.id, 'create', 'budget', r.lastInsertRowid, b.name);
    res.json(db.prepare('SELECT * FROM budgets WHERE id=?').get(r.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', auth, permit('edit'), (req, res) => {
  try {
    const db = getDB();
    const row = db.prepare('SELECT * FROM budgets WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'یافت نشد' });
    const b = req.body || {};
    db.prepare(`
      UPDATE budgets SET name=?, fiscal_year_id=?, year_label=?, status=?, notes=?, updated_at=strftime('%s','now')
      WHERE id=?
    `).run(
      b.name ?? row.name, b.fiscal_year_id ?? row.fiscal_year_id,
      b.year_label ?? row.year_label, b.status ?? row.status,
      b.notes ?? row.notes, req.params.id
    );
    if (Array.isArray(b.lines)) {
      db.prepare('DELETE FROM budget_lines WHERE budget_id=?').run(req.params.id);
      const ins = db.prepare(`
        INSERT INTO budget_lines (budget_id, account_code, cost_center_id, month, amount_rial, category, notes)
        VALUES (?,?,?,?,?,?,?)
      `);
      db.transaction(() => {
        for (const line of b.lines) {
          ins.run(
            req.params.id, line.account_code || '', line.cost_center_id || null,
            parseInt(line.month, 10) || 1, Math.round(Number(line.amount_rial) || 0),
            line.category || 'opex', line.notes || ''
          );
        }
      })();
    }
    audit(req.user.id, 'update', 'budget', req.params.id, b.name || row.name);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', auth, permit('delete'), (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM budgets WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  db.transaction(() => {
    db.prepare('DELETE FROM budget_lines WHERE budget_id=?').run(req.params.id);
    db.prepare('DELETE FROM budgets WHERE id=?').run(req.params.id);
  })();
  audit(req.user.id, 'delete', 'budget', req.params.id, row.name);
  res.json({ ok: true });
});

router.get('/:id/variance', auth, permit('view'), (req, res) => {
  const db = getDB();
  const budget = db.prepare('SELECT * FROM budgets WHERE id=?').get(req.params.id);
  if (!budget) return res.status(404).json({ error: 'یافت نشد' });

  const lines = db.prepare(`
    SELECT account_code, month, SUM(amount_rial) budget_rial
    FROM budget_lines WHERE budget_id=?
    GROUP BY account_code, month
    ORDER BY month, account_code
  `).all(budget.id);

  // Jalali year comes from the fiscal period / label only — never from the Gregorian clock.
  const yearRes = resolveBudgetJalaliYear(db, budget);
  if (!yearRes.ok) {
    return res.status(422).json({ error: yearRes.error, code: 'budget_year_unresolved', budget_id: budget.id });
  }
  const year = yearRes.year;
  const gBounds = gregorianBoundsOfJalaliYear(year);
  // Rows are grouped per (account, entry_date); the Jalali month is derived in JS so unpadded or
  // ISO-stored dates still land in the right month. Amounts stay integer rial.
  const actualRows = db.prepare(`
    SELECT jl.account_code,
           je.entry_date,
           SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}) actual_rial
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE COALESCE(je.deleted_at, 0) = 0
      AND COALESCE(je.status, 'approved') <> 'reversed'
      AND ${JE_NOT_DRAFT}
      AND (substr(je.entry_date, 1, 4) = ? OR (je.entry_date >= ? AND je.entry_date < ?))
    GROUP BY jl.account_code, je.entry_date
  `).all(String(year), gBounds.start, gBounds.end);

  const actualMap = {};
  for (const a of actualRows) {
    const month = jalaliMonthInYear(a.entry_date, year);
    if (!month) continue;
    const key = `${a.account_code}:${month}`;
    actualMap[key] = (actualMap[key] || 0) + Math.round(Number(a.actual_rial) || 0);
  }

  const rows = lines.map(l => {
    const key = `${l.account_code}:${l.month}`;
    const actual = actualMap[key] || 0;
    return {
      account_code: l.account_code,
      month: l.month,
      budget_rial: l.budget_rial,
      actual_rial: actual,
      variance_rial: (l.budget_rial || 0) - actual,
    };
  });

  const totals = rows.reduce((s, r) => ({
    budget_rial: s.budget_rial + r.budget_rial,
    actual_rial: s.actual_rial + r.actual_rial,
    variance_rial: s.variance_rial + r.variance_rial,
  }), { budget_rial: 0, actual_rial: 0, variance_rial: 0 });

  res.json({
    budget_id: budget.id,
    year_label: budget.year_label,
    fiscal_year: year,
    year_source: yearRes.source,
    fiscal_period: yearRes.fiscal_period,
    rows,
    totals,
  });
});

module.exports = router;
// Pure helpers exposed for unit tests (router is a function object; these do not register routes).
router.resolveBudgetJalaliYear = resolveBudgetJalaliYear;
router.jalaliYearInText = jalaliYearInText;
router.jalaliMonthInYear = jalaliMonthInYear;
router.gregorianBoundsOfJalaliYear = gregorianBoundsOfJalaliYear;
