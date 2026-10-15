'use strict';
/**
 * Monthly leave reserve (مرخصی استحقاقی) — Iranian Labor Code: ~2.5 days/month
 * (26 working days ≈ 30 calendar / year → 2.5 / month).
 *
 * Accrual JE: Dr coa_leave_expense / Cr coa_leave_payable
 * Cash-out:   Dr coa_leave_payable / Cr person payable (or bank via payment flow)
 * R13 void: reverse JE + soft-status.
 */

const { postToLedger } = require('../ledger');
const { reverseJournalEntry } = require('../void-journal');
const { acct: coaAcct } = require('../coa-map');
const { todayJalali } = require('../../jalali');

const LEAVE_DAYS_PER_MONTH_X100 = 250; // 2.5 days

function ensureLeaveAccrualSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payroll_leave_accruals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_label TEXT NOT NULL,
      person_id INTEGER NOT NULL,
      days_x100 INTEGER NOT NULL DEFAULT 250,
      amount_rial INTEGER NOT NULL DEFAULT 0,
      daily_wage_rial INTEGER NOT NULL DEFAULT 0,
      je_id INTEGER,
      status TEXT NOT NULL DEFAULT 'posted'
        CHECK(status IN ('posted','cashed_out','reversed')),
      cash_out_je_id INTEGER,
      cashed_out_at INTEGER,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      reversed_at INTEGER,
      reversed_by INTEGER,
      UNIQUE(person_id, period_label),
      FOREIGN KEY(person_id) REFERENCES persons(id)
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_leave_accruals_period
      ON payroll_leave_accruals(period_label, status);
  `);
}

function resolveDailyWageRial(db, personId, year, laborSettings) {
  const st = db.prepare(`
    SELECT * FROM salary_structures
    WHERE person_id=? AND fiscal_year=? AND active=1
    ORDER BY id DESC LIMIT 1
  `).get(personId, year);
  if (st) {
    const basis = st.wage_basis || 'monthly';
    const base = Math.round(Number(st.base_wage_rial) || 0);
    if (basis === 'daily') return base;
    if (basis === 'hourly') return Math.round(base * 733 / 100);
    return Math.round(base / 30);
  }
  const person = db.prepare('SELECT monthly_salary_rial FROM persons WHERE id=?').get(personId);
  const monthly = Math.round(Number(person?.monthly_salary_rial) || 0);
  if (monthly > 0) return Math.round(monthly / 30);
  const minDaily = Math.round(Number(laborSettings?.min_wage_daily_rial) || 0);
  return minDaily;
}

function monthlyLeaveAmount(db, personId, year, laborSettings) {
  const daily = resolveDailyWageRial(db, personId, year, laborSettings);
  if (daily <= 0) return null;
  const amount = Math.round(daily * LEAVE_DAYS_PER_MONTH_X100 / 100);
  return { daily_wage_rial: daily, days_x100: LEAVE_DAYS_PER_MONTH_X100, amount_rial: amount };
}

function postMonthlyLeaveAccrual(db, {
  period_label,
  year,
  date,
  userId,
  laborSettings,
}) {
  ensureLeaveAccrualSchema(db);
  const periodLabel = period_label || todayJalali().slice(0, 7);
  const fy = year || parseInt(String(periodLabel).slice(0, 4), 10);
  const labor = laborSettings
    || db.prepare('SELECT * FROM payroll_labor_settings WHERE year=?').get(fy);

  const employees = db.prepare(`
    SELECT id, name FROM persons WHERE active=1
      AND (monthly_salary_rial > 0 OR id IN (
        SELECT person_id FROM salary_structures WHERE fiscal_year=? AND active=1
      ))
  `).all(fy);

  const leaveExp = coaAcct(db, 'coa_leave_expense');
  const leavePay = coaAcct(db, 'coa_leave_payable');

  return db.transaction(() => {
    const out = [];
    let total = 0;
    for (const emp of employees) {
      const dup = db.prepare(`
        SELECT id FROM payroll_leave_accruals
        WHERE person_id=? AND period_label=? AND status<>'reversed'
      `).get(emp.id, periodLabel);
      if (dup) continue;
      const amounts = monthlyLeaveAmount(db, emp.id, fy, labor);
      if (!amounts || amounts.amount_rial <= 0) continue;
      total += amounts.amount_rial;
      out.push({ person_id: emp.id, person_name: emp.name, ...amounts });
    }
    if (!out.length) {
      throw Object.assign(new Error('ردیفی برای ذخیره مرخصی یافت نشد'), { status: 400 });
    }

    const jeId = postToLedger(db, {
      sourceType: 'payroll_leave_accrual',
      sourceId: 0,
      date: date || todayJalali(),
      description: `ذخیره ماهانه مرخصی استحقاقی — ${periodLabel}`,
      createdBy: userId,
      lines: [
        { ...leaveExp, debit: total / 10, credit: 0, debit_rial: total },
        { ...leavePay, debit: 0, credit: total / 10, credit_rial: total },
      ],
    });

    const ins = db.prepare(`
      INSERT INTO payroll_leave_accruals
        (period_label, person_id, days_x100, amount_rial, daily_wage_rial, je_id, status, created_by)
      VALUES (?,?,?,?,?,?,'posted',?)
    `);
    for (const row of out) {
      ins.run(
        periodLabel, row.person_id, row.days_x100, row.amount_rial,
        row.daily_wage_rial, jeId, userId
      );
    }
    return {
      je_id: jeId,
      period_label: periodLabel,
      rows: out,
      total_leave_rial: total,
    };
  })();
}

function leaveBalanceRial(db, personId) {
  ensureLeaveAccrualSchema(db);
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_rial),0) AS bal
    FROM payroll_leave_accruals
    WHERE person_id=? AND status='posted'
  `).get(personId);
  return Math.max(0, Math.round(Number(row?.bal) || 0));
}

