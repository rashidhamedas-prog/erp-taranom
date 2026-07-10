const router = require('express').Router();
const { getDB } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');

// Summary for a Jalali date range using final invoices as the revenue source.
// from/to are optional Jalali date strings (e.g. 1403/04/01).
router.get('/summary', auth, adminOnly, (req, res) => {
  const db = getDB();
  const from = req.query.from || '';
  const to = req.query.to || '';
  const invWhere = [];
  const invParams = [];
  invWhere.push("type='final'");
  if (from) { invWhere.push("date>=?"); invParams.push(from); }
  if (to)   { invWhere.push("date<=?"); invParams.push(to); }
  const invSql = 'WHERE ' + invWhere.join(' AND ');

  const invAgg = db.prepare(
    `SELECT COUNT(*) c, COALESCE(SUM(final),0) revenue FROM invoices ${invSql}`
  ).get(...invParams);

  // Outstanding debt = total invoiced minus total settled (not date-filtered on settlements)
  const totalInvoiced = db.prepare("SELECT COALESCE(SUM(final),0) s FROM invoices WHERE type='final'").get().s;
  const totalSettled  = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM settlements").get().s;
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
    WHERE type='final' AND date IS NOT NULL AND date<>'' AND length(date)>=7
    GROUP BY ym
    ORDER BY ym ASC
  `).all();
  res.json(rows);
});

// Per-salesperson breakdown using invoices
router.get('/salesperson', auth, adminOnly, (req, res) => {
  const db = getDB();
  const users = db.prepare("SELECT id,name,username FROM users WHERE active=1 ORDER BY name").all();
  const invMap = Object.fromEntries(
    db.prepare("SELECT user_id, COUNT(*) c, COALESCE(SUM(final),0) revenue FROM invoices WHERE type='final' GROUP BY user_id").all()
      .map(r => [r.user_id, { c: r.c, revenue: r.revenue }])
  );
  const custMap = Object.fromEntries(
    db.prepare('SELECT user_id, COUNT(*) c FROM customers GROUP BY user_id').all().map(r => [r.user_id, r.c])
  );
  const fupMap = Object.fromEntries(
    db.prepare("SELECT user_id, COUNT(*) c FROM followups WHERE status='open' GROUP BY user_id").all().map(r => [r.user_id, r.c])
  );
  const invCountMap = Object.fromEntries(
    db.prepare('SELECT user_id, COUNT(*) c FROM invoices GROUP BY user_id').all().map(r => [r.user_id, r.c])
  );
  const invoicedMap = Object.fromEntries(
    db.prepare("SELECT user_id, COALESCE(SUM(final),0) s FROM invoices WHERE type='final' GROUP BY user_id").all().map(r => [r.user_id, r.s])
  );
  const settledMap = Object.fromEntries(
    db.prepare('SELECT i.user_id uid, COALESCE(SUM(s.amount),0) s FROM settlements s JOIN invoices i ON s.invoice_id=i.id GROUP BY i.user_id').all().map(r => [r.uid, r.s])
  );
  const data = users.map(u => {
    const inv = invMap[u.id] || { c: 0, revenue: 0 };
    const userInvoiced = invoicedMap[u.id] || 0;
    const userSettled = settledMap[u.id] || 0;
    return {
      id: u.id, name: u.name, username: u.username,
      orders: inv.c, revenue: inv.revenue, debt: Math.max(0, userInvoiced - userSettled),
      customers: custMap[u.id] || 0, openFollowups: fupMap[u.id] || 0, invoices: invCountMap[u.id] || 0
    };
  });
  res.json(data);
});

// Top 10 customers by total final invoice value
router.get('/top-customers', auth, adminOnly, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT c.id, c.biz, c.city, c.owner, c.address,
           COUNT(i.id) orders, COALESCE(SUM(i.final),0) total,
           COALESCE(SUM(i.final),0) - COALESCE((SELECT SUM(s.amount) FROM settlements s WHERE s.cust_id=c.id),0) debt
    FROM customers c
    JOIN invoices i ON i.cust_id=c.id AND i.type='final'
    GROUP BY c.id
    ORDER BY total DESC
    LIMIT 10
  `).all();
  res.json(rows);
});

// Outstanding debt summary (invoice-based)
router.get('/debt', auth, adminOnly, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT c.id, c.biz as cust_biz, c.phone as cust_phone, u.name as salesperson,
           COALESCE(SUM(i.final),0) as total_invoiced,
           COALESCE((SELECT SUM(s.amount) FROM settlements s WHERE s.cust_id=c.id),0) as total_settled
    FROM customers c
    JOIN invoices i ON i.cust_id=c.id AND i.type='final'
    LEFT JOIN users u ON c.user_id=u.id
    GROUP BY c.id
    HAVING total_invoiced > total_settled
    ORDER BY (total_invoiced - total_settled) DESC
  `).all();
  rows.forEach(r => { r.debt = r.total_invoiced - r.total_settled; });
  const totalDebt = rows.reduce((a, r) => a + r.debt, 0);
  res.json({ rows, totalDebt });
});

module.exports = router;
