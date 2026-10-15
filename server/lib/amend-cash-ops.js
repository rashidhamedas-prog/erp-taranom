/**
 * In-place correction of cash-ops documents (دریافت/پرداخت).
 *
 * Same row id and the same live journal id are kept. Journal lines and the
 * party sub-ledger are rewritten in one transaction — the same idea as
 * patchOneInvoiceTimeSettlement — so cheque links, installment rows, and an
 * approved field receipt stay attached to this document.
 *
 * Money that lives on another voucher is not rewritten from here:
 * invoice-time receipts, card receipts, and cheques already in collection.
 */
'use strict';

const { rewriteJournalEntry } = require('./ledger');
const { rialToLedger } = require('./money');
const { acct } = require('./coa-map');
const { assertFiscalYearWritable } = require('./fiscal-period');
const { createLedgerEntry, resolveCashAccount } = require('../db');
const { parseFeeRial, outboundPaymentLines } = require('./payment-bank-fee');
const { recvAcct } = require('./void-settlement');
const { digitsOnly, normalizeSheba, recomputeInvoiceSettledBalances } = require('./invoice-payments');
const {
  sumLinkedPurchaseReturnsGrossRial, recomputePurchaseInvoiceSettledBalances,
} = require('./purchase-payments');
const { reverseJournalEntry } = require('./void-journal');
const { assertActiveBank, assertActiveCashBox, assertBankOverdraftOk } = require('./treasury-guards');

const RECEIPT_PAY = new Set(['cash', 'bank', 'bank_transfer', 'cheque']);
const PAY_PAY = new Set(['cash', 'bank', 'bank_transfer', 'cheque']);
const EARLY_CHEQUE_LC = new Set(['', 'registered', 'in_hand', 'pending', 'issued']);

