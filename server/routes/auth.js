const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getDB, audit, isDevice } = require('../db');
const {
  auth,
  adminOnly,
  invalidateUserCache,
  revokeUserSessions,
  revokeCurrentSession,
  SECRET,
} = require('../middleware/auth');
const {
  issueStaffSession,
  createLoginChallenge,
  revokeStaffSessionByHash,
  consumeRateLimit,
  rateLimitStatus,
  clearRateLimit,
} = require('../lib/auth-sessions');
const { validatePassword } = require('../lib/security');
const { getSmsSettings } = require('../lib/secret-settings');
const { sendSMS } = require('../sms');
const { publicInviteView, acceptInvitation } = require('../lib/user-invitations');

const OTP_TTL_SEC = 10 * 60;
const MAX_OTP_ATTEMPTS = 5;
const LOGIN_WINDOW_SEC = 15 * 60;
const LOGIN_FAILURE_MESSAGE = 'نام کاربری یا رمز عبور اشتباه است یا تلاش‌ها بیش از حد مجاز بوده است';
// Unknown accounts still execute bcrypt so timing does not become a username
// enumeration channel. The value is process-local and is never persisted.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);

function loginIp(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 128);
}

function rejectLogin(res, retryAfter = 0) {
  if (retryAfter > 0) res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfter))));
  return res.status(retryAfter > 0 ? 429 : 401).json({
    error: LOGIN_FAILURE_MESSAGE,
    code: 'LOGIN_REJECTED',
  });
}

function normalizePhone(p) {
  return String(p || '')
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\s\-()]+/g, '')
    .replace(/^(\+98|0098|98)/, '0');
}

function getSMSSettings(db) {
  return getSmsSettings(db);
}

function normalizeUsername(u) {
  return String(u || '')
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .trim()
    .slice(0, 64);
}

function otpDigest(purpose, subject, code) {
  return crypto.createHmac('sha256', SECRET)
    .update(`${purpose}:${subject}:${String(code || '')}`)
    .digest('hex');
}

function safeDigestEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'hex');
  const b = Buffer.from(String(right || ''), 'hex');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function loginConflict(res, error) {
  const existing = error.existing || {};
  const slotFa = { mobile: 'موبایل', desktop: 'دسکتاپ/ویندوز', web: 'وب' }[existing.device_slot] || existing.device_slot;
  return res.status(409).json({
    error: `این حساب روی یک دستگاه ${slotFa || ''} دیگر فعال است. برای ورود، نشست قبلی همان نوع باید قطع شود.`,
    code: 'DEVICE_SESSION_ACTIVE',
    other_device: {
      device_name: existing.device_name || '',
      device_kind: existing.device_kind || '',
      device_slot: existing.device_slot || '',
      last_seen: existing.last_seen || null,
    },
  });
}

function loginPayload(db, user, deviceInput) {
  const issued = issueStaffSession(db, user, deviceInput);
  const mustChange = !isDevice() && !!user.must_change_password;
  invalidateUserCache(user.id);
  return {
    token: issued.token,
    must_change_password: mustChange,
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role,
      phone: user.phone || '',
    },
  };
}

