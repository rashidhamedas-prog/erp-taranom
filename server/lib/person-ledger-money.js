'use strict';
/**
 * person_ledger.debit/credit are mixed: voucher/payroll-v294 rows are ledger-toman
 * (same unit as journal_lines.debit); some older hourly rows are already rial.
 * UI/API balances are INTEGER rial. Scale a line only when a source document proves it.
 */
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('./money');

function roundMoney(v) {
  return Math.round(Number(v) || 0);
}

/**
 * Resolve payroll net in INTEGER rial. Columns are historically messy
 * (net_pay toman vs net_pay_rial rial, or both toman). Prefer the magnitude
 * that matches a ×10 relationship; otherwise the larger plausible rial.
 */
function expectedPayrollRial(rec) {
  if (!rec) return 0;
  const npr = rec.net_pay_rial != null && rec.net_pay_rial !== ''
    ? roundMoney(rec.net_pay_rial)
    : 0;
  const np = roundMoney(Number(rec.net_pay) || 0);
  if (npr && np) {
    if (Math.abs(npr - np * 10) <= 1) return Math.max(0, npr);
    if (Math.abs(npr * 10 - np) <= 1) return Math.max(0, np);
    if (Math.abs(npr - np) <= 1) return Math.max(0, npr);
    return Math.max(0, Math.max(npr, np * 10));
  }
  if (npr) return Math.max(0, npr);
  return Math.max(0, np * 10);
}

function scaleToExpected(debit, credit, expectedRial) {
  const d = roundMoney(debit);
  const c = roundMoney(credit);
  const mag = Math.max(Math.abs(d), Math.abs(c));
  const exp = roundMoney(expectedRial);
  if (!exp) return { debit: d, credit: c };
  if (Math.abs(mag - exp) <= 1) return { debit: d, credit: c };
  if (Math.abs(mag * 10 - exp) <= 1) return { debit: d * 10, credit: c * 10 };
  return { debit: d, credit: c };
}

/** Abs rial on the payroll JE's person/payable leaf (largest non-expense line). */
function payrollJeAbsRial(db, payrollRecordId) {
  try {
    const row = db.prepare(`
      SELECT MAX(ABS(
        COALESCE(${SQL_JL_DEBIT_RIAL},0) - COALESCE(${SQL_JL_CREDIT_RIAL},0)
      )) AS mag
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      WHERE je.ref_type='payroll' AND je.ref_id=?
        AND COALESCE(je.deleted_at,0)=0
        AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
        AND jl.account_code NOT LIKE '61%'
        AND jl.account_code NOT LIKE '51%'
        AND jl.account_code NOT LIKE '52%'
    `).get(payrollRecordId);
    return roundMoney(row && row.mag);
  } catch (_) {
    return 0;
  }
}

function personLedgerLineRial(db, row) {
  const d = roundMoney(row && row.debit);
  const c = roundMoney(row && row.credit);
  const rt = String((row && row.ref_type) || '');
  const rid = row && row.ref_id != null ? Number(row.ref_id) : 0;
  if (!db || !rid) return { debit: d, credit: c };

  try {
    if (rt === 'payroll') {
      const rec = db.prepare('SELECT * FROM payroll_records WHERE id=?').get(rid);
      let exp = 0;
      if (rec) {
        exp = expectedPayrollRial(rec) + roundMoney(rec.arrears_rial);
      }
      const glMag = payrollJeAbsRial(db, rid);
      if (glMag && (!exp || Math.abs(exp - glMag) > 1)) {
        // Prefer JE magnitude when header columns disagree with posted GL
        if (Math.abs(exp * 10 - glMag) <= 1 || !exp) exp = glMag;
        else if (Math.abs(Math.max(Math.abs(d), Math.abs(c)) * 10 - glMag) <= 1) exp = glMag;
      }
      return scaleToExpected(d, c, exp || glMag);
    }
    if (rt === 'payroll_payment' || rt === 'payroll_payment_reversal') {
      let pay = db.prepare('SELECT amount_rial FROM payroll_payments WHERE id=?').get(rid);
      if (!pay) {
        pay = db.prepare(
          "SELECT amount_rial FROM payroll_payments WHERE payroll_record_id=? AND COALESCE(status,'posted')<>'reversed' ORDER BY id DESC LIMIT 1"
        ).get(rid);
      }
      if (pay) return scaleToExpected(d, c, pay.amount_rial);
    }
    if (rt === 'payroll_year_end') {
      const y = db.prepare('SELECT net_pay_rial FROM payroll_year_end_bonuses WHERE id=?').get(rid);
      if (y) return scaleToExpected(d, c, y.net_pay_rial);
    }
  } catch (_) { /* tables/columns optional */ }

  return { debit: d, credit: c };
}

