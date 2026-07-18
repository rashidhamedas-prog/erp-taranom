const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');

// Trust/guarantee checks (چک امانی) — cheques held purely as collateral, not
// yet a real transaction. They are intentionally NOT posted to the journal
// (a guarantee cheque isn't our money until it's actually deposited/cashed);
// this module only tracks custody and status. When a trust check is
// actually realized, record the real cash movement separately through
// Receipt/Payment Operations (referencing the same cheque number in its note).

const STATUSES = ['held', 'returned', 'realized', 'bounced'];

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { direction, status } = req.query;
  const where = [], params = [];
  if (direction) { where.push('direction=?'); params.push(direction); }
  if (status) { where.push('status=?'); params.push(status); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`SELECT * FROM trust_checks ${whereSql} ORDER BY due_date ASC, created_at DESC`).all(...params);
  res.json(rows);
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const { direction, party_name, party_phone, bank_name, sayadi, cheque_number, account_number, amount, owner_name, due_date, note } = req.body;
  if (!direction || !['in', 'out'].includes(direction)) return res.status(400).json({ error: 'جهت چک (دریافتی/پرداختی) الزامی است' });
  if (!party_name) return res.status(400).json({ error: 'نام طرف حساب الزامی است' });
  const amt = parseFloat(amount) || 0;
  if (!amt) return res.status(400).json({ error: 'مبلغ چک الزامی است' });
  const db = getDB();
  const result = db.prepare(
    `INSERT INTO trust_checks (direction,party_name,party_phone,bank_name,sayadi,cheque_number,account_number,amount,owner_name,due_date,note,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(direction, party_name, party_phone || '', bank_name || '', sayadi || '', cheque_number || '', account_number || '', amt, owner_name || '', due_date || '', note || '', req.user.id);
  audit(req.user.id, 'create', 'trust_check', result.lastInsertRowid, `ثبت چک امانی ${direction==='in'?'دریافتی':'پرداختی'} از/به ${party_name} به مبلغ ${amt}`);
  res.json(db.prepare('SELECT * FROM trust_checks WHERE id=?').get(result.lastInsertRowid));
});

router.patch('/:id/status', auth, adminOrAccounting, (req, res) => {
  const { status } = req.body;
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'وضعیت نامعتبر' });
  const db = getDB();
  const row = db.prepare('SELECT * FROM trust_checks WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  db.prepare('UPDATE trust_checks SET status=? WHERE id=?').run(status, req.params.id);
  audit(req.user.id, 'update', 'trust_check', req.params.id, `تغییر وضعیت چک امانی به ${status}`);
  res.json({ ok: true });
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM trust_checks WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  db.prepare('DELETE FROM trust_checks WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'trust_check', req.params.id, `حذف چک امانی #${req.params.id}`);
  res.json({ ok: true });
});

module.exports = router;
