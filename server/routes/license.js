'use strict';

const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly, centralOnly } = require('../middleware/auth');
const { verifyLicenseDocument } = require('../lib/license/verify');
const {
  normalizeClaims,
  evaluateLicenseState,
  getPublicKey,
  setPublicKey,
  getActiveLicenseRow,
  getLicenseStatus,
  touchLastSeen,
  checkClockRollback,
} = require('../lib/license/claims');

function parseLicenseBody(body) {
  if (!body) throw new Error('بدنه درخواست خالی است');
  if (body.license != null) {
    return typeof body.license === 'string' ? JSON.parse(body.license) : body.license;
  }
  if (body.license_json != null) {
    return typeof body.license_json === 'string'
      ? JSON.parse(body.license_json)
      : body.license_json;
  }
  // Allow posting the document itself at the top level.
  if (body.signature && (body.license_uid || body.customer)) return body;
  throw new Error('فیلد license یا license_json الزامی است');
}

/** GET /api/license/status — current entitlement (admin). */
router.get('/status', auth, adminOnly, (req, res) => {
  const db = getDB();
  const status = getLicenseStatus(db, new Date());
  const activeCount = status.license
    ? db.prepare(`
        SELECT COUNT(*) AS c FROM license_activations
        WHERE license_id=? AND deactivated_at IS NULL
      `).get(status.license.id)?.c || 0
    : 0;
  res.json({
    ...status,
    activations_active: activeCount,
    public_key_configured: !!getPublicKey(db),
  });
});

/**
 * POST /api/license/activate
 * Body: { license|license_json, device_fingerprint?, public_key? }
 * Verifies Ed25519 signature offline; stores license + optional device activation.
 */
router.post('/activate', auth, adminOnly, centralOnly, (req, res) => {
  const db = getDB();
  const clock = checkClockRollback(db, new Date());
  if (!clock.ok) {
    return res.status(403).json({
      error: clock.error,
      code: 'clock_rollback',
      last_seen_at: clock.last_seen_at,
    });
  }

  let doc;
  try {
    doc = parseLicenseBody(req.body || {});
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  if (req.body?.public_key) {
    setPublicKey(db, String(req.body.public_key));
  }
  const pub = getPublicKey(db);
  if (!pub) {
    return res.status(400).json({
      error: 'کلید عمومی لایسنس تنظیم نشده است (public_key در فعال‌سازی یا تنظیمات)',
      code: 'missing_public_key',
    });
  }

  const verified = verifyLicenseDocument(doc, pub);
  if (!verified.ok) {
    return res.status(400).json({ error: verified.error, code: 'invalid_signature' });
  }

  let claims;
  try {
    claims = normalizeClaims(verified.claims);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const fingerprint = String(req.body?.device_fingerprint || 'central').trim() || 'central';
  const nowIso = new Date().toISOString();
  const payloadJson = JSON.stringify(verified.claims);
  const signature = String(doc.signature);

  try {
    const result = db.transaction(() => {
      // Soft-deactivate any other active license (one active at a time).
      db.prepare(`
        UPDATE licenses SET status='deactivated', deactivated_at=?
        WHERE status='active' AND license_uid!=?
      `).run(nowIso, claims.license_uid);

      const existing = db.prepare('SELECT * FROM licenses WHERE license_uid=?').get(claims.license_uid);
      let licenseId;
      if (existing) {
        db.prepare(`
          UPDATE licenses SET
            customer=?, edition=?, max_users=?, max_devices=?, expiry=?, grace_days=?,
            feature_flags=?, payload_json=?, signature=?, status='active',
            activated_at=?, deactivated_at=NULL
          WHERE id=?
        `).run(
          claims.customer,
          claims.edition,
          claims.max_users,
          claims.max_devices,
          claims.expiry,
          claims.grace_days,
          JSON.stringify(claims.feature_flags),
          payloadJson,
          signature,
          existing.activated_at || nowIso,
          existing.id
        );
        licenseId = existing.id;
      } else {
        const info = db.prepare(`
          INSERT INTO licenses (
            license_uid, customer, edition, max_users, max_devices, expiry, grace_days,
            feature_flags, payload_json, signature, status, activated_at, created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?, 'active', ?, ?)
        `).run(
          claims.license_uid,
          claims.customer,
          claims.edition,
          claims.max_users,
          claims.max_devices,
          claims.expiry,
          claims.grace_days,
          JSON.stringify(claims.feature_flags),
          payloadJson,
          signature,
          nowIso,
          nowIso
        );
        licenseId = info.lastInsertRowid;
      }

      const openAct = db.prepare(`
        SELECT id FROM license_activations
        WHERE license_id=? AND device_fingerprint=? AND deactivated_at IS NULL
      `).get(licenseId, fingerprint);

      if (!openAct) {
        const activeDevices = db.prepare(`
          SELECT COUNT(*) AS c FROM license_activations
          WHERE license_id=? AND deactivated_at IS NULL
        `).get(licenseId)?.c || 0;
        if (claims.max_devices > 0 && activeDevices >= claims.max_devices) {
          const err = new Error(`سقف دستگاه‌های لایسنس (${claims.max_devices}) پر است`);
          err.code = 'max_devices';
          throw err;
        }
        db.prepare(`
          INSERT INTO license_activations (license_id, device_fingerprint, activated_at)
          VALUES (?,?,?)
        `).run(licenseId, fingerprint, nowIso);
      }

      return licenseId;
    })();

    touchLastSeen(db, new Date());
    try {
      audit(req.user.id, 'activate', 'license', result, `license_uid=${claims.license_uid}`);
    } catch { /* audit optional in tests */ }

    const state = evaluateLicenseState(claims, new Date());
    return res.json({
      ok: true,
      license_id: result,
      license_uid: claims.license_uid,
      mode: state.mode,
      readonly: state.readonly,
      customer: claims.customer,
      edition: claims.edition,
      expiry: claims.expiry,
      grace_days: claims.grace_days,
      max_users: claims.max_users,
      max_devices: claims.max_devices,
      feature_flags: claims.feature_flags,
      device_fingerprint: fingerprint,
    });
  } catch (e) {
    const status = e.code === 'max_devices' ? 409 : 400;
    return res.status(status).json({ error: e.message, code: e.code || 'activate_failed' });
  }
});

/**
 * POST /api/license/deactivate
 * Soft-deactivate active license + open activations. Never deletes rows/data.
 */
router.post('/deactivate', auth, adminOnly, centralOnly, (req, res) => {
  const db = getDB();
  const row = getActiveLicenseRow(db);
  if (!row) {
    return res.status(404).json({ error: 'لایسنس فعالی وجود ندارد', code: 'no_active_license' });
  }
  const nowIso = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`
      UPDATE licenses SET status='deactivated', deactivated_at=? WHERE id=?
    `).run(nowIso, row.id);
    db.prepare(`
      UPDATE license_activations SET deactivated_at=?
      WHERE license_id=? AND deactivated_at IS NULL
    `).run(nowIso, row.id);
  })();
  touchLastSeen(db, new Date());
  try {
    audit(req.user.id, 'deactivate', 'license', row.id, `license_uid=${row.license_uid}`);
  } catch { /* optional */ }
  res.json({
    ok: true,
    license_id: row.id,
    license_uid: row.license_uid,
    deactivated_at: nowIso,
  });
});

module.exports = router;
