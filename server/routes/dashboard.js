const router = require('express').Router();
const { getDB } = require('../db');
const { auth, adminOnly, adminOrAccounting } = require('../middleware/auth');
const { rialToToman, SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');
const { DELETED_FILTER } = require('../lib/ledger');
const { getActiveFiscalYear } = require('../lib/fiscal-period');

function ok(data, message = '') {
  return { success: true, data, message };
}

// GET /api/dashboard/summary
router.get('/summary', auth, (req, res) => {
  const db = getDB();
  const role = req.user.role;
  const seesAll = ['admin', 'accounting', 'sales_manager'].includes(role);

  let cashBank = 0;
  try {
    const rows = db.prepare(`
      SELECT jl.account_code,
        COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0)
        - COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) AS bal
      FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
      WHERE ${DELETED_FILTER} AND (jl.account_code LIKE '1101%' OR jl.account_code LIKE '1102%')
      GROUP BY jl.account_code
    `).all();
    cashBank = rows.reduce((s, r) => s + r.bal, 0);
  } catch (_) { /* empty db */ }

  const today = require('../jalali').todayJalali();
  let todaySales = 0, todayPurchases = 0;
  try {
    const salesQ = seesAll
      ? db.prepare("SELECT COALESCE(SUM(final),0) s FROM invoices WHERE type='final' AND date=? AND COALESCE(deleted_at,0)=0")
      : db.prepare("SELECT COALESCE(SUM(final),0) s FROM invoices WHERE type='final' AND date=? AND user_id=? AND COALESCE(deleted_at,0)=0");
    todaySales = (seesAll ? salesQ.get(today) : salesQ.get(today, req.user.id))?.s || 0;

    todayPurchases = db.prepare("SELECT COALESCE(SUM(total),0) s FROM purchase_invoices WHERE date=?").get(today)?.s || 0;
  } catch (_) { /* tables may be empty */ }

  let receivables = 0, payables = 0;
  try {
    receivables = db.prepare('SELECT COALESCE(SUM(debit)-SUM(credit),0) b FROM customer_ledger').get()?.b || 0;
    payables = db.prepare('SELECT COALESCE(SUM(credit)-SUM(debit),0) b FROM supplier_ledger').get()?.b || 0;
  } catch (_) { /* */ }

  res.json(ok({
    cash_bank_balance_rial: Math.round(cashBank),
    cash_bank_balance_toman: rialToToman(cashBank),
    today_sales_toman: todaySales,
    today_purchases_toman: todayPurchases,
    net_receivables_toman: receivables,
    net_payables_toman: payables,
    fiscal_year: getActiveFiscalYear(db),
  }));
});

// GET /api/dashboard/kpis
router.get('/kpis', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const monthPrefix = require('../jalali').todayJalali().slice(0, 7);
  const monthSales = db.prepare("SELECT COALESCE(SUM(final),0) s, COUNT(*) c FROM invoices WHERE type='final' AND date LIKE ? AND COALESCE(deleted_at,0)=0").get(monthPrefix + '%');

  const debtors = db.prepare(`
    SELECT c.id, c.biz, COALESCE(SUM(cl.debit)-SUM(cl.credit),0) bal
    FROM customers c JOIN customer_ledger cl ON cl.customer_id=c.id
    GROUP BY c.id HAVING bal > 0 ORDER BY bal DESC LIMIT 5
  `).all();

  res.json(ok({
    month_sales_toman: monthSales?.s || 0,
    month_invoice_count: monthSales?.c || 0,
    top_debtors: debtors,
  }));
});

// GET /api/dashboard/alerts
router.get('/alerts', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const alerts = [];
  const today = require('../jalali').todayJalali();

  try {
    const chequesDue = db.prepare(`
      SELECT COUNT(*) c FROM settlements
      WHERE pay_type='cheque' AND cheque_status='pending' AND cheque_due <= date(?, '+7 days')
    `).get(today)?.c;
    if (chequesDue) alerts.push({ type: 'cheque_due', count: chequesDue, message: `${chequesDue} چک تا ۷ روز آینده سررسید` });
  } catch (_) { /* */ }

  try {
    const lowStock = db.prepare('SELECT COUNT(*) c FROM products WHERE stock <= COALESCE(stock_alert,5)').get()?.c;
    if (lowStock) alerts.push({ type: 'low_stock', count: lowStock, message: `${lowStock} کالا زیر حد هشدار` });
  } catch (_) { /* */ }

  try {
    const drafts = db.prepare("SELECT COUNT(*) c FROM journal_entries WHERE status='draft' AND COALESCE(deleted_at,0)=0").get()?.c;
    if (drafts) alerts.push({ type: 'draft_vouchers', count: drafts, message: `${drafts} سند پیش‌نویس` });
  } catch (_) { /* status column may not exist yet */ }

  res.json(ok({ alerts }));
});

// GET /api/dashboard/charts/sales-trend
router.get('/charts/sales-trend', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const range = req.query.range || '30d';
  const days = range === '12m' ? 365 : range === '90d' ? 90 : 30;
  const rows = db.prepare(`
    SELECT date, COALESCE(SUM(final),0) total
    FROM invoices WHERE type='final' AND COALESCE(deleted_at,0)=0
    GROUP BY date ORDER BY date DESC LIMIT ?
  `).all(days);
  res.json(ok({ range, points: rows.reverse() }));
});

// GET /api/dashboard/pending-approvals
router.get('/pending-approvals', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const items = [];
  try {
    const inv = db.prepare("SELECT id,num,final,date FROM invoices WHERE type='final' AND COALESCE(approved,0)=0 AND COALESCE(deleted_at,0)=0 LIMIT 20").all();
    inv.forEach(i => items.push({ type: 'invoice_commission', ...i }));
  } catch (_) { /* */ }
  try {
    const jv = db.prepare("SELECT id,voucher_number,entry_date,description FROM journal_entries WHERE status='pending_approval' AND COALESCE(deleted_at,0)=0 LIMIT 20").all();
    jv.forEach(j => items.push({ type: 'journal_voucher', ...j }));
  } catch (_) { /* */ }
  res.json(ok({ items }));
});

module.exports = router;
