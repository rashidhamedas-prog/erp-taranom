const router = require('express').Router();
const crypto = require('crypto');
const { getDB, audit } = require('../db');
const { auth, adminOnly, centralOnlyStrict } = require('../middleware/auth');
const { assertSafeOutboundTarget } = require('../lib/safe-outbound-request');

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function generateKey() {
  return 'trn_' + crypto.randomBytes(24).toString('hex');
}

function normalizeScopes(raw) {
  const parts = String(raw || 'read').split(',').map((part) => part.trim()).filter(Boolean);
  const allowed = new Set(['read', 'write']);
  if (!parts.length || parts.some((part) => !allowed.has(part))) {
    const err = new Error('scope فقط read یا read,write است');
    err.status = 400;
    throw err;
  }
  const unique = [];
  for (const part of parts) if (!unique.includes(part)) unique.push(part);
  if (unique.includes('write') && !unique.includes('read')) unique.unshift('read');
  return unique.join(',');
}

function publicWebhook(row) {
  if (!row) return row;
  const { secret, ...rest } = row;
  return { ...rest, has_secret: !!(secret && String(secret).trim()) };
}

// List all API keys (admin)
router.get('/', auth, adminOnly, centralOnlyStrict, (req, res) => {
  const db = getDB();
  const rows = db.prepare(
    'SELECT k.id,k.name,k.key_prefix,k.scopes,k.active,k.last_used,k.created_at,u.name as owner FROM api_keys k LEFT JOIN users u ON k.user_id=u.id ORDER BY k.created_at DESC'
  ).all();
  res.json(rows);
});

// Usage log (admin)
router.get('/usage', auth, adminOnly, centralOnlyStrict, (req, res) => {
  const db = getDB();
  const limit = Math.min(200, parseInt(req.query.limit || '100'));
  const rows = db.prepare(
    'SELECT l.*,k.name as key_name FROM api_usage_log l LEFT JOIN api_keys k ON l.api_key_id=k.id ORDER BY l.created_at DESC LIMIT ?'
  ).all(limit);
  res.json(rows);
});

// Create API key (admin)
router.post('/', auth, adminOnly, centralOnlyStrict, (req, res) => {
  const { name, scopes = 'read' } = req.body;
  if (!name) return res.status(400).json({ error: 'نام الزامی است' });
  let scopeText;
  try { scopeText = normalizeScopes(scopes); }
  catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
  const key = generateKey();
  const db = getDB();
  const result = db.prepare(
    'INSERT INTO api_keys (user_id,name,key_hash,key_prefix,scopes) VALUES (?,?,?,?,?)'
  ).run(req.user.id, name, hashKey(key), key.substring(0, 12), scopeText);
  audit(req.user.id, 'create', 'api_key', result.lastInsertRowid, `ساخت کلید API: ${name}`);
  res.json({ id: result.lastInsertRowid, name, key, key_prefix: key.substring(0, 12), scopes: scopeText, active: 1 });
});

// Update API key (toggle active, rename)
router.put('/:id', auth, adminOnly, centralOnlyStrict, (req, res) => {
  const { name, scopes, active } = req.body;
  const db = getDB();
  let scopeText = scopes;
  try {
    if (scopes == null || String(scopes).trim() === '') {
      scopeText = db.prepare('SELECT scopes FROM api_keys WHERE id=?').get(req.params.id)?.scopes || 'read';
    } else {
      scopeText = normalizeScopes(scopes);
    }
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message });
  }
  db.prepare('UPDATE api_keys SET name=?,scopes=?,active=? WHERE id=?')
    .run(name, scopeText, active ? 1 : 0, req.params.id);
  audit(req.user.id, 'update', 'api_key', req.params.id, `ویرایش کلید API`);
  res.json({ ok: true });
});

// Delete API key (admin)
router.delete('/:id', auth, adminOnly, centralOnlyStrict, (req, res) => {
  const db = getDB();
  db.prepare('DELETE FROM api_keys WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'api_key', req.params.id, `حذف کلید API`);
  res.json({ ok: true });
});

// Webhook CRUD
router.get('/webhooks', auth, adminOnly, centralOnlyStrict, (req, res) => {
  const db = getDB();
  res.json(db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all().map(publicWebhook));
});

router.post('/webhooks', auth, adminOnly, centralOnlyStrict, async (req, res) => {
  const { name, url, events = 'customer.created', secret = '' } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'نام و آدرس الزامی است' });
  try { await assertSafeOutboundTarget(url); }
  catch (error) { return res.status(400).json({ error: error.message || 'آدرس webhook مجاز نیست' }); }
  const db = getDB();
  const r = db.prepare('INSERT INTO webhooks (user_id,name,url,events,secret) VALUES (?,?,?,?,?)')
    .run(req.user.id, name, url, events, secret);
  res.json({ id: r.lastInsertRowid, name, url, events, has_secret: !!(secret && String(secret).trim()), active: 1 });
});

router.put('/webhooks/:id', auth, adminOnly, centralOnlyStrict, async (req, res) => {
  const { name, url, events, secret, active } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'نام و آدرس الزامی است' });
  try { await assertSafeOutboundTarget(url); }
  catch (error) { return res.status(400).json({ error: error.message || 'آدرس webhook مجاز نیست' }); }
  const db = getDB();
  const existing = db.prepare('SELECT secret FROM webhooks WHERE id=?').get(req.params.id);
  const nextSecret = secret == null || String(secret).trim() === ''
    ? (existing && existing.secret) || ''
    : String(secret);
  db.prepare('UPDATE webhooks SET name=?,url=?,events=?,secret=?,active=? WHERE id=?')
    .run(name, url, events, nextSecret, active ? 1 : 0, req.params.id);
  res.json({ ok: true, has_secret: !!String(nextSecret).trim() });
});

router.delete('/webhooks/:id', auth, adminOnly, centralOnlyStrict, (req, res) => {
  getDB().prepare('DELETE FROM webhooks WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = { router, hashKey };