function httpErr(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function assertDatesWritable(db, oldDate, newDate) {
  for (const d of [oldDate, newDate]) {
    if (!d) continue;
    const fy = assertFiscalYearWritable(db, d);
    if (!fy.ok) throw httpErr(422, fy.error, 'E_FY_LOCKED');
  }
}

function liveJe(db, refType, refId) {
  return db.prepare(`
    SELECT id, ref_type, entry_date, description
    FROM journal_entries
    WHERE ref_type=? AND ref_id=?
      AND COALESCE(deleted_at,0)=0
      AND COALESCE(status,'posted') NOT IN ('reversed','void')
    ORDER BY id ASC
    LIMIT 1
  `).get(refType, refId);
}

function requireLiveJe(db, types, refId, label) {
  for (const refType of types) {
    const row = liveJe(db, refType, refId);
    if (row) return row;
  }
  throw httpErr(
    409,
    `سند دفتر این ${label} پیدا نشد. سند را ابطال کنید و دوباره ثبت کنید.`,
    'E_NO_JE'
  );
}

function coaOrThrow(db, code) {
  const row = db.prepare('SELECT code, name FROM chart_of_accounts WHERE code=?').get(String(code || '').trim());
  if (!row) throw httpErr(400, 'حساب انتخاب‌شده در کدینگ نیست', 'E_COA');
  return row;
}

function cashAccount(db, payType, bankId, cashBoxId, accountCode) {
  const override = String(accountCode || '').trim();
  // ADR-001: cheque receipts always hit notes receivable; ignore COA override.
  if (String(payType || '') === 'cheque') {
    return acct(db, 'coa_cheques_receivable');
  }
  if (override) return coaOrThrow(db, override);
  return resolveCashAccount(db, payType || 'cash', bankId || null, cashBoxId || null);
}

function payableAcct(db, supplierId) {
  const s = supplierId ? db.prepare('SELECT coa_code FROM suppliers WHERE id=?').get(supplierId) : null;
  if (s && s.coa_code) {
    const a = db.prepare('SELECT code, name FROM chart_of_accounts WHERE code=?').get(s.coa_code);
    if (a) return a;
  }
  return acct(db, 'coa_payable');
}

function payLabel(payType) {
  if (payType === 'cheque') return 'چک';
  if (payType === 'bank' || payType === 'bank_transfer') return 'واریز بانکی';
  return 'نقد';
}

function assertDest(payType, bankId, cashBoxId) {
  if (payType === 'pos_card') {
    throw httpErr(400, 'اصلاح به کارتخوان از این فرم ممکن نیست. سند را ابطال کنید و از کارتخوان دوباره ثبت کنید.', 'E_POS');
  }
  if (payType === 'cash' && !cashBoxId) throw httpErr(400, 'صندوق را انتخاب کنید', 'E_CASH_BOX');
  if ((payType === 'bank' || payType === 'bank_transfer' || payType === 'cheque') && !bankId) {
    throw httpErr(400, 'بانک را انتخاب کنید', 'E_BANK');
  }
}

function normalizePay(raw, allowed) {
  const payType = String(raw || 'cash');
  if (!allowed.has(payType)) throw httpErr(400, 'نوع پرداخت نامعتبر است', 'E_PAY_TYPE');
  return payType;
}

function rewriteOrThrow(db, opts) {
  const id = rewriteJournalEntry(db, opts);
  if (!id) {
    throw httpErr(409, 'سند دفتر برای اصلاح پیدا نشد', 'E_NO_JE');
  }
  return id;
}

function assertSayadiFree(db, sayadi, settlementId) {
  const d = digitsOnly(sayadi);
  if (!d) return;
  try {
    const dup = db.prepare(`
      SELECT id FROM cheque_records
      WHERE sayadi=? AND direction='in' AND COALESCE(record_status,'posted')<>'reversed'
        AND COALESCE(settlement_id,0)<>?
    `).get(d, settlementId);
    if (dup) throw httpErr(409, 'شناسه صیاد این چک قبلاً ثبت شده است', 'E_CHEQUE_SAYADI_DUP');
  } catch (e) {
    if (e && e.status) throw e;
  }
  const rows = db.prepare(`
    SELECT id, cheque_sayadi FROM settlements
    WHERE id<>? AND pay_type='cheque' AND COALESCE(status,'posted')<>'reversed'
      AND TRIM(COALESCE(cheque_sayadi,''))<>''
  `).all(settlementId);
  if (rows.some((r) => digitsOnly(r.cheque_sayadi) === d)) {
    throw httpErr(409, 'شناسه صیاد این چک قبلاً در دریافت دیگری ثبت شده است', 'E_CHEQUE_SAYADI_DUP');
  }
}

function assertChequeEditable(db, settlementId, chequeStatus) {
  if (['received', 'bounced', 'cancelled'].includes(String(chequeStatus || ''))) {
    throw httpErr(
      409,
      'وضعیت این چک وصول، برگشت یا ابطال است. برای اصلاح، سند را ابطال کنید و دریافت جدید ثبت کنید.',
      'E_CHEQUE_STATUS'
    );
  }
  let row = null;
  try {
    row = db.prepare(`
      SELECT id, lifecycle_status, COALESCE(collection_je_id,0) AS collection_je_id
      FROM cheque_records
      WHERE settlement_id=? AND COALESCE(record_status,'posted')<>'reversed'
      ORDER BY id DESC LIMIT 1
    `).get(settlementId);
  } catch (_) {
    return;
  }
  if (!row) return;
  const lc = String(row.lifecycle_status || '').trim();
  if (Number(row.collection_je_id) > 0 || !EARLY_CHEQUE_LC.has(lc)) {
    throw httpErr(
      409,
      'این چک در چرخهٔ وصول یا واگذاری است. اول وضعیت چک را برگردانید، یا سند را ابطال کنید.',
      'E_CHEQUE_LIFECYCLE'
    );
  }
}

function syncChequeRecords(db, settlementId, cust, fields) {
  const payType = fields.payType;
  try {
    if (payType !== 'cheque') {
      db.prepare(`
        UPDATE cheque_records SET record_status='reversed'
        WHERE settlement_id=? AND COALESCE(record_status,'posted')<>'reversed'
      `).run(settlementId);
      return;
    }
    const sayadi = digitsOnly(fields.cheque_sayadi);
    const existing = db.prepare(`
      SELECT id FROM cheque_records
      WHERE settlement_id=? AND COALESCE(record_status,'posted')<>'reversed'
      ORDER BY id DESC LIMIT 1
    `).get(settlementId);
    if (!existing) return;
    db.prepare(`
      UPDATE cheque_records SET
        cheque_number=?, receive_date=?, due_date=?, bank_name=?, branch=?,
        sayadi=?, sheba=?, account_number=?, party_name=?, party_id=?, customer_id=?,
        amount=?, note=?, invoice_id=?
      WHERE id=?
    `).run(
      fields.cheque_number || '',
      fields.date || '',
      fields.cheque_due || '',
      fields.cheque_bank || '',
      fields.cheque_branch || '',
      sayadi || '',
      fields.cheque_sheba || '',
      fields.cheque_account || '',
      (cust && (cust.biz || cust.owner)) || '',
      (cust && cust.party_id) || null,
      cust ? cust.id : null,
      fields.amountRial,
      fields.note || '',
      fields.invoiceId || null,
      existing.id
    );
  } catch (e) {
    if (e && e.status) throw e;
  }
}

function resyncSettlementCommission(db, settlementId, snap, userId) {
  const {
    computeSettlementCommission, recordSettlementCommissionAccrual,
  } = require('./rep-ledger');
  const oldAcc = db.prepare(`
    SELECT * FROM rep_ledger
    WHERE ref_type='settlement' AND ref_id=? AND entry_type='commission_accrual'
    ORDER BY id DESC LIMIT 1
  `).get(settlementId);
  const inv = snap.invoiceId
    ? db.prepare('SELECT * FROM invoices WHERE id=?').get(snap.invoiceId)
    : null;
  const newAmt = inv
    ? Math.round(Number(computeSettlementCommission(db, { id: settlementId, amount: snap.amountRial, date: snap.date }, inv)) || 0)
    : 0;
  const same = !!(
    oldAcc && inv && newAmt > 0
    && Number(oldAcc.rep_id) === Number(inv.user_id)
    && Math.round(Number(oldAcc.credit) || 0) === newAmt
  );
  if (same) {
    db.prepare('UPDATE rep_ledger SET date=? WHERE id=?').run(snap.date || '', oldAcc.id);
    if (liveJe(db, 'commission_accrual_settlement', settlementId)) {
      const expense = acct(db, 'coa_rep_commission_expense');
      const payable = acct(db, 'coa_rep_commission_payable');
      rewriteJournalEntry(db, {
        sourceType: 'commission_accrual_settlement',
        sourceId: settlementId,
        date: snap.date || '',
        description: oldAcc.description || 'تعهد انگیزه وصول',
        lines: [
          { code: expense.code, name: expense.name, debit: rialToLedger(newAmt), credit: 0 },
          { code: payable.code, name: payable.name, debit: 0, credit: rialToLedger(newAmt) },
        ],
      });
    }
    return;
  }
  if (oldAcc) {
    const je = liveJe(db, 'commission_accrual_settlement', settlementId);
    if (je) {
      reverseJournalEntry(db, je.id, {
        userId,
        date: snap.date || '',
        reason: 'اصلاح تسویه',
      });
    }
    db.prepare(`
      UPDATE rep_ledger SET entry_type='commission_accrual_void'
      WHERE ref_type='settlement' AND ref_id=? AND entry_type='commission_accrual'
    `).run(settlementId);
  }
  if (inv && newAmt > 0) {
    recordSettlementCommissionAccrual(db, {
      id: settlementId, amount: snap.amountRial, date: snap.date || '',
    }, inv, userId);
  }
}

function refreshInvoiceBalances(db, prevId, nextId) {
  const ids = new Set([prevId, nextId].map((x) => parseInt(x, 10)).filter((x) => x > 0));
  for (const id of ids) recomputeInvoiceSettledBalances(db, id);
}

function refreshPurchaseInvoiceBalances(db, prevId, nextId) {
  const ids = new Set([prevId, nextId].map((x) => parseInt(x, 10)).filter((x) => x > 0));
  for (const id of ids) recomputePurchaseInvoiceSettledBalances(db, id);
}

function amendSettlement(db, id, body, userId) {
  const row = db.prepare('SELECT * FROM settlements WHERE id=?').get(id);
  if (!row) throw httpErr(404, 'تسویه یافت نشد', 'E_NOT_FOUND');
  if (row.status === 'reversed') throw httpErr(400, 'این تسویه قبلاً ابطال شده است', 'E_REVERSED');

  const origin = String(row.note || '');
  if (row.pay_type === 'pos_card' || origin.includes('کارتخوان') || origin.includes('هنگام فاکتور')) {
    throw httpErr(
      409,
      'این دریافت همراه فاکتور یا کارتخوان است. از ویرایش همان فاکتور اصلاحش کنید؛ اگر سند جدا می‌خواهید، این را ابطال و دوباره ثبت کنید.',
      'E_AMEND_ORIGIN'
    );
  }
  requireLiveJe(db, ['settlement'], row.id, 'دریافت');
  assertChequeEditable(db, row.id, row.cheque_status);

  const custId = parseInt(body.cust_id, 10);
  if (!custId) throw httpErr(400, 'مشتری الزامی است', 'E_CUST');
  const cust = db.prepare('SELECT id, biz, owner, party_id FROM customers WHERE id=?').get(custId);
  if (!cust) throw httpErr(400, 'مشتری یافت نشد', 'E_CUST');

  const payType = normalizePay(body.pay_type || row.pay_type, RECEIPT_PAY);
  const bankId = body.bank_id ? parseInt(body.bank_id, 10) : null;
  const cashBoxId = body.cash_box_id ? parseInt(body.cash_box_id, 10) : null;
  assertDest(payType, bankId, cashBoxId);
  if (payType === 'cash') assertActiveCashBox(db, cashBoxId);
  if (payType === 'bank' || payType === 'bank_transfer') assertActiveBank(db, bankId);

  const amountRial = Math.round(Number(body.amountRial != null ? body.amountRial : body.amount) || 0);
  if (amountRial <= 0) throw httpErr(400, 'مبلغ معتبر وارد کنید', 'E_AMOUNT');
  const date = String(body.date != null ? body.date : (row.date || ''));
  assertDatesWritable(db, row.date, date);

  const invoiceId = body.invoice_id ? parseInt(body.invoice_id, 10) : null;
  if (invoiceId) {
    const inv = db.prepare('SELECT id, cust_id, final, final_rial, COALESCE(deleted_at,0) AS deleted_at FROM invoices WHERE id=?').get(invoiceId);
    if (!inv || Number(inv.deleted_at) > 0) throw httpErr(400, 'فاکتور یافت نشد', 'E_INVOICE');
    if (Number(inv.cust_id) !== custId) throw httpErr(400, 'این فاکتور متعلق به مشتری انتخاب‌شده نیست', 'E_INVOICE_CUST');
    const others = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN COALESCE(amount_rial,0)<>0 THEN amount_rial ELSE ROUND(amount) END),0) s
      FROM settlements
      WHERE invoice_id=? AND id<>? AND COALESCE(status,'posted')<>'reversed'
    `).get(invoiceId, row.id).s;
    const cap = Math.round(Number(inv.final_rial) || Number(inv.final) || 0);
    if (cap > 0 && (Number(others) || 0) + amountRial - cap > 0.5) {
      throw httpErr(409, 'مبلغ از ماندهٔ قابل تخصیص این فاکتور بیشتر است', 'E_OVER_ALLOC');
    }
  }

  const cheque = payType === 'cheque';
  const chequeBank = cheque ? String(body.cheque_bank || '').trim() : '';
  const chequeSayadi = cheque ? String(body.cheque_sayadi || '').trim() : '';
  const chequeDue = cheque ? String(body.cheque_due || '').trim() : '';
  if (cheque && (!chequeBank || !digitsOnly(chequeSayadi) || !chequeDue)) {
    throw httpErr(400, 'برای چک، نام بانک، شناسه صیاد و تاریخ سررسید الزامی است', 'E_CHEQUE_FIELDS');
  }
  if (cheque) assertSayadiFree(db, chequeSayadi, row.id);

  const note = String(body.note != null ? body.note : (row.note || ''));
  const accountCode = String(body.account_code != null ? body.account_code : (row.account_code || '')).trim().slice(0, 32);
  const cash = cashAccount(db, payType, bankId, cashBoxId, accountCode);
  const recv = recvAcct(db, custId);
  const fxNote = body.foreign_amount && body.fx_rate_rial
    ? ` (${body.foreign_amount} ${body.currency || ''} × ${body.fx_rate_rial})`
    : '';
  const description = `تسویه ${payLabel(payType)} - ${amountRial.toLocaleString('fa-IR')} ریال${fxNote}`;

  db.prepare(`
    UPDATE settlements SET
      cust_id=?, invoice_id=?, amount=?, amount_rial=?, pay_type=?, date=?, note=?,
      bank_id=?, cash_box_id=?, check_category_id=?, account_code=?,
      cheque_bank=?, cheque_sayadi=?, cheque_number=?, cheque_account=?,
      cheque_amount=?, cheque_owner=?, cheque_due=?, cheque_branch=?, cheque_sheba=?,
      cheque_status=?,
      foreign_amount=?, fx_rate_rial=?, currency=?
    WHERE id=?
  `).run(
    custId, invoiceId, amountRial, amountRial, payType, date, note,
    bankId, cashBoxId, cheque ? (body.check_category_id || null) : null, accountCode,
    chequeBank, cheque ? digitsOnly(chequeSayadi) : '', cheque ? String(body.cheque_number || '') : '',
    cheque ? String(body.cheque_account || '') : '',
    cheque ? amountRial : 0, cheque ? String(body.cheque_owner || '') : '', chequeDue,
    cheque ? String(body.cheque_branch || '') : '', cheque ? normalizeSheba(body.cheque_sheba || '') : '',
    cheque ? (row.cheque_status || 'pending') : 'pending',
    body.foreign_amount || null, body.fx_rate_rial || null, body.currency || 'IRR',
    row.id
  );

  const ledRow = db.prepare(`
    SELECT id FROM customer_ledger
    WHERE ref_type='settlement' AND ref_id=? AND entry_type='settlement'
    ORDER BY id ASC LIMIT 1
  `).get(row.id);
  if (ledRow) {
    db.prepare(`
      UPDATE customer_ledger
      SET customer_id=?, date=?, description=?, debit=0, credit=?
      WHERE id=?
    `).run(custId, date, description, amountRial, ledRow.id);
  } else {
    createLedgerEntry(db, {
      customer_id: custId, date, entry_type: 'settlement',
      ref_type: 'settlement', ref_id: row.id,
      description, debit: 0, credit: amountRial, user_id: userId,
    });
  }

  const jeId = rewriteOrThrow(db, {
    sourceType: 'settlement', sourceId: row.id,
    date, description: `تسویه ${payLabel(payType)} مشتری${fxNote}`,
    lines: [
      { code: cash.code, name: cash.name, debit: rialToLedger(amountRial), credit: 0 },
      { code: recv.code, name: recv.name, debit: 0, credit: rialToLedger(amountRial) },
    ],
  });

  syncChequeRecords(db, row.id, cust, {
    payType, date, note, amountRial, invoiceId,
    cheque_sayadi: chequeSayadi, cheque_number: body.cheque_number, cheque_due: chequeDue,
    cheque_bank: chequeBank, cheque_branch: body.cheque_branch,
    cheque_sheba: normalizeSheba(body.cheque_sheba || ''), cheque_account: body.cheque_account,
  });
  resyncSettlementCommission(db, row.id, { invoiceId, amountRial, date }, userId);
  refreshInvoiceBalances(db, row.invoice_id, invoiceId);

  return {
    id: row.id,
    amount: amountRial,
    journal_id: jeId,
    summary: `اصلاح دریافت #${row.id}: ${Math.round(Number(row.amount) || 0)} → ${amountRial} ریال`,
  };
}

