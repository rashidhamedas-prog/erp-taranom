'use strict';
/**
 * Purchase invoice mixed / partial payments (mirror of invoice-payments for AP side).
 * Purchase JE keeps supplier AP for the full amount; splits post supplier_payments + settlement JE.
 */
const { postToLedger } = require('./ledger');
const { rialToLedger } = require('./money');
const { todayJalali } = require('../jalali');
const { moneyRial, resolveCashPaid } = require('./cash-on-document');

const SPLIT_TYPES = new Set(['cash', 'bank', 'bank_transfer', 'cheque']);

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

function toAsciiDigits(s) {
  return String(s == null ? '' : s)
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}
function digitsOnly(v) {
  return toAsciiDigits(v).replace(/\D/g, '');
}

function assertChequeSplitFields(s, index) {
  const n = index + 1;
  const sayadi = digitsOnly(s.sayadi);
  const missing = [];
  if (!String(s.cheque_bank || '').trim()) missing.push('نام بانک');
  if (!String(s.cheque_branch || '').trim()) missing.push('شعبه');
  if (!String(s.cheque_account || '').trim()) missing.push('شماره حساب');
  if (!String(s.cheque_number || '').trim()) missing.push('شماره چک');
  if (!/^\d{16}$/.test(sayadi)) missing.push('شناسه صیاد ۱۶ رقمی');
  if (!String(s.cheque_due || '').trim()) missing.push('تاریخ سررسید');
  if (!String(s.cheque_owner || '').trim()) missing.push('نام گیرنده');
  if (missing.length) {
    const e = new Error(`چک پرداختی${n ? ` (ردیف ${n})` : ''}: ${missing.join('، ')} الزامی است`);
    e.status = 400;
    e.code = 'E_CHEQUE_FIELDS';
    throw e;
  }
  const sheba = String(s.sheba || '').replace(/\s/g, '').toUpperCase();
  if (sheba && !/^IR\d{24}$/.test(sheba)) {
    const e = new Error(`چک پرداختی (ردیف ${n}): شبای واردشده معتبر نیست`);
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
    if (s.pay_type === 'cash') {
      s.bank_id = null;
      if (!s.cash_box_id) {
        const e = new Error(`قسط ${i + 1}: صندوق را انتخاب کنید`);
        e.status = 400;
        e.code = 'E_CASH_BOX_REQUIRED';
        throw e;
      }
    } else if (s.pay_type === 'bank_transfer' || s.pay_type === 'bank') {
      s.cash_box_id = null;
      if (!s.bank_id) {
        const e = new Error(`قسط ${i + 1}: بانک واریز را انتخاب کنید`);
        e.status = 400;
        e.code = 'E_BANK_REQUIRED';
        throw e;
      }
    } else if (s.pay_type === 'cheque') {
      s.cash_box_id = null;
      s.bank_id = null;
      const legacy = !digitsOnly(s.sayadi) && !String(s.cheque_number || '').trim()
        && String(s.cheque_info || '').trim();
      if (!legacy) assertChequeSplitFields(s, i);
      else if (!s.check_category_id) {
        const e = new Error(`قسط ${i + 1}: دسته چک را انتخاب کنید`);
        e.status = 400;
        e.code = 'E_CHECK_CATEGORY_REQUIRED';
        throw e;
      }
    } else {
      s.cash_box_id = null;
    }
  });
}

function normalizePurchasePaySplits(body, purchaseFinal) {
  const finalAmt = moneyRial(purchaseFinal);
  const raw = Array.isArray(body && body.pay_splits) ? body.pay_splits : [];
  const splits = raw.map((s, i) => normalizeOneSplit(s, i)).filter((s) => s.amount > 0);
  assertSplits(splits, finalAmt);
  return splits;
}

function resolvePurchasePayments(body, purchaseFinal) {
  const finalAmt = moneyRial(purchaseFinal);
  const b = body || {};
  if (Array.isArray(b.pay_splits) && b.pay_splits.length > 0) {
    const splits = normalizePurchasePaySplits(b, finalAmt);
    return { splits, skipPurchaseCash: true };
  }
  const { paid, payType } = resolveCashPaid(b, finalAmt);
  if (paid <= 0) return { splits: [], skipPurchaseCash: false };
  const pt = normalizePayType(payType || b.pay_type);
  if (!SPLIT_TYPES.has(pt)) return { splits: [], skipPurchaseCash: false };
  const one = normalizeOneSplit(splitFromHeader(b, paid), 0);
  assertSplits([one], finalAmt);
  return { splits: [one], skipPurchaseCash: true };
}

