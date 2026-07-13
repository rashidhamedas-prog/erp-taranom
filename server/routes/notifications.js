const router = require('express').Router();
const { getDB } = require('../db');
const { auth } = require('../middleware/auth');
const notif = require('../lib/notifications');

const sseClients = new Set();

function broadcastNotification(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { sseClients.delete(res); }
  }
}

router.get('/stream', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  sseClients.add(res);
  const db = getDB();
  const rows = notif.listForUser(db, req.user);
  res.write(`data: ${JSON.stringify({ type: 'init', notifications: rows })}\n\n`);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(ping); } }, 25000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

router.get('/', auth, (req, res) => {
  const db = getDB();
  res.json(notif.listForUser(db, req.user));
});

router.get('/pending-actions', auth, (req, res) => {
  const db = getDB();
  const role = req.user.role;
  const actions = [];
  if (['admin', 'accounting', 'sales_manager'].includes(role)) {
    const pendingInv = db.prepare(`
      SELECT i.id, i.num, i.date, i.final, c.biz
      FROM invoices i JOIN customers c ON i.cust_id=c.id
      WHERE i.type='final' AND COALESCE(i.approved,0)=0 AND COALESCE(i.deleted_at,0)=0
      ORDER BY i.created_at DESC LIMIT 15
    `).all();
    pendingInv.forEach(i => actions.push({
      kind: 'invoice_approval', entity_type: 'invoice', entity_id: i.id,
      title: `تأیید فاکتور ${i.num}`, body: `${i.biz} — ${Number(i.final || 0).toLocaleString('fa-IR')} ت`,
      route: 'acc-commissions',
    }));
    const pendingRep = db.prepare(`
      SELECT rp.id, rp.amount, rp.date, c.biz
      FROM rep_payments rp JOIN customers c ON rp.customer_id=c.id
      WHERE rp.status='pending' ORDER BY rp.created_at DESC LIMIT 10
    `).all();
    pendingRep.forEach(p => actions.push({
      kind: 'rep_payment', entity_type: 'rep_payment', entity_id: p.id,
      title: 'پرداخت میدانی منتظر تأیید', body: `${p.biz} — ${Number(p.amount || 0).toLocaleString('fa-IR')} ت`,
      route: 'acc-reps',
    }));
  }
  const openFups = db.prepare(`
    SELECT f.id, f.subject, f.priority, c.biz
    FROM followups f JOIN customers c ON f.cust_id=c.id
    WHERE f.status='open' AND f.priority='high'
    ORDER BY f.created_at DESC LIMIT 10
  `).all();
  openFups.forEach(f => actions.push({
    kind: 'followup', entity_type: 'followup', entity_id: f.id,
    title: 'پیگیری فوری', body: `${f.biz} — ${f.subject || ''}`,
    route: 'followups',
  }));
  const notifs = notif.listForUser(db, req.user);
  res.json({ actions, notifications: notifs });
});

router.post('/:id/resolve', auth, (req, res) => {
  const db = getDB();
  notif.markResolved(db, req.params.id, req.user.id);
  broadcastNotification({ type: 'resolved', id: +req.params.id });
  res.json({ ok: true });
});

router.post('/entity-viewed', auth, (req, res) => {
  const { entity_type, entity_id } = req.body;
  if (!entity_type || !entity_id) return res.status(400).json({ error: 'entity_type و entity_id الزامی است' });
  const db = getDB();
  notif.markEntityViewed(db, entity_type, entity_id, req.user.id);
  broadcastNotification({ type: 'entity_viewed', entity_type, entity_id });
  res.json({ ok: true });
});

module.exports = router;
module.exports.broadcastNotification = broadcastNotification;
