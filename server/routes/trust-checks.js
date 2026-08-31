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

function resolveTrustParty(db, body) {
  const partyId = parseInt(body && body.party_id, 10);
  if (!Number.isFinite(partyId) || partyId <= 0) {
    const err = new Error('طرف حساب باید از فهرست اشخاص انتخاب شود');
    err.status = 400;
    err.code = 'E_TRUST_PARTY_REQUIRED';
    throw err;
  }
  const party = db.prepare(`
    SELECT id, full_name, company_name, biz, phone
    FROM parties WHERE id=? AND COALESCE(is_active,1)=1
  `).get(partyId);
  if (!party) {
    const err = new Error('طرف حساب یافت نشد');
    err.status = 400;
    err.code = 'E_TRUST_PARTY_INVALID';
    throw err;
  }
  return {
    partyId: party.id,
    partyName: party.full_name || party.company_name || party.biz || '',
    partyPhone: (body && body.party_phone) || party.phone || '',
  };
}

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
  const { direction, bank_name, sayadi, cheque_number, account_number, amount, owner_name, due_date, note } = req.body;
  if (!direction || !['in', 'out'].includes(direction)) return res.status(400).json({ error: 'جهت چک (دریافتی/پرداختی) الزامی است' });
  const amt = parseFloat(amount) || 0;
  if (!amt) return res.status(400).json({ error: 'مبلغ چک الزامی است' });
  const db = getDB();
  let party;
  try {
    party = resolveTrustParty(db, req.body);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  const result = db.prepare(
    `INSERT INTO trust_checks (direction,party_name,party_id,party_phone,bank_name,sayadi,cheque_number,account_number,amount,owner_name,due_date,note,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(direction, party.partyName, party.partyId, party.partyPhone, bank_name || '', sayadi || '', cheque_number || '', account_number || '', amt, owner_name || '', due_date || '', note || '', req.user.id);
  audit(req.user.id, 'create', 'trust_check', result.lastInsertRowid, `ثبت چک امانی ${direction==='in'?'دریافتی':'پرداختی'} از/به ${party.partyName} به مبلغ ${amt}`);
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
