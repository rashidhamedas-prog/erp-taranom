/**
 * Ensure a login user exists for a person (username = phone).
 * Spec: must_change_password=1; never return the password in API responses.
 */
const bcrypt = require('bcryptjs');

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
  const tempPass = String(Math.floor(10000 + Math.random() * 90000));
  const hash = bcrypt.hashSync(tempPass, 10);
  const r = db.prepare(`
    INSERT INTO users (name, username, password, role, active, must_change_password)
    VALUES (?,?,?,?,1,1)
  `).run(person.name || phone, phone, hash, role || 'department_manager');
  return { userId: r.lastInsertRowid, created: true, username: phone, tempPassword: tempPass };
}

module.exports = { ensurePersonUser };
