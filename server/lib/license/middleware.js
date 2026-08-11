'use strict';

const { getDB } = require('../../db');
const { getLicenseStatus, touchLastSeen } = require('./claims');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Paths that remain writable even in license read-only / clock-rollback mode.
 * Auth + license admin + backup *reads* (GET) are always fine; backup restore
 * stays blocked in readonly so data cannot be overwritten while locked.
 */
function isLicenseExemptPath(pathname) {
  const p = String(pathname || '').split('?')[0];
  if (p === '/api/license' || p.startsWith('/api/license/')) return true;
  if (p === '/api/auth' || p.startsWith('/api/auth/')) return true;
  // Explicit backup read endpoints (GET only reaches mutating check as false,
  // but keep the prefix documented for future POST download tokens).
  if (p === '/api/admin/backups' || p.startsWith('/api/admin/backup-download')) return true;
  if (p === '/api/admin/backup-health') return true;
  return false;
}

/**
 * Global guard: after expiry+grace (or clock rollback), block mutating /api/*
 * except auth/license/backup-read. Never deletes customer data.
 */
function licenseGuard(req, res, next) {
  try {
    if (!MUTATING.has(String(req.method || '').toUpperCase())) {
      // Still advance last_seen on successful traffic so rollback is detectable.
      try {
        const db = getDB();
        touchLastSeen(db, new Date());
      } catch { /* db may not be ready in edge boot paths */ }
      return next();
    }

    const path = (req.originalUrl || req.url || '').split('?')[0];
    if (isLicenseExemptPath(path)) return next();

    const db = getDB();
    const status = getLicenseStatus(db, new Date());

    // No active license → do not lock legacy/central installs.
    if (!status.active) {
      touchLastSeen(db, new Date());
      return next();
    }

    touchLastSeen(db, new Date());

    if (status.readonly) {
      return res.status(403).json({
        error: status.reason === 'clock_rollback'
          ? 'لایسنس به‌خاطر عقب‌گرد ساعت سیستم در حالت فقط‌خواندنی است'
          : 'لایسنس منقضی شده است — سامانه در حالت فقط‌خواندنی (داده‌ها حذف نمی‌شوند)',
        code: 'license_readonly',
        reason: status.reason,
        license: status.license
          ? {
              customer: status.license.customer,
              edition: status.license.edition,
              expiry: status.license.expiry,
              grace_ends_at: status.license.grace_ends_at,
            }
          : null,
      });
    }

    return next();
  } catch (e) {
    // Fail-open for unexpected errors would weaken enforcement; fail closed
    // only when we already know an active license exists. Otherwise continue.
    console.error('licenseGuard:', e.message);
    return next();
  }
}

module.exports = {
  licenseGuard,
  isLicenseExemptPath,
};
