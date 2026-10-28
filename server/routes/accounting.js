const { XLSX, readWorkbook } = require('../lib/excel-safe');
const router = require('express').Router();
const { acct: coaAcct, suggestChildCode, validateChildCode } = require('../lib/coa-map');
const { syncLiveTafsili } = require('../lib/coa-live');
const { DELETED_FILTER, postToLedger } = require('../lib/ledger');
const { rialToLedger, jlDebitRial, jlCreditRial, SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');
const {
  parseFeeRial, parseFeeCostCenterInput, resolveFeeCostCenterId,
  outboundPaymentLines, outboundPaymentReversalLines,
} = require('../lib/payment-bank-fee');
const { todayJalali } = require('../jalali');
const {
  assertOutboundPayment, cashAccountForSource, withPaymentIdempotency, isPersonPaymentVoucher,
} = require('../lib/cash-payment-contract');
const {
  parseVoucherAmount, normalizeDocType, sanitizeTemplateLine, nextNumericCode, coaStructureLocked,
} = require('../lib/voucher-guards');
const { firmSaleTypeSql, commissionEligibleSql } = require('../lib/sales-document');
const {
  glControlGrossByLeaf, supplierPayableGrossByLeaf, supplierBooksMismatchList,
  dualPartySupplierCustomerLeaves, unbalancedEntryCount, JE_APPROVED,
} = require('../lib/gl-metrics');
// دریافتنیِ مشتری: تفصیلی خودش وگرنه حساب کنترلی نگاشت‌شده
function recvAcct(db, custId) {
  const c = custId ? db.prepare('SELECT coa_code FROM customers WHERE id=?').get(custId) : null;
  if (c && c.coa_code) {
    const a = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(c.coa_code);
    if (a) return a;
  }
  return coaAcct(db, 'coa_receivable');
}
const { getCachedRate, toRial } = require('../lib/fx-rate');

/** Resolve rial amount when bank/cash is foreign — amount stays INTEGER rial for ledger. */
function resolveSettlementFx(db, opts) {
  const bankId = opts.bank_id ? parseInt(opts.bank_id, 10) : null;
  const boxId = opts.cash_box_id ? parseInt(opts.cash_box_id, 10) : null;
  const bank = bankId ? db.prepare('SELECT * FROM banks WHERE id=?').get(bankId) : null;
  const box = boxId ? db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(boxId) : null;
  const cur = String(opts.currency || bank?.currency || box?.currency || 'IRR').toUpperCase();
  const isForeign = !!(
    (bank && (bank.is_foreign || (bank.currency && bank.currency !== 'IRR')))
    || (box && (box.is_foreign || (box.currency && box.currency !== 'IRR')))
    || (cur && cur !== 'IRR' && cur !== 'TMN' && cur !== 'IRT')
  );
  const date = opts.date || '';
  if (!isForeign) {
    return {
      amountRial: Math.round(Number(opts.amount) || 0),
      foreign_amount: null,
      fx_rate_rial: null,
      currency: 'IRR',
    };
  }
  let rate = Math.round(Number(opts.fx_rate_rial) || 0);
  if (!rate) rate = getCachedRate(db, cur, date);
  const foreign = Number(opts.foreign_amount);
  if (foreign > 0 && rate > 0) {
    return {
      amountRial: toRial(foreign, rate),
      foreign_amount: foreign,
      fx_rate_rial: rate,
      currency: cur,
    };
  }
  // Fallback: amount already entered as rial (manual conversion)
  const amt = Math.round(Number(opts.amount) || 0);
  if (!amt) {
    const err = new Error(rate > 0
      ? 'مبلغ ارزی یا مبلغ ریالی الزامی است'
      : `نرخ ارز ${cur} یافت نشد — از «نرخ ارز» ثبت یا دریافت کنید`);
    err.status = 400;
    throw err;
  }
  return {
    amountRial: amt,
    foreign_amount: foreign > 0 ? foreign : null,
    fx_rate_rial: rate || null,
    currency: cur,
  };
}

const { getDB, audit, createLedgerEntry, createPersonLedgerEntry, backfillAccounting, resolveCashAccount } = require('../db');
const {
  settlementAssetAccount, insertChequeRecordForSettlement, recomputeInvoiceSettledBalances,
} = require('../lib/invoice-payments');
const { assertActiveBank, assertActiveCashBox } = require('../lib/treasury-guards');
const { recordCommissionAccrual, recordSettlementCommissionAccrual, reverseCommissionAccrual } = require('../lib/rep-ledger');
const { reverseSettlementInTx } = require('../lib/void-settlement');
const { reverseJournalEntry } = require('../lib/void-journal');
const { voidInvoiceFully, notifyInvoiceCancelled, saveCancelImage } = require('../lib/void-invoice');
const { auth, adminOnly, adminOrAccounting, centralOnly, requirePermission } = require('../middleware/auth');
const { assertMakerChecker } = require('../lib/rbac');
const { createSecureUpload } = require('../lib/upload-policy');
const { sendSecureHtml } = require('../lib/secure-html-response');
const {
  persistPrivateUpload, persistPrivateUploadWithCommit, locatePrivateFile, removeStoredFile, sendPrivateFile,
} = require('../lib/private-uploads');
const imageUpload = createSecureUpload('messageImage');
const voucherUpload = createSecureUpload('document');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const {
  attachMissingInvoiceRows, stmtEntryType, hideVoidedBookRows, glCustomersTafsiliBalance,
  customerLedgerTafsiliBalance, canonicalCustomerFold, ensureCustomerBooksRepaired,
  reclassifyControlArToCustomerLeaf, customerBooksMismatchList, customerPartyAltHint,
} = require('../lib/customer-books');
const { scopeUserId, customerVisibilitySql } = require('../lib/customer-scope');

const ENTRY_LABEL = {
  invoice: 'فاکتور فروش',
  settlement: 'دریافت وجه',
  sales_return: 'برگشت از فروش',
  reversal: 'ابطال/اصلاح',
  opening: 'مانده اول دوره',
  invoice_payment: 'دریافت هنگام فاکتور',
  cheque: 'ثبت چک دریافتی',
  cheque_endorse: 'خرج/ظهرنویسی چک',
  cheque_bounce: 'برگشت چک',
  cheque_in: 'ثبت چک دریافتی',
  cheque_clear: 'وصول چک',
  journal: 'سند حسابداری',
  manual: 'سند دستی',
};

/** Jalali date for parameterized SQL only — never interpolate into the query string. */
function safeJalaliDate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  return /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(s) ? s : null;
}

const JE_ALIVE = `${DELETED_FILTER} AND (
  COALESCE(je.status,'posted') NOT IN ('reversed','void')
  OR EXISTS (
    SELECT 1 FROM journal_entries _rev
    WHERE COALESCE(_rev.deleted_at,0)=0
      AND _rev.description LIKE ('ابطال سند #' || je.id || '%')
  )
)`;

function assertActiveAccount(db, code) {
  const acc = db.prepare('SELECT * FROM chart_of_accounts WHERE code=?').get(code);
  if (!acc) return { error: `کد حساب ${code} یافت نشد` };
  if (acc.is_active === 0) {
    return { error: `حساب ${acc.code} غیرفعال است`, code: 'E_COA_INACTIVE' };
  }
  return { acc };
}

function assertPostableAccount(db, code) {
  const acc = db.prepare('SELECT * FROM chart_of_accounts WHERE code=?').get(code);
  if (!acc) return { error: `کد حساب ${code} یافت نشد` };
  const hasChild = db.prepare(
    'SELECT 1 FROM chart_of_accounts WHERE parent_code=? AND is_active=1 LIMIT 1'
  ).get(acc.code);
  if (acc.is_active === 0) {
    return { error: `حساب ${acc.code} غیرفعال است`, code: 'E_COA_INACTIVE' };
  }
  if (hasChild) {
    return {
      error: `حساب ${acc.code} سطح پست نیست؛ معین/تفصیلی برگ را انتخاب کنید`,
      code: 'E_COA_NOT_POSTABLE',
    };
  }
  return { acc };
}

function glCustomerCoaSummary(db, customerId, { from, to } = {}) {
  const c = db.prepare('SELECT coa_code FROM customers WHERE id=?').get(customerId);
  if (!c || !c.coa_code) {
    return {
      gl_account_code: null,
      gl_opening_rial: null,
      gl_period_debit_rial: null,
      gl_period_credit_rial: null,
      gl_closing_rial: null,
    };
  }
  const like = String(c.coa_code) + '%';
  const sumSql = `
    SELECT
      COALESCE(SUM(${SQL_JL_DEBIT_RIAL}), 0) AS debit,
      COALESCE(SUM(${SQL_JL_CREDIT_RIAL}), 0) AS credit
    FROM journal_lines jl
    JOIN journal_entries je ON jl.entry_id = je.id
    WHERE jl.account_code LIKE ?
      AND ${JE_ALIVE}
  `;
  let opening_rial = 0;
  if (from) {
    const openRow = db.prepare(sumSql + ' AND je.entry_date < ?').get(like, from);
    opening_rial = Number(openRow.debit || 0) - Number(openRow.credit || 0);
  }
  const periodParts = [];
  const periodParams = [like];
  if (from) { periodParts.push('je.entry_date >= ?'); periodParams.push(from); }
  if (to) { periodParts.push('je.entry_date <= ?'); periodParams.push(to); }
  const periodSql = periodParts.length ? ' AND ' + periodParts.join(' AND ') : '';
  const period = db.prepare(sumSql + periodSql).get(...periodParams);
  const periodDr = Number(period.debit || 0);
  const periodCr = Number(period.credit || 0);
  return {
    gl_account_code: c.coa_code,
    gl_opening_rial: opening_rial,
    gl_period_debit_rial: periodDr,
    gl_period_credit_rial: periodCr,
    gl_closing_rial: opening_rial + periodDr - periodCr,
  };
}

// Build a customer account statement (opening balance + period movements + running balance).
// Running balance is always computed from the very first entry; date/type filters only
// affect which rows are *returned*, so the opening balance reflects everything before `from`.
function buildStatement(db, customerId, { from, to, type } = {}) {
  ensureCustomerBooksRepaired(db);
  const customer = db.prepare(
    'SELECT c.id,c.biz,c.owner,c.city,c.phone,c.balance,u.name as salesperson FROM customers c LEFT JOIN users u ON c.user_id=u.id WHERE c.id=?'
  ).get(customerId);
  if (!customer) return null;
  const all = hideVoidedBookRows(db, db.prepare(`
    SELECT cl.*, u.name as user_name
    FROM customer_ledger cl LEFT JOIN users u ON cl.user_id=u.id
    WHERE cl.customer_id=?
    ORDER BY cl.date ASC, cl.created_at ASC, cl.id ASC
  `).all(customerId));

  const ledgerTagged = [];
  for (const e of all) ledgerTagged.push(e);
  attachMissingInvoiceRows(db, customerId, ledgerTagged);
  require('../lib/report-order').sortReportRows(ledgerTagged, { date: 'date', dir: 'asc' });
  let ledgerRun = 0;
  for (const e of ledgerTagged) {
    ledgerRun += (e.debit || 0) - (e.credit || 0);
    e.running_balance = ledgerRun;
  }
  let ledger_opening = 0;
  if (from) {
    for (const e of ledgerTagged) {
      if ((e.date || '') < from) ledger_opening = e.running_balance;
      else break;
    }
  }
  let ledger_closing = from ? ledger_opening : (ledgerTagged.length ? ledgerTagged[ledgerTagged.length - 1].running_balance : 0);
  for (const e of ledgerTagged) {
    if (from && (e.date || '') < from) continue;
    if (to && (e.date || '') > to) continue;
    ledger_closing = e.running_balance;
  }

  // Rows and the running balance always come from the customer subledger
  // (plus firm invoices missing from it). The tafsili GL is a second figure:
  // historical lines often still sit on the control account, so the first
  // posting on a new coa_code must not become the statement.
  const tagged = ledgerTagged;
  for (const e of tagged) {
    const rawType = String(e.entry_type || '');
    const rawRef = String(e.ref_type || '');
    // Live sales_return must never be labeled «ابطال/اصلاح» (legacy entry_type bug).
    if (rawRef === 'sales_return' && !rawRef.includes('_reversal')) {
      e.entry_type = 'sales_return';
      e.type_label = ENTRY_LABEL.sales_return;
    } else if (rawType === 'reversal' || rawRef.includes('reversal')) {
      e.entry_type = 'reversal';
      e.type_label = ENTRY_LABEL.reversal;
    } else if (e.ref_type) {
      const fromRef = stmtEntryType(e.ref_type);
      if (fromRef && ENTRY_LABEL[fromRef]) e.entry_type = fromRef;
      e.type_label = ENTRY_LABEL[e.entry_type] || ENTRY_LABEL[e.ref_type] || e.entry_type || '-';
    } else {
      e.type_label = ENTRY_LABEL[e.entry_type] || e.entry_type || '-';
    }
    e.reference = (e.ref_type ? e.ref_type + '-' : '') + (e.ref_id || '');
  }
  let opening = ledger_opening;
  const entries = [];
  let periodClose = from ? opening : (tagged.length ? tagged[tagged.length - 1].running_balance : 0);
  for (const e of tagged) {
    if (from && (e.date || '') < from) continue;
    if (to && (e.date || '') > to) continue;
    if (type && e.entry_type !== type) continue;
    entries.push(e);
    periodClose = e.running_balance;
  }
  if (!entries.length && (from || to)) periodClose = opening;
  const totalDebit = entries.reduce((a, e) => a + (e.debit || 0), 0);
  const totalCredit = entries.reduce((a, e) => a + (e.credit || 0), 0);
  const gl = glCustomerCoaSummary(db, customerId, { from, to });
  const hasGl = gl.gl_account_code != null && gl.gl_closing_rial != null;
  const closing = periodClose;
  const books_mismatch = hasGl && Math.abs(Number(gl.gl_closing_rial) - Number(ledger_closing)) > 1;
  let party_hint = null;
  try { party_hint = customerPartyAltHint(db, customerId); } catch (_) { party_hint = null; }
  return {
    customer, entries,
    opening,
    totalDebit, totalCredit, closing,
    ledger_opening,
    ledger_closing,
    books_mismatch,
    party_hint,
    source: hasGl && !books_mismatch ? 'aligned' : 'customer_ledger',
    ...gl,
  };
}

/**
 * Audit 7A: «فروش خالص» = firm invoices − live sales returns; settled = live settlements.
 * Both honor the as-of cutoff. Optional rep scope (uid) limits to visible customers.
 */
function salesNetTotals(db, { asOf, uid } = {}) {
  const vis = uid != null ? customerVisibilitySql('c') : null;
  const join = (col) => (vis ? `JOIN customers c ON c.id=${col}` : '');
  const visSql = vis ? ` AND ${vis}` : '';
  const visParams = uid != null ? [uid, uid] : [];
  const dateSql = (alias) => (asOf ? ` AND ${alias}.date <= ?` : '');
  const dateP = asOf ? [asOf] : [];
  const gross = Number(db.prepare(`
    SELECT COALESCE(SUM(i.final),0) s FROM invoices i ${join('i.cust_id')}
    WHERE ${firmSaleTypeSql('i')} AND COALESCE(i.deleted_at,0)=0${dateSql('i')}${visSql}
  `).get(...dateP, ...visParams).s) || 0;
  let returns = 0;
  try {
    returns = Number(db.prepare(`
      SELECT COALESCE(SUM(r.amount),0) s FROM sales_returns r ${join('r.cust_id')}
      WHERE COALESCE(r.status,'posted')<>'reversed'${dateSql('r')}${visSql}
    `).get(...dateP, ...visParams).s) || 0;
  } catch (_) { returns = 0; }
  const totalSettled = Number(db.prepare(`
    SELECT COALESCE(SUM(s.amount),0) s FROM settlements s ${join('s.cust_id')}
    WHERE COALESCE(s.status,'posted')<>'reversed'${dateSql('s')}${visSql}
  `).get(...dateP, ...visParams).s) || 0;
  return { totalInvoicedGross: gross, salesReturns: returns, totalInvoiced: gross - returns, totalSettled };
}

