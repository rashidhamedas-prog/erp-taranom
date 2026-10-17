'use strict';

const crypto = require('crypto');

/**
 * Shared contract for the five outbound cash-ops paths:
 * person, chart account, internal bank transfer, expense, internal cash transfer.
 *
 * Money is integer rial. Incompatible fields are rejected, not dropped.
 * Cheque on these forms stays closed until a payable-cheque book posts
 * issue / deliver / clear / bounce / void without debiting the bank at issue.
 * Central-only idempotency rows are not a sync table.
 */

const { todayJalali } = require('../jalali');
const { assertFiscalYearWritable } = require('./fiscal-period');
const {
  assertActiveBank, assertActiveCashBox, assertBankOverdraftOk,
} = require('./treasury-guards');

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

function httpErr(status, message, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

function normalizeDigits(raw) {
  return String(raw)
    .replace(/[۰-۹]/g, (ch) => String(FA_DIGITS.indexOf(ch)))
    .replace(/[٠-٩]/g, (ch) => String(AR_DIGITS.indexOf(ch)));
}

function assertRialRoundTrip(n) {
  const back = Math.round((n / 10) * 10);
  if (back !== n) {
    throw httpErr(400, 'مبلغ در تبدیل ریال به واحد سند تغییر می‌کند', 'E_AMOUNT_ROUNDTRIP');
  }
  return n;
}

/** Positive integer id. Blank is absent. "3abc", false, and arrays are errors, not truncated. */
function strictPositiveId(raw, code) {
  const errCode = code || 'E_PAY_SOURCE';
  if (raw == null || raw === '') return null;
  if (typeof raw === 'boolean' || Array.isArray(raw) || (typeof raw === 'object')) {
    throw httpErr(400, 'شناسه حساب باید عدد صحیح باشد و بخش اضافی نادیده گرفته نمی‌شود', errCode);
  }
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw <= 0) {
      throw httpErr(400, 'شناسه حساب باید عدد صحیح مثبت باشد', errCode);
    }
    return raw;
  }
  const s = String(raw).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) {
    throw httpErr(400, 'شناسه حساب باید عدد صحیح باشد و بخش اضافی نادیده گرفته نمی‌شود', errCode);
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw httpErr(400, 'شناسه حساب خارج از محدوده امن است', errCode);
  }
  return n;
}

/** Positive integer rial. Rejects text, decimals, scientific notation, and unsafe magnitude. */
function parseStrictRial(raw, label) {
  const name = label || 'مبلغ';
  if (typeof raw === 'boolean' || raw == null || raw === '' || Array.isArray(raw) || (typeof raw === 'object')) {
    throw httpErr(400, `${name} باید عدد صحیح ریال و بزرگ‌تر از صفر باشد`, 'E_AMOUNT');
  }
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw <= 0) {
      throw httpErr(400, `${name} باید عدد صحیح ریال، مثبت و در محدوده امن باشد`, 'E_AMOUNT');
    }
    return assertRialRoundTrip(raw);
  }
  const s = normalizeDigits(String(raw).trim());
  if (!/^\d+$/.test(s)) {
    throw httpErr(400, `${name} باید عدد صحیح ریال باشد؛ اعشار، متن و نماد علمی پذیرفته نمی‌شود`, 'E_AMOUNT');
  }
  const trimmed = s.replace(/^0+/, '');
  if (!trimmed) throw httpErr(400, `${name} باید بزرگ‌تر از صفر باشد`, 'E_AMOUNT');
  if (trimmed.length > 15) throw httpErr(400, `${name} خارج از محدوده امن است`, 'E_AMOUNT');
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw httpErr(400, `${name} خارج از محدوده امن است`, 'E_AMOUNT');
  }
  return assertRialRoundTrip(n);
}

/** Empty means zero. Any other value must be a positive integer rial. */
function parseOptionalRial(raw, label) {
  if (raw == null || raw === '' || raw === 0 || raw === '0') return 0;
  return parseStrictRial(raw, label || 'کارمزد');
}

