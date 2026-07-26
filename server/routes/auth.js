const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getDB, audit, isDevice } = require('../db');
const { auth, adminOnly, invalidateUserCache, SECRET } = require('../middleware/auth');
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

function normalizeUsername(u) {
  return String(u || '')
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .trim()
    .slice(0, 64);
}

// Login
router.post('/login', (req, res) => {
  const username = normalizeUsername(req.body.username);
  const password = (req.body.password || '').slice(0, 128);
  if (!username || !password) return res.status(400).json({ error: 'اطلاعات ناقص' });

  if (isLockedOut(username))
    return res.status(429).json({ error: 'حساب به دلیل تلاش‌های مکرر ناموفق قفل شده است. ۱۵ دقیقه دیگر تلاش کنید.' });

  const db = getDB();
  const user = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
  if (!user || !user.password || !bcrypt.compareSync(password, user.password)) {
    recordFailure(username);
    if (user) audit(user.id, 'login_failed', 'user', user.id, 'رمز اشتباه', req);
    return res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است' });
  }

  failedLogins.delete(username);

  // Flag default password before 2FA step so must_change_password survives the 2FA round-trip.
  if (!isDevice() && password === 'admin123') {
    db.prepare('UPDATE users SET must_change_password=1 WHERE id=?').run(user.id);
    user.must_change_password = 1;
  }

  // 2FA: enabled for this user → require TOTP verification before issuing the real token.
  // Device builds never have two_factor_auth rows (central-only table) → step is skipped.
  const tfa = db.prepare('SELECT enabled FROM two_factor_auth WHERE user_id=?').get(user.id);
  if (tfa && tfa.enabled) {
    const preToken = jwt.sign({ id: user.id, scope: 'pre-2fa' }, SECRET, { expiresIn: '5m' });
    return res.json({ twofa_required: true, pre_token: preToken });
  }

  db.prepare("UPDATE users SET last_login=strftime('%s','now') WHERE id=?").run(user.id);

  // Slot-based device sessions: 1 mobile + 1 desktop + 1 web per user
  const fingerprint = String(req.body.device_fingerprint || '').slice(0, 200);
  const deviceName = String(req.body.device_name || '').slice(0, 120);
  const deviceKind = String(req.body.device_kind || 'web').slice(0, 32);
  const forceKick = !!req.body.force_logout_other;
  function deviceSlotOf(kind) {
    const k = String(kind || 'web').toLowerCase();
    if (/android|ios|mobile/.test(k)) return 'mobile';
    if (/desktop|windows|electron|win/.test(k)) return 'desktop';
    return 'web';
  }
  const deviceSlot = deviceSlotOf(deviceKind);
  if (fingerprint) {
    try {
      const existing = db.prepare(
        'SELECT * FROM user_device_sessions WHERE user_id=? AND device_slot=?'
      ).get(user.id, deviceSlot);
      if (existing && existing.device_fingerprint !== fingerprint && !forceKick) {
        const slotFa = { mobile: 'موبایل', desktop: 'دسکتاپ/ویندوز', web: 'وب' }[deviceSlot] || deviceSlot;
        return res.status(409).json({
          error: `این حساب روی یک دستگاه ${slotFa} دیگر فعال است. برای ورود، نشست قبلی همان نوع باید قطع شود.`,
          code: 'DEVICE_SESSION_ACTIVE',
          other_device: {
            device_name: existing.device_name,
            device_kind: existing.device_kind,
            device_slot: existing.device_slot || deviceSlot,
            last_seen: existing.last_seen,
          },
        });
      }
      db.prepare(`
        INSERT INTO user_device_sessions (user_id, device_slot, device_fingerprint, device_name, device_kind, last_seen)
        VALUES (?,?,?,?,?,strftime('%s','now'))
        ON CONFLICT(user_id, device_slot) DO UPDATE SET
          device_fingerprint=excluded.device_fingerprint,
          device_name=excluded.device_name,
          device_kind=excluded.device_kind,
          last_seen=excluded.last_seen
      `).run(user.id, deviceSlot, fingerprint, deviceName || deviceKind, deviceKind);
    } catch (e) {
      console.warn('user_device_sessions:', e.message);
    }
  }

  // Central only: default/assigned passwords must be changed on first login.
  let mustChange = false;
  if (!isDevice()) {
    mustChange = !!user.must_change_password;
    invalidateUserCache(user.id);
  }

  audit(user.id, 'login', 'user', user.id, 'ورود موفق', req);
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, name: user.name, phone: user.phone || '', dfp: fingerprint || undefined, dslot: fingerprint ? deviceSlot : undefined },
    SECRET, { expiresIn: '30d' }
  );
  res.json({
    token,
    must_change_password: mustChange,
    user: { id: user.id, name: user.name, username: user.username, role: user.role, phone: user.phone || '' }
  });
});

