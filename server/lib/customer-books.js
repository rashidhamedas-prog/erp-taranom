/**
 * Customer AR books: invoice always hits customer tafsili + customer_ledger.
 * Immediate-pay invoices also post the cash/bank pair (Dr cash / Cr AR).
 * Repair brings historical cash invoices and 1103-control openings into line.
 */
'use strict';

const { acct } = require('./coa-map');
const { postToLedger } = require('./ledger');
const { rialToLedger, SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('./money');
const { firmSaleTypeSql, invoiceTypeLabel, isFirmSale, autoApproveNormalInvoice } = require('./sales-document');

const IMMEDIATE_PAY = new Set(['cash', 'bank', 'bank_transfer', 'cheque']);
const JE_ALIVE = `COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'posted') NOT IN ('reversed','void')`;
const ENTRY_ALIVE = `COALESCE(deleted_at,0)=0 AND COALESCE(status,'posted') NOT IN ('reversed','void')`;
const REPAIR_FLAG = 'customer_books_repair_v1';

function isImmediatePay(payType) {
  return IMMEDIATE_PAY.has(String(payType || 'cash'));
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
  const { discAmt, final, vatAmount, netBeforeVat } = totals;
  const L = rialToLedger;

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
  const productCredit = Math.max(0, Math.round(Number(netBeforeVat) || 0) - incomeCredit);

  if (!reverse) {
    const jLines = [{ code: recv.code, name: recv.name, debit: L(final), credit: 0 }];
    if (discAmt > 0) jLines.push({ code: salesDisc.code, name: salesDisc.name, debit: L(discAmt), credit: 0, description: 'تخفیف فاکتور' });
    if (productCredit > 0) jLines.push({ code: sales.code, name: sales.name, debit: 0, credit: L(productCredit) });
    for (const b of incomeBuckets.values()) {
      if (b.amt > 0) jLines.push({ code: b.code, name: b.name, debit: 0, credit: L(b.amt), description: 'درآمد/خدمات' });
    }
    if (vatAmount > 0) jLines.push({ code: vatPay.code, name: vatPay.name, debit: 0, credit: L(vatAmount), description: 'مالیات بر ارزش افزوده' });
    if (cash && Number(final) > 0) {
      jLines.push({ code: cash.code, name: cash.name, debit: L(final), credit: 0, description: 'دریافت هنگام فاکتور' });
      jLines.push({ code: recv.code, name: recv.name, debit: 0, credit: L(final), description: 'تسویه هنگام فاکتور' });
    }
    return jLines;
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
  if (vatAmount > 0) jLines.push({ code: vatPay.code, name: vatPay.name, debit: L(vatAmount), credit: 0, description: 'ابطال VAT' });
  if (discAmt > 0) jLines.push({ code: salesDisc.code, name: salesDisc.name, debit: 0, credit: L(discAmt), description: 'ابطال تخفیف' });
  jLines.push({ code: recv.code, name: recv.name, debit: 0, credit: L(final) });
  return jLines;
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

function reverseInvoiceCustomerLedger(db, inv, userId, date) {
  const { createLedgerEntry } = require('../db');
  const { todayJalali } = require('../jalali');
  const when = date || todayJalali();
  createLedgerEntry(db, {
    customer_id: inv.cust_id, date: when, entry_type: 'reversal',
    ref_type: 'invoice', ref_id: inv.id,
    description: `ابطال فاکتور ${inv.num}`,
    debit: 0, credit: inv.final, user_id: userId,
  });
  const pay = db.prepare(
    "SELECT 1 FROM customer_ledger WHERE ref_type='invoice_payment' AND ref_id=? LIMIT 1"
  ).get(inv.id);
  if (pay) {
    createLedgerEntry(db, {
      customer_id: inv.cust_id, date: when, entry_type: 'reversal',
      ref_type: 'invoice_payment', ref_id: inv.id,
      description: `ابطال دریافت هنگام فاکتور ${inv.num}`,
      debit: inv.final, credit: 0, user_id: userId,
    });
  }
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
      WHERE ref_type IN ('opening_ledger','opening_balance','opening_reclass')
        AND ${ENTRY_ALIVE}
        AND (
          (ref_type='opening_ledger' AND ref_id=?)
          OR EXISTS (
            SELECT 1 FROM journal_lines jl
            WHERE jl.entry_id=journal_entries.id AND jl.account_code=?
          )
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
          netBeforeVat: (inv.subtotal || 0) - (inv.disc_amt || 0) + Math.round(inv.freight_amount || 0),
        }, false, {
          payType: skipPay ? 'credit' : (inv.pay_type || 'credit'),
          bankId: inv.bank_id, cashBoxId: inv.cash_box_id, rows,
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

/**
 * Signed live balance per customer (debit − credit).
 * Prefers the customer's tafsili in the general ledger; falls back to customer_ledger.
 * Runs the one-shot book repair first so CRM lists match the statement.
 */
function customerSignedBalanceMap(db) {
  ensureCustomerBooksRepaired(db);
  const map = new Map();
  const led = db.prepare(`
    SELECT customer_id, COALESCE(SUM(debit)-SUM(credit),0) AS bal
    FROM customer_ledger GROUP BY customer_id
  `).all();
  for (const r of led) map.set(Number(r.customer_id), Number(r.bal) || 0);

  const glRows = db.prepare(`
    SELECT c.id AS customer_id,
      COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) - COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) AS signed
    FROM customers c
    JOIN journal_lines jl ON jl.account_code = c.coa_code
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE c.coa_code IS NOT NULL AND TRIM(c.coa_code)<>''
      AND ${JE_ALIVE}
    GROUP BY c.id
  `).all();
  for (const r of glRows) map.set(Number(r.customer_id), Number(r.signed) || 0);
  return map;
}

function applyCustomerBalances(db, rows) {
  if (!rows || !rows.length) return rows;
  const map = customerSignedBalanceMap(db);
  for (const r of rows) {
    if (!r || r.id == null) continue;
    const id = Number(r.id);
    if (map.has(id)) {
      r.ledger_balance = r.balance;
      r.balance = map.get(id);
      r.balance_source = 'gl';
    }
  }
  return rows;
}

function glCustomersTafsiliBalance(db, { asOf } = {}) {
  const customers = db.prepare(`
    SELECT id, coa_code FROM customers
    WHERE coa_code IS NOT NULL AND TRIM(coa_code)<>''
  `).all();
  let debit = 0;
  let credit = 0;
  const seen = new Set();
  for (const c of customers) {
    const code = String(c.coa_code);
    if (seen.has(code)) continue;
    seen.add(code);
    const params = [code];
    let asOfSql = '';
    if (asOf) { asOfSql = ' AND je.entry_date <= ?'; params.push(asOf); }
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(${SQL_JL_DEBIT_RIAL}), 0) AS debit,
        COALESCE(SUM(${SQL_JL_CREDIT_RIAL}), 0) AS credit
      FROM journal_lines jl
      JOIN journal_entries je ON jl.entry_id = je.id
      WHERE jl.account_code = ?
        AND ${JE_ALIVE}
        ${asOfSql}
    `).get(...params);
    debit += Number(row.debit || 0);
    credit += Number(row.credit || 0);
  }
  const signed = debit - credit;
  return {
    debit, credit, signed,
    display: Math.max(0, signed),
    creditor: Math.max(0, -signed),
  };
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

function ensureCustomerBooksRepaired(db) {
  try {
    return repairCustomerBooks(db);
  } catch (e) {
    console.error('customer-books repair:', e.message);
    return { error: e.message };
  }
}

module.exports = {
  IMMEDIATE_PAY,
  isImmediatePay,
  receivableAcct,
  salesJournalLines,
  postInvoiceCustomerLedger,
  reverseInvoiceCustomerLedger,
  attachMissingInvoiceRows,
  glCustomersTafsiliBalance,
  customerSignedBalanceMap,
  applyCustomerBalances,
  repairCustomerBooks,
  ensureCustomerBooksRepaired,
  isFirmSale,
};
