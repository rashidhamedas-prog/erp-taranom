'use strict';
/**
 * Invoice mixed / partial payments.
 * Invoice JE always keeps customer AR for the full amount when splits exist.
 * Each split posts a settlement (cash/bank/cheque) or POS in-transit receipt.
 */
const { postToLedger } = require('./ledger');
const { rialToLedger } = require('./money');
const { todayJalali } = require('../jalali');
const { moneyRial, resolveCashPaid } = require('./cash-on-document');

const SPLIT_TYPES = new Set(['cash', 'bank', 'bank_transfer', 'cheque', 'pos_card']);

function normalizePayType(pt) {
  const t = String(pt || '').trim();
  if (t === 'bank') return 'bank_transfer';
  return t;
}

function splitFromHeader(body, amount) {
  const b = body || {};
  return {
    pay_type: normalizePayType(b.pay_type),
    amount,
    bank_id: b.bank_id,
    cash_box_id: b.cash_box_id,
    terminal_id: b.pos_terminal_id || b.terminal_id,
    check_category_id: b.check_category_id,
    cheque_info: b.cheque_info,
    cheque_due: b.cheque_due_date,
    cheque_bank: b.cheque_bank,
    cheque_branch: b.cheque_branch,
    cheque_account: b.cheque_account,
    cheque_number: b.cheque_number,
    sayadi: b.cheque_sayadi || b.sayadi,
    cheque_owner: b.cheque_owner,
    sheba: b.cheque_sheba || b.sheba,
  };
}

function digitsOnly(v) {
  return String(v || '').replace(/\D/g, '');
}

/** Received Sayadi cheque — در جریان / نزد صندوق، not cash until collected. */
function assertReceivedCheque(s, index) {
  const n = index + 1;
  const sayadi = digitsOnly(s.sayadi);
  const missing = [];
  if (!String(s.cheque_bank || '').trim()) missing.push('نام بانک');
  if (!String(s.cheque_branch || '').trim()) missing.push('شعبه');
  if (!String(s.cheque_account || '').trim()) missing.push('شماره حساب');
  if (!String(s.cheque_number || '').trim()) missing.push('شماره چک');
  if (!/^\d{16}$/.test(sayadi)) missing.push('شناسه صیاد ۱۶ رقمی');
  if (!String(s.cheque_due || '').trim()) missing.push('تاریخ سررسید');
  if (!String(s.cheque_owner || '').trim()) missing.push('نام صادرکننده');
  if (missing.length) {
    const e = new Error(`چک دریافتی${n ? ` (ردیف ${n})` : ''}: ${missing.join('، ')} الزامی است`);
    e.status = 400;
    e.code = 'E_CHEQUE_FIELDS';
    throw e;
  }
  const sheba = String(s.sheba || '').replace(/\s/g, '').toUpperCase();
  if (sheba && !/^IR\d{24}$/.test(sheba)) {
    const e = new Error(`چک دریافتی (ردیف ${n}): شبای واردشده معتبر نیست`);
    e.status = 400;
    e.code = 'E_CHEQUE_SHEBA';
    throw e;
  }
  s.sayadi = sayadi;
  s.sheba = sheba;
  s.cheque_bank = String(s.cheque_bank).trim();
  s.cheque_branch = String(s.cheque_branch).trim();
  s.cheque_account = String(s.cheque_account).trim();
  s.cheque_number = String(s.cheque_number).trim();
  s.cheque_owner = String(s.cheque_owner).trim();
  s.cheque_due = String(s.cheque_due).trim();
}

function normalizeInvoicePaySplits(body, invoiceFinal) {
  const finalAmt = moneyRial(invoiceFinal);
  const raw = Array.isArray(body && body.pay_splits) ? body.pay_splits : [];
  const splits = raw.map((s, i) => normalizeOneSplit(s, i)).filter((s) => s.amount > 0);
  assertSplits(splits, finalAmt);
  return splits;
}