// Overview stats for accounting dashboard
// Company-wide KPIs only for admin/accounting (scopeUserId=null).
// sales_manager / delegated users get AR scoped to their customers only.
router.get('/overview', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  ensureCustomerBooksRepaired(db);
  const uid = scopeUserId(req);
  const asOf = safeJalaliDate(req.query.asOf) || safeJalaliDate(req.query.to);
  const recvLive = canonicalCustomerFold(db, { asOf, userId: uid });
  const totalReceivable = recvLive.display;
  const creditorBalance = recvLive.creditor;
  const outstanding = totalReceivable;

  if (uid != null) {
    const vis = customerVisibilitySql('c');
    const sn = salesNetTotals(db, { asOf, uid });
    const { totalInvoiced, totalSettled } = sn;
    const pendingApproval = db.prepare(`
      SELECT COUNT(*) c FROM invoices i
      JOIN customers c ON c.id=i.cust_id
      WHERE i.type='final' AND i.approved=0 AND COALESCE(i.deleted_at,0)=0 AND ${vis}
    `).get(uid, uid).c;
    const approvedCount = db.prepare(`
      SELECT COUNT(*) c FROM invoices i
      JOIN customers c ON c.id=i.cust_id
      WHERE i.type='final' AND i.approved=1 AND COALESCE(i.deleted_at,0)=0 AND ${vis}
    `).get(uid, uid).c;
    return res.json({
      totalInvoiced, totalSettled,
      totalInvoicedGross: sn.totalInvoicedGross,
      salesReturns: sn.salesReturns,
      outstanding,
      creditorBalance,
      creditorBalanceLedger: creditorBalance,
      pendingApproval, approvedCount,
      trialBalanced: null,
      totalPayable: null,
      totalPayableLedger: null,
      supplierAdvances: null,
      customerAdvances: null,
      books_mismatch_ap: false,
      books_mismatch_suppliers: [],
      books_mismatch_suppliers_count: 0,
      totalReceivable,
      receivables_gross_debit: totalReceivable,
      receivables_gross_credit: creditorBalance,
      receivables_net_signed: Math.round(Number(recvLive.signed) || 0),
      totalReceivableGl: null,
      creditorBalanceGl: null,
      outstandingLedger: outstanding,
      asOf: asOf || null,
      pendingSettlements: 0,
      books_mismatch: false,
      scoped: true,
    });
  }

  const sn = salesNetTotals(db, { asOf });
  const { totalInvoiced, totalSettled } = sn;
  const pendingApproval = db.prepare("SELECT COUNT(*) c FROM invoices WHERE type='final' AND approved=0 AND COALESCE(deleted_at,0)=0").get().c;
  const pendingSettlements = db.prepare("SELECT COUNT(*) c FROM rep_payment_submissions WHERE status='pending'").get().c;
  const approvedCount = db.prepare("SELECT COUNT(*) c FROM invoices WHERE type='final' AND approved=1 AND COALESCE(deleted_at,0)=0").get().c;
  // Audit 7A: live (JE_ALIVE) + approved only; per-entry imbalance counted separately.
  const tb = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) d, COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) c
    FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id
    WHERE ${JE_ALIVE} AND ${JE_APPROVED}${asOf ? ' AND je.entry_date <= ?' : ''}
  `).get(...(asOf ? [asOf] : []));
  const unbalanced_count = unbalancedEntryCount(db, { to: asOf || null });
  const trialBalanced = Math.abs((tb.d || 0) - (tb.c || 0)) < 1 && unbalanced_count === 0;

  // Audit 7A / fix supplier-per-leaf: payable = leaves under 2101 + supplier leaves
  // outside that prefix (e.g. 110601…); each leaf once. Dual customer+supplier leaves
  // stay on the AP fold and are excluded from customerAdvances so مطالبات is not double-counted.
  const payableCode = coaAcct(db, 'coa_payable').code;
  const payFold = supplierPayableGrossByLeaf(db, payableCode, { asOf });
  const totalPayable = payFold.gross;
  const supplierAdvances = payFold.contra;
  const recvCode = coaAcct(db, 'coa_receivable').code;
  const dualLeaves = dualPartySupplierCustomerLeaves(db);
  const customerAdvances = glControlGrossByLeaf(db, recvCode, {
    asOf, debitNormal: true, excludeCodes: dualLeaves,
  }).contra;
  const recvGl = glCustomersTafsiliBalance(db, { asOf });
  const ledTaf = customerLedgerTafsiliBalance(db, { asOf });
  const outstandingLedger = ledTaf.display;
  const creditorLedger = ledTaf.creditor;

  // Old supplier_ledger path — totalPayableLedger for reconciliation only.
  let totalPayableLedger = 0;
  let hasSupplierLedger = false;
  try {
    const sl = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN bal > 0 THEN bal ELSE 0 END), 0) AS payable,
             COUNT(*) AS n
      FROM (
        SELECT supplier_id, COALESCE(SUM(credit)-SUM(debit),0) AS bal
        FROM supplier_ledger${asOf ? ' WHERE date <= ?' : ''} GROUP BY supplier_id
      )
    `).get(...(asOf ? [asOf] : []));
    totalPayableLedger = Number(sl.payable) || 0;
    hasSupplierLedger = Number(sl.n) > 0;
  } catch (_) { /* table may be empty/absent on older DBs */ }
  if (!hasSupplierLedger) {
    const payRow = db.prepare(`
      SELECT COALESCE(SUM(
        COALESCE(s.balance,0)
        + COALESCE(pi.total_purchased,0)
        - COALESCE(sp.total_paid,0)
        - COALESCE(pr.total_returned,0)
      ),0) total
      FROM suppliers s
      LEFT JOIN (SELECT supplier_id, SUM(final) total_purchased FROM purchase_invoices WHERE pay_type='credit' AND COALESCE(status,'posted')<>'reversed' GROUP BY supplier_id) pi ON pi.supplier_id=s.id
      LEFT JOIN (SELECT supplier_id, SUM(amount) total_paid FROM supplier_payments WHERE COALESCE(status,'posted')<>'reversed' GROUP BY supplier_id) sp ON sp.supplier_id=s.id
      LEFT JOIN (SELECT supplier_id, SUM(amount) total_returned FROM purchase_returns WHERE COALESCE(status,'posted')<>'reversed' GROUP BY supplier_id) pr ON pr.supplier_id=s.id
    `).get();
    totalPayableLedger = payRow.total || 0;
  }

  const mismatchAr = Math.abs(Number(totalReceivable) - Number(recvGl.display)) > 1;
  const mismatchCr = Math.abs(Number(creditorBalance) - Number(recvGl.creditor)) > 1;
  const mismatchLedAr = Math.abs(Number(outstandingLedger) - Number(recvGl.display)) > 1;
  const mismatchLedCr = Math.abs(Number(creditorLedger) - Number(recvGl.creditor)) > 1;
  const booksMismatch = mismatchAr || mismatchCr || mismatchLedAr || mismatchLedCr;
  // Fix 7A supplier-per-leaf: AP integrity = any supplier whose own ledger ≠ own leaf GL.
  let mismatchSuppliers = { count: 0, rows: [] };
  try {
    mismatchSuppliers = supplierBooksMismatchList(db, { asOf, limit: 8 });
  } catch (e) {
    console.error('books mismatch suppliers drill-down:', e.message);
  }
  const booksMismatchAp = Number(mismatchSuppliers.count) > 0;
  // v519: the alarm names the customers whose book differs from their own leaf.
  let mismatchCustomers = { count: 0, rows: [] };
  if (booksMismatch) {
    try {
      mismatchCustomers = customerBooksMismatchList(db, { asOf, limit: 8 });
    } catch (e) {
      console.error('books mismatch drill-down:', e.message);
    }
  }
  res.json({
    totalInvoiced, totalSettled,
    outstanding,
    creditorBalance,
    creditorBalanceLedger: creditorLedger,
    pendingApproval, approvedCount, trialBalanced,
    totalPayable,
    totalPayableLedger,
    totalPayableNet: payFold.net,
    supplierAdvances,
    customerAdvances,
    unbalanced_count,
    totalInvoicedGross: sn.totalInvoicedGross,
    salesReturns: sn.salesReturns,
    totalReceivable,
    receivables_gross_debit: totalReceivable,
    receivables_gross_credit: creditorBalance,
    receivables_net_signed: Math.round(Number(recvLive.signed) || 0),
    totalReceivableGl: recvGl.display,
    creditorBalanceGl: recvGl.creditor,
    outstandingLedger,
    asOf: asOf || null,
    pendingSettlements,
    books_mismatch: booksMismatch,
    books_mismatch_ap: booksMismatchAp,
    books_mismatch_detail: {
      payable: booksMismatchAp,
      payable_delta: Math.round(Number(totalPayableLedger) - Number(totalPayable)),
      receivable: mismatchAr,
      creditor: mismatchCr,
      unique_coa_receivable: mismatchLedAr,
      unique_coa_creditor: mismatchLedCr,
      receivable_delta: Math.round(Number(totalReceivable) - Number(recvGl.display)),
      creditor_delta: Math.round(Number(creditorBalance) - Number(recvGl.creditor)),
    },
    books_mismatch_customers: mismatchCustomers.rows,
    books_mismatch_customers_count: mismatchCustomers.count,
    books_mismatch_suppliers: mismatchSuppliers.rows,
    books_mismatch_suppliers_count: mismatchSuppliers.count,
    scoped: false,
  });
});

/** ADR-004 P0: run books repair + control AR → customer tafsili reclass (central admin). */
router.post('/repair-ar-tafsili', auth, adminOnly, centralOnly, (req, res) => {
  const db = getDB();
  let books = {};
  try {
    books = ensureCustomerBooksRepaired(db) || {};
  } catch (e) {
    return res.status(500).json({ error: e.message || 'تعمیر دفتر مشتری ناموفق' });
  }
  let reclass = { moved: 0 };
  try {
    reclass = reclassifyControlArToCustomerLeaf(db) || { moved: 0 };
  } catch (e) {
    return res.status(500).json({ error: e.message || 'انتقال کنترل→تفصیلی ناموفق' });
  }
  audit(req.user.id, 'repair_ar_tafsili', 'customers', null,
    JSON.stringify({ moved: reclass.moved, books }));
  res.json({
    ok: true,
    moved: reclass.moved || 0,
    skippedFy: reclass.skippedFy || 0,
    books,
    message: (reclass.moved || 0)
      ? `${reclass.moved} سطر از کنترل دریافتنی به تفصیلی مشتری منتقل شد`
      : 'سطر قابل انتقالی نبود یا قبلاً هم‌تراز است',
  });
});

// Receivables per customer — posted GL under the customer COA is the cutoff source.
// customer_ledger remains a labeled second view (ledger_outstanding / books_mismatch).
// Non-admin/accounting (scopeUserId set) only see their own customers.
router.get('/receivables', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  ensureCustomerBooksRepaired(db);
  const uid = scopeUserId(req);
  const { from, to } = req.query;
  const sf = safeJalaliDate(from), st = safeJalaliDate(to);
  const invTo = st ? ` AND i.date <= '${st}'` : '';
  const invFrom = (!st && sf) ? ` AND i.date >= '${sf}'` : '';
  const settTo = st ? ` AND s.date <= '${st}'` : '';
  const settFrom = (!st && sf) ? ` AND s.date >= '${sf}'` : '';
  const ledTo = st ? ' AND cl.date <= ?' : '';
  const ledFrom = (!st && sf) ? ' AND cl.date >= ?' : '';
  const scopeClause = uid != null ? ` WHERE ${customerVisibilitySql('c')}` : '';
  // Bind order follows SQL ? appearance: ledger date filter first, then visibility.
  const ledParams = [];
  if (st) ledParams.push(st);
  else if (sf) ledParams.push(sf);
  if (uid != null) ledParams.push(uid, uid);
  const rows = db.prepare(`
    SELECT c.id, c.biz, c.owner, c.city, c.phone, c.coa_code,
      u.name as salesperson,
      p.is_active as party_is_active,
      p.id as party_id,
      COALESCE(inv.total_invoiced, 0) as total_invoiced,
      COALESCE(stt.total_settled, 0) as total_settled,
      COALESCE(lb.balance, 0) as ledger_balance
    FROM customers c
    LEFT JOIN parties p ON p.id=c.party_id
    LEFT JOIN (
      SELECT i.cust_id, SUM(i.final) as total_invoiced
      FROM invoices i WHERE ${firmSaleTypeSql('i')} AND COALESCE(i.deleted_at,0)=0${invTo}${invFrom}
      GROUP BY i.cust_id
    ) inv ON inv.cust_id=c.id
    LEFT JOIN (
      SELECT cust_id, SUM(amount) as total_settled FROM settlements s
      WHERE COALESCE(status,'posted')<>'reversed'${settTo}${settFrom}
      GROUP BY cust_id
    ) stt ON stt.cust_id=c.id
    LEFT JOIN (
      SELECT customer_id, COALESCE(SUM(debit)-SUM(credit),0) AS balance
      FROM customer_ledger cl WHERE 1=1${ledTo}${ledFrom}
      GROUP BY customer_id
    ) lb ON lb.customer_id=c.id
    LEFT JOIN users u ON c.user_id=u.id
    ${scopeClause}
    ORDER BY ABS(COALESCE(lb.balance,0)) DESC
  `).all(...ledParams);
  const out = [];
  for (const r of rows) {
    const led = Number(r.ledger_balance) || 0;
    const invOut = (Number(r.total_invoiced) || 0) - (Number(r.total_settled) || 0);
    const ledgerOut = led !== 0 ? led : invOut;
    const gl = r.coa_code ? glCustomerCoaSummary(db, r.id, { from: sf, to: st }) : null;
    const hasGl = !!(gl && gl.gl_account_code && gl.gl_closing_rial != null);
    r.ledger_outstanding = ledgerOut;
    r.gl_closing_rial = hasGl ? gl.gl_closing_rial : null;
    r.outstanding = ledgerOut;
    r.source = (hasGl && Math.abs(Number(gl.gl_closing_rial) - Number(ledgerOut)) <= 1)
      ? 'aligned' : 'customer_ledger';
    r.books_mismatch = hasGl && Math.abs(Number(gl.gl_closing_rial) - Number(ledgerOut)) > 1;
    r.inactive = r.party_id != null && Number(r.party_is_active) === 0;
    const hasBalance = Math.abs(Number(r.outstanding) || 0) > 0.5 || Math.abs(ledgerOut) > 0.5 || Math.abs(invOut) > 0.5;
    // Soft-deleted / inactive parties stay only while a non-zero receivable remains.
    if (r.inactive && !hasBalance) continue;
    if (hasGl || ledgerOut || invOut) out.push(r);
  }
  out.sort((a, b) => Math.abs(Number(b.outstanding) || 0) - Math.abs(Number(a.outstanding) || 0));
  res.json(out);
});

// Receivables per final invoice (for invoice-level tracking) — as-of `to` when provided
router.get('/receivables/by-invoice', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const uid = scopeUserId(req);
  const { from, to } = req.query;
  const safeDate = v => (v && /^[\d/]+$/.test(v)) ? v : null;
  const sf = safeDate(from), st = safeDate(to);
  const invTo = st ? ' AND i.date <= ?' : '';
  const invFrom = (!st && sf) ? ' AND i.date >= ?' : '';
  const params = [];
  if (st) params.push(st);
  else if (sf) params.push(sf);
  const settDate = st ? ' AND date <= ?' : ((!st && sf) ? ' AND date >= ?' : '');
  const settParams = st ? [st] : ((!st && sf) ? [sf] : []);
  const scopeSql = uid != null ? ` AND ${customerVisibilitySql('c')}` : '';
  const scopeParams = uid != null ? [uid, uid] : [];
  const retDate = st ? ' AND sr.date <= ?' : ((!st && sf) ? ' AND sr.date >= ?' : '');
  const retParams = st ? [st] : ((!st && sf) ? [sf] : []);
  const face = sqlInvoiceFaceRial('i');
  const rows = db.prepare(`
    SELECT i.id, i.num, i.date, ${face} AS final, ${face} AS amount_rial,
      c.id as cust_id, c.biz, c.owner, u.name as salesperson,
      COALESCE(sp.paid, 0) + COALESCE(sr.returns_gross, 0) + COALESCE(rca.alloc_gross, 0) as paid
    FROM invoices i
    JOIN customers c ON i.cust_id=c.id
    LEFT JOIN users u ON c.user_id=u.id
    LEFT JOIN (
      SELECT invoice_id, SUM(amount) as paid FROM settlements
      WHERE invoice_id IS NOT NULL AND COALESCE(status,'posted')<>'reversed'${settDate}
      GROUP BY invoice_id
    ) sp ON sp.invoice_id=i.id
    LEFT JOIN (
      SELECT invoice_id, SUM(COALESCE(amount,0) + COALESCE(vat_amount,0)) as returns_gross
      FROM sales_returns sr
      WHERE invoice_id IS NOT NULL AND COALESCE(status,'posted')<>'reversed'${retDate}
      GROUP BY invoice_id
    ) sr ON sr.invoice_id=i.id
    LEFT JOIN (
      SELECT invoice_id, SUM(amount_rial) as alloc_gross FROM return_credit_allocations
      WHERE side='sales' AND COALESCE(status,'posted')<>'reversed'
      GROUP BY invoice_id
    ) rca ON rca.invoice_id=i.id
    WHERE ${firmSaleTypeSql('i')} AND COALESCE(i.deleted_at,0)=0${invTo}${invFrom}${scopeSql}
    ORDER BY i.date DESC, i.id DESC
    LIMIT 500
  `).all(...settParams, ...retParams, ...params, ...scopeParams);
  rows.forEach(r => { r.outstanding = (r.final || 0) - (r.paid || 0); });
  res.json(rows.filter(r => Math.abs(r.outstanding) > 0.0001));
});

// Settlements list
router.get('/settlements', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { from, to } = req.query;
  const where = ["COALESCE(s.status,'posted')<>'reversed'"];
  const params = [];
  if (from) { where.push("s.date >= ?"); params.push(from); }
  if (to) { where.push("s.date <= ?"); params.push(to); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT s.*, c.biz as cust_biz, u.name as recorder_name, i.num as invoice_num
    FROM settlements s
    LEFT JOIN customers c ON s.cust_id=c.id
    LEFT JOIN users u ON s.user_id=u.id
    LEFT JOIN invoices i ON s.invoice_id=i.id
    ${whereSql}
    ORDER BY s.date DESC, s.id DESC
    LIMIT 300
  `).all(...params);
  res.json(rows);
});

// Add settlement
router.post('/settlements', auth, adminOrAccounting, (req, res) => {
  const { cust_id, invoice_id, amount, pay_type, date, note, bank_id, cash_box_id, check_category_id,
          cheque_bank, cheque_sayadi, cheque_number, cheque_account,
          cheque_amount, cheque_owner, cheque_due, cheque_status,
          cheque_branch, cheque_sheba, foreign_amount, fx_rate_rial, currency, account_code } = req.body;
  if (!cust_id) return res.status(400).json({ error: 'مشتری الزامی است' });
  const db = getDB();
  const {
    requireClientRequestId, findByClientRequestId, isUniqueClientRequestConflict,
  } = require('../lib/client-request-id');
  const { assertJalaliDocDate } = require('../lib/validators');
  let requestKey;
  let settleDate;
  try {
    requestKey = requireClientRequestId(req.body);
    settleDate = assertJalaliDocDate(date, 'تاریخ تسویه') || '';
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  const priorSt = findByClientRequestId(db, 'settlements', requestKey);
  if (priorSt) return res.json({ id: priorSt.id, ok: true, amount: priorSt.amount_rial || priorSt.amount, idempotent_replay: true });
  let fx;
  try {
    fx = resolveSettlementFx(db, {
      amount, bank_id, cash_box_id, foreign_amount, fx_rate_rial, currency, date: settleDate || date,
    });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
  if (!fx.amountRial) return res.status(400).json({ error: 'مشتری و مبلغ الزامی است' });
  const amountRial = fx.amountRial;
  const payTypeNorm = pay_type || 'cash';
  try {
    if (payTypeNorm === 'cash') assertActiveCashBox(db, cash_box_id, { allowNull: !cash_box_id });
    if (payTypeNorm === 'bank' || payTypeNorm === 'bank_transfer') {
      assertActiveBank(db, bank_id);
    }
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  const whenDate = settleDate || date || '';
  let settlementId;
  try {
    settlementId = db.transaction(() => {
      const result = db.prepare(
        `INSERT INTO settlements
          (user_id,cust_id,invoice_id,amount,amount_rial,pay_type,date,note,bank_id,cash_box_id,check_category_id,
           cheque_bank,cheque_sayadi,cheque_number,cheque_account,
           cheque_amount,cheque_owner,cheque_due,cheque_status,cheque_branch,cheque_sheba,
           foreign_amount,fx_rate_rial,currency,account_code,client_request_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(req.user.id, cust_id, invoice_id || null, amountRial, amountRial, payTypeNorm,
            whenDate, note || '', bank_id || null, cash_box_id || null, check_category_id || null,
            cheque_bank || '', cheque_sayadi || '', cheque_number || '', cheque_account || '',
            parseFloat(cheque_amount || 0), cheque_owner || '', cheque_due || '',
            cheque_status || 'pending', cheque_branch || '', cheque_sheba || '',
            fx.foreign_amount, fx.fx_rate_rial, fx.currency, '', requestKey);
      const settlementId = result.lastInsertRowid;

      const payLabel = payTypeNorm === 'cheque' ? 'چک' : (payTypeNorm === 'bank_transfer' ? 'واریز بانکی' : 'نقد');
      const fxNote = fx.foreign_amount && fx.fx_rate_rial
        ? ` (${fx.foreign_amount} ${fx.currency} × ${fx.fx_rate_rial})`
        : '';
      createLedgerEntry(db, {
        customer_id: cust_id, date: whenDate, entry_type: 'settlement',
        ref_type: 'settlement', ref_id: settlementId,
        description: `تسویه ${payLabel} - ${amountRial.toLocaleString('fa-IR')} ریال${fxNote}`,
        debit: 0, credit: amountRial, user_id: req.user.id
      });
      // Customer receipt debit is the instrument only: cash box / bank / 1109.
      const cash = settlementAssetAccount(db, {
        pay_type: payTypeNorm, bank_id, cash_box_id,
      });
      postToLedger(db, {
        sourceType: 'settlement', sourceId: settlementId,
        date: whenDate || todayJalali(), description: `تسویه ${payLabel} مشتری${fxNote}`, createdBy: req.user.id,
        lines: [
          { code: cash.code, name: cash.name, debit: rialToLedger(amountRial), credit: 0 },
          (()=>{const a=recvAcct(db,cust_id);return { code: a.code, name: a.name, debit: 0, credit: rialToLedger(amountRial) };})()
        ]
      });
      if (payTypeNorm === 'cheque') {
        insertChequeRecordForSettlement(db, {
          settlementId, invoiceId: invoice_id || null, custId: cust_id, amountRial,
          date: whenDate, note: note || '',
          cheque_number, cheque_due, cheque_bank, cheque_branch: cheque_branch || '',
          sayadi: cheque_sayadi, sheba: cheque_sheba || '', cheque_account,
        });
      }
      if (invoice_id) {
        const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoice_id);
        if (inv) {
          recordSettlementCommissionAccrual(db, { id: settlementId, amount: amountRial, date: whenDate }, inv, req.user.id);
        }
        recomputeInvoiceSettledBalances(db, invoice_id);
      }
      return settlementId;
    })();
  } catch (e) {
    if (isUniqueClientRequestConflict(e)) {
      const again = findByClientRequestId(db, 'settlements', requestKey);
      if (again) return res.json({ id: again.id, ok: true, amount: again.amount_rial || again.amount, idempotent_replay: true });
    }
    return res.status(e.status || 400).json({ error: e.message || String(e), code: e.code });
  }
  audit(req.user.id, 'create', 'settlement', settlementId, `تسویه ${amountRial} ریال - مشتری ${cust_id}`);

  try {
    const cust = db.prepare('SELECT biz,owner,phone,mobile,party_group_id,user_id FROM customers WHERE id=?').get(cust_id);
    const { dispatchSmsEvent } = require('../lib/sms-dispatch');
    setImmediate(() => dispatchSmsEvent(db, 'settlement.created', {
      phone: cust?.mobile || cust?.phone,
      name: cust?.owner || cust?.biz,
      biz: cust?.biz,
      amount: amountRial,
      date: whenDate,
      note: note || '',
      party_group_id: cust?.party_group_id,
      user_id: cust?.user_id,
      created_by: req.user.id,
      user: req.user.name,
    }));
  } catch (_) {}

  res.json({ id: settlementId, ok: true, amount: amountRial, currency: fx.currency, fx_rate_rial: fx.fx_rate_rial });
});

