const crypto = require('crypto');

const ENVELOPE_PREFIX = 'enc:v1:';
const SECRET_CONTEXT = Buffer.from('erp-taranom/sync-local-kv/v1', 'utf8');

function encryptionKey() {
  const source = process.env.SYNC_LOCAL_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!source || Buffer.byteLength(source, 'utf8') < 32) {
    const error = new Error('Secure local storage requires a secret of at least 32 bytes');
    error.code = 'E_LOCAL_SECRET_KEY_REQUIRED';
    throw error;
  }
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(source, 'utf8'), Buffer.alloc(0), SECRET_CONTEXT, 32));
}

function encryptValue(value) {
  if (value === null || value === undefined) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(SECRET_CONTEXT);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENVELOPE_PREFIX.slice(0, -1), iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
}

function decryptValue(envelope) {
  if (envelope === null || envelope === undefined) return null;
  const value = String(envelope);
  if (!value.startsWith(ENVELOPE_PREFIX)) {
    const error = new Error('Local secret is not encrypted');
    error.code = 'E_LOCAL_SECRET_PLAINTEXT';
    throw error;
  }
  const parts = value.split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    const error = new Error('Invalid local secret envelope');
    error.code = 'E_LOCAL_SECRET_FORMAT';
    throw error;
  }
  const key = encryptionKey();
  try {
    const iv = Buffer.from(parts[2], 'base64url');
    const tag = Buffer.from(parts[3], 'base64url');
    const ciphertext = Buffer.from(parts[4], 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error('bad envelope');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(SECRET_CONTEXT);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    const error = new Error('Local secret authentication failed');
    error.code = 'E_LOCAL_SECRET_TAMPERED';
    throw error;
  }
}

function rawGet(db, key) {
  const row = db.prepare('SELECT value FROM sync_local_kv WHERE key=?').get(key);
  return row ? row.value : null;
}

function rawSet(db, key, value) {
  db.prepare('INSERT INTO sync_local_kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
}

function setSecret(db, key, value) {
  if (value === null || value === undefined || value === '') {
    db.prepare('DELETE FROM sync_local_kv WHERE key=?').run(key);
    return;
  }
  rawSet(db, key, encryptValue(value));
}

function getSecret(db, key) {
  const stored = rawGet(db, key);
  if (stored === null) return null;
  if (String(stored).startsWith(ENVELOPE_PREFIX)) return decryptValue(stored);

  // One-time migration for devices paired before encrypted storage shipped.
  // The plaintext value is replaced in the same SQLite transaction before use.
  const migrate = db.transaction(() => {
    rawSet(db, key, encryptValue(stored));
    return stored;
  });
  return migrate();
}

module.exports = {
  ENVELOPE_PREFIX,
  encryptValue,
  decryptValue,
  getSecret,
  setSecret
};
