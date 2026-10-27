'use strict';
/**
 * Extra cheque lifecycle actions (return-to-drawer, endorse-return, out-bounce,
 * out-void, replace, reverse-last-event, protest, transfer-to-customer)
 * — always reversal-not-delete.
 */

const { postToLedger } = require('./ledger');
const { acct } = require('./coa-map');
const { assertJournalIdempotent } = require('./sales-document');
const { reverseJournalEntry } = require('./void-journal');
const { assertTransition, normalizeLifecycle, statusLabelFor, isRegistered } = require('./cheque-lifecycle');
const { insertChequeEvent, lastReversibleEvent, chequeEventDesc, listChequeEvents } = require('./cheque-events');
const { syncSettlementChequeStatus } = require('./cheque-due');
const {
  resolveChequeInCredit,
  bounceContraAccount,
  postChequeBounceBooks,
  chequeAmountRial,
  xorChequeBookTargets,
} = require('./cheque-party-books');
const { daysUntilDue } = require('./cheque-quality');
const { todayJalali, addDaysToJalali } = require('../jalali');

function assertPosted(row) {
  if (!row) {
    const err = new Error('چک یافت نشد');
    err.status = 404;
    throw err;
  }
  if (String(row.record_status || 'posted') === 'reversed') {
    const err = new Error('این چک ابطال شده است');
    err.status = 400;
    err.code = 'E_CHEQUE_REVERSED';
    throw err;
  }
}

function amountRial(row) {
  const n = Math.round(Number(row.amount) || 0);
  if (n <= 0) {
    const err = new Error('مبلغ چک نامعتبر است');
    err.status = 400;
    throw err;
  }
  return n;
}

function resolveDate(raw, todayFn) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return todayFn();
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(s)) {
    const err = new Error('تاریخ باید به صورت YYYY/MM/DD باشد');
    err.status = 400;
    err.code = 'E_CHEQUE_DATE';
    throw err;
  }
  return s;
}

function setLifecycle(db, id, lc, statusLabel, extraSql = '', extraParams = []) {
  db.prepare(`
    UPDATE cheque_records
    SET lifecycle_status=?, status=? ${extraSql}
    WHERE id=? AND COALESCE(record_status,'posted')<>'reversed'
  `).run(lc, statusLabel, ...extraParams, id);
}

/** Debit party books when returning a cheque from the drawer (restores AR). */
function postReturnDrawerPartyBooks(db, {
  chequeId, customerId, personId, date, description, amountRial, userId,
}) {
  const rial = Math.round(Number(amountRial) || 0);
  if (!(rial > 0) || !chequeId) return;
  ({ customerId, personId } = xorChequeBookTargets(customerId, personId));
  if (customerId) {
    const exists = db.prepare(`
      SELECT 1 FROM customer_ledger
      WHERE ref_type='cheque_return_drawer' AND ref_id=? AND customer_id=? AND entry_type<>'reversal'
      LIMIT 1
    `).get(chequeId, customerId);
    if (!exists) {
      const { createLedgerEntry } = require('../db');
      createLedgerEntry(db, {
        customer_id: customerId,
        date: date || '',
        entry_type: 'cheque',
        ref_type: 'cheque_return_drawer',
        ref_id: chequeId,
        description: description || '',
        debit: rial,
        credit: 0,
        user_id: userId || null,
      });
    }
  }
  if (personId) {
    let exists = null;
    try {
      exists = db.prepare(`
        SELECT 1 FROM person_ledger
        WHERE ref_type='cheque_return_drawer' AND ref_id=? AND person_id=? AND COALESCE(entry_type,'')<>'reversal'
        LIMIT 1
      `).get(chequeId, personId);
    } catch (_) { exists = null; }
    if (!exists) {
      const { createPersonLedgerEntry } = require('../db');
      createPersonLedgerEntry(db, {
        person_id: personId,
        date: date || '',
        entry_type: 'cheque',
        ref_type: 'cheque_return_drawer',
        ref_id: chequeId,
        description: description || '',
        debit: rial,
        credit: 0,
        user_id: userId || null,
      });
    }
  }
  // Alias for callers / audits that expect postChequePartyBooks naming:
  // credit helper is wrong for return (would double-credit); debit books mirror Dr 1103.
  void require('./cheque-party-books').postChequePartyBooks;
}

/**
 * 6-month protest deadline from due_date (حقوق علیه ظهرنویس).
 * Returns warning string or null.
 */
