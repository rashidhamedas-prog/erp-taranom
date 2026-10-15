'use strict';
/**
 * Canonical Iran Labor / Tax pack for payroll (Solar year).
 * Sources: شورای عالی کار ۱۴۰۵، بخشنامه بیمه، قانون بودجه ماده ۸۴.
 * Amounts are RIAL. Seed is idempotent — fills missing/zero rows only unless force=true.
 */

const LEGAL_BY_YEAR = {
  1405: {
    label: 'مصوبات شورای عالی کار و بودجه ۱۴۰۵',
    min_wage_daily_rial: 5541850,
    housing_allowance_rial: 30000000,
    food_allowance_rial: 22000000,
    child_allowance_rial: 16625550,
    spouse_allowance_rial: 5000000,
    seniority_base_rial: 166667, // روزانه پایه سنوات
    insurance_multiple: 7, // سقف بیمه = ۷ × حداقل روزانه × روز دوره
    overtime_factor: 1.4,
    night_factor: 1.35,
    friday_factor: 1.4,
    shift_factor: 1.225,
    tax_exemption_rial: 400000000, // ماهانه = ۴۸۰ میلیارد ریال سالانه / ۱۲
    employee_insurance_bp: 700,
    employer_insurance_bp: 2300,
    // پلکان ماهانه ماده ۸۴ پس از کسر معافیت ماهانه (مبالغ مشمول ماهانه)
    tax_brackets_monthly: [
      { bracket_order: 1, bracket_min_rial: 0, bracket_max_rial: 400000000, tax_rate_bp: 1000 },
      { bracket_order: 2, bracket_min_rial: 400000000, bracket_max_rial: 600000000, tax_rate_bp: 1500 },
      { bracket_order: 3, bracket_min_rial: 600000000, bracket_max_rial: 800000000, tax_rate_bp: 2000 },
      { bracket_order: 4, bracket_min_rial: 800000000, bracket_max_rial: 1000000000, tax_rate_bp: 2500 },
      { bracket_order: 5, bracket_min_rial: 1000000000, bracket_max_rial: null, tax_rate_bp: 3000 },
    ],
  },
};

function legalPackForYear(year) {
  const y = Number(year);
  return LEGAL_BY_YEAR[y] || null;
}

function insuranceCapMonthly(pack, standardDays = 30) {
  if (!pack) return 0;
  const days = Math.max(1, Math.round(Number(standardDays) || 30));
  const mult = Math.max(1, Math.round(Number(pack.insurance_multiple) || 7));
  return Math.round(pack.min_wage_daily_rial * mult * days);
}