function installmentAmounts(body) {
  if (Array.isArray(body && body.installments) && body.installments.length) {
    return body.installments.map((row, i) => {
      const raw = row && typeof row === 'object' ? row.amount : row;
      if (raw == null || raw === '' || raw === 0 || raw === '0') {
        throw httpErr(400, `قسط ${i + 1} خالی یا صفر است`, 'E_INSTALLMENT');
      }
      return parseStrictRial(raw, `قسط ${i + 1}`);
    });
  }
  return [parseStrictRial(body && body.amount, 'مبلغ')];
}

/**
 * cash ↔ cash_box_id, bank|bank_transfer ↔ bank_id.
 * A leftover id for the other instrument is an error.
 * Cheque is refused on these forms.
 */
function exclusivePaySource(body) {
  const raw = String((body && body.pay_type) || 'cash').trim().toLowerCase();
  if (raw === 'cheque' || raw === 'check' || raw === 'چک') {
    throw httpErr(
      400,
      'ثبت چک در پرداخت به شخص، حساب و هزینه تا اتصال کامل دفتر چک پرداختنی بسته است. بانک با صرف صدور چک بستانکار نمی‌شود.',
      'E_CHEQUE_FORM_CLOSED'
    );
  }
  const payType = raw === 'bank_transfer' ? 'bank' : raw;
  if (payType !== 'cash' && payType !== 'bank') {
    throw httpErr(400, 'نوع پرداخت مجاز نیست', 'E_PAY_TYPE');
  }
  const bankId = strictPositiveId(body && body.bank_id, 'E_PAY_SOURCE');
  const cashBoxId = strictPositiveId(body && body.cash_box_id, 'E_PAY_SOURCE');
  if (payType === 'cash') {
    if (!cashBoxId) throw httpErr(400, 'صندوق را انتخاب کنید', 'E_CASH_BOX');
    if (bankId) throw httpErr(400, 'برای پرداخت نقدی شناسه بانک پذیرفته نمی‌شود', 'E_PAY_SOURCE');
    return { payType: 'cash', bankId: null, cashBoxId };
  }
  if (!bankId) throw httpErr(400, 'بانک را انتخاب کنید', 'E_BANK');
  if (cashBoxId) throw httpErr(400, 'برای واریز بانکی شناسه صندوق پذیرفته نمی‌شود', 'E_PAY_SOURCE');
  return { payType: 'bank', bankId, cashBoxId: null };
}

function assertPaymentDate(db, raw) {
  let s = raw == null || raw === '' ? todayJalali() : normalizeDigits(String(raw).trim());
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(s)) {
    throw httpErr(400, 'تاریخ باید جلالی و به صورت YYYY/MM/DD باشد', 'E_DATE');
  }
  const m = parseInt(s.slice(5, 7), 10);
  const d = parseInt(s.slice(8, 10), 10);
  const dim = m >= 1 && m <= 6 ? 31 : 30;
  if (m < 1 || m > 12 || d < 1 || d > dim) {
    throw httpErr(400, 'تاریخ جلالی معتبر نیست', 'E_DATE');
  }
  const fy = assertFiscalYearWritable(db, s);
  if (!fy.ok) throw httpErr(422, fy.error, 'E_FY_LOCKED');
  return s;
}

function cashAccountForSource(db, src) {
  const { resolveCashAccount } = require('../db');
  return resolveCashAccount(
    db,
    src.payType === 'bank' ? 'bank' : 'cash',
    src.bankId,
    src.cashBoxId
  );
}

/**
 * Validates one outbound payment body (optional installments).
 * Fee is allowed only on bank and is charged once, on the first installment.
 */
