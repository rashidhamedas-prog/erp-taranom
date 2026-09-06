const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { canSeeAllProductGroups, userCatalogAclIds } = require('../lib/product-visibility');

function validateGroupCoa(db, code) {
  const c = String(code || '').trim();
  if (!c) return { ok: true, coa_code: null };
  const acc = db.prepare('SELECT code FROM chart_of_accounts WHERE code=? AND is_active=1').get(c);
  if (!acc) return { error: 'حساب معین در کدینگ یافت نشد' };
  const hasChild = db.prepare(
    'SELECT 1 FROM chart_of_accounts WHERE parent_code=? AND is_active=1 LIMIT 1'
  ).get(acc.code);
  if (hasChild) {
    return { error: 'فقط حساب برگ (معین بدون فرزند فعال) مجاز است', code: 'E_COA_NOT_POSTABLE' };
  }
  return { ok: true, coa_code: acc.code };
}

// گروه‌های خصوصی (is_shared=0) فقط برای ایجادکننده / مدیر / حسابدار.
router.get('/', auth, (req, res) => {
  const db = getDB();
  const forAccess = req.query.for === 'access' || req.query.for === 'acl';
  // for=access: master list for ACL / dropdowns — no per-user catalog filter
  const visibility = (forAccess || canSeeAllProductGroups(req.user))
    ? ''
    : 'WHERE (c.is_shared=1 OR c.created_by=?)';
  const args = visibility ? [req.user.id] : [];
  let rows = db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id=c.id) as product_count
    FROM product_categories c ${visibility} ORDER BY c.sort_order, c.name
  `).all(...args);
  if (!forAccess) {
    const acl = userCatalogAclIds(db, req.user);
    if (acl && acl.length) {
      const set = new Set(acl);
      rows = rows.filter(c => set.has(c.id));
    }
  }
  // فقط فعال‌ها برای لیست دسترسی/انتخاب (مگر admin با all=1)
  if (req.query.all !== '1') {
    rows = rows.filter(c => c.active !== 0);
  }
  res.json(rows);
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const { name, sort_order, code, parent_id, description, is_shared, coa_code } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'نام دسته الزامی است' });
  const db = getDB();
  const exists = db.prepare('SELECT id FROM product_categories WHERE name=?').get(String(name).trim());
  if (exists) return res.status(400).json({ error: 'این دسته قبلاً ثبت شده' });
  const coa = validateGroupCoa(db, coa_code);
  if (coa.error) return res.status(400).json({ error: coa.error, code: coa.code });
  const c = parseInt(code) || (db.prepare('SELECT COALESCE(MAX(code),0)+1 c FROM product_categories').get().c);
  const shared = is_shared === false || is_shared === 0 ? 0 : 1;
  const result = db.prepare('INSERT INTO product_categories (name,sort_order,code,parent_id,description,is_shared,created_by,coa_code) VALUES (?,?,?,?,?,?,?,?)')
    .run(String(name).trim(), parseInt(sort_order) || c, c, parent_id ? parseInt(parent_id) : null,
      description || '', shared, req.user.id, coa.coa_code);
  // کاربر دوباره تعریف می‌کند — فلگ cleared را بردار تا با خالی بودن اشتباه نشود
  try {
    db.prepare("DELETE FROM settings WHERE key='product_categories_user_cleared'").run();
  } catch (_) { /* ignore */ }
  audit(req.user.id, 'create', 'product_category', result.lastInsertRowid, `ساخت دسته ${name}`);
  res.json(db.prepare('SELECT * FROM product_categories WHERE id=?').get(result.lastInsertRowid));
});

router.put('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM product_categories WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const { name, sort_order, active, code, parent_id, description, is_shared, coa_code } = req.body;
  const shared = is_shared != null ? (is_shared ? 1 : 0) : row.is_shared;
  const nextCoa = coa_code !== undefined ? validateGroupCoa(db, coa_code) : { ok: true, coa_code: row.coa_code };
  if (nextCoa.error) return res.status(400).json({ error: nextCoa.error, code: nextCoa.code });
  db.prepare('UPDATE product_categories SET name=?,sort_order=?,active=?,code=?,parent_id=?,description=?,is_shared=?,coa_code=? WHERE id=?')
    .run(name || row.name, sort_order != null ? (parseInt(sort_order) || 0) : row.sort_order,
      active != null ? (active ? 1 : 0) : row.active,
      code != null ? (parseInt(code) || row.code) : row.code,
      parent_id != null ? (parent_id ? parseInt(parent_id) : null) : row.parent_id,
      description ?? row.description,
      shared, nextCoa.coa_code, req.params.id);
  audit(req.user.id, 'update', 'product_category', req.params.id, `ویرایش دسته ${name || row.name}`);
  res.json({ ok: true });
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM product_categories WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const inUse = db.prepare('SELECT COUNT(*) c FROM products WHERE category_id=?').get(req.params.id).c;
  if (inUse > 0) return res.status(400).json({ error: 'این دسته برای محصولاتی استفاده شده و قابل حذف نیست' });
  const kids = db.prepare('SELECT COUNT(*) c FROM product_categories WHERE parent_id=?').get(req.params.id).c;
  if (kids > 0) return res.status(400).json({ error: 'ابتدا زیرگروه‌های این گروه را حذف کنید' });

  db.transaction(() => {
    // وابستگی زنده ACL کاتالوگ کاربر — با حذف گروه پاک می‌شود
    try {
      db.prepare('DELETE FROM user_catalog_categories WHERE category_id=?').run(req.params.id);
    } catch (_) { /* table may not exist on very old DBs */ }
    db.prepare('DELETE FROM product_categories WHERE id=?').run(req.params.id);
    const left = db.prepare('SELECT COUNT(*) c FROM product_categories').get().c;
    if (left === 0) {
      db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('product_categories_user_cleared','1')").run();
    }
  })();

  audit(req.user.id, 'delete', 'product_category', req.params.id, `حذف دسته ${row.name}`);
  res.json({ ok: true });
});

module.exports = router;