function cashOutLeave(db, {
  person_id,
  amount_rial,
  date,
  userId,
  resolvePersonPayable,
}) {
  ensureLeaveAccrualSchema(db);
  const personId = Number(person_id);
  const amount = Math.round(Number(amount_rial) || 0);
  if (amount <= 0) {
    throw Object.assign(new Error('مبلغ بازخرید مرخصی نامعتبر است'), { status: 400 });
  }
  const bal = leaveBalanceRial(db, personId);
  if (amount > bal + 1) {
    throw Object.assign(
      new Error(`مانده ذخیره مرخصی ${bal.toLocaleString('fa-IR')} ریال است`),
      { status: 400, code: 'E_LEAVE_OVER' }
    );
  }
  const person = db.prepare('SELECT * FROM persons WHERE id=? AND active=1').get(personId);
  if (!person) throw Object.assign(new Error('کارمند یافت نشد'), { status: 404 });
  const leavePay = coaAcct(db, 'coa_leave_payable');
  const payable = resolvePersonPayable(db, person);
  const payDate = date || todayJalali();

  return db.transaction(() => {
    const jeId = postToLedger(db, {
      sourceType: 'payroll_leave_cashout',
      sourceId: personId,
      date: payDate,
      description: `بازخرید مرخصی ${person.name} (${amount.toLocaleString('fa-IR')} ریال)`,
      createdBy: userId,
      lines: [
        { ...leavePay, debit: amount / 10, credit: 0 },
        { code: payable.code, name: payable.name, debit: 0, credit: amount / 10 },
      ],
    });

    // FIFO mark rows cashed_out / partial via reducing — simple: consume oldest posted rows
    let remain = amount;
    const rows = db.prepare(`
      SELECT id, amount_rial FROM payroll_leave_accruals
      WHERE person_id=? AND status='posted' ORDER BY id ASC
    `).all(personId);
    for (const row of rows) {
      if (remain <= 0) break;
      const take = Math.min(remain, row.amount_rial);
      if (take >= row.amount_rial) {
        db.prepare(`
          UPDATE payroll_leave_accruals
          SET status='cashed_out', cash_out_je_id=?, cashed_out_at=strftime('%s','now')
          WHERE id=?
        `).run(jeId, row.id);
      } else {
        // Split: reduce amount, insert cashed stub
        db.prepare('UPDATE payroll_leave_accruals SET amount_rial=? WHERE id=?')
          .run(row.amount_rial - take, row.id);
        db.prepare(`
          INSERT INTO payroll_leave_accruals
            (period_label, person_id, days_x100, amount_rial, daily_wage_rial, je_id, status,
             cash_out_je_id, cashed_out_at, created_by)
          SELECT period_label, person_id, 0, ?, daily_wage_rial, je_id, 'cashed_out',
                 ?, strftime('%s','now'), created_by
          FROM payroll_leave_accruals WHERE id=?
        `).run(take, jeId, row.id);
      }
      remain -= take;
    }
    return { journal_id: jeId, amount_rial: amount, balance_rial: leaveBalanceRial(db, personId) };
  })();
}

function voidLeaveAccrual(db, accrualId, userId) {
  ensureLeaveAccrualSchema(db);
  const row = db.prepare('SELECT * FROM payroll_leave_accruals WHERE id=?').get(accrualId);
  if (!row) throw Object.assign(new Error('ذخیره مرخصی یافت نشد'), { status: 404 });
  if (row.status === 'reversed') {
    throw Object.assign(new Error('قبلاً ابطال شده'), { status: 400 });
  }
  if (row.status === 'cashed_out') {
    throw Object.assign(new Error('بازخرید شده — ابطال از این مسیر مجاز نیست'), { status: 400 });
  }
  return db.transaction(() => {
    if (row.je_id) {
      // Only reverse JE if no other posted rows share it, or reverse whole batch by je_id
      const siblings = db.prepare(`
        SELECT COUNT(*) AS n FROM payroll_leave_accruals
        WHERE je_id=? AND status='posted'
      `).get(row.je_id);
      if (siblings && siblings.n === 1) {
        reverseJournalEntry(db, row.je_id, {
          userId,
          reason: 'ابطال ذخیره مرخصی',
        });
      }
    }
    db.prepare(`
      UPDATE payroll_leave_accruals
      SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=?
      WHERE id=?
    `).run(userId, accrualId);
    return { ok: true, id: accrualId };
  })();
}

module.exports = {
  ensureLeaveAccrualSchema,
  LEAVE_DAYS_PER_MONTH_X100,
  monthlyLeaveAmount,
  postMonthlyLeaveAccrual,
  leaveBalanceRial,
  cashOutLeave,
  voidLeaveAccrual,
};
