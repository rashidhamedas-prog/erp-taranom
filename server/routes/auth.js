const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getDB, audit } = require('../db');
const { auth, adminOnly, SECRET } = require('../middleware/auth');
const { validatePassword } = require('../lib/security');
const { sendSMS } = require('../sms');

// In-memory failed-login tracker: { username: { count, until } }
const failedLogins = new Map();
const forgotAttempts = new Map();
const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60 * 1000;
const OTP_TTL_SEC = 10 * 60;
const MAX_OTP_ATTEMPTS = 5;

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

function normalizePhone(p) {
  return String(p || '')
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\s\-()]+/g, '')
    .replace(/^(\+98|0098|98)/, '0');
}

function getSMSSettings(db) {
  const rows = db.prepare("SELECT key,value FROM settings WHERE key LIKE 'sms_%'").all();
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  return s;
}

function forgotRateLimit(key) {
  const rec = forgotAttempts.get(key) || { count: 0, until: 0 };
  if (Date.now() < rec.until) return false;
  if (rec.count >= 5) {
    rec.until = Date.now() + 15 * 60 * 1000;
    forgotAttempts.set(key, rec);
    return false;
  }
  rec.count += 1;
  forgotAttempts.set(key, rec);
  return true;
}

// Login
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
    return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است' });
  }

  failedLogins.delete(username);
  db.prepare("UPDATE users SET last_login=strftime('%s','now') WHERE id=?").run(user.id);
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, name: user.name, phone: user.phone || '' },
    SECRET, { expiresIn: '30d' }
  );
  res.json({ token, user: { id: user.id, name: user.name, username: user.username, role: user.role, phone: user.phone || '' } });
});

// Forgot password — step 1: send OTP via SMS
router.post('/forgot', async (req, res) => {
  const username = (req.body.username || '').trim().slice(0, 64);
  const phone = normalizePhone(req.body.phone);
  if (!username || !phone) return res.status(400).json({ error: 'نام کاربری و شماره موبایل الزامی است' });
  if (!/^09\d{9}$/.test(phone)) return res.status(400).json({ error: 'شماره موبایل نامعتبر است' });

  const key = username + ':' + phone;
  if (!forgotRateLimit(key)) {
    return res.status(429).json({ error: 'تعداد درخواست‌ها زیاد است. ۱۵ دقیقه دیگر تلاش کنید.' });
  }

  const db = getDB();
  const user = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
  if (!user) {
    // Same message — don't reveal whether user exists
    return res.json({ ok: true, message: 'اگر اطلاعات صحیح باشد، کد بازیابی ارسال می‌شود.' });
  }
  const userPhone = normalizePhone(user.phone);
  if (!userPhone || userPhone !== phone) {
    return res.json({ ok: true, message: 'اگر اطلاعات صحیح باشد، کد بازیابی ارسال می‌شود.' });
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  const expires = Math.floor(Date.now() / 1000) + OTP_TTL_SEC;
  db.prepare('DELETE FROM password_reset_otps WHERE user_id=?').run(user.id);
  db.prepare('INSERT INTO password_reset_otps (user_id,code_hash,expires_at) VALUES (?,?,?)')
    .run(user.id, codeHash, expires);

  const settings = getSMSSettings(db);
  const text = `کد بازیابی رمز CRM ترنم: ${code}\nاعتبار: ۱۰ دقیقه`;
  const sms = await sendSMS(settings, phone, text);
  if (!sms.ok) {
    return res.status(503).json({ error: 'ارسال پیامک ممکن نشد. با مدیر سیستم تماس بگیرید یا رمز را از مدیر بخواهید.' });
  }
  res.json({ ok: true, message: 'کد بازیابی به موبایل شما ارسال شد.' });
});

// Forgot password — step 2: verify OTP and set new password
router.post('/forgot-reset', (req, res) => {
  const username = (req.body.username || '').trim().slice(0, 64);
  const code = String(req.body.code || '').trim();
  const newPass = (req.body.newPass || '').slice(0, 128);
  if (!username || !code || !newPass) return res.status(400).json({ error: 'اطلاعات ناقص' });

  const passErr = validatePassword(newPass);
  if (passErr) return res.status(400).json({ error: passErr });

  const db = getDB();
  const user = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
  if (!user) return res.status(400).json({ error: 'کد نامعتبر یا منقضی شده است' });

  const otp = db.prepare(
    'SELECT * FROM password_reset_otps WHERE user_id=? ORDER BY id DESC LIMIT 1'
  ).get(user.id);
  if (!otp || otp.expires_at < Math.floor(Date.now() / 1000)) {
    return res.status(400).json({ error: 'کد منقضی شده — دوباره درخواست دهید' });
  }
  if (otp.attempts >= MAX_OTP_ATTEMPTS) {
    return res.status(429).json({ error: 'تعداد تلاش بیش از حد — دوباره درخواست کد دهید' });
  }

  const hash = crypto.createHash('sha256').update(code).digest('hex');
  if (hash !== otp.code_hash) {
    db.prepare('UPDATE password_reset_otps SET attempts=attempts+1 WHERE id=?').run(otp.id);
    return res.status(400).json({ error: 'کد اشتباه است' });
  }

  db.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(newPass, 10), user.id);
  db.prepare('DELETE FROM password_reset_otps WHERE user_id=?').run(user.id);
  audit(user.id, 'reset_password', 'user', user.id, 'بازیابی رمز از طریق پیامک');
  res.json({ ok: true, message: 'رمز جدید ذخیره شد. اکنون وارد شوید.' });
});

router.get('/me', auth, (req, res) => {
  const db = getDB();
  const user = db.prepare('SELECT id,name,username,role,phone,last_login FROM users WHERE id=?').get(req.user.id);
  res.json(user);
});

router.post('/change-password', auth, (req, res) => {
  const oldPass = (req.body.oldPass || '').slice(0, 128);
  const newPass = (req.body.newPass || '').slice(0, 128);
  const passErr = validatePassword(newPass);
  if (passErr) return res.status(400).json({ error: passErr });
  const db = getDB();
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(oldPass, user.password))
    return res.status(400).json({ error: 'رمز قدیمی اشتباه است' });
  db.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(newPass, 10), req.user.id);
  res.json({ ok: true });
});

router.post('/reset-password', auth, adminOnly, (req, res) => {
  const user_id = req.body.user_id;
  const new_pass = (req.body.new_pass || '').slice(0, 128);
  if (!user_id || !new_pass) return res.status(400).json({ error: 'اطلاعات ناقص' });
  const passErr = validatePassword(new_pass);
  if (passErr) return res.status(400).json({ error: passErr });
  const db = getDB();
  const target = db.prepare('SELECT id,name FROM users WHERE id=?').get(user_id);
  if (!target) return res.status(404).json({ error: 'کاربر یافت نشد' });
  db.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(new_pass, 10), user_id);
  audit(req.user.id, 'reset_password', 'user', user_id, `بازنشانی رمز ${target.name}`);
  res.json({ ok: true });
});

router.get('/users', auth, adminOnly, (req, res) => {
  const db = getDB();
  const users = db.prepare(`SELECT id,name,username,role,phone,active,last_login,commission_cash,commission_cheque,commission_basis,monthly_target,quarterly_target,annual_target,bonus_pct,commission_fixed,penalty_pct,incentive_locked,created_at,
    rep_code,rep_subtype,territory,supervisor_id,employment_status,bank_name,bank_account,bank_iban,rep_opening_balance
    FROM users ORDER BY created_at DESC`).all();
  res.json(users);
});

module.exports = router;