// Batch settlements (installments) — all share installment_group
router.post('/settlements/batch', auth, adminOrAccounting, (req, res) => {
  const { cust_id, payments, note } = req.body;
  if (!cust_id || !Array.isArray(payments) || !payments.length) {
    return res.status(400).json({ error: 'مشتری و حداقل یک قسط الزامی است' });
  }
  const db = getDB();
  const groupId = 'inst-' + Date.now().toString(36);
  const created = [];

  const runBatch = db.transaction(() => {
    const { validateIncomingChequeDue, digitsOnly: dueDigits } = require('../lib/cheque-due-validate');
    let chequeRowIdx = 0;
    for (const p of payments) {
      const amount = parseFloat(p.amount);
      if (!amount || amount <= 0) throw new Error('مبلغ هر قسط باید بزرگ‌تر از صفر باشد');
      const pay_type = p.pay_type || 'cash';
      let chequeDue = String(p.cheque_due || '').trim();
      let chequeNumber = String(p.cheque_number || '').trim();
      let chequeSayadi = String(p.cheque_sayadi || p.sayadi || '').trim();
      if (pay_type === 'cheque') {
        chequeRowIdx += 1;
        chequeSayadi = dueDigits(chequeSayadi);
        chequeDue = validateIncomingChequeDue(db, {
          due: chequeDue,
          receiveDate: p.date || '',
          allowSameDayDue: !!p.allow_same_day_due,
          invoiceId: p.invoice_id || null,
          sayadi: chequeSayadi,
          chequeNumber,
          index: chequeRowIdx,
        });
      }
      const result = db.prepare(
        `INSERT INTO settlements
          (user_id,cust_id,invoice_id,amount,amount_rial,pay_type,date,note,bank_id,cash_box_id,check_category_id,
           cheque_bank,cheque_sayadi,cheque_number,cheque_account,
           cheque_amount,cheque_owner,cheque_due,cheque_status,installment_group,cheque_branch,cheque_sheba,cheque_row)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(req.user.id, cust_id, p.invoice_id || null, amount, amount, pay_type,
            p.date || '', note || p.note || '', p.bank_id || null, p.cash_box_id || null, p.check_category_id || null,
            String(p.cheque_bank || '').trim(), chequeSayadi, chequeNumber, String(p.cheque_account || '').trim(),
            parseFloat(p.cheque_amount || 0), String(p.cheque_owner || '').trim(), chequeDue,
            p.cheque_status || 'pending', groupId, String(p.cheque_branch || '').trim(), String(p.cheque_sheba || '').trim(),
            parseInt(p.cheque_row) || 0);
      const settlementId = result.lastInsertRowid;
      const payLabel = pay_type === 'cheque' ? 'چک' : (pay_type === 'bank_transfer' ? 'واریز بانکی' : 'نقد');
      createLedgerEntry(db, {
        customer_id: cust_id, date: p.date || '', entry_type: 'settlement',
        ref_type: 'settlement', ref_id: settlementId,
        description: `تسویه ${payLabel} (قسط) - ${amount.toLocaleString('fa-IR')} ریال`,
        debit: 0, credit: amount, user_id: req.user.id
      });
      if (pay_type === 'cash' && p.cash_box_id) assertActiveCashBox(db, p.cash_box_id);
      if ((pay_type === 'bank' || pay_type === 'bank_transfer') && p.bank_id) assertActiveBank(db, p.bank_id);
      const cash = settlementAssetAccount(db, {
        pay_type, bank_id: p.bank_id, cash_box_id: p.cash_box_id,
      });
      postToLedger(db, {
        sourceType: 'settlement', sourceId: settlementId,
        date: p.date || todayJalali(), description: `تسویه ${payLabel} مشتری (قسط)`, createdBy: req.user.id,
        lines: [
          { code: cash.code, name: cash.name, debit: rialToLedger(amount), credit: 0 },
          (()=>{const a=recvAcct(db,cust_id);return { code: a.code, name: a.name, debit: 0, credit: rialToLedger(amount) };})()
        ]
      });
      if (pay_type === 'cheque') {
        insertChequeRecordForSettlement(db, {
          settlementId, invoiceId: p.invoice_id || null, custId: cust_id, amountRial: amount,
          date: p.date || '', note: note || p.note || '',
          cheque_number: chequeNumber, cheque_due: chequeDue,
          cheque_bank: String(p.cheque_bank || '').trim(), cheque_branch: String(p.cheque_branch || '').trim(),
          sayadi: chequeSayadi, sheba: String(p.cheque_sheba || '').trim(),
          cheque_account: String(p.cheque_account || '').trim(),
        });
      }
      if (p.invoice_id) {
        const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(p.invoice_id);
        if (inv) {
          recordSettlementCommissionAccrual(db, { id: settlementId, amount, date: p.date || '' }, inv, req.user.id);
        }
        recomputeInvoiceSettledBalances(db, p.invoice_id);
      }
      created.push({ id: settlementId, amount });
    }
  });
  try {
    runBatch();
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || String(e), code: e.code, register_due: e.register_due, invoice_due: e.invoice_due });
  }

  audit(req.user.id, 'create', 'settlement', null, `ثبت ${created.length} قسط برای مشتری ${cust_id}`);
  res.json({ ok: true, installment_group: groupId, created });
});

// Delete settlement
router.delete('/settlements/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const settlement = db.prepare('SELECT * FROM settlements WHERE id=?').get(req.params.id);
  if (!settlement) return res.status(404).json({ error: 'تسویه یافت نشد' });
  if (settlement.status === 'reversed') return res.status(400).json({ error: 'این تسویه قبلاً ابطال شده است' });

  db.transaction(() => {
    reverseSettlementInTx(db, settlement, req.user.id);
  })();
  audit(req.user.id, 'reverse', 'settlement', req.params.id, 'ابطال تسویه');
  res.json({ ok: true });
});

// Correct a standalone receipt in place (same id, rewritten journal).
router.put('/settlements/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  let fx;
  try {
    fx = resolveSettlementFx(db, {
      amount: req.body.amount,
      bank_id: req.body.bank_id,
      cash_box_id: req.body.cash_box_id,
      foreign_amount: req.body.foreign_amount,
      fx_rate_rial: req.body.fx_rate_rial,
      currency: req.body.currency,
      date: req.body.date,
    });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  try {
    const { amendSettlement } = require('../lib/amend-cash-ops');
    const out = db.transaction(() => amendSettlement(db, +req.params.id, {
      ...req.body,
      amountRial: fx.amountRial,
      foreign_amount: fx.foreign_amount,
      fx_rate_rial: fx.fx_rate_rial,
      currency: fx.currency,
    }, req.user.id))();
    audit(req.user.id, 'update', 'settlement', out.id, out.summary);
    res.json({ ok: true, id: out.id, amount: out.amount });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('amend settlement', e);
    res.status(status).json({ error: e.message || 'اصلاح دریافت ناموفق بود', code: e.code });
  }
});

// Cheque management list
router.get('/cheques', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { from, to, status, bank } = req.query;
  const where = ["s.pay_type='cheque'", "COALESCE(s.status,'posted')<>'reversed'"];
  const params = [];
  if (from) { where.push('s.cheque_due >= ?'); params.push(from); }
  if (to)   { where.push('s.cheque_due <= ?'); params.push(to); }
  if (status) { where.push('s.cheque_status = ?'); params.push(status); }
  if (bank)   { where.push('s.cheque_bank LIKE ?'); params.push('%' + bank + '%'); }
  const rows = db.prepare(`
    SELECT s.*, c.biz as cust_biz, u.name as salesperson_name
    FROM settlements s
    LEFT JOIN customers c ON s.cust_id=c.id
    LEFT JOIN users u ON c.user_id=u.id
    WHERE ${where.join(' AND ')}
    ORDER BY s.cheque_due ASC, s.created_at DESC
    LIMIT 500
  `).all(...params);
  res.json(rows);
});

// Update cheque status (pending → received/bounced/cancelled)
router.patch('/cheques/:id/status', auth, adminOrAccounting, (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'received', 'bounced', 'cancelled'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'وضعیت نامعتبر' });
  const db = getDB();
  const row = db.prepare('SELECT * FROM settlements WHERE id=? AND pay_type=?').get(req.params.id, 'cheque');
  if (!row) return res.status(404).json({ error: 'چک یافت نشد' });
  db.prepare('UPDATE settlements SET cheque_status=? WHERE id=?').run(status, req.params.id);
  audit(req.user.id, 'update', 'cheque', req.params.id, `وضعیت چک: ${status}`);
  res.json({ ok: true });
});

// Incentive (commission) report per salesperson (only approved invoices)
router.get('/commissions', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { from, to } = req.query;
  const { computeRepCommission, buildRepLedgerView, recordIncentivePaymentLedger, settleAdvancesAgainstPayment, notifyRep, isRepRole } = require('../lib/rep-ledger');
  const users = db.prepare(
    "SELECT id,name,role,commission_cash,commission_cheque,commission_basis,monthly_target FROM users WHERE active=1 AND role IN ('field_sales','inside_sales')"
  ).all();
  const paidRows = db.prepare(`
    SELECT rep_id, COALESCE(SUM(amount),0) s FROM incentive_payments
    WHERE COALESCE(status,'posted')<>'reversed'
    GROUP BY rep_id
  `).all();
  const paidMap = Object.fromEntries(paidRows.map(r => [r.rep_id, r.s]));
  const result = users.map(u => {
    const comm = computeRepCommission(db, u.id, { from, to });
    const view = buildRepLedgerView(db, u.id, { from, to });
    const paid = paidMap[u.id] || 0;
    return {
      ...u,
      roleLabel: u.role === 'inside_sales' ? 'تلفنی' : 'میدانی',
      basisLabel: u.commission_basis === 'collection' ? 'وصول' : u.commission_basis === 'profit' ? 'سود' : 'فاکتور',
      ...comm,
      paid,
      payable: view?.payable ?? Math.max(0, comm.totalComm - paid),
      balance: view?.balance ?? 0,
      advancesRemaining: view?.advancesRemaining ?? 0
    };
  });
  res.json(result);
});

// List incentive payments (optionally for a single rep)
router.get('/incentive-payments', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { rep_id } = req.query;
  const rows = rep_id
    ? db.prepare("SELECT ip.*, u.name as rep_name, r.name as recorder FROM incentive_payments ip LEFT JOIN users u ON ip.rep_id=u.id LEFT JOIN users r ON ip.created_by=r.id WHERE ip.rep_id=? AND COALESCE(ip.status,'posted')<>'reversed' ORDER BY ip.created_at DESC").all(rep_id)
    : db.prepare("SELECT ip.*, u.name as rep_name, r.name as recorder FROM incentive_payments ip LEFT JOIN users u ON ip.rep_id=u.id LEFT JOIN users r ON ip.created_by=r.id WHERE COALESCE(ip.status,'posted')<>'reversed' ORDER BY ip.created_at DESC LIMIT 300").all();
  res.json(rows);
});

// Record an incentive payment to a sales representative
router.post('/incentive-payments', auth, adminOrAccounting, (req, res) => {
  const { recordIncentivePaymentLedger, settleAdvancesAgainstPayment, notifyRep } = require('../lib/rep-ledger');
  const {
    rep_id, note, check_category_id, fee_cost_center_id, bank_fee_cost_center_id,
  } = req.body;
  if (!rep_id) return res.status(400).json({ error: 'کارشناس الزامی است' });
  const db = getDB();
  try {
    const spec = assertOutboundPayment(db, req.body);
    const rep = db.prepare('SELECT id,name FROM users WHERE id=?').get(rep_id);
    if (!rep) return res.status(404).json({ error: 'کارشناس یافت نشد' });
    const feeCcId = resolveFeeCostCenterId(db, {
      feeRial: spec.fee, payType: spec.payType,
      feeCostCenterId: parseFeeCostCenterInput({ fee_cost_center_id, bank_fee_cost_center_id }),
    });
    const out = withPaymentIdempotency(db, {
      key: req.body.idempotency_key, userId: req.user.id, path: '/api/accounting/incentive-payments', body: req.body,
    }, () => {
      assertOutboundPayment(db, req.body);
      const ids = [];
      const cash = cashAccountForSource(db, spec);
      const { counterpartyAccount, mirrorPersonMovement } = require('../lib/person-counterparty');
      const destParty = counterpartyAccount(db, rep_id, 'coa_rep_commission_payable');
      const payable = destParty.account;
      spec.amounts.forEach((amount, i) => {
        const fee = i === 0 ? spec.fee : 0;
        const result = db.prepare(
          'INSERT INTO incentive_payments (rep_id,amount,fee_rial,pay_type,date,note,created_by,bank_id,check_category_id,cash_box_id,fee_cost_center_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
        ).run(rep_id, amount, fee, spec.payType, spec.date, note || '', req.user.id, spec.bankId, check_category_id || null, spec.cashBoxId, i === 0 ? feeCcId : null);
        const paymentId = result.lastInsertRowid;
        recordIncentivePaymentLedger(db, {
          rep_id, amount, date: spec.date, payment_id: paymentId, created_by: req.user.id,
        });
        if (req.body.settle_advances !== false) {
          settleAdvancesAgainstPayment(db, rep_id, amount, paymentId, req.user.id);
        }
        const { lines } = outboundPaymentLines(db, {
          amount, feeRial: fee, payType: spec.payType,
          dest: payable, cash, feeCostCenterId: i === 0 ? feeCcId : null,
        });
        postToLedger(db, {
          sourceType: 'incentive_payment', sourceId: paymentId,
          date: spec.date, description: `پرداخت انگیزه فروش به ${rep.name}`, createdBy: req.user.id,
          lines,
        });
        if (destParty.person) {
          mirrorPersonMovement(db, {
            personId: destParty.person.id,
            date: spec.date,
            entryType: 'incentive_payment',
            refType: 'incentive_payment',
            refId: paymentId,
            description: `پرداخت انگیزه فروش به ${rep.name}`,
            debit: amount,
            credit: 0,
            userId: req.user.id,
          });
        }
        ids.push(paymentId);
      });
      return { id: ids[0], ids, ok: true, fee_rial: spec.fee };
    });
    if (!out.replayed) {
      audit(req.user.id, 'create', 'incentive_payment', out.id, `پرداخت انگیزه ${spec.amounts.join('+')} ریال به ${rep.name}`);
      notifyRep(db, rep_id, `💵 انگیزه ${spec.amounts.reduce((a, b) => a + b, 0)} ریال به حساب شما پرداخت شد.`, req.user.id);
    }
    res.json(out);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('incentive-payment', e);
    res.status(status).json({ error: e.message || 'ثبت پرداخت انگیزه ناموفق بود', code: e.code });
  }
});

// Delete an incentive payment — v446 hollow-void (soft-void JE + retire rep_ledger; no twin ابطال)
router.delete('/incentive-payments/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM incentive_payments WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.status === 'reversed') return res.status(400).json({ error: 'این پرداخت قبلاً ابطال شده است' });
  db.transaction(() => {
    const je = db.prepare(`
      SELECT id FROM journal_entries
      WHERE ref_type IN ('incentive_payment','rep_settlement') AND ref_id=?
        AND COALESCE(deleted_at,0)=0
        AND COALESCE(status,'posted') NOT IN ('reversed','void')
      ORDER BY id ASC LIMIT 1
    `).get(row.id);
    if (je) {
      reverseJournalEntry(db, je.id, {
        userId: req.user.id,
        reason: 'ابطال پرداخت انگیزه فروش',
        sourceType: 'incentive_payment_reversal',
      });
    }
    // Drop any legacy paired reverse vouchers still lingering
    try {
      const { hardDeleteJournalEntry } = require('../lib/void-journal');
      const revs = db.prepare(`
        SELECT id FROM journal_entries WHERE ref_type='incentive_payment_reversal' AND ref_id=?
      `).all(row.id);
      for (const r of revs) hardDeleteJournalEntry(db, r.id);
    } catch (_) { /* optional */ }

    const ledgerRows = db.prepare("SELECT * FROM rep_ledger WHERE ref_type='incentive_payment' AND ref_id=?").all(row.id);
    for (const item of ledgerRows) {
      if (item.entry_type === 'advance_settle') {
        const match = String(item.description || '').match(/#(\d+)/);
        if (match) {
          db.prepare('UPDATE rep_advances SET settled_amount=MAX(0,COALESCE(settled_amount,0)-?) WHERE id=?')
            .run(item.credit || 0, Number(match[1]));
        }
      }
    }
    const { retireRepLedgerByRef, retirePersonLedgerByRef } = require('../lib/party-ledger-retire');
    retireRepLedgerByRef(db, {
      refTypes: ['incentive_payment', 'incentive_payment_reversal'],
      refId: row.id,
      repId: row.rep_id,
    });
    retirePersonLedgerByRef(db, {
      refTypes: ['incentive_payment', 'rep_settlement', 'incentive_payment_reversal'],
      refId: row.id,
    });
    db.prepare("UPDATE incentive_payments SET status='reversed',reversal_journal_id=NULL,reversed_at=strftime('%s','now'),reversed_by=? WHERE id=?")
      .run(req.user.id, row.id);
  })();
  audit(req.user.id, 'reverse', 'incentive_payment', req.params.id, 'ابطال پرداخت انگیزه فروش');
  res.json({ ok: true });
});

router.put('/incentive-payments/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  try {
    const { amendIncentivePayment } = require('../lib/amend-cash-ops');
    const out = db.transaction(() => amendIncentivePayment(db, +req.params.id, req.body || {}, req.user.id))();
    audit(req.user.id, 'update', 'incentive_payment', out.id, out.summary);
    res.json({ ok: true, id: out.id, amount: out.amount });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('amend incentive', e);
    res.status(status).json({ error: e.message || 'اصلاح پرداخت انگیزه ناموفق بود', code: e.code });
  }
});

// My commission — salesperson views their own (no adminOnly)
router.get('/my-commission', auth, (req, res) => {
  const db = getDB();
  const { computeRepCommission, buildRepLedgerView, recordIncentivePaymentLedger, settleAdvancesAgainstPayment, notifyRep, isRepRole } = require('../lib/rep-ledger');
  const u = db.prepare('SELECT id,name,commission_cash,commission_cheque,commission_basis,monthly_target FROM users WHERE id=?').get(req.user.id);
  if (!u || !isRepRole(u.role)) {
    return res.json({ cashComm: 0, chequeComm: 0, totalComm: 0, paid: 0, payable: 0, commRate: { cash: 0, cheque: 0 } });
  }
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const range = {};
  if (from) range.from = from;
  if (to) range.to = to;
  const comm = computeRepCommission(db, u.id, range);
  const view = buildRepLedgerView(db, u.id, range);
  const paid = view?.paid ?? db.prepare("SELECT COALESCE(SUM(amount),0) s FROM incentive_payments WHERE rep_id=? AND COALESCE(status,'posted')<>'reversed'").get(u.id).s;
  const pendingExp = db.prepare("SELECT COUNT(*) c FROM rep_expenses WHERE rep_id=? AND status='pending'").get(u.id).c;
  res.json({
    ...comm,
    ...(view?.commission || {}),
    cashSales: comm.cashSales, chequeSales: comm.chequeSales,
    cashComm: comm.cashComm, chequeComm: comm.chequeComm, totalComm: comm.totalComm,
    paid, payable: view?.payable ?? Math.max(0, comm.totalComm - paid),
    balance: view?.balance ?? 0, advancesRemaining: view?.advancesRemaining ?? 0,
    commRate: { cash: u.commission_cash || 0, cheque: u.commission_cheque || 0 },
    basisLabel: u.commission_basis === 'collection' ? 'بر اساس وصول' : u.commission_basis === 'profit' ? 'بر اساس سود' : 'بر اساس فاکتور',
    pendingExpenses: pendingExp
  });
});

function isRepRole(role) {
  return role === 'field_sales' || role === 'inside_sales';
}

// Invoices pending approval
router.get('/pending-approvals', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT i.id, i.num, i.date, i.final, i.pay_type,
      c.biz as cust_biz, u.name as salesperson
    FROM invoices i
    LEFT JOIN customers c ON i.cust_id=c.id
    LEFT JOIN users u ON i.user_id=u.id
    WHERE i.type='final' AND i.approved=0
      AND COALESCE(i.deleted_at,0)=0 AND COALESCE(i.status,'posted')<>'reversed'
    ORDER BY i.created_at DESC
  `).all();
  res.json(rows);
});

// Cancel / void formal invoice (full reverse — R13). Optional snapshot image for in-app message.
router.post('/invoices/:id/cancel', auth, adminOrAccounting, imageUpload.single('image'), async (req, res) => {
  const db = getDB();
  try {
    const result = voidInvoiceFully(db, req.params.id, req.user, { reason: 'cancel' });
    let imageFileName = null;
    if (req.file && req.file.buffer) {
      imageFileName = saveCancelImage(req.file);
    }
    notifyInvoiceCancelled(db, {
      inv: result.invoice,
      user: req.user,
      title: result.title,
      imageFileName,
    });
    audit(req.user.id, 'cancel', 'invoice', result.invoice.id, result.title, req);
    res.json({
      ok: true,
      restoredToProforma: result.restoredToProforma,
      settlementsReversed: result.settlementsReversed,
      title: result.title,
      image: imageFileName,
    });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || 'خطا در لغو فاکتور' });
  }
});

// Approve invoice for commission — SoD: سازنده (user_id) ≠ تأییدکننده
router.post('/invoices/:id/approve', auth, adminOrAccounting, async (req, res) => {
  try {
    const db = getDB();
    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'یافت نشد' });
    if (inv.type !== 'final') return res.status(400).json({ error: 'فقط فاکتور رسمی قابل تأیید است' });
    assertMakerChecker(req.user, inv.user_id);
    db.transaction(() => {
      db.prepare('UPDATE invoices SET approved=1, approved_at=?, approved_by=? WHERE id=?')
        .run(Math.floor(Date.now() / 1000), req.user.id, inv.id);
      recordCommissionAccrual(db, inv, req.user.id);
    })();
    audit(req.user.id, 'approve', 'invoice', inv.id, `تأیید فاکتور ${inv.num} برای انگیزه فروش`, req);

    // Rubika: send invoice summary (image can follow via /rubika endpoint)
    let rubika = { skipped: true };
    try {
      const { sendRubikaText, invoiceSummaryText } = require('../lib/rubika');
      const cust = inv.cust_id ? db.prepare('SELECT biz,owner FROM customers WHERE id=?').get(inv.cust_id) : null;
      rubika = await sendRubikaText(db, invoiceSummaryText(inv, cust?.biz || cust?.owner || ''));
    } catch (e) {
      rubika = { ok: false, reason: e.message };
    }
    try {
      const cust = inv.cust_id ? db.prepare('SELECT biz,owner,phone,mobile,party_group_id,user_id FROM customers WHERE id=?').get(inv.cust_id) : null;
      const { dispatchSmsEvent } = require('../lib/sms-dispatch');
      setImmediate(() => dispatchSmsEvent(db, 'invoice.approved', {
        phone: cust?.mobile || cust?.phone,
        name: cust?.owner || cust?.biz,
        biz: cust?.biz,
        amount: inv.final,
        num: inv.num,
        date: inv.date,
        party_group_id: cust?.party_group_id,
        user_id: cust?.user_id,
        created_by: req.user.id,
        user: req.user.name,
      }));
    } catch (_) {}
    res.json({ ok: true, rubika });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || 'خطا در تأیید فاکتور', code: e.code });
  }
});