// Login
router.post('/login', (req, res) => {
  const username = normalizeUsername(req.body.username);
  const password = (req.body.password || '').slice(0, 128);
  if (!username || !password) return res.status(400).json({ error: 'اطلاعات ناقص' });

  const ip = loginIp(req);
  const identityState = rateLimitStatus('login_identity', username);
  const ipState = rateLimitStatus('login_ip', ip);
  if (!identityState.allowed || !ipState.allowed) {
    return rejectLogin(res, Math.max(identityState.retryAfter, ipState.retryAfter));
  }

  const db = getDB();
  const user = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
  const passwordMatches = bcrypt.compareSync(password, user && user.password ? user.password : DUMMY_PASSWORD_HASH);
  if (!user || !passwordMatches) {
    const identityLimit = consumeRateLimit('login_identity', username, {
      max: 10, windowSec: LOGIN_WINDOW_SEC, blockSec: LOGIN_WINDOW_SEC,
    });
    const ipLimit = consumeRateLimit('login_ip', ip, {
      max: 50, windowSec: LOGIN_WINDOW_SEC, blockSec: LOGIN_WINDOW_SEC,
    });
    if (user) audit(user.id, 'login_failed', 'user', user.id, 'رمز اشتباه', req);
    const retryAfter = Math.max(identityLimit.retryAfter, ipLimit.retryAfter);
    return rejectLogin(res, retryAfter);
  }

  clearRateLimit('login_identity', username);

  // Flag default password before 2FA step so must_change_password survives the 2FA round-trip.
  if (!isDevice() && password === 'admin123') {
    db.prepare('UPDATE users SET must_change_password=1 WHERE id=?').run(user.id);
    user.must_change_password = 1;
  }

  // 2FA: enabled for this user → require TOTP verification before issuing the real token.
  // Device builds never have two_factor_auth rows (central-only table) → step is skipped.
  const deviceInput = {
    device_fingerprint: req.body.device_fingerprint,
    device_name: req.body.device_name,
    device_kind: req.body.device_kind,
    force_logout_other: req.body.force_logout_other,
  };
  const tfa = db.prepare('SELECT enabled FROM two_factor_auth WHERE user_id=?').get(user.id);
  if (tfa && tfa.enabled) {
    try {
      const challenge = createLoginChallenge(user, deviceInput);
      return res.json({ twofa_required: true, pre_token: challenge.preToken });
    } catch (error) {
      if (error.code === 'DEVICE_SESSION_ACTIVE') return loginConflict(res, error);
      throw error;
    }
  }

  db.prepare("UPDATE users SET last_login=strftime('%s','now') WHERE id=?").run(user.id);

  try {
    const payload = loginPayload(db, user, deviceInput);
    audit(user.id, 'login', 'user', user.id, 'ورود موفق و ایجاد نشست معتبر', req);
    return res.json(payload);
  } catch (error) {
    if (error.code === 'DEVICE_SESSION_ACTIVE') return loginConflict(res, error);
    throw error;
  }
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
  const byId = db.prepare('SELECT id,user_id,session_id FROM user_device_sessions WHERE id=?').get(id);
  if (!byId) return res.status(404).json({ error: 'نشست یافت نشد' });
  if (byId.session_id) revokeStaffSessionByHash(byId.session_id);
  db.prepare('DELETE FROM user_device_sessions WHERE id=?').run(id);
  audit(req.user.id, 'revoke', 'user_device_session', byId.user_id, 'قطع نشست دستگاه #' + id, req);
  res.json({ ok: true });
});

router.post('/logout', auth, (req, res) => {
  const db = getDB();
  revokeCurrentSession(req);
  if (req.user.sid) {
    const sidHash = require('../lib/auth-sessions').opaqueHash(req.user.sid);
    db.prepare('DELETE FROM user_device_sessions WHERE session_id=?').run(sidHash);
  }
  audit(req.user.id, 'logout', 'user_session', req.user.id, 'خروج و ابطال نشست جاری', req);
  res.json({ ok: true });
});

