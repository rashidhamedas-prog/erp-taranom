'use strict';
/**
 * Invoice payments — single path:
 * Invoice JE always posts full AR (customer debit). Every immediate receipt
 * (cash/bank/cheque/POS, full or partial, single or multi) becomes a settlement
 * (or POS in-transit receipt) with its own JE / customer_ledger credit.
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

function toAsciiDigits(s) {
  return String(s == null ? '' : s)
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

function digitsOnly(v) {
  return toAsciiDigits(v).replace(/\D/g, '');
}

function normalizeSheba(v) {
  let s = toAsciiDigits(v).replace(/\s/g, '').toUpperCase();
  if (!s) return '';
  if (/^\d{24}$/.test(s)) s = `IR${s}`;
  return s;
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
    cheque_due: b.cheque_due_date || b.cheque_due,
    cheque_bank: b.cheque_bank,
    cheque_branch: b.cheque_branch,
    cheque_account: b.cheque_account,
    cheque_number: b.cheque_number,
    sayadi: b.cheque_sayadi || b.sayadi,
    cheque_owner: b.cheque_owner,
    sheba: b.cheque_sheba || b.sheba,
  };
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
  const sheba = normalizeSheba(s.sheba);
  if (sheba && !/^IR\d{24}$/.test(sheba)) {
    const e = new Error(`چک دریافتی (ردیف ${n}): شبای واردشده معتبر نیست (IR + ۲۴ رقم)`);
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
  const mapped = raw.map((s, i) => normalizeOneSplit(s, i));
  const zeroIdx = mapped.findIndex((s) => !(s.amount > 0));
  if (zeroIdx >= 0 && mapped.length > 0) {
    const e = new Error(`قسط ${zeroIdx + 1}: مبلغ دریافت باید بزرگ‌تر از صفر باشد`);
    e.status = 400;
    e.code = 'E_PAY_SPLIT_AMOUNT';
    throw e;
  }
  const splits = mapped.filter((s) => s.amount > 0);
  assertSplits(splits, finalAmt);
  return splits;
}

/**
 * Every non-credit immediate receipt becomes settlement splits.
 * Invoice JE must use payType credit (skipInvoiceCash) whenever splits exist.
 */
function resolveInvoicePayments(body, invoiceFinal, opts) {
  const finalAmt = moneyRial(invoiceFinal);
  const b = body || {};
  if (Array.isArray(b.pay_splits) && b.pay_splits.length > 0) {
    const splits = normalizeInvoicePaySplits(b, finalAmt);
    return { splits, skipInvoiceCash: true };
  }
  const pt = normalizePayType(b.pay_type);
  if (!pt || pt === 'credit') {
    return { splits: [], skipInvoiceCash: false };
  }
  if (!SPLIT_TYPES.has(pt)) {
    return { splits: [], skipInvoiceCash: false };
  }
  // A blank cheque face used to become the whole invoice (one leaf, summed).
  if (pt === 'cheque' && !(opts && opts.allowImplicitChequeFace)) {
    const rawAmt = b.pay_amount;
    const declared = rawAmt != null && rawAmt !== '' ? moneyRial(rawAmt) : 0;
    if (!(declared > 0)) {
      const e = new Error('مبلغ این فقره چک را جدا وارد کنید؛ مبلغ خالی روی یک برگه با کل فاکتور جمع نمی‌شود');
      e.status = 400;
      e.code = 'E_CHEQUE_FACE';
      throw e;
    }
  }
  const { paid } = resolveCashPaid(b, finalAmt);
  if (paid <= 0) {
    return { splits: [], skipInvoiceCash: false };
  }
  const one = normalizeOneSplit(splitFromHeader(b, paid), 0);
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
    sheba: normalizeSheba(s.sheba || s.cheque_sheba),
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
  try {
    const finalRow = db.prepare('SELECT final, final_rial FROM invoices WHERE id=?').get(invoiceId);
    const finalAmt = moneyRial(finalRow && (finalRow.final_rial != null ? finalRow.final_rial : finalRow.final));
    const settled = moneyRial(amount);
    db.prepare('UPDATE invoices SET settled_amount=?, balance_due=? WHERE id=?')
      .run(settled, Math.max(0, finalAmt - settled), invoiceId);
  } catch (_) { /* optional columns */ }
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
  }, invoiceFinal, { allowImplicitChequeFace: true });
}

