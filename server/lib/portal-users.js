/**
 * Ensure a login user exists for a person (username = phone).
 * Spec: must_change_password=1; never return the password in API responses.
 * SMS of a temporary password is optional (opts.sendSms). A predictable
 * fallback password is never created; without SMS the user must use the
 * verified password-recovery flow or ask an administrator to reset access.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getSmsSettings } = require('./secret-settings');

const PORTAL_ROLES = ['unit_manager', 'department_manager'];

function revokeExistingSessions(db, userId) {
  // Lazy import avoids loading the auth stack in schema-only tooling.
  require('../middleware/auth').revokeUserSessions(db, userId);
}

function randomTempPassword() {
  // Fourteen readable characters with guaranteed upper/lower/digit classes.
  // Random placement prevents the class positions from becoming a template.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const chars = [
    'ABCDEFGHJKLMNPQRSTUVWXYZ'[crypto.randomInt(24)],
    'abcdefghijkmnopqrstuvwxyz'[crypto.randomInt(25)],
    '23456789'[crypto.randomInt(8)],
  ];
  while (chars.length < 14) chars.push(alphabet[crypto.randomInt(alphabet.length)]);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function ensurePersonUser(db, personId, role, opts) {
  const sendSms = !!(opts && opts.sendSms);
  const person = db.prepare('SELECT id, name, phone FROM persons WHERE id=?').get(personId);
  if (!person) {
    const err = new Error('ابتدا شخص را بسازید');
    err.status = 400;
    throw err;
  }
  const phone = String(person.phone || '').trim();
  if (!phone) {
    const err = new Error('شماره تلفن شخص برای ساخت کاربر الزامی است');
    err.status = 400;
    throw err;
  }
  const existing = db.prepare('SELECT id, username, role, active FROM users WHERE username=?').get(phone);
  if (existing) {
    if (role && existing.role !== role && existing.role !== 'admin') {
      revokeExistingSessions(db, existing.id);
      db.prepare('UPDATE users SET role=?, active=1 WHERE id=?').run(role, existing.id);
    } else if (existing.active !== 1) {
      revokeExistingSessions(db, existing.id);
      db.prepare('UPDATE users SET active=1 WHERE id=?').run(existing.id);
    }
    return { userId: existing.id, created: false, username: existing.username };
  }
  // Always generate an unguessable credential. When SMS is disabled, do not
  // return it even to internal callers; activation continues through the
  // verified forgot-password flow or an explicit administrator reset.
  const tempPass = randomTempPassword();
  const hash = bcrypt.hashSync(tempPass, 10);
  const r = db.prepare(`
    INSERT INTO users (name, username, password, role, active, must_change_password)
    VALUES (?,?,?,?,1,1)
  `).run(person.name || phone, phone, hash, role || 'department_manager');
  return {
    userId: r.lastInsertRowid,
    created: true,
    username: phone,
    ...(sendSms ? { tempPassword: tempPass } : {}),
    sendSms,
  };
}

/** Best-effort SMS of temp password — never throws; never log the password. Only when sendSms was requested. */
function sendTempPasswordSms(db, createdUser) {
  if (!createdUser?.created || !createdUser.tempPassword || !createdUser.username) return;
  if (createdUser.sendSms === false) return;
  try {
    const { sendSMS } = require('../sms');
    const settings = getSmsSettings(db);
    if (!settings.sms_api_key) return;
    const text = `ورود پورتال ترنم\nنام کاربری: ${createdUser.username}\nرمز موقت: ${createdUser.tempPassword}\nدر اولین ورود رمز را تغییر دهید.`;
    sendSMS(settings, createdUser.username, text).catch(() => {});
  } catch (_) { /* SMS optional */ }
}