router.post('/logout-all', auth, (req, res) => {
  const db = getDB();
  revokeUserSessions(db, req.user.id);
  audit(req.user.id, 'revoke', 'user_session', req.user.id, 'خروج از همه دستگاه‌ها');
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
  const byIdentity = consumeRateLimit('password-reset-send', key, { max: 5, windowSec: 900, blockSec: 900 });
  const byIp = consumeRateLimit('password-reset-send-ip', req.ip || req.socket?.remoteAddress || '', { max: 20, windowSec: 900, blockSec: 900 });
  if (!byIdentity.allowed || !byIp.allowed) {
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

  const code = String(crypto.randomInt(100000, 1000000));
  const codeHash = otpDigest('password-reset', user.id, code);
  const expires = Math.floor(Date.now() / 1000) + OTP_TTL_SEC;
  db.prepare('DELETE FROM password_reset_otps WHERE user_id=?').run(user.id);
  db.prepare('INSERT INTO password_reset_otps (user_id,code_hash,expires_at) VALUES (?,?,?)')
    .run(user.id, codeHash, expires);

  const settings = getSMSSettings(db);
  const text = `کد بازیابی رمز ERP ترنم: ${code}\nاعتبار: ۱۰ دقیقه`;
  const sms = await sendSMS(settings, phone, text);
  if (!sms.ok) {
    // Delivery failed: the generated credential must not remain usable.
    db.prepare('DELETE FROM password_reset_otps WHERE user_id=?').run(user.id);
    audit(user.id, 'otp_delivery_failed', 'user', user.id, 'عدم تحویل کد بازیابی رمز', req);
    // Keep the public response indistinguishable from an unknown account.
    return res.json({ ok: true, message: 'اگر اطلاعات صحیح باشد، کد بازیابی ارسال می‌شود.' });
  }
  audit(user.id, 'otp_sent', 'user', user.id, 'ارسال کد بازیابی رمز', req);
  res.json({ ok: true, message: 'اگر اطلاعات صحیح باشد، کد بازیابی ارسال می‌شود.' });
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
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'کد نامعتبر یا منقضی شده است' });

  const identityRate = consumeRateLimit('password-reset-verify', username, { max: 10, windowSec: 900, blockSec: 900 });
  const ipRate = consumeRateLimit('password-reset-verify-ip', req.ip || req.socket?.remoteAddress || '', { max: 30, windowSec: 900, blockSec: 900 });
  if (!identityRate.allowed || !ipRate.allowed) {
    return res.status(429).json({ error: 'تعداد تلاش بیش از حد است. ۱۵ دقیقه دیگر تلاش کنید.' });
  }

  const passErr = validatePassword(newPass);
  if (passErr) return res.status(400).json({ error: passErr });

  const db = getDB();
  const user = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
  if (!user) return res.status(400).json({ error: 'کد نامعتبر یا منقضی شده است' });

  const otp = db.prepare(
    'SELECT * FROM password_reset_otps WHERE user_id=? ORDER BY id DESC LIMIT 1'
  ).get(user.id);
  if (!otp || otp.expires_at < Math.floor(Date.now() / 1000)) {
    if (otp) db.prepare('DELETE FROM password_reset_otps WHERE id=?').run(otp.id);
    return res.status(400).json({ error: 'کد منقضی شده — دوباره درخواست دهید' });
  }
  if (otp.attempts >= MAX_OTP_ATTEMPTS) {
    return res.status(429).json({ error: 'تعداد تلاش بیش از حد — دوباره درخواست کد دهید' });
  }

  const hash = otpDigest('password-reset', user.id, code);
  if (!safeDigestEqual(hash, otp.code_hash)) {
    const attempts = Number(otp.attempts || 0) + 1;
    if (attempts >= MAX_OTP_ATTEMPTS) {
      db.prepare('DELETE FROM password_reset_otps WHERE id=?').run(otp.id);
    } else {
      db.prepare('UPDATE password_reset_otps SET attempts=? WHERE id=?').run(attempts, otp.id);
    }
    audit(user.id, 'otp_failed', 'user', user.id, 'کد بازیابی رمز نامعتبر', req);
    return res.status(400).json({ error: 'کد اشتباه است' });
  }

  revokeUserSessions(db, user.id, { bumpEpoch: false });
  db.transaction(() => {
    db.prepare('UPDATE users SET password=?,must_change_password=0,auth_epoch=COALESCE(auth_epoch,0)+1 WHERE id=?')
      .run(bcrypt.hashSync(newPass, 10), user.id);
    db.prepare('DELETE FROM password_reset_otps WHERE user_id=?').run(user.id);
  })();
  clearRateLimit('password-reset-verify', username);
  invalidateUserCache(user.id);
  audit(user.id, 'reset_password', 'user', user.id, 'بازیابی رمز از طریق پیامک و ابطال همه نشست‌ها', req);
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
      revokeUserSessions(db, req.user.id, { bumpEpoch: false });
      db.prepare('UPDATE users SET password=?,must_change_password=0,auth_epoch=COALESCE(auth_epoch,0)+1 WHERE id=?')
        .run(bcrypt.hashSync(newPass, 10), req.user.id);
      invalidateUserCache(req.user.id);
      audit(req.user.id, 'change_password', 'user', req.user.id, 'تغییر رمز و ابطال نشست‌های محلی', req);
      return res.json({ ok: true });
    }
  }

  if (!bcrypt.compareSync(oldPass, user.password))
    return res.status(400).json({ error: 'رمز قدیمی اشتباه است' });
  revokeUserSessions(db, req.user.id, { bumpEpoch: false });
  db.prepare('UPDATE users SET password=?,must_change_password=0,auth_epoch=COALESCE(auth_epoch,0)+1 WHERE id=?')
    .run(bcrypt.hashSync(newPass, 10), req.user.id);
  invalidateUserCache(req.user.id);
  audit(req.user.id, 'change_password', 'user', req.user.id, 'تغییر رمز و ابطال همه نشست‌ها', req);
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
  revokeUserSessions(db, user_id, { bumpEpoch: false });
  db.prepare('UPDATE users SET password=?,must_change_password=1,auth_epoch=COALESCE(auth_epoch,0)+1 WHERE id=?')
    .run(bcrypt.hashSync(new_pass, 10), user_id);
  invalidateUserCache(+user_id);
  audit(req.user.id, 'reset_password', 'user', user_id, `بازنشانی رمز ${target.name} و ابطال همه نشست‌ها`, req);
  res.json({ ok: true });
});

