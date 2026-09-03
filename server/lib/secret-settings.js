'use strict';

const {
  ENVELOPE_PREFIX,
  LEGACY_ENVELOPE_RE,
  encrypt,
  decryptDetailed,
} = require('../services/crypto');

// Only credential material belongs here. Identifiers, sender numbers and URLs
// remain ordinary settings so the UI can display and validate them normally.
const SECRET_SETTING_KEYS = Object.freeze([
  'telegram_bot_token',
  'sms_api_key',
  'niksms_api_key',
  'smsir_api_key',
  'webhook_secret',
  'backup_smtp_pass',
  'backup_password',
  // moadian_private_key_path is a filesystem path (not PEM) — keep plaintext; PEM stays on disk.
  'ai_api_key',
  'website_wc_key',
  'website_wc_secret',
  'website_b2b_token',
  'rubika_bot_token',
]);

const SECRET_SETTING_SET = new Set(SECRET_SETTING_KEYS);
const SECRET_MASK = '********';
const ACCEPTED_MASKS = new Set([
  SECRET_MASK,
  '••••••••',
  '************',
  '[stored]',
]);

function isSecretSetting(key) {
  return SECRET_SETTING_SET.has(String(key));
}

function secretPurpose(key) {
  if (!isSecretSetting(key)) {
    const error = new Error('Setting is not classified as secret');
    error.code = 'E_SETTING_NOT_SECRET';
    throw error;
  }
  return `setting:${key}`;
}

function isMaskValue(value) {
  return ACCEPTED_MASKS.has(String(value || '').trim());
}

function readRawSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(String(key));
  return row ? String(row.value == null ? '' : row.value) : '';
}

function migrateStoredValue(db, key, oldValue, plaintext) {
  const replacement = encrypt(plaintext, secretPurpose(key));
  db.prepare('UPDATE settings SET value=? WHERE key=? AND value=?')
    .run(replacement, key, oldValue);
  return plaintext;
}

function openSecretSettingValue(db, key, storedValue, { migrate = true } = {}) {
  const value = String(storedValue == null ? '' : storedValue);
  if (!value) return '';

  if (value.startsWith(ENVELOPE_PREFIX)) {
    return decryptDetailed(value, secretPurpose(key)).plaintext;
  }

  if (value.startsWith('enc:')) {
    const error = new Error('Stored secret uses an unsupported envelope version');
    error.code = 'E_SECRET_FORMAT';
    throw error;
  }

  if (LEGACY_ENVELOPE_RE.test(value)) {
    const opened = decryptDetailed(value, secretPurpose(key));
    if (migrate && opened.needsMigration) migrateStoredValue(db, key, value, opened.plaintext);
    return opened.plaintext;
  }

  // Historical settings were plaintext. A successful access is the safe point
  // to replace them atomically with authenticated ciphertext.
  if (migrate) migrateStoredValue(db, key, value, value);
  return value;
}

function getSetting(db, key, options) {
  const value = readRawSetting(db, key);
  return isSecretSetting(key) ? openSecretSettingValue(db, String(key), value, options) : value;
}

function selectSettingRows(db, keys) {
  if (!keys) return db.prepare('SELECT key,value FROM settings').all();
  const normalized = [...new Set(keys.map(String))];
  if (!normalized.length) return [];
  return db.prepare(`SELECT key,value FROM settings WHERE key IN (${normalized.map(() => '?').join(',')})`)
    .all(...normalized);
}

function getSettings(db, keys, options) {
  const rows = selectSettingRows(db, keys);
  const out = {};
  if (keys) for (const key of keys) out[key] = '';
  for (const row of rows) {
    out[row.key] = isSecretSetting(row.key)
      ? openSecretSettingValue(db, row.key, row.value, options)
      : String(row.value == null ? '' : row.value);
  }
  return out;
}

function getPublicSettings(db, keys) {
  const rows = selectSettingRows(db, keys);
  const out = {};
  if (keys) for (const key of keys) out[key] = '';

  for (const row of rows) {
    if (!isSecretSetting(row.key)) {
      out[row.key] = String(row.value == null ? '' : row.value);
      continue;
    }

    // Opening validates the authentication tag and performs one-time legacy
    // migration, but the plaintext is deliberately never placed in output.
    const hasValue = openSecretSettingValue(db, row.key, row.value) !== '';
    out[row.key] = hasValue ? SECRET_MASK : '';
    out[`${row.key}_has_value`] = hasValue;
  }

  if (keys) {
    for (const key of keys) {
      if (isSecretSetting(key) && out[`${key}_has_value`] === undefined) {
        out[`${key}_has_value`] = false;
      }
    }
  }
  return out;
}

function prepareSettingWrite(key, input) {
  const normalizedKey = String(key);
  if (!isSecretSetting(normalizedKey)) {
    return { action: 'write', value: input == null ? '' : String(input) };
  }

  // null is the explicit clear operation. Empty strings and masks are common
  // browser form round-trips and must not destroy a credential already stored.
  if (input === null) return { action: 'write', value: '' };
  if (input === undefined) return { action: 'skip' };
  const value = String(input);
  if (!value.trim() || isMaskValue(value)) return { action: 'skip' };
  return { action: 'write', value: encrypt(value, secretPurpose(normalizedKey)) };
}

function updateSettings(db, entries, allowedKeys) {
  const allowed = allowedKeys instanceof Set ? allowedKeys : new Set(allowedKeys || []);
  const stmt = db.prepare(`
    INSERT INTO settings (key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `);
  const writes = [];

  for (const [key, input] of entries || []) {
    if (!allowed.has(key)) continue;
    const prepared = prepareSettingWrite(key, input);
    if (prepared.action === 'write') writes.push([key, prepared.value]);
  }

  db.transaction(() => {
    for (const [key, value] of writes) stmt.run(key, value);
  })();
  return { writtenKeys: writes.map(([key]) => key) };
}

function setSetting(db, key, value) {
  return updateSettings(db, [[key, value]], new Set([key]));
}

function getSmsSettings(db, extraKeys = []) {
  return getSettings(db, [
    'sms_provider',
    'sms_api_key',
    'sms_from',
    'niksms_api_key',
    'smsir_api_key',
    'smsir_line',
    ...extraKeys,
  ]);
}

function getPublicSmsSettings(db, extraKeys = []) {
  return getPublicSettings(db, [
    'sms_provider',
    'sms_api_key',
    'sms_from',
    'niksms_api_key',
    'smsir_api_key',
    'smsir_line',
    ...extraKeys,
  ]);
}

module.exports = {
  SECRET_SETTING_KEYS,
  SECRET_MASK,
  isSecretSetting,
  isMaskValue,
  getSetting,
  getSettings,
  getPublicSettings,
  getSmsSettings,
  getPublicSmsSettings,
  openSecretSettingValue,
  prepareSettingWrite,
  setSetting,
  updateSettings,
};
