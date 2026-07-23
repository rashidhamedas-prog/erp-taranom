// Two-factor authentication (TOTP) — ported from CRM v4.
// Management (setup/disable/reset) is CENTRAL-ONLY: two_factor_auth is not a
// synced table, so offline device builds skip the 2FA step at login (the
// device itself is trusted after pairing). Verification at login only runs
// where a secret exists — i.e. on the central web server.
const router = require('express').Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { authenticator } = require('otplib');
const { getDB, audit, isDevice } = require('../db');
const { auth, adminOnly, centralOnlyStrict, invalidateUserCache, SECRET } = require('../middleware/auth');
const { encrypt, decrypt, sha256 } = require('../services/crypto');

authenticator.options = { window: 1 }; // accept one 30s step of clock drift

function issueToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, name: user.name, phone: user.phone || '' },
    SECRET, { expiresIn: '30d' }
  );
}

function loginUserPayload(user) {
  const mustChange = !isDevice() && !!user.must_change_password;
  if (mustChange) invalidateUserCache(user.id);
  return {
    token: issueToken(user),
    must_change_password: mustChange,
    user: { id: user.id, name: user.name, username: user.username, role: user.role, phone: user.phone || '' }
  };
}

function getSettingValue(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : '';
}

function generateRecoveryCodes(n = 8) {
  const codes = [];
  for (let i = 0; i < n; i++) codes.push(crypto.randomBytes(4).toString('hex'));
  return codes;
}

// Step 1 of enabling: generate a secret, store disabled, return otpauth URI for the QR
router.post('/setup', auth, centralOnlyStrict, (req, res) => {
  const db = getDB();
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const existing = db.prepare('SELECT * FROM two_factor_auth WHERE user_id=?').get(user.id);
  if (existing && existing.enabled) return res.status(400).json({ error: 'احراز هویت دو مرحله‌ای از قبل فعال است' });

  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(user.username, 'CRM Taranom', secret);
  if (existing) {
    db.prepare('UPDATE two_factor_auth SET secret=?, enabled=0 WHERE user_id=?').run(encrypt(secret), user.id);
  } else {
    db.prepare('INSERT INTO two_factor_auth (user_id, secret, enabled) VALUES (?,?,0)').run(user.id, encrypt(secret));
  }
  res.json({ otpauth, secret }); // secret shown once for manual entry
});

// Step 2 of enabling: verify the first code → enable + hand out recovery codes.
// ALSO used at login: body {pre_token, code} exchanges a pre-2fa token for the real one.
router.post('/verify', (req, res) => {
  const db = getDB();
  const code = String(req.body.code || '').replace(/\s/g, '');
  if (!code) return res.status(400).json({ error: 'کد الزامی است' });

  // ── Login flow (pre-2fa token) ──
  if (req.body.pre_token) {
    let payload;
    try { payload = jwt.verify(req.body.pre_token, SECRET); } catch { return res.status(401).json({ error: 'توکن منقضی شده — دوباره وارد شوید' }); }
    if (payload.scope !== 'pre-2fa') return res.status(401).json({ error: 'توکن نامعتبر' });
    const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(payload.id);
    const tfa = db.prepare('SELECT * FROM two_factor_auth WHERE user_id=? AND enabled=1').get(payload.id);
    if (!user || !tfa) return res.status(401).json({ error: 'وضعیت 2FA نامعتبر' });
    if (!authenticator.check(code, decrypt(tfa.secret))) {
      audit(user.id, '2fa_failed', 'user', user.id, 'کد 2FA اشتباه', req);
      return res.status(401).json({ error: 'کد تأیید اشتباه است' });
    }
    db.prepare("UPDATE users SET last_login=strftime('%s','now') WHERE id=?").run(user.id);
    audit(user.id, 'login', 'user', user.id, 'ورود موفق با 2FA', req);
    return res.json(loginUserPayload(user));
  }

  // ── Enable flow (authenticated) ──
  const token = req.headers['authorization']?.split(' ')[1];
  let payload;
  try { payload = jwt.verify(token, SECRET); } catch { return res.status(401).json({ error: 'توکن نامعتبر' }); }
  const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(payload.id);
  if (!user) return res.status(401).json({ error: 'کاربر نامعتبر' });
  const tfa = db.prepare('SELECT * FROM two_factor_auth WHERE user_id=?').get(user.id);
  if (!tfa) return res.status(400).json({ error: 'ابتدا setup را انجام دهید' });
  if (tfa.enabled) return res.status(400).json({ error: 'از قبل فعال است' });
  if (!authenticator.check(code, decrypt(tfa.secret))) {
    return res.status(400).json({ error: 'کد تأیید اشتباه است — دوباره تلاش کنید' });
  }
  const codes = generateRecoveryCodes();
  db.prepare('UPDATE two_factor_auth SET enabled=1, recovery_codes=? WHERE user_id=?')
    .run(JSON.stringify(codes.map(sha256)), user.id);
  audit(user.id, '2fa_enabled', 'user', user.id, 'فعال‌سازی احراز هویت دو مرحله‌ای', req);
  res.json({ ok: true, recovery_codes: codes }); // shown ONCE — user must save them
});