function paymentCreditAccount(db, split) {
  const { acct } = require('./coa-map');
  const { resolveCashAccount } = require('../db');
  if (split && split.pay_type === 'cheque') return acct(db, 'coa_cheques_payable');
  const pt = split.pay_type === 'bank_transfer' ? 'bank' : split.pay_type;
  return resolveCashAccount(db, pt, split.bank_id, split.cash_box_id);
}

function headerPayTypeFromSplits(splits, fallback, purchaseFinal) {
  if (!splits.length) return fallback || 'credit';
  const sum = splits.reduce((a, s) => a + s.amount, 0);
  if (splits.length === 1 && Math.abs(sum - moneyRial(purchaseFinal)) < 1) return splits[0].pay_type;
  if (splits.length === 1) return splits[0].pay_type;
  return 'mixed';
}

function persistPurchasePayPlan(db, purchaseId, payPlan, body) {
  const splits = (payPlan && payPlan.splits) || [];
  const amount = splits.length
    ? splits.reduce((a, s) => a + s.amount, 0)
    : moneyRial(body && body.pay_amount);
  try {
    db.prepare('UPDATE purchase_invoices SET pay_splits_json=?, pay_amount_rial=? WHERE id=?')
      .run(splits.length ? JSON.stringify(splits) : null, amount, purchaseId);
  } catch (_) { /* columns may lag until boot ensureColumn */ }
}

function payableAcct(db, supplierId) {
  const s = supplierId ? db.prepare('SELECT coa_code FROM suppliers WHERE id=?').get(supplierId) : null;
  if (s && s.coa_code) {
    const a = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(s.coa_code);
    if (a) return a;
  }
  const { acct } = require('./coa-map');
  return acct(db, 'coa_payable');
}