// Upload invoice image to Rubika after approval (client html2canvas)
router.post('/invoices/:id/rubika', auth, adminOrAccounting, imageUpload.single('image'), async (req, res) => {
  let temporaryName = null;
  try {
    const db = getDB();
    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'یافت نشد' });
    const { sendRubikaImage, invoiceSummaryText } = require('../lib/rubika');
    const cust = inv.cust_id ? db.prepare('SELECT biz FROM customers WHERE id=?').get(inv.cust_id) : null;
    const caption = invoiceSummaryText(inv, cust?.biz || '');
    if (!req.file) {
      const { sendRubikaText } = require('../lib/rubika');
      return res.json(await sendRubikaText(db, caption));
    }
    temporaryName = persistPrivateUpload(req.file, 'rubika', 'invoice');
    const temporaryPath = locatePrivateFile('rubika', temporaryName, { migrateLegacy: false });
    return res.json(await sendRubikaImage(db, temporaryPath, caption));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  } finally {
    if (temporaryName) removeStoredFile('rubika', temporaryName);
  }
});

// General Accounting — P&L, cash flow, ledger summary
router.get('/general', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { from, to } = req.query;
  const safeDate = v => (v && /^[\d/]+$/.test(v)) ? v : null;
  const sf = safeDate(from), st = safeDate(to);
  const invDateWhere = sf || st ? `AND date >= '${sf||''}' AND date <= '${st||'9999'}'` : '';
  const settDateWhere = sf || st ? `AND date >= '${sf||''}' AND date <= '${st||'9999'}'` : '';
  // R13: exclude voided invoices/purchases from every revenue & VAT figure
  const invAlive = "AND COALESCE(deleted_at,0)=0";
  const purAlive = "AND COALESCE(status,'posted')<>'reversed'";

  const revenue     = db.prepare(`SELECT COALESCE(SUM(final),0) s FROM invoices WHERE ${firmSaleTypeSql()} ${invAlive} ${invDateWhere}`).get().s;
  const subtotal    = db.prepare(`SELECT COALESCE(SUM(subtotal),0) s FROM invoices WHERE ${firmSaleTypeSql()} ${invAlive} ${invDateWhere}`).get().s;
  const discAmt     = db.prepare(`SELECT COALESCE(SUM(disc_amt),0) s FROM invoices WHERE ${firmSaleTypeSql()} ${invAlive} ${invDateWhere}`).get().s;
  const vatOutput   = db.prepare(`SELECT COALESCE(SUM(vat_amount),0) s FROM invoices WHERE ${firmSaleTypeSql()} ${invAlive} ${invDateWhere}`).get().s;
  const purDateWhere = sf || st ? `AND date >= '${sf||''}' AND date <= '${st||'9999'}'` : '';
  const vatInput    = db.prepare(`SELECT COALESCE(SUM(vat_amount),0) s FROM purchase_invoices WHERE 1=1 ${purAlive} ${purDateWhere}`).get().s;

  // Cost of goods sold: sum of (qty × unit cost) across all final invoice rows in range
  const costMap = {};
  db.prepare('SELECT id,cost FROM products').all().forEach(p => { costMap[p.id] = p.cost || 0; });
  let cogs = 0;
  const finalInvRows = db.prepare(`SELECT rows FROM invoices WHERE ${firmSaleTypeSql()} ${invAlive} ${invDateWhere}`).all();
  for (const inv of finalInvRows) {
    let parsed = [];
    try { parsed = JSON.parse(inv.rows || '[]'); } catch (e) { parsed = []; }
    for (const r of parsed) cogs += (r.qty || 0) * (costMap[r.product_id] || 0);
  }
  cogs = Math.round(cogs);
  const grossProfit = revenue - cogs;
  const settled     = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM settlements WHERE COALESCE(status,'posted')<>'reversed' ${settDateWhere}`).get().s;
  const cashSettled = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM settlements WHERE pay_type='cash' AND COALESCE(status,'posted')<>'reversed' ${settDateWhere}`).get().s;
  const cheqSettled = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM settlements WHERE pay_type='cheque' AND COALESCE(status,'posted')<>'reversed' ${settDateWhere}`).get().s;
  const commExpense = (() => {
    const users = db.prepare("SELECT id,commission_cash,commission_cheque FROM users WHERE active=1").all();
    let total = 0;
    for (const u of users) {
      const cs = db.prepare(`SELECT COALESCE(SUM(final),0) s FROM invoices WHERE user_id=? AND ${commissionEligibleSql()} AND pay_type='cash' ${invAlive} ${invDateWhere}`).get(u.id).s;
      const qs = db.prepare(`SELECT COALESCE(SUM(final),0) s FROM invoices WHERE user_id=? AND ${commissionEligibleSql()} AND pay_type='cheque' ${invAlive} ${invDateWhere}`).get(u.id).s;
      total += cs * (u.commission_cash || 0) / 100 + qs * (u.commission_cheque || 0) / 100;
    }
    return Math.round(total);
  })();

  // Monthly revenue & collections for chart
  const monthlyInv = db.prepare(`SELECT substr(date,1,7) ym, SUM(final) rev FROM invoices WHERE ${firmSaleTypeSql()} AND COALESCE(deleted_at,0)=0 AND date<>'' GROUP BY ym ORDER BY ym DESC LIMIT 12`).all();
  const monthlySett = db.prepare(`SELECT substr(date,1,7) ym, SUM(amount) col FROM settlements WHERE date<>'' AND COALESCE(status,'posted')<>'reversed' GROUP BY ym ORDER BY ym DESC LIMIT 12`).all();

  // Recent transactions journal
  const invJournal = db.prepare(`SELECT 'invoice' as entry_type, num ref, date, final amount, cust_id, 0 is_credit FROM invoices WHERE ${firmSaleTypeSql()} AND COALESCE(deleted_at,0)=0 ORDER BY created_at DESC LIMIT 30`).all();
  const settJournal = db.prepare(`SELECT 'settlement' as entry_type, id||'' ref, date, amount, cust_id, 1 is_credit FROM settlements WHERE COALESCE(status,'posted')<>'reversed' ORDER BY created_at DESC LIMIT 30`).all();
  const journal = [...invJournal, ...settJournal].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 50);

  // Enrich journal with customer name
  const custMap = {};
  db.prepare('SELECT id,biz FROM customers').all().forEach(c => { custMap[c.id] = c.biz; });
  journal.forEach(j => { j.cust_biz = custMap[j.cust_id] || '-'; });

  res.json({
    revenue, subtotal, discAmt, settled, cashSettled, cheqSettled,
    outstanding: revenue - settled,
    cogs, grossProfit,
    commExpense,
    netProfit: grossProfit - commExpense,
    vatOutput, vatInput, netVatPayable: vatOutput - vatInput,
    monthlyInv, monthlySett, journal
  });
});

router.get('/income-statement', auth, adminOrAccounting, (req, res, next) => {
  req.url = '/general' + (req.originalUrl.includes('?') ? '?' + req.originalUrl.split('?').slice(1).join('?') : '');
  router.handle(req, res, next);
});

// Customer ledger (transaction history) — REMOVED in v1.0.11 (use acc-statement instead)

// Chart of accounts
router.get('/chart-of-accounts', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  if (!Object.prototype.hasOwnProperty.call(req.query, 'parent')) {
    try {
      const live = syncLiveTafsili(db);
      if (live && ((live.filled || 0) > 0 || (live.repaired || 0) > 0)) {
        console.log('coa live tafsili', live.filled || 0, 'filled', live.repaired || 0, 'repaired');
      }
    } catch (e) {
      console.error('coa live sync:', e.message);
    }
  }
  const includeInactive = req.query.include_inactive === '1' || req.query.include_inactive === 'true';
  const activeSql = includeInactive ? '' : ' AND is_active=1';
  if (Object.prototype.hasOwnProperty.call(req.query, 'parent')) {
    const parent = String(req.query.parent ?? '');
    if (parent === '' || parent === '__root__') {
      return res.json(db.prepare(
        `SELECT * FROM chart_of_accounts WHERE parent_code IS NULL${activeSql} ORDER BY code`
      ).all());
    }
    return res.json(db.prepare(
      `SELECT * FROM chart_of_accounts WHERE parent_code=?${activeSql} ORDER BY code`
    ).all(parent));
  }
  const accounts = db.prepare(`SELECT * FROM chart_of_accounts WHERE 1=1${activeSql} ORDER BY code`).all();
  res.json(accounts);
});

// D4 — suggest next child COA code under parent
router.get('/coa/suggest-child', auth, adminOrAccounting, (req, res) => {
  const parent_code = String(req.query.parent_code || '').trim();
  if (!parent_code) return res.status(400).json({ error: 'parent_code الزامی است' });
  const db = getDB();
  const suggested = suggestChildCode(db, parent_code);
  if (!suggested) return res.status(404).json({ error: 'حساب والد یافت نشد' });
  res.json(suggested);
});

router.post('/chart-of-accounts', auth, adminOrAccounting, (req, res) => {
  const { code, name, type, parent_code, level, nature, balance_type, is_cost_element, tafsili_type, is_active } = req.body;
  if (!code || !name || !type) return res.status(400).json({ error: 'کد، نام و نوع حساب الزامی است' });
  const validTypes = ['asset', 'liability', 'equity', 'revenue', 'cogs', 'expense'];
  if (!validTypes.includes(type)) return res.status(400).json({ error: 'نوع حساب نامعتبر است' });
  const db = getDB();
  const codeStr = String(code).trim();
  const exists = db.prepare('SELECT id FROM chart_of_accounts WHERE code=?').get(codeStr);
  if (exists) return res.status(400).json({ error: 'این کد حساب قبلاً ثبت شده' });
  if (parent_code) {
    const parent = db.prepare('SELECT code FROM chart_of_accounts WHERE code=? AND is_active=1').get(parent_code);
    if (!parent) return res.status(400).json({ error: 'حساب والد یافت نشد' });
    if (!validateChildCode(parent_code, codeStr)) {
      return res.status(400).json({ error: 'کد فرزند باید با پیشوند کد والد شروع شود' });
    }
  }
  const result = db.prepare(`
    INSERT INTO chart_of_accounts
      (code,name,type,parent_code,level,nature,balance_type,is_cost_element,tafsili_type,is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    codeStr, String(name).trim(), type, parent_code || null,
    level != null ? parseInt(level, 10) || null : null, nature || null, balance_type || null,
    is_cost_element ? 1 : 0, tafsili_type || null, is_active === false || is_active === 0 ? 0 : 1
  );
  audit(req.user.id, 'create', 'chart_of_accounts', result.lastInsertRowid, `ساخت حساب ${code} ${name}`);
  res.json(db.prepare('SELECT * FROM chart_of_accounts WHERE id=?').get(result.lastInsertRowid));
});

router.put('/chart-of-accounts/:code', auth, adminOrAccounting, (req, res) => {
  const code = String(req.params.code || '').trim();
  const db = getDB();
  const row = db.prepare('SELECT * FROM chart_of_accounts WHERE code=?').get(code);
  if (!row) return res.status(404).json({ error: 'حساب یافت نشد' });
  const { name, type, parent_code, is_active, nature, level, balance_type, tafsili_type } = req.body;
  const validTypes = ['asset', 'liability', 'equity', 'revenue', 'cogs', 'expense'];
  if (type && !validTypes.includes(type)) return res.status(400).json({ error: 'نوع حساب نامعتبر است' });
  if (parent_code) {
    if (parent_code === code) return res.status(400).json({ error: 'حساب نمی‌تواند والد خودش باشد' });
    const parent = db.prepare('SELECT code FROM chart_of_accounts WHERE code=? AND is_active=1').get(parent_code);
    if (!parent) return res.status(400).json({ error: 'حساب والد یافت نشد' });
    if (!validateChildCode(parent_code, code)) {
      return res.status(400).json({ error: 'کد فرزند باید با پیشوند کد والد شروع شود' });
    }
  }
  const movement = db.prepare('SELECT COUNT(*) c FROM journal_lines WHERE account_code=?').get(code)?.c || 0;
  const locked = coaStructureLocked(row, req.body || {}, movement);
  if (locked) return res.status(409).json(locked);
  db.prepare(`UPDATE chart_of_accounts SET name=?,type=?,parent_code=?,is_active=?,
    nature=COALESCE(?,nature), level=COALESCE(?,level), balance_type=COALESCE(?,balance_type),
    tafsili_type=COALESCE(?,tafsili_type) WHERE code=?`)
    .run(
      name != null ? String(name).trim() : row.name,
      type || row.type,
      parent_code !== undefined ? (parent_code || null) : row.parent_code,
      is_active != null ? (is_active ? 1 : 0) : row.is_active,
      nature != null ? nature : null,
      level != null ? parseInt(level, 10) || null : null,
      balance_type != null ? balance_type : null,
      tafsili_type != null ? tafsili_type : null,
      code
    );
  audit(req.user.id, 'update', 'chart_of_accounts', row.id, `ویرایش حساب ${code}`);
  res.json(db.prepare('SELECT * FROM chart_of_accounts WHERE code=?').get(code));
});

/** Delete COA account — blocked if has children, journal usage, or linked entities. */
router.delete('/chart-of-accounts/:code', auth, adminOrAccounting, (req, res) => {
  const code = String(req.params.code || '').trim();
  const db = getDB();
  const row = db.prepare('SELECT * FROM chart_of_accounts WHERE code=?').get(code);
  if (!row) return res.status(404).json({ error: 'حساب یافت نشد' });

  const child = db.prepare('SELECT code FROM chart_of_accounts WHERE parent_code=? LIMIT 1').get(code);
  if (child) {
    return res.status(400).json({ error: `حساب فرزند دارد (${child.code}) — ابتدا فرزندها را حذف کنید` });
  }
  const jl = db.prepare('SELECT COUNT(*) c FROM journal_lines WHERE account_code=?').get(code)?.c || 0;
  if (jl > 0) {
    return res.status(400).json({ error: 'این حساب در اسناد گردش دارد و قابل حذف نیست' });
  }
  const refTables = [
    ['products', 'coa_code'], ['persons', 'coa_code'], ['parties', 'coa_code'],
    ['customers', 'coa_code'], ['suppliers', 'coa_code'], ['banks', 'coa_code'], ['cash_boxes', 'coa_code'],
  ];
  for (const [tbl, col] of refTables) {
    try {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tbl)) continue;
      const n = db.prepare(`SELECT COUNT(*) c FROM ${tbl} WHERE ${col}=?`).get(code)?.c || 0;
      if (n > 0) return res.status(400).json({ error: `حساب به ${tbl} وصل است و قابل حذف نیست` });
    } catch (_) { /* ignore */ }
  }
  try {
    const settingsHit = db.prepare("SELECT key FROM settings WHERE key LIKE 'coa_%' AND value=?").get(code);
    if (settingsHit) {
      return res.status(400).json({ error: `این کد در نگاشت کنترل (${settingsHit.key}) استفاده شده` });
    }
  } catch (_) { /* ignore */ }

  db.prepare('DELETE FROM chart_of_accounts WHERE code=?').run(code);
  audit(req.user.id, 'delete', 'chart_of_accounts', row.id, `حذف حساب ${code} ${row.name}`);
  res.json({ ok: true, code });
});