// Login with a one-time recovery code (lost device) — consumes the code
router.post('/recovery-code', (req, res) => {
  const db = getDB();
  const code = String(req.body.code || '').trim().toLowerCase();
  if (!req.body.pre_token || !code) return res.status(400).json({ error: 'اطلاعات ناقص' });
  let payload;
  try { payload = jwt.verify(req.body.pre_token, SECRET); } catch { return res.status(401).json({ error: 'توکن منقضی شده — دوباره وارد شوید' }); }
  if (payload.scope !== 'pre-2fa') return res.status(401).json({ error: 'توکن نامعتبر' });
  const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(payload.id);
  const tfa = db.prepare('SELECT * FROM two_factor_auth WHERE user_id=? AND enabled=1').get(payload.id);
  if (!user || !tfa) return res.status(401).json({ error: 'وضعیت 2FA نامعتبر' });
  const hashes = JSON.parse(tfa.recovery_codes || '[]');
  const idx = hashes.indexOf(sha256(code));
  if (idx === -1) {
    audit(user.id, '2fa_recovery_failed', 'user', user.id, 'کد بازیابی اشتباه', req);
    return res.status(401).json({ error: 'کد بازیابی نامعتبر است' });
  }
  hashes.splice(idx, 1); // one-time use
  db.prepare('UPDATE two_factor_auth SET recovery_codes=? WHERE user_id=?').run(JSON.stringify(hashes), user.id);
  db.prepare("UPDATE users SET last_login=strftime('%s','now') WHERE id=?").run(user.id);
  audit(user.id, 'login', 'user', user.id, `ورود با کد بازیابی (${hashes.length} کد باقی‌مانده)`, req);
  res.json({ ...loginUserPayload(user), remaining_codes: hashes.length });
});

// Disable own 2FA (requires a valid current code)
router.post('/disable', auth, centralOnlyStrict, (req, res) => {
  const db = getDB();
  const code = String(req.body.code || '').replace(/\s/g, '');
  const tfa = db.prepare('SELECT * FROM two_factor_auth WHERE user_id=? AND enabled=1').get(req.user.id);
  if (!tfa) return res.status(400).json({ error: '2FA فعال نیست' });
  if (!authenticator.check(code, decrypt(tfa.secret))) {
    return res.status(400).json({ error: 'کد تأیید اشتباه است' });
  }
  db.prepare('DELETE FROM two_factor_auth WHERE user_id=?').run(req.user.id);
  audit(req.user.id, '2fa_disabled', 'user', req.user.id, 'غیرفعال‌سازی 2FA توسط خود کاربر', req);
  res.json({ ok: true });
});

// Own 2FA status
router.get('/status', auth, (req, res) => {
  const db = getDB();
  const tfa = db.prepare('SELECT enabled, recovery_codes FROM two_factor_auth WHERE user_id=?').get(req.user.id);
  const requiredRoles = (getSettingValue(db, 'twofa_required_roles') || '').split(',').map(s => s.trim());
  res.json({
    enabled: !!(tfa && tfa.enabled),
    required: requiredRoles.includes(req.user.role),
    remaining_recovery_codes: tfa ? JSON.parse(tfa.recovery_codes || '[]').length : 0,
  });
});

// Admin: reset (remove) a user's 2FA — for lost devices when recovery codes are gone
router.post('/admin-reset/:userId', auth, adminOnly, centralOnlyStrict, (req, res) => {
  const db = getDB();
  const target = db.prepare('SELECT id,name FROM users WHERE id=?').get(req.params.userId);
  if (!target) return res.status(404).json({ error: 'کاربر یافت نشد' });
  db.prepare('DELETE FROM two_factor_auth WHERE user_id=?').run(target.id);
  audit(req.user.id, '2fa_admin_reset', 'user', target.id, `بازنشانی 2FA کاربر ${target.name} توسط مدیر`, req);
  res.json({ ok: true });
});

// Admin: 2FA status of all users
router.get('/admin-status', auth, adminOnly, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT u.id, u.name, u.username, u.role, COALESCE(t.enabled,0) as twofa_enabled
    FROM users u LEFT JOIN two_factor_auth t ON t.user_id=u.id
    WHERE u.active=1 ORDER BY u.name
  `).all();
  res.json(rows);
});

module.exports = router;
