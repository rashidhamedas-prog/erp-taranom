/**
 * Ensure a login user exists for a person (username = phone).
 * Spec: must_change_password=1; never return the password in API responses.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

function randomTempPassword() {
  // 10 chars, alphanumeric — readable in SMS, not a dictionary word
  return crypto.randomBytes(8).toString('base64url').replace(/[^a-zA-Z0-9]/g, 'x').slice(0, 10);
}

function ensurePersonUser(db, personId, role) {
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
      db.prepare('UPDATE users SET role=? WHERE id=?').run(role, existing.id);
    }
    return { userId: existing.id, created: false, username: existing.username };
  }
  const tempPass = randomTempPassword();
  const hash = bcrypt.hashSync(tempPass, 10);
  const r = db.prepare(`
    INSERT INTO users (name, username, password, role, active, must_change_password)
    VALUES (?,?,?,?,1,1)
  `).run(person.name || phone, phone, hash, role || 'department_manager');
  return { userId: r.lastInsertRowid, created: true, username: phone, tempPassword: tempPass };
}

/** Best-effort SMS of temp password — never throws; never log the password. */
function sendTempPasswordSms(db, createdUser) {
  if (!createdUser?.created || !createdUser.tempPassword || !createdUser.username) return;
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

module.exports = { ensurePersonUser, sendTempPasswordSms, randomTempPassword };
