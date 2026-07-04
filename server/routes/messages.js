const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDB } = require('../db');
const { auth } = require('../middleware/auth');

const MSG_UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'messages');
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
// Admin: all messages of the tenant (broadcast + direct to any user)
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
      WHERE m.tenant_id = ?
      ORDER BY m.created_at DESC
      LIMIT 300
    `).all(req.tenantId);
  } else {
    // Non-admin sees only: messages sent to them directly OR sent by them
    msgs = db.prepare(`
      SELECT m.*, f.name as from_name, t.name as to_name
      FROM messages m
      LEFT JOIN users f ON m.from_id = f.id
      LEFT JOIN users t ON m.to_id = t.id
      WHERE m.tenant_id = ? AND (m.to_id = ? OR m.from_id = ?)
      ORDER BY m.created_at DESC
      LIMIT 200
    `).all(req.tenantId, req.user.id, req.user.id);
  }
  res.json(msgs.map(m => ({
    ...m,
    direction: m.from_id === req.user.id ? 'sent' : 'received'
  })));
});

// Unread count for current user
router.get('/unread-count', auth, (req, res) => {
  const db = getDB();
  let r;
  if (req.user.role === 'admin') {
    // Admin: all unread (direct to them + broadcasts from others)
    r = db.prepare('SELECT COUNT(*) as c FROM messages WHERE tenant_id=? AND (to_id=? OR to_id IS NULL) AND from_id<>? AND is_read=0')
      .get(req.tenantId, req.user.id, req.user.id);
  } else {
    // Non-admin: only direct unread messages
    r = db.prepare('SELECT COUNT(*) as c FROM messages WHERE tenant_id=? AND to_id=? AND from_id<>? AND is_read=0')
      .get(req.tenantId, req.user.id, req.user.id);
  }
  res.json({ count: r.c });
});

// Send message
router.post('/', auth, (req, res) => {
  const { to_id, body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'متن پیام الزامی است' });
  const db = getDB();
  // Recipient must be a user of the same tenant; non-admins can only message admins
  if (to_id) {
    const target = db.prepare('SELECT role FROM users WHERE id=? AND tenant_id=?').get(to_id, req.tenantId);
    if (!target) return res.status(404).json({ error: 'گیرنده یافت نشد' });
    if (req.user.role !== 'admin' && target.role !== 'admin') return res.status(403).json({ error: 'فقط می‌توانید به مدیر پیام بفرستید' });
  }
  if (!to_id && req.user.role !== 'admin') return res.status(403).json({ error: 'ارسال همگانی فقط توسط مدیر' });
  const result = db.prepare('INSERT INTO messages (tenant_id,from_id,to_id,body) VALUES (?,?,?,?)')
    .run(req.tenantId, req.user.id, to_id || null, body.trim());
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
  if (to_id) {
    const target = db.prepare('SELECT role FROM users WHERE id=? AND tenant_id=?').get(to_id, req.tenantId);
    if (!target) return res.status(404).json({ error: 'گیرنده یافت نشد' });
    if (req.user.role !== 'admin' && target.role !== 'admin') return res.status(403).json({ error: 'فقط می‌توانید به مدیر پیام بفرستید' });
  }
  if (!to_id && req.user.role !== 'admin') return res.status(403).json({ error: 'ارسال همگانی فقط توسط مدیر' });
  let image;
  try { image = await saveMsgImage(req.file.buffer); }
  catch (e) { return res.status(500).json({ error: 'خطا در ذخیره تصویر' }); }
  const result = db.prepare('INSERT INTO messages (tenant_id,from_id,to_id,body,image) VALUES (?,?,?,?,?)')
    .run(req.tenantId, req.user.id, to_id || null, (body || '').trim(), image);
  const row = db.prepare(`
    SELECT m.*, f.name as from_name, t.name as to_name
    FROM messages m LEFT JOIN users f ON m.from_id=f.id LEFT JOIN users t ON m.to_id=t.id
    WHERE m.id=?`).get(result.lastInsertRowid);
  res.json({ ...row, direction: 'sent' });
});

// Mark one message as read
router.post('/read/:id', auth, (req, res) => {
  const db = getDB();
  db.prepare('UPDATE messages SET is_read=1 WHERE id=? AND tenant_id=? AND (to_id=? OR to_id IS NULL)').run(req.params.id, req.tenantId, req.user.id);
  res.json({ ok: true });
});

// Mark all as read (for this user)
router.post('/read-all', auth, (req, res) => {
  const db = getDB();
  if (req.user.role === 'admin') {
    db.prepare('UPDATE messages SET is_read=1 WHERE tenant_id=? AND (to_id=? OR to_id IS NULL) AND from_id<>?').run(req.tenantId, req.user.id, req.user.id);
  } else {
    db.prepare('UPDATE messages SET is_read=1 WHERE tenant_id=? AND to_id=? AND from_id<>?').run(req.tenantId, req.user.id, req.user.id);
  }
  res.json({ ok: true });
});

// Delete a message (sender or admin can delete)
router.delete('/:id', auth, (req, res) => {
  const db = getDB();
  const msg = db.prepare('SELECT * FROM messages WHERE id=? AND tenant_id=?').get(req.params.id, req.tenantId);
  if (!msg) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && msg.from_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  db.prepare('DELETE FROM messages WHERE id=? AND tenant_id=?').run(req.params.id, req.tenantId);
  res.json({ ok: true });
});

// List all users for compose recipient (non-admin gets admin list only)
router.get('/users', auth, (req, res) => {
  const db = getDB();
  let users;
  if (req.user.role === 'admin') {
    users = db.prepare('SELECT id,name,role FROM users WHERE tenant_id=? AND active=1 AND id<>? ORDER BY name').all(req.tenantId, req.user.id);
  } else {
    users = db.prepare("SELECT id,name,role FROM users WHERE tenant_id=? AND active=1 AND role='admin' ORDER BY name").all(req.tenantId);
  }
  res.json(users);
});

module.exports = router;
