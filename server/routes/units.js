const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');

router.get('/', auth, (req, res) => {
  const db = getDB();
  res.json(db.prepare('SELECT * FROM units_of_measure WHERE is_active=1 ORDER BY name').all());
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const { code, name } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'کد و نام الزامی است' });
  const db = getDB();
  try {
    const r = db.prepare('INSERT INTO units_of_measure (code,name) VALUES (?,?)').run(code.toUpperCase(), name);
    audit(req.user.id, 'create', 'unit_of_measure', r.lastInsertRowid, name);
    res.json(db.prepare('SELECT * FROM units_of_measure WHERE id=?').get(r.lastInsertRowid));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'کد واحد تکراری است' });
    throw e;
  }
});

router.put('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM units_of_measure WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const { name, is_active } = req.body;
  db.prepare('UPDATE units_of_measure SET name=?, is_active=? WHERE id=?')
    .run(name || row.name, is_active != null ? (is_active ? 1 : 0) : row.is_active, req.params.id);
  res.json({ ok: true });
});

module.exports = router;
