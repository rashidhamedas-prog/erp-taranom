const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');

// Update 11 / B1: گروه‌های کالا برچسب گزارشی سراسری‌اند — بدون فیلتر دیده‌شدن.
router.get('/', auth, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id=c.id) as product_count
    FROM product_categories c ORDER BY c.sort_order, c.name
  `).all();
  res.json(rows);
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const { name, sort_order, code, parent_id, description } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'نام دسته الزامی است' });
  const db = getDB();
  const exists = db.prepare('SELECT id FROM product_categories WHERE name=?').get(String(name).trim());
  if (exists) return res.status(400).json({ error: 'این دسته قبلاً ثبت شده' });
  const c = parseInt(code) || (db.prepare('SELECT COALESCE(MAX(code),0)+1 c FROM product_categories').get().c);
  const result = db.prepare('INSERT INTO product_categories (name,sort_order,code,parent_id,description,is_shared,created_by) VALUES (?,?,?,?,?,?,?)')
    .run(String(name).trim(), parseInt(sort_order) || c, c, parent_id ? parseInt(parent_id) : null,
      description || '', 1, req.user.id);
  audit(req.user.id, 'create', 'product_category', result.lastInsertRowid, `ساخت دسته ${name}`);
  res.json(db.prepare('SELECT * FROM product_categories WHERE id=?').get(result.lastInsertRowid));
});

router.put('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM product_categories WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const { name, sort_order, active, code, parent_id, description } = req.body;
  db.prepare('UPDATE product_categories SET name=?,sort_order=?,active=?,code=?,parent_id=?,description=?,is_shared=1 WHERE id=?')
    .run(name || row.name, sort_order != null ? (parseInt(sort_order) || 0) : row.sort_order,
      active != null ? (active ? 1 : 0) : row.active,
      code != null ? (parseInt(code) || row.code) : row.code,
      parent_id != null ? (parent_id ? parseInt(parent_id) : null) : row.parent_id,
      description ?? row.description, req.params.id);
  audit(req.user.id, 'update', 'product_category', req.params.id, `ویرایش دسته ${name || row.name}`);
  res.json({ ok: true });
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM product_categories WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const inUse = db.prepare('SELECT COUNT(*) c FROM products WHERE category_id=?').get(req.params.id).c;
  if (inUse > 0) return res.status(400).json({ error: 'این دسته برای محصولاتی استفاده شده و قابل حذف نیست' });
  db.prepare('DELETE FROM product_categories WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'product_category', req.params.id, `حذف دسته ${row.name}`);
  res.json({ ok: true });
});

module.exports = router;