function protestDeadlineWarning(row, asOf) {
  const due = String((row && row.due_date) || '').trim();
  if (!due) return null;
  const today = asOf || todayJalali();
  if (daysUntilDue(due, today) == null) return null;
  // مهلت ۶ ماه ≈ ۱۸۰ روز از سررسید
  const deadline = addDaysToJalali(due, 180);
  const daysToDeadline = daysUntilDue(deadline, today);
  if (daysToDeadline == null) return null;
  if (daysToDeadline < 0) {
    return `هشدار: مهلت ۶ماههٔ واخواست از سررسید (${due}) گذشته است (مهلت تا ${deadline})`;
  }
  if (daysToDeadline <= 30) {
    return `هشدار: کمتر از ۳۰ روز تا پایان مهلت ۶ماههٔ واخواست (مهلت تا ${deadline})`;
  }
  return `مهلت ۶ماههٔ واخواست تا ${deadline} است — برای حفظ حقوق علیه ظهرنویس اقدام کنید`;
}

/**
 * عودت چک دریافتنی به صاحب.
 * نزد صندوق: Dr 1103 / Cr 1109 + دفتر طرف‌حساب (بدهکار).
 * پس از برگشت/واخواست: بدون سند GL — فقط event (مبلغ قبلاً در AR یا واخواستی است).
 */
function returnToDrawer(db, row, { user, date, clientRequestId, todayFn }) {
  assertPosted(row);
  if (row.direction !== 'in') {
    const err = new Error('عودت فقط برای چک دریافتنی است');
    err.status = 400;
    throw err;
  }
  assertTransition(row, 'returned_to_drawer');
  const entryDate = resolveDate(date, todayFn);
  const from = normalizeLifecycle(row);
  const desc = chequeEventDesc(row, 'عودت به صاحب چک');

  // After bounce/protest: no GL — amount already restored to AR (or sits on واخواستی).
  if (from === 'bounced') {
    setLifecycle(db, row.id, 'returned_to_drawer', 'عودت به صاحب');
    syncSettlementChequeStatus(db, row.id);
    insertChequeEvent(db, {
      chequeId: row.id,
      fromStatus: from,
      toStatus: 'returned_to_drawer',
      eventDate: entryDate,
      journalEntryId: null,
      partyId: row.party_id,
      note: desc + ' — بدون سند (پس از برگشت)',
      createdBy: user.id,
      clientRequestId,
    });
    return {
      ok: true,
      journal_entry_id: null,
      lifecycle_status: 'returned_to_drawer',
      warning: 'عودت پس از برگشت فقط رویداد ثبت شد؛ سند حسابداری صادر نشد',
    };
  }

  const amtR = amountRial(row);
  const amt = amtR / 10;
  const notes = acct(db, 'coa_cheques_receivable');
  const recv = acct(db, 'coa_receivable');
  assertJournalIdempotent(db, 'cheque_return_drawer', row.id);

  const party = resolveChequeInCredit(db, {
    partyId: row.party_id,
    customerId: row.customer_id,
  });
  const arCode = party.creditAcct || recv;

  const jeId = postToLedger(db, {
    sourceType: 'cheque_return_drawer',
    sourceId: row.id,
    date: entryDate,
    description: desc,
    createdBy: user.id,
    lines: [
      { code: arCode.code, name: arCode.name, debit: amt, credit: 0, debit_rial: amtR },
      { code: notes.code, name: notes.name, debit: 0, credit: amt, credit_rial: amtR },
    ],
  });
  postReturnDrawerPartyBooks(db, {
    chequeId: row.id,
    customerId: party.customerId,
    personId: party.personId,
    date: entryDate,
    description: desc,
    amountRial: amtR,
    userId: user.id,
  });
  setLifecycle(db, row.id, 'returned_to_drawer', 'عودت به صاحب');
  syncSettlementChequeStatus(db, row.id);
  insertChequeEvent(db, {
    chequeId: row.id,
    fromStatus: from,
    toStatus: 'returned_to_drawer',
    eventDate: entryDate,
    journalEntryId: jeId,
    partyId: row.party_id,
    note: desc,
    createdBy: user.id,
    clientRequestId,
  });
  return { ok: true, journal_entry_id: jeId, lifecycle_status: 'returned_to_drawer' };
}

/**
 * برگشت از ظهرنویس — Dr 1109 / Cr طرف
 */
