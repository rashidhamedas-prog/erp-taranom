'use strict';

const { DEFAULT_ROLE_PERMISSIONS } = require('./rbac');

const ROLE_KEYS = Object.keys(DEFAULT_ROLE_PERMISSIONS);
const DEFAULT_ABSOLUTE_HOURS = 12;
const DEFAULT_IDLE_HOURS = 8;
const MAX_HOURS = 24;

function readSetting(db, key) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? row.value : '';
  } catch {
    return '';
  }
}

function clampHours(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const hours = Math.round(n);
  if (hours < 1 || hours > MAX_HOURS) return null;
  return hours;
}

function staffSessionPolicy(db) {
  const absolute = clampHours(readSetting(db, 'session_absolute_hours'), DEFAULT_ABSOLUTE_HOURS)
    || DEFAULT_ABSOLUTE_HOURS;
  let idle = clampHours(readSetting(db, 'session_idle_hours'), DEFAULT_IDLE_HOURS)
    || DEFAULT_IDLE_HOURS;
  if (idle > absolute) idle = absolute;
  return {
    absoluteHours: absolute,
    idleHours: idle,
    absoluteSec: absolute * 3600,
    idleSec: idle * 3600,
  };
}

function normalizeTwofaRoles(value) {
  const picked = new Set();
  for (const part of String(value || '').split(',')) {
    const role = part.trim();
    if (ROLE_KEYS.includes(role)) picked.add(role);
  }
  return [...picked].join(',');
}

function twofaRequiredRoles(db) {
  return normalizeTwofaRoles(readSetting(db, 'twofa_required_roles')).split(',').filter(Boolean);
}

function roleRequiresTwofa(db, role) {
  return twofaRequiredRoles(db).includes(String(role || ''));
}

function validateStaffPolicyBody(body, db) {
  const hasAbsolute = Object.prototype.hasOwnProperty.call(body, 'session_absolute_hours');
  const hasIdle = Object.prototype.hasOwnProperty.call(body, 'session_idle_hours');
  if (!hasAbsolute && !hasIdle) return { ok: true };
  const current = staffSessionPolicy(db);
  const absolute = hasAbsolute
    ? clampHours(body.session_absolute_hours, null)
    : current.absoluteHours;
  const idle = hasIdle
    ? clampHours(body.session_idle_hours, null)
    : current.idleHours;
  if (!absolute || !idle) {
    return { ok: false, error: 'عمر نشست باید عددی بین ۱ تا ۲۴ ساعت باشد' };
  }
  if (idle > absolute) {
    return { ok: false, error: 'مهلت بیکاری نمی‌تواند از سقف عمر نشست بیشتر باشد' };
  }
  return { ok: true, absolute, idle };
}

module.exports = {
  ROLE_KEYS,
  DEFAULT_ABSOLUTE_HOURS,
  DEFAULT_IDLE_HOURS,
  staffSessionPolicy,
  normalizeTwofaRoles,
  twofaRequiredRoles,
  roleRequiresTwofa,
  validateStaffPolicyBody,
};
