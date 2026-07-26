const router = require('express').Router();
const { acct: coaAcct, suggestChildCode, validateChildCode } = require('../lib/coa-map');
const { DELETED_FILTER, postToLedger } = require('../lib/ledger');
const { rialToLedger, jlDebitRial, jlCreditRial, SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');
const { todayJalali } = require('../jalali');
const { parseQty } = require('../lib/round3');
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
const { recordCommissionAccrual, recordSettlementCommissionAccrual, reverseCommissionAccrual } = require('../lib/rep-ledger');
const { reverseSettlementInTx } = require('../lib/void-settlement');
const { voidInvoiceFully, notifyInvoiceCancelled, saveCancelImage } = require('../lib/void-invoice');
const { auth, adminOnly, adminOrAccounting, centralOnly, requirePermission } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const { UPLOADS_ROOT } = require('../paths');
const VOUCHER_UPLOAD_DIR = path.join(UPLOADS_ROOT, 'vouchers');
fs.mkdirSync(VOUCHER_UPLOAD_DIR, { recursive: true });
const voucherUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, VOUCHER_UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, 'v_' + Date.now() + '_' + Math.round(Math.random() * 1e6) + path.extname(file.originalname || ''))
  }),
  limits: { fileSize: 5 * 1024 * 1024 }
});

const ENTRY_LABEL = {
  invoice: 'فاکتور فروش',
  settlement: 'دریافت وجه',
  reversal: 'ابطال/اصلاح',
  opening: 'مانده اول دوره'
};

// Build a customer account statement (opening balance + period movements + running balance).
// Running balance is always computed from the very first entry; date/type filters only
// affect which rows are *returned*, so the opening balance reflects everything before `from`.
function buildStatement(db, customerId, { from, to, type } = {}) {
  const customer = db.prepare(
    'SELECT c.id,c.biz,c.owner,c.city,c.phone,c.balance,u.name as salesperson FROM customers c LEFT JOIN users u ON c.user_id=u.id WHERE c.id=?'
  ).get(customerId);
  if (!customer) return null;
  const all = db.prepare(`
    SELECT cl.*, u.name as user_name
    FROM customer_ledger cl LEFT JOIN users u ON cl.user_id=u.id
    WHERE cl.customer_id=?
    ORDER BY cl.created_at ASC, cl.id ASC
  `).all(customerId);

  let balance = 0, opening = 0, openingCounted = false;
  const entries = [];
  for (const e of all) {
    balance += (e.debit || 0) - (e.credit || 0);
    e.running_balance = balance;
    e.type_label = ENTRY_LABEL[e.entry_type] || e.entry_type || '-';
    e.reference = (e.ref_type ? e.ref_type + '-' : '') + (e.ref_id || '');
    // Everything strictly before the `from` date rolls into the opening balance
    if (from && (e.date || '') < from) { opening = balance; openingCounted = true; continue; }
    if (to && (e.date || '') > to) continue;
    if (type && e.entry_type !== type) continue;
    entries.push(e);
  }
  if (!openingCounted) opening = 0;
  const totalDebit = entries.reduce((a, e) => a + (e.debit || 0), 0);
  const totalCredit = entries.reduce((a, e) => a + (e.credit || 0), 0);
  return { customer, entries, opening, totalDebit, totalCredit, closing: balance };
}

