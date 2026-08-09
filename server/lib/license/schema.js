'use strict';

/**
 * License & entitlement schema (P1-M1 / W2-M1).
 * Central-only tables — do NOT append to SYNCABLE_TABLES.
 */
function initLicenseSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS licenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      license_uid TEXT NOT NULL UNIQUE,
      customer TEXT NOT NULL,
      edition TEXT NOT NULL,
      max_users INTEGER NOT NULL DEFAULT 0,
      max_devices INTEGER NOT NULL DEFAULT 0,
      expiry TEXT NOT NULL,
      grace_days INTEGER NOT NULL DEFAULT 14,
      feature_flags TEXT NOT NULL DEFAULT '{}',
      payload_json TEXT NOT NULL,
      signature TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      activated_at TEXT,
      deactivated_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS license_activations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      license_id INTEGER NOT NULL,
      device_fingerprint TEXT NOT NULL,
      activated_at TEXT NOT NULL,
      deactivated_at TEXT,
      FOREIGN KEY(license_id) REFERENCES licenses(id)
    );

    CREATE INDEX IF NOT EXISTS idx_license_activations_license
      ON license_activations(license_id);
    CREATE INDEX IF NOT EXISTS idx_licenses_status
      ON licenses(status);
  `);

  // Public verify key + clock-rollback watermark (no secrets).
  const defaults = [
    ['license_public_key', ''],
    ['license_last_seen_at', ''],
  ];
  const ins = db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)"
  );
  for (const [k, v] of defaults) ins.run(k, v);
}

module.exports = { initLicenseSchema };