function endorseReturn(db, row, { user, date, clientRequestId, todayFn }) {
  assertPosted(row);
  if (row.direction !== 'in') {
    const err = new Error('برگشت ظهرنویسی فقط برای چک دریافتنی است');
    err.status = 400;
    throw err;
  }
  assertTransition(row, 'endorse_returned');
  const entryDate = resolveDate(date, todayFn);
  const amtR = amountRial(row);
  const amt = amtR / 10;
  const from = normalizeLifecycle(row);
  const recv = acct(db, 'coa_cheques_receivable');
  const payable = acct(db, 'coa_payable');
  const desc = chequeEventDesc(row, 'برگشت از ظهرنویس');
  assertJournalIdempotent(db, 'cheque_endorse_return', row.id);

  const jeId = postToLedger(db, {
    sourceType: 'cheque_endorse_return',
    sourceId: row.id,
    date: entryDate,
    description: desc,
    createdBy: user.id,
    lines: [
      { code: recv.code, name: recv.name, debit: amt, credit: 0, debit_rial: amtR },
      { code: payable.code, name: payable.name, debit: 0, credit: amt, credit_rial: amtR },
    ],
  });
  setLifecycle(db, row.id, 'endorse_returned', 'برگشت از ظهرنویس',
    ', endorse_party_id=NULL, endorse_supplier_id=NULL');
  insertChequeEvent(db, {
    chequeId: row.id,
    fromStatus: from,
    toStatus: 'endorse_returned',
    eventDate: entryDate,
    journalEntryId: jeId,
    createdBy: user.id,
    clientRequestId,
    note: desc,
  });
  return { ok: true, journal_entry_id: jeId, lifecycle_status: 'endorse_returned' };
}

/**
 * واخواست / برگشت از بانک: Dr اسناد واخواستی / Cr 1116 (یا بانک).
 * بدون بدهکار کردن مشتری — انتقال جدا با transferProtestToCustomer.
 */
function protestCheque(db, row, { user, date, clientRequestId, todayFn, body }) {
  assertPosted(row);
  if (row.direction !== 'in') {
    const err = new Error('واخواست فقط برای چک دریافتنی است');
    err.status = 400;
    throw err;
  }
  const from = normalizeLifecycle(row);
  if (!['in_collection', 'cleared'].includes(from) && !['in_collection', 'cleared'].includes(String(row.lifecycle_status || ''))) {
    const err = new Error('فقط چک‌های واگذارشده یا وصول‌شده قابل واخواست هستند');
    err.status = 400;
    err.code = 'E_CHEQUE_LIFECYCLE';
    throw err;
  }
  assertTransition(row, 'bounced');
  const entryDate = resolveDate(date, todayFn);
  const amtR = chequeAmountRial(row);
  const amt = amtR / 10;
  const bounced = acct(db, 'coa_bounced_cheques');
  const contra = bounceContraAccount(db, row);
  const desc = chequeEventDesc(row, 'واخواست چک');
  assertJournalIdempotent(db, 'cheque_bounce', row.id);

  const certNo = body && body.protest_cert_no != null
    ? String(body.protest_cert_no).trim()
    : '';
  const protestDate = body && body.protest_date
    ? resolveDate(body.protest_date, todayFn)
    : entryDate;

  const jeId = postToLedger(db, {
    sourceType: 'cheque_bounce',
    sourceId: row.id,
    date: entryDate,
    description: `${desc}${row.party_name ? ' — ' + row.party_name : ''}`,
    createdBy: user.id,
    lines: [
      { code: bounced.code, name: bounced.name, debit: amt, credit: 0, debit_rial: amtR },
      { code: contra.code, name: contra.name, debit: 0, credit: amt, credit_rial: amtR },
    ],
  });

  db.prepare(`
    UPDATE cheque_records
    SET lifecycle_status='bounced', bounced_je_id=?, status='برگشتی',
        protest_cert_no=?, protest_date=?
    WHERE id=? AND lifecycle_status IN ('in_collection','cleared')
      AND COALESCE(record_status,'posted')<>'reversed'
  `).run(jeId, certNo, protestDate, row.id);

  syncSettlementChequeStatus(db, row.id);
  insertChequeEvent(db, {
    chequeId: row.id,
    fromStatus: from,
    toStatus: 'bounced',
    eventDate: entryDate,
    journalEntryId: jeId,
    partyId: row.party_id,
    note: desc + (certNo ? ` — گواهی ${certNo}` : ''),
    createdBy: user.id,
    clientRequestId,
  });

  const warning = protestDeadlineWarning(row, entryDate);
  return {
    ok: true,
    journal_entry_id: jeId,
    lifecycle_status: 'bounced',
    protest_cert_no: certNo,
    protest_date: protestDate,
    warning: warning || undefined,
  };
}

/**
 * انتقال اسناد واخواستی به حساب مشتری: Dr 1103 / Cr اسناد واخواستی + دفتر طرف‌حساب.
 */
