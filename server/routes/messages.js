const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDB } = require('../db');
const { auth } = require('../middleware/auth');

const { UPLOADS_ROOT } = require('../paths');
const MSG_UPLOAD_DIR = path.join(UPLOADS_ROOT, 'messages');
fs.mkdirSync(MSG_UPLOAD_DIR, { recursive: true });
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// Save an image buffer (PNG) to uploads/messages, optionally re-encoding via sharp
async function saveMsgImage(buffer) {
  const name = 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.png';
  const dest = path.join(MSG_UPLOAD_DIR, name);
  try {
    const sharp = require('sharp');
    await sharp(buffer).resize({ width: 1200, withoutEnlargement: true }).png({ quality: 80 }).toFile(dest);
  } catch (e) {
    fs.writeFileSync(dest, buffer); // fallback: store as-is
  }
  return name;
}

// List messages for current user
// Admin: all messages (broadcast + direct to any user)
// Non-admin: only direct messages to/from them (no broadcasts to others)
router.get('/', auth, (req, res) => {
  const db = getDB();
  let msgs;
  if (req.user.role === 'admin') {
    msgs = db.prepare(`
      SELECT m.*, f.name as from_name, t.name as to_name
      FROM messages m
      LEFT JOIN users f ON m.from_id = f.id
      LEFT JOIN users t ON m.to_id = t.id
      ORDER BY m.created_at DESC
      LIMIT 300
    `).all();
  } else {
    // Non-admin sees only: messages sent to them directly OR sent by them
    msgs = db.prepare(`
      SELECT m.*, f.name as from_name, t.name as to_name
      FROM messages m
      LEFT JOIN users f ON m.from_id = f.id
      LEFT JOIN users t ON m.to_id = t.id
      WHERE m.to_id = ? OR m.from_id = ?
      ORDER BY m.created_at DESC
      LIMIT 200
    `).all(req.user.id, req.user.id);
  }
  res.json(msgs.map(m => ({
    ...m,
    direction: m.from_id === req.user.id ? 'sent' : 'received'
  })));
});

// ── Telegram-like chat threads (spec 1.0.9 §3) ───────────────────────────────
// A "thread" is one conversation partner. Special ids:
//   'broadcast' — admin announcements (to_id IS NULL), read-only for non-admins
//   'self'      — system notifications recorded from/to the same user
//                 (B2B order alerts, payment status changes, …)
function peerOf(m, me) {
  if (m.to_id == null) return 'broadcast';
  if (m.from_id === me && m.to_id === me) return 'self';
  return m.from_id === me ? m.to_id : m.from_id;
}

router.get('/threads', auth, (req, res) => {
  const db = getDB();
  const me = req.user.id;
  const rows = db.prepare(`
    SELECT m.*, f.name as from_name, f.role as from_role, t.name as to_name
    FROM messages m
    LEFT JOIN users f ON m.from_id=f.id
    LEFT JOIN users t ON m.to_id=t.id
    WHERE m.to_id=? OR m.from_id=? OR m.to_id IS NULL
    ORDER BY m.created_at ASC LIMIT 2000
  `).all(me, me);
  const threads = new Map();
  for (const m of rows) {
    const pid = peerOf(m, me);
    let th = threads.get(pid);
    if (!th) {
      th = { peer_id: pid, peer_name: '', peer_role: '', last_body: '', last_at: 0, last_from_me: false, last_read: 0, last_image: null, unread: 0 };
      threads.set(pid, th);
    }
    if (pid === 'broadcast') th.peer_name = '📢 اطلاعیه‌ها';
    else if (pid === 'self') th.peer_name = '📌 اعلان‌های من';
    else { th.peer_name = m.from_id === me ? (m.to_name || '?') : (m.from_name || '?'); th.peer_role = m.from_id === me ? '' : (m.from_role || ''); }
    th.last_body = m.body || '';
    th.last_at = m.created_at;
    th.last_from_me = m.from_id === me && pid !== 'self' && pid !== 'broadcast';
    th.last_read = m.is_read;
    th.last_image = m.image || null;
    if (m.from_id !== me && !m.is_read && (m.to_id === me)) th.unread++;
    if (pid === 'self' && !m.is_read) th.unread++;
  }
  res.json([...threads.values()].sort((a, b) => b.last_at - a.last_at));
});

// Full conversation with one peer (ascending). Marks nothing read by itself.
router.get('/thread/:peer', auth, (req, res) => {
  const db = getDB();
  const me = req.user.id;
  const peer = req.params.peer;
  let rows;
  const SEL = `
    SELECT m.*, f.name as from_name, t.name as to_name
    FROM messages m LEFT JOIN users f ON m.from_id=f.id LEFT JOIN users t ON m.to_id=t.id`;
  if (peer === 'broadcast') {
    rows = db.prepare(SEL + ' WHERE m.to_id IS NULL ORDER BY m.created_at ASC LIMIT 300').all();
  } else if (peer === 'self') {
    rows = db.prepare(SEL + ' WHERE m.from_id=? AND m.to_id=? ORDER BY m.created_at ASC LIMIT 300').all(me, me);
  } else {
    const pid = parseInt(peer);
    if (!pid) return res.status(400).json({ error: 'گفتگو نامعتبر' });
    rows = db.prepare(SEL + ` WHERE (m.from_id=? AND m.to_id=?) OR (m.from_id=? AND m.to_id=?)
      ORDER BY m.created_at ASC LIMIT 300`).all(me, pid, pid, me);
  }
  res.json(rows.map(m => ({ ...m, mine: m.from_id === me && peer !== 'self' && peer !== 'broadcast' })));
});

