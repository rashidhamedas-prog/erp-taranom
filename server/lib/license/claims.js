'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOCK_ROLLBACK_TOLERANCE_MS = DAY_MS; // reject if now < last_seen - 1 day

const SETTINGS_PUBLIC_KEY = 'license_public_key';
const SETTINGS_LAST_SEEN = 'license_last_seen_at';

function asInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function asIso(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Normalize & validate license claim fields.
 * Required: customer, edition, expiry, license_uid (or id).
 */
function normalizeClaims(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('ادعاهای لایسنس نامعتبر است');
  }
  const license_uid = String(raw.license_uid || raw.id || '').trim();
  const customer = String(raw.customer || '').trim();
  const edition = String(raw.edition || '').trim();
  const expiry = asIso(raw.expiry);
  if (!license_uid) throw new Error('شناسه لایسنس (license_uid) الزامی است');
  if (!customer) throw new Error('نام مشتری لایسنس الزامی است');
  if (!edition) throw new Error('نسخه (edition) لایسنس الزامی است');
  if (!expiry) throw new Error('تاریخ انقضای لایسنس نامعتبر است');

  let feature_flags = raw.feature_flags;
  if (typeof feature_flags === 'string') {
    try { feature_flags = JSON.parse(feature_flags); } catch { feature_flags = {}; }
  }
  if (!feature_flags || typeof feature_flags !== 'object' || Array.isArray(feature_flags)) {
    feature_flags = {};
  }

  return {
    v: asInt(raw.v, 1),
    license_uid,
    customer,
    edition,
    max_users: Math.max(0, asInt(raw.max_users, 0)),
    max_devices: Math.max(0, asInt(raw.max_devices, 0)),
    expiry,
    grace_days: Math.max(0, asInt(raw.grace_days, 14)),
    feature_flags,
    issued_at: asIso(raw.issued_at) || null,
  };
}

/**
 * Evaluate entitlement state at `now`.
 * Modes: none | valid | grace | readonly
 * After expiry+grace → readonly (never wipe data).
 */
function evaluateLicenseState(claims, now = new Date()) {
  if (!claims) {
    return { mode: 'none', readonly: false, reason: 'no_license' };
  }
  const expiryMs = new Date(claims.expiry).getTime();
  const graceDays = Math.max(0, asInt(claims.grace_days, 14));
  const graceEndMs = expiryMs + graceDays * DAY_MS;
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();

  if (t <= expiryMs) {
    return {
      mode: 'valid',
      readonly: false,
      reason: 'active',
      expiry: claims.expiry,
      grace_ends_at: new Date(graceEndMs).toISOString(),
      days_remaining: Math.ceil((expiryMs - t) / DAY_MS),
    };
  }
  if (t <= graceEndMs) {
    return {
      mode: 'grace',
      readonly: false,
      reason: 'grace_period',
      expiry: claims.expiry,
      grace_ends_at: new Date(graceEndMs).toISOString(),
      days_in_grace: Math.ceil((t - expiryMs) / DAY_MS),
    };
  }
  return {
    mode: 'readonly',
    readonly: true,
    reason: 'expired_past_grace',
    expiry: claims.expiry,
    grace_ends_at: new Date(graceEndMs).toISOString(),
  };
}

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? String(row.value || '') : '';
}

function setSetting(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value ?? ''));
}

function getPublicKey(db) {
  return getSetting(db, SETTINGS_PUBLIC_KEY);
}

function setPublicKey(db, pemOrB64) {
  setSetting(db, SETTINGS_PUBLIC_KEY, pemOrB64 || '');
}

/**
 * Simple clock-rollback guard: reject if system time < last_seen_at - 1 day.
 * @returns {{ ok: true } | { ok: false, error: string, code: string }}
 */
function checkClockRollback(db, now = new Date()) {
  const last = getSetting(db, SETTINGS_LAST_SEEN);
  if (!last) return { ok: true };
  const lastMs = new Date(last).getTime();
  if (Number.isNaN(lastMs)) return { ok: true };
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (t < lastMs - CLOCK_ROLLBACK_TOLERANCE_MS) {
    return {
      ok: false,
      error: 'ساعت سیستم نسبت به آخرین مشاهده عقب‌گرد مشکوک دارد',
      code: 'clock_rollback',
      last_seen_at: last,
    };
  }
  return { ok: true };
}

/** Advance last_seen watermark (monotonic). */
function touchLastSeen(db, now = new Date()) {
  const iso = (now instanceof Date ? now : new Date(now)).toISOString();
  const last = getSetting(db, SETTINGS_LAST_SEEN);
  if (!last || new Date(iso).getTime() >= new Date(last).getTime()) {
    setSetting(db, SETTINGS_LAST_SEEN, iso);
  }
}

function getActiveLicenseRow(db) {
  return db.prepare(`
    SELECT * FROM licenses
    WHERE status='active'
    ORDER BY id DESC
    LIMIT 1
  `).get() || null;
}

function rowToClaims(row) {
  if (!row) return null;
  let feature_flags = {};
  try { feature_flags = JSON.parse(row.feature_flags || '{}'); } catch { feature_flags = {}; }
  return {
    v: 1,
    license_uid: row.license_uid,
    customer: row.customer,
    edition: row.edition,
    max_users: row.max_users,
    max_devices: row.max_devices,
    expiry: row.expiry,
    grace_days: row.grace_days,
    feature_flags,
  };
}

function getLicenseStatus(db, now = new Date()) {
  const clock = checkClockRollback(db, now);
  const row = getActiveLicenseRow(db);
  if (!row) {
    return {
      active: false,
      mode: 'none',
      readonly: false,
      clock_ok: clock.ok,
      clock_error: clock.ok ? null : clock.error,
      license: null,
    };
  }
  const claims = rowToClaims(row);
  const state = evaluateLicenseState(claims, now);
  // Clock rollback forces safe read-only (never delete data).
  const readonly = state.readonly || !clock.ok;
  return {
    active: true,
    mode: clock.ok ? state.mode : 'readonly',
    readonly,
    reason: clock.ok ? state.reason : 'clock_rollback',
    clock_ok: clock.ok,
    clock_error: clock.ok ? null : clock.error,
    license: {
      id: row.id,
      license_uid: row.license_uid,
      customer: row.customer,
      edition: row.edition,
      max_users: row.max_users,
      max_devices: row.max_devices,
      expiry: row.expiry,
      grace_days: row.grace_days,
      feature_flags: claims.feature_flags,
      status: row.status,
      activated_at: row.activated_at,
      grace_ends_at: state.grace_ends_at || null,
    },
  };
}

module.exports = {
  DAY_MS,
  CLOCK_ROLLBACK_TOLERANCE_MS,
  SETTINGS_PUBLIC_KEY,
  SETTINGS_LAST_SEEN,
  normalizeClaims,
  evaluateLicenseState,
  getPublicKey,
  setPublicKey,
  checkClockRollback,
  touchLastSeen,
  getActiveLicenseRow,
  rowToClaims,
  getLicenseStatus,
};
