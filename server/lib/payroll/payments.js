'use strict';
/**
 * Payroll payment settlement — multi-leg clearing of wages payable.
 *
 * Accrual (already posted) credits coa_payroll_payable for net_pay.
 * Each payment leg: Dr payable / Cr bank|cash for that leg only.
 * Remaining liability stays on the balance sheet until fully cleared.
 *
 * R13: each leg is independently voidable; void-all cascades active legs.
 */

const { postToLedger } = require('../ledger');
const { todayJalali } = require('../../jalali');
const { reverseJournalEntry } = require('../void-journal');
const { resolvePersonPayableAccount } = require('./person-account');

function netPayRial(row) {
  if (!row) return 0;
  if (row.net_pay_rial != null && row.net_pay_rial !== '') {
    return Math.max(0, Math.round(Number(row.net_pay_rial) || 0));
  }
  return Math.max(0, Math.round((Number(row.net_pay) || 0) * 10));
}

function sumPaidRial(db, payrollRecordId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_rial), 0) AS s
    FROM payroll_payments
    WHERE payroll_record_id=? AND COALESCE(status,'posted')<>'reversed'
  `).get(payrollRecordId);
  return Math.max(0, Math.round(Number(row && row.s) || 0));
}

function remainingRial(db, row) {
  if (!row || row.status === 'reversed') return 0;
  return Math.max(0, netPayRial(row) - sumPaidRial(db, row.id));
}

function listActivePayments(db, payrollRecordId) {
  return db.prepare(`
    SELECT * FROM payroll_payments
    WHERE payroll_record_id=? AND COALESCE(status,'posted')<>'reversed'
    ORDER BY id ASC
  `).all(payrollRecordId);
}

function refreshPayrollPaymentState(db, payrollRecordId) {
  const row = db.prepare('SELECT * FROM payroll_records WHERE id=?').get(payrollRecordId);
  if (!row) return null;
  if (row.status === 'reversed') return row;

  const paid = sumPaidRial(db, payrollRecordId);
  const net = netPayRial(row);
  const fully = net > 0 && paid >= net;
  const partial = paid > 0 && !fully;
  const lastJe = db.prepare(`
    SELECT journal_id FROM payroll_payments
    WHERE payroll_record_id=? AND COALESCE(status,'posted')<>'reversed'
    ORDER BY id DESC LIMIT 1
  `).get(payrollRecordId);

  let status = 'posted';
  if (fully) status = 'paid';
  else if (partial) status = 'partial';

  db.prepare(`
    UPDATE payroll_records SET
      paid_rial=?,
      paid=?,
      status=?,
      payment_journal_id=?,
      paid_at=CASE
        WHEN ? THEN COALESCE(paid_at, strftime('%s','now'))
        ELSE NULL
      END
    WHERE id=?
  `).run(
    paid,
    fully ? 1 : 0,
    status,
    lastJe && lastJe.journal_id ? lastJe.journal_id : null,
    fully ? 1 : 0,
    payrollRecordId
  );

  return db.prepare('SELECT * FROM payroll_records WHERE id=?').get(payrollRecordId);
}

function normalizeLegs(body, remaining) {
  const b = body || {};
  let raw = Array.isArray(b.legs) ? b.legs : null;
  if (!raw || !raw.length) {
    raw = [{
      amount_rial: b.amount_rial != null ? b.amount_rial : remaining,
      pay_type: b.pay_type || 'cash',
      bank_id: b.bank_id,
      cash_box_id: b.cash_box_id,
      date: b.date,
      note: b.note,
    }];
  }

  const legs = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i] || {};
    const amount = Math.round(Number(s.amount_rial != null ? s.amount_rial : s.amount) || 0);
    if (amount <= 0) {
      const e = new Error(`قسط ${i + 1}: مبلغ باید بزرگ‌تر از صفر باشد`);
      e.status = 400;
      e.code = 'E_PAYROLL_PAY_AMOUNT';
      throw e;
    }
    legs.push({
      amount_rial: amount,
      pay_type: String(s.pay_type || 'cash'),
      bank_id: s.bank_id ? Number(s.bank_id) : null,
      cash_box_id: s.cash_box_id ? Number(s.cash_box_id) : null,
      date: s.date || b.date || null,
      note: s.note != null ? String(s.note) : (b.note || ''),
    });
  }

  const total = legs.reduce((a, L) => a + L.amount_rial, 0);
  if (total > remaining) {
    const e = new Error(
      `جمع اقساط (${total.toLocaleString('fa-IR')} ریال) از مانده قابل پرداخت (${remaining.toLocaleString('fa-IR')} ریال) بیشتر است`
    );
    e.status = 400;
    e.code = 'E_PAYROLL_OVERPAY';
    throw e;
  }
  if (total <= 0) {
    const e = new Error('مبلغ پرداخت باید بزرگ‌تر از صفر باشد');
    e.status = 400;
    e.code = 'E_PAYROLL_PAY_AMOUNT';
    throw e;
  }
  return legs;
}

/**
 * Post one or more payment legs against a payroll accrual.
 * Must be called inside db.transaction (or wraps one if createPersonLedgerEntry/resolveCashAccount provided via deps).
 */
function postPayrollPayments(db, {
  row,
  person,
  body,
  userId,
  resolveCashAccount,
  createPersonLedgerEntry,
}) {
  if (!row) throw Object.assign(new Error('یافت نشد'), { status: 404 });
  if (row.status === 'reversed') {
    throw Object.assign(new Error('این رکورد ابطال شده است'), { status: 400 });
  }

  const rem = remainingRial(db, row);
  if (rem <= 0) {
    throw Object.assign(new Error('این حقوق قبلاً به‌طور کامل پرداخت شده است'), { status: 400, code: 'E_PAYROLL_FULLY_PAID' });
  }

  const legs = normalizeLegs(body, rem);
  const payable = resolvePersonPayableAccount(db, person);
  const created = [];

  for (const leg of legs) {
    const cash = resolveCashAccount(db, leg.pay_type || 'cash', leg.bank_id, leg.cash_box_id);
    const payDate = leg.date || todayJalali();
    const journalId = postToLedger(db, {
      date: payDate,
      description: `پرداخت حقوق ${person ? person.name : ''} (${row.period_label || ''}) — ${leg.amount_rial.toLocaleString('fa-IR')} ریال`,
      sourceType: 'payroll_payment',
      sourceId: row.id,
      createdBy: userId,
      lines: [
        { code: payable.code, name: payable.name, debit: leg.amount_rial / 10, credit: 0 },
        { code: cash.code, name: cash.name, debit: 0, credit: leg.amount_rial / 10 },
      ],
    });

    const info = db.prepare(`
      INSERT INTO payroll_payments (
        payroll_record_id, amount_rial, pay_type, bank_id, cash_box_id,
        date, note, journal_id, status, created_by
      ) VALUES (?,?,?,?,?,?,?,?, 'posted', ?)
    `).run(
      row.id,
      leg.amount_rial,
      leg.pay_type || 'cash',
      leg.bank_id,
      leg.cash_box_id,
      payDate,
      leg.note || '',
      journalId,
      userId
    );
    const paymentId = info.lastInsertRowid;

    // person_ledger = INTEGER rial (ADR money). personLedgerLineRial matches amount_rial 1:1.
    // Legacy toman rows still scale via personLedgerLineRial when mag×10 = amount_rial.
    createPersonLedgerEntry(db, {
      person_id: row.person_id,
      date: payDate,
      entry_type: 'payroll_payment',
      ref_type: 'payroll_payment',
      ref_id: paymentId,
      description: `پرداخت حقوق ${row.period_label || ''} (${leg.amount_rial.toLocaleString('fa-IR')} ریال)`,
      debit: leg.amount_rial,
      credit: 0,
      user_id: userId,
    });

    created.push({ id: paymentId, amount_rial: leg.amount_rial, journal_id: journalId, date: payDate });
  }

  const updated = refreshPayrollPaymentState(db, row.id);
  return {
    ok: true,
    payments: created,
    paid_rial: updated.paid_rial,
    remaining_rial: remainingRial(db, updated),
    paid: !!updated.paid,
    status: updated.status,
  };
}

function voidOnePayrollPayment(db, payment, userId, createPersonLedgerEntry) {
  if (!payment) throw Object.assign(new Error('پرداخت یافت نشد'), { status: 404 });
  if (payment.status === 'reversed') {
    throw Object.assign(new Error('این پرداخت قبلاً ابطال شده است'), { status: 400 });
  }

  const row = db.prepare('SELECT * FROM payroll_records WHERE id=?').get(payment.payroll_record_id);
  if (!row) throw Object.assign(new Error('رکورد حقوق یافت نشد'), { status: 404 });
  if (row.status === 'reversed') {
    throw Object.assign(new Error('رکورد حقوق ابطال شده است'), { status: 400 });
  }

  if (payment.journal_id) {
    reverseJournalEntry(db, payment.journal_id, {
      userId,
      reason: `ابطال پرداخت حقوق #${payment.id}`,
      sourceType: 'payroll_payment_reversal',
    });
  }

  // v374: retire person books only — no hollow «ابطال پرداخت حقوق» reverse rows.
  void createPersonLedgerEntry;
  try {
    db.prepare(`
      UPDATE person_ledger SET deleted_at=strftime('%s','now')
      WHERE COALESCE(deleted_at,0)=0
        AND (
          (ref_type='payroll_payment' AND ref_id=?)
          OR (ref_type='payroll_payment_reversal' AND ref_id=?)
          OR (ref_type='payroll_payment' AND ref_id=? AND ?=1)
          OR (ref_type='payroll_payment_reversal' AND ref_id=? AND ?=1)
        )
    `).run(
      payment.id, payment.id,
      row.id, payment.legacy_ref_payroll_record ? 1 : 0,
      row.id, payment.legacy_ref_payroll_record ? 1 : 0
    );
  } catch (_) { /* person_ledger may lack deleted_at on very old DBs */ }

  db.prepare(`
    UPDATE payroll_payments SET
      status='reversed',
      reversed_at=strftime('%s','now'),
      reversed_by=?,
      reversal_journal_id=NULL
    WHERE id=?
  `).run(userId, payment.id);

  return refreshPayrollPaymentState(db, row.id);
}