function ensureLaborColumn(db, name, definition) {
  const cols = db.prepare('PRAGMA table_info(payroll_labor_settings)').all().map(c => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE payroll_labor_settings ADD COLUMN ${name} ${definition}`);
}

/**
 * Seed / refresh legal labor settings + tax brackets for a fiscal year.
 * @returns {{ seeded: boolean, labor: object|null, brackets: number, forced: boolean }}
 */
function seedLegalPack(db, year, { force = false } = {}) {
  const y = Number(year);
  const pack = legalPackForYear(y);
  if (!pack) {
    return { seeded: false, labor: null, brackets: 0, forced: !!force, error: `بسته قانونی برای سال ${y} تعریف نشده` };
  }

  ensureLaborColumn(db, 'spouse_allowance_rial', 'INTEGER NOT NULL DEFAULT 0');

  const existing = db.prepare('SELECT * FROM payroll_labor_settings WHERE year=?').get(y);
  const isEmpty = !existing
    || (
      Number(existing.min_wage_daily_rial || 0) === 0
      && Number(existing.housing_allowance_rial || 0) === 0
      && Number(existing.food_allowance_rial || 0) === 0
      && Number(existing.tax_exemption_rial || 0) === 0
    );

  const cap = insuranceCapMonthly(pack, 30);
  let labor = existing || null;

  if (force || isEmpty) {
    db.prepare(`
      INSERT INTO payroll_labor_settings
        (year, min_wage_daily_rial, housing_allowance_rial, food_allowance_rial, child_allowance_rial,
         spouse_allowance_rial, seniority_base_rial, insurance_cap_monthly_rial, overtime_factor, night_factor,
         friday_factor, shift_factor, tax_exemption_rial)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(year) DO UPDATE SET
        min_wage_daily_rial=excluded.min_wage_daily_rial,
        housing_allowance_rial=excluded.housing_allowance_rial,
        food_allowance_rial=excluded.food_allowance_rial,
        child_allowance_rial=excluded.child_allowance_rial,
        spouse_allowance_rial=excluded.spouse_allowance_rial,
        seniority_base_rial=excluded.seniority_base_rial,
        insurance_cap_monthly_rial=excluded.insurance_cap_monthly_rial,
        overtime_factor=excluded.overtime_factor,
        night_factor=excluded.night_factor,
        friday_factor=excluded.friday_factor,
        shift_factor=excluded.shift_factor,
        tax_exemption_rial=excluded.tax_exemption_rial
    `).run(
      y,
      pack.min_wage_daily_rial,
      pack.housing_allowance_rial,
      pack.food_allowance_rial,
      pack.child_allowance_rial,
      pack.spouse_allowance_rial,
      pack.seniority_base_rial,
      cap,
      pack.overtime_factor,
      pack.night_factor,
      pack.friday_factor,
      pack.shift_factor,
      pack.tax_exemption_rial
    );
    labor = db.prepare('SELECT * FROM payroll_labor_settings WHERE year=?').get(y);
  } else if (existing && Number(existing.insurance_cap_monthly_rial || 0) === 0) {
    db.prepare('UPDATE payroll_labor_settings SET insurance_cap_monthly_rial=? WHERE year=?').run(cap, y);
    labor = db.prepare('SELECT * FROM payroll_labor_settings WHERE year=?').get(y);
  } else if (existing && Number(existing.spouse_allowance_rial || 0) === 0 && pack.spouse_allowance_rial) {
    db.prepare('UPDATE payroll_labor_settings SET spouse_allowance_rial=? WHERE year=?')
      .run(pack.spouse_allowance_rial, y);
    labor = db.prepare('SELECT * FROM payroll_labor_settings WHERE year=?').get(y);
  }

  const activeBrackets = db.prepare(`
    SELECT COUNT(*) c FROM payroll_tax_brackets WHERE fiscal_year=? AND active=1
  `).get(y).c;
  let bracketsWritten = 0;
  if (force || !activeBrackets) {
    // UNIQUE(fiscal_year, bracket_order) — must remove rows, not only deactivate
    db.prepare('DELETE FROM payroll_tax_brackets WHERE fiscal_year=?').run(y);
    const ins = db.prepare(`
      INSERT INTO payroll_tax_brackets
        (fiscal_year, bracket_order, bracket_min_rial, bracket_max_rial, tax_rate_bp, active)
      VALUES (?,?,?,?,?,1)
    `);
    for (const b of pack.tax_brackets_monthly) {
      ins.run(y, b.bracket_order, b.bracket_min_rial, b.bracket_max_rial, b.tax_rate_bp);
      bracketsWritten += 1;
    }
  }

  return {
    seeded: true,
    forced: !!force,
    labor,
    brackets: bracketsWritten || activeBrackets,
    pack,
    insurance_cap_monthly_rial: cap,
  };
}

/** Boot helper: ensure current/common years have a pack if empty. */
function ensureDefaultLegalPacks(db) {
  for (const year of [1405, 1404]) {
    try {
      if (legalPackForYear(year)) seedLegalPack(db, year, { force: false });
    } catch (e) {
      console.warn('ensureDefaultLegalPacks', year, e.message);
    }
  }
}

module.exports = {
  LEGAL_BY_YEAR,
  legalPackForYear,
  insuranceCapMonthly,
  seedLegalPack,
  ensureDefaultLegalPacks,
};
