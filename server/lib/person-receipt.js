'use strict';

/**
 * دریافت از شخص (غیرمشتری).
 * نقد → صندوق، واریز → بانک شرکت، کارتخوان → وجوه در راه ۱۱۱۸،
 * چک دریافتنی → اسناد دریافتنی ۱۱۰۹ نزد صندوق (بانک شرکت بدهکار نمی‌شود).
 * اگر طرف، مشتری باشد این مسیر سند نمی‌سازد تا دفتر مشتری دور زده نشود.
 */

const { acct } = require('./coa-map');
const { postToLedger } = require('./ledger');
const { rialToLedger } = require('./money');
const { httpErr, assertPaymentDate, strictPositiveId } = require('./cash-payment-contract');

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

function digitsOnly(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[۰-۹]/g, (ch) => String(FA_DIGITS.indexOf(ch)))
    .replace(/[٠-٩]/g, (ch) => String(AR_DIGITS.indexOf(ch)))
    .replace(/\D/g, '');
}

/** Sayad received-cheque identity. Sheba is optional; if present it must be IR+24. */
function validateReceivedCheque(raw, index) {
  const n = (index || 0) + 1;
  const src = raw || {};
  const sayadi = digitsOnly(src.sayadi != null ? src.sayadi : src.cheque_sayadi);
  const bank = String(src.bank || src.cheque_bank || '').trim();
  const branch = String(src.branch || src.cheque_branch || '').trim();
  const account = String(src.account || src.cheque_account || '').trim();
  const number = String(src.number || src.cheque_number || '').trim();
  const due = String(src.due || src.cheque_due || '').trim();
  const owner = String(src.owner || src.cheque_owner || '').trim();
  let sheba = String(src.sheba || src.cheque_sheba || '').replace(/\s/g, '').toUpperCase();
  const amount = Math.round(Number(src.amount != null ? src.amount : src.cheque_amount) || 0);
  const missing = [];
  if (!bank) missing.push('نام بانک صادرکننده');
  if (!branch) missing.push('شعبه');
  if (!account) missing.push('شماره حساب');
  if (!number) missing.push('شماره چک');
  if (!/^\d{16}$/.test(sayadi)) missing.push('شناسه صیاد ۱۶ رقمی');
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(due)) missing.push('تاریخ سررسید');
  if (!owner) missing.push('نام صادرکننده');
  if (!amount || amount <= 0) missing.push('مبلغ چک');
  if (sheba && !/^IR\d{24}$/.test(sheba)) missing.push('شبا (IR و ۲۴ رقم)');
  if (!sheba) sheba = '';
  if (missing.length) {
    throw httpErr(400, `چک دریافتنی ردیف ${n}: ${missing.join('، ')}`, 'E_CHEQUE_FIELDS');
  }
  return {
    bank, branch, account, number, sayadi, due, owner, sheba, amount,
    note: String(src.note || '').trim(),
  };
}

function customerForParty(db, partyId) {
  const party = db.prepare('SELECT legacy_table, legacy_id FROM parties WHERE id=?').get(partyId);
  if (party && party.legacy_table === 'customers' && party.legacy_id) {
    const row = db.prepare('SELECT id FROM customers WHERE id=?').get(party.legacy_id);
    if (row) return row.id;
  }
  const linked = db.prepare('SELECT id FROM customers WHERE party_id=? ORDER BY id LIMIT 1').get(partyId);
  return linked ? linked.id : null;
}

function personAccount(db, person) {
  if (person.coa_code) {
    const row = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(person.coa_code);
    if (row) return row;
  }
  if (person.party_id) {
    const party = db.prepare('SELECT coa_code FROM parties WHERE id=?').get(person.party_id);
    if (party && party.coa_code) {
      const row = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(party.coa_code);
      if (row) return row;
    }
  }
  return acct(db, 'coa_misc_persons');
}

function assetAccount(db, payType, bankId, cashBoxId) {
  const { resolveCashAccount } = require('../db');
  if (payType === 'cheque') return acct(db, 'coa_cheques_receivable');
  if (payType === 'pos_card') return acct(db, 'coa_card_in_transit');
  const kind = payType === 'bank_transfer' ? 'bank' : payType;
  return resolveCashAccount(db, kind, bankId, cashBoxId);
}

