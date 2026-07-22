/**
 * Ensure a login user exists for a person (username = phone).
 * Spec: must_change_password=1; never return the password in API responses.
 * SMS of temp password is optional (opts.sendSms) — without SMS, default temp is 12345.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const PORTAL_ROLES = ['unit_manager', 'department_manager'];
const DEFAULT_TEMP_PASSWORD = '12345';

function randomTempPassword() {
  // 10 chars, alphanumeric — readable in SMS, not a dictionary word
  return crypto.randomBytes(8).toString('base64url').replace(/[^a-zA-Z0-9]/g, 'x').slice(0, 10);
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
      db.prepare('UPDATE users SET role=?, active=1 WHERE id=?').run(role, existing.id);
    } else if (existing.active !== 1) {
      db.prepare('UPDATE users SET active=1 WHERE id=?').run(existing.id);
    }
    return { userId: existing.id, created: false, username: existing.username };
  }
  // SMS on → random (sent by SMS). SMS off → fixed default; first login forces change.
  const tempPass = sendSms ? randomTempPassword() : DEFAULT_TEMP_PASSWORD;
  const hash = bcrypt.hashSync(tempPass, 10);
  const r = db.prepare(`
    INSERT INTO users (name, username, password, role, active, must_change_password)
    VALUES (?,?,?,?,1,1)
  `).run(person.name || phone, phone, hash, role || 'department_manager');
  return {
    userId: r.lastInsertRowid,
    created: true,
    username: phone,
    tempPassword: tempPass,
    sendSms,
  };
}

/** Best-effort SMS of temp password — never throws; never log the password. Only when sendSms was requested. */
function sendTempPasswordSms(db, createdUser) {
  if (!createdUser?.created || !createdUser.tempPassword || !createdUser.username) return;
  if (createdUser.sendSms === false) return;
  try {
    const { sendSMS } = require('../sms');
    const settingsRows = db.prepare(
      "SELECT key,value FROM settings WHERE key IN ('sms_provider','sms_api_key','sms_from')"
    ).all();
    const settings = {};
    settingsRows.forEach(r => { settings[r.key] = r.value; });
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
  return {
    has_access: !!(u.active && isPortal),
    portal_role: isPortal ? u.role : null,
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
 * sendSms: if true and user is newly created, SMS random temp password; else default 12345.
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
  DEFAULT_TEMP_PASSWORD,
};