function transferProtestToCustomer(db, row, { user, date, clientRequestId, todayFn }) {
  assertPosted(row);
  if (row.direction !== 'in') {
    const err = new Error('انتقال واخواست فقط برای چک دریافتنی است');
    err.status = 400;
    throw err;
  }
  if (normalizeLifecycle(row) !== 'bounced' && String(row.lifecycle_status || '') !== 'bounced') {
    const err = new Error('فقط چک برگشتی/واخواست‌شده قابل انتقال به مشتری است');
    err.status = 400;
    err.code = 'E_CHEQUE_LIFECYCLE';
    throw err;
  }
  const entryDate = resolveDate(date, todayFn);
  const amtR = amountRial(row);
  const amt = amtR / 10;
  const bounced = acct(db, 'coa_bounced_cheques');
  const party = resolveChequeInCredit(db, {
    partyId: row.party_id,
    customerId: row.customer_id,
  });
  const desc = chequeEventDesc(row, 'انتقال واخواست به حساب مشتری');
  assertJournalIdempotent(db, 'cheque_protest_transfer', row.id);

  const jeId = postToLedger(db, {
    sourceType: 'cheque_protest_transfer',
    sourceId: row.id,
    date: entryDate,
    description: desc,
    createdBy: user.id,
    lines: [
      {
        code: party.creditAcct.code,
        name: party.creditAcct.name,
        debit: amt,
        credit: 0,
        debit_rial: amtR,
      },
      { code: bounced.code, name: bounced.name, debit: 0, credit: amt, credit_rial: amtR },
    ],
  });
  postChequeBounceBooks(db, {
    chequeId: row.id,
    customerId: party.customerId,
    personId: party.personId,
    date: entryDate,
    description: desc,
    amountRial: amtR,
    userId: user.id,
  });
  insertChequeEvent(db, {
    chequeId: row.id,
    fromStatus: 'bounced',
    toStatus: 'bounced',
    eventDate: entryDate,
    journalEntryId: jeId,
    partyId: row.party_id,
    note: desc,
    createdBy: user.id,
    clientRequestId,
  });
  const warning = protestDeadlineWarning(row, entryDate);
  return {
    ok: true,
    journal_entry_id: jeId,
    lifecycle_status: 'bounced',
    warning: warning || undefined,
  };
}

/**
 * Resolve journal id to store on event after reverseJournalEntry —
 * prefer counter-voucher (reversed_by_je_id), else return value of reverse.
 */
function reversalJournalIdForEvent(db, originalJeId, reverseResult) {
  if (originalJeId) {
    try {
      const link = db.prepare('SELECT reversed_by_je_id FROM journal_entries WHERE id=?').get(originalJeId);
      if (link && link.reversed_by_je_id) return Number(link.reversed_by_je_id);
    } catch (_) { /* column may be absent */ }
  }
  if (reverseResult != null) return Number(reverseResult);
  return null;
}

/**
 * پاس چک پرداختنی از بانک — Dr اسناد پرداختنی (2109) / Cr بانک (1102-xx).
 * وضعیت → cleared_out. تاریخ ≥ issue_date. idempotent: assertJournalIdempotent + client_request_id.
 */