function personLedgerAliveSql(db) {
  try {
    const cols = db.prepare('PRAGMA table_info(person_ledger)').all().map((c) => c.name);
    if (cols.includes('deleted_at')) return 'COALESCE(pl.deleted_at,0)=0';
  } catch (_) { /* ignore */ }
  return '1=1';
}

/**
 * One-shot: mirror live payroll_payment JEs into person_ledger when missing.
 * Historical gap — payment JE posted without PL row → live ≠ GL.
 */
function healMissingPayrollPaymentPersonLedger(db) {
  if (process.env.SYNC_ROLE === 'device') {
    return { skipped: true, reason: 'device' };
  }
  const flag = db.prepare(
    "SELECT value FROM settings WHERE key='person_payroll_payment_pl_heal_v368'"
  ).get();
  if (flag && String(flag.value).length) {
    try {
      const parsed = JSON.parse(flag.value);
      if (parsed && parsed.ok) return { skipped: true, count: parsed.count || 0 };
    } catch (_) {
      if (flag.value === '1') return { skipped: true };
    }
  }

  let count = 0;
  try {
    const hasPl = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='person_ledger'"
    ).get();
    const hasPay = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='payroll_payments'"
    ).get();
    if (!hasPl || !hasPay) {
      db.prepare(
        "INSERT OR REPLACE INTO settings (key,value) VALUES ('person_payroll_payment_pl_heal_v368',?)"
      ).run(JSON.stringify({ ok: 1, count: 0, skipped: 'no_tables' }));
      return { skipped: true, count: 0 };
    }

    const alive = personLedgerAliveSql(db);
    const pays = db.prepare(`
      SELECT pp.*, pr.person_id
      FROM payroll_payments pp
      JOIN payroll_records pr ON pr.id = pp.payroll_record_id
      WHERE COALESCE(pp.status,'posted')<>'reversed'
        AND COALESCE(pr.status,'')<>'reversed'
    `).all();

    const ins = db.prepare(`
      INSERT INTO person_ledger
        (person_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id)
      VALUES (?,?,?,?,?,?,?,?,?)
    `);
    const run = db.transaction(() => {
      for (const pp of pays) {
        const exists = db.prepare(`
          SELECT 1 FROM person_ledger pl
          WHERE pl.person_id=? AND pl.ref_type='payroll_payment' AND pl.ref_id=?
            AND ${alive}
          LIMIT 1
        `).get(pp.person_id, pp.id);
        if (exists) continue;
        const amt = roundMoney(pp.amount_rial);
        if (!amt) continue;
        // Store rial (ADR money); personLedgerLineRial matches amount_rial 1:1
        ins.run(
          pp.person_id,
          pp.date || '',
          'payroll_payment',
          'payroll_payment',
          pp.id,
          `پرداخت حقوق (هم‌ترازی زیردفتر v368) — ${amt.toLocaleString('fa-IR')} ریال`,
          amt,
          0,
          pp.created_by || 1
        );
        count += 1;
      }
    });
    run();
  } catch (e) {
    console.warn('⚠️ person_payroll_payment_pl_heal_v368:', e.message);
    return { ok: false, error: e.message, count };
  }

  db.prepare(
    "INSERT OR REPLACE INTO settings (key,value) VALUES ('person_payroll_payment_pl_heal_v368',?)"
  ).run(JSON.stringify({ ok: 1, count, at: new Date().toISOString() }));
  return { ok: true, count };
}

module.exports = {
  personLedgerLineRial,
  personLedgerAliveSql,
  scaleToExpected,
  expectedPayrollRial,
  healMissingPayrollPaymentPersonLedger,
};