function voidAllPayrollPayments(db, row, userId, createPersonLedgerEntry) {
  if (!row) throw Object.assign(new Error('یافت نشد'), { status: 404 });
  const active = listActivePayments(db, row.id);
  if (!active.length && !row.paid) {
    throw Object.assign(new Error('این حقوق هنوز پرداخت نشده است'), { status: 400 });
  }
  for (const p of active) {
    voidOnePayrollPayment(db, p, userId, createPersonLedgerEntry);
  }
  // Legacy: paid=1 with payment_journal_id but no payroll_payments rows
  if (!active.length && row.paid && row.payment_journal_id) {
    reverseJournalEntry(db, row.payment_journal_id, {
      userId,
      reason: `ابطال پرداخت حقوق #${row.id}`,
      sourceType: 'payroll_payment_reversal',
    });
    void createPersonLedgerEntry;
    try {
      db.prepare(`
        UPDATE person_ledger SET deleted_at=strftime('%s','now')
        WHERE person_id=? AND COALESCE(deleted_at,0)=0
          AND ref_type IN ('payroll_payment','payroll_payment_reversal')
          AND ref_id=?
      `).run(row.person_id, row.id);
    } catch (_) { /* optional */ }
    db.prepare(`
      UPDATE payroll_records SET paid=0, paid_rial=0, status='posted',
        payment_journal_id=NULL, paid_at=NULL WHERE id=?
    `).run(row.id);
  }
  return refreshPayrollPaymentState(db, row.id);
}

function enrichPayrollRow(db, row) {
  if (!row) return row;
  const reversed = row.status === 'reversed';
  const net = netPayRial(row);
  const paid = reversed
    ? 0
    : (row.paid_rial != null ? Math.round(Number(row.paid_rial) || 0) : sumPaidRial(db, row.id));
  const remaining = reversed ? 0 : Math.max(0, net - paid);
  return {
    ...row,
    net_pay_rial: net,
    paid_rial: paid,
    remaining_rial: remaining,
    payment_count: reversed ? 0 : listActivePayments(db, row.id).length,
  };
}

module.exports = {
  netPayRial,
  sumPaidRial,
  remainingRial,
  listActivePayments,
  refreshPayrollPaymentState,
  normalizeLegs,
  postPayrollPayments,
  voidOnePayrollPayment,
  voidAllPayrollPayments,
  enrichPayrollRow,
};
