const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  // Count unique registered people: parties is source of truth; add legacy
  // customers/suppliers only when not already linked via party_id; persons stay separate.
  const rows = db.prepare(`
    SELECT g.*,
      (SELECT COUNT(*) FROM parties pt WHERE pt.party_group_id=g.id) +
      (SELECT COUNT(*) FROM customers c WHERE c.party_group_id=g.id AND c.party_id IS NULL) +
      (SELECT COUNT(*) FROM suppliers s WHERE s.party_group_id=g.id AND s.party_id IS NULL) +
      (SELECT COUNT(*) FROM persons p WHERE p.party_group_id=g.id) AS entity_count
    FROM party_groups g ORDER BY g.code
  `).all();
  res.json(rows);
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const { name, code, entity_type, description, is_marketer } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'نام گروه الزامی است' });
  const db = getDB();
  const exists = db.prepare('SELECT id FROM party_groups WHERE name=?').get(String(name).trim());
  if (exists) return res.status(400).json({ error: 'این گروه قبلاً ثبت شده' });
  const c = parseInt(code) || (db.prepare('SELECT COALESCE(MAX(code),0)+1 c FROM party_groups').get().c);
  const result = db.prepare('INSERT INTO party_groups (code,name,entity_type,description,is_marketer) VALUES (?,?,?,?,?)')
    .run(c, String(name).trim(), entity_type || 'all', description || '', is_marketer ? 1 : 0);
  audit(req.user.id, 'create', 'party_group', result.lastInsertRowid, `ساخت گروه اشخاص ${name}`);
  res.json(db.prepare('SELECT * FROM party_groups WHERE id=?').get(result.lastInsertRowid));
});

router.put('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM party_groups WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const { name, entity_type, description, active, is_marketer } = req.body;
  db.prepare('UPDATE party_groups SET name=?,entity_type=?,description=?,active=?,is_marketer=? WHERE id=?')
    .run(name || row.name, entity_type || row.entity_type, description ?? row.description,
      active != null ? (active ? 1 : 0) : row.active,
      is_marketer != null ? (is_marketer ? 1 : 0) : (row.is_marketer || 0),
      req.params.id);
  audit(req.user.id, 'update', 'party_group', req.params.id, `ویرایش گروه ${name || row.name}`);
  res.json({ ok: true });
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM party_groups WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const inUse = db.prepare(`
    SELECT (SELECT COUNT(*) FROM customers WHERE party_group_id=?) +
           (SELECT COUNT(*) FROM suppliers WHERE party_group_id=?) +
           (SELECT COUNT(*) FROM persons WHERE party_group_id=?) +
           (SELECT COUNT(*) FROM parties WHERE party_group_id=?) c
  `).get(req.params.id, req.params.id, req.params.id, req.params.id).c;
  if (inUse > 0) return res.status(400).json({ error: 'این گروه برای اشخاصی استفاده شده و قابل حذف نیست' });
  db.prepare('DELETE FROM party_groups WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'party_group', req.params.id, `حذف گروه ${row.name}`);
  res.json({ ok: true });
});

module.exports = router;
