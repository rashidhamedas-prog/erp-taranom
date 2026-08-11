'use strict';
/**
 * Person positions (سمت/جایگاه) — report tags only (Update 11 / P2).
 */
const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');

router.get('/', auth, (req, res) => {
  const db = getDB();
  res.json(db.prepare('SELECT * FROM person_positions WHERE active=1 ORDER BY name').all());
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'نام سمت الزامی است' });
  const db = getDB();
  try {
    const r = db.prepare('INSERT INTO person_positions (name) VALUES (?)').run(name);
    audit(req.user.id, 'create', 'person_position', r.lastInsertRowid, name);
    res.json(db.prepare('SELECT * FROM person_positions WHERE id=?').get(r.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: 'این سمت قبلاً ثبت شده' });
  }
});

router.put('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM person_positions WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const name = req.body.name != null ? String(req.body.name).trim() : row.name;
  const active = req.body.active != null ? (req.body.active ? 1 : 0) : row.active;
  db.prepare('UPDATE person_positions SET name=?,active=? WHERE id=?').run(name, active, req.params.id);
  res.json({ ok: true });
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const inUse = db.prepare('SELECT COUNT(*) c FROM persons WHERE position_id=?').get(req.params.id).c;
  if (inUse > 0) return res.status(400).json({ error: 'این سمت برای اشخاصی استفاده شده' });
  db.prepare('DELETE FROM person_positions WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
