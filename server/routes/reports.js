const router = require('express').Router();
const { getDB } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');

// Summary for a Jalali date range using final invoices as the revenue source.
// from/to are optional Jalali date strings (e.g. 1403/04/01).
router.get('/summary', auth, adminOnly, (req, res) => {
  const db = getDB();
  const from = req.query.from || '';
  const to = req.query.to || '';
  const invWhere = ['tenant_id=?', "type='final'"];
  const invParams = [req.tenantId];
  if (from) { invWhere.push('date>=?'); invParams.push(from); }
  if (to)   { invWhere.push('date<=?'); invParams.push(to); }
  const invSql = 'WHERE ' + invWhere.join(' AND ');

  const invAgg = db.prepare(
    `SELECT COUNT(*) c, COALESCE(SUM(final),0) revenue FROM invoices ${invSql}`
  ).get(...invParams);

  // Outstanding debt = total invoiced minus total settled (not date-filtered on settlements)
  const totalInvoiced = db.prepare("SELECT COALESCE(SUM(final),0) s FROM invoices WHERE tenant_id=? AND type='final'").get(req.tenantId).s;
  const totalSettled  = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM settlements WHERE tenant_id=?').get(req.tenantId).s;
  const debt = Math.max(0, totalInvoiced - totalSettled);

  // distinct customers with a final invoice in range
  const custCount = db.prepare(
    `SELECT COUNT(DISTINCT cust_id) c FROM invoices ${invSql}`
  ).get(...invParams).c;

  res.json({
    from, to,
    orders: invAgg.c,       // invoice count (kept field name for UI compat)
    revenue: invAgg.revenue,
    paid: totalSettled,
    debt,
    customers: custCount
  });
});

// Revenue grouped by Jalali month from final invoices
router.get('/monthly', auth, adminOnly, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT substr(date,1,7) as ym, COUNT(*) orders, COALESCE(SUM(final),0) revenue
    FROM invoices
    WHERE tenant_id=? AND type='final' AND date IS NOT NULL AND date<>'' AND length(date)>=7
    GROUP BY ym
    ORDER BY ym ASC
  `).all(req.tenantId);
  res.json(rows);
});

// Per-salesperson breakdown using invoices
router.get('/salesperson', auth, adminOnly, (req, res) => {
  const db = getDB();
  const users = db.prepare('SELECT id,name,username FROM users WHERE tenant_id=? AND active=1 ORDER BY name').all(req.tenantId);
  const data = users.map(u => {
    const inv = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(final),0) revenue FROM invoices WHERE tenant_id=? AND user_id=? AND type='final'").get(req.tenantId, u.id);
    const customers = db.prepare('SELECT COUNT(*) c FROM customers WHERE tenant_id=? AND user_id=?').get(req.tenantId, u.id).c;
    const openFollowups = db.prepare("SELECT COUNT(*) c FROM followups WHERE tenant_id=? AND user_id=? AND status='open'").get(req.tenantId, u.id).c;
    const invoices = db.prepare('SELECT COUNT(*) c FROM invoices WHERE tenant_id=? AND user_id=?').get(req.tenantId, u.id).c;
    // Per-user outstanding: invoiced minus settled
    const userInvoiced = db.prepare("SELECT COALESCE(SUM(final),0) s FROM invoices WHERE tenant_id=? AND user_id=? AND type='final'").get(req.tenantId, u.id).s;
    const userSettled  = db.prepare('SELECT COALESCE(SUM(s.amount),0) s FROM settlements s JOIN invoices i ON s.invoice_id=i.id WHERE s.tenant_id=? AND i.user_id=?').get(req.tenantId, u.id).s;
    return {
      id: u.id, name: u.name, username: u.username,
      orders: inv.c, revenue: inv.revenue, debt: Math.max(0, userInvoiced - userSettled),
      customers, openFollowups, invoices
    };
  });
  res.json(data);
});

// Top 10 customers by total final invoice value
router.get('/top-customers', auth, adminOnly, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT c.id, c.biz, c.city, c.owner,
           COUNT(i.id) orders, COALESCE(SUM(i.final),0) total,
           COALESCE(SUM(i.final),0) - COALESCE((SELECT SUM(s.amount) FROM settlements s WHERE s.cust_id=c.id AND s.tenant_id=c.tenant_id),0) debt
    FROM customers c
    JOIN invoices i ON i.cust_id=c.id AND i.type='final' AND i.tenant_id=c.tenant_id
    WHERE c.tenant_id=?
    GROUP BY c.id
    ORDER BY total DESC
    LIMIT 10
  `).all(req.tenantId);
  res.json(rows);
});

