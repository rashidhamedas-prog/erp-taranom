const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { direction, status } = req.query;
  const where = [], params = [];
  if (direction) { where.push('direction=?'); params.push(direction); }
  if (status) { where.push('status LIKE ?'); params.push('%' + status + '%'); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`SELECT * FROM cheque_records ${whereSql} ORDER BY due_date ASC, id DESC LIMIT 1000`).all(...params);
  res.json(rows);
});

router.patch('/:id/status', auth, adminOrAccounting, (req, res) => {
  const { status, status_note } = req.body;
  const db = getDB();
  const row = db.prepare('SELECT * FROM cheque_records WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  db.prepare('UPDATE cheque_records SET status=?, status_note=? WHERE id=?')
    .run(status || row.status, status_note ?? row.status_note, req.params.id);
  audit(req.user.id, 'update', 'cheque_record', req.params.id, `تغییر وضعیت چک ${row.cheque_number}`);
  res.json({ ok: true });
});

module.exports = router;