/** New client sends pay_splits; old cash/cheque invoices keep the invoice-JE cash pair. */
function resolveInvoicePayments(body, invoiceFinal) {
  const finalAmt = moneyRial(invoiceFinal);
  const b = body || {};
  if (Array.isArray(b.pay_splits)) {
    const splits = normalizeInvoicePaySplits(b, finalAmt);
    return { splits, skipInvoiceCash: splits.length > 0 };
  }
  resolveCashPaid(b, finalAmt);
  const pt = normalizePayType(b.pay_type);
  const declared = b.pay_amount != null && b.pay_amount !== '' ? moneyRial(b.pay_amount) : null;
  // Cheque is always a received-note settlement (اسناد دریافتنی), even when it covers the whole invoice.
  const needsSplit = pt === 'pos_card' || pt === 'cheque' || (declared != null && declared > 0 && declared < finalAmt - 0.5);
  if (!needsSplit || !SPLIT_TYPES.has(pt)) {
    return { splits: [], skipInvoiceCash: false };
  }
  const one = normalizeOneSplit(splitFromHeader(b, declared != null ? declared : finalAmt), 0);
  assertSplits([one], finalAmt);
  return { splits: [one], skipInvoiceCash: true };
}

function normalizeOneSplit(s, index) {
  const pay_type = normalizePayType(s && s.pay_type);
  if (!SPLIT_TYPES.has(pay_type)) {
    const e = new Error(`قسط ${index + 1}: نوع پرداخت نامعتبر است`);
    e.status = 400;
    e.code = 'E_PAY_SPLIT_TYPE';
    throw e;
  }
  return {
    pay_type,
    amount: moneyRial(s.amount != null ? s.amount : s.amount_rial),
    bank_id: s.bank_id ? Number(s.bank_id) : null,
    cash_box_id: s.cash_box_id ? Number(s.cash_box_id) : null,
    terminal_id: s.terminal_id || s.pos_terminal_id ? Number(s.terminal_id || s.pos_terminal_id) : null,
    check_category_id: s.check_category_id ? Number(s.check_category_id) : null,
    cheque_info: String(s.cheque_info || '').trim(),
    cheque_due: String(s.cheque_due || s.cheque_due_date || '').trim(),
    cheque_bank: String(s.cheque_bank || '').trim(),
    cheque_branch: String(s.cheque_branch || '').trim(),
    cheque_account: String(s.cheque_account || s.account_number || '').trim(),
    cheque_number: String(s.cheque_number || '').trim(),
    sayadi: digitsOnly(s.sayadi || s.cheque_sayadi),
    cheque_owner: String(s.cheque_owner || s.issuer || '').trim(),
    sheba: String(s.sheba || s.cheque_sheba || '').replace(/\s/g, '').toUpperCase(),
    note: String(s.note || '').trim(),
  };
}

function settlementAssetAccount(db, split) {
  const { acct } = require('./coa-map');
  const { resolveCashAccount } = require('../db');
  if (split && split.pay_type === 'cheque') return acct(db, 'coa_cheques_receivable');
  return resolveCashAccount(db, split.pay_type, split.bank_id, split.cash_box_id);
}

function assertSplits(splits, finalAmt) {
  let sum = 0;
  splits.forEach((s) => { sum += s.amount; });
  if (sum - finalAmt > 0.5) {
    const e = new Error('جمع مبالغ پرداخت از مبلغ فاکتور بیشتر است');
    e.status = 400;
    e.code = 'E_PAY_SPLIT_OVER';
    throw e;
  }
  splits.forEach((s, i) => {
    if (s.pay_type === 'pos_card' && !s.terminal_id) {
      const e = new Error(`قسط ${i + 1}: کارتخوان را انتخاب کنید`);
      e.status = 400;
      e.code = 'E_PAY_SPLIT_POS';
      throw e;
    }
    if (s.pay_type === 'cash') {
      s.bank_id = null;
      s.terminal_id = null;
      if (!s.cash_box_id) {
        const e = new Error(`قسط ${i + 1}: صندوق را انتخاب کنید`);
        e.status = 400;
        e.code = 'E_CASH_BOX_REQUIRED';
        throw e;
      }
    } else if (s.pay_type === 'pos_card') {
      s.bank_id = null;
      s.cash_box_id = null;
    } else if (s.pay_type === 'bank_transfer' || s.pay_type === 'bank') {
      s.cash_box_id = null;
      s.terminal_id = null;
      if (!s.bank_id) {
        const e = new Error(`قسط ${i + 1}: بانک واریز را انتخاب کنید`);
        e.status = 400;
        e.code = 'E_BANK_REQUIRED';
        throw e;
      }
    } else if (s.pay_type === 'cheque') {
      s.cash_box_id = null;
      s.terminal_id = null;
      s.bank_id = null;
      const legacy = !digitsOnly(s.sayadi) && !String(s.cheque_number || '').trim() && String(s.cheque_info || '').trim();
      if (!legacy) assertReceivedCheque(s, i);
    } else {
      s.cash_box_id = null;
      s.terminal_id = null;
    }
  });
}