// Mark a whole thread read (drives the double-tick on the sender's side)
router.post('/thread/:peer/read', auth, (req, res) => {
  const db = getDB();
  const me = req.user.id;
  const peer = req.params.peer;
  if (peer === 'self') {
    db.prepare('UPDATE messages SET is_read=1 WHERE from_id=? AND to_id=?').run(me, me);
  } else if (peer !== 'broadcast') {
    const pid = parseInt(peer);
    if (pid) db.prepare('UPDATE messages SET is_read=1 WHERE from_id=? AND to_id=?').run(pid, me);
  }
  res.json({ ok: true });
});

// Unread count for current user
router.get('/unread-count', auth, (req, res) => {
  const db = getDB();
  let r;
  if (req.user.role === 'admin') {
    // Admin: all unread (direct to them + broadcasts from others)
    r = db.prepare('SELECT COUNT(*) as c FROM messages WHERE (to_id=? OR to_id IS NULL) AND from_id<>? AND is_read=0')
      .get(req.user.id, req.user.id);
  } else {
    // Non-admin: direct unread + self-notifications (from_id=to_id=me, e.g.
    // B2B order alerts) — previously excluded so the badge never showed them
    r = db.prepare('SELECT COUNT(*) as c FROM messages WHERE to_id=? AND is_read=0')
      .get(req.user.id);
  }
  res.json({ count: r.c });
});

// A non-admin may message an admin, or REPLY to any user who has already
// messaged them (so chat threads started by accounting/managers are two-way)
function canMessage(db, fromUser, toId) {
  if (fromUser.role === 'admin') return true;
  const target = db.prepare('SELECT role FROM users WHERE id=?').get(toId);
  if (!target) return false;
  if (target.role === 'admin') return true;
  const prior = db.prepare('SELECT 1 FROM messages WHERE from_id=? AND to_id=? LIMIT 1').get(toId, fromUser.id);
  return !!prior;
}

// Send message
router.post('/', auth, (req, res) => {
  const { to_id, body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'متن پیام الزامی است' });
  const db = getDB();
  if (req.user.role !== 'admin' && to_id) {
    if (!canMessage(db, req.user, to_id)) return res.status(403).json({ error: 'فقط می‌توانید به مدیر یا کسی که به شما پیام داده پاسخ دهید' });
  }
  // Only admin can broadcast (to_id = null)
  const recipient = (req.user.role === 'admin') ? (to_id || null) : (to_id || null);
  if (!to_id && req.user.role !== 'admin') return res.status(403).json({ error: 'ارسال همگانی فقط توسط مدیر' });
  const result = db.prepare('INSERT INTO messages (from_id,to_id,body) VALUES (?,?,?)')
    .run(req.user.id, recipient, body.trim());
  const row = db.prepare(`
    SELECT m.*, f.name as from_name, t.name as to_name
    FROM messages m LEFT JOIN users f ON m.from_id=f.id LEFT JOIN users t ON m.to_id=t.id
    WHERE m.id=?`).get(result.lastInsertRowid);
  res.json({ ...row, direction: 'sent' });
});

// Send a message with an image attachment (e.g. a customer account statement)
router.post('/with-image', auth, memUpload.single('image'), async (req, res) => {
  const { to_id, body } = req.body;
  if (!req.file) return res.status(400).json({ error: 'تصویر الزامی است' });
  const db = getDB();
  if (req.user.role !== 'admin' && to_id) {
    if (!canMessage(db, req.user, to_id)) return res.status(403).json({ error: 'فقط می‌توانید به مدیر یا کسی که به شما پیام داده پاسخ دهید' });
  }
  if (!to_id && req.user.role !== 'admin') return res.status(403).json({ error: 'ارسال همگانی فقط توسط مدیر' });
  let image;
  try { image = await saveMsgImage(req.file.buffer); }
  catch (e) { return res.status(500).json({ error: 'خطا در ذخیره تصویر' }); }
  const recipient = to_id || null;
  const result = db.prepare('INSERT INTO messages (from_id,to_id,body,image) VALUES (?,?,?,?)')
    .run(req.user.id, recipient, (body || '').trim(), image);
  const row = db.prepare(`
    SELECT m.*, f.name as from_name, t.name as to_name
    FROM messages m LEFT JOIN users f ON m.from_id=f.id LEFT JOIN users t ON m.to_id=t.id
    WHERE m.id=?`).get(result.lastInsertRowid);
  res.json({ ...row, direction: 'sent' });
});

// Mark one message as read
router.post('/read/:id', auth, (req, res) => {
  const db = getDB();
  db.prepare('UPDATE messages SET is_read=1 WHERE id=? AND (to_id=? OR to_id IS NULL)').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// Mark all as read (for this user)
router.post('/read-all', auth, (req, res) => {
  const db = getDB();
  if (req.user.role === 'admin') {
    db.prepare('UPDATE messages SET is_read=1 WHERE (to_id=? OR to_id IS NULL) AND from_id<>?').run(req.user.id, req.user.id);
  } else {
    db.prepare('UPDATE messages SET is_read=1 WHERE to_id=? AND from_id<>?').run(req.user.id, req.user.id);
  }
  res.json({ ok: true });
});

// Delete a message (sender or admin can delete)
router.delete('/:id', auth, (req, res) => {
  const db = getDB();
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && msg.from_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  db.prepare('DELETE FROM messages WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// List all users for compose recipient (non-admin gets admin list only)
router.get('/users', auth, (req, res) => {
  const db = getDB();
  let users;
  if (req.user.role === 'admin') {
    users = db.prepare('SELECT id,name,role FROM users WHERE active=1 AND id<>? ORDER BY name').all(req.user.id);
  } else {
    users = db.prepare("SELECT id,name,role FROM users WHERE active=1 AND role='admin' ORDER BY name").all();
  }
  res.json(users);
});

module.exports = router;
