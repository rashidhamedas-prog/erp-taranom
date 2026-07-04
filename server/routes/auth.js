const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDB, audit, getSetting } = require('../db');
const { auth, adminOnly, SECRET } = require('../middleware/auth');

// In-memory failed-login tracker: { username: { count, until } }
const failedLogins = new Map();
const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 min

function isLockedOut(username) {
  const rec = failedLogins.get(username);
  if (!rec) return false;
  if (Date.now() < rec.until) return true;
  failedLogins.delete(username);
  return false;
}

function recordFailure(username) {
  const rec = failedLogins.get(username) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= MAX_FAILURES) rec.until = Date.now() + LOCKOUT_MS;
  failedLogins.set(username, rec);
}

// Issue the internal-scope JWT for a fully authenticated user
function issueToken(user) {
  return jwt.sign(
    { id: user.id, tid: user.tenant_id, scope: 'internal', username: user.username, role: user.role, name: user.name, phone: user.phone || '' },
    SECRET, { expiresIn: '30d' }
  );
}

// Login — step 1: username/password. If the user has 2FA enabled, a short-lived
// pre-auth token is returned instead and the client must call /2fa/verify.
router.post('/login', (req, res) => {
  const username = (req.body.username || '').trim().slice(0, 64);
  const password = (req.body.password || '').slice(0, 128);
  if (!username || !password) return res.status(400).json({ error: 'اطلاعات ناقص' });

  if (isLockedOut(username))
    return res.status(429).json({ error: 'حساب به دلیل تلاش‌های مکرر ناموفق قفل شده است. ۱۵ دقیقه دیگر تلاش کنید.' });

  const db = getDB();
  const user = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    recordFailure(username);
    if (user) audit(user.tenant_id, user.id, 'login_failed', 'user', user.id, 'رمز اشتباه', req.ip);
    return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است' });
  }

  // Tenant suspension blocks login (platform owner has no tenant)
  if (user.role !== 'platform_owner') {
    const tenant = db.prepare('SELECT status FROM tenants WHERE id=?').get(user.tenant_id);
    if (!tenant || tenant.status !== 'active') {
      return res.status(403).json({ error: 'حساب کسب‌وکار شما غیرفعال است. با پشتیبانی تماس بگیرید.' });
    }
  }

  failedLogins.delete(username); // reset on success

  // 2FA: enabled for this user → require TOTP verification before issuing the real token
  const tfa = db.prepare('SELECT enabled FROM two_factor_auth WHERE user_id=?').get(user.id);
  const requiredRoles = (getSetting(user.tenant_id, 'twofa_required_roles') || '').split(',').map(s => s.trim()).filter(Boolean);
  const tfaRequired = requiredRoles.includes(user.role);
  if (tfa && tfa.enabled) {
    const preToken = jwt.sign({ id: user.id, scope: 'pre-2fa' }, SECRET, { expiresIn: '5m' });
    return res.json({ twofa_required: true, pre_token: preToken });
  }

  db.prepare("UPDATE users SET last_login=strftime('%s','now') WHERE id=?").run(user.id);
  audit(user.tenant_id, user.id, 'login', 'user', user.id, 'ورود موفق', req.ip);
  const token = issueToken(user);
  res.json({
    token,
    user: { id: user.id, name: user.name, username: user.username, role: user.role, phone: user.phone || '' },
    twofa_setup_required: tfaRequired && !(tfa && tfa.enabled),
  });
});

// Get current user
router.get('/me', auth, (req, res) => {
  const db = getDB();
  const user = db.prepare('SELECT id,name,username,role,phone,last_login,tenant_id FROM users WHERE id=?').get(req.user.id);
  res.json(user);
});

// Change own password
router.post('/change-password', auth, (req, res) => {
  const oldPass = (req.body.oldPass || '').slice(0, 128);
  const newPass = (req.body.newPass || '').slice(0, 128);
  if (!newPass || newPass.length < 6) return res.status(400).json({ error: 'رمز جدید باید حداقل ۶ کاراکتر باشد' });
  const db = getDB();
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(oldPass, user.password))
    return res.status(400).json({ error: 'رمز قدیمی اشتباه است' });
  db.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(newPass, 10), req.user.id);
  audit(req.tenantId, req.user.id, 'change_password', 'user', req.user.id, 'تغییر رمز عبور', req.ip);
  res.json({ ok: true });
});

// Admin: reset a user's password (same tenant only)
router.post('/reset-password', auth, adminOnly, (req, res) => {
  const user_id = req.body.user_id;
  const new_pass = (req.body.new_pass || '').slice(0, 128);
  if (!user_id || !new_pass || new_pass.length < 6) return res.status(400).json({ error: 'اطلاعات ناقص یا رمز کوتاه‌تر از ۶ کاراکتر' });
  const db = getDB();
  const target = db.prepare('SELECT id,name FROM users WHERE id=? AND tenant_id=?').get(user_id, req.tenantId);
  if (!target) return res.status(404).json({ error: 'کاربر یافت نشد' });
  db.prepare('UPDATE users SET password=? WHERE id=? AND tenant_id=?').run(bcrypt.hashSync(new_pass, 10), user_id, req.tenantId);
  audit(req.tenantId, req.user.id, 'reset_password', 'user', user_id, `بازنشانی رمز ${target.name}`, req.ip);
  res.json({ ok: true });
});

// Admin: list all users of own tenant with last_login
router.get('/users', auth, adminOnly, (req, res) => {
  const db = getDB();
  const users = db.prepare('SELECT id,name,username,role,phone,active,last_login,commission_cash,commission_cheque,incentive_locked,created_at FROM users WHERE tenant_id=? ORDER BY created_at DESC').all(req.tenantId);
  res.json(users);
});

module.exports = router;