function outClear(db, row, { user, date, bankId, clientRequestId, todayFn }) {
  assertPosted(row);
  if (row.direction !== 'out') {
    const err = new Error('پاس بانکی فقط برای چک پرداختنی است');
    err.status = 400;
    err.code = 'E_CHEQUE_DIRECTION';
    throw err;
  }
  // Idempotency short-circuit MUST run before assertTransition (replay after clear).
  if (clientRequestId) {
    const existingEv = db.prepare(
      'SELECT * FROM cheque_events WHERE client_request_id=?'
    ).get(clientRequestId);
    if (existingEv) {
      return {
        ok: true,
        journal_entry_id: existingEv.journal_entry_id,
        lifecycle_status: existingEv.to_status || 'cleared_out',
        idempotent: true,
      };
    }
  }
  if (normalizeLifecycle(row) === 'cleared_out' && row.cleared_je_id) {
    return {
      ok: true,
      journal_entry_id: row.cleared_je_id,
      lifecycle_status: 'cleared_out',
      idempotent: true,
    };
  }
  assertTransition(row, 'cleared_out');
  const entryDate = resolveDate(date, todayFn);
  const issue = String(row.issue_date || '').trim();
  if (issue && entryDate < issue) {
    const err = new Error(`تاریخ پاس نمی‌تواند قبل از تاریخ صدور (${issue}) باشد`);
    err.status = 400;
    err.code = 'E_CHEQUE_CLEAR_BEFORE_ISSUE';
    throw err;
  }

  const amtR = amountRial(row);
  const amt = amtR / 10;
  const from = normalizeLifecycle(row);
  const notesPay = acct(db, 'coa_cheques_payable');
  const bankDefault = acct(db, 'coa_bank_default');
  let cashLine = bankDefault;
  let resolvedBankId = bankId != null ? Number(bankId) : null;
  if (!Number.isFinite(resolvedBankId) || resolvedBankId <= 0) {
    resolvedBankId = row.collection_bank_id ? Number(row.collection_bank_id) : null;
  }
  if (!resolvedBankId) {
    const err = new Error('بانک پاس برای چک پرداختنی الزامی است');
    err.status = 400;
    err.code = 'E_CHEQUE_BANK';
    throw err;
  }
  const b = db.prepare('SELECT id, coa_code, name FROM banks WHERE id=?').get(resolvedBankId);
  if (!b) {
    const err = new Error('بانک پاس معتبر نیست');
    err.status = 400;
    err.code = 'E_CHEQUE_BANK';
    throw err;
  }
  cashLine = { code: b.coa_code || ('1102-' + b.id), name: b.name || bankDefault.name };
  resolvedBankId = b.id;

  const desc = chequeEventDesc(row, 'پاس چک پرداختنی');
  assertJournalIdempotent(db, 'cheque_out_clear', row.id);

  const jeId = postToLedger(db, {
    sourceType: 'cheque_out_clear',
    sourceId: row.id,
    date: entryDate,
    description: desc,
    createdBy: user.id,
    lines: [
      { code: notesPay.code, name: notesPay.name, debit: amt, credit: 0, debit_rial: amtR },
      { code: cashLine.code, name: cashLine.name, debit: 0, credit: amt, credit_rial: amtR },
    ],
  });

  const updated = db.prepare(`
    UPDATE cheque_records
    SET lifecycle_status='cleared_out', status=?,
        cleared_je_id=?,
        collection_bank_id=COALESCE(?, collection_bank_id)
    WHERE id=? AND COALESCE(record_status,'posted')<>'reversed'
  `).run(statusLabelFor('cleared_out'), jeId, resolvedBankId, row.id);
  if (!updated.changes) {
    const err = new Error('وضعیت چرخه این چک اجازه پاس بانکی را نمی‌دهد');
    err.status = 400;
    err.code = 'E_CHEQUE_LIFECYCLE';
    throw err;
  }
  syncSettlementChequeStatus(db, row.id);
  insertChequeEvent(db, {
    chequeId: row.id,
    fromStatus: from,
    toStatus: 'cleared_out',
    eventDate: entryDate,
    journalEntryId: jeId,
    bankId: resolvedBankId,
    partyId: row.party_id,
    note: desc,
    createdBy: user.id,
    clientRequestId,
  });
  return {
    ok: true,
    journal_entry_id: jeId,
    lifecycle_status: 'cleared_out',
    bank_id: resolvedBankId,
  };
}

/**
 * برگشت چک پرداختی — فقط وضعیت؛ سند معکوس اگر قبلاً paid/issued/cleared_out
 */
function outBounce(db, row, { user, date, clientRequestId, todayFn }) {
  assertPosted(row);
  if (row.direction !== 'out') {
    const err = new Error('برگشت پرداختی فقط برای چک پرداختنی است');
    err.status = 400;
    throw err;
  }
  assertTransition(row, 'bounced_out');
  const entryDate = resolveDate(date, todayFn);
  const from = normalizeLifecycle(row);
  let jeId = null;
  const desc = chequeEventDesc(row, 'برگشت چک پرداختی');

  if (['paid', 'issued', 'expensed', 'endorsed', 'cleared_out'].includes(from)) {
    let targetJeId = null;
    if (from === 'cleared_out' && row.cleared_je_id) {
      targetJeId = row.cleared_je_id;
    } else {
      const payJe = db.prepare(`
        SELECT id FROM journal_entries
        WHERE ref_id=? AND ref_type IN ('cheque_pay','cheque_expense','cheque_endorse','cheque_out_clear')
          AND COALESCE(deleted_at,0)=0
        ORDER BY id DESC LIMIT 1
      `).get(row.id);
      targetJeId = payJe && payJe.id;
    }
    if (targetJeId) {
      const rev = reverseJournalEntry(db, targetJeId, {
        userId: user.id,
        date: entryDate,
        reason: desc,
        sourceType: 'cheque_out_bounce',
      });
      // Store reversal JE id (counter voucher or soft-void result) — not blindly the original.
      jeId = reversalJournalIdForEvent(db, targetJeId, rev);
    }
  }

  setLifecycle(db, row.id, 'bounced_out', 'برگشت پرداختی');
  insertChequeEvent(db, {
    chequeId: row.id,
    fromStatus: from,
    toStatus: 'bounced_out',
    eventDate: entryDate,
    journalEntryId: jeId,
    createdBy: user.id,
    clientRequestId,
    note: desc,
  });
  return { ok: true, journal_entry_id: jeId, lifecycle_status: 'bounced_out', warning: 'وضعیت برگشت پرداختی ثبت شد' };
}