function headerPayTypeFromSplits(splits, fallback, invoiceFinal) {
  if (!splits.length) return fallback || 'credit';
  const sum = splits.reduce((a, s) => a + s.amount, 0);
  if (splits.length === 1 && Math.abs(sum - moneyRial(invoiceFinal)) < 1) return splits[0].pay_type;
  if (splits.length === 1) return splits[0].pay_type;
  return 'mixed';
}

function usesSplitPosting(splits) {
  return Array.isArray(splits) && splits.length > 0;
}

function persistInvoicePayPlan(db, invoiceId, payPlan, body) {
  const splits = (payPlan && payPlan.splits) || [];
  const amount = splits.length
    ? splits.reduce((a, s) => a + s.amount, 0)
    : moneyRial(body && body.pay_amount);
  const terminal = splits.find((s) => s.terminal_id)?.terminal_id
    || (body && (body.pos_terminal_id || body.terminal_id))
    || null;
  try {
    db.prepare('UPDATE invoices SET pay_splits_json=?, pay_amount_rial=?, pos_terminal_id=? WHERE id=?')
      .run(splits.length ? JSON.stringify(splits) : null, amount, terminal, invoiceId);
  } catch (_) { /* columns may lag until boot ensureColumn */ }
}

function paymentsFromStoredInvoice(inv, invoiceFinal) {
  let stored = null;
  try { stored = inv && inv.pay_splits_json ? JSON.parse(inv.pay_splits_json) : null; } catch (_) { stored = null; }
  return resolveInvoicePayments({
    pay_type: inv && inv.pay_type,
    pay_splits: Array.isArray(stored) && stored.length ? stored : undefined,
    pay_amount: inv && inv.pay_amount_rial,
    bank_id: inv && inv.bank_id,
    cash_box_id: inv && inv.cash_box_id,
    pos_terminal_id: inv && inv.pos_terminal_id,
    cheque_info: inv && inv.cheque_info,
    cheque_due_date: inv && inv.cheque_due_date,
    check_category_id: inv && inv.check_category_id,
    cheque_bank: inv && inv.cheque_bank,
    cheque_branch: inv && inv.cheque_branch,
    cheque_account: inv && inv.cheque_account,
    cheque_number: inv && inv.cheque_number,
    cheque_sayadi: inv && (inv.cheque_sayadi || inv.sayadi),
    sayadi: inv && (inv.sayadi || inv.cheque_sayadi),
    cheque_owner: inv && inv.cheque_owner,
    cheque_sheba: inv && (inv.cheque_sheba || inv.sheba),
    sheba: inv && (inv.sheba || inv.cheque_sheba),
  }, invoiceFinal);
}

function applyInvoicePaySplits(db, {
  invoiceId, custId, date, splits, userId, num, chequeHeader,
}) {
  if (!splits || !splits.length) return [];
  const when = date || todayJalali();
  const ids = [];
  splits.forEach((s, i) => {
    const note = s.note || `دریافت هنگام فاکتور ${num || invoiceId}` + (splits.length > 1 ? ` — قسط ${i + 1}` : '');
    if (s.pay_type === 'pos_card') {
      const pos = require('./pos');
      const rec = pos.postReceipt(db, {
        terminal_id: s.terminal_id,
        amount_rial: s.amount,
        invoice_id: invoiceId,
        cust_id: custId,
        date: when,
        note,
        idempotency_key: `inv-${invoiceId}-pos-${i}-${s.amount}`,
      }, { id: userId });
      ids.push({ kind: 'pos', id: rec && (rec.receiptId || rec.id) });
      return;
    }
    const settlementId = insertInvoiceSettlement(db, {
      userId, custId, invoiceId, split: s, date: when, note, chequeHeader,
    });
    ids.push({ kind: 'settlement', id: settlementId });
  });
  return ids;
}

