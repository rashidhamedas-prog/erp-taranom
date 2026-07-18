const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');

const OPENING_NOTE = 'مانده اول دوره';

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { direction, status, opening } = req.query;
  const where = [], params = [];
  if (direction) { where.push('direction=?'); params.push(direction); }
  if (status) { where.push('status LIKE ?'); params.push('%' + status + '%'); }
  if (opening === '1') { where.push("(note LIKE ? OR status LIKE ?)"); params.push('%' + OPENING_NOTE + '%', '%اول دوره%'); }
  else if (opening === '0') { where.push("(note NOT LIKE ? AND status NOT LIKE ?)"); params.push('%' + OPENING_NOTE + '%', '%اول دوره%'); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`SELECT * FROM cheque_records ${whereSql} ORDER BY due_date ASC, id DESC LIMIT 1000`).all(...params);
  res.json(rows);
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const {
    direction, cheque_number, issue_date, receive_date, due_date,
    bank_name, branch, sayadi, sheba, account_number,
    party_name, status, status_note, amount, note, opening
  } = req.body;
  if (!direction || !amount) return res.status(400).json({ error: 'جهت و مبلغ الزامی است' });
  const db = getDB();
  const finalNote = opening ? (note ? note + ' — ' + OPENING_NOTE : OPENING_NOTE) : (note || '');
  const result = db.prepare(`
    INSERT INTO cheque_records (
      direction, cheque_number, issue_date, receive_date, due_date,
      bank_name, branch, sayadi, sheba, account_number,
      party_name, status, status_note, amount, note, created_by_name
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    direction,
    cheque_number || '',
    issue_date || '',
    receive_date || '',
    due_date || '',
    bank_name || '',
    branch || '',
    sayadi || '',
    sheba || '',
    account_number || '',
    party_name || '',
    status || (opening ? 'مانده اول دوره' : ''),
    status_note || '',
    amount,
    finalNote,
    req.user.name || ''
  );
  audit(req.user.id, 'create', 'cheque_record', result.lastInsertRowid, `ثبت چک ${cheque_number || result.lastInsertRowid}`);
  res.json(db.prepare('SELECT * FROM cheque_records WHERE id=?').get(result.lastInsertRowid));
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

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM cheque_records WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  db.prepare('DELETE FROM cheque_records WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'cheque_record', req.params.id, `حذف چک ${row.cheque_number}`);
  res.json({ ok: true });
});

module.exports = router;