// Link an operational entity to an existing chart account (Mahak mode)
const COA_ENTITY_TABLE = { customer: 'customers', supplier: 'suppliers', product: 'products', bank: 'banks', cashbox: 'cash_boxes', person: 'persons' };
router.patch('/link-coa', auth, adminOnly, centralOnly, (req, res) => {
  const { entity_type, entity_id, coa_code } = req.body || {};
  const table = COA_ENTITY_TABLE[entity_type];
  if (!table) return res.status(400).json({ error: 'نوع موجودیت نامعتبر است' });
  const id = parseInt(entity_id, 10);
  const code = String(coa_code || '').trim();
  if (!id || !code) return res.status(400).json({ error: 'شناسه و کد حساب الزامی است' });
  const db = getDB();
  const acc = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=? AND is_active=1').get(code);
  if (!acc) return res.status(400).json({ error: 'حساب در کدینگ یافت نشد' });
  const row = db.prepare(`SELECT id, coa_code FROM ${table} WHERE id=?`).get(id);
  if (!row) return res.status(404).json({ error: 'رکورد یافت نشد' });
  if (row.coa_code && String(row.coa_code) !== code) {
    return res.status(400).json({
      error: 'تفصیلی این موجودیت پایدار است و با اتصال مجدد عوض نمی‌شود',
      code: 'E_COA_IDENTITY_LOCKED',
      coa_code: row.coa_code,
    });
  }
  db.prepare(`UPDATE ${table} SET coa_code=? WHERE id=?`).run(code, id);
  audit(req.user.id, 'link_coa', entity_type, id, `اتصال به ${code} ${acc.name}`);
  res.json({ ok: true, coa_code: acc.code, coa_name: acc.name });
});

const {
  sqlInvoiceFaceRial, sqlPurchaseFaceRial, allocPickerFields,
} = require('../lib/invoice-face-amount');

const SALES_INV_PAID_SQL = `
  COALESCE((SELECT SUM(s.amount) FROM settlements s WHERE s.invoice_id=i.id AND COALESCE(s.status,'posted')<>'reversed'), 0)
  + COALESCE((
    SELECT SUM(COALESCE(sr.amount,0) + COALESCE(sr.vat_amount,0)) FROM sales_returns sr
    WHERE sr.invoice_id=i.id AND COALESCE(sr.status,'posted')<>'reversed'
  ), 0)
  + COALESCE((
    SELECT SUM(rca.amount_rial) FROM return_credit_allocations rca
    WHERE rca.side='sales' AND rca.invoice_id=i.id AND COALESCE(rca.status,'posted')<>'reversed'
  ), 0)`;

const PURCHASE_INV_PAID_SQL = `
  COALESCE((SELECT SUM(sp.amount) FROM supplier_payments sp
    WHERE sp.purchase_invoice_id=p.id AND COALESCE(sp.status,'posted')<>'reversed'), 0)
  + COALESCE((SELECT SUM(ep.amount) FROM expense_payments ep
    WHERE ep.purchase_invoice_id=p.id AND COALESCE(ep.status,'posted')<>'reversed'), 0)
  + COALESCE((
    SELECT SUM(COALESCE(pr.amount,0) + COALESCE(pr.vat_amount,0)) FROM purchase_returns pr
    WHERE pr.purchase_invoice_id=p.id AND COALESCE(pr.status,'posted')<>'reversed'
  ), 0)
  + COALESCE((
    SELECT SUM(rca.amount_rial) FROM return_credit_allocations rca
    WHERE rca.side='purchase' AND rca.invoice_id=p.id AND COALESCE(rca.status,'posted')<>'reversed'
  ), 0)`;

/** Firm sales invoices for return / allocation pickers — face = after discount (AR). */
router.get('/customers/:custId/firm-invoices', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const face = sqlInvoiceFaceRial('i');
  const rows = db.prepare(`
    SELECT i.id, i.num, i.date, i.type, i.subtotal, i.disc_amt, i.final, i.final_rial,
      ${face} AS amount_rial,
      ${SALES_INV_PAID_SQL} AS paid
    FROM invoices i
    WHERE i.cust_id=? AND ${firmSaleTypeSql('i')}
      AND COALESCE(i.deleted_at,0)=0
      AND COALESCE(i.status,'posted')<>'reversed'
    ORDER BY i.date DESC, i.id DESC
  `).all(req.params.custId);
  res.json(rows.map((r) => allocPickerFields(r, { paid: r.paid })));
});

// Open invoices for a customer (for payment allocation) — outstanding from net face
router.get('/customers/:custId/open-invoices', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const face = sqlInvoiceFaceRial('i');
  const rows = db.prepare(`
    SELECT i.id, i.num, i.date, i.type, i.subtotal, i.disc_amt, i.final, i.final_rial,
      ${face} AS amount_rial,
      ${SALES_INV_PAID_SQL} AS paid
    FROM invoices i
    WHERE i.cust_id=? AND ${firmSaleTypeSql('i')}
      AND COALESCE(i.deleted_at,0)=0
      AND COALESCE(i.status,'posted')<>'reversed'
    ORDER BY i.date DESC, i.id DESC
  `).all(req.params.custId);
  res.json(rows.map((r) => allocPickerFields(r, { paid: r.paid })).filter((r) => r.outstanding > 0));
});

/** Purchase invoices for return / allocation pickers — face = after discount (AP). */
router.get('/suppliers/:supplierId/purchase-invoices', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const face = sqlPurchaseFaceRial('p');
  const rows = db.prepare(`
    SELECT p.id, p.num, p.date, p.subtotal, p.disc_amt, p.final,
      ${face} AS amount_rial,
      ${PURCHASE_INV_PAID_SQL} AS paid
    FROM purchase_invoices p
    WHERE p.supplier_id=? AND COALESCE(p.status,'posted')<>'reversed'
    ORDER BY p.date DESC, p.id DESC
  `).all(req.params.supplierId);
  res.json(rows.map((r) => allocPickerFields(r, { paid: r.paid })));
});

// Open purchase invoices for a supplier (payment allocation)
router.get('/suppliers/:supplierId/open-invoices', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const face = sqlPurchaseFaceRial('p');
  const rows = db.prepare(`
    SELECT p.id, p.num, p.date, p.subtotal, p.disc_amt, p.final,
      ${face} AS amount_rial,
      ${PURCHASE_INV_PAID_SQL} AS paid
    FROM purchase_invoices p
    WHERE p.supplier_id=? AND COALESCE(p.status,'posted')<>'reversed'
    ORDER BY p.date DESC, p.id DESC
  `).all(req.params.supplierId);
  res.json(rows.map((r) => allocPickerFields(r, { paid: r.paid })).filter((r) => r.outstanding > 0));
});

// Payables per purchase invoice (mirror receivables/by-invoice)
router.get('/payables/by-invoice', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const face = sqlPurchaseFaceRial('p');
  const rows = db.prepare(`
    SELECT p.id, p.num, p.date, ${face} AS final, ${face} AS amount_rial,
      p.supplier_id, s.name as supplier_name,
      COALESCE(sp.paid_sup, 0) + COALESCE(ep.paid_exp, 0) + COALESCE(pr.returns_gross, 0) + COALESCE(rca.alloc_gross, 0) as paid
    FROM purchase_invoices p
    JOIN suppliers s ON p.supplier_id=s.id
    LEFT JOIN (
      SELECT purchase_invoice_id, SUM(amount) as paid_sup FROM supplier_payments
      WHERE purchase_invoice_id IS NOT NULL AND COALESCE(status,'posted')<>'reversed'
      GROUP BY purchase_invoice_id
    ) sp ON sp.purchase_invoice_id=p.id
    LEFT JOIN (
      SELECT purchase_invoice_id, SUM(amount) as paid_exp FROM expense_payments
      WHERE purchase_invoice_id IS NOT NULL AND COALESCE(status,'posted')<>'reversed'
      GROUP BY purchase_invoice_id
    ) ep ON ep.purchase_invoice_id=p.id
    LEFT JOIN (
      SELECT purchase_invoice_id, SUM(COALESCE(amount,0) + COALESCE(vat_amount,0)) as returns_gross
      FROM purchase_returns
      WHERE purchase_invoice_id IS NOT NULL AND COALESCE(status,'posted')<>'reversed'
      GROUP BY purchase_invoice_id
    ) pr ON pr.purchase_invoice_id=p.id
    LEFT JOIN (
      SELECT invoice_id, SUM(amount_rial) as alloc_gross FROM return_credit_allocations
      WHERE side='purchase' AND COALESCE(status,'posted')<>'reversed'
      GROUP BY invoice_id
    ) rca ON rca.invoice_id=p.id
    WHERE COALESCE(p.status,'posted')<>'reversed'
    ORDER BY p.date DESC, p.id DESC
    LIMIT 500
  `).all();
  rows.forEach(r => { r.outstanding = (r.final || 0) - (r.paid || 0); });
  res.json(rows.filter(r => Math.abs(r.outstanding) > 0.0001));
});

// Journal entries with lines (paginated, date-filtered, search by doc#)
// Default: hide soft-voided + technical هم‌ترازی / [ابطال] leftovers (v400).
// Audit: include_audit=1 (admin/accounting) shows those descriptions too.
router.get('/journal', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { from, to, page = '1', ref_type, q } = req.query;
  const includeAudit = req.query.include_audit === '1'
    || req.query.include_audit === 'true'
    || req.query.show_audit === '1';
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  // Default 200; cap 500 — UI pages through until total is reached (no hard 50 ceiling).
  const limitRaw = parseInt(req.query.limit, 10);
  const limit = Math.min(500, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 200));
  const offset = (pageNum - 1) * limit;
  const where = [], params = [];
  if (from) { where.push('je.entry_date >= ?'); params.push(from); }
  if (to)   { where.push('je.entry_date <= ?'); params.push(to); }
  if (ref_type) {
    const types = String(ref_type).split(',').map(s => s.trim()).filter(Boolean);
    if (types.length === 1) { where.push('je.ref_type = ?'); params.push(types[0]); }
    else if (types.length > 1) {
      where.push(`je.ref_type IN (${types.map(() => '?').join(',')})`);
      params.push(...types);
    }
  }
  // Search by document number: internal id (#329) and/or voucher_number label.
  const qRaw = String(q == null ? '' : q).trim();
  if (qRaw) {
    const needle = qRaw
      .replace(/[۰-۹]/g, (ch) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(ch)))
      .replace(/[٠-٩]/g, (ch) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(ch)))
      .replace(/^#+/, '')
      .trim();
    if (needle) {
      if (/^\d+$/.test(needle)) {
        where.push('(je.id = ? OR IFNULL(je.voucher_number,\'\') = ? OR IFNULL(je.voucher_number,\'\') LIKE ?)');
        params.push(Number(needle), needle, '%' + needle + '%');
      } else {
        where.push('(CAST(je.id AS TEXT) LIKE ? OR IFNULL(je.voucher_number,\'\') LIKE ?)');
        const like = '%' + needle + '%';
        params.push(like, like);
      }
    }
  }
  where.push('COALESCE(je.deleted_at,0)=0');
  if (!includeAudit) {
    where.push("COALESCE(je.status,'posted')<>'reversed'");
    // Hide technical alignment vouchers and leftover void titles from operational list.
    // char(8204)=ZWNJ so «هم‌ترازی» / «هم ترازی» / «همترازی» all match.
    where.push(
      "REPLACE(REPLACE(IFNULL(je.description,''), char(8204), ''), ' ', '') NOT LIKE '%همترازی%'"
    );
    where.push("TRIM(IFNULL(je.description,'')) NOT LIKE 'ابطال%'");
    where.push("TRIM(IFNULL(je.description,'')) NOT LIKE '[ابطال%'");
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM journal_entries je ${whereSql}`).get(...params).c;
  const entries = db.prepare(`
    SELECT je.*, u.name as created_by_name FROM journal_entries je
    LEFT JOIN users u ON je.created_by=u.id
    ${whereSql} ORDER BY je.entry_date DESC, je.id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const ids = entries.map(e => e.id);
  const lines = ids.length
    ? db.prepare(`SELECT * FROM journal_lines WHERE entry_id IN (${ids.join(',')}) ORDER BY entry_id,id`).all()
    : [];
  entries.forEach(e => { e.lines = lines.filter(l => l.entry_id === e.id); });
  res.json({ entries, total, page: pageNum, limit, include_audit: !!includeAudit });
});

// Customer account statement (JSON) — filters: from, to, type
router.get('/statement/:customerId', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { from, to, type } = req.query;
  const safeDate = v => (v && /^[\d/]+$/.test(v)) ? v : undefined;
  const data = buildStatement(db, req.params.customerId, { from: safeDate(from), to: safeDate(to), type: type || undefined });
  if (!data) return res.status(404).json({ error: 'مشتری یافت نشد' });
  res.json(data);
});

// Customer account statement export — format: excel | csv | pdf
router.get('/statement/:customerId/export', auth, adminOrAccounting, async (req, res) => {
  const db = getDB();
  const { from, to, type, format = 'excel' } = req.query;
  const safeDate = v => (v && /^[\d/]+$/.test(v)) ? v : undefined;
  const data = buildStatement(db, req.params.customerId, { from: safeDate(from), to: safeDate(to), type: type || undefined });
  if (!data) return res.status(404).json({ error: 'مشتری یافت نشد' });
  const faNum = n => Number(n || 0).toLocaleString('fa-IR');
  const rows = data.entries.map(e => ({
    'تاریخ': e.date || '', 'نوع تراکنش': e.type_label, 'شرح': e.description || '',
    'بدهکار (ریال)': e.debit || 0, 'بستانکار (ریال)': e.credit || 0,
    'مانده (ریال)': e.running_balance || 0, 'مرجع': e.reference || '', 'ثبت‌کننده': e.user_name || ''
  }));

  if (format === 'csv') {
    const headers = Object.keys(rows[0] || { 'تاریخ': '', 'نوع تراکنش': '', 'شرح': '', 'بدهکار (ریال)': '', 'بستانکار (ریال)': '', 'مانده (ریال)': '', 'مرجع': '', 'ثبت‌کننده': '' });
    const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = [headers.join(',')];
    for (const r of rows) lines.push(headers.map(h => esc(r[h])).join(','));
    lines.push('');
    lines.push([esc('مانده اول دوره (دفتر مشتری)'), '', '', '', '', esc(data.opening)].join(','));
    lines.push([esc('جمع دوره'), '', '', esc(data.totalDebit), esc(data.totalCredit), esc(data.closing)].join(','));
    lines.push([esc('مانده نهایی (دفتر مشتری)'), '', '', '', '', esc(data.closing)].join(','));
    if (data.gl_account_code) {
      lines.push([esc('مانده دفتر کل تفصیلی'), '', '', '', '', esc(data.gl_closing_rial)].join(','));
    }
    if (data.books_mismatch) {
      lines.push([esc('هشدار: دفتر کل تفصیلی تاریخچه کامل را ندارد — عدد اصلی از دفتر مشتری است'), '', '', '', '', esc(Math.abs(Number(data.closing) - Number(data.gl_closing_rial)))].join(','));
    }
    res.setHeader('Content-Disposition', `attachment; filename=statement-${data.customer.id}.csv`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.send('﻿' + lines.join('\n')); // BOM for Excel UTF-8
  }

  if (format === 'pdf') {
    // Printable HTML — user prints to PDF from the browser
    const rowsHtml = data.entries.map((e, i) => `
      <tr>
        <td>${faNum(i + 1)}</td><td>${escapeHtml(e.date || '-')}</td><td>${escapeHtml(e.type_label)}</td>
        <td class="description">${escapeHtml(e.description || '-')}</td>
        <td>${e.debit > 0 ? faNum(e.debit) : '-'}</td>
        <td>${e.credit > 0 ? faNum(e.credit) : '-'}</td>
        <td>${faNum(Math.abs(e.running_balance || 0))} ${(e.running_balance || 0) > 0 ? 'بد' : 'بس'}</td>
      </tr>`).join('');
    const company = escapeHtml((db.prepare("SELECT value FROM settings WHERE key='company_name'").get() || {}).value || 'پوشاک ترنم');
    const customerBiz = escapeHtml(data.customer.biz);
    const customerOwner = escapeHtml(data.customer.owner || '-');
    const customerSalesperson = escapeHtml(data.customer.salesperson || '-');
    const customerCity = escapeHtml(data.customer.city || '-');
    const customerPhone = escapeHtml(data.customer.phone || '-');
    const html = `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="UTF-8">
<title>صورت‌حساب ${customerBiz}</title>
<link href="/vendor/vazirmatn/vazirmatn.css" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:'Vazirmatn',sans-serif}
body{background:#f3f4f6;color:#1f2937;padding:20px;font-size:12px}
.sheet{max-width:900px;margin:0 auto;background:#fff;padding:28px;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
.head{display:flex;justify-content:space-between;border-bottom:3px solid #1A5C38;padding-bottom:14px;margin-bottom:16px}
h1{font-size:20px;color:#1A5C38}.sub{color:#6b7280;font-size:12px;margin-top:4px}
.info{display:flex;gap:24px;margin-bottom:14px;font-size:13px}.info b{color:#1A5C38}
table{width:100%;border-collapse:collapse;margin-top:8px}
th,td{border:1px solid #e5e7eb;padding:7px 6px;text-align:center}
.description{text-align:right}.brand{display:flex;align-items:center;gap:14px}.brand img{height:58px}.head-meta{text-align:left}
thead th{background:#1A5C38;color:#fff}tbody tr:nth-child(even){background:#f4f7f5}
.tot{margin-top:14px;margin-right:auto;width:320px;font-size:13px}
.tot .l{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed #e5e7eb}
.tot .f{font-weight:800;color:#1A5C38;border:none;font-size:15px;padding-top:8px}
.pbtn{display:block;margin:18px auto 0;background:#1A5C38;color:#fff;border:none;padding:10px 28px;border-radius:8px;font-size:14px;cursor:pointer}
@media print{body{background:#fff;padding:0}.sheet{box-shadow:none}.pbtn{display:none}@page{size:A4;margin:10mm}}
</style></head><body><div class="sheet">
<div class="head"><div class="brand"><img src="/logo-sm.png" alt="لوگو"><div><h1>صورت‌حساب مشتری</h1><div class="sub">${company}</div></div></div>
<div class="head-meta"><div><b>مشتری:</b> ${customerBiz}</div><div><b>کارشناس:</b> ${customerSalesperson}</div>${(from || to) ? `<div><b>دوره:</b> ${escapeHtml(from || '...')} تا ${escapeHtml(to || '...')}</div>` : ''}</div></div>
<div class="info"><div><b>نام کامل:</b> ${customerOwner}</div><div><b>شهر:</b> ${customerCity}</div><div><b>تلفن:</b> ${customerPhone}</div></div>
<table><thead><tr><th>ردیف</th><th>تاریخ</th><th>نوع</th><th>شرح</th><th>بدهکار</th><th>بستانکار</th><th>مانده</th></tr></thead>
<tbody>${rowsHtml || '<tr><td colspan="7">تراکنشی ثبت نشده</td></tr>'}</tbody></table>
<div class="tot">
<div class="l"><span>مانده اول دوره (دفتر مشتری)</span><span>${faNum(Math.abs(data.opening))} ${data.opening > 0 ? 'بدهکار' : 'بستانکار'}</span></div>
<div class="l"><span>جمع بدهکار دوره</span><span>${faNum(data.totalDebit)} ت</span></div>
<div class="l"><span>جمع بستانکار دوره</span><span>${faNum(data.totalCredit)} ت</span></div>
<div class="l f"><span>مانده نهایی (دفتر مشتری)</span><span>${faNum(Math.abs(data.closing))} ${data.closing > 0 ? 'بدهکار' : 'بستانکار'}</span></div>
${data.gl_account_code ? `<div class="l"><span>مانده دفتر کل تفصیلی</span><span>${faNum(Math.abs(data.gl_closing_rial || 0))} ${(data.gl_closing_rial || 0) > 0 ? 'بدهکار' : 'بستانکار'}</span></div>` : ''}
${data.books_mismatch ? `<div class="l" style="color:#b45309"><span>هشدار: عدد اصلی دفتر مشتری است</span><span>${faNum(Math.abs(Number(data.closing) - Number(data.gl_closing_rial || 0)))}</span></div>` : ''}
</div>
<button class="pbtn" type="button" data-print>چاپ / ذخیره PDF 🖨️</button>
</div><script src="/print-page.js"></script></body></html>`;
    return sendSecureHtml(res, html, { allowPrintScript: true });
  }

  // default: excel
  const wb = XLSX.utils.book_new();
  const sheetData = [...rows,
    {},
    { 'تاریخ': 'مانده اول دوره (دفتر مشتری)', 'مانده (ریال)': data.opening },
    { 'تاریخ': 'جمع دوره', 'بدهکار (ریال)': data.totalDebit, 'بستانکار (ریال)': data.totalCredit, 'مانده (ریال)': data.closing },
    { 'تاریخ': 'مانده نهایی (دفتر مشتری)', 'مانده (ریال)': data.closing },
  ];
  if (data.gl_account_code) {
    sheetData.push({ 'تاریخ': 'مانده دفتر کل تفصیلی', 'مانده (ریال)': data.gl_closing_rial });
  }
  if (data.books_mismatch) {
    sheetData.push({
      'تاریخ': 'هشدار: دفتر کل تفصیلی تاریخچه کامل را ندارد — عدد اصلی از دفتر مشتری است',
      'مانده (ریال)': Math.abs(Number(data.closing) - Number(data.gl_closing_rial || 0)),
    });
  }
  const ws = XLSX.utils.json_to_sheet(sheetData);
  ws['!cols'] = [14, 14, 30, 16, 16, 16, 14, 16].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'صورت‌حساب');
  const buf = await XLSX.write(wb);
  res.setHeader('Content-Disposition', `attachment; filename=statement-${data.customer.id}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Manually re-sync accounting entries for all prior operations (idempotent).
router.post('/backfill', auth, adminOnly, centralOnly, (req, res) => {
  const db = getDB();
  // clear the one-time flag so the routine re-scans; existence checks prevent duplicates
  db.prepare("INSERT INTO settings (key,value) VALUES ('accounting_backfill_v1','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
  backfillAccounting(db);
  audit(req.user.id, 'backfill', 'accounting', null, 'همگام‌سازی حسابداری عملیات گذشته');
  res.json({ ok: true });
});

// ============================================================
// Sales returns — customer sends goods back; restocks inventory,
// credits the customer's receivable, reverses revenue (contra account 4102)
// ============================================================
router.get('/sales-returns', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT sr.*, c.biz as cust_biz FROM sales_returns sr
    LEFT JOIN customers c ON sr.cust_id=c.id
    WHERE COALESCE(sr.status,'posted')<>'reversed' ORDER BY sr.date DESC, sr.id DESC
  `).all();
  res.json(rows.map(r => {
    let parsed = [];
    try { parsed = JSON.parse(r.rows || '[]'); } catch (_) { parsed = []; }
    return { ...r, rows: parsed };
  }));
});

