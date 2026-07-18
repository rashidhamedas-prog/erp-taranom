const router = require('express').Router();
const { getDB } = require('../db');
const { auth } = require('../middleware/auth');

function fuzzyScore(hay, needle) {
  if (!needle) return 0;
  const h = (hay || '').toLowerCase();
  const n = needle.toLowerCase();
  if (h === n) return 100;
  if (h.startsWith(n)) return 80;
  if (h.includes(n)) return 60;
  const words = n.split(/\s+/).filter(Boolean);
  if (words.every(w => h.includes(w))) return 50;
  return 0;
}

router.get('/', auth, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q || q.length < 2) return res.json([]);
  const db = getDB();
  const results = [];
  const limit = 8;

  const customers = db.prepare('SELECT id, biz, owner, phone, city FROM customers ORDER BY id DESC LIMIT 200').all();
  for (const c of customers) {
    const score = Math.max(
      fuzzyScore(c.biz, q), fuzzyScore(c.owner, q), fuzzyScore(c.phone, q), fuzzyScore(c.city, q)
    );
    if (score > 0) results.push({ type: 'customer', id: c.id, label: c.biz, sub: c.owner || c.phone || '', score, route: 'customers' });
  }

  const products = db.prepare('SELECT id, name, code, barcode FROM products ORDER BY id DESC LIMIT 200').all();
  for (const p of products) {
    const score = Math.max(fuzzyScore(p.name, q), fuzzyScore(p.code, q), fuzzyScore(p.barcode, q));
    if (score > 0) results.push({ type: 'product', id: p.id, label: p.name, sub: p.code || '', score, route: 'products' });
  }

  const invoices = db.prepare(`
    SELECT i.id, i.num, i.type, i.final, c.biz
    FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id
    WHERE COALESCE(i.deleted_at,0)=0 ORDER BY i.id DESC LIMIT 150
  `).all();
  for (const i of invoices) {
    const score = Math.max(fuzzyScore(i.num, q), fuzzyScore(i.biz, q));
    if (score > 0) results.push({
      type: 'invoice', id: i.id, label: i.num || ('فاکتور #' + i.id),
      sub: (i.biz || '') + ' — ' + Number(i.final || 0).toLocaleString('fa-IR') + ' ت',
      score, route: 'invoices',
    });
  }

  const navItems = [
    { type: 'page', id: 'dash', label: 'داشبورد', route: 'dash' },
    { type: 'page', id: 'customers', label: 'مشتریان', route: 'customers' },
    { type: 'page', id: 'invoices', label: 'فاکتورها', route: 'invoices' },
    { type: 'page', id: 'products', label: 'محصولات', route: 'products' },
    { type: 'page', id: 'followups', label: 'پیگیری‌ها', route: 'followups' },
    { type: 'page', id: 'reports', label: 'گزارشات', route: 'reports' },
    { type: 'page', id: 'settings', label: 'تنظیمات', route: 'settings' },
    { type: 'page', id: 'accounting', label: 'حسابداری', route: 'accounting' },
    { type: 'page', id: 'acc-receivables', label: 'مطالبات مشتریان', route: 'acc-receivables' },
    { type: 'page', id: 'acc-statement', label: 'صورت‌حساب مشتری', route: 'acc-statement' },
    { type: 'page', id: 'stocktaking', label: 'انبارگردانی', route: 'stocktaking' },
    { type: 'page', id: 'ai', label: 'مشاور هوشمند', route: 'ai' },
    { type: 'page', id: 'help', label: 'راهنما', route: 'help' },
  ];
  for (const n of navItems) {
    const score = fuzzyScore(n.label, q);
    if (score > 0) results.push({ ...n, sub: 'صفحه', score });
  }

  results.sort((a, b) => b.score - a.score);
  res.json(results.slice(0, 25));
});

module.exports = router;