// Overview stats for accounting dashboard
router.get('/overview', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const totalInvoiced = db.prepare("SELECT COALESCE(SUM(final),0) s FROM invoices WHERE type='final'").get().s;
  const totalSettled = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM settlements WHERE COALESCE(status,'posted')<>'reversed'").get().s;
  const pendingApproval = db.prepare("SELECT COUNT(*) c FROM invoices WHERE type='final' AND approved=0").get().c;
  const pendingSettlements = db.prepare("SELECT COUNT(*) c FROM rep_payment_submissions WHERE status='pending'").get().c;
  const approvedCount = db.prepare("SELECT COUNT(*) c FROM invoices WHERE type='final' AND approved=1").get().c;
  const tb = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) d, COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) c
    FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id
  `).get();
  const trialBalanced = Math.abs((tb.d || 0) - (tb.c || 0)) < 1;
  const payRow = db.prepare(`
    SELECT COALESCE(SUM(
      COALESCE(s.balance,0)
      + COALESCE(pi.total_purchased,0)
      - COALESCE(sp.total_paid,0)
      - COALESCE(pr.total_returned,0)
    ),0) total
    FROM suppliers s
    LEFT JOIN (SELECT supplier_id, SUM(final) total_purchased FROM purchase_invoices WHERE pay_type='credit' GROUP BY supplier_id) pi ON pi.supplier_id=s.id
    LEFT JOIN (SELECT supplier_id, SUM(amount) total_paid FROM supplier_payments GROUP BY supplier_id) sp ON sp.supplier_id=s.id
    LEFT JOIN (SELECT supplier_id, SUM(amount) total_returned FROM purchase_returns GROUP BY supplier_id) pr ON pr.supplier_id=s.id
  `).get();
  res.json({
    totalInvoiced, totalSettled, outstanding: totalInvoiced - totalSettled,
    pendingApproval, approvedCount, trialBalanced,
    totalPayable: payRow.total || 0,
    pendingSettlements
  });
});

// Receivables per customer — ledger outstanding is source of truth (opening + invoices − settlements).
// Invoice/settlement sums are informational; go-live DBs may have openings with zero invoices.
router.get('/receivables', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { from, to } = req.query;
  const safeDate = v => (v && /^[\d/]+$/.test(v)) ? v : null;
  const sf = safeDate(from), st = safeDate(to);
  const invTo = st ? ` AND i.date <= '${st}'` : '';
  const invFrom = (!st && sf) ? ` AND i.date >= '${sf}'` : '';
  const settTo = st ? ` AND s.date <= '${st}'` : '';
  const settFrom = (!st && sf) ? ` AND s.date >= '${sf}'` : '';
  const rows = db.prepare(`
    SELECT c.id, c.biz, c.owner, c.city, c.phone,
      u.name as salesperson,
      COALESCE(inv.total_invoiced, 0) as total_invoiced,
      COALESCE(st.total_settled, 0) as total_settled,
      COALESCE(lb.balance, 0) as ledger_balance
    FROM customers c
    LEFT JOIN (
      SELECT i.cust_id, SUM(i.final) as total_invoiced
      FROM invoices i WHERE i.type='final'${invTo}${invFrom}
      GROUP BY i.cust_id
    ) inv ON inv.cust_id=c.id
    LEFT JOIN (
      SELECT cust_id, SUM(amount) as total_settled FROM settlements s
      WHERE COALESCE(status,'posted')<>'reversed'${settTo}${settFrom}
      GROUP BY cust_id
    ) st ON st.cust_id=c.id
    LEFT JOIN (
      SELECT customer_id, COALESCE(SUM(debit)-SUM(credit),0) AS balance
      FROM customer_ledger GROUP BY customer_id
    ) lb ON lb.customer_id=c.id
    LEFT JOIN users u ON c.user_id=u.id
    WHERE COALESCE(inv.total_invoiced,0) > 0 OR COALESCE(lb.balance,0) <> 0
    ORDER BY ABS(COALESCE(lb.balance,0)) DESC
  `).all();
  rows.forEach(r => {
    // Prefer live ledger (includes opening). Fall back to invoice−settlement if ledger empty.
    const led = Number(r.ledger_balance) || 0;
    const invOut = (Number(r.total_invoiced) || 0) - (Number(r.total_settled) || 0);
    r.outstanding = led !== 0 ? led : invOut;
  });
  res.json(rows);
});

// Receivables per final invoice (for invoice-level tracking) — as-of `to` when provided
router.get('/receivables/by-invoice', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
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
  const rows = db.prepare(`
    SELECT i.id, i.num, i.date, i.final, c.id as cust_id, c.biz, c.owner, u.name as salesperson,
      COALESCE(sp.paid, 0) as paid
    FROM invoices i
    JOIN customers c ON i.cust_id=c.id
    LEFT JOIN users u ON c.user_id=u.id
    LEFT JOIN (
      SELECT invoice_id, SUM(amount) as paid FROM settlements
      WHERE invoice_id IS NOT NULL AND COALESCE(status,'posted')<>'reversed'${settDate}
      GROUP BY invoice_id
    ) sp ON sp.invoice_id=i.id
    WHERE i.type='final'${invTo}${invFrom}
    ORDER BY i.date DESC, i.id DESC
    LIMIT 500
  `).all(...settParams, ...params);
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
    ORDER BY s.created_at DESC
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
  let fx;
  try {
    fx = resolveSettlementFx(db, {
      amount, bank_id, cash_box_id, foreign_amount, fx_rate_rial, currency, date,
    });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
  if (!fx.amountRial) return res.status(400).json({ error: 'مشتری و مبلغ الزامی است' });
  const amountRial = fx.amountRial;
  const settlementId = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO settlements
        (user_id,cust_id,invoice_id,amount,pay_type,date,note,bank_id,cash_box_id,check_category_id,
         cheque_bank,cheque_sayadi,cheque_number,cheque_account,
         cheque_amount,cheque_owner,cheque_due,cheque_status,cheque_branch,cheque_sheba,
         foreign_amount,fx_rate_rial,currency,account_code)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(req.user.id, cust_id, invoice_id || null, amountRial, pay_type || 'cash',
          date || '', note || '', bank_id || null, cash_box_id || null, check_category_id || null,
          cheque_bank || '', cheque_sayadi || '', cheque_number || '', cheque_account || '',
          parseFloat(cheque_amount || 0), cheque_owner || '', cheque_due || '',
          cheque_status || 'pending', cheque_branch || '', cheque_sheba || '',
          fx.foreign_amount, fx.fx_rate_rial, fx.currency, String(account_code || '').slice(0, 32));
    const settlementId = result.lastInsertRowid;

    const payLabel = (pay_type || 'cash') === 'cheque' ? 'چک' : (pay_type === 'bank_transfer' ? 'واریز بانکی' : 'نقد');
    const fxNote = fx.foreign_amount && fx.fx_rate_rial
      ? ` (${fx.foreign_amount} ${fx.currency} × ${fx.fx_rate_rial})`
      : '';
    createLedgerEntry(db, {
      customer_id: cust_id, date: date || '', entry_type: 'settlement',
      ref_type: 'settlement', ref_id: settlementId,
      description: `تسویه ${payLabel} - ${amountRial.toLocaleString('fa-IR')} ریال${fxNote}`,
      debit: 0, credit: amountRial, user_id: req.user.id
    });
    let cash = resolveCashAccount(db, pay_type || 'cash', bank_id, cash_box_id);
    const overrideCode = String(account_code || '').trim();
    if (overrideCode) {
      const acctRow = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(overrideCode);
      if (acctRow) cash = { code: acctRow.code, name: acctRow.name };
    }
    postToLedger(db, {
      sourceType: 'settlement', sourceId: settlementId,
      date: date || todayJalali(), description: `تسویه ${payLabel} مشتری${fxNote}`, createdBy: req.user.id,
      lines: [
        { code: cash.code, name: cash.name, debit: rialToLedger(amountRial), credit: 0 },
        (()=>{const a=recvAcct(db,cust_id);return { code: a.code, name: a.name, debit: 0, credit: rialToLedger(amountRial) };})()
      ]
    });
    if (invoice_id) {
      const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoice_id);
      if (inv) {
        recordSettlementCommissionAccrual(db, { id: settlementId, amount: amountRial, date: date || '' }, inv, req.user.id);
      }
    }
    return settlementId;
  })();
  audit(req.user.id, 'create', 'settlement', settlementId, `تسویه ${amountRial} ریال - مشتری ${cust_id}`);

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

  db.transaction(() => {
    for (const p of payments) {
      const amount = parseFloat(p.amount);
      if (!amount || amount <= 0) throw new Error('مبلغ هر قسط باید بزرگ‌تر از صفر باشد');
      const pay_type = p.pay_type || 'cash';
      const result = db.prepare(
        `INSERT INTO settlements
          (user_id,cust_id,invoice_id,amount,pay_type,date,note,bank_id,cash_box_id,check_category_id,
           cheque_bank,cheque_sayadi,cheque_number,cheque_account,
           cheque_amount,cheque_owner,cheque_due,cheque_status,installment_group,cheque_branch,cheque_sheba,cheque_row)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(req.user.id, cust_id, p.invoice_id || null, amount, pay_type,
            p.date || '', note || p.note || '', p.bank_id || null, p.cash_box_id || null, p.check_category_id || null,
            p.cheque_bank || '', p.cheque_sayadi || '', p.cheque_number || '', p.cheque_account || '',
            parseFloat(p.cheque_amount || 0), p.cheque_owner || '', p.cheque_due || '',
            p.cheque_status || 'pending', groupId, p.cheque_branch || '', p.cheque_sheba || '',
            parseInt(p.cheque_row) || 0);
      const settlementId = result.lastInsertRowid;
      const payLabel = pay_type === 'cheque' ? 'چک' : (pay_type === 'bank_transfer' ? 'واریز بانکی' : 'نقد');
      createLedgerEntry(db, {
        customer_id: cust_id, date: p.date || '', entry_type: 'settlement',
        ref_type: 'settlement', ref_id: settlementId,
        description: `تسویه ${payLabel} (قسط) - ${amount.toLocaleString('fa-IR')} ریال`,
        debit: 0, credit: amount, user_id: req.user.id
      });
      const cash = resolveCashAccount(db, pay_type, p.bank_id, p.cash_box_id);
      postToLedger(db, {
        sourceType: 'settlement', sourceId: settlementId,
        date: p.date || todayJalali(), description: `تسویه ${payLabel} مشتری (قسط)`, createdBy: req.user.id,
        lines: [
          { code: cash.code, name: cash.name, debit: rialToLedger(amount), credit: 0 },
          (()=>{const a=recvAcct(db,cust_id);return { code: a.code, name: a.name, debit: 0, credit: rialToLedger(amount) };})()
        ]
      });
      if (p.invoice_id) {
        const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(p.invoice_id);
        if (inv) {
          recordSettlementCommissionAccrual(db, { id: settlementId, amount, date: p.date || '' }, inv, req.user.id);
        }
      }
      created.push({ id: settlementId, amount });
    }
  })();

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
  const paidRows = db.prepare('SELECT rep_id, COALESCE(SUM(amount),0) s FROM incentive_payments GROUP BY rep_id').all();
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
  const { rep_id, amount, pay_type, date, note, bank_id, check_category_id, cash_box_id } = req.body;
  if (!rep_id || !amount) return res.status(400).json({ error: 'کارشناس و مبلغ الزامی است' });
  const db = getDB();
  const rep = db.prepare('SELECT id,name FROM users WHERE id=?').get(rep_id);
  if (!rep) return res.status(404).json({ error: 'کارشناس یافت نشد' });
  const paymentId = db.transaction(() => {
    const result = db.prepare(
      'INSERT INTO incentive_payments (rep_id,amount,pay_type,date,note,created_by,bank_id,check_category_id,cash_box_id) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(rep_id, parseFloat(amount), pay_type || 'cash', date || todayJalali(), note || '', req.user.id, bank_id || null, check_category_id || null, cash_box_id || null);
    recordIncentivePaymentLedger(db, {
      rep_id, amount: parseFloat(amount), date: date || todayJalali(), payment_id: result.lastInsertRowid, created_by: req.user.id
    });
    if (req.body.settle_advances !== false) {
      settleAdvancesAgainstPayment(db, rep_id, parseFloat(amount), result.lastInsertRowid, req.user.id);
    }
    const cash = resolveCashAccount(db, pay_type || 'cash', bank_id, cash_box_id);
    const payable = coaAcct(db, 'coa_rep_commission_payable');
    postToLedger(db, {
      sourceType: 'incentive_payment', sourceId: result.lastInsertRowid,
      date: date || todayJalali(), description: `پرداخت انگیزه فروش به ${rep.name}`, createdBy: req.user.id,
      lines: [
        { code: payable.code, name: payable.name, debit: rialToLedger(amount), credit: 0 },
        { code: cash.code, name: cash.name, debit: 0, credit: rialToLedger(amount) }
      ]
    });
    return result.lastInsertRowid;
  })();
  audit(req.user.id, 'create', 'incentive_payment', paymentId, `پرداخت انگیزه ${amount} ریال به ${rep.name}`);
  notifyRep(db, rep_id, `💵 انگیزه ${amount} ریال به حساب شما پرداخت شد.`, req.user.id);
  res.json({ id: paymentId, ok: true });
});