function insertInvoiceSettlement(db, { userId, custId, invoiceId, split, date, note, chequeHeader }) {
  const { createLedgerEntry } = require('../db');
  const { recvAcct } = lazyRecv();
  const amountRial = split.amount;
  const pay_type = split.pay_type;
  const chequeInfo = split.cheque_info || (chequeHeader && chequeHeader.cheque_info) || '';
  const chequeDue = split.cheque_due || (chequeHeader && chequeHeader.cheque_due_date) || '';
  const structured = [split.cheque_bank, split.cheque_number, split.sayadi].filter(Boolean).join(' — ');
  const detail = structured || chequeInfo;
  const settNote = detail ? `${note}${note ? ' — ' : ''}${detail}` : note;
  const asset = settlementAssetAccount(db, split);
  if (pay_type === 'cheque' && split.sayadi) {
    const dup = db.prepare(
      "SELECT id FROM cheque_records WHERE sayadi=? AND direction='in' AND COALESCE(record_status,'posted')<>'reversed'"
    ).get(split.sayadi);
    if (dup) {
      const e = new Error('شناسه صیاد این چک قبلاً ثبت شده است');
      e.status = 409;
      e.code = 'E_CHEQUE_SAYADI_DUP';
      throw e;
    }
  }
  const result = db.prepare(`
    INSERT INTO settlements
      (user_id,cust_id,invoice_id,amount,amount_rial,pay_type,date,note,bank_id,cash_box_id,check_category_id,
       cheque_bank,cheque_sayadi,cheque_number,cheque_account,cheque_amount,cheque_owner,cheque_due,cheque_status,
       cheque_branch,cheque_sheba,account_code)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    userId, custId, invoiceId, amountRial, amountRial, pay_type, date, settNote,
    split.bank_id, split.cash_box_id, pay_type === 'cheque' ? null : split.check_category_id,
    split.cheque_bank || '', split.sayadi || '', split.cheque_number || '', split.cheque_account || '',
    pay_type === 'cheque' ? amountRial : 0, split.cheque_owner || '',
    chequeDue, pay_type === 'cheque' ? 'pending' : '',
    split.cheque_branch || '', split.sheba || '',
    pay_type === 'cheque' ? asset.code : ''
  );
  const settlementId = result.lastInsertRowid;
  if (pay_type === 'cheque') {
    const cust = db.prepare('SELECT biz, owner FROM customers WHERE id=?').get(custId);
    db.prepare(`
      INSERT INTO cheque_records
        (direction, cheque_number, receive_date, due_date, bank_name, branch, sayadi, sheba,
         account_number, party_name, customer_id, status, amount, note, invoice_id, settlement_id, lifecycle_status)
      VALUES ('in',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      split.cheque_number || '', date || '', chequeDue, split.cheque_bank || '', split.cheque_branch || '',
      split.sayadi || '', split.sheba || '', split.cheque_account || '',
      (cust && (cust.biz || cust.owner)) || '', custId,
      'نزد صندوق', amountRial, settNote, invoiceId, settlementId, 'in_hand'
    );
  }
  const payLabel = pay_type === 'cheque' ? 'چک'
    : (pay_type === 'bank_transfer' || pay_type === 'bank') ? 'واریز بانکی' : 'نقد';
  createLedgerEntry(db, {
    customer_id: custId, date, entry_type: 'settlement',
    ref_type: 'settlement', ref_id: settlementId,
    description: `تسویه ${payLabel} هنگام فاکتور — ${amountRial.toLocaleString('fa-IR')} ریال`,
    debit: 0, credit: amountRial, user_id: userId,
  });
  const recv = recvAcct(db, custId);
  postToLedger(db, {
    sourceType: 'settlement', sourceId: settlementId,
    date, description: `تسویه ${payLabel} هنگام فاکتور`, createdBy: userId,
    lines: [
      { code: asset.code, name: asset.name, debit: rialToLedger(amountRial), credit: 0 },
      { code: recv.code, name: recv.name, debit: 0, credit: rialToLedger(amountRial) },
    ],
  });
  return settlementId;
}

function lazyRecv() {
  try {
    const books = require('./customer-books');
    if (typeof books.receivableAcct === 'function') {
      return { recvAcct: books.receivableAcct };
    }
  } catch (_) { /* fall through */ }
  return {
    recvAcct(db, custId) {
      const { acct } = require('./coa-map');
      const c = custId ? db.prepare('SELECT coa_code FROM customers WHERE id=?').get(custId) : null;
      if (c && c.coa_code) {
        const a = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(c.coa_code);
        if (a) return a;
      }
      return acct(db, 'coa_receivable');
    },
  };
}

module.exports = {
  normalizeInvoicePaySplits,
  resolveInvoicePayments,
  headerPayTypeFromSplits,
  usesSplitPosting,
  applyInvoicePaySplits,
  persistInvoicePayPlan,
  paymentsFromStoredInvoice,
  settlementAssetAccount,
  SPLIT_TYPES,
};