// Invoice-linked return picker: given a final sales invoice, return each line
// item with its original price/discount and how much of it is still
// returnable (original qty minus whatever has already been returned against
// this same invoice).
router.get('/sales-returns/available/:invoiceId', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const excludeReturnId = req.query.exclude_return_id
      ? parseInt(req.query.exclude_return_id, 10)
      : null;
    const { getInvoiceReturnablePack } = require('../lib/sales-return-doc');
    res.json(getInvoiceReturnablePack(db, req.params.invoiceId, { excludeReturnId }));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'خطا', code: e.code });
  }
});

router.post('/sales-returns', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  try {
    const { createSalesReturn } = require('../lib/sales-return-doc');
    const out = createSalesReturn(db, req.body || {}, req.user);
    audit(req.user.id, 'create', 'sales_return', out.id, `برگشت از فروش به مبلغ ${out.amount}`);
    res.json({ id: out.id, ok: true });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

/** R13 Edit ⇒ reverse all create effects, re-post on same id (customer locked). */
router.put('/sales-returns/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  try {
    const { updateSalesReturn } = require('../lib/sales-return-doc');
    const out = updateSalesReturn(db, req.params.id, req.body || {}, req.user);
    audit(req.user.id, 'amend', 'sales_return', out.id, `ویرایش برگشت از فروش به مبلغ ${out.amount}`);
    res.json(out);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.get('/sales-returns/reason-codes', auth, adminOrAccounting, (_req, res) => {
  const { REASON_CODES } = require('../lib/return-credit-allocate');
  res.json(REASON_CODES);
});

router.get('/sales-returns/:id/allocations', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM sales_returns WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const {
    listAllocationsForReturn, unallocatedGrossRial, returnGrossRial, SIDE_SALES,
  } = require('../lib/return-credit-allocate');
  res.json({
    return_id: row.id,
    invoice_id: row.invoice_id,
    gross_rial: returnGrossRial(row),
    unallocated_rial: row.invoice_id ? 0 : unallocatedGrossRial(db, SIDE_SALES, row),
    allocations: listAllocationsForReturn(db, SIDE_SALES, row.id),
  });
});

router.post('/sales-returns/:id/allocate', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  try {
    const { allocateReturnCredit, SIDE_SALES } = require('../lib/return-credit-allocate');
    const body = req.body || {};
    const allocations = Array.isArray(body.allocations)
      ? body.allocations
      : (body.invoice_id ? [{ invoice_id: body.invoice_id, amount_rial: body.amount_rial || body.amount }] : []);
    const out = allocateReturnCredit(db, {
      side: SIDE_SALES,
      returnId: parseInt(req.params.id, 10),
      allocations,
      userId: req.user.id,
      note: body.note || '',
    });
    audit(req.user.id, 'allocate', 'sales_return', req.params.id, `تخصیص اعتبار برگشت به ${out.recomputed.length} فاکتور`);
    res.json({ ok: true, ...out });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.delete('/sales-returns/:id/allocations/:allocId', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  try {
    const { reverseAllocation, SIDE_SALES } = require('../lib/return-credit-allocate');
    const out = reverseAllocation(db, {
      side: SIDE_SALES,
      allocId: parseInt(req.params.allocId, 10),
      userId: req.user.id,
    });
    audit(req.user.id, 'void_allocate', 'sales_return', req.params.id, `ابطال تخصیص #${req.params.allocId}`);
    res.json(out);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

/** رسید برگشت به انبار — برگه عملیاتی بدون مبلغ */
router.get('/sales-returns/:id/warehouse-slip', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare(`
    SELECT sr.*, c.biz AS cust_biz, u.name AS recorder, i.num AS invoice_num
    FROM sales_returns sr
    LEFT JOIN customers c ON c.id=sr.cust_id
    LEFT JOIN users u ON u.id=sr.user_id
    LEFT JOIN invoices i ON i.id=sr.invoice_id
    WHERE sr.id=?
  `).get(req.params.id);
  if (!row) return res.status(404).send('برگشت فروش یافت نشد');
  if (row.status === 'reversed') return res.status(400).send('این برگشت ابطال شده است');
  const paperQ = String(req.query.paper || 'A4').toUpperCase();
  const paper = paperQ === 'A5' ? 'A5' : 'A4';
  try {
    const { buildSalesReturnSlip, companySettings } = require('../lib/warehouse-slip-print');
    const getSetting = (d, key) => {
      const r = d.prepare('SELECT value FROM settings WHERE key=?').get(key);
      return r ? r.value : '';
    };
    const html = buildSalesReturnSlip(db, row, companySettings(db, getSetting), paper);
    return sendSecureHtml(res, html, { allowPrintScript: true });
  } catch (e) {
    console.error('sales-return warehouse-slip:', e && e.message);
    return res.status(500).send('خطا در ساخت رسید برگشت انبار');
  }
});

router.delete('/sales-returns/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  try {
    const { voidSalesReturn } = require('../lib/sales-return-doc');
    voidSalesReturn(db, req.params.id, req.user);
    audit(req.user.id, 'void', 'sales_return', req.params.id, 'ابطال برگشت از فروش');
    res.json({ ok: true });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

// ============================================================
// Manual journal vouchers — double-entry, must balance exactly.
// A line can target either a raw chart-of-accounts code (l.code) or a
// specific Person (l.person_id) — the latter posts to the generic 1106
// control account in the journal while also recording the movement in
// that person's own ledger, mirroring how customer/supplier sub-ledgers
// work against their own control accounts (1103/2101).
// ============================================================
function validateAndBuildVoucherLines(db, lines) {
  let totalDebit = 0, totalCredit = 0;
  const cleanLines = [];
  const personPostings = [];
  const { resolvePersonIdFromVoucherLine } = require('../lib/party-turnover');
  for (const l of (lines || [])) {
    const debitParsed = parseVoucherAmount(l.debit);
    const creditParsed = parseVoucherAmount(l.credit);
    if (debitParsed.error) return debitParsed;
    if (creditParsed.error) return creditParsed;
    const debit = debitParsed.value;
    const credit = creditParsed.value;
    if (debit && credit) return { error: 'هر ردیف فقط باید بدهکار یا بستانکار باشد، نه هر دو' };
    if (!debit && !credit) continue;
    const wantsPerson = !!(l.person_id || l.party_id || l.target_type === 'person');
    if (wantsPerson) {
      const resolvedId = resolvePersonIdFromVoucherLine(db, l);
      const person = resolvedId ? db.prepare('SELECT * FROM persons WHERE id=?').get(resolvedId) : null;
      if (!person) {
        return { error: `شخص با شناسه ${l.person_id || l.party_id || '—'} یافت نشد — از فهرست اشخاص انتخاب کنید` };
      }
      // Prefer leaf tafsili when present; otherwise misc-persons control (1106).
      let personAccount = null;
      if (person.coa_code) {
        personAccount = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(person.coa_code);
      }
      if (!personAccount) {
        const party = person.party_id
          ? db.prepare('SELECT coa_code FROM parties WHERE id=?').get(person.party_id)
          : null;
        if (party && party.coa_code) {
          personAccount = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(party.coa_code);
        }
      }
      if (!personAccount) personAccount = coaAcct(db, 'coa_misc_persons');
      cleanLines.push({
        code: personAccount.code, name: personAccount.name, debit, credit,
        description: l.description || person.name, detail_account_id: l.detail_account_id || null,
        cost_center_id: l.cost_center_id || null, project_id: l.project_id || null, tax_type: l.tax_type || null,
        tafsili2_code: l.tafsili2_code || null,
      });
      personPostings.push({ person_id: person.id, debit, credit, description: l.description || '' });
    } else {
      // System fee/interest controls (6115/6114/4115) may have gained معین
      // children in live books — coerce to healed leaf before postable guard.
      const { coerceSystemPostableCode } = require('../lib/coa-map');
      const lineCode = coerceSystemPostableCode(db, l.code);
      const posted = assertPostableAccount(db, lineCode);
      if (posted.error) return posted;
      const acc = posted.acc;
      cleanLines.push({
        code: acc.code, name: acc.name, debit, credit, description: l.description || '',
        detail_account_id: l.detail_account_id || null, cost_center_id: l.cost_center_id || null,
        project_id: l.project_id || null, tax_type: l.tax_type || null,
        tafsili2_code: l.tafsili2_code || null,
      });
    }
    totalDebit += debit; totalCredit += credit;
  }
  if (cleanLines.length < 2) return { error: 'سند باید حداقل دو ردیف معتبر داشته باشد' };
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    return { error: `سند نامتوازن است: بدهکار ${totalDebit.toLocaleString('fa-IR')} ≠ بستانکار ${totalCredit.toLocaleString('fa-IR')}` };
  }
  return { cleanLines, personPostings };
}

/** لیست پرداخت‌های خروجی مبتنی بر سند (شخص / حساب) — مکمل supplier/incentive/expense */
router.get('/cash-ops/outgoing', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { listCashOpsOutgoing } = require('../lib/cash-ops-list');
  const limit = parseInt(req.query.limit, 10);
  res.json(listCashOpsOutgoing(db, { limit: Number.isFinite(limit) ? limit : 300 }));
});

/** دریافت از شخص/حساب (سند) — مکمل settlements مشتری */
router.get('/cash-ops/incoming-extra', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { listCashOpsIncomingExtra } = require('../lib/cash-ops-list');
  const limit = parseInt(req.query.limit, 10);
  res.json(listCashOpsIncomingExtra(db, { limit: Number.isFinite(limit) ? limit : 300 }));
});

/**
 * In-place amend of cash-ops vouchers (پرداخت به شخص / پرداخت به حساب).
 * Same JE id + voucher_number; rewrites GL + party books.
 */
router.put('/vouchers/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const id = +req.params.id;
  const entry = db.prepare(`
    SELECT id, ref_type, doc_type, description FROM journal_entries
    WHERE id=? AND COALESCE(deleted_at,0)=0 AND COALESCE(status,'posted') NOT IN ('reversed','void')
  `).get(id);
  if (!entry) return res.status(404).json({ error: 'سند یافت نشد' });
  try {
    const {
      amendPersonVoucherPayment, amendAccountPayment,
    } = require('../lib/amend-cash-ops');
    let out;
    if (entry.ref_type === 'manual_voucher') {
      if (!isPersonPaymentVoucher(db, entry)) {
        return res.status(400).json({
          error: 'این سند دستی پرداخت به شخص نیست. سندهای مبهم خودکار به پرداخت تبدیل نمی‌شوند.',
          code: 'E_NOT_PERSON_PAYMENT',
        });
      }
      out = db.transaction(() => amendPersonVoucherPayment(db, id, req.body || {}, req.user.id))();
    } else if (entry.ref_type === 'account_payment') {
      out = db.transaction(() => amendAccountPayment(db, id, req.body || {}, req.user.id))();
    } else {
      return res.status(400).json({
        error: 'فقط پرداخت به شخص یا پرداخت به حساب از این مسیر اصلاح می‌شود',
        code: 'E_VOUCHER_KIND',
      });
    }
    audit(req.user.id, 'update', entry.ref_type, out.id, out.summary);
    res.json({ ok: true, id: out.id, amount: out.amount, journal_id: out.journal_id });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('amend voucher', e);
    res.status(status).json({ error: e.message || 'اصلاح سند ناموفق بود', code: e.code });
  }
});

function postManualVoucher(db, user, body, opts) {
  const options = opts || {};
  const { date, description, doc_type, cost_center_id, lines, voucher_type } = body || {};
  if (!Array.isArray(lines) || lines.length < 2) {
    const err = new Error('سند باید حداقل دو ردیف (بدهکار و بستانکار) داشته باشد');
    err.status = 400;
    throw err;
  }
  const typed = normalizeDocType(doc_type || voucher_type || 'manual');
  if (typed.error) {
    const err = new Error(typed.error);
    err.status = 400;
    err.code = typed.code;
    throw err;
  }
  const built = validateAndBuildVoucherLines(db, lines);
  if (built.error) {
    const err = new Error(built.error);
    err.status = 400;
    err.code = built.code;
    throw err;
  }
  const requestKey = String(body.client_request_id || '').trim().slice(0, 80);
  if (requestKey) {
    const prev = db.prepare(`
      SELECT id, voucher_number, status, deleted_at FROM journal_entries WHERE client_request_id=?
    `).get(requestKey);
    const alive = prev
      && !Number(prev.deleted_at)
      && !['reversed', 'void'].includes(String(prev.status || 'posted'));
    if (alive) return { id: prev.id, voucher_number: prev.voucher_number || null, ok: true, replayed: true };
    if (prev) db.prepare('UPDATE journal_entries SET client_request_id=NULL WHERE id=?').run(prev.id);
  }

  const rawType = typed.value;
  const OPENING_TYPES = new Set(['opening', 'افتتاحیه', 'opening_balance', 'مانده اول دوره', 'beginning_inventory', 'موجودی اول دوره', 'fiscal_opening']);
  const isOpening = OPENING_TYPES.has(rawType);
  const fromExcel = !!options.excelTrusted;
  // Excel-imported opening docs → opening+auto; pure manual form → manual; excel non-opening → auto
  let voucherType = 'manual';
  let sourceType = 'manual_voucher';
  if (isOpening) {
    voucherType = 'opening';
    sourceType = rawType.includes('inventory') || rawType.includes('موجودی') ? 'opening_inventory' : 'opening_balance';
  } else if (fromExcel) {
    voucherType = 'auto';
    sourceType = 'excel_import';
  }

  const entryId = db.transaction(() => {
    const entryId = postToLedger(db, {
      sourceType, sourceId: null, date: date || todayJalali(),
      description: description || (isOpening ? 'سند افتتاحیه' : (fromExcel ? 'سند وارداتی اکسل' : 'سند دستی')),
      createdBy: user.id,
      voucherType,
      srcSystem: fromExcel ? 'excel' : null,
      docType: rawType || null,
      costCenterId: cost_center_id || null,
      lines: built.cleanLines.map(l => ({
        ...l, debit: rialToLedger(l.debit), credit: rialToLedger(l.credit),
      })),
    });
    // Stamp self ref_id so party-turnover can XOR-dedup person_ledger against GL (same as account-payments)
    try { db.prepare('UPDATE journal_entries SET ref_id=? WHERE id=? AND (ref_id IS NULL OR ref_id=0)').run(entryId, entryId); } catch (_) {}
    db.prepare('UPDATE journal_entries SET doc_type=? WHERE id=?').run(rawType, entryId);
    if (requestKey) {
      db.prepare('UPDATE journal_entries SET client_request_id=? WHERE id=?').run(requestKey, entryId);
    }
    for (const p of built.personPostings) {
      createPersonLedgerEntry(db, {
        person_id: p.person_id, date: date || '', entry_type: sourceType, ref_type: sourceType, ref_id: entryId,
        description: p.description || description || 'سند', debit: p.debit, credit: p.credit, user_id: user.id
      });
    }
    mirrorManualVoucherToCustomers(db, user, {
      entryId, date: date || '', description, sourceType, lines: built.cleanLines, personPostings: built.personPostings,
    });
    return entryId;
  })();
  const posted = db.prepare('SELECT voucher_number FROM journal_entries WHERE id=?').get(entryId);
  return { id: entryId, voucher_number: posted && posted.voucher_number, ok: true, replayed: false };
}

function mirrorManualVoucherToCustomers(db, user, opts) {
  if (opts.sourceType !== 'manual_voucher') return;
  const { createLedgerEntry } = require('../db');
  const { refreshCustomerBalanceFromLedger } = require('../lib/opening-post');
  const seen = new Set();
  const lineCodes = new Set(
    (opts.lines || []).map((l) => (l && l.code != null ? String(l.code).trim() : '')).filter(Boolean)
  );
  const post = (customerId, debit, credit, lineDesc) => {
    const key = customerId + ':' + debit + ':' + credit + ':' + (lineDesc || '');
    if (seen.has(key)) return;
    seen.add(key);
    createLedgerEntry(db, {
      customer_id: customerId,
      date: opts.date,
      entry_type: 'journal',
      ref_type: 'manual_voucher',
      ref_id: opts.entryId,
      description: lineDesc || opts.description || 'سند دستی',
      debit, credit,
      user_id: user.id,
    });
    refreshCustomerBalanceFromLedger(db, customerId);
  };
  // v536: only mirror onto a customer book when the voucher actually hits that
  // customer's leaf. Dual-role person payments (Dr person 1106…) must not inflate AR.
  for (const p of opts.personPostings || []) {
    const person = db.prepare('SELECT party_id, name, coa_code FROM persons WHERE id=?').get(p.person_id);
    if (!person || !person.party_id) continue;
    const custs = db.prepare('SELECT id, coa_code FROM customers WHERE party_id=?').all(person.party_id);
    for (const c of custs) {
      const coa = c.coa_code ? String(c.coa_code).trim() : '';
      if (!coa || !lineCodes.has(coa)) continue;
      post(c.id, p.debit, p.credit, p.description || person.name);
    }
  }
  for (const line of opts.lines || []) {
    if (!line.code) continue;
    const custs = db.prepare('SELECT id FROM customers WHERE coa_code=?').all(line.code);
    for (const c of custs) post(c.id, line.debit, line.credit, line.description || line.name);
  }
}

function postPartyPersonPayments(db, user, body) {
  const spec = assertOutboundPayment(db, body || {});
  const partyId = parseInt(body && body.party_id, 10);
  if (!partyId) {
    const err = new Error('شخص را انتخاب کنید');
    err.status = 400;
    err.code = 'E_PERSON';
    throw err;
  }
  const { resolvePersonIdFromVoucherLine } = require('../lib/party-turnover');
  const personId = resolvePersonIdFromVoucherLine(db, { party_id: partyId, target_type: 'person' });
  const person = personId ? db.prepare('SELECT * FROM persons WHERE id=?').get(personId) : null;
  if (!person) {
    const err = new Error('شخص در فهرست اشخاص یافت نشد');
    err.status = 400;
    err.code = 'E_PERSON';
    throw err;
  }
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
  if (!personAccount) personAccount = coaAcct(db, 'coa_misc_persons');
  const feeCcId = resolveFeeCostCenterId(db, {
    feeRial: spec.fee, payType: spec.payType,
    feeCostCenterId: parseFeeCostCenterInput(body),
    documentCostCenterId: body.cost_center_id,
  });
  return withPaymentIdempotency(db, {
    key: body.idempotency_key, userId: user.id, path: '/api/accounting/vouchers#person_payment', body,
  }, () => {
    assertOutboundPayment(db, body || {});
    const ids = [];
    const cash = cashAccountForSource(db, spec);
    const note = body.note || body.description || 'پرداخت به شخص';
    spec.amounts.forEach((amount, i) => {
      const fee = i === 0 ? spec.fee : 0;
      const { lines } = outboundPaymentLines(db, {
        amount, feeRial: fee, payType: spec.payType,
        dest: personAccount, cash, destDescription: 'پرداخت به شخص',
        feeCostCenterId: i === 0 ? feeCcId : null,
      });
      const entryId = postToLedger(db, {
        sourceType: 'manual_voucher', sourceId: null,
        date: spec.date, description: note, createdBy: user.id,
        voucherType: 'manual', docType: 'person_payment',
        costCenterId: feeCcId || body.cost_center_id || null,
        lines,
      });
      db.prepare('UPDATE journal_entries SET ref_id=?, doc_type=? WHERE id=?').run(entryId, 'person_payment', entryId);
      createPersonLedgerEntry(db, {
        person_id: person.id, date: spec.date, entry_type: 'manual_voucher',
        ref_type: 'manual_voucher', ref_id: entryId,
        description: 'پرداخت به شخص', debit: amount, credit: 0, user_id: user.id,
      });
      ids.push(entryId);
    });
    return { id: ids[0], ids, ok: true, fee_rial: spec.fee, doc_type: 'person_payment' };
  });
}

router.post('/vouchers', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  try {
    if (String((req.body || {}).doc_type || '').trim() === 'person_payment') {
      const out = postPartyPersonPayments(db, req.user, req.body || {});
      if (!out.replayed) audit(req.user.id, 'create', 'person_payment', out.id, `پرداخت به شخص #${out.id}`);
      return res.json(out);
    }
    const out = postManualVoucher(db, req.user, req.body || {}, { excelTrusted: false });
    if (!out.replayed) audit(req.user.id, 'create', 'journal_voucher', out.id, `ثبت سند: ${(req.body && req.body.description) || ''}`);
    res.json(out);
  } catch (e) {
    if (String(e.message || '').includes('idx_journal_client_request') || String(e.message || '').includes('client_request_id')) {
      const key = String((req.body || {}).client_request_id || '').trim();
      const prev = key ? db.prepare(`
        SELECT id, voucher_number, status, deleted_at FROM journal_entries WHERE client_request_id=?
      `).get(key) : null;
      const alive = prev
        && !Number(prev.deleted_at)
        && !['reversed', 'void'].includes(String(prev.status || 'posted'));
      if (alive) return res.json({ id: prev.id, voucher_number: prev.voucher_number || null, ok: true, replayed: true });
    }
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

/** پرداخت به حساب کدینگ (همه سطوح) — Dr حساب مقصد [+ کارمزد 6115] / Cr صندوق یا بانک */
router.post('/account-payments', auth, adminOrAccounting, (req, res) => {
  const {
    account_code, note, fee_cost_center_id, bank_fee_cost_center_id, cost_center_id,
  } = req.body;
  const code = String(account_code || '').trim();
  if (!code) return res.status(400).json({ error: 'حساب مقصد الزامی است' });
  const db = getDB();
  try {
    const spec = assertOutboundPayment(db, req.body);
    const feeCcId = resolveFeeCostCenterId(db, {
      feeRial: spec.fee, payType: spec.payType,
      feeCostCenterId: parseFeeCostCenterInput({ fee_cost_center_id, bank_fee_cost_center_id }),
      documentCostCenterId: cost_center_id,
    });
    const posted = assertActiveAccount(db, code);
    if (posted.error) return res.status(400).json({ error: posted.error, code: posted.code });
    const dest = posted.acc;
    const out = withPaymentIdempotency(db, {
      key: req.body.idempotency_key, userId: req.user.id, path: '/api/accounting/account-payments', body: req.body,
    }, () => {
      assertOutboundPayment(db, req.body);
      const ids = [];
      const cash = cashAccountForSource(db, spec);
      const desc = note || `پرداخت به حساب ${dest.code} — ${dest.name}`;
      spec.amounts.forEach((amount, i) => {
        const fee = i === 0 ? spec.fee : 0;
        const { lines } = outboundPaymentLines(db, {
          amount, feeRial: fee, payType: spec.payType, dest, cash,
          feeCostCenterId: i === 0 ? feeCcId : null,
        });
        const id = postToLedger(db, {
          sourceType: 'account_payment', sourceId: null,
          date: spec.date, description: desc, createdBy: req.user.id,
          costCenterId: cost_center_id || feeCcId || null,
          lines,
        });
        try { db.prepare('UPDATE journal_entries SET ref_id=? WHERE id=?').run(id, id); } catch (_) {}
        mirrorAccountVoucherToPartyBooks(db, {
          entryId: id, accountCode: dest.code, date: spec.date, amountRial: amount,
          userId: req.user.id, note: desc, direction: 'payment',
        });
        ids.push(id);
      });
      return { id: ids[0], ids, ok: true, fee_rial: spec.fee };
    });
    if (!out.replayed) {
      audit(req.user.id, 'create', 'account_payment', out.id, `پرداخت ${spec.amounts.join('+')} به حساب ${code}`);
      try {
        const { dispatchSmsEvent } = require('../lib/sms-dispatch');
        setImmediate(() => dispatchSmsEvent(db, 'payment.created', {
          name: dest.name, amount: spec.amounts.reduce((a, b) => a + b, 0), date: spec.date, note: note || '', num: dest.code,
          created_by: req.user.id, user: req.user.name,
        }));
      } catch (_) {}
    }
    res.json(out);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('account-payment', e);
    res.status(status).json({ error: e.message || 'ثبت پرداخت به حساب ناموفق بود', code: e.code });
  }
});

/** دریافت از شخص غیرمشتری — نقد/واریز/کارتخوان/چک دریافتنی. مشتری به تسویه برمی‌گردد. */
router.post('/person-receipts', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  try {
    const { postPersonReceipt } = require('../lib/person-receipt');
    const out = withPaymentIdempotency(db, {
      key: req.body && req.body.idempotency_key,
      userId: req.user.id,
      path: '/api/accounting/person-receipts',
      body: req.body,
    }, () => postPersonReceipt(db, req.user, req.body || {}));
    if (!out.replayed) {
      audit(req.user.id, 'create', 'person_receipt', out.id, `دریافت از شخص #${out.id}`);
    }
    res.json(out);
  } catch (e) {
    const status = e.status || 400;
    if (status >= 500) console.error('person-receipt', e);
    res.status(status).json({ error: e.message || 'ثبت دریافت ناموفق بود', code: e.code, cust_id: e.cust_id || null });
  }
});

/** دریافت به حساب کدینگ — Dr صندوق/بانک / Cr حساب مبدأ */
router.post('/account-receipts', auth, adminOrAccounting, (req, res) => {
  const { date, amount, account_code, pay_type, bank_id, cash_box_id, note } = req.body;
  const amt = Math.round(Number(amount) || 0);
  const code = String(account_code || '').trim();
  if (!amt || amt <= 0) return res.status(400).json({ error: 'مبلغ معتبر الزامی است' });
  if (!code) return res.status(400).json({ error: 'حساب مبدأ الزامی است' });
  const db = getDB();
  const {
    requireClientRequestId, findByClientRequestId, isUniqueClientRequestConflict,
  } = require('../lib/client-request-id');
  const { assertJalaliDocDate } = require('../lib/validators');
  let requestKey;
  let when;
  try {
    requestKey = requireClientRequestId(req.body);
    when = assertJalaliDocDate(date, 'تاریخ دریافت') || todayJalali();
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  const priorJe = findByClientRequestId(db, 'journal_entries', requestKey);
  if (priorJe) return res.json({ id: priorJe.id, ok: true, idempotent_replay: true });
  const posted = assertPostableAccount(db, code);
  if (posted.error) return res.status(400).json({ error: posted.error, code: posted.code });
  const src = posted.acc;
  const cash = resolveCashAccount(db, pay_type || 'cash', bank_id, cash_box_id);
  const desc = note || `دریافت از حساب ${src.code} — ${src.name}`;
  let entryId;
  try {
    entryId = db.transaction(() => {
      const id = postToLedger(db, {
        sourceType: 'account_receipt', sourceId: null,
        date: when, description: desc, createdBy: req.user.id,
        lines: [
          { code: cash.code, name: cash.name, debit: rialToLedger(amt), credit: 0 },
          { code: src.code, name: src.name, debit: 0, credit: rialToLedger(amt) }
        ]
      });
      try { db.prepare('UPDATE journal_entries SET ref_id=?, client_request_id=? WHERE id=?').run(id, requestKey, id); } catch (_) {
        db.prepare('UPDATE journal_entries SET client_request_id=? WHERE id=?').run(requestKey, id);
      }
      mirrorAccountVoucherToPartyBooks(db, {
        entryId: id, accountCode: src.code, date: when, amountRial: amt,
        userId: req.user.id, note: desc, direction: 'receipt',
      });
      return id;
    })();
  } catch (e) {
    if (isUniqueClientRequestConflict(e)) {
      const again = findByClientRequestId(db, 'journal_entries', requestKey);
      if (again) return res.json({ id: again.id, ok: true, idempotent_replay: true });
    }
    return res.status(e.status || 400).json({ error: e.message || String(e), code: e.code });
  }
  audit(req.user.id, 'create', 'account_receipt', entryId, `دریافت ${amt} از حساب ${code}`);
  res.json({ id: entryId, ok: true });
});

/**
 * If the COA leaf belongs to a customer/person, mirror into their subledger
 * so گردش / صورت‌حساب immediately reflect «دریافت/پرداخت از حساب».
 */
function mirrorAccountVoucherToPartyBooks(db, { entryId, accountCode, date, amountRial, userId, note, direction }) {
  const code = String(accountCode || '').trim();
  if (!code || !amountRial) return null;
  const isReceipt = direction === 'receipt';
  const cust = db.prepare(
    'SELECT id FROM customers WHERE coa_code=? ORDER BY id LIMIT 1'
  ).get(code);
  if (cust) {
    createLedgerEntry(db, {
      customer_id: cust.id,
      date: date || '',
      entry_type: isReceipt ? 'settlement' : 'journal',
      ref_type: isReceipt ? 'account_receipt' : 'account_payment',
      ref_id: entryId,
      description: note || (isReceipt ? 'دریافت از حساب مشتری' : 'پرداخت به حساب مشتری'),
      debit: isReceipt ? 0 : amountRial,
      credit: isReceipt ? amountRial : 0,
      user_id: userId || null,
    });
    return { kind: 'customer', id: cust.id };
  }
  let person = db.prepare(
    'SELECT id FROM persons WHERE coa_code=? ORDER BY id LIMIT 1'
  ).get(code);
  if (!person) {
    const party = db.prepare('SELECT id FROM parties WHERE coa_code=? LIMIT 1').get(code);
    if (party) {
      try {
        const { ensurePersonForParty } = require('../lib/party-turnover');
        const pid = ensurePersonForParty(db, party.id);
        if (pid) person = { id: pid };
      } catch (_) { /* optional */ }
    }
  }
  if (person) {
    createPersonLedgerEntry(db, {
      person_id: person.id,
      date: date || '',
      entry_type: isReceipt ? 'account_receipt' : 'account_payment',
      ref_type: isReceipt ? 'account_receipt' : 'account_payment',
      ref_id: entryId,
      description: note || (isReceipt ? 'دریافت از شخص' : 'پرداخت به شخص'),
      debit: isReceipt ? 0 : amountRial,
      credit: isReceipt ? amountRial : 0,
      user_id: userId || null,
    });
    return { kind: 'person', id: person.id };
  }
  return null;
}

// Attach a single file (receipt/photo/scan) to a manual voucher
router.post('/vouchers/:id/attachment', auth, adminOrAccounting, voucherUpload.single('file'), (req, res) => {
  const db = getDB();
  const entry = db.prepare("SELECT * FROM journal_entries WHERE id=? AND ref_type='manual_voucher'").get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'سند دستی یافت نشد' });
  if (!req.file) return res.status(400).json({ error: 'فایلی آپلود نشد' });
  const { filename } = persistPrivateUploadWithCommit(req.file, 'vouchers', 'voucher', (storedName) =>
    db.prepare('UPDATE journal_entries SET attachment=? WHERE id=?').run(storedName, req.params.id));
  if (entry.attachment) removeStoredFile('vouchers', entry.attachment);
  res.json({ ok: true, attachment: filename, attachment_url: `/api/accounting/vouchers/${entry.id}/attachment` });
});

router.get('/vouchers/:id/attachment', auth, adminOrAccounting, (req, res) => {
  const entry = getDB().prepare("SELECT attachment FROM journal_entries WHERE id=? AND ref_type='manual_voucher'").get(req.params.id);
  if (!entry || !entry.attachment) return res.status(404).json({ error: 'پیوست سند یافت نشد' });
  return sendPrivateFile(res, 'vouchers', entry.attachment, { inline: false });
});

// ---- Journal templates (recurring entries) ----
router.get('/vouchers/templates', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare('SELECT * FROM journal_templates ORDER BY name').all();
  res.json(rows.map(r => ({ ...r, lines: JSON.parse(r.lines_json || '[]') })));
});
router.post('/vouchers/templates', auth, adminOrAccounting, (req, res) => {
  const { name, description, cost_center_id, lines } = req.body;
  if (!name) return res.status(400).json({ error: 'نام قالب الزامی است' });
  if (!Array.isArray(lines) || lines.length < 2) return res.status(400).json({ error: 'قالب باید حداقل دو ردیف داشته باشد' });
  const db = getDB();
  const cleanLines = lines.map(sanitizeTemplateLine);
  const result = db.prepare('INSERT INTO journal_templates (name,description,lines_json,cost_center_id,created_by) VALUES (?,?,?,?,?)')
    .run(name, description || '', JSON.stringify(cleanLines), cost_center_id || null, req.user.id);
  audit(req.user.id, 'create', 'journal_template', result.lastInsertRowid, `ساخت قالب سند: ${name}`);
  res.json({ id: result.lastInsertRowid, ok: true });
});
router.delete('/vouchers/templates/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  db.prepare('DELETE FROM journal_templates WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Voucher drafts (draft mode — saved but not yet posted to the ledger) ----
router.get('/vouchers/drafts', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT d.*, u.name as created_by_name FROM voucher_drafts d LEFT JOIN users u ON d.created_by=u.id ORDER BY d.created_at DESC
  `).all();
  res.json(rows.map(r => ({ ...r, lines: JSON.parse(r.lines_json || '[]') })));
});
router.post('/vouchers/drafts', auth, adminOrAccounting, (req, res) => {
  const { date, description, cost_center_id, lines } = req.body;
  if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'حداقل یک ردیف لازم است' });
  const db = getDB();
  const result = db.prepare('INSERT INTO voucher_drafts (date,description,lines_json,cost_center_id,created_by) VALUES (?,?,?,?,?)')
    .run(date || '', description || '', JSON.stringify(lines), cost_center_id || null, req.user.id);
  res.json({ id: result.lastInsertRowid, ok: true });
});
router.delete('/vouchers/drafts/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  db.prepare('DELETE FROM voucher_drafts WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
// Posting a draft runs it through the exact same validation/posting path as
// a normal voucher, then removes the draft — maker-checker (۸D): سازنده ≠ ثبت‌کننده.
router.post('/vouchers/drafts/:id/post', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const draft = db.prepare('SELECT * FROM voucher_drafts WHERE id=?').get(req.params.id);
    if (!draft) return res.status(404).json({ error: 'پیش‌نویس یافت نشد' });
    assertMakerChecker(req.user, draft.created_by);
    const lines = JSON.parse(draft.lines_json || '[]');
    const built = validateAndBuildVoucherLines(db, lines);
    if (built.error) return res.status(400).json({ error: built.error, code: built.code });
    const entryId = db.transaction(() => {
      const entryId = postToLedger(db, {
        sourceType: 'manual_voucher', sourceId: null, date: draft.date || todayJalali(),
        description: draft.description || 'سند دستی', createdBy: req.user.id,
        voucherType: 'manual',
        lines: built.cleanLines.map(l => ({
          ...l, debit: rialToLedger(l.debit), credit: rialToLedger(l.credit),
        })),
      });
      if (draft.cost_center_id) db.prepare('UPDATE journal_entries SET cost_center_id=? WHERE id=?').run(draft.cost_center_id, entryId);
      for (const p of built.personPostings) {
        createPersonLedgerEntry(db, {
          person_id: p.person_id, date: draft.date || '', entry_type: 'manual_voucher', ref_type: 'manual_voucher', ref_id: entryId,
          description: p.description || draft.description || 'سند دستی', debit: p.debit, credit: p.credit, user_id: req.user.id
        });
      }
      db.prepare('DELETE FROM voucher_drafts WHERE id=?').run(req.params.id);
      return entryId;
    })();
    audit(req.user.id, 'create', 'journal_voucher', entryId, `ثبت سند از پیش‌نویس: ${draft.description || ''}`);
    res.json({ id: entryId, ok: true });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || 'خطا در ثبت پیش‌نویس', code: e.code });
  }
});

const VOIDABLE_VOUCHER_TYPES = new Set(['manual_voucher', 'account_payment', 'account_receipt']);

router.delete('/vouchers/:id', auth, adminOrAccounting, requirePermission('accounting', 'delete'), (req, res) => {
  const db = getDB();
  const entry = db.prepare(`
    SELECT * FROM journal_entries
    WHERE id=? AND COALESCE(deleted_at,0)=0 AND COALESCE(status,'posted')<>'reversed'
  `).get(req.params.id);
  if (!entry || !VOIDABLE_VOUCHER_TYPES.has(entry.ref_type)) {
    return res.status(404).json({ error: 'سند قابل ابطال یافت نشد' });
  }
  db.transaction(() => {
    reverseJournalEntry(db, entry.id, {
      userId: req.user.id,
      reason: entry.ref_type === 'manual_voucher' ? 'ابطال سند دستی'
        : entry.ref_type === 'account_payment' ? 'ابطال پرداخت به حساب'
        : 'ابطال دریافت از حساب',
      sourceType: entry.ref_type + '_reversal',
    });
    // v373: retire party books — no hollow reverse lines on statements.
    const {
      retireCustomerLedgerByRef, retirePersonLedgerByRef,
    } = require('../lib/party-ledger-retire');
    if (entry.ref_type === 'manual_voucher') {
      retirePersonLedgerByRef(db, {
        refTypes: ['manual_voucher', 'manual_voucher_reversal'],
        refId: Number(req.params.id),
      });
      const touched = db.prepare(`
        SELECT DISTINCT customer_id FROM customer_ledger
        WHERE ref_type='manual_voucher' AND ref_id=?
      `).all(Number(req.params.id));
      retireCustomerLedgerByRef(db, {
        refTypes: ['manual_voucher', 'manual_voucher_reversal'],
        refId: Number(req.params.id),
      });
      const { refreshCustomerBalanceFromLedger } = require('../lib/opening-post');
      for (const row of touched) refreshCustomerBalanceFromLedger(db, row.customer_id);
    }
    if (entry.ref_type === 'account_receipt' || entry.ref_type === 'account_payment') {
      const revType = entry.ref_type + '_reversal';
      retireCustomerLedgerByRef(db, {
        refTypes: [entry.ref_type, revType],
        refId: Number(req.params.id),
      });
      retirePersonLedgerByRef(db, {
        refTypes: [entry.ref_type, revType],
        refId: Number(req.params.id),
      });
    }
  })();
  audit(req.user.id, 'reverse', entry.ref_type, req.params.id, `ابطال ${entry.ref_type} #${req.params.id}`);
  res.json({ ok: true });
});

// T5 — minimal GL account dashboard (period totals + last 10 entries)
router.get('/account-dashboard/:code', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const code = String(req.params.code || '').trim();
  const account = db.prepare('SELECT * FROM chart_of_accounts WHERE code=?').get(code);
  if (!account) return res.status(404).json({ error: 'حساب یافت نشد' });
  const safeDate = v => (v && /^[\d/]+$/.test(v)) ? v : null;
  const from = safeDate(req.query.from);
  const to = safeDate(req.query.to);
  const dateParts = [];
  const dateParams = [];
  if (from) { dateParts.push('je.entry_date >= ?'); dateParams.push(from); }
  if (to) { dateParts.push('je.entry_date <= ?'); dateParams.push(to); }
  const dateSql = dateParts.length ? ' AND ' + dateParts.join(' AND ') : '';
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) AS debit_rial,
      COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) AS credit_rial
    FROM journal_lines jl
    JOIN journal_entries je ON jl.entry_id=je.id
    WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0${dateSql}
  `).get(code, ...dateParams);
  const debitNormal = ['asset', 'expense', 'cogs'].includes(account.type);
  const debit_rial = Math.round(Number(totals.debit_rial) || 0);
  const credit_rial = Math.round(Number(totals.credit_rial) || 0);
  const balance = debitNormal ? (debit_rial - credit_rial) : (credit_rial - debit_rial);
  const recent = db.prepare(`
    SELECT je.id, je.entry_date, je.description, je.ref_type, je.ref_id,
      jl.debit_rial, jl.credit_rial, jl.debit, jl.credit, jl.description AS line_description
    FROM journal_lines jl
    JOIN journal_entries je ON jl.entry_id=je.id
    WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0${dateSql}
    ORDER BY je.entry_date DESC, je.id DESC
    LIMIT 10
  `).all(code, ...dateParams).map(l => ({
    ...l,
    debit_rial: jlDebitRial(l),
    credit_rial: jlCreditRial(l),
  }));
  res.json({
    account,
    period: { from: from || null, to: to || null, debit_rial, credit_rial, balance },
    recent_entries: recent,
  });
});

// ============================================================
// General Ledger — account-level ledger (counterpart to per-customer ledger)
// ============================================================
router.get('/general-ledger/:code', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const account = db.prepare('SELECT * FROM chart_of_accounts WHERE code=?').get(req.params.code);
  if (!account) return res.status(404).json({ error: 'حساب یافت نشد' });

  const from = safeJalaliDate(req.query.from);
  const to = safeJalaliDate(req.query.to);
  const q = req.query.q != null ? String(req.query.q).trim() : '';
  const hasPage = req.query.page != null && String(req.query.page) !== '';
  const hasPageSize = req.query.pageSize != null && String(req.query.pageSize) !== '';
  const paginate = hasPage || hasPageSize;
  let page = Math.max(1, parseInt(req.query.page, 10) || 1);
  let pageSize = parseInt(req.query.pageSize, 10);
  if (!Number.isFinite(pageSize) || pageSize <= 0) pageSize = 50;
  pageSize = Math.min(200, pageSize);

  const debitNormal = ['asset', 'expense', 'cogs'].includes(account.type);
  const signMove = (dr, cr) => (debitNormal ? (dr - cr) : (cr - dr));

  let opening_rial = 0;
  if (from) {
    const openRow = db.prepare(`
      SELECT
        COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) AS d,
        COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) AS c
      FROM journal_lines jl
      JOIN journal_entries je ON jl.entry_id=je.id
      WHERE jl.account_code=? AND ${JE_ALIVE} AND je.entry_date < ?
    `).get(account.code, from);
    opening_rial = signMove(Number(openRow.d) || 0, Number(openRow.c) || 0);
  }

  const where = ['jl.account_code=?', JE_ALIVE];
  const params = [account.code];
  if (from) { where.push('je.entry_date >= ?'); params.push(from); }
  if (to) { where.push('je.entry_date <= ?'); params.push(to); }

  const periodLines = db.prepare(`
    SELECT jl.*, je.entry_date, je.description as entry_description, je.ref_type, je.ref_id
    FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id
    WHERE ${where.join(' AND ')}
    ORDER BY je.entry_date ASC, je.id ASC, jl.id ASC
  `).all(...params);

  let period_debit_rial = 0;
  let period_credit_rial = 0;
  let running = opening_rial;
  periodLines.forEach((l) => {
    const dr = jlDebitRial(l);
    const cr = jlCreditRial(l);
    l.debit_rial = dr;
    l.credit_rial = cr;
    period_debit_rial += dr;
    period_credit_rial += cr;
    running += signMove(dr, cr);
    l.running_balance = running;
  });
  const closing_rial = opening_rial + signMove(period_debit_rial, period_credit_rial);
  const unfiltered_total = periodLines.length;

  let displayLines = periodLines;
  if (q) {
    const needle = q.toLowerCase();
    displayLines = periodLines.filter((l) => {
      const hay = [
        l.entry_description, l.description, l.ref_type, l.ref_id,
      ].map((x) => String(x == null ? '' : x).toLowerCase()).join('\n');
      return hay.includes(needle);
    });
  }
  const total = displayLines.length;

  let lines = displayLines;
  if (paginate) {
    const start = (page - 1) * pageSize;
    lines = displayLines.slice(start, start + pageSize);
  } else {
    page = 1;
    pageSize = total || pageSize;
  }

  res.json({
    account,
    opening_rial,
    period_debit_rial,
    period_credit_rial,
    closing_rial,
    lines,
    page,
    pageSize,
    total,
    unfiltered_total,
    q: q || null,
    balance: closing_rial,
  });
});

// ============================================================
// Trial Balance — sum of debit/credit per account, must balance system-wide
// ============================================================
router.get('/trial-balance', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { from, to } = req.query;
  const sf = safeJalaliDate(from), st = safeJalaliDate(to);
  const tbWhere = [JE_ALIVE, JE_APPROVED];
  const tbParams = [];
  if (sf) { tbWhere.push('je.entry_date >= ?'); tbParams.push(sf); }
  if (st) { tbWhere.push('je.entry_date <= ?'); tbParams.push(st); }
  const rows = db.prepare(`
    SELECT jl.account_code, jl.account_name,
      COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) as total_debit, COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) as total_credit
    FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id
    WHERE ${tbWhere.join(' AND ')}
    GROUP BY jl.account_code, jl.account_name
    ORDER BY jl.account_code
  `).all(...tbParams);
  const unbalanced_count = unbalancedEntryCount(db, { from: sf, to: st });
  const coaMap = {};
  db.prepare('SELECT code,type FROM chart_of_accounts').all().forEach(a => { coaMap[a.code] = a.type; });
  let totalDebit = 0, totalCredit = 0;
  rows.forEach(r => {
    r.type = coaMap[r.account_code] || '';
    // A trial balance places each account's net into whichever column it
    // actually falls on — debit column if debits exceed credits, credit
    // column otherwise — regardless of the account's "normal" side. (An
    // earlier version of this branched on debitNormal and had the two
    // ternaries swapped for credit-normal accounts, which zeroed out every
    // revenue/liability/equity balance and made the trial balance appear
    // permanently unbalanced.)
    const net = r.total_debit - r.total_credit;
    r.debit_balance = Math.max(0, net);
    r.credit_balance = Math.max(0, -net);
    totalDebit += r.debit_balance; totalCredit += r.credit_balance;
  });
  res.json({
    rows, totalDebit, totalCredit,
    unbalanced_count,
    balanced: Math.abs(totalDebit - totalCredit) < 1 && unbalanced_count === 0,
  });
});

// ============================================================
// Balance Sheet — assets vs liabilities + equity, as of the given date
// Note: equity here = capital account balance + accumulated net profit
// computed from all-time revenue/COGS/expense postings (no period-close
// entries are booked), which is a pragmatic approximation appropriate
// for a single-business ledger of this scale.
// ============================================================
router.get('/balance-sheet', auth, adminOrAccounting, (req, res) => {
  const { buildBalanceSheet } = require('../lib/balance-sheet');
  res.json(buildBalanceSheet(getDB(), { asOf: req.query.asOf }));
});

// ============================================================
// Cost centers
// ============================================================
router.get('/cost-centers', auth, (req, res) => {
  const db = getDB();
  res.json(db.prepare('SELECT * FROM cost_centers ORDER BY name').all());
});
function costCenterParentId(db, parentId, selfId) {
  const pid = parentId ? parseInt(parentId, 10) : null;
  if (!pid) return null;
  if (selfId && pid === parseInt(selfId, 10)) {
    const err = new Error('مرکز هزینه نمی‌تواند والد خودش باشد');
    err.status = 400;
    throw err;
  }
  const parent = db.prepare('SELECT id, parent_id FROM cost_centers WHERE id=?').get(pid);
  if (!parent) {
    const err = new Error('مرکز هزینه والد یافت نشد');
    err.status = 400;
    throw err;
  }
  let cursor = parent;
  let guard = 0;
  while (cursor && cursor.parent_id && guard++ < 12) {
    if (selfId && Number(cursor.parent_id) === Number(selfId)) {
      const err = new Error('حلقه در سلسله مراکز هزینه مجاز نیست');
      err.status = 400;
      throw err;
    }
    cursor = db.prepare('SELECT id, parent_id FROM cost_centers WHERE id=?').get(cursor.parent_id);
  }
  return pid;
}

router.post('/cost-centers', auth, adminOrAccounting, (req, res) => {
  const { name, code, entity, parent_id } = req.body;
  if (!name) return res.status(400).json({ error: 'نام مرکز هزینه الزامی است' });
  const db = getDB();
  let cc = String(code || '').trim();
  if (!cc) {
    const existing = db.prepare("SELECT code FROM cost_centers WHERE code LIKE 'CC-%'").all().map((r) => r.code);
    cc = nextNumericCode(existing, 'CC-');
    while (db.prepare('SELECT 1 FROM cost_centers WHERE code=?').get(cc)) {
      existing.push(cc);
      cc = nextNumericCode(existing, 'CC-');
    }
  } else if (db.prepare('SELECT 1 FROM cost_centers WHERE code=?').get(cc)) {
    return res.status(409).json({ error: 'کد مرکز هزینه تکراری است', code: 'E_CC_CODE' });
  }
  let parentId = null;
  try { parentId = costCenterParentId(db, parent_id, null); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const kindByEntity = {
    workshop: 'production', distribution_office: 'service', admin: 'admin', sales: 'selling', production: 'production',
  };
  const kind = kindByEntity[entity] || 'admin';
  const result = db.prepare(
    'INSERT INTO cost_centers (name,code,entity,parent_id,kind,is_stage) VALUES (?,?,?,?,?,0)'
  ).run(name, cc, entity || '', parentId, kind);
  res.json(db.prepare('SELECT * FROM cost_centers WHERE id=?').get(result.lastInsertRowid));
});
router.put('/cost-centers/:id', auth, adminOrAccounting, (req, res) => {
  const { name, code, active, entity, parent_id } = req.body;
  const db = getDB();
  const row = db.prepare('SELECT * FROM cost_centers WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'مرکز هزینه یافت نشد' });
  let parentId = row.parent_id || null;
  if (parent_id !== undefined) {
    try { parentId = costCenterParentId(db, parent_id, req.params.id); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  }
  const nextCode = code != null ? String(code).trim() : String(row.code || '');
  if (nextCode) {
    const dup = db.prepare('SELECT id FROM cost_centers WHERE code=? AND id<>?').get(nextCode, row.id);
    if (dup) return res.status(409).json({ error: 'کد مرکز هزینه تکراری است', code: 'E_CC_CODE' });
  }
  db.prepare('UPDATE cost_centers SET name=?,code=?,active=?,entity=?,parent_id=? WHERE id=?')
    .run(name, nextCode, active ? 1 : 0, entity ?? '', parentId, req.params.id);
  res.json({ ok: true });
});
/** Whitelisted probes for cost-center delete (table, column, Persian label).
 * Includes non-FK columns so hard-delete cannot orphan journals/docs (research v398). */
const COST_CENTER_REF_SPECS = [
  ['warehouses', 'cost_center_id', 'انبار'],
  ['journal_lines', 'cost_center_id', 'سطر دفترکل'],
  ['journal_entries', 'cost_center_id', 'سند حسابداری'],
  ['journal_templates', 'cost_center_id', 'قالب سند'],
  ['voucher_drafts', 'cost_center_id', 'پیش‌نویس سند'],
  ['invoices', 'cost_center_id', 'فاکتور فروش'],
  ['purchase_invoices', 'cost_center_id', 'فاکتور خرید'],
  ['settlements', 'cost_center_id', 'تسویه'],
  ['cheque_records', 'cost_center_id', 'چک'],
  ['expense_payments', 'cost_center_id', 'پرداخت هزینه'],
  ['rep_expenses', 'cost_center_id', 'هزینه نماینده'],
  ['payroll_records', 'cost_center_id', 'حقوق'],
  ['persons', 'cost_center_id', 'پرونده شخص'],
  ['budget_lines', 'cost_center_id', 'بودجه'],
  ['bom_operations', 'cost_center_id', 'عملیات BOM'],
  ['bom_lines', 'stage_cost_center_id', 'مواد BOM'],
  ['bom_outputs', 'stage_cost_center_id', 'خروجی BOM'],
  ['cost_center_rates', 'cost_center_id', 'نرخ سربار'],
  ['cost_center_account_maps', 'cost_center_id', 'نگاشت معین'],
  ['overhead_allocation_weights', 'cost_center_id', 'وزن جذب سربار'],
  ['user_cost_centers', 'cost_center_id', 'دسترسی کاربر'],
  ['production_orders', 'cost_center_id', 'سفارش تولید'],
  ['production_order_stages', 'cost_center_id', 'مرحله تولید'],
  ['production_material_issues', 'cost_center_id', 'حواله مواد'],
  ['production_labor_entries', 'cost_center_id', 'دستمزد تولید'],
  ['production_overhead_applications', 'cost_center_id', 'جذب سربار'],
  ['production_waste', 'cost_center_id', 'ضایعات'],
  ['production_variances', 'cost_center_id', 'انحراف تولید'],
  ['production_estimate_lines', 'cost_center_id', 'برآورد تولید'],
];

const COST_CENTER_SEED_CODES = new Set(['CC-WORKSHOP', 'CC-DISTRIBUTION']);

function costCenterHasColumn(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch (_) {
    return false;
  }
}

function costCenterRefReasons(db, id) {
  const reasons = [];
  for (const [table, col, label] of COST_CENTER_REF_SPECS) {
    if (!costCenterHasColumn(db, table, col)) continue;
    try {
      const n = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${col}=?`).get(id).c || 0;
      if (n > 0) reasons.push(label);
    } catch (_) { /* table missing / migration mid-flight */ }
  }
  return reasons;
}

