const router = require('express').Router();
const { getDB } = require('../db');
const { auth } = require('../middleware/auth');
const notif = require('../lib/notifications');
const inbox = require('../lib/notification-inbox');
const { readManifest } = require('../lib/app-update');

const sseClients = new Set();

function broadcastNotification(payload) {
  const safe = { type: payload && payload.type ? payload.type : 'changed' };
  if (safe.type !== 'init' && safe.type !== 'changed' && safe.type !== 'ping') {
    safe.type = 'changed';
  }
  const data = `data: ${JSON.stringify(safe)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { sseClients.delete(res); }
  }
}

router.get('/stream', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  sseClients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'init' })}\n\n`);
  const ping = setInterval(() => {
    try { res.write(`data: ${JSON.stringify({ type: 'ping' })}\n\n`); } catch { clearInterval(ping); }
  }, 25000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

router.get('/inbox', auth, (req, res) => {
  const db = getDB();
  res.json(inbox.buildInbox(db, req.user));
});

router.get('/summary', auth, (req, res) => {
  const db = getDB();
  const built = inbox.buildInbox(db, req.user);
  res.json({
    unread: built.counts.unread,
    actionable: built.counts.actionable,
    today_jalali: built.today_jalali,
  });
});

router.post('/read', auth, (req, res) => {
  const db = getDB();
  const out = inbox.markRead(db, req.user, req.body?.keys || []);
  broadcastNotification({ type: 'changed' });
  res.json({ ok: true, ...out });
});

router.post('/unread', auth, (req, res) => {
  const db = getDB();
  const out = inbox.markUnread(db, req.user, req.body?.keys || []);
  broadcastNotification({ type: 'changed' });
  res.json({ ok: true, ...out });
});

router.post('/dismiss', auth, (req, res) => {
  const db = getDB();
  const out = inbox.dismiss(db, req.user, req.body?.keys || []);
  broadcastNotification({ type: 'changed' });
  res.json({ ok: true, ...out });
});

router.post('/undismiss', auth, (req, res) => {
  const db = getDB();
  const out = inbox.undismiss(db, req.user, req.body?.keys || []);
  broadcastNotification({ type: 'changed' });
  res.json({ ok: true, ...out });
});

router.post('/read-all', auth, (req, res) => {
  const db = getDB();
  const category = req.body?.category ? String(req.body.category) : undefined;
  const out = inbox.markAllRead(db, req.user, { category });
  broadcastNotification({ type: 'changed' });
  res.json({ ok: true, ...out });
});

router.get('/', auth, (req, res) => {
  const db = getDB();
  res.json(notif.listForUser(db, req.user));
});

router.get('/pending-actions', auth, (req, res) => {
  const db = getDB();
  const actions = inbox.buildPendingActions(db, req.user).map((a) => ({
    kind: a.kind,
    entity_type: a.target?.kind === 'invoice' ? 'invoice'
      : a.kind === 'rep_payment' ? 'rep_payment'
        : a.kind === 'followup' ? 'followup' : a.target?.kind,
    entity_id: a.target?.id,
    title: a.title,
    body: a.amount_rial != null
      ? `${a.subtitle} — ${Number(a.amount_rial).toLocaleString('fa-IR')} ریال`
      : a.subtitle,
    route: a.target?.route,
    amount_rial: a.amount_rial,
  }));
  const built = inbox.buildInbox(db, req.user);
  const notifications = notif.listForUser(db, req.user);
  res.json({
    actions,
    notifications,
    unread_count: built.counts.unread,
    actionable_count: built.counts.actionable,
  });
});

router.post('/:id/resolve', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM app_notifications WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'اعلان یافت نشد' });
  if (!notif.userMayResolve(db, req.user, row)) {
    return res.status(403).json({ error: 'دسترسی ندارید', code: 'E_FORBIDDEN' });
  }
  notif.markResolved(db, req.params.id, req.user.id);
  broadcastNotification({ type: 'changed' });
  res.json({ ok: true });
});

router.post('/entity-viewed', auth, (req, res) => {
  const { entity_type, entity_id } = req.body || {};
  if (!entity_type || !entity_id) return res.status(400).json({ error: 'entity_type و entity_id الزامی است' });
  const db = getDB();
  inbox.markEntityViewedForUser(db, req.user, entity_type, entity_id);
  broadcastNotification({ type: 'changed' });
  res.json({ ok: true });
});

/** ثبت اعلان نسخه جدید (از کلاینت پس از بررسی به‌روزرسانی) */
router.post('/register-update', auth, (req, res) => {
  const platform = String(req.body?.platform || '').slice(0, 32);
  const version = String(req.body?.version || '').slice(0, 32);
  if (!['android', 'desktop', 'web'].includes(platform)) {
    return res.status(400).json({ error: 'platform نامعتبر است' });
  }
  const manifest = readManifest();
  const expected = String(manifest?.[platform]?.version || '');
  if (!version || version !== expected) {
    return res.status(400).json({ error: 'نسخه با manifest هم‌خوان نیست', code: 'E_UPDATE_VERSION' });
  }
  const notes = String(manifest?.[platform]?.notes || '');
  const db = getDB();
  const id = notif.notifyAppUpdate(db, { platform, version, notes });
  broadcastNotification({ type: 'changed' });
  res.json({ ok: true, id });
});

module.exports = router;
module.exports.broadcastNotification = broadcastNotification;
