const { XLSX, readWorkbook } = require('../lib/excel-safe');
const router = require('express').Router();
const { getDB } = require('../db');
const notif = require('../lib/notifications');
const { auth, adminOnly } = require('../middleware/auth');
const { todayJalali, nowHHMM } = require('../jalali');
const { parseListQuery, listResponse } = require('../lib/pagination');
function getScope(req) {
  if (req.user.role === 'admin' && req.query.user_id) return parseInt(req.query.user_id);
  if (req.user.role === 'admin') return null;
  return req.user.id;
}

router.get('/', auth, (req, res) => {
  const db = getDB();
  const scope = getScope(req);
  const { page, pageSize, offset } = parseListQuery(req.query);
  // Skip followups whose customer was removed or whose accounting party is inactive
  const activeCust = `EXISTS (
    SELECT 1 FROM customers c
    WHERE c.id=f.cust_id
      AND (c.party_id IS NULL OR EXISTS (SELECT 1 FROM parties p WHERE p.id=c.party_id AND p.is_active=1))
  )`;
  const where = scope === null
    ? `WHERE ${activeCust}`
    : `WHERE f.user_id=? AND ${activeCust}`;
  const params = scope === null ? [] : [scope];
  const total = db.prepare(`SELECT COUNT(*) AS c FROM followups f ${where}`).get(...params)?.c || 0;
  const select = scope === null
    ? `SELECT f.*,c.biz as cust_biz,u.name as salesperson FROM followups f LEFT JOIN customers c ON f.cust_id=c.id LEFT JOIN users u ON f.user_id=u.id`
    : `SELECT f.*,c.biz as cust_biz FROM followups f LEFT JOIN customers c ON f.cust_id=c.id`;
  const rows = db.prepare(`${select} ${where} ORDER BY f.created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
  res.json(listResponse(rows, { page, pageSize, total }, req.query));
});

// Activity timeline for a specific customer
router.get('/by-customer/:cust_id', auth, (req, res) => {
  const db = getDB();
  const rows = db.prepare(
    'SELECT f.*,u.name as salesperson FROM followups f LEFT JOIN users u ON f.user_id=u.id WHERE f.cust_id=? ORDER BY f.created_at DESC'
  ).all(req.params.cust_id);
  res.json(rows);
});

router.post('/', auth, (req, res) => {
  const { cust_id, date, type, subject, note, action, next_date, next_time, status, priority,
          interest_level, purchase_prob, pipeline_stage, tags, lost_reason, assigned_to, account_balance } = req.body;
  if (!cust_id) return res.status(400).json({ error: 'مشتری الزامی است' });
  const db = getDB();
  const finalDate = date && String(date).trim() ? date : todayJalali();
  const time = nowHHMM();
  const result = db.prepare(
    'INSERT INTO followups (user_id,cust_id,date,time,type,subject,note,action,next_date,next_time,status,priority,interest_level,purchase_prob,pipeline_stage,tags,lost_reason,assigned_to,account_balance) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    req.user.id, cust_id, finalDate, time,
    type || '📱 تلفن', subject || '', note || '', action || '', next_date || '', next_time || '',
    status || 'open', priority || 'mid',
    interest_level || 'mid', parseInt(purchase_prob) || 50,
    pipeline_stage || 'lead', tags || '', lost_reason || '',
    assigned_to ? parseInt(assigned_to) : null,
    parseFloat(account_balance) || 0
  );
  const row = db.prepare('SELECT f.*,c.biz as cust_biz FROM followups f LEFT JOIN customers c ON f.cust_id=c.id WHERE f.id=?').get(result.lastInsertRowid);
  try {
    const cust = db.prepare('SELECT biz FROM customers WHERE id=?').get(cust_id);
    notif.notifyNewFollowup(db, row, cust);
  } catch (e) { console.error('notify followup:', e.message); }
  res.json(row);
});

router.put('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM followups WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  const { cust_id, date, type, subject, note, action, next_date, next_time, status, priority,
          interest_level, purchase_prob, pipeline_stage, tags, lost_reason, assigned_to, account_balance } = req.body;
  const finalDate = date && String(date).trim() ? date : (row.date || todayJalali());
  // Reset sms_sent when next_date/next_time changes so reminder fires again
  const smsReset = (next_date !== row.next_date || next_time !== row.next_time) ? 0 : row.sms_sent;
  db.prepare(
    'UPDATE followups SET cust_id=?,date=?,type=?,subject=?,note=?,action=?,next_date=?,next_time=?,status=?,priority=?,interest_level=?,purchase_prob=?,pipeline_stage=?,tags=?,lost_reason=?,assigned_to=?,sms_sent=?,account_balance=? WHERE id=?'
  ).run(
    cust_id, finalDate,
    type || '📱 تلفن', subject || '', note || '', action || '', next_date || '', next_time || '',
    status || 'open', priority || 'mid',
    interest_level || 'mid', parseInt(purchase_prob) || 50,
    pipeline_stage || 'lead', tags || '', lost_reason || '',
    assigned_to ? parseInt(assigned_to) : null, smsReset,
    account_balance != null ? parseFloat(account_balance) || 0 : (row.account_balance || 0),
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM followups WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  db.prepare('DELETE FROM followups WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/export/excel', auth, adminOnly, async (req, res) => {
  const db = getDB();
  const scope = getScope(req);
  let rows;
  if (scope === null) {
    rows = db.prepare('SELECT f.*,c.biz as cust_biz FROM followups f LEFT JOIN customers c ON f.cust_id=c.id ORDER BY f.created_at DESC').all();
  } else {
    rows = db.prepare('SELECT f.*,c.biz as cust_biz FROM followups f LEFT JOIN customers c ON f.cust_id=c.id WHERE f.user_id=? ORDER BY f.created_at DESC').all(scope);
  }
  const data = rows.map(r => ({
    'مشتری': r.cust_biz, 'تاریخ': r.date, 'ساعت': r.time, 'نوع تماس': r.type,
    'مرحله پایپ‌لاین': r.pipeline_stage, 'مانده حساب': r.account_balance || 0, 'موضوع': r.subject, 'نتیجه': r.note,
    'اقدام بعدی': r.action, 'تاریخ پیگیری': r.next_date,
    'احتمال خرید': r.purchase_prob, 'علاقه‌مندی': r.interest_level,
    'تگ‌ها': r.tags, 'دلیل از دست دادن': r.lost_reason,
    'وضعیت': r.status, 'اولویت': r.priority
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'پیگیری‌ها');
  const buf = await XLSX.write(wb);
  res.setHeader('Content-Disposition', 'attachment; filename=followups.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

module.exports = router;