function assertPurchaseRoom(db, invoiceId, paymentId, supplierId, amount, extraTable) {
  if (!invoiceId) return;
  const inv = db.prepare('SELECT id, supplier_id, final FROM purchase_invoices WHERE id=?').get(invoiceId);
  if (!inv) throw httpErr(400, 'فاکتور خرید یافت نشد', 'E_PO');
  if (supplierId && Number(inv.supplier_id) !== Number(supplierId)) {
    throw httpErr(400, 'فاکتور خرید متعلق به این تأمین‌کننده نیست', 'E_PO_SUPPLIER');
  }
  const cap = Math.round(Number(inv.final) || 0);
  if (!cap) return;
  const returnsGross = sumLinkedPurchaseReturnsGrossRial(db, invoiceId);
  const room = Math.max(0, cap - returnsGross);
  const paidSup = db.prepare(`
    SELECT COALESCE(SUM(amount),0) s FROM supplier_payments
    WHERE purchase_invoice_id=? AND id<>? AND COALESCE(status,'posted')<>'reversed'
  `).get(invoiceId, extraTable === 'supplier' ? paymentId : 0).s;
  const paidExp = db.prepare(`
    SELECT COALESCE(SUM(amount),0) s FROM expense_payments
    WHERE purchase_invoice_id=? AND id<>? AND COALESCE(status,'posted')<>'reversed'
  `).get(invoiceId, extraTable === 'expense' ? paymentId : 0).s;
  if ((Number(paidSup) || 0) + (Number(paidExp) || 0) + amount - room > 0.5) {
    throw httpErr(409, 'مبلغ از ماندهٔ فاکتور خرید بیشتر است', 'E_OVER_ALLOC');
  }
}