// Delete an incentive payment
router.delete('/incentive-payments/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM incentive_payments WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.status === 'reversed') return res.status(400).json({ error: 'این پرداخت قبلاً ابطال شده است' });
  const rep = db.prepare('SELECT name FROM users WHERE id=?').get(row.rep_id);
  // Reversal journal entry — was previously missing, leaving a dangling one-sided
  // entry in the books whenever a payment was deleted
  db.transaction(() => {
    const cash = resolveCashAccount(db, row.pay_type, row.bank_id, row.cash_box_id);
    const payable = coaAcct(db, 'coa_rep_commission_payable');
    const reversalId = postToLedger(db, {
      sourceType: 'incentive_payment_reversal', sourceId: row.id, date: todayJalali(),
      description: `ابطال پرداخت انگیزه فروش به ${rep ? rep.name : ''}`, createdBy: req.user.id,
      lines: [
        { code: cash.code, name: cash.name, debit: rialToLedger(row.amount), credit: 0 },
        { code: payable.code, name: payable.name, debit: 0, credit: rialToLedger(row.amount) }
      ]
    });
    const ledgerRows = db.prepare("SELECT * FROM rep_ledger WHERE ref_type='incentive_payment' AND ref_id=?").all(row.id);
    for (const item of ledgerRows) {
      if (item.entry_type === 'advance_settle') {
        const match = String(item.description || '').match(/#(\d+)/);
        if (match) {
          db.prepare('UPDATE rep_advances SET settled_amount=MAX(0,COALESCE(settled_amount,0)-?) WHERE id=?')
            .run(item.credit || 0, Number(match[1]));
        }
      }
      db.prepare(`
        INSERT INTO rep_ledger (rep_id,date,entry_type,ref_type,ref_id,description,debit,credit,created_by)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(item.rep_id, todayJalali(), 'reversal', 'incentive_payment_reversal', row.id,
        `ابطال ${item.description || 'پرداخت انگیزه'}`, item.credit || 0, item.debit || 0, req.user.id);
    }
    db.prepare("UPDATE incentive_payments SET status='reversed',reversal_journal_id=?,reversed_at=strftime('%s','now'),reversed_by=? WHERE id=?")
      .run(reversalId, req.user.id, row.id);
  })();
  audit(req.user.id, 'reverse', 'incentive_payment', req.params.id, 'ابطال پرداخت انگیزه فروش');
  res.json({ ok: true });
});

// My commission — salesperson views their own (no adminOnly)
router.get('/my-commission', auth, (req, res) => {
  const db = getDB();
  const { computeRepCommission, buildRepLedgerView, recordIncentivePaymentLedger, settleAdvancesAgainstPayment, notifyRep, isRepRole } = require('../lib/rep-ledger');
  const u = db.prepare('SELECT id,name,commission_cash,commission_cheque,commission_basis,monthly_target FROM users WHERE id=?').get(req.user.id);
  if (!u || !isRepRole(u.role)) {
    return res.json({ cashComm: 0, chequeComm: 0, totalComm: 0, paid: 0, payable: 0, commRate: { cash: 0, cheque: 0 } });
  }
  const comm = computeRepCommission(db, u.id, {});
  const view = buildRepLedgerView(db, u.id, {});
  const paid = view?.paid ?? db.prepare('SELECT COALESCE(SUM(amount),0) s FROM incentive_payments WHERE rep_id=?').get(u.id).s;
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
router.post('/invoices/:id/cancel', auth, adminOrAccounting, memUpload.single('image'), async (req, res) => {
  const db = getDB();
  try {
    const result = voidInvoiceFully(db, req.params.id, req.user, { reason: 'cancel' });
    let imageFileName = null;
    if (req.file && req.file.buffer) {
      imageFileName = await saveCancelImage(req.file.buffer);
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

// Approve invoice for commission
router.post('/invoices/:id/approve', auth, adminOrAccounting, async (req, res) => {
  const db = getDB();
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'یافت نشد' });
  if (inv.type !== 'final') return res.status(400).json({ error: 'فقط فاکتور رسمی قابل تأیید است' });
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
  res.json({ ok: true, rubika });
});

// Upload invoice image to Rubika after approval (client html2canvas)
router.post('/invoices/:id/rubika', auth, adminOrAccounting, (req, res, next) => {
  const multer = require('multer');
  const path = require('path');
  const fs = require('fs');
  const uploadDir = path.join(__dirname, '..', 'uploads', 'rubika');
  fs.mkdirSync(uploadDir, { recursive: true });
  const up = multer({ dest: uploadDir, limits: { fileSize: 8 * 1024 * 1024 } }).single('image');
  up(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
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
      const result = await sendRubikaImage(db, req.file.path, caption);
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// General Accounting — P&L, cash flow, ledger summary
router.get('/general', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { from, to } = req.query;
  const safeDate = v => (v && /^[\d/]+$/.test(v)) ? v : null;
  const sf = safeDate(from), st = safeDate(to);
  const invDateWhere = sf || st ? `AND date >= '${sf||''}' AND date <= '${st||'9999'}'` : '';
  const settDateWhere = sf || st ? `AND date >= '${sf||''}' AND date <= '${st||'9999'}'` : '';

  const revenue     = db.prepare(`SELECT COALESCE(SUM(final),0) s FROM invoices WHERE type='final' ${invDateWhere}`).get().s;
  const subtotal    = db.prepare(`SELECT COALESCE(SUM(subtotal),0) s FROM invoices WHERE type='final' ${invDateWhere}`).get().s;
  const discAmt     = db.prepare(`SELECT COALESCE(SUM(disc_amt),0) s FROM invoices WHERE type='final' ${invDateWhere}`).get().s;
  const vatOutput   = db.prepare(`SELECT COALESCE(SUM(vat_amount),0) s FROM invoices WHERE type='final' ${invDateWhere}`).get().s;
  const purDateWhere = sf || st ? `AND date >= '${sf||''}' AND date <= '${st||'9999'}'` : '';
  const vatInput    = db.prepare(`SELECT COALESCE(SUM(vat_amount),0) s FROM purchase_invoices WHERE 1=1 ${purDateWhere}`).get().s;

  // Cost of goods sold: sum of (qty × unit cost) across all final invoice rows in range
  const costMap = {};
  db.prepare('SELECT id,cost FROM products').all().forEach(p => { costMap[p.id] = p.cost || 0; });
  let cogs = 0;
  const finalInvRows = db.prepare(`SELECT rows FROM invoices WHERE type='final' ${invDateWhere}`).all();
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
      const cs = db.prepare(`SELECT COALESCE(SUM(final),0) s FROM invoices WHERE user_id=? AND type='final' AND approved=1 AND pay_type='cash' ${invDateWhere}`).get(u.id).s;
      const qs = db.prepare(`SELECT COALESCE(SUM(final),0) s FROM invoices WHERE user_id=? AND type='final' AND approved=1 AND pay_type='cheque' ${invDateWhere}`).get(u.id).s;
      total += cs * (u.commission_cash || 0) / 100 + qs * (u.commission_cheque || 0) / 100;
    }
    return Math.round(total);
  })();

  // Monthly revenue & collections for chart
  const monthlyInv = db.prepare(`SELECT substr(date,1,7) ym, SUM(final) rev FROM invoices WHERE type='final' AND date<>'' GROUP BY ym ORDER BY ym DESC LIMIT 12`).all();
  const monthlySett = db.prepare(`SELECT substr(date,1,7) ym, SUM(amount) col FROM settlements WHERE date<>'' AND COALESCE(status,'posted')<>'reversed' GROUP BY ym ORDER BY ym DESC LIMIT 12`).all();

  // Recent transactions journal
  const invJournal = db.prepare(`SELECT 'invoice' as entry_type, num ref, date, final amount, cust_id, 0 is_credit FROM invoices WHERE type='final' ORDER BY created_at DESC LIMIT 30`).all();
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
  const accounts = db.prepare('SELECT * FROM chart_of_accounts WHERE is_active=1 ORDER BY code').all();
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
  const { name, type, parent_code, is_active } = req.body;
  const validTypes = ['asset', 'liability', 'equity', 'revenue', 'cogs', 'expense'];
  if (type && !validTypes.includes(type)) return res.status(400).json({ error: 'نوع حساب نامعتبر است' });
  if (parent_code) {
    if (parent_code === code) return res.status(400).json({ error: 'حساب نمی‌تواند والد خودش باشد' });
    const parent = db.prepare('SELECT code FROM chart_of_accounts WHERE code=? AND is_active=1').get(parent_code);
    if (!parent) return res.status(400).json({ error: 'حساب والد یافت نشد' });
  }
  db.prepare('UPDATE chart_of_accounts SET name=?,type=?,parent_code=?,is_active=? WHERE code=?')
    .run(
      name != null ? String(name).trim() : row.name,
      type || row.type,
      parent_code !== undefined ? (parent_code || null) : row.parent_code,
      is_active != null ? (is_active ? 1 : 0) : row.is_active,
      code
    );
  audit(req.user.id, 'update', 'chart_of_accounts', row.id, `ویرایش حساب ${code}`);
  res.json(db.prepare('SELECT * FROM chart_of_accounts WHERE code=?').get(code));
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
  const row = db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id);
  if (!row) return res.status(404).json({ error: 'رکورد یافت نشد' });
  db.prepare(`UPDATE ${table} SET coa_code=? WHERE id=?`).run(code, id);
  audit(req.user.id, 'link_coa', entity_type, id, `اتصال به ${code} ${acc.name}`);
  res.json({ ok: true, coa_code: acc.code, coa_name: acc.name });
});

// Open invoices for a customer (for payment allocation)
router.get('/customers/:custId/open-invoices', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT i.id, i.num, i.date, i.final,
      COALESCE((SELECT SUM(s.amount) FROM settlements s WHERE s.invoice_id=i.id AND COALESCE(s.status,'posted')<>'reversed'), 0) as paid
    FROM invoices i
    WHERE i.cust_id=? AND i.type='final'
    ORDER BY i.date DESC, i.id DESC
  `).all(req.params.custId);
  rows.forEach(r => { r.outstanding = Math.max(0, (r.final || 0) - (r.paid || 0)); });
  res.json(rows.filter(r => r.outstanding > 0));
});

// Journal entries with lines (paginated, date-filtered)
router.get('/journal', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { from, to, page = '1', ref_type } = req.query;
  const pageNum = Math.max(1, parseInt(page));
  const limit = 50, offset = (pageNum - 1) * limit;
  const where = [], params = [];
  if (from) { where.push('je.entry_date >= ?'); params.push(from); }
  if (to)   { where.push('je.entry_date <= ?'); params.push(to); }
  if (ref_type) { where.push('je.ref_type = ?'); params.push(ref_type); }
  where.push('COALESCE(je.deleted_at,0)=0');
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
  res.json({ entries, total, page: pageNum, limit });
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
router.get('/statement/:customerId/export', auth, adminOrAccounting, (req, res) => {
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
    lines.push([esc('مانده اول دوره'), '', '', '', '', esc(data.opening)].join(','));
    lines.push([esc('جمع دوره'), '', '', esc(data.totalDebit), esc(data.totalCredit), esc(data.closing)].join(','));
    res.setHeader('Content-Disposition', `attachment; filename=statement-${data.customer.id}.csv`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.send('﻿' + lines.join('\n')); // BOM for Excel UTF-8
  }

  if (format === 'pdf') {
    // Printable HTML — user prints to PDF from the browser
    const rowsHtml = data.entries.map((e, i) => `
      <tr>
        <td>${faNum(i + 1)}</td><td>${e.date || '-'}</td><td>${e.type_label}</td>
        <td style="text-align:right">${(e.description || '-').replace(/</g, '&lt;')}</td>
        <td>${e.debit > 0 ? faNum(e.debit) : '-'}</td>
        <td>${e.credit > 0 ? faNum(e.credit) : '-'}</td>
        <td>${faNum(Math.abs(e.running_balance || 0))} ${(e.running_balance || 0) > 0 ? 'بد' : 'بس'}</td>
      </tr>`).join('');
    const company = (db.prepare("SELECT value FROM settings WHERE key='company_name'").get() || {}).value || 'پوشاک ترنم';
    const html = `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="UTF-8">
<title>صورت‌حساب ${data.customer.biz}</title>
<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;600;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:'Vazirmatn',sans-serif}
body{background:#f3f4f6;color:#1f2937;padding:20px;font-size:12px}
.sheet{max-width:900px;margin:0 auto;background:#fff;padding:28px;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
.head{display:flex;justify-content:space-between;border-bottom:3px solid #1A5C38;padding-bottom:14px;margin-bottom:16px}
h1{font-size:20px;color:#1A5C38}.sub{color:#6b7280;font-size:12px;margin-top:4px}
.info{display:flex;gap:24px;margin-bottom:14px;font-size:13px}.info b{color:#1A5C38}
table{width:100%;border-collapse:collapse;margin-top:8px}
th,td{border:1px solid #e5e7eb;padding:7px 6px;text-align:center}
thead th{background:#1A5C38;color:#fff}tbody tr:nth-child(even){background:#f4f7f5}
.tot{margin-top:14px;margin-right:auto;width:320px;font-size:13px}
.tot .l{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed #e5e7eb}
.tot .f{font-weight:800;color:#1A5C38;border:none;font-size:15px;padding-top:8px}
.pbtn{display:block;margin:18px auto 0;background:#1A5C38;color:#fff;border:none;padding:10px 28px;border-radius:8px;font-size:14px;cursor:pointer}
@media print{body{background:#fff;padding:0}.sheet{box-shadow:none}.pbtn{display:none}@page{size:A4;margin:10mm}}
</style></head><body><div class="sheet">
<div class="head"><div style="display:flex;align-items:center;gap:14px"><img src="/logo-sm.png" style="height:58px" onerror="this.style.display='none'"><div><h1>صورت‌حساب مشتری</h1><div class="sub">${company}</div></div></div>
<div style="text-align:left"><div><b>مشتری:</b> ${data.customer.biz}</div><div><b>کارشناس:</b> ${data.customer.salesperson || '-'}</div>${(from || to) ? `<div><b>دوره:</b> ${from || '...'} تا ${to || '...'}</div>` : ''}</div></div>
<div class="info"><div><b>نام کامل:</b> ${data.customer.owner || '-'}</div><div><b>شهر:</b> ${data.customer.city || '-'}</div><div><b>تلفن:</b> ${data.customer.phone || '-'}</div></div>
<table><thead><tr><th>ردیف</th><th>تاریخ</th><th>نوع</th><th>شرح</th><th>بدهکار</th><th>بستانکار</th><th>مانده</th></tr></thead>
<tbody>${rowsHtml || '<tr><td colspan="7">تراکنشی ثبت نشده</td></tr>'}</tbody></table>
<div class="tot">
<div class="l"><span>مانده اول دوره</span><span>${faNum(Math.abs(data.opening))} ${data.opening > 0 ? 'بدهکار' : 'بستانکار'}</span></div>
<div class="l"><span>جمع بدهکار دوره</span><span>${faNum(data.totalDebit)} ت</span></div>
<div class="l"><span>جمع بستانکار دوره</span><span>${faNum(data.totalCredit)} ت</span></div>
<div class="l f"><span>مانده نهایی</span><span>${faNum(Math.abs(data.closing))} ${data.closing > 0 ? 'بدهکار' : 'بستانکار'}</span></div>
</div>
<button class="pbtn" onclick="window.print()">چاپ / ذخیره PDF 🖨️</button>
</div></body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  }

  // default: excel
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  const sheetData = [...rows,
    {},
    { 'تاریخ': 'مانده اول دوره', 'مانده (ریال)': data.opening },
    { 'تاریخ': 'جمع دوره', 'بدهکار (ریال)': data.totalDebit, 'بستانکار (ریال)': data.totalCredit, 'مانده (ریال)': data.closing }
  ];
  const ws = XLSX.utils.json_to_sheet(sheetData);
  ws['!cols'] = [14, 14, 30, 16, 16, 16, 14, 16].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'صورت‌حساب');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
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
    WHERE COALESCE(sr.status,'posted')<>'reversed' ORDER BY sr.created_at DESC
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
  const db = getDB();
  const inv = db.prepare('SELECT i.*,c.biz as cust_biz FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.id=?').get(req.params.invoiceId);
  if (!inv) return res.status(404).json({ error: 'فاکتور یافت نشد' });
  const invRows = JSON.parse(inv.rows || '[]');
  const alreadyReturned = {};
  db.prepare("SELECT rows FROM sales_returns WHERE invoice_id=? AND COALESCE(status,'posted')<>'reversed'").all(req.params.invoiceId).forEach(pr => {
    JSON.parse(pr.rows || '[]').forEach(r => { alreadyReturned[r.product_id] = (alreadyReturned[r.product_id] || 0) + r.qty; });
  });
  const rows = invRows.map(r => ({
    ...r, already_returned: alreadyReturned[r.product_id] || 0,
    max_returnable: r.qty - (alreadyReturned[r.product_id] || 0)
  })).filter(r => r.max_returnable > 0);
  res.json({ invoice: inv, rows });
});

router.post('/sales-returns', auth, adminOrAccounting, (req, res) => {
  const { cust_id, invoice_id, date, note, rows } = req.body;
  if (!cust_id) return res.status(400).json({ error: 'مشتری الزامی است' });
  const db = getDB();

  // Invoice-linked return: original price/discount are always taken from the
  // invoice itself (never trusted from the client), and the returned quantity
  // per product can never exceed what was actually sold minus what has
  // already been returned against that same invoice.
  let invoiceLineMap = null, alreadyReturnedMap = {};
  if (invoice_id) {
    const inv = db.prepare('SELECT * FROM invoices WHERE id=? AND cust_id=?').get(invoice_id, cust_id);
    if (!inv) return res.status(400).json({ error: 'فاکتور یافت نشد یا متعلق به این مشتری نیست' });
    invoiceLineMap = {};
    JSON.parse(inv.rows || '[]').forEach(r => { invoiceLineMap[r.product_id] = r; });
    db.prepare("SELECT rows FROM sales_returns WHERE invoice_id=? AND COALESCE(status,'posted')<>'reversed'").all(invoice_id).forEach(pr => {
      JSON.parse(pr.rows || '[]').forEach(r => { alreadyReturnedMap[r.product_id] = (alreadyReturnedMap[r.product_id] || 0) + r.qty; });
    });
  }

  const built = [];
  let amount = 0, costAmount = 0;
  for (const r of (rows || [])) {
    const pid = parseInt(r.product_id);
    const prod = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
    if (!prod) continue;
    let qty = Math.max(0.001, parseQty(r.qty, 1));
    let price, disc = 0, discAmt = 0;
    if (invoiceLineMap) {
      const origLine = invoiceLineMap[pid];
      if (!origLine) return res.status(400).json({ error: `کالای ${prod.name} در این فاکتور وجود ندارد` });
      const already = alreadyReturnedMap[pid] || 0;
      const maxReturnable = origLine.qty - already;
      if (qty > maxReturnable) return res.status(400).json({ error: `حداکثر مقدار قابل برگشت برای ${prod.name}: ${maxReturnable}` });
      price = origLine.price;
      disc = origLine.disc || 0;
      discAmt = Math.round(qty * price * disc / 100);
    } else {
      price = parseFloat(r.price) || prod.price;
    }
    const sum = qty * price - discAmt;
    amount += sum;
    costAmount += qty * ((Number(prod.average_cost_rial) > 0 ? Number(prod.average_cost_rial) : Number(prod.cost)) || 0);
    built.push({ product_id: pid, name: prod.name, qty, price, disc, disc_amt: discAmt, sum });
  }
  if (!built.length) return res.status(400).json({ error: 'حداقل یک ردیف لازم است' });

  const retId = db.transaction(() => {
    const result = db.prepare(
      'INSERT INTO sales_returns (user_id,cust_id,invoice_id,date,note,rows,amount,cost_amount) VALUES (?,?,?,?,?,?,?,?)'
    ).run(req.user.id, cust_id, invoice_id || null, date || todayJalali(), note || '', JSON.stringify(built), amount, costAmount);
    const retId = result.lastInsertRowid;

    for (const r of built) {
      db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(r.qty, r.product_id);
      db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)').run(r.product_id, req.user.id, r.qty, `برگشت از فروش #${retId}`);
    }
    createLedgerEntry(db, {
      customer_id: cust_id, date: date || todayJalali(), entry_type: 'reversal', ref_type: 'sales_return', ref_id: retId,
      description: `برگشت از فروش #${retId}`, debit: 0, credit: amount, user_id: req.user.id
    });
    const salesReturn = coaAcct(db, 'coa_sales_return');
    const inventory = coaAcct(db, 'coa_inventory');
    const cogs = coaAcct(db, 'coa_cogs');
    const journalLines = [
      { code: salesReturn.code, name: salesReturn.name, debit: rialToLedger(amount), credit: 0 },
      (()=>{const a=recvAcct(db,cust_id);return { code: a.code, name: a.name, debit: 0, credit: rialToLedger(amount) };})(),
    ];
    if (costAmount > 0) {
      journalLines.push(
        { code: inventory.code, name: inventory.name, debit: rialToLedger(costAmount), credit: 0 },
        { code: cogs.code, name: cogs.name, debit: 0, credit: rialToLedger(costAmount) }
      );
    }
    postToLedger(db, {
      sourceType: 'sales_return', sourceId: retId,
      date: date || todayJalali(), description: `برگشت از فروش #${retId}`, createdBy: req.user.id,
      lines: journalLines,
    });
    return retId;
  })();
  audit(req.user.id, 'create', 'sales_return', retId, `برگشت از فروش به مبلغ ${amount}`);
  res.json({ id: retId, ok: true });
});

router.delete('/sales-returns/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM sales_returns WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.status === 'reversed') return res.status(400).json({ error: 'این برگشت فروش قبلاً ابطال شده است' });
  db.transaction(() => {
    const invRows = JSON.parse(row.rows || '[]');
    for (const r of invRows) {
      db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(r.qty, r.product_id);
      db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)').run(r.product_id, req.user.id, -r.qty, `ابطال برگشت از فروش #${row.id}`);
    }
    createLedgerEntry(db, {
      customer_id: row.cust_id, date: todayJalali(), entry_type: 'reversal', ref_type: 'sales_return_reversal', ref_id: row.id,
      description: `ابطال برگشت از فروش #${row.id}`, debit: row.amount, credit: 0, user_id: req.user.id
    });
    const salesReturn = coaAcct(db, 'coa_sales_return');
    const inventory = coaAcct(db, 'coa_inventory');
    const cogs = coaAcct(db, 'coa_cogs');
    const journalLines = [
      (()=>{const a=recvAcct(db,row.cust_id);return { code: a.code, name: a.name, debit: rialToLedger(row.amount), credit: 0 };})(),
      { code: salesReturn.code, name: salesReturn.name, debit: 0, credit: rialToLedger(row.amount) },
    ];
    if (row.cost_amount > 0) {
      journalLines.push(
        { code: cogs.code, name: cogs.name, debit: rialToLedger(row.cost_amount), credit: 0 },
        { code: inventory.code, name: inventory.name, debit: 0, credit: rialToLedger(row.cost_amount) }
      );
    }
    const reversalId = postToLedger(db, {
      sourceType: 'sales_return_reversal', sourceId: row.id, date: todayJalali(),
      description: `ابطال برگشت از فروش #${row.id}`, createdBy: req.user.id, lines: journalLines,
    });
    db.prepare("UPDATE sales_returns SET status='reversed',reversal_journal_id=?,reversed_at=strftime('%s','now'),reversed_by=? WHERE id=?")
      .run(reversalId, req.user.id, row.id);
  })();
  res.json({ ok: true });
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
  for (const l of (lines || [])) {
    const debit = parseFloat(l.debit) || 0, credit = parseFloat(l.credit) || 0;
    if (debit && credit) return { error: 'هر ردیف فقط باید بدهکار یا بستانکار باشد، نه هر دو' };
    if (!debit && !credit) continue;
    if (l.person_id) {
      const person = db.prepare('SELECT * FROM persons WHERE id=?').get(l.person_id);
      if (!person) return { error: `شخص با شناسه ${l.person_id} یافت نشد` };
      const personAccount = coaAcct(db, 'coa_misc_persons');
      cleanLines.push({
        code: personAccount.code, name: personAccount.name, debit, credit,
        description: l.description || person.name, detail_account_id: l.detail_account_id || null,
        cost_center_id: l.cost_center_id || null, project_id: l.project_id || null, tax_type: l.tax_type || null,
        tafsili2_code: l.tafsili2_code || null,
      });
      personPostings.push({ person_id: person.id, debit, credit, description: l.description || '' });
    } else {
      const acc = db.prepare('SELECT * FROM chart_of_accounts WHERE code=?').get(l.code);
      if (!acc) return { error: `کد حساب ${l.code} یافت نشد` };
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

router.post('/vouchers', auth, adminOrAccounting, (req, res) => {
  const { date, description, doc_type, cost_center_id, lines, from_excel, src_system, voucher_type } = req.body;
  if (!Array.isArray(lines) || lines.length < 2) {
    return res.status(400).json({ error: 'سند باید حداقل دو ردیف (بدهکار و بستانکار) داشته باشد' });
  }
  const db = getDB();
  const built = validateAndBuildVoucherLines(db, lines);
  if (built.error) return res.status(400).json({ error: built.error });

  const rawType = String(doc_type || voucher_type || 'manual').toLowerCase().trim();
  const OPENING_TYPES = new Set(['opening', 'افتتاحیه', 'opening_balance', 'مانده اول دوره', 'beginning_inventory', 'موجودی اول دوره', 'fiscal_opening']);
  const isOpening = OPENING_TYPES.has(rawType);
  const fromExcel = !!(from_excel || src_system === 'excel');
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
      createdBy: req.user.id,
      voucherType,
      srcSystem: fromExcel ? 'excel' : null,
      docType: rawType || null,
      lines: built.cleanLines.map(l => ({
        ...l, debit: rialToLedger(l.debit), credit: rialToLedger(l.credit),
      })),
    });
    if (cost_center_id) db.prepare('UPDATE journal_entries SET cost_center_id=? WHERE id=?').run(cost_center_id, entryId);
    if (doc_type) db.prepare('UPDATE journal_entries SET doc_type=? WHERE id=?').run(String(doc_type), entryId);
    for (const p of built.personPostings) {
      createPersonLedgerEntry(db, {
        person_id: p.person_id, date: date || '', entry_type: sourceType, ref_type: sourceType, ref_id: entryId,
        description: p.description || description || 'سند', debit: p.debit, credit: p.credit, user_id: req.user.id
      });
    }
    return entryId;
  })();
  audit(req.user.id, 'create', 'journal_voucher', entryId, `ثبت سند: ${description || ''}`);
  res.json({ id: entryId, ok: true });
});