/**
 * ابطال چک پرداختی با سند معکوس صدور
 */
function outVoid(db, row, { user, date, clientRequestId, todayFn }) {
  assertPosted(row);
  if (row.direction !== 'out') {
    const err = new Error('ابطال پرداختی فقط برای چک پرداختنی است');
    err.status = 400;
    throw err;
  }
  assertTransition(row, 'voided');
  const entryDate = resolveDate(date, todayFn);
  const from = normalizeLifecycle(row);
  const desc = chequeEventDesc(row, 'ابطال چک پرداختی');
  let jeId = null;

  if (row.journal_entry_id) {
    const rev = reverseJournalEntry(db, row.journal_entry_id, {
      userId: user.id,
      date: entryDate,
      reason: desc,
      sourceType: 'cheque_out_void',
    });
    jeId = reversalJournalIdForEvent(db, row.journal_entry_id, rev);
  }

  db.prepare(`
    UPDATE cheque_records
    SET lifecycle_status='voided', status='ابطال‌شده',
        record_status='reversed', reversed_at=strftime('%s','now'), reversed_by=?
    WHERE id=?
  `).run(user.id, row.id);

  insertChequeEvent(db, {
    chequeId: row.id,
    fromStatus: from,
    toStatus: 'voided',
    eventDate: entryDate,
    journalEntryId: jeId,
    createdBy: user.id,
    clientRequestId,
    note: desc,
  });
  return { ok: true, journal_entry_id: jeId, lifecycle_status: 'voided' };
}

/**
 * تعویض چک پرداختی — معکوس قدیم + ثبت چک جدید با replaces_cheque_id
 */
function replaceCheque(db, row, { user, date, clientRequestId, todayFn, body }) {
  assertPosted(row);
  if (row.direction !== 'out') {
    const err = new Error('تعویض فقط برای چک پرداختنی است');
    err.status = 400;
    throw err;
  }
  assertTransition(row, 'replaced');
  const entryDate = resolveDate(date, todayFn);
  const from = normalizeLifecycle(row);
  const desc = chequeEventDesc(row, 'تعویض چک');

  if (row.journal_entry_id) {
    reverseJournalEntry(db, row.journal_entry_id, {
      userId: user.id,
      date: entryDate,
      reason: desc,
      sourceType: 'cheque_replace',
    });
  }

  const amountNum = Math.round(Number(body.amount != null ? body.amount : row.amount) || 0);
  const ins = db.prepare(`
    INSERT INTO cheque_records (
      direction, cheque_number, issue_date, receive_date, due_date,
      bank_name, branch, sayadi, sheba, account_number,
      party_name, party_id, customer_id, status, status_note, amount, note, created_by_name,
      lifecycle_status, replaces_cheque_id, check_category_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    'out',
    String(body.cheque_number || ''),
    body.issue_date || entryDate,
    '',
    body.due_date || row.due_date || '',
    body.bank_name || row.bank_name || '',
    body.branch || row.branch || '',
    body.sayadi || '',
    body.sheba || row.sheba || '',
    body.account_number || row.account_number || '',
    row.party_name || '',
    row.party_id || null,
    row.customer_id || null,
    'ثبت‌شده',
    body.status_note || '',
    amountNum,
    (body.note || '') + (body.note ? ' — ' : '') + `تعویض چک #${row.id}`,
    user.name || '',
    'registered',
    row.id,
    body.check_category_id || row.check_category_id || null
  );
  const newId = ins.lastInsertRowid;

  // Opening-style JE for notes payable
  const pay = acct(db, 'coa_cheques_payable');
  const opening = acct(db, 'coa_payable');
  const amt = amountNum / 10;
  const jeId = postToLedger(db, {
    sourceType: 'cheque_replace',
    sourceId: newId,
    date: entryDate,
    description: chequeEventDesc({ cheque_number: body.cheque_number, sayadi: body.sayadi }, 'ثبت چک جایگزین'),
    createdBy: user.id,
    lines: [
      { code: opening.code, name: opening.name, debit: amt, credit: 0, debit_rial: amountNum },
      { code: pay.code, name: pay.name, debit: 0, credit: amt, credit_rial: amountNum },
    ],
  });
  db.prepare('UPDATE cheque_records SET journal_entry_id=? WHERE id=?').run(jeId, newId);

  db.prepare(`
    UPDATE cheque_records
    SET lifecycle_status='replaced', status='تعویض‌شده',
        record_status='reversed', reversed_at=strftime('%s','now'), reversed_by=?
    WHERE id=?
  `).run(user.id, row.id);

  insertChequeEvent(db, {
    chequeId: row.id,
    fromStatus: from,
    toStatus: 'replaced',
    eventDate: entryDate,
    journalEntryId: jeId,
    createdBy: user.id,
    clientRequestId,
    note: desc,
  });

  return {
    ok: true,
    journal_entry_id: jeId,
    lifecycle_status: 'replaced',
    new_cheque_id: newId,
  };
}

