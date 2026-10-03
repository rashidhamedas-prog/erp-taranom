'use strict';
/**
 * person_ledger.debit/credit are mixed: voucher/payroll-v294 rows are ledger-toman
 * (same unit as journal_lines.debit); some older hourly rows are already rial.
 * UI/API balances are INTEGER rial. Scale a line only when a source document proves it.
 */
function roundMoney(v) {
  return Math.round(Number(v) || 0);
}

function expectedPayrollRial(rec) {
  if (!rec) return 0;
  if (rec.net_pay_rial != null && rec.net_pay_rial !== '') {
    return Math.max(0, roundMoney(rec.net_pay_rial));
  }
  return Math.max(0, roundMoney(Number(rec.net_pay) || 0) * 10);
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

function personLedgerLineRial(db, row) {
  const d = roundMoney(row && row.debit);
  const c = roundMoney(row && row.credit);
  const rt = String((row && row.ref_type) || '');
  const rid = row && row.ref_id != null ? Number(row.ref_id) : 0;
  if (!db || !rid) return { debit: d, credit: c };

  try {
    if (rt === 'payroll') {
      const rec = db.prepare('SELECT * FROM payroll_records WHERE id=?').get(rid);
      if (rec) {
        const exp = expectedPayrollRial(rec) + roundMoney(rec.arrears_rial);
        return scaleToExpected(d, c, exp);
      }
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

module.exports = {
  personLedgerLineRial,
  personLedgerAliveSql,
  scaleToExpected,
};