/** Active linked sales returns — gross net+VAT in rial (same units as invoice final_rial). */
function sumLinkedSalesReturnsGrossRial(db, invoiceId) {
  if (!invoiceId) return 0;
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT amount, vat_amount FROM sales_returns
      WHERE invoice_id=? AND COALESCE(status,'posted')<>'reversed'
    `).all(invoiceId);
  } catch (_) {
    return 0;
  }
  return rows.reduce(
    (a, r) => a + moneyRial(Number(r.amount) || 0) + moneyRial(Number(r.vat_amount) || 0),
    0
  );
}

function recomputeInvoiceSettledBalances(db, invoiceId) {
  try {
    const receipts = loadInvoiceReceipts(db, invoiceId);
    const paidSett = (receipts.settlements || []).reduce(
      (a, s) => a + moneyRial(Number(s.amount_rial) || s.amount), 0
    );
    const paidPos = (receipts.pos || []).reduce(
      (a, p) => a + moneyRial(Number(p.amount_rial) || p.amount), 0
    );
    // POS receipts already create a settlement row with the same amount — count settlements only
    // when both exist for the same cash movement. Prefer settlement sum; if no settlements, use POS.
    const paidReceipts = paidSett > 0 ? paidSett : paidPos;
    const paidReturns = sumLinkedSalesReturnsGrossRial(db, invoiceId);
    let paidAlloc = 0;
    try {
      const { sumAllocationsToInvoice, SIDE_SALES } = require('./return-credit-allocate');
      paidAlloc = sumAllocationsToInvoice(db, SIDE_SALES, invoiceId);
    } catch (_) { paidAlloc = 0; }
    const paid = paidReceipts + paidReturns + paidAlloc;
    const finalRow = db.prepare('SELECT final, final_rial FROM invoices WHERE id=?').get(invoiceId);
    const finalAmt = moneyRial(finalRow && (Number(finalRow.final_rial) || finalRow.final));
    db.prepare('UPDATE invoices SET settled_amount=?, balance_due=? WHERE id=?')
      .run(paid, Math.max(0, finalAmt - paid), invoiceId);
    return { paid, balance_due: Math.max(0, finalAmt - paid) };
  } catch (_) {
    return null;
  }
}

function applyInvoicePaySplits(db, {
  invoiceId, custId, date, splits, userId, num, chequeHeader, skipJournal, startIndex,
}) {
  if (!splits || !splits.length) return [];
  const when = date || todayJalali();
  const base = Math.max(0, Math.round(Number(startIndex) || 0));
  const ids = [];
  let chequeLeaf = 0;
  const multi = (base + splits.length) > 1;
  splits.forEach((s, i) => {
    const absI = base + i;
    // «قسط» برای همهٔ انواع گمراه‌کننده است — برگ چک را فقره بنام؛ کارتخوان/نقد را قسط.
    let stage = '';
    if (multi) {
      if (s.pay_type === 'cheque') {
        chequeLeaf += 1;
        stage = ` — فقره چک ${chequeLeaf}`;
      } else {
        const kind = s.pay_type === 'pos_card' ? 'کارتخوان' : (s.pay_type === 'cash' ? 'نقد' : 'قسط');
        stage = ` — ${kind} ${absI + 1}`;
      }
    }
    const note = s.note || `دریافت هنگام فاکتور ${num || invoiceId}${stage}`;
    if (s.pay_type === 'pos_card') {
      if (skipJournal) {
        ids.push({ kind: 'pos_skipped', id: null });
        return;
      }
      const pos = require('./pos');
      const rec = pos.postReceipt(db, {
        terminal_id: s.terminal_id,
        amount_rial: s.amount,
        invoice_id: invoiceId,
        cust_id: custId,
        date: when,
        note,
        idempotency_key: `inv-${invoiceId}-pos-${absI}-${s.amount}`,
      }, { id: userId });
      ids.push({ kind: 'pos', id: rec && (rec.receiptId || rec.id) });
      return;
    }
    const settlementId = insertInvoiceSettlement(db, {
      userId, custId, invoiceId, split: s, date: when, note, chequeHeader, skipJournal,
    });
    ids.push({ kind: 'settlement', id: settlementId });
  });
  recomputeInvoiceSettledBalances(db, invoiceId);
  return ids;
}

/**
 * Live cheque receipts that never got a دفتر چک row (older receive path)
 * get exactly one instrument. Does not post a second JE or customer credit.
 */
function backfillMissingSettlementCheques(db) {
  const FLAG = 'cheque_receipt_mirror_v339';
  let done = null;
  try { done = db.prepare('SELECT value FROM settings WHERE key=?').get(FLAG); } catch (_) { done = null; }
  if (done && done.value === '1') return { inserted: 0, skipped: true };
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT id, cust_id, invoice_id, amount, amount_rial, date, note,
             cheque_number, cheque_due, cheque_bank, cheque_branch, cheque_sayadi,
             cheque_sheba, cheque_account
      FROM settlements
      WHERE pay_type='cheque' AND COALESCE(status,'posted')<>'reversed'
        AND NOT EXISTS (
          SELECT 1 FROM cheque_records cr
          WHERE cr.settlement_id=settlements.id
            AND COALESCE(cr.record_status,'posted')<>'reversed'
        )
    `).all();
  } catch (_) {
    return { inserted: 0, skipped: true };
  }
  let inserted = 0;
  const run = db.transaction(() => {
    for (const s of rows) {
      const amountRial = Math.round(Number(s.amount_rial != null ? s.amount_rial : s.amount) || 0);
      if (!(amountRial > 0)) continue;
      try {
        const id = insertChequeRecordForSettlement(db, {
          settlementId: s.id,
          invoiceId: s.invoice_id || null,
          custId: s.cust_id,
          amountRial,
          date: s.date || '',
          note: s.note || '',
          cheque_number: s.cheque_number,
          cheque_due: s.cheque_due,
          cheque_bank: s.cheque_bank,
          cheque_branch: s.cheque_branch || '',
          sayadi: s.cheque_sayadi,
          sheba: s.cheque_sheba || '',
          cheque_account: s.cheque_account,
        });
        if (id) inserted += 1;
      } catch (e) {
        if (e && e.code === 'E_CHEQUE_SAYADI_DUP') continue;
        throw e;
      }
    }
    db.prepare("INSERT INTO settings (key,value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value='1'")
      .run(FLAG);
  });
  run();
  if (inserted) console.log(`✅ چک دریافت بدون ردیف دفتر ساخته شد (${inserted})`);
  return { inserted };
}