// Attach a single file (receipt/photo/scan) to a manual voucher
router.post('/vouchers/:id/attachment', auth, adminOrAccounting, voucherUpload.single('file'), (req, res) => {
  const db = getDB();
  const entry = db.prepare("SELECT * FROM journal_entries WHERE id=? AND ref_type='manual_voucher'").get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'سند دستی یافت نشد' });
  if (!req.file) return res.status(400).json({ error: 'فایلی آپلود نشد' });
  if (entry.attachment) {
    const oldPath = path.join(VOUCHER_UPLOAD_DIR, entry.attachment);
    fs.unlink(oldPath, () => {});
  }
  db.prepare('UPDATE journal_entries SET attachment=? WHERE id=?').run(req.file.filename, req.params.id);
  res.json({ ok: true, attachment: req.file.filename });
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
  const result = db.prepare('INSERT INTO journal_templates (name,description,lines_json,cost_center_id,created_by) VALUES (?,?,?,?,?)')
    .run(name, description || '', JSON.stringify(lines), cost_center_id || null, req.user.id);
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
// a normal voucher, then removes the draft — this is the "review, then
// confirm" step that stands in for a full approval workflow.
router.post('/vouchers/drafts/:id/post', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const draft = db.prepare('SELECT * FROM voucher_drafts WHERE id=?').get(req.params.id);
  if (!draft) return res.status(404).json({ error: 'پیش‌نویس یافت نشد' });
  const lines = JSON.parse(draft.lines_json || '[]');
  const built = validateAndBuildVoucherLines(db, lines);
  if (built.error) return res.status(400).json({ error: built.error });
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
});

