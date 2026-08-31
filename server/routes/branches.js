'use strict';
const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');

router.get('/', auth, (req, res) => {
  const db = getDB();
  res.json(db.prepare('SELECT * FROM branches WHERE COALESCE(active,1)=1 ORDER BY id').all());
});

router.post('/', auth, adminOnly, (req, res) => {
  const code = String(req.body.code || '').trim();
  const name = String(req.body.name || '').trim();
  if (!code || !name) return res.status(400).json({ error: 'کد و نام شعبه الزامی است' });
  const db = getDB();
  try {
    const r = db.prepare('INSERT INTO branches (code,name) VALUES (?,?)').run(code, name);
    audit(req.user.id, 'create', 'branch', r.lastInsertRowid, code);
    res.json(db.prepare('SELECT * FROM branches WHERE id=?').get(r.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: e.message || 'ثبت شعبه ناموفق' });
  }
});

module.exports = router;