function deactivateCostCenter(db, req, row, reasons) {
  db.prepare('UPDATE cost_centers SET active=0 WHERE id=?').run(row.id);
  const why = reasons.length ? reasons.join('، ') : 'سیستمی';
  audit(req.user.id, 'update', 'cost_center', row.id,
    `غیرفعال‌سازی مرکز هزینه ${row.name} (${why})`);
  return {
    ok: true,
    deactivated: true,
    reason: reasons[0] || 'سیستمی',
    message: 'مرکز هزینه ارجاع دارد و غیرفعال شد (حذف فیزیکی نشد)',
  };
}

router.delete('/cost-centers/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'شناسه نامعتبر است' });
  const row = db.prepare('SELECT * FROM cost_centers WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: 'مرکز هزینه یافت نشد' });

  const childCount = db.prepare('SELECT COUNT(*) c FROM cost_centers WHERE parent_id=?').get(id).c || 0;
  if (childCount > 0) {
    return res.status(400).json({
      error: `این مرکز هزینه ${childCount} زیرمجموعه دارد — ابتدا زیرمجموعه‌ها را حذف یا به والد دیگر منتقل کنید`,
    });
  }

  const reasons = costCenterRefReasons(db, id);
  const isSeed = COST_CENTER_SEED_CODES.has(String(row.code || '').toUpperCase());

  if (reasons.length || isSeed) {
    if (Number(row.active) === 0) {
      return res.status(400).json({
        error: isSeed
          ? 'مراکز سیستمی کارگاه/توزیع قابل حذف نیستند — از قبل غیرفعال‌اند'
          : `این مرکز هزینه در ${reasons.slice(0, 3).join('، ')} استفاده شده و از قبل غیرفعال است`,
      });
    }
    return res.json(deactivateCostCenter(db, req, row, reasons.length ? reasons : ['سیستمی']));
  }

  try {
    db.prepare('DELETE FROM cost_centers WHERE id=?').run(id);
  } catch (e) {
    const msg = String(e && e.message || '');
    if (msg.includes('FOREIGN KEY') || e.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      return res.json(deactivateCostCenter(db, req, row, ['ارجاع پایگاه‌داده']));
    }
    throw e;
  }
  audit(req.user.id, 'delete', 'cost_center', id, `حذف مرکز هزینه ${row.name}`);
  res.json({ ok: true });
});