// Admin: list / revoke device sessions (slot-aware)
router.get('/device-sessions', auth, adminOnly, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT s.*, u.name as user_name, u.username
    FROM user_device_sessions s
    LEFT JOIN users u ON u.id=s.user_id
    ORDER BY s.last_seen DESC
  `).all();
  res.json(rows);
});

router.delete('/device-sessions/:id', auth, adminOnly, (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'شناسه نامعتبر' });
  // Prefer delete by session id; fallback: treat param as user_id (legacy) → wipe all slots
  const byId = db.prepare('SELECT id, user_id FROM user_device_sessions WHERE id=?').get(id);
  if (byId) {
    db.prepare('DELETE FROM user_device_sessions WHERE id=?').run(id);
    audit(req.user.id, 'revoke', 'user_device_session', byId.user_id, 'قطع نشست دستگاه #' + id);
  } else {
    db.prepare('DELETE FROM user_device_sessions WHERE user_id=?').run(id);
    audit(req.user.id, 'revoke', 'user_device_session', id, 'قطع همه نشست‌های کاربر');
  }
  res.json({ ok: true });
});

// Forgot password — step 1: send OTP via SMS
router.post('/forgot', async (req, res) => {
  if (isDevice()) {
    const { isPaired } = require('../sync/client');
    if (isPaired(getDB())) {
      return res.status(403).json({ error: 'بازیابی رمز فقط از نسخه وب (سرور مرکزی) امکان‌پذیر است.' });
    }
  }
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
  const text = `کد بازیابی رمز ERP ترنم: ${code}\nاعتبار: ۱۰ دقیقه`;
  const sms = await sendSMS(settings, phone, text);
  if (!sms.ok) {
    return res.status(503).json({ error: 'ارسال پیامک ممکن نشد. با مدیر سیستم تماس بگیرید یا رمز را از مدیر بخواهید.' });
  }
  res.json({ ok: true, message: 'کد بازیابی به موبایل شما ارسال شد.' });
});

// Forgot password — step 2: verify OTP and set new password
router.post('/forgot-reset', (req, res) => {
  if (isDevice()) {
    const { isPaired } = require('../sync/client');
    if (isPaired(getDB())) {
      return res.status(403).json({ error: 'بازیابی رمز فقط از نسخه وب (سرور مرکزی) امکان‌پذیر است.' });
    }
  }
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

  db.prepare('UPDATE users SET password=?, must_change_password=0 WHERE id=?').run(bcrypt.hashSync(newPass, 10), user.id);
  db.prepare('DELETE FROM password_reset_otps WHERE user_id=?').run(user.id);
  invalidateUserCache(user.id);
  audit(user.id, 'reset_password', 'user', user.id, 'بازیابی رمز از طریق پیامک');
  res.json({ ok: true, message: 'رمز جدید ذخیره شد. اکنون وارد شوید.' });
});

router.get('/me', auth, (req, res) => {
  const db = getDB();
  const user = db.prepare('SELECT id,name,username,role,phone,last_login,must_change_password,party_id,sales_warehouse_id FROM users WHERE id=?').get(req.user.id);
  let is_marketer = false;
  let catalog_category_ids = [];
  try {
    catalog_category_ids = db.prepare('SELECT category_id FROM user_catalog_categories WHERE user_id=?').all(user.id).map(r => r.category_id);
    if (user.party_id) {
      const p = db.prepare('SELECT party_group_id, party_roles FROM parties WHERE id=?').get(user.party_id);
      if (p?.party_group_id) {
        const g = db.prepare('SELECT is_marketer FROM party_groups WHERE id=?').get(p.party_group_id);
        if (g?.is_marketer) is_marketer = true;
      }
      try {
        const roles = p?.party_roles ? JSON.parse(p.party_roles) : [];
        if (roles.includes('marketer')) is_marketer = true;
      } catch (_) {}
    }
  } catch (_) {}
  res.json({ ...user, is_marketer, catalog_category_ids });
});

router.get('/users/:id/catalog-categories', auth, adminOnly, (req, res) => {
  const db = getDB();
  const ids = db.prepare('SELECT category_id FROM user_catalog_categories WHERE user_id=?').all(req.params.id).map(r => r.category_id);
  res.json(ids);
});

router.put('/users/:id/catalog-categories', auth, adminOnly, (req, res) => {
  const db = getDB();
  const ids = Array.isArray(req.body.category_ids) ? req.body.category_ids.map(Number).filter(Boolean) : [];
  db.transaction(() => {
    db.prepare('DELETE FROM user_catalog_categories WHERE user_id=?').run(req.params.id);
    const ins = db.prepare('INSERT OR IGNORE INTO user_catalog_categories (user_id,category_id) VALUES (?,?)');
    for (const cid of ids) ins.run(req.params.id, cid);
  })();
  res.json({ ok: true, category_ids: ids });
});

router.post('/change-password', auth, async (req, res) => {
  const oldPass = (req.body.oldPass || '').slice(0, 128);
  const newPass = (req.body.newPass || '').slice(0, 128);
  const passErr = validatePassword(newPass);
  if (passErr) return res.status(400).json({ error: passErr });
  if (newPass === 'admin123') return res.status(400).json({ error: 'این رمز مجاز نیست — رمز جدیدی انتخاب کنید' });
  const db = getDB();
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);

  // Paired devices: change on central first, then mirror locally — otherwise
  // the next sync pull overwrites users.password with the old central hash.
  if (isDevice()) {
    const { isPaired, changePasswordOnCentral } = require('../sync/client');
    if (isPaired(db)) {
      const proxied = await changePasswordOnCentral(user.username, oldPass, newPass);
      if (proxied.offline) {
        return res.status(503).json({
          error: 'اتصال به سرور مرکزی برقرار نیست. برای تغییر رمز باید آنلاین باشید یا از نسخه وب استفاده کنید.'
        });
      }
      if (!proxied.ok) {
        return res.status(proxied.code === 'twofa_required' ? 403 : 400).json({
          error: proxied.error,
          code: proxied.code || undefined
        });
      }
      db.prepare('UPDATE users SET password=?, must_change_password=0 WHERE id=?')
        .run(bcrypt.hashSync(newPass, 10), req.user.id);
      invalidateUserCache(req.user.id);
      return res.json({ ok: true });
    }
  }

  if (!bcrypt.compareSync(oldPass, user.password))
    return res.status(400).json({ error: 'رمز قدیمی اشتباه است' });
  db.prepare('UPDATE users SET password=?, must_change_password=0 WHERE id=?').run(bcrypt.hashSync(newPass, 10), req.user.id);
  invalidateUserCache(req.user.id);
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
  // رمزی که مدیر تعیین کرده موقتی است — کاربر در اولین ورود باید عوضش کند
  db.prepare('UPDATE users SET password=?, must_change_password=1 WHERE id=?').run(bcrypt.hashSync(new_pass, 10), user_id);
  invalidateUserCache(+user_id);
  audit(req.user.id, 'reset_password', 'user', user_id, `بازنشانی رمز ${target.name}`);
  res.json({ ok: true });
});

router.get('/users', auth, adminOnly, (req, res) => {
  const db = getDB();
  const users = db.prepare(`SELECT u.id,u.name,u.username,u.role,u.phone,u.active,u.last_login,u.commission_cash,u.commission_cheque,u.commission_basis,u.monthly_target,u.quarterly_target,u.annual_target,u.bonus_pct,u.commission_fixed,u.penalty_pct,u.supervisor_commission_pct,u.incentive_locked,u.created_at,
    u.rep_code,u.rep_subtype,u.territory,u.supervisor_id,u.employment_status,u.bank_name,u.bank_account,u.bank_iban,u.rep_opening_balance,u.party_id,u.sales_warehouse_id,
    p.person_code,p.legal_type,p.company_name,p.national_id,p.economic_code,
    p.secondary_phone AS person_secondary_phone,p.mobile AS person_mobile,p.fax AS person_fax,
    p.email AS person_email,p.city AS person_city,p.province AS person_province,p.address AS person_address,
    p.postal_code AS person_postal_code,p.birth_date AS person_birth_date,p.notes AS person_notes,
    p.party_group_id AS person_party_group_id,p.account_nature AS person_account_nature
    FROM users u LEFT JOIN parties p ON p.id=u.party_id ORDER BY u.created_at DESC`).all();
  res.json(users);
});

module.exports = router;