function createSupplierLedgerEntry(db, { supplier_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id }) {
  db.prepare('INSERT INTO supplier_ledger (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(supplier_id, date || '', entry_type, ref_type || '', ref_id || null, description || '', debit || 0, credit || 0, user_id || null);
}

function applyPurchasePaySplits(db, {
  purchaseId, supplierId, date, splits, userId, num, chequeHeader,
}) {
  if (!splits || !splits.length) return [];
  const when = date || todayJalali();
  const ids = [];
  splits.forEach((s, i) => {
    const note = s.note || `پرداخت هنگام فاکتور خرید ${num || purchaseId}` + (splits.length > 1 ? ` — قسط ${i + 1}` : '');
    const payId = insertPurchasePayment(db, {
      userId, supplierId, purchaseId, split: s, date: when, note, chequeHeader,
    });
    ids.push({ kind: 'supplier_payment', id: payId });
  });
  recomputePurchaseInvoiceSettledBalances(db, purchaseId);
  return ids;
}

function insertPurchasePayment(db, { userId, supplierId, purchaseId, split, date, note, chequeHeader }) {
  const amountRial = split.amount;
  const pay_type = split.pay_type === 'bank' ? 'bank_transfer' : split.pay_type;
  const chequeInfo = split.cheque_info || (chequeHeader && chequeHeader.cheque_info) || '';
  const chequeDue = split.cheque_due || (chequeHeader && chequeHeader.cheque_due_date) || '';
  const structured = [split.cheque_bank, split.cheque_number, split.sayadi].filter(Boolean).join(' — ');
  const detail = structured || chequeInfo;
  const payNote = detail ? `${note}${note ? ' — ' : ''}${detail}` : note;
  const creditAcct = paymentCreditAccount(db, split);

  if (pay_type === 'cheque' && split.sayadi) {
    const dup = db.prepare(
      "SELECT id FROM cheque_records WHERE sayadi=? AND direction='out' AND COALESCE(record_status,'posted')<>'reversed'"
    ).get(split.sayadi);
    if (dup) {
      const e = new Error('شناسه صیاد این چک قبلاً ثبت شده است');
      e.status = 409;
      e.code = 'E_CHEQUE_SAYADI_DUP';
      throw e;
    }
  }

  const result = db.prepare(
    'INSERT INTO supplier_payments (supplier_id,purchase_invoice_id,amount,pay_type,date,note,created_by,bank_id,check_category_id,cash_box_id,account_code) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    supplierId, purchaseId, amountRial, pay_type, date, payNote, userId,
    split.bank_id, pay_type === 'cheque' ? (split.check_category_id || null) : split.check_category_id,
    split.cash_box_id, pay_type === 'cheque' ? creditAcct.code : ''
  );
  const payId = result.lastInsertRowid;

  if (pay_type === 'cheque') {
    const sup = db.prepare('SELECT name FROM suppliers WHERE id=?').get(supplierId);
    db.prepare(`
      INSERT INTO cheque_records
        (direction, cheque_number, issue_date, receive_date, due_date, bank_name, branch, sayadi, sheba,
         account_number, party_name, party_id, status, amount, note, lifecycle_status)
      VALUES ('out',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      split.cheque_number || '', date || '', date || '', chequeDue,
      split.cheque_bank || '', split.cheque_branch || '', split.sayadi || '', split.sheba || '',
      split.cheque_account || '', (sup && sup.name) || split.cheque_owner || '', supplierId,
      // supplier_payment JE already Dr AP / Cr notes payable — lifecycle is issued, not re-payable.
      'پرداخت‌شده', amountRial, payNote, 'issued'
    );
  }

  createSupplierLedgerEntry(db, {
    supplier_id: supplierId, date, entry_type: 'payment', ref_type: 'supplier_payment', ref_id: payId,
    description: `پرداخت هنگام فاکتور خرید — ${amountRial.toLocaleString('fa-IR')} ریال`,
    debit: amountRial, credit: 0, user_id: userId,
  });

  const payable = payableAcct(db, supplierId);
  const payLabel = pay_type === 'cheque' ? 'چک'
    : (pay_type === 'bank_transfer' || pay_type === 'bank') ? 'واریز بانکی' : 'نقد';
  postToLedger(db, {
    sourceType: 'supplier_payment', sourceId: payId,
    date, description: `پرداخت ${payLabel} هنگام فاکتور خرید`, createdBy: userId,
    lines: [
      { code: payable.code, name: payable.name, debit: rialToLedger(amountRial), credit: 0 },
      { code: creditAcct.code, name: creditAcct.name, debit: 0, credit: rialToLedger(amountRial) },
    ],
  });
  return payId;
}

/** Active linked purchase returns — gross net+VAT in rial (same units as purchase final). */
function sumLinkedPurchaseReturnsGrossRial(db, purchaseInvoiceId) {
  if (!purchaseInvoiceId) return 0;
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT amount, vat_amount FROM purchase_returns
      WHERE purchase_invoice_id=? AND COALESCE(status,'posted')<>'reversed'
    `).all(purchaseInvoiceId);
  } catch (_) {
    return 0;
  }
  return rows.reduce(
    (a, r) => a + moneyRial(Number(r.amount) || 0) + moneyRial(Number(r.vat_amount) || 0),
    0
  );
}

function recomputePurchaseInvoiceSettledBalances(db, purchaseInvoiceId) {
  try {
    const paidSup = db.prepare(`
      SELECT COALESCE(SUM(amount),0) s FROM supplier_payments
      WHERE purchase_invoice_id=? AND COALESCE(status,'posted')<>'reversed'
    `).get(purchaseInvoiceId).s;
    const paidExp = db.prepare(`
      SELECT COALESCE(SUM(amount),0) s FROM expense_payments
      WHERE purchase_invoice_id=? AND COALESCE(status,'posted')<>'reversed'
    `).get(purchaseInvoiceId).s;
    const paidReturns = sumLinkedPurchaseReturnsGrossRial(db, purchaseInvoiceId);
    let paidAlloc = 0;
    try {
      const { sumAllocationsToInvoice, SIDE_PURCHASE } = require('./return-credit-allocate');
      paidAlloc = sumAllocationsToInvoice(db, SIDE_PURCHASE, purchaseInvoiceId);
    } catch (_) { paidAlloc = 0; }
    const paid = moneyRial(paidSup) + moneyRial(paidExp) + paidReturns + paidAlloc;
    const finalRow = db.prepare('SELECT final FROM purchase_invoices WHERE id=?').get(purchaseInvoiceId);
    const finalAmt = moneyRial(finalRow && finalRow.final);
    db.prepare('UPDATE purchase_invoices SET settled_amount=?, balance_due=? WHERE id=?')
      .run(paid, Math.max(0, finalAmt - paid), purchaseInvoiceId);
    return { paid, balance_due: Math.max(0, finalAmt - paid) };
  } catch (_) {
    return null;
  }
}

module.exports = {
  resolvePurchasePayments,
  applyPurchasePaySplits,
  persistPurchasePayPlan,
  headerPayTypeFromSplits,
  paymentCreditAccount,
  SPLIT_TYPES,
  sumLinkedPurchaseReturnsGrossRial,
  recomputePurchaseInvoiceSettledBalances,
};