function amendSupplierPayment(db, id, body, userId) {
  const row = db.prepare('SELECT * FROM supplier_payments WHERE id=?').get(id);
  if (!row) throw httpErr(404, 'پرداخت یافت نشد', 'E_NOT_FOUND');
  if (row.status === 'reversed') throw httpErr(400, 'این پرداخت قبلاً ابطال شده است', 'E_REVERSED');
  requireLiveJe(db, ['supplier_payment'], row.id, 'پرداخت');

  const supplierId = parseInt(body.supplier_id, 10);
  if (!supplierId) throw httpErr(400, 'تأمین‌کننده الزامی است', 'E_SUPPLIER');
  const sup = db.prepare('SELECT id, name FROM suppliers WHERE id=?').get(supplierId);
  if (!sup) throw httpErr(400, 'تأمین‌کننده یافت نشد', 'E_SUPPLIER');

  const payType = normalizePay(body.pay_type || row.pay_type, PAY_PAY);
  const bankId = body.bank_id ? parseInt(body.bank_id, 10) : null;
  const cashBoxId = body.cash_box_id ? parseInt(body.cash_box_id, 10) : null;
  assertDest(payType, bankId, cashBoxId);
  const amount = Math.round(Number(body.amount) || 0);
  if (amount <= 0) throw httpErr(400, 'مبلغ معتبر وارد کنید', 'E_AMOUNT');
  const fee = parseFeeRial(body.fee_rial != null ? body.fee_rial : row.fee_rial, payType);
  const date = String(body.date != null ? body.date : (row.date || ''));
  assertDatesWritable(db, row.date, date);
  const purchaseId = body.purchase_invoice_id ? parseInt(body.purchase_invoice_id, 10) : null;
  assertPurchaseRoom(db, purchaseId, row.id, supplierId, amount, 'supplier');

  const note = String(body.note != null ? body.note : (row.note || ''));
  const accountCode = String(body.account_code != null ? body.account_code : (row.account_code || '')).trim().slice(0, 32);
  const cash = cashAccount(db, payType, bankId, cashBoxId, accountCode);
  const payable = payableAcct(db, supplierId);
  const { lines } = outboundPaymentLines(db, {
    amount, feeRial: fee, payType, dest: payable, cash,
  });

  db.prepare(`
    UPDATE supplier_payments SET
      supplier_id=?, purchase_invoice_id=?, amount=?, fee_rial=?, pay_type=?, date=?, note=?,
      bank_id=?, check_category_id=?, cash_box_id=?, account_code=?
    WHERE id=?
  `).run(
    supplierId, purchaseId, amount, fee, payType, date, note,
    bankId, body.check_category_id || null, cashBoxId, accountCode, row.id
  );

  const description = `پرداخت به تأمین‌کننده — ${amount.toLocaleString('fa-IR')} ریال`;
  const ledRow = db.prepare(`
    SELECT id FROM supplier_ledger
    WHERE ref_type='supplier_payment' AND ref_id=? AND entry_type='payment'
    ORDER BY id ASC LIMIT 1
  `).get(row.id);
  if (ledRow) {
    db.prepare(`
      UPDATE supplier_ledger
      SET supplier_id=?, date=?, description=?, debit=?, credit=0
      WHERE id=?
    `).run(supplierId, date, description, amount, ledRow.id);
  } else {
    db.prepare(`
      INSERT INTO supplier_ledger (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(supplierId, date, 'payment', 'supplier_payment', row.id, description, amount, 0, userId || null);
  }

  const jeId = rewriteOrThrow(db, {
    sourceType: 'supplier_payment', sourceId: row.id,
    date, description: 'پرداخت به تأمین‌کننده', lines,
  });
  refreshPurchaseInvoiceBalances(db, row.purchase_invoice_id, purchaseId);
  return {
    id: row.id, amount, journal_id: jeId,
    summary: `اصلاح پرداخت تأمین‌کننده #${row.id}: ${Math.round(Number(row.amount) || 0)} → ${amount} ریال`,
  };
}

function unwindIncentiveSubledger(db, paymentId) {
  const rows = db.prepare(`
    SELECT * FROM rep_ledger
    WHERE ref_type='incentive_payment' AND ref_id=? AND entry_type='advance_settle'
  `).all(paymentId);
  for (const item of rows) {
    const match = String(item.description || '').match(/#(\d+)/);
    if (match) {
      db.prepare('UPDATE rep_advances SET settled_amount=MAX(0, COALESCE(settled_amount,0)-?) WHERE id=?')
        .run(item.credit || 0, Number(match[1]));
    }
  }
  db.prepare(`
    DELETE FROM rep_ledger
    WHERE ref_type='incentive_payment' AND ref_id=?
      AND entry_type IN ('commission_paid','advance_settle')
  `).run(paymentId);
}

function amendIncentivePayment(db, id, body, userId) {
  const row = db.prepare('SELECT * FROM incentive_payments WHERE id=?').get(id);
  if (!row) throw httpErr(404, 'پرداخت یافت نشد', 'E_NOT_FOUND');
  if (row.status === 'reversed') throw httpErr(400, 'این پرداخت قبلاً ابطال شده است', 'E_REVERSED');
  const jeTypes = ['incentive_payment', 'rep_settlement'].filter((t) => liveJe(db, t, row.id));
  if (!jeTypes.length) {
    throw httpErr(409, 'سند دفتر این پرداخت انگیزه پیدا نشد. سند را ابطال کنید و دوباره ثبت کنید.', 'E_NO_JE');
  }

  const repId = parseInt(body.rep_id, 10);
  if (!repId) throw httpErr(400, 'کارشناس الزامی است', 'E_REP');
  const rep = db.prepare('SELECT id, name FROM users WHERE id=?').get(repId);
  if (!rep) throw httpErr(400, 'کارشناس یافت نشد', 'E_REP');

  const payType = normalizePay(body.pay_type || row.pay_type, PAY_PAY);
  const bankId = body.bank_id ? parseInt(body.bank_id, 10) : null;
  const cashBoxId = body.cash_box_id ? parseInt(body.cash_box_id, 10) : null;
  assertDest(payType, bankId, cashBoxId);
  const amount = Math.round(Number(body.amount) || 0);
  if (amount <= 0) throw httpErr(400, 'مبلغ معتبر وارد کنید', 'E_AMOUNT');
  const fee = parseFeeRial(body.fee_rial != null ? body.fee_rial : row.fee_rial, payType);
  const date = String(body.date != null ? body.date : (row.date || ''));
  assertDatesWritable(db, row.date, date);
  const note = String(body.note != null ? body.note : (row.note || ''));

  const cash = cashAccount(db, payType, bankId, cashBoxId, '');
  const payable = acct(db, 'coa_rep_commission_payable');
  const { lines } = outboundPaymentLines(db, { amount, feeRial: fee, payType, dest: payable, cash });

  db.prepare(`
    UPDATE incentive_payments SET
      rep_id=?, amount=?, fee_rial=?, pay_type=?, date=?, note=?,
      bank_id=?, check_category_id=?, cash_box_id=?
    WHERE id=?
  `).run(repId, amount, fee, payType, date, note, bankId, body.check_category_id || null, cashBoxId, row.id);

  unwindIncentiveSubledger(db, row.id);
  const { recordIncentivePaymentLedger, settleAdvancesAgainstPayment } = require('./rep-ledger');
  recordIncentivePaymentLedger(db, {
    rep_id: repId, amount, date, payment_id: row.id, created_by: userId,
  });
  if (body.settle_advances !== false) {
    settleAdvancesAgainstPayment(db, repId, amount, row.id, userId);
  }
  const advSettled = db.prepare(`
    SELECT COALESCE(SUM(credit),0) s FROM rep_ledger
    WHERE ref_type='incentive_payment' AND ref_id=? AND entry_type='advance_settle'
  `).get(row.id).s;
  const snaps = db.prepare('SELECT id, balance_before FROM rep_settlements WHERE ref_payment_id=?').all(row.id);
  const updSnap = db.prepare(`
    UPDATE rep_settlements
    SET rep_id=?, date=?, commission_paid=?, advance_settled=?, total_amount=?, balance_after=?
    WHERE id=?
  `);
  for (const snap of snaps) {
    updSnap.run(
      repId, date, amount, Math.round(Number(advSettled) || 0), amount,
      Math.round((Number(snap.balance_before) || 0) - amount), snap.id
    );
  }

  let jeId = null;
  for (const refType of jeTypes) {
    jeId = rewriteOrThrow(db, {
      sourceType: refType, sourceId: row.id,
      date, description: `پرداخت انگیزه فروش به ${rep.name}`, lines,
    });
  }
  return {
    id: row.id, amount, journal_id: jeId,
    summary: `اصلاح پرداخت انگیزه #${row.id}: ${Math.round(Number(row.amount) || 0)} → ${amount} ریال`,
  };
}

function amendExpensePayment(db, id, body, userId) {
  const row = db.prepare('SELECT * FROM expense_payments WHERE id=?').get(id);
  if (!row) throw httpErr(404, 'پرداخت هزینه یافت نشد', 'E_NOT_FOUND');
  if (row.status === 'reversed') throw httpErr(400, 'این هزینه قبلاً ابطال شده است', 'E_REVERSED');
  requireLiveJe(db, ['expense_payment'], row.id, 'پرداخت هزینه');

  const { resolveExpensePosting } = require('../routes/expenses');
  const title = String(body.title != null ? body.title : (row.title || '')).trim();
  if (!title) throw httpErr(400, 'عنوان هزینه الزامی است', 'E_TITLE');
  const payType = normalizePay(body.pay_type || row.pay_type, PAY_PAY);
  const bankId = body.bank_id ? parseInt(body.bank_id, 10) : null;
  const cashBoxId = body.cash_box_id ? parseInt(body.cash_box_id, 10) : null;
  assertDest(payType, bankId, cashBoxId);
  const amount = Math.round(Number(body.amount) || 0);
  if (amount <= 0) throw httpErr(400, 'مبلغ معتبر وارد کنید', 'E_AMOUNT');
  const fee = parseFeeRial(body.fee_rial != null ? body.fee_rial : row.fee_rial, payType);
  const date = String(body.date != null ? body.date : (row.date || ''));
  assertDatesWritable(db, row.date, date);
  const purchaseId = body.purchase_invoice_id ? parseInt(body.purchase_invoice_id, 10) : null;
  assertPurchaseRoom(db, purchaseId, row.id, null, amount, 'expense');

  let posting;
  try {
    posting = resolveExpensePosting(db, {
      category: body.category != null ? body.category : row.category,
      account_code: body.account_code != null ? body.account_code : row.account_code,
      is_overhead: body.is_overhead != null ? body.is_overhead : row.is_overhead,
      cost_center_id: body.cost_center_id != null ? body.cost_center_id : row.cost_center_id,
      amount,
    });
  } catch (e) {
    throw httpErr(e.status || 400, e.message || 'حساب هزینه نامعتبر است', 'E_EXPENSE');
  }

  const note = String(body.note != null ? body.note : (row.note || ''));
  const cash = cashAccount(db, payType, bankId, cashBoxId, '');
  const { lines } = outboundPaymentLines(db, {
    amount, feeRial: fee, payType, dest: posting.account, cash, destDescription: title,
  });

  db.prepare(`
    UPDATE expense_payments SET
      category=?, title=?, amount=?, fee_rial=?, pay_type=?, bank_id=?, cash_box_id=?,
      check_category_id=?, cost_center_id=?, date=?, note=?, account_code=?,
      purchase_invoice_id=?, is_overhead=?
    WHERE id=?
  `).run(
    body.category != null ? body.category : (row.category || 'admin'),
    title, amount, fee, payType, bankId, cashBoxId,
    body.check_category_id || null, posting.costCenterId, date, note, posting.account.code,
    purchaseId, posting.isOverhead, row.id
  );

  const expSrc = posting.isOverhead || posting.section === 'production_overhead'
    ? 'production_overhead_actual'
    : 'expense_payment';
  const jeId = rewriteOrThrow(db, {
    sourceType: expSrc, sourceId: row.id,
    date, description: `پرداخت هزینه: ${title}`,
    costCenterId: posting.costCenterId, lines,
  });
  db.prepare('UPDATE journal_entries SET cost_center_id=? WHERE id=?')
    .run(posting.costCenterId, jeId);
  db.prepare('UPDATE expense_payments SET journal_entry_id=? WHERE id=?').run(jeId, row.id);

  refreshPurchaseInvoiceBalances(db, row.purchase_invoice_id, purchaseId);
  return {
    id: row.id, amount, journal_id: jeId,
    summary: `اصلاح هزینه #${row.id}: ${Math.round(Number(row.amount) || 0)} → ${amount} ریال`,
  };
}

/** Person COA leaf used on voucher lines (same as POST /vouchers person target). */
function personDestAccount(db, personId) {
  const person = db.prepare('SELECT * FROM persons WHERE id=?').get(personId);
  if (!person) throw httpErr(404, 'شخص یافت نشد', 'E_PERSON');
  let personAccount = null;
  if (person.coa_code) {
    personAccount = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(person.coa_code);
  }
  if (!personAccount && person.party_id) {
    const party = db.prepare('SELECT coa_code FROM parties WHERE id=?').get(person.party_id);
    if (party && party.coa_code) {
      personAccount = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(party.coa_code);
    }
  }
  if (!personAccount) personAccount = acct(db, 'coa_misc_persons');
  return { person, dest: personAccount };
}

/**
 * In-place amend of «پرداخت به شخص» voucher (JE ref_type=manual_voucher, self ref_id).
 * Keeps same journal id + voucher_number; rewrites GL + person_ledger.
 */
function amendPersonVoucherPayment(db, jeId, body, userId) {
  const id = Number(jeId);
  const entry = db.prepare(`
    SELECT * FROM journal_entries
    WHERE id=? AND COALESCE(deleted_at,0)=0 AND COALESCE(status,'posted') NOT IN ('reversed','void')
  `).get(id);
  if (!entry || entry.ref_type !== 'manual_voucher') {
    throw httpErr(404, 'پرداخت به شخص یافت نشد', 'E_NOT_FOUND');
  }
  // Self-stamped ref_id (create stamps ref_id=id)
  requireLiveJe(db, ['manual_voucher'], id, 'پرداخت به شخص');

  const { resolvePersonIdFromVoucherLine, ensurePersonForParty } = require('./party-turnover');
  const { createPersonLedgerEntry } = require('../db');
  const { retirePersonLedgerByRef } = require('./party-ledger-retire');

  let personId = resolvePersonIdFromVoucherLine(db, {
    person_id: body.person_id,
    party_id: body.party_id,
  });
  if (!personId && body.party_id) personId = ensurePersonForParty(db, body.party_id);
  if (!personId) {
    // Fall back to existing person on this voucher
    const prev = db.prepare(`
      SELECT person_id FROM person_ledger
      WHERE ref_type='manual_voucher' AND ref_id=? AND debit>0
      ORDER BY id LIMIT 1
    `).get(id);
    personId = prev && prev.person_id;
  }
  if (!personId) throw httpErr(400, 'شخص را انتخاب کنید', 'E_PERSON');

  const payType = normalizePay(body.pay_type || 'cash', PAY_PAY);
  const bankId = body.bank_id ? parseInt(body.bank_id, 10) : null;
  const cashBoxId = body.cash_box_id ? parseInt(body.cash_box_id, 10) : null;
  assertDest(payType, bankId, cashBoxId);
  if (bankId) assertActiveBank(db, bankId);
  if (cashBoxId) assertActiveCashBox(db, cashBoxId);

  const amount = Math.round(Number(body.amount) || 0);
  if (amount <= 0) throw httpErr(400, 'مبلغ معتبر وارد کنید', 'E_AMOUNT');
  const fee = parseFeeRial(body.fee_rial, payType);
  const date = String(body.date != null ? body.date : (entry.entry_date || ''));
  assertDatesWritable(db, entry.entry_date, date);
  const note = String(body.note != null ? body.note : (entry.description || 'پرداخت به شخص'));

  const { person, dest } = personDestAccount(db, personId);
  const cash = cashAccount(db, payType, bankId, cashBoxId, '');
  if (payType === 'bank' || payType === 'bank_transfer') {
    assertBankOverdraftOk(db, bankId, amount + fee);
  }
  const { lines } = outboundPaymentLines(db, {
    amount, feeRial: fee, payType, dest, cash, destDescription: 'پرداخت به شخص',
  });

  const jeOut = rewriteOrThrow(db, {
    sourceType: 'manual_voucher', sourceId: id,
    date, description: note || 'پرداخت به شخص', lines,
  });

  retirePersonLedgerByRef(db, {
    refTypes: ['manual_voucher', 'manual_voucher_reversal'],
    refId: id,
  });
  createPersonLedgerEntry(db, {
    person_id: person.id,
    date,
    entry_type: 'manual_voucher',
    ref_type: 'manual_voucher',
    ref_id: id,
    description: note || 'پرداخت به شخص',
    debit: amount,
    credit: 0,
    user_id: userId || null,
  });

  return {
    id,
    amount,
    journal_id: jeOut,
    summary: `اصلاح پرداخت به شخص #${id}: → ${amount} ریال (${person.name || ''})`,
  };
}

/**
 * In-place amend of «پرداخت به حساب» (JE ref_type=account_payment).
 * Avoids requiring routes/accounting (circular); mirrors party books locally.
 */
function amendAccountPayment(db, jeId, body, userId) {
  const id = Number(jeId);
  const entry = db.prepare(`
    SELECT * FROM journal_entries
    WHERE id=? AND COALESCE(deleted_at,0)=0 AND COALESCE(status,'posted') NOT IN ('reversed','void')
  `).get(id);
  if (!entry || entry.ref_type !== 'account_payment') {
    throw httpErr(404, 'پرداخت به حساب یافت نشد', 'E_NOT_FOUND');
  }
  requireLiveJe(db, ['account_payment'], id, 'پرداخت به حساب');

  const code = String(body.account_code || '').trim();
  if (!code) throw httpErr(400, 'حساب مقصد الزامی است', 'E_COA');
  const dest = db.prepare('SELECT code,name,is_active FROM chart_of_accounts WHERE code=?').get(code);
  if (!dest || dest.is_active === 0) throw httpErr(400, 'حساب مقصد معتبر نیست', 'E_COA');

  const payType = normalizePay(body.pay_type || 'cash', PAY_PAY);
  const bankId = body.bank_id ? parseInt(body.bank_id, 10) : null;
  const cashBoxId = body.cash_box_id ? parseInt(body.cash_box_id, 10) : null;
  assertDest(payType, bankId, cashBoxId);
  if (bankId) assertActiveBank(db, bankId);
  if (cashBoxId) assertActiveCashBox(db, cashBoxId);

  const amount = Math.round(Number(body.amount) || 0);
  if (amount <= 0) throw httpErr(400, 'مبلغ معتبر وارد کنید', 'E_AMOUNT');
  const fee = parseFeeRial(body.fee_rial, payType);
  const date = String(body.date != null ? body.date : (entry.entry_date || ''));
  assertDatesWritable(db, entry.entry_date, date);
  const note = String(body.note != null ? body.note : (entry.description || `پرداخت به حساب ${dest.code}`));

  const cash = cashAccount(db, payType, bankId, cashBoxId, '');
  if (payType === 'bank' || payType === 'bank_transfer') {
    assertBankOverdraftOk(db, bankId, amount + fee);
  }
  const { lines } = outboundPaymentLines(db, {
    amount, feeRial: fee, payType, dest, cash,
    destDescription: note || `پرداخت به حساب ${dest.code}`,
  });

  const jeOut = rewriteOrThrow(db, {
    sourceType: 'account_payment', sourceId: id,
    date, description: note || `پرداخت به حساب ${dest.code} — ${dest.name}`, lines,
  });

  const {
    retirePersonLedgerByRef, retireCustomerLedgerByRef,
  } = require('./party-ledger-retire');
  const { createPersonLedgerEntry, createLedgerEntry } = require('../db');
  retirePersonLedgerByRef(db, {
    refTypes: ['account_payment', 'account_payment_reversal'],
    refId: id,
  });
  retireCustomerLedgerByRef(db, {
    refTypes: ['account_payment', 'account_payment_reversal'],
    refId: id,
  });

  const cust = db.prepare('SELECT id FROM customers WHERE coa_code=? ORDER BY id LIMIT 1').get(dest.code);
  if (cust) {
    createLedgerEntry(db, {
      customer_id: cust.id, date, entry_type: 'journal',
      ref_type: 'account_payment', ref_id: id,
      description: note || 'پرداخت به حساب مشتری',
      debit: amount, credit: 0, user_id: userId || null,
    });
  } else {
    let person = db.prepare('SELECT id FROM persons WHERE coa_code=? ORDER BY id LIMIT 1').get(dest.code);
    if (!person) {
      const party = db.prepare('SELECT id FROM parties WHERE coa_code=? LIMIT 1').get(dest.code);
      if (party) {
        try {
          const { ensurePersonForParty } = require('./party-turnover');
          const pid = ensurePersonForParty(db, party.id);
          if (pid) person = { id: pid };
        } catch (_) { /* optional */ }
      }
    }
    if (person) {
      createPersonLedgerEntry(db, {
        person_id: person.id, date,
        entry_type: 'account_payment', ref_type: 'account_payment', ref_id: id,
        description: note || 'پرداخت به شخص',
        debit: amount, credit: 0, user_id: userId || null,
      });
    }
  }

  return {
    id,
    amount,
    journal_id: jeOut,
    summary: `اصلاح پرداخت به حساب #${id}: → ${amount} ریال (${dest.code})`,
  };
}

module.exports = {
  amendSettlement,
  amendSupplierPayment,
  amendIncentivePayment,
  amendExpensePayment,
  amendPersonVoucherPayment,
  amendAccountPayment,
};
