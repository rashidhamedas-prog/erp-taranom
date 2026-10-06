const router = require('express').Router();
const { getDB } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { rialToToman } = require('../lib/money');
const { getActiveFiscalYear } = require('../lib/fiscal-period');
const { firmSaleTypeSql } = require('../lib/sales-document');
const { canonicalCustomerFold, customerSignedBalanceMap } = require('../lib/customer-books');
const { scopeUserId, customerVisibilitySql } = require('../lib/customer-scope');

function ok(data, message = '') {
  return { success: true, data, message };
}

/**
 * Company-wide financial aggregates: admin + accounting only.
 * Everyone else (incl. sales_manager / delegated) gets customer-scoped numbers.
 */
// GET /api/dashboard/summary
router.get('/summary', auth, (req, res) => {
  const db = getDB();
  const uid = scopeUserId(req);
  const companyWide = uid == null;

  let cashBank = 0;
  let todayPurchases = 0;
  let payables = 0;
  if (companyWide) {
    try {
      cashBank = require('../lib/cash-flow').sumCashBankBalanceRial(db);
    } catch (_) { /* empty db */ }
  }

  const today = require('../jalali').todayJalali();
  let todaySales = 0;
  try {
    if (companyWide) {
      todaySales = db.prepare(
        `SELECT COALESCE(SUM(final),0) s FROM invoices WHERE ${firmSaleTypeSql()} AND date=? AND COALESCE(deleted_at,0)=0`
      ).get(today)?.s || 0;
      todayPurchases = db.prepare('SELECT COALESCE(SUM(total),0) s FROM purchase_invoices WHERE date=?').get(today)?.s || 0;
    } else {
      // Scope by customer ownership (not invoice issuer alone)
      todaySales = db.prepare(`
        SELECT COALESCE(SUM(i.final),0) s
        FROM invoices i
        JOIN customers c ON c.id = i.cust_id
        WHERE ${firmSaleTypeSql('i')} AND i.date=? AND COALESCE(i.deleted_at,0)=0
          AND ${customerVisibilitySql('c')}
      `).get(today, uid, uid)?.s || 0;
    }
  } catch (_) { /* tables may be empty */ }

  let receivables = 0;
  try {
    receivables = canonicalCustomerFold(db, { userId: uid }).signed;
    if (companyWide) {
      payables = db.prepare('SELECT COALESCE(SUM(credit)-SUM(debit),0) b FROM supplier_ledger').get()?.b || 0;
    }
  } catch (_) { /* */ }

  res.json(ok({
    cash_bank_balance_rial: companyWide ? Math.round(cashBank) : 0,
    cash_bank_balance_toman: companyWide ? rialToToman(cashBank) : 0,
    today_sales_toman: todaySales,
    today_purchases_toman: companyWide ? todayPurchases : 0,
    net_receivables_toman: receivables,
    net_payables_toman: companyWide ? payables : 0,
    fiscal_year: getActiveFiscalYear(db),
    scoped: !companyWide,
  }));
});

// GET /api/dashboard/kpis — company finance only
router.get('/kpis', auth, adminOrAccounting, (req, res) => {
  if (scopeUserId(req) != null) {
    return res.status(403).json({ error: 'آمار سراسری فقط برای مدیر و حسابداری است' });
  }
  const db = getDB();
  const monthPrefix = require('../jalali').todayJalali().slice(0, 7);
  const monthSales = db.prepare(`SELECT COALESCE(SUM(final),0) s, COUNT(*) c FROM invoices WHERE ${firmSaleTypeSql()} AND date LIKE ? AND COALESCE(deleted_at,0)=0`).get(monthPrefix + '%');

  const balMap = customerSignedBalanceMap(db);
  const debtors = db.prepare('SELECT id, biz FROM customers').all()
    .map((c) => ({ id: c.id, biz: c.biz, bal: Number(balMap.get(c.id) || 0) }))
    .filter((c) => c.bal > 0)
    .sort((a, b) => b.bal - a.bal)
    .slice(0, 5);

  res.json(ok({
    month_sales_toman: monthSales?.s || 0,
    month_invoice_count: monthSales?.c || 0,
    top_debtors: debtors,
  }));
});

// GET /api/dashboard/alerts
router.get('/alerts', auth, adminOrAccounting, (req, res) => {
  if (scopeUserId(req) != null) {
    return res.status(403).json({ error: 'هشدارهای سراسری فقط برای مدیر و حسابداری است' });
  }
  const db = getDB();
  const alerts = [];
  const today = require('../jalali').todayJalali();

  try {
    const horizon = require('../jalali').addDaysToJalali(today, 7);
    const chequesDue = require('../lib/cheque-due').countOpenDueCheques(db, horizon);
    if (chequesDue) alerts.push({ type: 'cheque_due', count: chequesDue, message: `${chequesDue} چک سررسیدشده یا تا ۷ روز آینده` });
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
  if (scopeUserId(req) != null) {
    return res.status(403).json({ error: 'نمودار سراسری فقط برای مدیر و حسابداری است' });
  }
  const db = getDB();
  const range = req.query.range || '30d';
  const days = range === '12m' ? 365 : range === '90d' ? 90 : 30;
  const rows = db.prepare(`
    SELECT date, COALESCE(SUM(final),0) total
    FROM invoices WHERE ${firmSaleTypeSql()} AND COALESCE(deleted_at,0)=0
    GROUP BY date ORDER BY date DESC LIMIT ?
  `).all(days);
  res.json(ok({ range, points: rows.reverse() }));
});

// GET /api/dashboard/pending-approvals
router.get('/pending-approvals', auth, adminOrAccounting, (req, res) => {
  if (scopeUserId(req) != null) {
    return res.status(403).json({ error: 'اقدامات سراسری فقط برای مدیر و حسابداری است' });
  }
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