function assertSayadiFree(db, sayadi) {
  const dup = db.prepare(
    "SELECT id FROM cheque_records WHERE sayadi=? AND direction='in' AND COALESCE(record_status,'posted')<>'reversed'"
  ).get(sayadi);
  if (dup) throw httpErr(409, 'شناسه صیاد این چک قبلاً ثبت شده است', 'E_CHEQUE_SAYADI_DUP');
}

function insertReceivedCheque(db, row) {
  db.prepare(`
    INSERT INTO cheque_records
      (direction, cheque_number, receive_date, due_date, bank_name, branch, sayadi, sheba,
       account_number, party_name, party_id, customer_id, status, amount, note, lifecycle_status, journal_entry_id)
    VALUES ('in',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    row.number, row.date, row.due, row.bank, row.branch, row.sayadi, row.sheba,
    row.account, row.partyName, row.partyId, null,
    'نزد صندوق', row.amount, row.note, 'registered', row.journalId
  );
}

/**
 * Posts one or more receipt vouchers for a non-customer party.
 * Must run inside the caller's transaction (idempotency wrapper).
 */
function postPersonReceipt(db, user, body) {
  const { createPersonLedgerEntry } = require('../db');
  const { resolvePersonIdFromVoucherLine } = require('./party-turnover');
  const { assertActiveBank, assertActiveCashBox } = require('./treasury-guards');
  const partyId = parseInt(body && body.party_id, 10);
  if (!partyId) throw httpErr(400, 'شخص را انتخاب کنید', 'E_PERSON');
  const custId = customerForParty(db, partyId);
  if (custId) {
    const err = httpErr(409, 'این شخص مشتری است؛ دریافت در دفتر مشتری ثبت می‌شود', 'E_USE_SETTLEMENT');
    err.cust_id = custId;
    throw err;
  }
  const personId = resolvePersonIdFromVoucherLine(db, { party_id: partyId, target_type: 'person' });
  const person = personId ? db.prepare('SELECT * FROM persons WHERE id=?').get(personId) : null;
  if (!person) throw httpErr(400, 'شخص در فهرست اشخاص یافت نشد', 'E_PERSON');
  const credit = personAccount(db, person);
  const rawType = String((body && body.pay_type) || 'cash').trim().toLowerCase();
  const payType = rawType === 'bank_transfer' ? 'bank' : rawType;
  if (!['cash', 'bank', 'pos_card', 'cheque'].includes(payType)) {
    throw httpErr(400, 'روش دریافت مجاز نیست', 'E_PAY_TYPE');
  }
  const date = assertPaymentDate(db, body && body.date);
  const note = String((body && (body.note || body.description)) || 'دریافت از شخص').trim() || 'دریافت از شخص';
  const bankId = strictPositiveId(body && body.bank_id, 'E_PAY_SOURCE');
  const cashBoxId = strictPositiveId(body && body.cash_box_id, 'E_PAY_SOURCE');
  const slices = [];
  if (payType === 'cheque') {
    const list = Array.isArray(body.cheques) ? body.cheques : [];
    if (!list.length) throw httpErr(400, 'حداقل یک چک دریافتنی لازم است', 'E_CHEQUE_FIELDS');
    if (bankId || cashBoxId) {
      throw httpErr(400, 'چک دریافتنی به اسناد دریافتنی می‌رود و بانک یا صندوق شرکت نمی‌خواهد', 'E_PAY_SOURCE');
    }
    list.forEach((row, i) => {
      const ch = validateReceivedCheque(row, i);
      assertSayadiFree(db, ch.sayadi);
      slices.push({ amount: ch.amount, cheque: ch });
    });
  } else if (payType === 'cash') {
    if (!cashBoxId) throw httpErr(400, 'صندوق مقصد را انتخاب کنید', 'E_CASH_BOX');
    if (bankId) throw httpErr(400, 'برای دریافت نقد شناسه بانک پذیرفته نمی‌شود', 'E_PAY_SOURCE');
    assertActiveCashBox(db, cashBoxId);
    const amounts = Array.isArray(body.installments) && body.installments.length
      ? body.installments.map((n) => Math.round(Number(n) || 0))
      : [Math.round(Number(body.amount) || 0)];
    amounts.forEach((amount, i) => {
      if (!amount || amount <= 0) throw httpErr(400, `قسط ${i + 1} باید بزرگ‌تر از صفر باشد`, 'E_AMOUNT');
      slices.push({ amount, cheque: null });
    });
  } else if (payType === 'bank') {
    if (!bankId) throw httpErr(400, 'بانک مقصد شرکت را انتخاب کنید', 'E_BANK');
    if (cashBoxId) throw httpErr(400, 'برای واریز بانکی شناسه صندوق پذیرفته نمی‌شود', 'E_PAY_SOURCE');
    assertActiveBank(db, bankId);
    const amounts = Array.isArray(body.installments) && body.installments.length
      ? body.installments.map((n) => Math.round(Number(n) || 0))
      : [Math.round(Number(body.amount) || 0)];
    amounts.forEach((amount, i) => {
      if (!amount || amount <= 0) throw httpErr(400, `قسط ${i + 1} باید بزرگ‌تر از صفر باشد`, 'E_AMOUNT');
      slices.push({ amount, cheque: null });
    });
  } else {
    const terminalId = strictPositiveId(body && body.terminal_id, 'E_POS');
    if (!terminalId) throw httpErr(400, 'کارتخوان را انتخاب کنید', 'E_POS');
    if (bankId || cashBoxId) throw httpErr(400, 'کارتخوان بانک یا صندوق شرکت را همان لحظه بدهکار نمی‌کند', 'E_PAY_SOURCE');
    const amounts = Array.isArray(body.installments) && body.installments.length
      ? body.installments.map((n) => Math.round(Number(n) || 0))
      : [Math.round(Number(body.amount) || 0)];
    amounts.forEach((amount, i) => {
      if (!amount || amount <= 0) throw httpErr(400, `قسط ${i + 1} باید بزرگ‌تر از صفر باشد`, 'E_AMOUNT');
      slices.push({ amount, cheque: null });
    });
  }
  const asset = assetAccount(db, payType, payType === 'bank' ? bankId : null, payType === 'cash' ? cashBoxId : null);
  const ids = [];
  const partyName = person.name || person.full_name || '';
  slices.forEach((slice) => {
    const desc = slice.cheque
      ? `${note} — چک ${slice.cheque.number} صیاد ${slice.cheque.sayadi}`
      : note;
    const entryId = postToLedger(db, {
      sourceType: 'manual_voucher',
      sourceId: null,
      date,
      description: desc,
      createdBy: user.id,
      voucherType: 'manual',
      docType: 'person_receipt',
      lines: [
        { code: asset.code, name: asset.name, debit: rialToLedger(slice.amount), credit: 0, description: 'دریافت' },
        { code: credit.code, name: credit.name, debit: 0, credit: rialToLedger(slice.amount), description: 'بستانکار شخص' },
      ],
    });
    db.prepare('UPDATE journal_entries SET ref_id=?, doc_type=? WHERE id=?').run(entryId, 'person_receipt', entryId);
    createPersonLedgerEntry(db, {
      person_id: person.id,
      date,
      entry_type: 'manual_voucher',
      ref_type: 'manual_voucher',
      ref_id: entryId,
      description: 'دریافت از شخص',
      debit: 0,
      credit: slice.amount,
      user_id: user.id,
    });
    if (slice.cheque) {
      insertReceivedCheque(db, {
        ...slice.cheque,
        date,
        amount: slice.amount,
        note: slice.cheque.note || note,
        partyName,
        partyId,
        journalId: entryId,
      });
    }
    ids.push(entryId);
  });
  return { id: ids[0], ids, ok: true, pay_type: payType, count: ids.length };
}

module.exports = {
  digitsOnly,
  validateReceivedCheque,
  customerForParty,
  postPersonReceipt,
};
