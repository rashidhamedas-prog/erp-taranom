// Two-factor authentication (TOTP) — ported from CRM v4.
// Management (setup/disable/reset) is CENTRAL-ONLY: two_factor_auth is not a
// synced table, so offline device builds skip the 2FA step at login (the
// device itself is trusted after pairing). Verification at login only runs
// where a secret exists — i.e. on the central web server.
const router = require('express').Router();
const crypto = require('crypto');
const { authenticator } = require('otplib');
const { getDB, audit, isDevice } = require('../db');
const { auth, adminOnly, centralOnlyStrict, invalidateUserCache, revokeUserSessions } = require('../middleware/auth');
const {
  issueStaffSession,
  verifyLoginChallengeToken,
  failLoginChallenge,
  consumeLoginChallenge,
  challengeDevice,
  SECRET,
} = require('../lib/auth-sessions');
const { encrypt, decrypt, sha256 } = require('../services/crypto');

authenticator.options = { window: 1 }; // accept one 30s step of clock drift

function loginUserPayload(db, user, challengePayload) {
  const mustChange = !isDevice() && !!user.must_change_password;
  if (mustChange) invalidateUserCache(user.id);
  return {
    token: issueStaffSession(db, user, challengeDevice(challengePayload)).token,
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

const RECOVERY_DIGEST_PREFIX = 'h1:';
function recoveryDigest(code) {
  return RECOVERY_DIGEST_PREFIX + crypto.createHmac('sha256', SECRET)
    .update(`2fa-recovery:v1:${String(code || '').trim().toLowerCase()}`)
    .digest('hex');
}

function safeDigestEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function findRecoveryCode(hashes, code) {
  const current = recoveryDigest(code);
  const legacy = sha256(code);
  let index = -1;
  let legacyMatch = false;
  for (let i = 0; i < hashes.length; i += 1) {
    const stored = String(hashes[i] || '');
    const matchCurrent = safeDigestEqual(stored, current);
    const matchLegacy = !stored.startsWith(RECOVERY_DIGEST_PREFIX) && safeDigestEqual(stored, legacy);
    if (index === -1 && (matchCurrent || matchLegacy)) {
      index = i;
      legacyMatch = matchLegacy;
    }
  }
  return { index, legacyMatch };
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
    let challenge;
    try { challenge = verifyLoginChallengeToken(req.body.pre_token); }
    catch { return res.status(401).json({ error: 'چالش ورود منقضی یا باطل شده است — دوباره وارد شوید' }); }
    const payload = challenge.payload;
    const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(payload.id);
    const tfa = db.prepare('SELECT * FROM two_factor_auth WHERE user_id=? AND enabled=1').get(payload.id);
    if (!user || !tfa || Number(user.auth_epoch || 0) !== Number(payload.ae || 0)) {
      return res.status(401).json({ error: 'وضعیت 2FA نامعتبر' });
    }
    if (!authenticator.check(code, decrypt(tfa.secret))) {
      failLoginChallenge(payload);
      audit(user.id, '2fa_failed', 'user', user.id, 'کد 2FA اشتباه', req);
      const exhausted = Number(challenge.row.attempts || 0) + 1 >= 5;
      return res.status(exhausted ? 429 : 401).json({ error: exhausted ? 'تعداد تلاش بیش از حد است — دوباره وارد شوید' : 'کد تأیید اشتباه است' });
    }
    if (!consumeLoginChallenge(payload)) return res.status(401).json({ error: 'چالش ورود قبلاً استفاده شده است' });
    db.prepare("UPDATE users SET last_login=strftime('%s','now') WHERE id=?").run(user.id);
    audit(user.id, 'login', 'user', user.id, 'ورود موفق با 2FA', req);
    return res.json(loginUserPayload(db, user, payload));
  }

  // ── Enable flow (authenticated) ──
  return auth(req, res, () => centralOnlyStrict(req, res, () => {
    const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(req.user.id);
    if (!user) return res.status(401).json({ error: 'کاربر نامعتبر' });
    const tfa = db.prepare('SELECT * FROM two_factor_auth WHERE user_id=?').get(user.id);
    if (!tfa) return res.status(400).json({ error: 'ابتدا setup را انجام دهید' });
    if (tfa.enabled) return res.status(400).json({ error: 'از قبل فعال است' });
    if (!authenticator.check(code, decrypt(tfa.secret))) {
      audit(user.id, '2fa_enable_failed', 'user', user.id, 'کد فعال‌سازی 2FA نامعتبر', req);
      return res.status(400).json({ error: 'کد تأیید اشتباه است — دوباره تلاش کنید' });
    }
    const codes = generateRecoveryCodes();
    db.prepare('UPDATE two_factor_auth SET enabled=1,recovery_codes=? WHERE user_id=?')
      .run(JSON.stringify(codes.map(recoveryDigest)), user.id);
    revokeUserSessions(db, user.id);
    audit(user.id, '2fa_enabled', 'user', user.id, 'فعال‌سازی 2FA و ابطال همه نشست‌ها', req);
    return res.json({ ok: true, recovery_codes: codes, relogin_required: true });
  }));
});