router.delete('/vouchers/:id', auth, adminOrAccounting, requirePermission('accounting', 'delete'), (req, res) => {
  const db = getDB();
  const entry = db.prepare("SELECT * FROM journal_entries WHERE id=? AND ref_type='manual_voucher' AND COALESCE(deleted_at,0)=0").get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'سند دستی یافت نشد' });
  db.transaction(() => {
    const lines = db.prepare('SELECT * FROM journal_lines WHERE entry_id=? ORDER BY id').all(req.params.id);
    if (!lines.length) throw new Error('سند فاقد ردیف حسابداری است');
    postToLedger(db, {
      sourceType: 'manual_voucher_reversal', sourceId: Number(req.params.id), date: todayJalali(),
      description: `ابطال سند دستی #${req.params.id}`, createdBy: req.user.id,
      lines: lines.map(l => ({
        code: l.account_code, name: l.account_name,
        debit: rialToLedger(jlCreditRial(l)), credit: rialToLedger(jlDebitRial(l)),
        description: `معکوس: ${l.description || ''}`, detail_account_id: l.detail_account_id || null,
        cost_center_id: l.cost_center_id || null, project_id: l.project_id || null, tax_type: l.tax_type || null,
      })),
    });
    const personRows = db.prepare("SELECT * FROM person_ledger WHERE ref_type='manual_voucher' AND ref_id=?").all(req.params.id);
    for (const p of personRows) {
      createPersonLedgerEntry(db, {
        person_id: p.person_id, date: todayJalali(), entry_type: 'reversal',
        ref_type: 'manual_voucher_reversal', ref_id: Number(req.params.id),
        description: `ابطال ${p.description || 'سند دستی'}`, debit: p.credit, credit: p.debit, user_id: req.user.id,
      });
    }
    db.prepare("UPDATE journal_entries SET status='reversed',deleted_at=strftime('%s','now'),deleted_by=? WHERE id=?")
      .run(req.user.id, req.params.id);
  })();
  audit(req.user.id, 'reverse', 'journal_voucher', req.params.id, 'ابطال سند دستی');
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
  const lines = db.prepare(`
    SELECT jl.*, je.entry_date, je.description as entry_description, je.ref_type, je.ref_id
    FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id
    WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0
    ORDER BY je.entry_date ASC, je.id ASC
  `).all(req.params.code);
  // Normal balance side determines running-balance sign: debit-normal accounts (asset/expense/cogs) add debit, subtract credit
  const debitNormal = ['asset', 'expense', 'cogs'].includes(account.type);
  let balance = 0;
  lines.forEach(l => {
    const dr = jlDebitRial(l);
    const cr = jlCreditRial(l);
    l.debit_rial = dr;
    l.credit_rial = cr;
    balance += debitNormal ? (dr - cr) : (cr - dr);
    l.running_balance = balance;
  });
  res.json({ account, lines, balance });
});

