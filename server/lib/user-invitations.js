/**
 * Central-only staff invitations. Raw token is returned once on create;
 * only sha256(token) is stored. Not registered in SYNCABLE_TABLES.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { validatePassword } = require('./security');
const { DEFAULT_ROLE_PERMISSIONS } = require('./rbac');

const INVITE_TTL_SEC = 72 * 60 * 60;
const TOKEN_BYTES = 32;
const DEFAULT_INVITE_ROLE = 'field_sales';

function inviteableRoles() {
  return Object.keys(DEFAULT_ROLE_PERMISSIONS).filter((role) => role !== 'admin');
}

function inviteRoleError(message, status) {
  const err = new Error(message);
  err.status = status || 400;
  err.code = 'E_INVITE_ROLE';
  return err;
}

/** Empty/null → field_sales. Never admin. Accounting only if actor is admin. */
function resolveIntendedRole(raw, actorRole) {
  if (raw == null || raw === '') return DEFAULT_INVITE_ROLE;
  const role = String(raw).trim();
  if (!role) return DEFAULT_INVITE_ROLE;
  if (role === 'admin' || !inviteableRoles().includes(role)) {
    throw inviteRoleError('نقش دعوت نامعتبر است');
  }
  if (role === 'accounting' && String(actorRole || '') !== 'admin') {
    throw inviteRoleError('فقط مدیر سیستم می‌تواند حسابدار دعوت کند', 403);
  }
  return role;
}

function roleFromInviteRow(row) {
  const stored = String((row && row.intended_role) || '').trim() || DEFAULT_INVITE_ROLE;
  if (stored === 'admin' || !inviteableRoles().includes(stored)) return DEFAULT_INVITE_ROLE;
  return stored;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function hashInviteToken(raw) {
  return crypto.createHash('sha256').update(String(raw || ''), 'utf8').digest('hex');
}

function generateInviteToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function tableColumns(db, table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name); }
  catch { return []; }
}

function hasColumn(db, table, column) {
  return tableColumns(db, table).includes(column);
}

function personContact(person) {
  const email = String(person.email || person.invited_email || '').trim();
  const phone = String(person.phone || '').trim();
  return email || phone || '';
}

function findInviteByRawToken(db, rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) return null;
  return db.prepare('SELECT * FROM user_invitations WHERE token_hash=?').get(hashInviteToken(token)) || null;
}

function invitePublicStatus(row, now = nowSec()) {
  if (!row) return { status: 'invalid', valid: false };
  if (row.used_at) return { status: 'used', valid: false };
  if (Number(row.expires_at) <= now) return { status: 'expired', valid: false };
  return { status: 'valid', valid: true };
}

function existingUserForPerson(db, person) {
  if (!person) return null;
  if (hasColumn(db, 'users', 'person_id')) {
    const byPerson = db.prepare('SELECT id, username FROM users WHERE person_id=?').get(person.id);
    if (byPerson) return byPerson;
  }
  const phone = String(person.phone || '').trim();
  if (phone) {
    const byUsername = db.prepare('SELECT id, username FROM users WHERE username=?').get(phone);
    if (byUsername) return byUsername;
    const byPhone = db.prepare('SELECT id, username FROM users WHERE phone=?').get(phone);
    if (byPhone) return byPhone;
  }
  return null;
}

function createInvitation(db, { personId, createdBy, ttlSec, role, actorRole }) {
  const person = db.prepare('SELECT * FROM persons WHERE id=?').get(Number(personId));
  if (!person) {
    const err = new Error('شخص یافت نشد');
    err.status = 404;
    err.code = 'E_INVITE_PERSON_NOT_FOUND';
    throw err;
  }
  const existing = existingUserForPerson(db, person);
  if (existing) {
    const err = new Error('این شخص قبلاً حساب کاربری دارد');
    err.status = 409;
    err.code = 'E_INVITE_USER_EXISTS';
    throw err;
  }

  const intendedRole = resolveIntendedRole(role, actorRole);
  const raw = generateInviteToken();
  if (raw === '12345' || raw === 'admin123') {
    const err = new Error('تولید توکن دعوت ناموفق بود');
    err.status = 500;
    err.code = 'E_INVITE_TOKEN';
    throw err;
  }
  const expiresAt = nowSec() + (Number(ttlSec) > 0 ? Number(ttlSec) : INVITE_TTL_SEC);
  const created = db.transaction(() => {
    db.prepare(`
      UPDATE user_invitations SET expires_at=?
      WHERE person_id=? AND used_at IS NULL AND expires_at>?
    `).run(nowSec(), person.id, nowSec());
    const cols = tableColumns(db, 'user_invitations');
    const fields = ['person_id', 'token_hash', 'expires_at', 'invited_email', 'created_by'];
    const values = [person.id, hashInviteToken(raw), expiresAt, personContact(person), createdBy || null];
    if (cols.includes('intended_role')) {
      fields.push('intended_role');
      values.push(intendedRole);
    }
    const result = db.prepare(
      `INSERT INTO user_invitations (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`
    ).run(...values);
    return result.lastInsertRowid;
  })();

  return {
    id: created,
    token: raw,
    expires_at: expiresAt,
    invite_url: `/invite?token=${encodeURIComponent(raw)}`,
    person_id: person.id,
    intended_role: intendedRole,
  };
}