// ============================================================
// Customer groups — accounting nature (Debit by default; Credit for
// special groups). Only admin/accounting may change the nature.
// ============================================================
router.get('/customer-groups', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  res.json(db.prepare('SELECT * FROM customer_groups ORDER BY id').all());
});
router.post('/customer-groups', auth, adminOrAccounting, (req, res) => {
  const { name, nature } = req.body;
  if (!name) return res.status(400).json({ error: 'نام گروه الزامی است' });
  const db = getDB();
  const result = db.prepare("INSERT INTO customer_groups (name,nature) VALUES (?,?)").run(name, nature === 'credit' ? 'credit' : 'debit');
  res.json(db.prepare('SELECT * FROM customer_groups WHERE id=?').get(result.lastInsertRowid));
});
router.put('/customer-groups/:id', auth, adminOrAccounting, (req, res) => {
  const { name, nature } = req.body;
  const db = getDB();
  db.prepare("UPDATE customer_groups SET name=?,nature=? WHERE id=?").run(name, nature === 'credit' ? 'credit' : 'debit', req.params.id);
  audit(req.user.id, 'update', 'customer_group', req.params.id, `تغییر ماهیت حساب گروه به ${nature}`);
  res.json({ ok: true });
});
router.delete('/customer-groups/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const inUse = db.prepare('SELECT COUNT(*) c FROM customers WHERE group_id=?').get(req.params.id).c;
  if (inUse) return res.status(400).json({ error: 'این گروه به مشتریانی نسبت داده شده و قابل حذف نیست' });
  db.prepare('DELETE FROM customer_groups WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.postManualVoucher = postManualVoucher;
module.exports.validateAndBuildVoucherLines = validateAndBuildVoucherLines;
// Shared with the B2B portal (routes/b2b.js) so customers see the exact same
// statement the accounting module produces.
module.exports.buildStatement = buildStatement;
