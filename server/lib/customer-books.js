/**
 * Customer AR books: invoice always hits customer tafsili + customer_ledger.
 * Immediate-pay invoices also post the cash/bank pair (Dr cash / Cr AR).
 * Repair brings historical cash invoices and 1103-control openings into line.
 */
'use strict';

const { acct } = require('./coa-map');
const { postToLedger } = require('./ledger');
const { rialToLedger, SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('./money');
const {
  firmSaleTypeSql, invoiceTypeLabel, isFirmSale, autoApproveNormalInvoice,
  normalizeFreightType, freightChargedToCounterparty,
} = require('./sales-document');

// Cheque is اسناد دریافتنی until cleared — never cash/bank on the sale voucher.
const IMMEDIATE_PAY = new Set(['cash', 'bank', 'bank_transfer']);
const JE_NOT_DELETED = `COALESCE(je.deleted_at,0)=0`;
const JE_HAS_PAIR_REVERSE = `EXISTS (
  SELECT 1 FROM journal_entries _rev
  WHERE COALESCE(_rev.deleted_at,0)=0
    AND _rev.description LIKE ('ابطال سند #' || je.id || '%')
)`;
const JE_BALANCE = `${JE_NOT_DELETED} AND (
  COALESCE(je.status,'posted') NOT IN ('reversed','void')
  OR ${JE_HAS_PAIR_REVERSE}
)`;
const JE_ALIVE = `${JE_NOT_DELETED} AND COALESCE(je.status,'posted') NOT IN ('reversed','void')`;
const ENTRY_ALIVE = `COALESCE(deleted_at,0)=0 AND COALESCE(status,'posted') NOT IN ('reversed','void')`;
const REPAIR_FLAG = 'customer_books_repair_v1';
const REPAIR_FLAG_V2 = 'customer_books_repair_v2';
/** Legacy one-shot flag (v1). v374 hollow-purge deleted corrective debits and left credits; heal is continuous from v376. */
const REPAIR_FLAG_OPENING_CHEQUE = 'opening_cheque_ledger_mirror_v1';
const REPAIR_FLAG_OPENING_CHEQUE_V2 = 'opening_cheque_ledger_mirror_v2';
const AR_CONTROL_RECLASS = 'ar_control_reclass';
const OPENING_CHEQUE_NOTE_SQL = `(IFNULL(cr.note,'') LIKE '%مانده اول دوره%' OR IFNULL(cr.status,'') LIKE '%اول دوره%')`;

/**
 * SQL: customer_ledger alias is operationally live (aligns with hideVoidedBookRows +
 * opening-cheque policy — opening receipt is notes/equity, never a customer creditor).
 */
function sqlCustomerLedgerLive(alias) {
  const a = alias || 'cl';
  return `
    NOT (
      (COALESCE(${a}.entry_type,'')='reversal' OR ${a}.ref_type LIKE '%reversal%')
      AND NOT (
        ${a}.ref_type='sales_return'
        AND EXISTS (
          SELECT 1 FROM sales_returns _sr
          WHERE _sr.id=${a}.ref_id AND COALESCE(_sr.status,'posted')<>'reversed'
        )
      )
    )
    AND NOT (
      ${a}.ref_type='settlement' AND EXISTS (
        SELECT 1 FROM settlements _s
        WHERE _s.id=${a}.ref_id AND COALESCE(_s.status,'posted')='reversed'
      )
    )
    AND NOT (
      ${a}.ref_type IN ('cheque','cheque_in','cheque_endorse','cheque_clear','cheque_bounce')
      AND EXISTS (
        SELECT 1 FROM cheque_records cr WHERE cr.id=${a}.ref_id
          AND (
            COALESCE(cr.record_status,'posted')='reversed'
            OR ${OPENING_CHEQUE_NOTE_SQL}
          )
      )
    )
    AND NOT (
      ${a}.ref_type IN ('sales_return','sales_return_reversal') AND EXISTS (
        SELECT 1 FROM sales_returns _sr
        WHERE _sr.id=${a}.ref_id AND COALESCE(_sr.status,'posted')='reversed'
      )
    )
    AND NOT (
      ${a}.ref_type='pos_receipt' AND EXISTS (
        SELECT 1 FROM pos_receipts _pr
        WHERE _pr.id=${a}.ref_id AND COALESCE(_pr.status,'open') IN ('reversed','void')
      )
    )
    AND NOT (
      ${a}.ref_type IN ('invoice','invoice_payment','invoice_ar_reclass') AND EXISTS (
        SELECT 1 FROM invoices _i WHERE _i.id=${a}.ref_id
          AND (
            COALESCE(_i.status,'') IN ('reversed','void','cancelled')
            OR COALESCE(_i.deleted_at,0)>0
          )
      )
    )
  `;
}

const STMT_REF_ALIAS = {
  invoice_ar_reclass: 'invoice',
  invoice_payment: 'invoice',
  cheque_endorse: 'cheque',
  cheque_in: 'cheque',
  cheque_clear: 'cheque',
  cheque_bounce: 'cheque_bounce',
  cheque: 'cheque',
  opening_ledger: 'opening',
  opening_reclass: 'opening',
  opening_balance: 'opening',
  opening_cheque: 'opening',
  [AR_CONTROL_RECLASS]: 'reversal',
};

function normalizeStmtRefType(refType) {
  const t = String(refType || '');
  if (STMT_REF_ALIAS[t]) return STMT_REF_ALIAS[t];
  if (t.includes('reversal') || t.endsWith('_void') || t.endsWith('_cancel')) return 'reversal';
  return t;
}

function stmtEntryType(refType, normalized) {
  const raw = String(refType || '');
  if (raw === 'invoice_payment') return 'settlement';
  if (raw === 'sales_return') return 'sales_return';
  if (raw === 'pos_receipt') return 'settlement';
  // Keep the instrument. Collapsing every cheque ref into "cheque" made a
  // receipt and an opening-cheque correction look like an endorsement.
  if (raw === 'cheque_in') return 'cheque_in';
  if (raw === 'cheque_endorse') return 'cheque_endorse';
  if (raw === 'cheque_clear') return 'cheque_clear';
  if (raw === 'cheque_bounce') return 'cheque_bounce';
  const n = normalized || normalizeStmtRefType(refType);
  if (n === 'invoice') return 'invoice';
  if (n === 'invoice_payment' || n === 'settlement') return 'settlement';
  if (n === 'sales_return') return 'sales_return';
  if (n === 'cheque_bounce') return 'cheque_bounce';
  if (n === 'cheque_in' || n === 'cheque') return 'cheque_in';
  if (n === 'cheque_endorse') return 'cheque_endorse';
  if (n === 'cheque_clear') return 'cheque_clear';
  if (n === 'opening') return 'opening';
  if (n === 'reversal') return 'reversal';
  if (raw.includes('reversal')) return 'reversal';
  return n || 'journal';
}

const CHEQUE_BOOK_REFS = new Set([
  'cheque', 'cheque_in', 'cheque_endorse', 'cheque_clear', 'cheque_bounce',
]);

/**
 * Operational statement omits a voided document and its hollow reverse lines.
 * GL stays soft-voided (v285/R12); party books show only the final live state (v373).
 * Matches ERPNext «hide cancelled entries» on statements.
 */
function hideVoidedBookRows(db, rows) {
  let reversedCheques = new Set();
  let openingCheques = new Set();
  let reversedSettlements = new Set();
  let reversedSalesReturns = new Set();
  let reversedPosReceipts = new Set();
  let reversedInvoices = new Set();
  try {
    reversedCheques = new Set(
      db.prepare(`
        SELECT id FROM cheque_records
        WHERE COALESCE(record_status,'posted')='reversed'
      `).all().map((r) => Number(r.id))
    );
  } catch (_) { /* table optional on ancient DBs */ }
  try {
    openingCheques = new Set(
      db.prepare(`
        SELECT id FROM cheque_records cr
        WHERE ${OPENING_CHEQUE_NOTE_SQL}
      `).all().map((r) => Number(r.id))
    );
  } catch (_) { /* optional */ }
  try {
    reversedSettlements = new Set(
      db.prepare(`
        SELECT id FROM settlements
        WHERE COALESCE(status,'posted')='reversed'
      `).all().map((r) => Number(r.id))
    );
  } catch (_) { /* optional */ }
  try {
    reversedSalesReturns = new Set(
      db.prepare(`
        SELECT id FROM sales_returns
        WHERE COALESCE(status,'posted')='reversed'
      `).all().map((r) => Number(r.id))
    );
  } catch (_) { /* optional */ }
  try {
    reversedPosReceipts = new Set(
      db.prepare(`
        SELECT id FROM pos_receipts
        WHERE COALESCE(status,'open') IN ('reversed','void')
      `).all().map((r) => Number(r.id))
    );
  } catch (_) { /* optional */ }
  try {
    reversedInvoices = new Set(
      db.prepare(`
        SELECT id FROM invoices
        WHERE COALESCE(status,'') IN ('reversed','void','cancelled')
           OR COALESCE(deleted_at,0)>0
      `).all().map((r) => Number(r.id))
    );
  } catch (_) {
    try {
      reversedInvoices = new Set(
        db.prepare(`
          SELECT id FROM invoices WHERE COALESCE(deleted_at,0)>0
        `).all().map((r) => Number(r.id))
      );
    } catch (__) { /* optional */ }
  }
  return (rows || []).filter((e) => {
    const refId = Number(e.ref_id);
    const rt = String(e.ref_type || '');
    const et = String(e.entry_type || '');
    if (CHEQUE_BOOK_REFS.has(rt) && reversedCheques.has(refId)) return false;
    // Opening cheque = notes/equity JE only — never a live customer receipt credit.
    if (rt === 'cheque_in' && openingCheques.has(refId)) return false;
    if (rt === 'settlement' && reversedSettlements.has(refId)) return false;
    if ((rt === 'sales_return' || rt === 'sales_return_reversal') && reversedSalesReturns.has(refId)) {
      return false;
    }
    if (rt === 'pos_receipt' && reversedPosReceipts.has(refId)) return false;
    if ((rt === 'invoice' || rt === 'invoice_payment' || rt === 'invoice_ar_reclass')
      && reversedInvoices.has(refId)) {
      return false;
    }
    // Hollow reverse lines (legacy) — never show on operational statement
    if (et === 'reversal' || rt.endsWith('_reversal') || rt.includes('reversal')) {
      // Live sales_return was mis-tagged as entry_type=reversal before v373 —
      // keep it if the return is still posted.
      if (rt === 'sales_return' && !reversedSalesReturns.has(refId)) return true;
      return false;
    }
    return true;
  });
}

function isImmediatePay(payType) {
  return IMMEDIATE_PAY.has(String(payType || 'cash'));
}

function sumJournalSides(lines) {
  let debit = 0;
  let credit = 0;
  for (const l of lines || []) {
    debit += Number(l.debit) || 0;
    credit += Number(l.credit) || 0;
  }
  return { debit, credit, ok: Math.abs(debit - credit) <= 0.05 };
}

function assertJournalLinesBalanced(lines, context) {
  const s = sumJournalSides(lines);
  if (s.ok) return lines;
  const err = new Error(
    `سند تراز نیست (بدهکار ${s.debit} ≠ بستانکار ${s.credit})` + (context ? ` — ${context}` : '')
  );
  err.status = 409;
  err.code = 'E_JE_UNBALANCED';
  err.debit = s.debit;
  err.credit = s.credit;
  throw err;
}

function receivableAcct(db, custId) {
  const c = custId ? db.prepare('SELECT coa_code FROM customers WHERE id=?').get(custId) : null;
  if (c && c.coa_code) {
    const a = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(c.coa_code);
    if (a) return a;
  }
  return acct(db, 'coa_receivable');
}

function cashAcct(db, payType, bankId, cashBoxId) {
  const { resolveCashAccount } = require('../db');
  return resolveCashAccount(db, payType === 'bank_transfer' ? 'bank' : payType, bankId, cashBoxId);
}

/**
 * Firm-sale journal lines. AR is always the customer tafsili (never skipped for cash).
 * Immediate pay adds Dr cash / Cr AR so the sale still appears on the customer statement.
 */
function salesJournalLines(db, custId, totals, reverse, opts = {}) {
  const payType = opts.payType || 'credit';
  const bankId = opts.bankId || null;
  const cashBoxId = opts.cashBoxId || null;
  const recv = receivableAcct(db, custId);
  const cash = isImmediatePay(payType) ? cashAcct(db, payType, bankId, cashBoxId) : null;
  const sales = acct(db, 'coa_sales');
  const salesDisc = acct(db, 'coa_sales_discount');
  const vatPay = acct(db, 'coa_vat_payable');
  const otherIncome = (() => { try { return acct(db, 'coa_other_income'); } catch { return sales; } })();
  const discAmt = Math.round(Number(totals.discAmt) || 0);
  const vatAmount = Math.round(Number(totals.vatAmount) || 0);
  const L = rialToLedger;
  const freightRial = Math.round(Number(opts.freightRial != null ? opts.freightRial : opts.freight_amount) || 0);
  const freightType = normalizeFreightType(opts.freightType || opts.freight_type);
  const freightToParty = freightChargedToCounterparty(freightType) && freightRial > 0;
  const freightSeller = freightType === 'seller' && freightRial > 0;
  const final = Math.round(Number(totals.final) || 0);
  const netBeforeVat = Math.round(Number(totals.netBeforeVat) || 0);
  const goodsNet = Math.max(0, netBeforeVat - (freightToParty ? freightRial : 0));


  let incomeCredit = 0;
  const incomeBuckets = new Map();
  for (const r of opts.rows || []) {
    if (r.row_type === 'income') {
      const code = r.income_coa || otherIncome.code;
      const name = r.name || otherIncome.name;
      const amt = Math.round(Number(r.sum) || 0);
      incomeCredit += amt;
      const prev = incomeBuckets.get(code) || { code, name, amt: 0 };
      prev.amt += amt;
      incomeBuckets.set(code, prev);
    }
  }
  // Header discount is a separate debit. Credit GROSS goods (net + discount)
  // or the journal is short on the credit side by discAmt ("سند تراز نیست").
  const productCredit = Math.max(0, goodsNet + discAmt - incomeCredit);
  const freightInc = otherIncome;
  const freightExp = (() => { try { return acct(db, 'coa_sales_expense'); } catch { return salesDisc; } })();
  const freightPay = (() => { try { return acct(db, 'coa_payable'); } catch { return recv; } })();

  function freightLines(rev) {
    const out = [];
    if (freightToParty) {
      out.push({
        code: freightInc.code, name: freightInc.name,
        debit: rev ? L(freightRial) : 0,
        credit: rev ? 0 : L(freightRial),
        description: rev ? 'ابطال کرایه عهده خریدار' : 'کرایه حمل عهده خریدار',
      });
    } else if (freightSeller) {
      out.push({
        code: freightExp.code, name: freightExp.name,
        debit: rev ? 0 : L(freightRial),
        credit: rev ? L(freightRial) : 0,
        description: rev ? 'ابطال هزینه کرایه عهده فروشنده' : 'هزینه کرایه عهده فروشنده',
      });
      out.push({
        code: freightPay.code, name: freightPay.name,
        debit: rev ? L(freightRial) : 0,
        credit: rev ? 0 : L(freightRial),
        description: rev ? 'ابطال بدهی کرایه عهده فروشنده' : 'بدهی کرایه عهده فروشنده',
      });
    }
    return out;
  }

  if (!reverse) {
    const jLines = [{ code: recv.code, name: recv.name, debit: L(final), credit: 0 }];
    if (discAmt > 0) jLines.push({ code: salesDisc.code, name: salesDisc.name, debit: L(discAmt), credit: 0, description: 'تخفیف فاکتور' });
    if (productCredit > 0) jLines.push({ code: sales.code, name: sales.name, debit: 0, credit: L(productCredit) });
    for (const b of incomeBuckets.values()) {
      if (b.amt > 0) jLines.push({ code: b.code, name: b.name, debit: 0, credit: L(b.amt), description: 'درآمد/خدمات' });
    }
    jLines.push(...freightLines(false));
    if (vatAmount > 0) jLines.push({ code: vatPay.code, name: vatPay.name, debit: 0, credit: L(vatAmount), description: 'مالیات بر ارزش افزوده' });
    if (cash && Number(final) > 0) {
      jLines.push({ code: cash.code, name: cash.name, debit: L(final), credit: 0, description: 'دریافت هنگام فاکتور' });
      jLines.push({ code: recv.code, name: recv.name, debit: 0, credit: L(final), description: 'تسویه هنگام فاکتور' });
    }
    return assertJournalLinesBalanced(jLines, 'فاکتور فروش');
  }

  const jLines = [];
  if (cash && Number(final) > 0) {
    jLines.push({ code: recv.code, name: recv.name, debit: L(final), credit: 0, description: 'ابطال تسویه هنگام فاکتور' });
    jLines.push({ code: cash.code, name: cash.name, debit: 0, credit: L(final), description: 'ابطال دریافت هنگام فاکتور' });
  }
  if (productCredit > 0) jLines.push({ code: sales.code, name: sales.name, debit: L(productCredit), credit: 0, description: 'ابطال' });
  for (const b of incomeBuckets.values()) {
    if (b.amt > 0) jLines.push({ code: b.code, name: b.name, debit: L(b.amt), credit: 0, description: 'ابطال درآمد' });
  }
  jLines.push(...freightLines(true));
  if (vatAmount > 0) jLines.push({ code: vatPay.code, name: vatPay.name, debit: L(vatAmount), credit: 0, description: 'ابطال VAT' });
  if (discAmt > 0) jLines.push({ code: salesDisc.code, name: salesDisc.name, debit: 0, credit: L(discAmt), description: 'ابطال تخفیف' });
  jLines.push({ code: recv.code, name: recv.name, debit: 0, credit: L(final) });
  return assertJournalLinesBalanced(jLines, 'ابطال فاکتور فروش');
}

function postInvoiceCustomerLedger(db, {
  customerId, date, invId, num, invType, final, userId, payType, skipImmediatePayment,
}) {
  const { createLedgerEntry } = require('../db');
  const exists = db.prepare(
    "SELECT 1 FROM customer_ledger WHERE ref_type='invoice' AND ref_id=? AND entry_type IN ('invoice','reversal') LIMIT 1"
  ).get(invId);
  if (!exists) {
    createLedgerEntry(db, {
      customer_id: customerId, date: date || '', entry_type: 'invoice',
      ref_type: 'invoice', ref_id: invId,
      description: `${invoiceTypeLabel(invType)} ${num}`,
      debit: final, credit: 0, user_id: userId,
    });
  }
  if (!isImmediatePay(payType) || skipImmediatePayment) return;
  const payExists = db.prepare(
    "SELECT 1 FROM customer_ledger WHERE ref_type='invoice_payment' AND ref_id=? LIMIT 1"
  ).get(invId);
  const settExists = db.prepare(
    "SELECT 1 FROM settlements WHERE invoice_id=? AND COALESCE(status,'posted')<>'reversed' LIMIT 1"
  ).get(invId);
  if (payExists || settExists) return;
  createLedgerEntry(db, {
    customer_id: customerId, date: date || '', entry_type: 'settlement',
    ref_type: 'invoice_payment', ref_id: invId,
    description: `دریافت هنگام فاکتور ${num}`,
    debit: 0, credit: final, user_id: userId,
  });
}

/**
 * In-place amend of the invoice customer_ledger row (same id).
 * Never inserts entry_type='reversal'. Immediate-pay rows are updated or zeroed.
 */
function updateInvoiceCustomerLedger(db, {
  customerId, date, invId, num, invType, final, userId, payType, skipImmediatePayment,
}) {
  const desc = `${invoiceTypeLabel(invType)} ${num}`;
  const invRow = db.prepare(
    "SELECT id FROM customer_ledger WHERE ref_type='invoice' AND ref_id=? AND entry_type='invoice' LIMIT 1"
  ).get(invId);
  if (invRow) {
    db.prepare(`
      UPDATE customer_ledger
      SET customer_id=?, date=?, description=?, debit=?, credit=0
      WHERE id=?
    `).run(customerId, date || '', desc, final, invRow.id);
  } else {
    postInvoiceCustomerLedger(db, {
      customerId, date, invId, num, invType, final, userId,
      payType: 'credit', skipImmediatePayment: true,
    });
  }

  const payRow = db.prepare(
    "SELECT id FROM customer_ledger WHERE ref_type='invoice_payment' AND ref_id=? LIMIT 1"
  ).get(invId);

  if (isImmediatePay(payType) && !skipImmediatePayment) {
    if (payRow) {
      db.prepare(`
        UPDATE customer_ledger
        SET customer_id=?, date=?, description=?, debit=0, credit=?
        WHERE id=?
      `).run(customerId, date || '', `دریافت هنگام فاکتور ${num}`, final, payRow.id);
    } else {
      postInvoiceCustomerLedger(db, {
        customerId, date, invId, num, invType, final, userId, payType,
        skipImmediatePayment: false,
      });
    }
  } else if (payRow) {
    db.prepare(`
      UPDATE customer_ledger
      SET customer_id=?, date=?, description=?, debit=0, credit=0
      WHERE id=?
    `).run(customerId, date || '', '—', payRow.id);
  }
}

function reverseInvoiceCustomerLedger(db, inv, userId, date) {
  // v373: retire subledger rows — no hollow «ابطال/اصلاح» lines on the statement.
  void userId; void date;
  const { retireCustomerLedgerByRef } = require('./party-ledger-retire');
  retireCustomerLedgerByRef(db, {
    refTypes: ['invoice', 'invoice_payment', 'invoice_ar_reclass'],
    refId: inv.id,
    customerId: inv.cust_id,
  });
}

function invoiceJeHitsCustomerAr(db, inv) {
  const recv = receivableAcct(db, inv.cust_id);
  const row = db.prepare(`
    SELECT 1 AS ok
    FROM journal_lines jl
    JOIN journal_entries je ON jl.entry_id=je.id
    WHERE je.ref_type='invoice' AND je.ref_id=?
      AND jl.account_code=?
      AND ${JE_ALIVE}
    LIMIT 1
  `).get(inv.id, recv.code);
  return !!row;
}

function findInvoiceCashLine(db, inv) {
  return db.prepare(`
    SELECT jl.account_code, jl.debit_rial, jl.credit_rial, je.id AS je_id
    FROM journal_lines jl
    JOIN journal_entries je ON jl.entry_id=je.id
    WHERE je.ref_type='invoice' AND je.ref_id=?
      AND ${JE_ALIVE}
      AND COALESCE(NULLIF(jl.debit_rial,0), ROUND(jl.debit), 0) > 0
      AND jl.account_code NOT LIKE '41%'
      AND jl.account_code NOT LIKE '21%'
    ORDER BY jl.id
    LIMIT 1
  `).get(inv.id);
}

function parsePartyRoles(party) {
  let roles = [];
  try {
    roles = typeof party?.party_roles === 'string'
      ? JSON.parse(party.party_roles || '[]')
      : (party?.party_roles || []);
  } catch (_) { roles = []; }
  if (!roles.length && party?.party_type) {
    if (party.party_type === 'both') roles = ['customer', 'supplier'];
    else roles = [party.party_type];
  }
  return Array.isArray(roles) ? roles : [];
}

function resolveOpeningDestAccount(db, partyId) {
  const recv = acct(db, 'coa_receivable');
  let misc;
  try { misc = acct(db, 'coa_misc_persons'); } catch (_) { misc = recv; }
  const party = partyId ? db.prepare('SELECT * FROM parties WHERE id=?').get(partyId) : null;
  if (party?.legacy_table === 'customers' && party.legacy_id) {
    const c = db.prepare('SELECT coa_code FROM customers WHERE id=?').get(party.legacy_id);
    if (c?.coa_code && c.coa_code !== recv.code) {
      const a = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(c.coa_code);
      if (a) return a;
    }
  }
  if (party?.coa_code && party.coa_code !== recv.code) {
    const a = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(party.coa_code);
    if (a) return a;
  }
  const roles = parsePartyRoles(party || {});
  if (!roles.includes('customer')) return misc;
  return null;
}

function repairOpeningControlToTafsili(db) {
  const recv = acct(db, 'coa_receivable');
  const rows = db.prepare(`
    SELECT je.id, je.ref_id, je.entry_date, je.created_by,
           COALESCE(NULLIF(jl.debit_rial,0), ROUND(jl.debit), 0) AS debit_rial,
           COALESCE(NULLIF(jl.credit_rial,0), ROUND(jl.credit), 0) AS credit_rial
    FROM journal_entries je
    JOIN journal_lines jl ON jl.entry_id=je.id
    WHERE je.ref_type='opening_balance'
      AND jl.account_code=?
      AND ${JE_ALIVE}
  `).all(recv.code);
  let n = 0;
  for (const row of rows) {
    const already = db.prepare(`
      SELECT 1 FROM journal_entries
      WHERE ref_type='opening_reclass' AND ref_id=? AND ${ENTRY_ALIVE}
      LIMIT 1
    `).get(row.id);
    if (already) continue;
    const dest = resolveOpeningDestAccount(db, row.ref_id);
    if (!dest || dest.code === recv.code) continue;
    const net = Math.round(Number(row.debit_rial) || 0) - Math.round(Number(row.credit_rial) || 0);
    if (!net) continue;
    const abs = Math.abs(net);
    postToLedger(db, {
      sourceType: 'opening_reclass',
      sourceId: row.id,
      date: row.entry_date || '',
      description: `انتقال مانده افتتاحیه از ${recv.code} به ${dest.code}`,
      createdBy: row.created_by || null,
      voucherType: 'opening',
      lines: net > 0
        ? [
          { code: dest.code, name: dest.name, debit: rialToLedger(abs), credit: 0 },
          { code: recv.code, name: recv.name, debit: 0, credit: rialToLedger(abs) },
        ]
        : [
          { code: recv.code, name: recv.name, debit: rialToLedger(abs), credit: 0 },
          { code: dest.code, name: dest.name, debit: 0, credit: rialToLedger(abs) },
        ],
    });
    n++;
  }
  return n;
}

function repairLedgerOpeningsToGl(db) {
  let isDeviceFn = () => false;
  try { isDeviceFn = require('../db').isDevice; } catch (_) {}
  if (typeof isDeviceFn === 'function' && isDeviceFn()) return 0;
  const opening = acct(db, 'coa_opening_balance');
  const rows = db.prepare(`
    SELECT cl.customer_id, cl.date, cl.debit, cl.credit, cl.user_id, c.coa_code
    FROM customer_ledger cl
    JOIN customers c ON c.id=cl.customer_id
    WHERE cl.ref_type='opening' AND c.coa_code IS NOT NULL AND c.coa_code<>''
  `).all();
  let n = 0;
  for (const o of rows) {
    const already = db.prepare(`
      SELECT 1 FROM journal_entries
      WHERE ${ENTRY_ALIVE}
        AND (
          (ref_type='opening_ledger' AND ref_id=?)
          OR (ref_type IN ('opening_balance','opening_reclass') AND EXISTS (
            SELECT 1 FROM journal_lines jl
            WHERE jl.entry_id=journal_entries.id AND jl.account_code=?
          ))
        )
      LIMIT 1
    `).get(o.customer_id, o.coa_code);
    if (already) continue;
    const dest = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(o.coa_code);
    if (!dest) continue;
    const net = Math.round(Number(o.debit) || 0) - Math.round(Number(o.credit) || 0);
    if (!net) continue;
    const abs = Math.abs(net);
    postToLedger(db, {
      sourceType: 'opening_ledger',
      sourceId: o.customer_id,
      date: o.date || '',
      description: 'مانده اولیه حساب (هم‌تراز دفتر مشتری)',
      createdBy: o.user_id || null,
      voucherType: 'opening',
      lines: net > 0
        ? [
          { code: dest.code, name: dest.name, debit: rialToLedger(abs), credit: 0 },
          { code: opening.code, name: opening.name, debit: 0, credit: rialToLedger(abs) },
        ]
        : [
          { code: opening.code, name: opening.name, debit: rialToLedger(abs), credit: 0 },
          { code: dest.code, name: dest.name, debit: 0, credit: rialToLedger(abs) },
        ],
    });
    n++;
  }
  return n;
}


function resolveCustomerIdFromArJe(db, refType, refId) {
  const rt = String(refType || '');
  if (refId == null || refId === '') return null;
  const rid = Number(refId);
  if (!Number.isFinite(rid)) return null;
  if (rt === 'invoice' || rt === 'invoice_void' || rt === 'invoice_ar_reclass'
      || rt === 'invoice_reversal' || rt.startsWith('invoice_')) {
    const r = db.prepare('SELECT cust_id FROM invoices WHERE id=?').get(rid);
    return r ? r.cust_id : null;
  }
  if (rt === 'settlement' || rt === 'settlement_void' || rt === 'settlement_reversal'
      || rt.startsWith('settlement')) {
    const r = db.prepare('SELECT cust_id FROM settlements WHERE id=?').get(rid);
    return r ? r.cust_id : null;
  }
  if (rt === 'pos_receipt' || rt === 'pos_receipt_reversal' || rt.startsWith('pos_receipt')) {
    try {
      const r = db.prepare('SELECT cust_id FROM pos_receipts WHERE id=?').get(rid);
      if (r && r.cust_id) return r.cust_id;
    } catch (_) {}
    const srow = db.prepare('SELECT cust_id FROM settlements WHERE id=?').get(rid);
    return srow ? srow.cust_id : null;
  }
  if (rt === 'opening_ledger') return rid;
  if (rt === 'opening_balance' || rt === 'opening_reclass') {
    const p = db.prepare(
      "SELECT legacy_id FROM parties WHERE id=? AND legacy_table='customers'"
    ).get(rid);
    return p && p.legacy_id ? p.legacy_id : null;
  }
  if (rt === 'cheque_in' || rt === 'cheque_bounce' || rt === 'cheque_endorse'
      || rt === 'cheque_clear' || rt.startsWith('cheque_')) {
    try {
      const r = db.prepare('SELECT customer_id FROM cheque_records WHERE id=?').get(rid);
      return r && r.customer_id ? r.customer_id : null;
    } catch (_) { return null; }
  }
  if (rt === 'sales_return' || rt.includes('sales_return')) {
    try {
      const r = db.prepare('SELECT cust_id FROM sales_returns WHERE id=?').get(rid);
      return r ? r.cust_id : null;
    } catch (_) { return null; }
  }
  if (rt === 'account_receipt' || rt === 'account_payment'
      || rt === 'account_receipt_reversal' || rt === 'account_payment_reversal') {
    const row = db.prepare(`
      SELECT c.id FROM customers c
      JOIN journal_lines jl ON jl.account_code = c.coa_code
      WHERE jl.entry_id=?
      ORDER BY c.id
      LIMIT 1
    `).get(rid);
    return row ? row.id : null;
  }
  return null;
}

function reclassifyControlArToCustomerLeaf(db) {
  let isDeviceFn = () => false;
  try { isDeviceFn = require('../db').isDevice; } catch (_) {}
  if (typeof isDeviceFn === 'function' && isDeviceFn()) {
    return { skipped: true, reason: 'device', moved: 0 };
  }
  const { todayJalali } = require('../jalali');
  const recv = acct(db, 'coa_receivable');
  const rows = db.prepare(`
    SELECT jl.id AS line_id, je.id AS entry_id, je.ref_type, je.ref_id, je.entry_date, je.created_by,
           ${SQL_JL_DEBIT_RIAL} AS debit_rial, ${SQL_JL_CREDIT_RIAL} AS credit_rial
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.account_code = ?
      AND ${JE_BALANCE}
      AND je.ref_type NOT IN (?, 'opening_balance', 'opening_reclass', 'opening_ledger')
      AND (${SQL_JL_DEBIT_RIAL} > 0 OR ${SQL_JL_CREDIT_RIAL} > 0)
    ORDER BY je.entry_date, je.id, jl.id
  `).all(recv.code, AR_CONTROL_RECLASS);
  let moved = 0;
  let skippedFy = 0;
  for (const row of rows) {
    const already = db.prepare(`
      SELECT 1 FROM journal_entries
      WHERE ref_type=? AND ref_id=? AND ${ENTRY_ALIVE}
      LIMIT 1
    `).get(AR_CONTROL_RECLASS, row.line_id);
    if (already) continue;
    const custId = resolveCustomerIdFromArJe(db, row.ref_type, row.ref_id);
    if (!custId) continue;
    const cust = db.prepare('SELECT coa_code FROM customers WHERE id=?').get(custId);
    if (!cust || !cust.coa_code || String(cust.coa_code).trim() === '' || cust.coa_code === recv.code) continue;
    const dest = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(cust.coa_code);
    if (!dest || dest.code === recv.code) continue;
    const net = Math.round(Number(row.debit_rial) || 0) - Math.round(Number(row.credit_rial) || 0);
    if (!net) continue;
    const abs = Math.abs(net);
    const lines = net > 0
      ? [
        { code: dest.code, name: dest.name, debit: rialToLedger(abs), credit: 0 },
        { code: recv.code, name: recv.name, debit: 0, credit: rialToLedger(abs) },
      ]
      : [
        { code: recv.code, name: recv.name, debit: rialToLedger(abs), credit: 0 },
        { code: dest.code, name: dest.name, debit: 0, credit: rialToLedger(abs) },
      ];
    const base = {
      sourceType: AR_CONTROL_RECLASS,
      sourceId: row.line_id,
      description: 'انتقال دریافتنی از ' + recv.code + ' به تفصیلی ' + dest.code + ' (سطر ' + row.line_id + ')',
      createdBy: row.created_by || null,
      voucherType: 'auto',
      lines,
    };
    try {
      db.transaction(() => {
        try {
          postToLedger(db, { ...base, date: row.entry_date || todayJalali() });
        } catch (e) {
          if (e && (e.status === 422 || /سال مالی|قفل/.test(String(e.message || '')))) {
            postToLedger(db, {
              ...base,
              date: todayJalali(),
              description: base.description + ' — تاریخ اصل ' + (row.entry_date || '-'),
            });
            skippedFy += 1;
          } else throw e;
        }
      })();
      moved += 1;
    } catch (e) {
      console.error('ar_control_reclass line', row.line_id, e.message);
    }
  }
  if (moved) console.log('✅ ar_control_reclass moved=' + moved + ' fyFallback=' + skippedFy);
  return { moved, skippedFy };
}

function syncCustomerOpeningBooks(db, customerId, balRial, createdAt, userId) {
  const { createLedgerEntry } = require('../db');
  const bal = Math.round(Number(balRial) || 0);
  db.prepare("DELETE FROM customer_ledger WHERE customer_id=? AND ref_type='opening'").run(customerId);
  if (bal) {
    createLedgerEntry(db, {
      customer_id: customerId,
      date: '',
      entry_type: 'opening',
      ref_type: 'opening',
      ref_id: customerId,
      description: 'مانده اولیه حساب',
      debit: bal > 0 ? bal : 0,
      credit: bal < 0 ? -bal : 0,
      user_id: userId,
      created_at: createdAt || 1,
    });
  }
  const old = db.prepare(`
    SELECT id FROM journal_entries
    WHERE ref_type='opening_ledger' AND ref_id=? AND ${ENTRY_ALIVE}
  `).all(customerId);
  for (const je of old) {
    db.prepare('UPDATE journal_entries SET deleted_at=? WHERE id=?')
      .run(Math.floor(Date.now() / 1000), je.id);
  }
  if (!bal) return { ledger: false, journal: false };
  let coa = db.prepare('SELECT coa_code FROM customers WHERE id=?').get(customerId);
  if (!coa || !coa.coa_code) {
    try {
      const { ensureCustomerTafsili } = require('./party-tafsili');
      ensureCustomerTafsili(db, customerId);
      coa = db.prepare('SELECT coa_code FROM customers WHERE id=?').get(customerId);
    } catch (_) {}
  }
  if (!coa || !coa.coa_code) return { ledger: true, journal: false };
  const dest = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(coa.coa_code);
  if (!dest) return { ledger: true, journal: false };
  const opening = acct(db, 'coa_opening_balance');
  const abs = Math.abs(bal);
  postToLedger(db, {
    sourceType: 'opening_ledger',
    sourceId: customerId,
    date: '',
    description: 'مانده اولیه حساب (هم‌تراز دفتر مشتری)',
    createdBy: userId || null,
    voucherType: 'opening',
    lines: bal > 0
      ? [
        { code: dest.code, name: dest.name, debit: rialToLedger(abs), credit: 0 },
        { code: opening.code, name: opening.name, debit: 0, credit: rialToLedger(abs) },
      ]
      : [
        { code: opening.code, name: opening.name, debit: rialToLedger(abs), credit: 0 },
        { code: dest.code, name: dest.name, debit: 0, credit: rialToLedger(abs) },
      ],
  });
  return { ledger: true, journal: true };
}

function repairMissingInvoiceBooks(db) {
  const invs = db.prepare(`
    SELECT * FROM invoices
    WHERE ${firmSaleTypeSql()} AND COALESCE(deleted_at,0)=0
  `).all();
  let ledger = 0;
  let journal = 0;
  let reclass = 0;
  for (const inv of invs) {
    const skipPay = !!db.prepare(
      "SELECT 1 FROM settlements WHERE invoice_id=? AND COALESCE(status,'posted')<>'reversed' LIMIT 1"
    ).get(inv.id);
    const hadLedger = db.prepare(
      "SELECT 1 FROM customer_ledger WHERE ref_type='invoice' AND ref_id=? LIMIT 1"
    ).get(inv.id);
    postInvoiceCustomerLedger(db, {
      customerId: inv.cust_id, date: inv.date, invId: inv.id, num: inv.num,
      invType: inv.type, final: inv.final, userId: inv.user_id,
      payType: inv.pay_type || 'credit', skipImmediatePayment: skipPay,
    });
    if (!hadLedger) ledger++;

    const je = db.prepare(`
      SELECT id FROM journal_entries
      WHERE ref_type='invoice' AND ref_id=? AND ${ENTRY_ALIVE}
      LIMIT 1
    `).get(inv.id);
    if (!je) {
      let rows = [];
      try { rows = JSON.parse(inv.rows || '[]'); } catch (_) { rows = []; }
      postToLedger(db, {
        sourceType: 'invoice', sourceId: inv.id, date: inv.date || '',
        description: `${invoiceTypeLabel(inv.type)} ${inv.num} (بازسازی سند)`,
        createdBy: inv.user_id,
        lines: salesJournalLines(db, inv.cust_id, {
          subtotal: inv.subtotal, discAmt: inv.disc_amt || 0, final: inv.final,
          vatAmount: inv.vat_amount || 0,
          netBeforeVat: (inv.subtotal || 0) - (inv.disc_amt || 0)
            + (freightChargedToCounterparty(inv.freight_type) ? Math.round(inv.freight_amount || 0) : 0),
        }, false, {
          payType: skipPay ? 'credit' : (inv.pay_type || 'credit'),
          bankId: inv.bank_id, cashBoxId: inv.cash_box_id, rows,
          freightRial: Math.round(inv.freight_amount || 0), freightType: inv.freight_type,
        }),
      });
      if (inv.type === 'normal') autoApproveNormalInvoice(db, inv.id, inv.user_id);
      journal++;
      continue;
    }
    if (!invoiceJeHitsCustomerAr(db, inv) && isImmediatePay(inv.pay_type)) {
      const cashLine = findInvoiceCashLine(db, inv);
      const recv = receivableAcct(db, inv.cust_id);
      const already = db.prepare(`
        SELECT 1 FROM journal_entries
        WHERE ref_type='invoice_ar_reclass' AND ref_id=? AND ${ENTRY_ALIVE}
        LIMIT 1
      `).get(inv.id);
      if (!already && cashLine && recv) {
        const amt = Math.round(Number(inv.final) || Number(cashLine.debit_rial) || 0);
        if (amt > 0) {
          const cash = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(cashLine.account_code)
            || { code: cashLine.account_code, name: cashLine.account_code };
          postToLedger(db, {
            sourceType: 'invoice_ar_reclass', sourceId: inv.id,
            date: inv.date || '',
            description: `انتقال فروش نقدی ${inv.num} به حساب مشتری`,
            createdBy: inv.user_id,
            lines: [
              { code: recv.code, name: recv.name, debit: rialToLedger(amt), credit: 0 },
              { code: cash.code, name: cash.name, debit: 0, credit: rialToLedger(amt) },
            ],
          });
          reclass++;
        }
      }
    }
  }
  return { ledger, journal, reclass };
}

function attachMissingInvoiceRows(db, customerId, tagged) {
  const have = new Set(
    tagged.filter((e) => e.ref_type === 'invoice' && e.entry_type !== 'reversal')
      .map((e) => String(e.ref_id))
  );
  const invs = db.prepare(`
    SELECT id, num, type, date, final, created_at
    FROM invoices
    WHERE cust_id=? AND ${firmSaleTypeSql()} AND COALESCE(deleted_at,0)=0
  `).all(customerId);
  let added = 0;
  for (const inv of invs) {
    if (have.has(String(inv.id))) continue;
    tagged.push({
      id: null,
      customer_id: customerId,
      date: inv.date || '',
      entry_type: 'invoice',
      ref_type: 'invoice',
      ref_id: inv.id,
      description: `${invoiceTypeLabel(inv.type)} ${inv.num}`,
      debit: inv.final, credit: 0,
      created_at: inv.created_at || 0,
      user_name: null,
      synthesized: 1,
    });
    added++;
  }
  if (added) {
    tagged.sort((a, b) => {
      const da = String(a.date || '');
      const db_ = String(b.date || '');
      if (da !== db_) return da.localeCompare(db_);
      return (Number(a.created_at) || 0) - (Number(b.created_at) || 0) || (Number(a.id) || 0) - (Number(b.id) || 0);
    });
  }
  return added;
}

function listCustomerGlMovements(db, customerId) {
  const c = db.prepare('SELECT coa_code FROM customers WHERE id=?').get(customerId);
  if (!c || !c.coa_code) return [];
  const like = String(c.coa_code) + '%';
  const rows = db.prepare(`
    SELECT
      je.id AS journal_id,
      je.entry_date AS date,
      je.ref_type,
      je.ref_id,
      je.description,
      je.created_at,
      je.created_by AS user_id,
      u.name AS user_name,
      ${SQL_JL_DEBIT_RIAL} AS debit,
      ${SQL_JL_CREDIT_RIAL} AS credit
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    LEFT JOIN users u ON u.id = je.created_by
    WHERE jl.account_code LIKE ?
      AND ${JE_BALANCE}
      AND (${SQL_JL_DEBIT_RIAL} > 0 OR ${SQL_JL_CREDIT_RIAL} > 0)
    ORDER BY je.entry_date ASC, COALESCE(je.created_at,0) ASC, je.id ASC, jl.id ASC
  `).all(like);
  return rows.map((r) => {
    const ref_type = normalizeStmtRefType(r.ref_type);
    return {
      id: null,
      journal_id: r.journal_id,
      customer_id: customerId,
      date: r.date || '',
      entry_type: stmtEntryType(r.ref_type, ref_type),
      ref_type,
      raw_ref_type: r.ref_type,
      ref_id: r.ref_id,
      description: r.description || '',
      debit: Math.round(Number(r.debit) || 0),
      credit: Math.round(Number(r.credit) || 0),
      created_at: r.created_at || 0,
      user_id: r.user_id,
      user_name: r.user_name,
      source: 'gl',
    };
  });
}

function ledgerMatchKey(refType, refId, debit, credit) {
  const idPart = refId == null || refId === '' ? '' : String(refId);
  return `${normalizeStmtRefType(refType)}|${idPart}|${Math.round(Number(debit) || 0)}|${Math.round(Number(credit) || 0)}`;
}

function openingAmtKey(debit, credit) {
  return `opening||${Math.round(Number(debit) || 0)}|${Math.round(Number(credit) || 0)}`;
}

/**
 * Every live GL line on a customer tafsili gets a matching customer_ledger row.
 * Idempotent: a journal posted after the first run is still copied.
 * A shared coa is copied once, onto the lowest customer id.
 * Matches invoice_ar_reclass→invoice and opening_*→opening so cash-invoice repair is not doubled.
 */
function repairGlLinesToLedger(db) {
  // Idempotent. The old one-shot flag skipped every journal posted after the
  // first overview, so a tafsili voucher never reached the customer book.
  const { createLedgerEntry } = require('../db');
  let inserted = 0;
  const run = db.transaction(() => {
    const customers = db.prepare(`
      SELECT id, coa_code FROM customers
      WHERE coa_code IS NOT NULL AND TRIM(coa_code)<>''
      ORDER BY id
    `).all();
    const seen = new Set();
    for (const c of customers) {
      const code = String(c.coa_code);
      if (seen.has(code)) continue;
      seen.add(code);
      const ledRows = db.prepare(
        'SELECT ref_type, ref_id, debit, credit, entry_type FROM customer_ledger WHERE customer_id=?'
      ).all(c.id);
      const counts = new Map();
      const bump = (key) => { if (key) counts.set(key, (counts.get(key) || 0) + 1); };
      for (const r of ledRows) {
        bump(ledgerMatchKey(r.ref_type, r.ref_id, r.debit, r.credit));
        if (normalizeStmtRefType(r.ref_type) === 'opening') bump(openingAmtKey(r.debit, r.credit));
        if (String(r.entry_type || '') === 'reversal') {
          const idPart = r.ref_id == null || r.ref_id === '' ? '' : String(r.ref_id);
          bump(`reversal|${idPart}|${Math.round(Number(r.debit) || 0)}|${Math.round(Number(r.credit) || 0)}`);
        }
      }
      const used = new Map();
      const consume = (key) => {
        if (!key) return false;
        const have = counts.get(key) || 0;
        const u = used.get(key) || 0;
        if (u >= have) return false;
        used.set(key, u + 1);
        return true;
      };
      const glLines = db.prepare(`
        SELECT je.ref_type, je.ref_id, je.entry_date, je.created_by, je.description,
               ${SQL_JL_DEBIT_RIAL} AS debit, ${SQL_JL_CREDIT_RIAL} AS credit
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        WHERE jl.account_code = ?
          AND ${JE_BALANCE}
          AND je.ref_type <> 'ar_control_reclass'
          AND (${SQL_JL_DEBIT_RIAL} > 0 OR ${SQL_JL_CREDIT_RIAL} > 0)
        ORDER BY je.entry_date, je.id, jl.id
      `).all(code);
      for (const g of glLines) {
        const debit = Math.round(Number(g.debit) || 0);
        const credit = Math.round(Number(g.credit) || 0);
        const primary = ledgerMatchKey(g.ref_type, g.ref_id, debit, credit);
        const opening = normalizeStmtRefType(g.ref_type) === 'opening'
          ? openingAmtKey(debit, credit) : null;
        const idPart = g.ref_id == null || g.ref_id === '' ? '' : String(g.ref_id);
        const reversal = `reversal|${idPart}|${debit}|${credit}`;
        if (consume(primary) || consume(opening) || consume(reversal)) continue;
        createLedgerEntry(db, {
          customer_id: c.id,
          date: g.entry_date || '',
          entry_type: stmtEntryType(g.ref_type),
          ref_type: g.ref_type || 'journal',
          ref_id: g.ref_id,
          description: g.description || '',
          debit,
          credit,
          user_id: g.created_by || null,
        });
        inserted += 1;
        bump(primary);
        consume(primary);
        if (opening) { bump(opening); consume(opening); }
      }
      // A synthetic books_align debit (repair v3) stands in for these lines.
      // Once the lines themselves are on the book, the plug double-counts.
      // Drop it only when the book without it is closer to the live GL.
      const glSigned = Math.round(glLines.reduce((s, g) => s + (Number(g.debit) || 0) - (Number(g.credit) || 0), 0));
      const alignRow = db.prepare(`
        SELECT COALESCE(SUM(debit)-SUM(credit),0) AS n
        FROM customer_ledger WHERE customer_id=? AND ref_type='books_align'
      `).get(c.id);
      const alignNet = Math.round(Number(alignRow && alignRow.n) || 0);
      if (alignNet !== 0) {
        const ledNow = db.prepare(`
          SELECT COALESCE(SUM(debit)-SUM(credit),0) AS n FROM customer_ledger WHERE customer_id=?
        `).get(c.id);
        const ledSigned = Math.round(Number(ledNow && ledNow.n) || 0);
        const without = ledSigned - alignNet;
        if (Math.abs(without - glSigned) + 0.5 < Math.abs(ledSigned - glSigned)) {
          db.prepare(`DELETE FROM customer_ledger WHERE customer_id=? AND ref_type='books_align'`).run(c.id);
        }
      }
    }
    db.prepare("INSERT INTO settings (key,value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value='1'")
      .run(REPAIR_FLAG_V2);
  });
  run();
  if (inserted) {
    console.log(`✅ دفتر مشتری از خطوط دفتر کل تکمیل شد (${inserted} ردیف)`);
  }
  return { ledgerFromGl: inserted };
}

/**
 * Signed live balance per customer (debit − credit).
 * Same rule as buildStatement: customer_ledger + firm invoices missing from it.
 * A partial tafsili GL must not replace this figure.
 */
function customerSignedBalanceMap(db) {
  // Device/desktop: skip one-shot repairs on every balances read — avoids SQLITE_BUSY
  // fighting the sync outbox and keeps the dashboard panel from 500ing.
  if (process.env.SYNC_ROLE !== 'device') {
    try {
      ensureCustomerBooksRepaired(db);
    } catch (e) {
      console.error('customerSignedBalanceMap repair:', e.message);
    }
  }
  const map = new Map();
  const source = new Map(); // customer_id → 'gl' | 'customer_ledger'
  let led = [];
  try {
    led = db.prepare(`
      SELECT customer_id, COALESCE(SUM(debit)-SUM(credit),0) AS bal
      FROM customer_ledger cl
      WHERE ${sqlCustomerLedgerLive('cl')}
      GROUP BY customer_id
    `).all();
  } catch (e) {
    console.error('customerSignedBalanceMap ledger:', e.message);
    map._source = source;
    return map;
  }
  for (const r of led) {
    map.set(Number(r.customer_id), Number(r.bal) || 0);
    source.set(Number(r.customer_id), 'customer_ledger');
  }

  // Match attachMissingInvoiceRows: firm sales not yet in customer_ledger.
  try {
    const missing = db.prepare(`
      SELECT i.cust_id AS customer_id, COALESCE(SUM(i.final),0) AS add_amt
      FROM invoices i
      WHERE ${firmSaleTypeSql('i')} AND COALESCE(i.deleted_at,0)=0
        AND NOT EXISTS (
          SELECT 1 FROM customer_ledger cl
          WHERE cl.customer_id=i.cust_id AND cl.ref_type='invoice' AND cl.ref_id=i.id
            AND COALESCE(cl.entry_type,'')<>'reversal'
        )
      GROUP BY i.cust_id
    `).all();
    for (const r of missing) {
      const id = Number(r.customer_id);
      map.set(id, (map.get(id) || 0) + (Number(r.add_amt) || 0));
      if (!source.has(id)) source.set(id, 'customer_ledger');
    }
  } catch (e) {
    console.error('customerSignedBalanceMap missing invoices:', e.message);
  }

  // Do not replace the subledger with a partial tafsili GL. A new coa_code
  // (party_tafsili_backfill) does not move historical control-account lines, so
  // the first receipt on that tafsili would hide the real balance. GL is shown
  // beside the statement only as a diagnostic until the two books agree.
  map._source = source;
  return map;
}

/**
 * Sum of live customer balances from the subledger (same rule as the statement).
 * Positive signed = debtor. Supports an as-of Jalali cutoff on ledger/invoice dates.
 * Optional userId: only customers visible to that rep (user_id OR assigned_to).
 * null/undefined userId = company-wide (admin/accounting only at the route layer).
 */
function canonicalCustomerFold(db, { asOf, userId } = {}) {
  ensureCustomerBooksRepaired(db);
  const asOfSql = asOf ? ' AND cl.date <= ?' : '';
  const scopeSql = userId != null ? ' WHERE (c.user_id=? OR c.assigned_to=?)' : '';
  const foldParams = [];
  if (asOf) foldParams.push(asOf);
  if (userId != null) foldParams.push(userId, userId);
  const liveSql = sqlCustomerLedgerLive('cl');
  const rows = db.prepare(`
    SELECT c.id AS customer_id,
      COALESCE(SUM(cl.debit),0) AS debit,
      COALESCE(SUM(cl.credit),0) AS credit
    FROM customers c
    LEFT JOIN customer_ledger cl ON cl.customer_id = c.id ${asOfSql}
      AND (${liveSql})
    ${scopeSql}
    GROUP BY c.id
  `).all(...foldParams);
  const byId = new Map();
  for (const r of rows) {
    byId.set(Number(r.customer_id), {
      debit: Number(r.debit) || 0,
      credit: Number(r.credit) || 0,
    });
  }
  const missParams = [];
  let missAsOf = '';
  let missScope = '';
  if (asOf) { missAsOf = ' AND i.date <= ?'; missParams.push(asOf); }
  if (userId != null) {
    missScope = ' AND EXISTS (SELECT 1 FROM customers cx WHERE cx.id=i.cust_id AND (cx.user_id=? OR cx.assigned_to=?))';
    missParams.push(userId, userId);
  }
  const missing = db.prepare(`
    SELECT i.cust_id AS customer_id, COALESCE(SUM(i.final),0) AS add_amt
    FROM invoices i
    WHERE ${firmSaleTypeSql('i')} AND COALESCE(i.deleted_at,0)=0
      ${missAsOf}
      ${missScope}
      AND NOT EXISTS (
        SELECT 1 FROM customer_ledger cl
        WHERE cl.customer_id=i.cust_id AND cl.ref_type='invoice' AND cl.ref_id=i.id
          AND COALESCE(cl.entry_type,'')<>'reversal'
      )
    GROUP BY i.cust_id
  `).all(...missParams);
  for (const r of missing) {
    const id = Number(r.customer_id);
    const cur = byId.get(id) || { debit: 0, credit: 0 };
    cur.debit += Number(r.add_amt) || 0;
    byId.set(id, cur);
  }
  return foldSignedRows([...byId.values()]);
}

function applyCustomerBalances(db, rows) {
  if (!rows || !rows.length) return rows;
  let map;
  try {
    map = customerSignedBalanceMap(db);
  } catch (e) {
    console.error('applyCustomerBalances map failed:', e.message);
    return rows; // keep SQL join balances (lb) already on rows
  }
  const source = map._source || new Map();
  for (const r of rows) {
    if (!r || r.id == null) continue;
    const id = Number(r.id);
    if (map.has(id)) {
      r.ledger_balance = r.balance;
      r.balance = map.get(id);
      r.balance_source = source.get(id) || 'customer_ledger';
    }
  }
  return rows;
}

/**
 * Sum of positive (debtor) live balances — same formula as dashboard list.
 * Optional scope: user_id OR assigned_to.
 */
function sumPositiveCustomerBalancesRial(db, userId) {
  let rows;
  if (userId != null) {
    rows = db.prepare(
      'SELECT id, 0 AS balance FROM customers WHERE user_id=? OR assigned_to=?'
    ).all(userId, userId);
  } else {
    rows = db.prepare('SELECT id, 0 AS balance FROM customers').all();
  }
  applyCustomerBalances(db, rows);
  let debit = 0;
  for (const r of rows) {
    const b = Number(r.balance) || 0;
    if (b > 0) debit += b;
  }
  return Math.round(debit);
}

function eachUniqueCustomerCoa(db, fn) {
  const customers = db.prepare(`
    SELECT id, coa_code FROM customers
    WHERE coa_code IS NOT NULL AND TRIM(coa_code)<>''
    ORDER BY id
  `).all();
  const seen = new Set();
  for (const c of customers) {
    const code = String(c.coa_code);
    if (seen.has(code)) continue;
    seen.add(code);
    fn(c, code);
  }
}

function foldSignedRows(rows) {
  let debit = 0;
  let credit = 0;
  let display = 0;
  let creditor = 0;
  for (const row of rows) {
    const d = Number(row.debit || 0);
    const cr = Number(row.credit || 0);
    debit += d;
    credit += cr;
    const signed = d - cr;
    if (signed > 0) display += signed;
    else if (signed < 0) creditor += -signed;
  }
  return { debit, credit, signed: debit - credit, display, creditor };
}

function glCustomersTafsiliBalance(db, { asOf } = {}) {
  const params = [];
  let asOfSql = '';
  if (asOf) { asOfSql = ' AND je.entry_date <= ?'; params.push(asOf); }
  const rows = db.prepare(`
    SELECT
      COALESCE(SUM(${SQL_JL_DEBIT_RIAL}), 0) AS debit,
      COALESCE(SUM(${SQL_JL_CREDIT_RIAL}), 0) AS credit
    FROM journal_lines jl
    JOIN journal_entries je ON jl.entry_id = je.id
    WHERE ${JE_BALANCE}
      ${asOfSql}
      AND jl.account_code IN (
        SELECT coa_code FROM customers
        WHERE coa_code IS NOT NULL AND TRIM(coa_code) <> ''
      )
    GROUP BY jl.account_code
  `).all(...params);
  return foldSignedRows(rows);
}

/** Same unique-code set as GL — so dashboard compares apples to apples. */
function customerLedgerTafsiliBalance(db, { asOf } = {}) {
  const params = [];
  let asOfSql = '';
  if (asOf) { asOfSql = ' AND cl.date <= ?'; params.push(asOf); }
  const liveSql = sqlCustomerLedgerLive('cl');
  const rows = db.prepare(`
    SELECT
      COALESCE(SUM(cl.debit), 0) AS debit,
      COALESCE(SUM(cl.credit), 0) AS credit
    FROM (
      SELECT MIN(id) AS id
      FROM customers
      WHERE coa_code IS NOT NULL AND TRIM(coa_code) <> ''
      GROUP BY coa_code
    ) c
    LEFT JOIN customer_ledger cl ON cl.customer_id = c.id ${asOfSql}
      AND (${liveSql})
    GROUP BY c.id
  `).all(...params);
  return foldSignedRows(rows);
}

/**
 * One-way debit plug (GL − ledger, only when positive) onto the lowest id
 * that shares the coa. Do not call from ensureCustomerBooksRepaired:
 * a later credit never reduces the plug, and a shared code lands on the
 * wrong customer. Unmatched lines are copied by repairGlLinesToLedger.
 * Kept for an explicit maintenance call.
 */
function repairLedgerSignedToGl(db) {
  const { createLedgerEntry } = require('../db');
  const { todayJalali } = require('../jalali');
  let aligned = 0;
  const run = db.transaction(() => {
    eachUniqueCustomerCoa(db, (c, code) => {
      const glRow = db.prepare(`
        SELECT
          COALESCE(SUM(${SQL_JL_DEBIT_RIAL}), 0) AS debit,
          COALESCE(SUM(${SQL_JL_CREDIT_RIAL}), 0) AS credit
        FROM journal_lines jl
        JOIN journal_entries je ON jl.entry_id = je.id
        WHERE jl.account_code = ?
          AND ${JE_BALANCE}
          AND je.ref_type <> 'ar_control_reclass'
      `).get(code);
      const glSigned = Math.round(Number(glRow.debit || 0) - Number(glRow.credit || 0));
      const ledRow = db.prepare(`
        SELECT COALESCE(SUM(debit),0) AS debit, COALESCE(SUM(credit),0) AS credit
        FROM customer_ledger WHERE customer_id=?
      `).get(c.id);
      const ledSigned = Math.round(Number(ledRow.debit || 0) - Number(ledRow.credit || 0));
      const delta = glSigned - ledSigned;
      if (delta <= 1) return;
      const lastGl = db.prepare(`
        SELECT MAX(je.entry_date) AS d
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        WHERE jl.account_code = ? AND ${JE_ALIVE}
      `).get(code);
      createLedgerEntry(db, {
        customer_id: c.id,
        date: (lastGl && lastGl.d) || todayJalali(),
        entry_type: 'adjustment',
        ref_type: 'books_align',
        ref_id: c.id,
        description: 'هم‌ترازی دفتر مشتری با دفتر کل',
        debit: delta,
        credit: 0,
        user_id: null,
      });
      aligned += 1;
    });
  });
  run();
  if (aligned) {
    console.log(`✅ دفتر مشتری با دفتر کل هم‌تراز شد (${aligned} حساب)`);
  }
  return { aligned };
}

function repairCustomerBooks(db) {
  const flag = db.prepare('SELECT value FROM settings WHERE key=?').get(REPAIR_FLAG);
  if (flag && flag.value === '1') return { skipped: true };
  const result = { openings: 0, openingGl: 0, ledger: 0, journal: 0, reclass: 0 };
  const run = db.transaction(() => {
    result.openings = repairOpeningControlToTafsili(db);
    const inv = repairMissingInvoiceBooks(db);
    result.ledger = inv.ledger;
    result.journal = inv.journal;
    result.reclass = inv.reclass;
    result.openingGl = repairLedgerOpeningsToGl(db);
    db.prepare("INSERT INTO settings (key,value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value='1'")
      .run(REPAIR_FLAG);
  });
  run();
  console.log(
    `✅ دفتر مشتری هم‌تراز شد (افتتاحیه→تفصیلی ${result.openings}، افتتاحیه دفتر ${result.openingGl}، فاکتور دفتر ${result.ledger}، سند ${result.journal}، انتقال نقدی ${result.reclass})`
  );
  return result;
}

/**
 * Opening cheques post Dr notes / Cr equity — never a customer/person receipt.
 * Older builds credited party books; v1 heal was one-shot. After v374 hollow-purge
 * removed corrective «اصلاح:» debits, orphan credits returned. Continuous from v376.
 */
function repairOpeningChequeLedgerMirrors(db) {
  const { retireCustomerLedgerByRef, retirePersonLedgerByRef } = require('./party-ledger-retire');
  let reversed = 0;
  const run = db.transaction(() => {
    let rows = [];
    try {
      rows = db.prepare(`
        SELECT DISTINCT cl.customer_id, cl.ref_id
        FROM customer_ledger cl
        JOIN cheque_records cr ON cr.id = cl.ref_id
        WHERE cl.ref_type='cheque_in'
          AND ${OPENING_CHEQUE_NOTE_SQL}
      `).all();
    } catch (_) { rows = []; }
    for (const led of rows) {
      reversed += retireCustomerLedgerByRef(db, {
        refTypes: ['cheque_in'],
        refId: led.ref_id,
        customerId: led.customer_id,
      });
    }
    try {
      const personRows = db.prepare(`
        SELECT DISTINCT pl.person_id, pl.ref_id
        FROM person_ledger pl
        JOIN cheque_records cr ON cr.id = pl.ref_id
        WHERE pl.ref_type='cheque_in'
          AND ${OPENING_CHEQUE_NOTE_SQL}
      `).all();
      for (const led of personRows) {
        reversed += retirePersonLedgerByRef(db, {
          refTypes: ['cheque_in'],
          refId: led.ref_id,
          personId: led.person_id,
        });
      }
    } catch (_) { /* person_ledger optional */ }
    // Observability only — never skip on subsequent boots (v1 left orphans).
    db.prepare("INSERT INTO settings (key,value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value='1'")
      .run(REPAIR_FLAG_OPENING_CHEQUE);
    db.prepare("INSERT INTO settings (key,value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value='1'")
      .run(REPAIR_FLAG_OPENING_CHEQUE_V2);
  });
  run();
  if (reversed) console.log(`✅ اعتبار چک اول دوره از دفتر طرف حساب برداشته شد (${reversed} ردیف)`);
  return { reversed, continuous: true };
}

function repairSettlementsMissingBooks(db) {
  const { createLedgerEntry } = require('../db');
  const { invoiceHasCashPairOnJe } = require('./invoice-payments');
  const FLAG = 'settlement_books_backfill_v295';
  const done = db.prepare('SELECT value FROM settings WHERE key=?').get(FLAG);
  if (done && done.value === '1') return { inserted: 0, skipped: true };
  let inserted = 0;
  const rows = db.prepare(`
    SELECT s.id, s.cust_id, s.amount, s.amount_rial, s.pay_type, s.date, s.user_id, s.invoice_id
    FROM settlements s
    WHERE COALESCE(s.status,'posted')<>'reversed'
      AND NOT EXISTS (
        SELECT 1 FROM customer_ledger cl
        WHERE cl.ref_type='settlement' AND cl.ref_id=s.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM customer_ledger cl
        WHERE cl.customer_id=s.cust_id AND cl.ref_type='invoice_payment' AND cl.ref_id=s.invoice_id
      )
  `).all();
  const run = db.transaction(() => {
    for (const s of rows) {
      const amountRial = Math.round(Number(s.amount_rial != null ? s.amount_rial : s.amount) || 0);
      if (amountRial <= 0 || !s.cust_id) continue;
      // Skip if a pos_receipt books row already mirrors this settlement amount on same day
      if (s.invoice_id) {
        const posHit = db.prepare(`
          SELECT 1 FROM customer_ledger
          WHERE customer_id=? AND ref_type='pos_receipt' AND credit=? AND date=?
          LIMIT 1
        `).get(s.cust_id, amountRial, s.date || '');
        if (posHit) continue;
      }
      // Never invent a books-only credit without leaf JE or invoice cash-pair (KPI desync).
      const liveJe = db.prepare(`
        SELECT 1 FROM journal_entries
        WHERE ref_type='settlement' AND ref_id=?
          AND COALESCE(deleted_at,0)=0 AND COALESCE(status,'posted') NOT IN ('reversed','void')
        LIMIT 1
      `).get(s.id);
      if (!liveJe && !invoiceHasCashPairOnJe(db, s.invoice_id)) continue;
      const payLabel = s.pay_type === 'cheque' ? 'چک'
        : (s.pay_type === 'bank_transfer' || s.pay_type === 'bank') ? 'واریز بانکی'
          : (s.pay_type === 'pos_card' ? 'کارتخوان' : 'نقد');
      createLedgerEntry(db, {
        customer_id: s.cust_id,
        date: s.date || '',
        entry_type: 'settlement',
        ref_type: 'settlement',
        ref_id: s.id,
        description: `تسویه ${payLabel} — ${amountRial.toLocaleString('fa-IR')} ریال`,
        debit: 0,
        credit: amountRial,
        user_id: s.user_id || null,
      });
      inserted += 1;
    }
    db.prepare("INSERT INTO settings (key,value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value='1'")
      .run(FLAG);
  });
  run();
  if (inserted) console.log(`✅ ردیف دفتر مشتری برای تسویه‌های بدون کتاب تکمیل شد (${inserted})`);
  return { inserted };
}

/**
 * Continuous: posted settlements with customer_ledger credit but no live settlement JE
 * and no invoice cash-pair → post Dr asset / Cr customer leaf so fold matches tafsili.
 */
function repairSettlementsMissingLeafJe(db) {
  const { settlementAssetAccount, invoiceHasCashPairOnJe } = require('./invoice-payments');
  const { todayJalali } = require('../jalali');
  const rows = db.prepare(`
    SELECT s.id, s.cust_id, s.amount, s.amount_rial, s.pay_type, s.date, s.user_id,
           s.invoice_id, s.bank_id, s.cash_box_id, s.account_code, s.note
    FROM settlements s
    WHERE COALESCE(s.status,'posted')<>'reversed'
      AND EXISTS (
        SELECT 1 FROM customer_ledger cl
        WHERE cl.ref_type='settlement' AND cl.ref_id=s.id
          AND COALESCE(cl.entry_type,'')<>'reversal' AND COALESCE(cl.credit,0)>0
      )
      AND NOT EXISTS (
        SELECT 1 FROM journal_entries je
        WHERE je.ref_type='settlement' AND je.ref_id=s.id
          AND COALESCE(je.deleted_at,0)=0
          AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
      )
  `).all();
  let posted = 0;
  let skippedShadow = 0;
  for (const s of rows) {
    if (invoiceHasCashPairOnJe(db, s.invoice_id)) {
      skippedShadow += 1;
      continue;
    }
    // POS settlements are mirrored by pos_receipt JE — never double-post.
    if (String(s.pay_type || '') === 'pos_card' || /کارتخوان/.test(String(s.note || ''))) {
      skippedShadow += 1;
      continue;
    }
    const amountRial = Math.round(Number(s.amount_rial != null ? s.amount_rial : s.amount) || 0);
    if (amountRial <= 0 || !s.cust_id) continue;
    const recv = receivableAcct(db, s.cust_id);
    let asset;
    try {
      const override = String(s.account_code || '').trim();
      if (override) {
        asset = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(override);
      }
      if (!asset) {
        asset = settlementAssetAccount(db, {
          pay_type: s.pay_type, bank_id: s.bank_id, cash_box_id: s.cash_box_id,
        });
      }
    } catch (e) {
      console.error('settlement missing leaf JE asset', s.id, e.message);
      continue;
    }
    if (!asset || !asset.code) continue;
    const payLabel = s.pay_type === 'cheque' ? 'چک'
      : (s.pay_type === 'bank_transfer' || s.pay_type === 'bank') ? 'واریز بانکی' : 'نقد';
    try {
      db.transaction(() => {
        postToLedger(db, {
          sourceType: 'settlement',
          sourceId: s.id,
          date: s.date || todayJalali(),
          description: `تسویه ${payLabel} هنگام فاکتور (هم‌ترازی دفتر/تفصیلی)`,
          createdBy: s.user_id || null,
          lines: [
            { code: asset.code, name: asset.name, debit: rialToLedger(amountRial), credit: 0 },
            { code: recv.code, name: recv.name, debit: 0, credit: rialToLedger(amountRial) },
          ],
        });
      })();
      posted += 1;
    } catch (e) {
      console.error('settlement missing leaf JE', s.id, e.message);
    }
  }
  if (posted) console.log(`✅ سند کل برای تسویه‌های بدون JE روی تفصیلی تکمیل شد (${posted})`);
  return { posted, skippedShadow, scanned: rows.length };
}

/**
 * R13 repair: reversed settlements must not leave a live credit in customer_ledger.
 * v373: retire leftover rows (no hollow reverse inserts).
 */
function repairReversedSettlementBooks(db) {
  const { retireCustomerLedgerByRef } = require('./party-ledger-retire');
  const rows = db.prepare(`
    SELECT DISTINCT cl.customer_id, cl.ref_id
    FROM customer_ledger cl
    JOIN settlements s ON s.id = cl.ref_id
    WHERE cl.ref_type='settlement'
      AND COALESCE(s.status,'posted')='reversed'
  `).all();
  if (!rows.length) return { reversed: 0 };
  let reversed = 0;
  const run = db.transaction(() => {
    for (const row of rows) {
      reversed += retireCustomerLedgerByRef(db, {
        refTypes: ['settlement'],
        refId: row.ref_id,
        customerId: row.customer_id,
      });
    }
  });
  run();
  if (reversed) console.log(`✅ دفتر مشتری برای تسویه‌های ابطال‌شده بازنشسته شد (${reversed} ردیف)`);
  return { reversed };
}

/**
 * Soft-void alive ar_control_reclass vouchers whose source line sits on the
 * given parent JE (ref_id of reclass = journal_lines.id of that parent).
 * Used when the parent settlement/invoice JE is voided but the control→leaf
 * move was left behind (Sadoughi T-0002 / dashboard Δ151.8M).
 */
function softVoidArControlReclassForParentJe(db, parentJeId, reason) {
  if (!parentJeId) return 0;
  const { reverseJournalEntry } = require('./void-journal');
  const alive = db.prepare(`
    SELECT re.id AS reclass_id
    FROM journal_entries re
    JOIN journal_lines src ON src.id = re.ref_id
    WHERE re.ref_type = ?
      AND COALESCE(re.deleted_at,0)=0
      AND COALESCE(re.status,'posted') NOT IN ('reversed','void')
      AND src.entry_id = ?
  `).all(AR_CONTROL_RECLASS, parentJeId);
  let n = 0;
  for (const r of alive) {
    reverseJournalEntry(db, r.reclass_id, {
      reason: reason || 'یتیم کنترل→تفصیلی پس از ابطال مبدأ',
      sourceType: AR_CONTROL_RECLASS,
    });
    n += 1;
  }
  return n;
}

/** Cascade: every settlement JE (alive or already void) for this settlement id. */
function softVoidArControlReclassForSettlement(db, settlementId, reason) {
  if (!settlementId) return 0;
  const parents = db.prepare(`
    SELECT id FROM journal_entries
    WHERE ref_type='settlement' AND ref_id=?
  `).all(settlementId);
  let n = 0;
  for (const p of parents) {
    n += softVoidArControlReclassForParentJe(
      db, p.id, reason || `ابطال تسویه #${settlementId} — معکوس انتقال کنترل→تفصیلی`
    );
  }
  return n;
}

/**
 * Continuous heal (v390): soft-void ar_control_reclass whose economic parent is dead.
 * Settlement void used to soft-void only the settlement JE; control→leaf moves stayed
 * as orphan leaf credits → books AR > leaf GL (exact Δ for صدوقی = 151.8M).
 * Invoice reclass for live invoices is kept.
 */
function repairOrphanArControlReclass(db) {
  const { reverseJournalEntry } = require('./void-journal');
  let voided = 0;
  const run = db.transaction(() => {
    const orphans = db.prepare(`
      SELECT re.id AS reclass_id, src_je.id AS parent_je_id,
             src_je.ref_type AS parent_ref_type, src_je.ref_id AS parent_ref_id,
             src_je.status AS parent_status, src_je.deleted_at AS parent_deleted
      FROM journal_entries re
      JOIN journal_lines src ON src.id = re.ref_id
      JOIN journal_entries src_je ON src_je.id = src.entry_id
      WHERE re.ref_type = ?
        AND COALESCE(re.deleted_at,0)=0
        AND COALESCE(re.status,'posted') NOT IN ('reversed','void')
        AND (
          COALESCE(src_je.deleted_at,0)>0
          OR COALESCE(src_je.status,'posted') IN ('reversed','void')
          OR (
            src_je.ref_type='settlement'
            AND EXISTS (
              SELECT 1 FROM settlements s
              WHERE s.id=src_je.ref_id AND COALESCE(s.status,'posted')='reversed'
            )
          )
          OR (
            src_je.ref_type IN ('invoice','sales')
            AND EXISTS (
              SELECT 1 FROM invoices i
              WHERE i.id=src_je.ref_id
                AND (
                  COALESCE(i.status,'') IN ('reversed','void','cancelled')
                  OR COALESCE(i.deleted_at,0)>0
                )
            )
          )
          OR (
            src_je.ref_type IN ('pos_receipt','pos')
            AND EXISTS (
              SELECT 1 FROM pos_receipts pr
              WHERE pr.id=src_je.ref_id
                AND COALESCE(pr.status,'open') IN ('reversed','void')
            )
          )
        )
    `).all(AR_CONTROL_RECLASS);
    for (const row of orphans) {
      reverseJournalEntry(db, row.reclass_id, {
        reason: 'heal یتیم کنترل→تفصیلی (مبدأ ابطال‌شده)',
        sourceType: AR_CONTROL_RECLASS,
      });
      voided += 1;
    }
  });
  run();
  if (voided) console.log(`✅ orphan ar_control_reclass soft-voided (${voided})`);
  return { voided, continuous: true };
}

function ensureCustomerBooksRepaired(db) {
  let v1 = {};
  try {
    v1 = repairCustomerBooks(db);
  } catch (e) {
    console.error('customer-books repair:', e.message);
    v1 = { error: e.message };
  }
  let openingCtl = 0;
  try {
    openingCtl = repairOpeningControlToTafsili(db);
  } catch (e) {
    console.error('customer-books opening control→leaf:', e.message);
  }
  let reclass = {};
  try {
    reclass = reclassifyControlArToCustomerLeaf(db);
  } catch (e) {
    console.error('customer-books ar reclass:', e.message);
    reclass = { error: e.message };
  }
  let openingGl = { openingGl: 0 };
  try {
    openingGl = { openingGl: repairLedgerOpeningsToGl(db) };
  } catch (e) {
    console.error('customer-books opening→GL:', e.message);
    openingGl = { error: e.message };
  }
  let v2 = {};
  try {
    v2 = repairGlLinesToLedger(db);
  } catch (e) {
    console.error('customer-books repair v2:', e.message);
    v2 = { error: e.message };
  }
  let openingCheque = {};
  try {
    openingCheque = repairOpeningChequeLedgerMirrors(db);
  } catch (e) {
    console.error('opening cheque ledger repair:', e.message);
    openingCheque = { error: e.message };
  }
  let orphanReclass = {};
  try {
    orphanReclass = repairOrphanArControlReclass(db);
  } catch (e) {
    console.error('orphan ar_control_reclass heal:', e.message);
    orphanReclass = { error: e.message };
  }
  let settBooks = {};
  try {
    settBooks = repairSettlementsMissingBooks(db);
  } catch (e) {
    console.error('settlement books repair:', e.message);
    settBooks = { error: e.message };
  }
  let settRevBooks = {};
  try {
    settRevBooks = repairReversedSettlementBooks(db);
  } catch (e) {
    console.error('reversed settlement books repair:', e.message);
    settRevBooks = { error: e.message };
  }
  let settLeafJe = {};
  try {
    settLeafJe = repairSettlementsMissingLeafJe(db);
  } catch (e) {
    console.error('settlement leaf JE repair:', e.message);
    settLeafJe = { error: e.message };
  }
  let chequeMirror = {};
  try {
    chequeMirror = require('./invoice-payments').backfillMissingSettlementCheques(db);
  } catch (e) {
    console.error('cheque receipt mirror:', e.message);
    chequeMirror = { error: e.message };
  }
  return {
    ...v1, openingCtl, reclass, ...openingGl, v2, v3: { skipped: true },
    openingCheque, orphanReclass, settBooks, settRevBooks, settLeafJe, chequeMirror,
  };
}

module.exports = {
  IMMEDIATE_PAY,
  isImmediatePay,
  receivableAcct,
  salesJournalLines,
  sumJournalSides,
  assertJournalLinesBalanced,
  postInvoiceCustomerLedger,
  updateInvoiceCustomerLedger,
  reverseInvoiceCustomerLedger,
  attachMissingInvoiceRows,
  listCustomerGlMovements,
  normalizeStmtRefType,
  stmtEntryType,
  hideVoidedBookRows,
  sqlCustomerLedgerLive,
  glCustomersTafsiliBalance,
  customerLedgerTafsiliBalance,
  customerSignedBalanceMap,
  canonicalCustomerFold,
  foldSignedRows,
  applyCustomerBalances,
  sumPositiveCustomerBalancesRial,
  repairCustomerBooks,
  repairGlLinesToLedger,
  repairLedgerOpeningsToGl,
  reclassifyControlArToCustomerLeaf,
  syncCustomerOpeningBooks,
  repairLedgerSignedToGl,
  repairOpeningChequeLedgerMirrors,
  softVoidArControlReclassForParentJe,
  softVoidArControlReclassForSettlement,
  repairOrphanArControlReclass,
  repairSettlementsMissingBooks,
  repairReversedSettlementBooks,
  repairSettlementsMissingLeafJe,
  ensureCustomerBooksRepaired,
  resolveCustomerIdFromArJe,
  isFirmSale,
  AR_CONTROL_RECLASS,
};