function publicInviteView(db, rawToken) {
  const row = findInviteByRawToken(db, rawToken);
  const state = invitePublicStatus(row);
  if (state.status === 'invalid') {
    return { status: 'invalid', valid: false };
  }
  const person = db.prepare('SELECT name FROM persons WHERE id=?').get(row.person_id);
  return {
    status: state.status,
    valid: state.valid,
    person_name: person ? String(person.name || '').trim() : '',
  };
}

function normalizeInviteUsername(raw) {
  return String(raw || '')
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .trim()
    .slice(0, 64);
}

function acceptInvitation(db, { rawToken, username, password }) {
  const token = String(rawToken || '').trim();
  const userName = normalizeInviteUsername(username);
  const pass = String(password || '');
  if (!token) {
    const err = new Error('توکن دعوت نامعتبر است');
    err.status = 400;
    err.code = 'E_INVITE_INVALID';
    throw err;
  }
  if (!userName || userName.length < 3) {
    const err = new Error('نام کاربری باید حداقل ۳ کاراکتر باشد');
    err.status = 400;
    err.code = 'E_INVITE_USERNAME';
    throw err;
  }
  const passErr = validatePassword(pass);
  if (passErr) {
    const err = new Error(passErr);
    err.status = 400;
    err.code = 'E_INVITE_PASSWORD';
    throw err;
  }

  return db.transaction(() => {
    const row = findInviteByRawToken(db, token);
    const state = invitePublicStatus(row);
    if (state.status === 'invalid') {
      const err = new Error('لینک دعوت نامعتبر است');
      err.status = 404;
      err.code = 'E_INVITE_INVALID';
      throw err;
    }
    if (state.status === 'used') {
      const err = new Error('این دعوت قبلاً استفاده شده است');
      err.status = 409;
      err.code = 'E_INVITE_USED';
      throw err;
    }
    if (state.status === 'expired') {
      const err = new Error('لینک دعوت منقضی شده است');
      err.status = 410;
      err.code = 'E_INVITE_EXPIRED';
      throw err;
    }

    const person = db.prepare('SELECT * FROM persons WHERE id=?').get(row.person_id);
    if (!person) {
      const err = new Error('شخص دعوت‌شده یافت نشد');
      err.status = 404;
      err.code = 'E_INVITE_PERSON_NOT_FOUND';
      throw err;
    }
    const taken = db.prepare('SELECT id FROM users WHERE username=?').get(userName);
    if (taken) {
      const err = new Error('این نام کاربری قبلاً ثبت شده');
      err.status = 400;
      err.code = 'E_INVITE_USERNAME_TAKEN';
      throw err;
    }
    const already = existingUserForPerson(db, person);
    if (already) {
      const err = new Error('این شخص قبلاً حساب کاربری دارد');
      err.status = 409;
      err.code = 'E_INVITE_USER_EXISTS';
      throw err;
    }

    const hash = bcrypt.hashSync(pass, 10);
    const userCols = tableColumns(db, 'users');
    const fields = ['name', 'username', 'password', 'role', 'active', 'must_change_password'];
    const intendedRole = roleFromInviteRow(row);
    const values = [person.name || userName, userName, hash, intendedRole, 1, 0];
    if (userCols.includes('phone')) {
      fields.push('phone');
      values.push(String(person.phone || '').trim());
    }
    if (userCols.includes('person_id')) {
      fields.push('person_id');
      values.push(person.id);
    }
    const placeholders = fields.map(() => '?').join(',');
    const inserted = db.prepare(
      `INSERT INTO users (${fields.join(',')}) VALUES (${placeholders})`
    ).run(...values);
    const userId = inserted.lastInsertRowid;

    if (userCols.includes('party_id')) {
      try {
        require('./user-party').ensureUserParty(db, userId, {
          full_name: person.name,
          phone: person.phone,
          mobile: person.phone,
        });
      } catch (e) {
        if (e.code === 'E_PARTY_ALREADY_LINKED') throw e;
        // Party link is best-effort when the party schema is incomplete.
      }
    }

    const marked = db.prepare(`
      UPDATE user_invitations SET used_at=?
      WHERE id=? AND used_at IS NULL AND expires_at>?
    `).run(nowSec(), row.id, nowSec());
    if (!marked.changes) {
      const err = new Error('این دعوت قبلاً استفاده شده است');
      err.status = 409;
      err.code = 'E_INVITE_USED';
      throw err;
    }

    return {
      user_id: userId,
      username: userName,
      person_id: person.id,
      role: intendedRole,
      must_change_password: 0,
    };
  })();
}

module.exports = {
  INVITE_TTL_SEC,
  DEFAULT_INVITE_ROLE,
  inviteableRoles,
  resolveIntendedRole,
  hashInviteToken,
  generateInviteToken,
  createInvitation,
  publicInviteView,
  acceptInvitation,
  findInviteByRawToken,
  invitePublicStatus,
};