// ============================================================
// Trial Balance — sum of debit/credit per account, must balance system-wide
// ============================================================
router.get('/trial-balance', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { from, to } = req.query;
  const safeDate = v => (v && /^[\d/]+$/.test(v)) ? v : null;
  const sf = safeDate(from), st = safeDate(to);
  const dateWhere = (sf || st) ? `WHERE je.entry_date >= '${sf || ''}' AND je.entry_date <= '${st || '9999'}' AND ${DELETED_FILTER}` : `WHERE ${DELETED_FILTER}`;
  const rows = db.prepare(`
    SELECT jl.account_code, jl.account_name,
      COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) as total_debit, COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) as total_credit
    FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id
    ${dateWhere}
    GROUP BY jl.account_code, jl.account_name
    ORDER BY jl.account_code
  `).all();
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
  res.json({ rows, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 1 });
});

// ============================================================
// Balance Sheet — assets vs liabilities + equity, as of the given date
// Note: equity here = capital account balance + accumulated net profit
// computed from all-time revenue/COGS/expense postings (no period-close
// entries are booked), which is a pragmatic approximation appropriate
// for a single-business ledger of this scale.
// ============================================================
router.get('/balance-sheet', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { asOf } = req.query;
  const safeDate = v => (v && /^[\d/]+$/.test(v)) ? v : null;
  const s = safeDate(asOf);
  const dateWhere = s ? `WHERE je.entry_date <= '${s}' AND ${DELETED_FILTER}` : `WHERE ${DELETED_FILTER}`;
  const rows = db.prepare(`
    SELECT jl.account_code, COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) d, COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) c
    FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id
    ${dateWhere}
    GROUP BY jl.account_code
  `).all();
  const accounts = db.prepare('SELECT * FROM chart_of_accounts').all();
  const accMap = {}; accounts.forEach(a => { accMap[a.code] = a; });
  const byType = { asset: [], liability: [], equity: [], revenue: [], cogs: [], expense: [] };
  let revenueTotal = 0, cogsTotal = 0, expenseTotal = 0;
  for (const r of rows) {
    const acc = accMap[r.account_code]; if (!acc) continue;
    const debitNormal = ['asset', 'expense', 'cogs'].includes(acc.type);
    const balance = debitNormal ? (r.d - r.c) : (r.c - r.d);
    if (acc.type === 'revenue') revenueTotal += balance;
    else if (acc.type === 'cogs') cogsTotal += balance;
    else if (acc.type === 'expense') expenseTotal += balance;
    else if (byType[acc.type]) byType[acc.type].push({ code: acc.code, name: acc.name, balance });
  }
  const netProfit = revenueTotal - cogsTotal - expenseTotal;
  const totalAssets = byType.asset.reduce((a, x) => a + x.balance, 0);
  const totalLiabilities = byType.liability.reduce((a, x) => a + x.balance, 0);
  const capital = byType.equity.reduce((a, x) => a + x.balance, 0);
  const totalEquity = capital + netProfit;
  res.json({
    assets: byType.asset, liabilities: byType.liability, equity: byType.equity,
    totalAssets, totalLiabilities, capital, retainedEarnings: netProfit, totalEquity,
    balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 1
  });
});

