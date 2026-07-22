const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');

// "دسته چک" — one of our own checkbooks, always tied to a specific bank.
// Used when WE issue a cheque (supplier payments, incentive payments,
// cash-basis purchase invoices) so each cheque leaf can be traced back to
// its bank and serial range.

router.get('/', auth, (req, res) => {
  const db = getDB();
  const { bank_id } = req.query;
  const rows = bank_id
    ? db.prepare('SELECT cc.*, b.name as bank_name FROM check_categories cc LEFT JOIN banks b ON cc.bank_id=b.id WHERE cc.bank_id=? ORDER BY cc.id DESC').all(bank_id)
    : db.prepare('SELECT cc.*, b.name as bank_name FROM check_categories cc LEFT JOIN banks b ON cc.bank_id=b.id ORDER BY cc.id DESC').all();
  res.json(rows);
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const { bank_id, name, serial_from, serial_to, holder_name, leaf_count, current_leaf, note } = req.body;
  if (!bank_id) return res.status(400).json({ error: 'بانک الزامی است' });
  if (!name) return res.status(400).json({ error: 'نام دسته چک الزامی است' });
  const db = getDB();
  const bank = db.prepare('SELECT id FROM banks WHERE id=?').get(bank_id);
  if (!bank) return res.status(404).json({ error: 'بانک یافت نشد' });
  const result = db.prepare(
    'INSERT INTO check_categories (bank_id,name,serial_from,serial_to,holder_name,leaf_count,current_leaf,note) VALUES (?,?,?,?,?,?,?,?)'
  ).run(bank_id, name, serial_from || '', serial_to || '', holder_name || '',
    parseInt(leaf_count, 10) || 0, current_leaf || '', note || '');
  audit(req.user.id, 'create', 'check_category', result.lastInsertRowid, `ساخت دسته چک ${name}`);
  res.json(db.prepare('SELECT * FROM check_categories WHERE id=?').get(result.lastInsertRowid));
});

router.put('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM check_categories WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const { bank_id, name, serial_from, serial_to, active, holder_name, leaf_count, current_leaf, note } = req.body;
  db.prepare(`UPDATE check_categories SET bank_id=?,name=?,serial_from=?,serial_to=?,active=?,
    holder_name=?,leaf_count=?,current_leaf=?,note=? WHERE id=?`)
    .run(bank_id || row.bank_id, name || row.name, serial_from ?? row.serial_from, serial_to ?? row.serial_to,
      active != null ? (active ? 1 : 0) : row.active,
      holder_name ?? row.holder_name ?? '', leaf_count != null ? parseInt(leaf_count, 10) : (row.leaf_count || 0),
      current_leaf ?? row.current_leaf ?? '', note ?? row.note ?? '', req.params.id);
  audit(req.user.id, 'update', 'check_category', req.params.id, `ویرایش دسته چک`);
  res.json({ ok: true });
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM check_categories WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const refs =
    db.prepare('SELECT COUNT(*) c FROM purchase_invoices WHERE check_category_id=?').get(req.params.id).c +
    db.prepare('SELECT COUNT(*) c FROM supplier_payments WHERE check_category_id=?').get(req.params.id).c +
    db.prepare('SELECT COUNT(*) c FROM incentive_payments WHERE check_category_id=?').get(req.params.id).c;
  if (refs > 0) return res.status(400).json({ error: 'این دسته چک استفاده شده و قابل حذف نیست — می‌توانید آن را غیرفعال کنید' });
  db.prepare('DELETE FROM check_categories WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'check_category', req.params.id, 'حذف دسته چک');
  res.json({ ok: true });
});

module.exports = router;
