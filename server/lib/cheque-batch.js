'use strict';
/**
 * Batch cheque lifecycle actions (send-to-bank / clear / bounce / out-clear)
 * — all ids run inside the caller's db.transaction().
 */

const { postToLedger } = require('./ledger');
const { acct } = require('./coa-map');
const { assertJournalIdempotent } = require('./sales-document');
const {
  isRegistered,
  sqlIsRegistered,
  normalizeLifecycle,
  statusLabelFor,
} = require('./cheque-lifecycle');
const { syncSettlementChequeStatus } = require('./cheque-due');
const { postChequeInReceipt } = require('./cheque-party-books');
const { insertChequeEvent, chequeEventDesc } = require('./cheque-events');
const { outClear, assertPosted, protestCheque } = require('./cheque-lifecycle-actions');

const BATCH_ACTIONS = new Set(['send-to-bank', 'clear', 'bounce', 'out-clear']);

function resolveBatchDate(raw, todayFn) {
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

function ensureDepositSlipColumn(db) {
  try {
    const cols = db.prepare('PRAGMA table_info(cheque_records)').all();
    if (!cols.some((c) => c.name === 'deposit_slip_no')) {
      db.exec("ALTER TABLE cheque_records ADD COLUMN deposit_slip_no TEXT DEFAULT ''");
    }
  } catch (_) { /* */ }
}

function assertClearNotBeforeSend(db, row, entryDate) {
  if (!row || !row.collection_je_id) return;
  const sendJe = db.prepare(
    'SELECT entry_date FROM journal_entries WHERE id=? AND COALESCE(deleted_at,0)=0'
  ).get(row.collection_je_id);
  const sendDate = sendJe && String(sendJe.entry_date || '').trim();
  if (sendDate && entryDate < sendDate) {
    const err = new Error(`تاریخ وصول نمی‌تواند قبل از تاریخ واگذاری (${sendDate}) باشد`);
    err.status = 400;
    err.code = 'E_CHEQUE_CLEAR_BEFORE_SEND';
    throw err;
  }
}

/** واگذاری چک دریافتنی به بانک — Dr 1116 / Cr 1109 */
function sendChequeToBank(db, row, {
  user, entryDate, bankId, depositSlipNo, clientRequestId,
}) {
  assertPosted(row);
  if (row.direction !== 'in') {
    const err = new Error('واگذاری فقط برای چک دریافتنی است');
    err.status = 400;
    err.code = 'E_CHEQUE_DIRECTION';
    throw err;
  }
  if (!isRegistered(row)) {
    const err = new Error('وضعیت چرخه این چک اجازه واگذاری به بانک را نمی‌دهد');
    err.status = 400;
    err.code = 'E_CHEQUE_LIFECYCLE';
    throw err;
  }
  if (clientRequestId) {
    const existingEv = db.prepare(
      'SELECT * FROM cheque_events WHERE client_request_id=?'
    ).get(clientRequestId);
    if (existingEv) {
      return {
        ok: true,
        id: row.id,
        journal_entry_id: existingEv.journal_entry_id,
        lifecycle_status: existingEv.to_status || 'in_collection',
        idempotent: true,
      };
    }
  }

  const amountRial = Math.round(Number(row.amount) || 0);
  if (amountRial <= 0) {
    const err = new Error('مبلغ چک نامعتبر است');
    err.status = 400;
    err.code = 'E_CHEQUE_AMOUNT';
    throw err;
  }
  const resolvedBankId = bankId != null ? Number(bankId) : null;
  if (!Number.isFinite(resolvedBankId) || resolvedBankId <= 0) {
    const err = new Error('بانک وصول برای واگذاری الزامی است');
    err.status = 400;
    err.code = 'E_CHEQUE_BANK';
    throw err;
  }
  const bank = db.prepare('SELECT id FROM banks WHERE id=?').get(resolvedBankId);
  if (!bank) {
    const err = new Error('بانک وصول معتبر نیست');
    err.status = 400;
    err.code = 'E_CHEQUE_BANK';
    throw err;
  }

  postChequeInReceipt(db, row, user.id, entryDate);
  assertJournalIdempotent(db, 'cheque_send_to_bank', row.id);

  const collection = acct(db, 'coa_cheques_in_collection');
  const receivable = acct(db, 'coa_cheques_receivable');
  const amt = amountRial / 10;
  const from = normalizeLifecycle(row);
  const slip = depositSlipNo != null ? String(depositSlipNo).trim() : '';
  const desc = chequeEventDesc(row, slip ? `واگذاری به بانک — شماره واگذاری ${slip}` : 'واگذاری به بانک');

  ensureDepositSlipColumn(db);
  const jeId = postToLedger(db, {
    sourceType: 'cheque_send_to_bank',
    sourceId: row.id,
    date: entryDate,
    description: desc,
    createdBy: user.id,
    lines: [
      { code: collection.code, name: collection.name, debit: amt, credit: 0, debit_rial: amountRial },
      { code: receivable.code, name: receivable.name, debit: 0, credit: amt, credit_rial: amountRial },
    ],
  });

  const updated = db.prepare(`
    UPDATE cheque_records
    SET lifecycle_status='in_collection', collection_bank_id=?, collection_je_id=?,
        status='واگذارشده', deposit_slip_no=COALESCE(NULLIF(?, ''), deposit_slip_no)
    WHERE id=? AND ${sqlIsRegistered('lifecycle_status')}
      AND COALESCE(record_status,'posted')<>'reversed'
  `).run(resolvedBankId, jeId, slip, row.id);
  if (!updated.changes) {
    const err = new Error('وضعیت چرخه این چک اجازه ارسال به بانک را نمی‌دهد');
    err.status = 400;
    err.code = 'E_CHEQUE_LIFECYCLE';
    throw err;
  }
  syncSettlementChequeStatus(db, row.id);
  insertChequeEvent(db, {
    chequeId: row.id,
    fromStatus: from,
    toStatus: 'in_collection',
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
    id: row.id,
    journal_entry_id: jeId,
    lifecycle_status: 'in_collection',
    deposit_slip_no: slip || null,
  };
}

/** وصول چک دریافتنی — Dr بانک / Cr 1116 */
function clearChequeReceivable(db, row, { user, entryDate, bankId, clientRequestId }) {
  assertPosted(row);
  if (row.direction !== 'in') {
    const err = new Error('وصول فقط برای چک دریافتنی است');
    err.status = 400;
    err.code = 'E_CHEQUE_DIRECTION';
    throw err;
  }
  if (clientRequestId) {
    const existingEv = db.prepare(
      'SELECT * FROM cheque_events WHERE client_request_id=?'
    ).get(clientRequestId);
    if (existingEv) {
      return {
        ok: true,
        id: row.id,
        journal_entry_id: existingEv.journal_entry_id,
        lifecycle_status: existingEv.to_status || 'cleared',
        idempotent: true,
      };
    }
  }

  const amountRial = Math.round(Number(row.amount) || 0);
  if (amountRial <= 0) {
    const err = new Error('مبلغ چک نامعتبر است');
    err.status = 400;
    err.code = 'E_CHEQUE_AMOUNT';
    throw err;
  }
  if (row.lifecycle_status !== 'in_collection') {
    const err = new Error('چک باید در وضعیت «در جریان وصول» باشد');
    err.status = 400;
    err.code = 'E_CHEQUE_LIFECYCLE';
    throw err;
  }
  assertClearNotBeforeSend(db, row, entryDate);
  postChequeInReceipt(db, row, user.id, entryDate);
  assertJournalIdempotent(db, 'cheque_clear', row.id);

  const bank = acct(db, 'coa_bank_default');
  const collection = acct(db, 'coa_cheques_in_collection');
  const amt = amountRial / 10;
  let cashLine = bank;
  let resolvedBankId = bankId != null ? Number(bankId) : null;
  if (!Number.isFinite(resolvedBankId) || resolvedBankId <= 0) {
    resolvedBankId = row.collection_bank_id || null;
  }
  if (resolvedBankId) {
    const b = db.prepare('SELECT id, coa_code, name FROM banks WHERE id=?').get(resolvedBankId);
    if (!b) {
      const err = new Error('بانک واریز معتبر نیست');
      err.status = 400;
      err.code = 'E_CHEQUE_BANK';
      throw err;
    }
    cashLine = { code: b.coa_code || ('1102-' + b.id), name: b.name || bank.name };
    resolvedBankId = b.id;
  }

  const from = normalizeLifecycle(row);
  const desc = chequeEventDesc(row, 'وصول چک');
  const jeId = postToLedger(db, {
    sourceType: 'cheque_clear',
    sourceId: row.id,
    date: entryDate,
    description: desc,
    createdBy: user.id,
    lines: [
      { code: cashLine.code, name: cashLine.name, debit: amt, credit: 0, debit_rial: amountRial },
      { code: collection.code, name: collection.name, debit: 0, credit: amt, credit_rial: amountRial },
    ],
  });
  const updated = db.prepare(`
    UPDATE cheque_records
    SET lifecycle_status='cleared', cleared_je_id=?, status=?,
        collection_bank_id=COALESCE(?, collection_bank_id)
    WHERE id=? AND lifecycle_status='in_collection'
  `).run(jeId, statusLabelFor('cleared'), resolvedBankId, row.id);
  if (!updated.changes) {
    const err = new Error('چک باید در وضعیت «در جریان وصول» باشد');
    err.status = 400;
    err.code = 'E_CHEQUE_LIFECYCLE';
    throw err;
  }
  syncSettlementChequeStatus(db, row.id);
  insertChequeEvent(db, {
    chequeId: row.id,
    fromStatus: from,
    toStatus: 'cleared',
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
    id: row.id,
    journal_entry_id: jeId,
    lifecycle_status: 'cleared',
  };
}

/** برگشت/واخواست چک دریافتنی — Dr اسناد واخواستی / Cr 1116|بانک */
function bounceChequeReceivable(db, row, { user, entryDate, clientRequestId, body }) {
  if (clientRequestId) {
    const existingEv = db.prepare(
      'SELECT * FROM cheque_events WHERE client_request_id=?'
    ).get(clientRequestId);
    if (existingEv) {
      return {
        ok: true,
        id: row.id,
        journal_entry_id: existingEv.journal_entry_id,
        lifecycle_status: existingEv.to_status || 'bounced',
        idempotent: true,
      };
    }
  }
  const r = protestCheque(db, row, {
    user,
    date: entryDate,
    clientRequestId,
    todayFn: () => entryDate,
    body: body || {},
  });
  return {
    ok: true,
    id: row.id,
    journal_entry_id: r.journal_entry_id,
    lifecycle_status: r.lifecycle_status || 'bounced',
    warning: r.warning,
  };
}

/**
 * Run one action across many cheque ids. Caller must wrap in db.transaction().
 * @returns {{ ok: true, action: string, results: object[] }}
 */
function runBatchChequeAction(db, {
  action, ids, date, bankId, depositSlipNo, user, todayFn, clientRequestId,
}) {
  const act = String(action || '').trim();
  if (!BATCH_ACTIONS.has(act)) {
    const err = new Error('عملیات گروهی نامعتبر است (send-to-bank|clear|bounce|out-clear)');
    err.status = 400;
    err.code = 'E_CHEQUE_BATCH_ACTION';
    throw err;
  }
  const list = Array.isArray(ids) ? ids.map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0) : [];
  if (!list.length) {
    const err = new Error('فهرست شناسه چک خالی است');
    err.status = 400;
    err.code = 'E_CHEQUE_BATCH_IDS';
    throw err;
  }
  const uniq = [...new Set(list)];
  const entryDate = resolveBatchDate(date, todayFn);
  const results = [];

  for (const id of uniq) {
    const row = db.prepare('SELECT * FROM cheque_records WHERE id=?').get(id);
    if (!row) {
      const err = new Error(`چک #${id} یافت نشد`);
      err.status = 404;
      err.code = 'E_CHEQUE_NOT_FOUND';
      throw err;
    }
    const perIdKey = clientRequestId
      ? `${String(clientRequestId).trim()}:${id}`
      : null;

    let one;
    if (act === 'send-to-bank') {
      one = sendChequeToBank(db, row, {
        user,
        entryDate,
        bankId,
        depositSlipNo,
        clientRequestId: perIdKey,
      });
    } else if (act === 'clear') {
      one = clearChequeReceivable(db, row, {
        user,
        entryDate,
        bankId,
        clientRequestId: perIdKey,
      });
    } else if (act === 'bounce') {
      one = bounceChequeReceivable(db, row, {
        user,
        entryDate,
        clientRequestId: perIdKey,
      });
    } else {
      // out-clear
      one = outClear(db, row, {
        user,
        date: entryDate,
        bankId,
        clientRequestId: perIdKey,
        todayFn,
      });
      one = { ...one, id: row.id };
    }
    results.push(one);
  }

  return {
    ok: true,
    action: act,
    date: entryDate,
    deposit_slip_no: depositSlipNo != null ? String(depositSlipNo).trim() || null : null,
    results,
  };
}

module.exports = {
  BATCH_ACTIONS,
  ensureDepositSlipColumn,
  sendChequeToBank,
  clearChequeReceivable,
  bounceChequeReceivable,
  runBatchChequeAction,
};