// Login with a one-time recovery code (lost device) — consumes the code
router.post('/recovery-code', (req, res) => {
  const db = getDB();
  const code = String(req.body.code || '').trim().toLowerCase();
  if (!req.body.pre_token || !code) return res.status(400).json({ error: 'اطلاعات ناقص' });
  let challenge;
  try { challenge = verifyLoginChallengeToken(req.body.pre_token); }
  catch { return res.status(401).json({ error: 'چالش ورود منقضی یا باطل شده است — دوباره وارد شوید' }); }
  const payload = challenge.payload;
  const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(payload.id);
  const tfa = db.prepare('SELECT * FROM two_factor_auth WHERE user_id=? AND enabled=1').get(payload.id);
  if (!user || !tfa || Number(user.auth_epoch || 0) !== Number(payload.ae || 0)) {
    return res.status(401).json({ error: 'وضعیت 2FA نامعتبر' });
  }
  const hashes = JSON.parse(tfa.recovery_codes || '[]');
  const match = findRecoveryCode(hashes, code);
  const idx = match.index;
  if (idx === -1) {
    failLoginChallenge(payload);
    audit(user.id, '2fa_recovery_failed', 'user', user.id, 'کد بازیابی اشتباه', req);
    const exhausted = Number(challenge.row.attempts || 0) + 1 >= 5;
    return res.status(exhausted ? 429 : 401).json({ error: exhausted ? 'تعداد تلاش بیش از حد است — دوباره وارد شوید' : 'کد بازیابی نامعتبر است' });
  }
  if (!consumeLoginChallenge(payload)) return res.status(401).json({ error: 'چالش ورود قبلاً استفاده شده است' });
  // Legacy unsalted SHA-256 entries are supported only on this one successful
  // consumption path; the matched value is immediately removed and never
  // re-written in the weak format.
  if (match.legacyMatch) hashes[idx] = recoveryDigest(code);
  hashes.splice(idx, 1); // one-time use
  db.prepare('UPDATE two_factor_auth SET recovery_codes=? WHERE user_id=?').run(JSON.stringify(hashes), user.id);
  db.prepare("UPDATE users SET last_login=strftime('%s','now') WHERE id=?").run(user.id);
  audit(user.id, 'login', 'user', user.id, `ورود با کد بازیابی (${hashes.length} کد باقی‌مانده)`, req);
  res.json({ ...loginUserPayload(db, user, payload), remaining_codes: hashes.length });
});

// Disable own 2FA (requires a valid current code)
router.post('/disable', auth, centralOnlyStrict, (req, res) => {
  const db = getDB();
  const code = String(req.body.code || '').replace(/\s/g, '');
  const tfa = db.prepare('SELECT * FROM two_factor_auth WHERE user_id=? AND enabled=1').get(req.user.id);
  if (!tfa) return res.status(400).json({ error: '2FA فعال نیست' });
  if (!authenticator.check(code, decrypt(tfa.secret))) {
    audit(req.user.id, '2fa_disable_failed', 'user', req.user.id, 'کد غیرفعال‌سازی 2FA نامعتبر', req);
    return res.status(400).json({ error: 'کد تأیید اشتباه است' });
  }
  db.prepare('DELETE FROM two_factor_auth WHERE user_id=?').run(req.user.id);
  revokeUserSessions(db, req.user.id);
  audit(req.user.id, '2fa_disabled', 'user', req.user.id, 'غیرفعال‌سازی 2FA و ابطال همه نشست‌ها', req);
  res.json({ ok: true, relogin_required: true });
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
  revokeUserSessions(db, target.id);
  audit(req.user.id, '2fa_admin_reset', 'user', target.id, `بازنشانی 2FA کاربر ${target.name} و ابطال نشست‌ها`, req);
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