/**
 * برگشت آخرین رویداد — سند معکوس؛ ردیف حذف نمی‌شود
 */
function reverseLastEvent(db, row, { user, date, clientRequestId, todayFn }) {
  assertPosted(row);
  const entryDate = resolveDate(date, todayFn);
  const last = lastReversibleEvent(db, row.id);
  if (!last || !last.journal_entry_id) {
    const err = new Error('رویداد قابل برگشت یافت نشد');
    err.status = 400;
    err.code = 'E_CHEQUE_NO_EVENT';
    throw err;
  }
  const desc = chequeEventDesc(row, 'برگشت آخرین رویداد');
  const rev = reverseJournalEntry(db, last.journal_entry_id, {
    userId: user.id,
    date: entryDate,
    reason: desc,
    sourceType: 'cheque_event_reversal',
  });
  const eventJeId = reversalJournalIdForEvent(db, last.journal_entry_id, rev);

  const restore = last.from_status || 'registered';
  setLifecycle(db, row.id, restore, statusLabelFor(restore));
  syncSettlementChequeStatus(db, row.id);

  insertChequeEvent(db, {
    chequeId: row.id,
    fromStatus: last.to_status,
    toStatus: restore,
    eventDate: entryDate,
    journalEntryId: eventJeId,
    reversesEventId: last.id,
    createdBy: user.id,
    clientRequestId,
    note: desc,
  });

  return {
    ok: true,
    journal_entry_id: eventJeId,
    lifecycle_status: restore,
    reversed_event_id: last.id,
  };
}

/**
 * حساب‌های انتظامی جفت تضمین — از coa-map (sibling). اگر کلید نباشد خطای شفاف.
 */
function resolveGuaranteeMemoPair(db, direction) {
  const isOut = String(direction || 'in') === 'out';
  const drKey = isOut ? 'coa_memo_guarantee_out_dr' : 'coa_memo_guarantee_in_dr';
  const crKey = isOut ? 'coa_memo_guarantee_out_cr' : 'coa_memo_guarantee_in_cr';
  let dr;
  let cr;
  try {
    dr = acct(db, drKey);
    cr = acct(db, crKey);
  } catch (_) {
    const err = new Error(
      'حساب‌های انتظامی تضمین در نقشه COA تعریف نشده‌اند ('
      + drKey + ' / ' + crKey
      + '). ابتدا کلیدهای coa_memo_guarantee_* را در coa-map اضافه کنید.'
    );
    err.status = 422;
    err.code = 'E_COA_MEMO_MISSING';
    throw err;
  }
  if (!dr || !dr.code || !cr || !cr.code) {
    const err = new Error('حساب انتظامی تضمین ناقص است (' + drKey + ' / ' + crKey + ')');
    err.status = 422;
    err.code = 'E_COA_MEMO_MISSING';
    throw err;
  }
  return { dr, cr, drKey, crKey };
}

function tableHasCol(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch (_) {
    return false;
  }
}

/** سند انتظامی جفت برای تضمین/امانی */
function postGuaranteeMemoJe(db, {
  direction, amountRial: amtR, sourceType, sourceId, date, description, userId,
}) {
  const { dr, cr } = resolveGuaranteeMemoPair(db, direction);
  const amtRial = Math.round(Number(amtR) || 0);
  const amt = amtRial / 10;
  if (amtRial <= 0) {
    const err = new Error('مبلغ سند انتظامی نامعتبر است');
    err.status = 400;
    throw err;
  }
  assertJournalIdempotent(db, sourceType, sourceId);
  return postToLedger(db, {
    sourceType,
    sourceId,
    date,
    description: description || 'سند انتظامی تضمین',
    createdBy: userId,
    lines: [
      { code: dr.code, name: dr.name, debit: amt, credit: 0, debit_rial: amtRial },
      { code: cr.code, name: cr.name, debit: 0, credit: amt, credit_rial: amtRial },
    ],
  });
}

/**
 * چک تضمینی: اگر سند دریافت دارد ابتدا reverse، سپس سند انتظامی جفت.
 * خطا throw می‌شود (rollback) — catch خالی ممنوع.
 */
