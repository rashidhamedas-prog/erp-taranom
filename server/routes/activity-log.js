const router = require('express').Router();
const { getDB } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');

router.get('/', auth, adminOnly, (req, res) => {
  const db = getDB();
  const { limit, user_id, action } = req.query;
  const lim = Math.min(parseInt(limit, 10) || 100, 500);
  let sql = 'SELECT * FROM user_activity_log WHERE 1=1';
  const params = [];
  if (user_id) { sql += ' AND user_id=?'; params.push(parseInt(user_id, 10)); }
  if (action) { sql += ' AND action=?'; params.push(action); }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(lim);
  res.json({ success: true, data: db.prepare(sql).all(...params) });
});

module.exports = router;
