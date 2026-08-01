'use strict';

const crypto = require('crypto');
const { getJwtSecret } = require('../lib/security');

const ENVELOPE_PREFIX = 'enc:v2:';
const LEGACY_ENVELOPE_RE = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]*$/i;
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

function configError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function decodeExplicitKey(rawValue) {
  const raw = String(rawValue || '');
  let key;

  if (raw.startsWith('base64:')) {
    const encoded = raw.slice(7);
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw configError('DATA_ENCRYPTION_KEY base64 encoding is invalid', 'E_DATA_KEY_INVALID');
    }
    key = Buffer.from(encoded, 'base64');
  } else if (raw.startsWith('hex:')) {
    const encoded = raw.slice(4);
    if (!/^[0-9a-f]{64}$/i.test(encoded)) {
      throw configError('DATA_ENCRYPTION_KEY hex encoding must contain 64 hex characters', 'E_DATA_KEY_INVALID');
    }
    key = Buffer.from(encoded, 'hex');
  } else if (/^[0-9a-f]{64}$/i.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    if (Buffer.byteLength(raw, 'utf8') < 32) {
      throw configError('DATA_ENCRYPTION_KEY must contain at least 32 bytes', 'E_DATA_KEY_WEAK');
    }
    // A long operator-provided value is domain-separated into an AES key.
    key = crypto.createHash('sha256').update('erp-taranom:data-key:v2\0').update(raw, 'utf8').digest();
  }

  if (key.length !== 32) {
    throw configError('DATA_ENCRYPTION_KEY must decode to exactly 32 bytes', 'E_DATA_KEY_INVALID');
  }
  return key;
}

function getDataEncryptionKey() {
  const configured = String(process.env.DATA_ENCRYPTION_KEY || '');
  if (configured) return decodeExplicitKey(configured);

  if (process.env.NODE_ENV === 'production') {
    throw configError('DATA_ENCRYPTION_KEY is required in production', 'E_DATA_KEY_REQUIRED');
  }

  // Test/development compatibility only. Production must never couple data
  // encryption to token signing. Keeping the historical derivation here lets
  // local databases migrate without a destructive reset.
  return crypto.createHash('sha256')
    .update(getJwtSecret() + ':secrets-at-rest')
    .digest();
}

function getLegacyKey() {
  return crypto.createHash('sha256')
    .update(getJwtSecret() + ':secrets-at-rest')
    .digest();
}

function keyId(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function purposeAad(purpose) {
  const value = String(purpose || 'generic');
  if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(value)) {
    throw configError('Invalid encryption purpose', 'E_SECRET_PURPOSE_INVALID');
  }
  return Buffer.from(`erp-taranom|v2|${value}`, 'utf8');
}

function encrypt(plain, purpose = 'generic') {
  const key = getDataEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(purposeAad(purpose));
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'enc',
    'v2',
    keyId(key),
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}

function decodeBase64Url(value, expectedLength, label) {
  if (!BASE64URL_RE.test(value)) {
    throw configError(`Encrypted secret ${label} is malformed`, 'E_SECRET_FORMAT');
  }
  const out = Buffer.from(value, 'base64url');
  if (expectedLength != null && out.length !== expectedLength) {
    throw configError(`Encrypted secret ${label} has an invalid length`, 'E_SECRET_FORMAT');
  }
  return out;
}

function decryptV2(payload, purpose) {
  const parts = String(payload).split(':');
  if (parts.length !== 6 || parts[0] !== 'enc' || parts[1] !== 'v2' || !/^[0-9a-f]{16}$/i.test(parts[2])) {
    throw configError('Encrypted secret envelope is malformed', 'E_SECRET_FORMAT');
  }

  const key = getDataEncryptionKey();
  if (!crypto.timingSafeEqual(Buffer.from(parts[2], 'hex'), Buffer.from(keyId(key), 'hex'))) {
    throw configError('Encrypted secret cannot be opened with the configured key', 'E_SECRET_KEY_MISMATCH');
  }

  try {
    const iv = decodeBase64Url(parts[3], 12, 'nonce');
    const tag = decodeBase64Url(parts[4], 16, 'tag');
    const encrypted = decodeBase64Url(parts[5], null, 'ciphertext');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(purposeAad(purpose));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error && (error.code === 'E_SECRET_FORMAT' || error.code === 'E_SECRET_PURPOSE_INVALID')) throw error;
    throw configError('Encrypted secret authentication failed', 'E_SECRET_DECRYPT_FAILED');
  }
}

function decryptLegacy(payload) {
  if (!LEGACY_ENVELOPE_RE.test(String(payload))) {
    throw configError('Legacy encrypted secret envelope is malformed', 'E_SECRET_FORMAT');
  }
  const [ivHex, tagHex, dataHex] = String(payload).split(':');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', getLegacyKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw configError('Legacy encrypted secret authentication failed', 'E_SECRET_DECRYPT_FAILED');
  }
}

function decryptDetailed(payload, purpose = 'generic') {
  const value = String(payload || '');
  if (value.startsWith(ENVELOPE_PREFIX)) {
    return { plaintext: decryptV2(value, purpose), version: 2, needsMigration: false };
  }
  if (LEGACY_ENVELOPE_RE.test(value)) {
    return { plaintext: decryptLegacy(value), version: 1, needsMigration: true };
  }
  throw configError('Encrypted secret envelope is not recognized', 'E_SECRET_FORMAT');
}

function decrypt(payload, purpose = 'generic') {
  return decryptDetailed(payload, purpose).plaintext;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function assertDataEncryptionConfig() {
  getDataEncryptionKey();
  return true;
}

// A production process importing the crypto service must fail during boot,
// before it can accept requests or write secrets using an implicit key.
if (process.env.NODE_ENV === 'production') assertDataEncryptionConfig();

module.exports = {
  ENVELOPE_PREFIX,
  LEGACY_ENVELOPE_RE,
  encrypt,
  decrypt,
  decryptDetailed,
  sha256,
  assertDataEncryptionConfig,
};