function getPortalAccessByPhone(db, phone) {
  const p = String(phone || '').trim();
  if (!p) return { has_access: false, portal_role: null, user_id: null };
  const u = db.prepare('SELECT id, username, role, active FROM users WHERE username=?').get(p);
  if (!u) return { has_access: false, portal_role: null, user_id: null };
  const isPortal = PORTAL_ROLES.includes(u.role);
  const hasAccess = !!(u.active && isPortal);
  return {
    has_access: hasAccess,
    // OPS-01: inactive/revoked users must not expose a portal role or the UI
    // re-selects «مدیر واحد» after reload and a later save re-grants access.
    portal_role: hasAccess ? u.role : null,
    user_id: u.id,
    active: !!u.active,
    role: u.role,
  };
}

/**
 * Ensure a persons row exists for portal (by phone). Used when granting access from parties UI.
 */
function ensurePersonRowByPhone(db, { phone, name }) {
  const p = String(phone || '').trim();
  if (!p) {
    const err = new Error('شماره تلفن برای دسترسی پورتال الزامی است');
    err.status = 400;
    throw err;
  }
  let row = db.prepare('SELECT id, name, phone FROM persons WHERE phone=?').get(p);
  if (row) {
    if (name && name !== row.name) {
      db.prepare('UPDATE persons SET name=? WHERE id=?').run(String(name).trim(), row.id);
      row = db.prepare('SELECT id, name, phone FROM persons WHERE id=?').get(row.id);
    }
    return row;
  }
  const r = db.prepare('INSERT INTO persons (name, phone, active) VALUES (?,?,1)')
    .run(String(name || p).trim(), p);
  return db.prepare('SELECT id, name, phone FROM persons WHERE id=?').get(r.lastInsertRowid);
}

/**
 * Grant or revoke portal login for a person (by persons.id or phone+name).
 * portalRole: 'unit_manager' | 'department_manager' | '' | 'none'
 * sendSms: if true and user is newly created, SMS a random temporary password.
 * If false, no initial credential is disclosed and recovery/reset is required.
 * Never expose password in API JSON — use _temp only for SMS then drop.
 */
function setPortalAccess(db, { personId, phone, name, portalRole, sendSms }) {
  const role = String(portalRole || '').trim();
  const wantNone = !role || role === 'none' || role === 'off' || role === '0';
  const wantSms = !!sendSms;

  let person = null;
  if (personId) {
    person = db.prepare('SELECT id, name, phone FROM persons WHERE id=?').get(personId);
    if (!person) {
      const err = new Error('شخص یافت نشد');
      err.status = 404;
      throw err;
    }
  } else {
    person = ensurePersonRowByPhone(db, { phone, name });
  }

  const phoneStr = String(person.phone || '').trim();
  if (!phoneStr) {
    const err = new Error('شماره تلفن شخص برای دسترسی پورتال الزامی است');
    err.status = 400;
    throw err;
  }

  if (wantNone) {
    const existing = db.prepare('SELECT id, role, active FROM users WHERE username=?').get(phoneStr);
    if (existing && PORTAL_ROLES.includes(existing.role)) {
      revokeExistingSessions(db, existing.id);
      db.prepare('UPDATE users SET active=0 WHERE id=?').run(existing.id);
    }
    return {
      person_id: person.id,
      username: phoneStr,
      portal_role: null,
      has_access: false,
      created: false,
      revoked: !!(existing && PORTAL_ROLES.includes(existing.role)),
      sms_sent: false,
    };
  }

  if (!PORTAL_ROLES.includes(role)) {
    const err = new Error('نقش پورتال نامعتبر است (unit_manager یا department_manager)');
    err.status = 400;
    throw err;
  }

  const createdUser = ensurePersonUser(db, person.id, role, { sendSms: wantSms });
  return {
    person_id: person.id,
    username: createdUser.username,
    portal_role: role,
    has_access: true,
    created: !!createdUser.created,
    userId: createdUser.userId,
    sms_sent: !!(wantSms && createdUser.created),
    _temp: createdUser,
  };
}

module.exports = {
  ensurePersonUser,
  sendTempPasswordSms,
  randomTempPassword,
  getPortalAccessByPhone,
  ensurePersonRowByPhone,
  setPortalAccess,
  PORTAL_ROLES,
};