function inviteClient(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 128);
}

function rejectInviteRate(res, retryAfter) {
  if (retryAfter > 0) res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfter))));
  return res.status(429).json({
    error: 'تعداد تلاش برای دعوت بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.',
    code: 'E_INVITE_RATE',
  });
}

// Public: inspect a one-time staff invite (name only — no phone/email dump)
router.get('/invite/:token', (req, res) => {
  const ip = inviteClient(req);
  const ipState = rateLimitStatus('invite_lookup_ip', ip);
  if (!ipState.allowed) return rejectInviteRate(res, ipState.retryAfter);
  consumeRateLimit('invite_lookup_ip', ip, { max: 60, windowSec: LOGIN_WINDOW_SEC, blockSec: LOGIN_WINDOW_SEC });
  const db = getDB();
  return res.json(publicInviteView(db, req.params.token));
});

router.post('/invite/:token/accept', (req, res) => {
  const ip = inviteClient(req);
  const ipState = rateLimitStatus('invite_accept_ip', ip);
  if (!ipState.allowed) return rejectInviteRate(res, ipState.retryAfter);
  const consumed = consumeRateLimit('invite_accept_ip', ip, {
    max: 10, windowSec: LOGIN_WINDOW_SEC, blockSec: LOGIN_WINDOW_SEC,
  });
  if (!consumed.allowed) return rejectInviteRate(res, consumed.retryAfter);

  const db = getDB();
  try {
    const accepted = acceptInvitation(db, {
      rawToken: req.params.token,
      username: req.body && req.body.username,
      password: req.body && req.body.password,
    });
    audit(accepted.user_id, 'create', 'user', accepted.user_id, 'پذیرش دعوت و ساخت حساب', req);
    clearRateLimit('invite_accept_ip', ip);
    return res.json({
      ok: true,
      username: accepted.username,
      must_change_password: 0,
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'خطا در پذیرش دعوت', code: err.code });
  }
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