function assertOutboundPayment(db, body) {
  const src = exclusivePaySource(body || {});
  const amounts = installmentAmounts(body || {});
  const date = assertPaymentDate(db, body && body.date);
  const fee = parseOptionalRial(body && (body.fee_rial != null ? body.fee_rial : body.bank_fee_rial), 'کارمزد');
  if (fee > 0 && src.payType !== 'bank') {
    throw httpErr(400, 'کارمزد فقط برای واریز بانکی مجاز است و نادیده گرفته نمی‌شود', 'E_FEE');
  }
  if (src.payType === 'cash') assertActiveCashBox(db, src.cashBoxId);
  else {
    assertActiveBank(db, src.bankId);
    const total = amounts.reduce((sum, n) => sum + n, 0) + fee;
    assertBankOverdraftOk(db, src.bankId, total);
  }
  return { ...src, amounts, date, fee };
}

function assertTransferPair(body) {
  const fromType = String(body && body.from_type || '');
  const toType = String(body && body.to_type || '');
  if (fromType !== 'cash' && fromType !== 'bank') {
    throw httpErr(400, 'نوع حساب مبدأ نامعتبر است', 'E_TRANSFER_SIDE');
  }
  if (toType !== 'cash' && toType !== 'bank') {
    throw httpErr(400, 'نوع حساب مقصد نامعتبر است', 'E_TRANSFER_SIDE');
  }
  const fromId = strictPositiveId(body.from_id, 'E_TRANSFER_SIDE');
  const toId = strictPositiveId(body.to_id, 'E_TRANSFER_SIDE');
  if (!fromId || !toId) {
    throw httpErr(400, 'مبدأ و مقصد باید حساب مشخص باشند. گزینه عمومی پذیرفته نمی‌شود', 'E_TRANSFER_SIDE');
  }
  if (fromType === toType && fromId === toId) {
    throw httpErr(400, 'حساب مبدأ و مقصد نمی‌تواند یکسان باشد', 'E_TRANSFER_SAME');
  }
  const amount = parseStrictRial(body.amount, 'مبلغ');
  const feeRaw = body.fee_rial != null ? body.fee_rial : body.bank_fee_rial;
  const feeGiven = !(feeRaw == null || feeRaw === '' || feeRaw === 0 || feeRaw === '0');
  if (feeGiven && fromType !== 'bank') {
    throw httpErr(400, 'کارمزد فقط وقتی مبدأ بانک است مجاز است', 'E_FEE');
  }
  const fee = fromType === 'bank' ? parseOptionalRial(feeRaw, 'کارمزد') : 0;
  return { fromType, toType, fromId, toId, amount, fee };
}

function paymentBodyHash(body) {
  if (!body || typeof body !== 'object') return '';
  const pick = {
    amount: body.amount ?? null,
    installments: body.installments ?? null,
    pay_type: body.pay_type ?? null,
    bank_id: body.bank_id ?? null,
    cash_box_id: body.cash_box_id ?? null,
    date: body.date ?? null,
    fee_rial: body.fee_rial ?? body.bank_fee_rial ?? null,
    from_type: body.from_type ?? null,
    from_id: body.from_id ?? null,
    to_type: body.to_type ?? null,
    to_id: body.to_id ?? null,
    supplier_id: body.supplier_id ?? null,
    party_id: body.party_id ?? null,
    rep_id: body.rep_id ?? null,
    account_code: body.account_code ?? null,
    purchase_invoice_id: body.purchase_invoice_id ?? null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(pick)).digest('hex');
}

function ensureIdempotencyTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cash_payment_idempotency (
      idempotency_key TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      user_id INTEGER,
      result_json TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )
  `);
  const cols = db.prepare('PRAGMA table_info(cash_payment_idempotency)').all();
  if (!cols.some((c) => c.name === 'body_hash')) {
    db.exec('ALTER TABLE cash_payment_idempotency ADD COLUMN body_hash TEXT');
  }
}

function withPaymentIdempotency(db, meta, work) {
  ensureIdempotencyTable(db);
  const key = String((meta && meta.key) || '').trim();
  if (key && (key.length > 80 || !/^[\w.:-]+$/.test(key))) {
    throw httpErr(400, 'کلید تکرار عملیات نامعتبر است', 'E_IDEMPOTENCY');
  }
  const run = () => {
    if (key) {
      const prev = db.prepare(
        'SELECT path, result_json, body_hash FROM cash_payment_idempotency WHERE idempotency_key=?'
      ).get(key);
      if (prev) {
        const path = String(meta.path || '');
        if (String(prev.path || '') !== path) {
          throw httpErr(409, 'این کلید تکرار برای مسیر دیگری ثبت شده است', 'E_IDEMPOTENCY');
        }
        const hash = paymentBodyHash(meta.body);
        if (prev.body_hash && hash && prev.body_hash !== hash) {
          throw httpErr(409, 'این کلید تکرار با بدنهٔ دیگری ثبت شده است', 'E_IDEMPOTENCY');
        }
        const parsed = JSON.parse(prev.result_json);
        parsed.replayed = true;
        return parsed;
      }
    }
    const result = work();
    if (key) {
      db.prepare(
        'INSERT INTO cash_payment_idempotency (idempotency_key, path, user_id, result_json, body_hash) VALUES (?,?,?,?,?)'
      ).run(key, String(meta.path || ''), meta.userId || null, JSON.stringify(result), paymentBodyHash(meta.body) || null);
    }
    return result;
  };
  try {
    return db.transaction(run)();
  } catch (e) {
    if (key && /UNIQUE/i.test(String(e && e.message))) {
      const prev = db.prepare(
        'SELECT path, result_json, body_hash FROM cash_payment_idempotency WHERE idempotency_key=?'
      ).get(key);
      if (prev) {
        if (String(prev.path || '') !== String(meta.path || '')) {
          throw httpErr(409, 'این کلید تکرار برای مسیر دیگری ثبت شده است', 'E_IDEMPOTENCY');
        }
        const hash = paymentBodyHash(meta.body);
        if (prev.body_hash && hash && prev.body_hash !== hash) {
          throw httpErr(409, 'این کلید تکرار با بدنهٔ دیگری ثبت شده است', 'E_IDEMPOTENCY');
        }
        const parsed = JSON.parse(prev.result_json);
        parsed.replayed = true;
        return parsed;
      }
    }
    throw e;
  }
}

/** Stable identity for «پرداخت به شخص» versus an ordinary manual voucher. */
function isPersonPaymentVoucher(db, entry) {
  if (!entry || entry.ref_type !== 'manual_voucher') return false;
  if (String(entry.doc_type || '') === 'person_payment') return true;
  const desc = String(entry.description || '');
  const personHit = db.prepare(`
    SELECT 1 AS ok FROM person_ledger
    WHERE ref_type='manual_voucher' AND ref_id=? AND debit>0 LIMIT 1
  `).get(entry.id);
  if (!personHit) return false;
  if (desc.includes('پرداخت به شخص')) return true;
  const lineHit = db.prepare(`
    SELECT 1 AS ok FROM journal_lines
    WHERE entry_id=? AND IFNULL(description,'') LIKE '%پرداخت به شخص%' LIMIT 1
  `).get(entry.id);
  return !!lineHit;
}

const EXPENSE_NOT_AP = 'تسویه بدهی فاکتور خرید از «پرداخت به شخص → تأمین‌کننده» ثبت می‌شود. پرداخت هزینه فقط هزینه مستقیم است و همان مبلغ را بدهی فاکتور حساب نمی‌کند.';

module.exports = {
  httpErr,
  parseStrictRial,
  parseOptionalRial,
  installmentAmounts,
  exclusivePaySource,
  assertPaymentDate,
  assertOutboundPayment,
  assertTransferPair,
  cashAccountForSource,
  withPaymentIdempotency,
  isPersonPaymentVoucher,
  EXPENSE_NOT_AP,
};