// ============================================================
// Cost centers
// ============================================================
router.get('/cost-centers', auth, (req, res) => {
  const db = getDB();
  res.json(db.prepare('SELECT * FROM cost_centers ORDER BY name').all());
});
router.post('/cost-centers', auth, adminOrAccounting, (req, res) => {
  const { name, code, entity } = req.body;
  if (!name) return res.status(400).json({ error: 'نام مرکز هزینه الزامی است' });
  const db = getDB();
  let cc = code || '';
  if (!cc) {
    const n = (db.prepare('SELECT COUNT(*) c FROM cost_centers').get().c || 0) + 1;
    cc = 'CC-' + String(n).padStart(3, '0');
  }
  const result = db.prepare('INSERT INTO cost_centers (name,code,entity) VALUES (?,?,?)').run(name, cc, entity || '');
  res.json(db.prepare('SELECT * FROM cost_centers WHERE id=?').get(result.lastInsertRowid));
});
router.put('/cost-centers/:id', auth, adminOrAccounting, (req, res) => {
  const { name, code, active, entity } = req.body;
  const db = getDB();
  db.prepare('UPDATE cost_centers SET name=?,code=?,active=?,entity=? WHERE id=?')
    .run(name, code || '', active ? 1 : 0, entity ?? '', req.params.id);
  res.json({ ok: true });
});
router.delete('/cost-centers/:id', auth, adminOrAccounting, (req, res) => {
  getDB().prepare('DELETE FROM cost_centers WHERE id=?').run(req.params.id);
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
// Shared with the B2B portal (routes/b2b.js) so customers see the exact same
// statement the accounting module produces.
module.exports.buildStatement = buildStatement;