// Outstanding debt summary (invoice-based)
router.get('/debt', auth, adminOnly, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT c.id, c.biz as cust_biz, c.phone as cust_phone, u.name as salesperson,
           COALESCE(SUM(i.final),0) as total_invoiced,
           COALESCE((SELECT SUM(s.amount) FROM settlements s WHERE s.cust_id=c.id AND s.tenant_id=c.tenant_id),0) as total_settled
    FROM customers c
    JOIN invoices i ON i.cust_id=c.id AND i.type='final' AND i.tenant_id=c.tenant_id
    LEFT JOIN users u ON c.user_id=u.id
    WHERE c.tenant_id=?
    GROUP BY c.id
    HAVING total_invoiced > total_settled
    ORDER BY (total_invoiced - total_settled) DESC
  `).all(req.tenantId);
  rows.forEach(r => { r.debt = r.total_invoiced - r.total_settled; });
  const totalDebt = rows.reduce((a, r) => a + r.debt, 0);
  res.json({ rows, totalDebt });
});

// Moadian compliance: share of final invoices in the period that reached the tax authority
router.get('/einvoice-compliance', auth, adminOnly, (req, res) => {
  const db = getDB();
  const safeDate = v => (v && /^[\d/]+$/.test(v)) ? v : null;
  const sf = safeDate(req.query.from), st = safeDate(req.query.to);
  const dateClause = sf || st ? ` AND i.date >= '${sf || ''}' AND i.date <= '${st || '9999'}'` : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM invoices i WHERE i.tenant_id=? AND i.type='final'${dateClause}`).get(req.tenantId).c;
  const byStatus = db.prepare(`
    SELECT s.status, COUNT(DISTINCT s.invoice_id) c
    FROM einvoice_submissions s JOIN invoices i ON s.invoice_id=i.id
    WHERE s.tenant_id=? AND i.type='final'${dateClause}
    GROUP BY s.status
  `).all(req.tenantId);
  const statusMap = Object.fromEntries(byStatus.map(r => [r.status, r.c]));
  const confirmed = statusMap.confirmed || 0;
  const notSubmitted = Math.max(0, total - byStatus.reduce((a, r) => a + r.c, 0));
  const rows = db.prepare(`
    SELECT i.id, i.num, i.date, i.final, c.biz as cust_biz,
           COALESCE(s.status,'not_submitted') as einvoice_status, s.tax_id, s.error, s.attempts
    FROM invoices i
    LEFT JOIN einvoice_submissions s ON s.invoice_id=i.id AND s.tenant_id=i.tenant_id
      AND s.id=(SELECT MAX(id) FROM einvoice_submissions WHERE invoice_id=i.id)
    LEFT JOIN customers c ON i.cust_id=c.id
    WHERE i.tenant_id=? AND i.type='final'${dateClause}
    ORDER BY i.created_at DESC LIMIT 500
  `).all(req.tenantId);
  res.json({
    total, confirmed, pending: statusMap.pending || 0, error: statusMap.error || 0,
    cancelled: statusMap.cancelled || 0, not_submitted: notSubmitted,
    compliance_pct: total ? Math.round(confirmed / total * 100) : 0,
    rows,
  });
});

module.exports = router;