/**
 * One physical cheque ⇒ one دفتر چک row. Never sum several leaves onto one sayadi.
 */
function insertChequeRecordForSettlement(db, {
  settlementId, invoiceId, custId, amountRial, date, note,
  cheque_number, cheque_due, cheque_bank, cheque_branch, sayadi, sheba, cheque_account,
}) {
  if (!settlementId || !amountRial) return null;
  const sayadiNorm = digitsOnly(sayadi);
  if (sayadiNorm) {
    const dup = db.prepare(
      "SELECT id FROM cheque_records WHERE sayadi=? AND direction='in' AND COALESCE(record_status,'posted')<>'reversed'"
    ).get(sayadiNorm);
    if (dup) {
      const e = new Error('شناسه صیاد این چک قبلاً ثبت شده است');
      e.status = 409;
      e.code = 'E_CHEQUE_SAYADI_DUP';
      throw e;
    }
  }
  const existing = db.prepare(`
    SELECT id FROM cheque_records
    WHERE settlement_id=? AND COALESCE(record_status,'posted')<>'reversed'
    LIMIT 1
  `).get(settlementId);
  if (existing) return existing.id;
  const cust = custId
    ? db.prepare('SELECT biz, owner, party_id FROM customers WHERE id=?').get(custId)
    : null;
  const result = db.prepare(`
    INSERT INTO cheque_records
      (direction, cheque_number, receive_date, due_date, bank_name, branch, sayadi, sheba,
       account_number, party_name, party_id, customer_id, status, amount, note, invoice_id, settlement_id, lifecycle_status)
    VALUES ('in',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    cheque_number || '', date || '', cheque_due || '', cheque_bank || '', cheque_branch || '',
    sayadiNorm || '', sheba || '', cheque_account || '',
    (cust && (cust.biz || cust.owner)) || '', (cust && cust.party_id) || null, custId || null,
    'نزد صندوق', amountRial, note || '', invoiceId || null, settlementId, 'registered'
  );
  return result.lastInsertRowid;
}

function insertInvoiceSettlement(db, { userId, custId, invoiceId, split, date, note, chequeHeader, skipJournal }) {

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
    // Canonical lifecycle: registered (= نزد صندوق). Never in_hand/in_collection until send-to-bank.
    insertChequeRecordForSettlement(db, {
      settlementId, invoiceId, custId, amountRial, date, note: settNote,
      cheque_number: split.cheque_number, cheque_due: chequeDue,
      cheque_bank: split.cheque_bank, cheque_branch: split.cheque_branch,
      sayadi: split.sayadi, sheba: split.sheba, cheque_account: split.cheque_account,
    });
  }
  const payLabel = pay_type === 'cheque' ? 'چک'
    : (pay_type === 'bank_transfer' || pay_type === 'bank') ? 'واریز بانکی' : 'نقد';
  // Always mirror into customer_ledger so صورت‌حساب / گردش مشتری stay complete.
  // skipJournal only avoids a second GL posting when cash already sits on the invoice JE.
  const booksExist = db.prepare(`
    SELECT 1 FROM customer_ledger
    WHERE customer_id=? AND (
      (ref_type='settlement' AND ref_id=?)
      OR (ref_type='invoice_payment' AND ref_id=?)
      OR (ref_type='pos_receipt' AND debit=0 AND credit=? AND date=?)
    )
    LIMIT 1
  `).get(custId, settlementId, invoiceId || 0, amountRial, date || '');
  if (!booksExist) {
    createLedgerEntry(db, {
      customer_id: custId, date, entry_type: 'settlement',
      ref_type: 'settlement', ref_id: settlementId,
      description: `تسویه ${payLabel} هنگام فاکتور — ${amountRial.toLocaleString('fa-IR')} ریال`,
      debit: 0, credit: amountRial, user_id: userId,
    });
  }
  if (skipJournal) {
    return settlementId;
  }
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

function loadInvoiceReceipts(db, invoiceId) {
  let settlements = [];
  try {
    settlements = db.prepare(`
      SELECT s.*, b.name AS bank_name, cb.name AS cash_box_name
      FROM settlements s
      LEFT JOIN banks b ON b.id=s.bank_id
      LEFT JOIN cash_boxes cb ON cb.id=s.cash_box_id
      WHERE s.invoice_id=? AND COALESCE(s.status,'posted')<>'reversed'
      ORDER BY s.id
    `).all(invoiceId);
  } catch (_) {
    try {
      settlements = db.prepare(`
        SELECT s.* FROM settlements s
        WHERE s.invoice_id=? AND COALESCE(s.status,'posted')<>'reversed'
        ORDER BY s.id
      `).all(invoiceId);
    } catch (__) { settlements = []; }
  }
  let pos = [];
  try {
    pos = db.prepare(`
      SELECT pr.*, t.name AS terminal_name
      FROM pos_receipts pr
      LEFT JOIN pos_terminals t ON t.id=pr.terminal_id
      WHERE pr.invoice_id=? AND COALESCE(pr.status,'posted') NOT IN ('reversed','void')
      ORDER BY pr.id
    `).all(invoiceId);
  } catch (_) { pos = []; }
  return { settlements, pos };
}

module.exports = {
  normalizeInvoicePaySplits,
  resolveInvoicePayments,
  headerPayTypeFromSplits,
  usesSplitPosting,
  applyInvoicePaySplits,
  recomputeInvoiceSettledBalances,
  sumLinkedSalesReturnsGrossRial,
  persistInvoicePayPlan,
  paymentsFromStoredInvoice,
  settlementAssetAccount,
  insertChequeRecordForSettlement,
  backfillMissingSettlementCheques,
  loadInvoiceReceipts,
  digitsOnly,
  toAsciiDigits,
  normalizeSheba,
  SPLIT_TYPES,
};