function markGuarantee(db, row, { user, date, clientRequestId, todayFn, body }) {
  assertPosted(row);
  assertTransition(row, 'guarantee');
  const entryDate = resolveDate(date, todayFn);
  const from = normalizeLifecycle(row);
  const amtR = amountRial(row);
  const dir = row.direction || 'in';
  body = body || {};

  let reversedJeId = null;
  if (row.journal_entry_id) {
    reverseJournalEntry(db, row.journal_entry_id, {
      userId: user.id,
      date: entryDate,
      reason: chequeEventDesc(row, 'تبدیل به تضمینی — معکوس سند دریافت'),
      sourceType: 'cheque_guarantee_reversal',
    });
    reversedJeId = row.journal_entry_id;
    db.prepare('UPDATE cheque_records SET journal_entry_id=NULL WHERE id=?').run(row.id);
  }

  const memoJeId = postGuaranteeMemoJe(db, {
    direction: dir,
    amountRial: amtR,
    sourceType: 'cheque_guarantee_memo',
    sourceId: row.id,
    date: entryDate,
    description: chequeEventDesc(row, 'سند انتظامی چک تضمینی'),
    userId: user.id,
  });

  setLifecycle(db, row.id, 'guarantee', 'تضمینی');
  if (tableHasCol(db, 'cheque_records', 'is_guarantee')) {
    db.prepare('UPDATE cheque_records SET is_guarantee=1 WHERE id=?').run(row.id);
  }

  let trustId = null;
  const hasTrust = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='trust_checks'"
  ).get();
  if (hasTrust) {
    const cols = db.prepare('PRAGMA table_info(trust_checks)').all().map((c) => c.name);
    const has = (n) => cols.includes(n);
    const note = body.note || ('چک تضمینی #' + row.id);
    const expiry = body.guarantee_expiry || body.expiry_date || row.due_date || '';
    const contractId = body.contract_id != null ? parseInt(body.contract_id, 10) : null;
    const contractRef = body.contract_ref || body.contract_no || '';
    const insertCols = [
      'direction', 'party_name', 'bank_name', 'sayadi', 'cheque_number', 'account_number',
      'amount', 'owner_name', 'due_date', 'status', 'note', 'created_by',
    ];
    const insertVals = [
      dir, row.party_name || '', row.bank_name || '', row.sayadi || '',
      row.cheque_number || '', row.account_number || '', row.amount || 0,
      row.party_name || '', row.due_date || '', 'held', note, user.id,
    ];
    if (has('party_id') && row.party_id) { insertCols.push('party_id'); insertVals.push(row.party_id); }
    if (has('party_phone')) { insertCols.push('party_phone'); insertVals.push(body.party_phone || ''); }
    if (has('cheque_record_id')) { insertCols.push('cheque_record_id'); insertVals.push(row.id); }
    if (has('contract_id') && Number.isFinite(contractId) && contractId > 0) {
      insertCols.push('contract_id'); insertVals.push(contractId);
    }
    if (has('contract_ref') && contractRef) {
      insertCols.push('contract_ref'); insertVals.push(String(contractRef));
    }
    if (has('guarantee_expiry')) { insertCols.push('guarantee_expiry'); insertVals.push(expiry); }
    if (has('memo_je_id')) { insertCols.push('memo_je_id'); insertVals.push(memoJeId); }
    const ph = insertCols.map(() => '?').join(',');
    const r = db.prepare(
      `INSERT INTO trust_checks (${insertCols.join(',')}) VALUES (${ph})`
    ).run(...insertVals);
    trustId = r.lastInsertRowid;
  }

  insertChequeEvent(db, {
    chequeId: row.id,
    fromStatus: from,
    toStatus: 'guarantee',
    eventDate: entryDate,
    journalEntryId: memoJeId,
    partyId: row.party_id,
    createdBy: user.id,
    clientRequestId,
    note: reversedJeId
      ? ('تضمینی — معکوس سند دریافت #' + reversedJeId + ' + سند انتظامی')
      : 'تضمینی — سند انتظامی',
  });

  return {
    ok: true,
    lifecycle_status: 'guarantee',
    journal_entry_id: memoJeId,
    reversed_journal_entry_id: reversedJeId,
    trust_check_id: trustId,
  };
}

module.exports = {
  assertPosted,
  returnToDrawer,
  endorseReturn,
  outClear,
  outBounce,
  outVoid,
  replaceCheque,
  reverseLastEvent,
  markGuarantee,
  resolveGuaranteeMemoPair,
  postGuaranteeMemoJe,
  protestCheque,
  transferProtestToCustomer,
  protestDeadlineWarning,
  listChequeEvents,
  isRegistered,
};
