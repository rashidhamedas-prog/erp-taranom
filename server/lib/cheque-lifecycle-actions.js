'use strict';
/**
 * Extra cheque lifecycle actions (return-to-drawer, endorse-return, out-bounce,
 * out-void, replace, reverse-last-event) — always reversal-not-delete.
 */

const { postToLedger } = require('./ledger');
const { acct } = require('./coa-map');
const { assertJournalIdempotent } = require('./sales-document');
const { reverseJournalEntry } = require('./void-journal');
const { assertTransition, normalizeLifecycle, statusLabelFor, isRegistered } = require('./cheque-lifecycle');
const { insertChequeEvent, lastReversibleEvent, chequeEventDesc, listChequeEvents } = require('./cheque-events');
const { syncSettlementChequeStatus } = require('./cheque-due');

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

/**
 * عودت چک دریافتنی به صاحب — Dr مشتری / Cr 1109 یا واخواستی
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
  const amtR = amountRial(row);
  const amt = amtR / 10;
  const from = normalizeLifecycle(row);
  const creditKey = from === 'bounced' ? 'coa_bounced_cheques' : 'coa_cheques_receivable';
  let credit;
  try { credit = acct(db, creditKey); } catch (_) { credit = acct(db, 'coa_cheques_receivable'); }
  const recv = acct(db, 'coa_ar');
  const desc = chequeEventDesc(row, 'عودت به صاحب چک');
  assertJournalIdempotent(db, 'cheque_return_drawer', row.id);

  const jeId = postToLedger(db, {
    sourceType: 'cheque_return_drawer',
    sourceId: row.id,
    date: entryDate,
    description: desc,
    createdBy: user.id,
    lines: [
      { code: recv.code, name: recv.name, debit: amt, credit: 0, debit_rial: amtR },
      { code: credit.code, name: credit.name, debit: 0, credit: amt, credit_rial: amtR },
    ],
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
 * برگشت چک پرداختی — فقط وضعیت؛ سند معکوس اگر قبلاً paid/issued
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

  if (['paid', 'issued', 'expensed', 'endorsed'].includes(from) && row.journal_entry_id) {
    // Prefer last pay/expense JE via reverse
    const payJe = db.prepare(`
      SELECT id FROM journal_entries
      WHERE ref_id=? AND ref_type IN ('cheque_pay','cheque_expense','cheque_endorse')
        AND COALESCE(deleted_at,0)=0
      ORDER BY id DESC LIMIT 1
    `).get(row.id);
    if (payJe) {
      reverseJournalEntry(db, payJe.id, {
        userId: user.id,
        date: entryDate,
        reason: desc,
        sourceType: 'cheque_out_bounce',
      });
      jeId = payJe.id;
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
    reverseJournalEntry(db, row.journal_entry_id, {
      userId: user.id,
      date: entryDate,
      reason: desc,
      sourceType: 'cheque_out_void',
    });
    jeId = row.journal_entry_id;
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
  reverseJournalEntry(db, last.journal_entry_id, {
    userId: user.id,
    date: entryDate,
    reason: desc,
    sourceType: 'cheque_event_reversal',
  });

  const restore = last.from_status || 'registered';
  setLifecycle(db, row.id, restore, statusLabelFor(restore));
  syncSettlementChequeStatus(db, row.id);

  insertChequeEvent(db, {
    chequeId: row.id,
    fromStatus: last.to_status,
    toStatus: restore,
    eventDate: entryDate,
    journalEntryId: last.journal_entry_id,
    reversesEventId: last.id,
    createdBy: user.id,
    clientRequestId,
    note: desc,
  });

  return {
    ok: true,
    journal_entry_id: last.journal_entry_id,
    lifecycle_status: restore,
    reversed_event_id: last.id,
  };
}

/**
 * چک تضمینی — بدون سند مالی؛ لینک trust_checks در صورت وجود
 */
function markGuarantee(db, row, { user, date, clientRequestId, todayFn, body }) {
  assertPosted(row);
  assertTransition(row, 'guarantee');
  const entryDate = resolveDate(date, todayFn);
  const from = normalizeLifecycle(row);
  setLifecycle(db, row.id, 'guarantee', 'تضمینی');
  let trustId = null;
  try {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trust_checks'").get();
    if (has) {
      const r = db.prepare(`
        INSERT INTO trust_checks (
          direction, party_name, bank_name, sayadi, cheque_number, account_number,
          amount, owner_name, due_date, status, note, created_by
        ) VALUES (?,?,?,?,?,?,?,?,?,'held',?,?)
      `).run(
        row.direction || 'in',
        row.party_name || '',
        row.bank_name || '',
        row.sayadi || '',
        row.cheque_number || '',
        row.account_number || '',
        row.amount || 0,
        row.party_name || '',
        row.due_date || '',
        (body && body.note) || ('چک تضمینی #' + row.id),
        user.id
      );
      trustId = r.lastInsertRowid;
    }
  } catch (_) { /* trust schema may differ */ }

  insertChequeEvent(db, {
    chequeId: row.id,
    fromStatus: from,
    toStatus: 'guarantee',
    eventDate: entryDate,
    journalEntryId: null,
    createdBy: user.id,
    clientRequestId,
    note: 'تضمینی — بدون سند مالی',
  });
  return { ok: true, lifecycle_status: 'guarantee', trust_check_id: trustId };
}

module.exports = {
  assertPosted,
  returnToDrawer,
  endorseReturn,
  outBounce,
  outVoid,
  replaceCheque,
  reverseLastEvent,
  markGuarantee,
  listChequeEvents,
  isRegistered,
};
