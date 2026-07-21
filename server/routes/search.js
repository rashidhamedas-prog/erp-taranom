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

  const products = db.prepare(`
    SELECT p.id, p.name, p.code, p.barcode, p.category_id, pc.name as category_name, pc.parent_id,
      (SELECT name FROM product_categories WHERE id=pc.parent_id) as parent_category_name
    FROM products p
    LEFT JOIN product_categories pc ON pc.id=p.category_id
    ORDER BY p.id DESC LIMIT 200
  `).all();
  for (const p of products) {
    const score = Math.max(fuzzyScore(p.name, q), fuzzyScore(p.code, q), fuzzyScore(p.barcode, q));
    if (score > 0) {
      const groupLabel = [p.parent_category_name, p.category_name].filter(Boolean).join(' › ');
      results.push({
        type: 'product', id: p.id, label: p.name, sub: (p.code || '') + (groupLabel ? ' — ' + groupLabel : ''),
        score, route: 'acc-products', category_id: p.category_id || null,
        category_name: p.category_name || null, parent_category_name: p.parent_category_name || null,
      });
    }
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

  try {
    const persons = db.prepare(`
      SELECT p.id, p.name, p.phone, p.category_id, pc.name as category_name,
        (SELECT name FROM person_categories WHERE id=pc.parent_id) as parent_category_name
      FROM persons p
      LEFT JOIN person_categories pc ON pc.id=p.category_id
      ORDER BY p.id DESC LIMIT 200
    `).all();
    for (const p of persons) {
      const score = Math.max(fuzzyScore(p.name, q), fuzzyScore(p.phone, q));
      if (score > 0) {
        const groupLabel = [p.parent_category_name, p.category_name].filter(Boolean).join(' › ');
        results.push({
          type: 'person', id: p.id, label: p.name,
          sub: (p.phone || '') + (groupLabel ? ' — ' + groupLabel : ''),
          score, route: 'acc-persons', category_id: p.category_id || null,
          category_name: p.category_name || null, parent_category_name: p.parent_category_name || null,
        });
      }
    }
  } catch (_) { /* persons table/columns may be missing on old DBs */ }

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
