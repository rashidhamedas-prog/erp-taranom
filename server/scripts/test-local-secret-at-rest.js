const assert = require('assert');
const Database = require('better-sqlite3');
const { ENVELOPE_PREFIX, getSecret, setSecret } = require('../sync/secure-kv');

process.env.JWT_SECRET = 'wave0-local-secret-test-key-32-bytes-minimum';

const db = new Database(':memory:');
db.exec('CREATE TABLE sync_local_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

const token = 'device-token-that-must-never-be-plaintext';
setSecret(db, 'device_token', token);
const encrypted = db.prepare('SELECT value FROM sync_local_kv WHERE key=?').pluck().get('device_token');
assert.ok(encrypted.startsWith(ENVELOPE_PREFIX), 'stored value must use the versioned envelope');
assert.ok(!encrypted.includes(token), 'stored value must not contain plaintext');
assert.strictEqual(getSecret(db, 'device_token'), token, 'encrypted value must round-trip');

const parts = encrypted.split(':');
parts[4] = `${parts[4].slice(0, -1)}${parts[4].endsWith('A') ? 'B' : 'A'}`;
db.prepare('UPDATE sync_local_kv SET value=? WHERE key=?').run(parts.join(':'), 'device_token');
assert.throws(
  () => getSecret(db, 'device_token'),
  error => error && error.code === 'E_LOCAL_SECRET_TAMPERED',
  'tampered ciphertext must fail closed'
);

db.prepare('UPDATE sync_local_kv SET value=? WHERE key=?').run(token, 'device_token');
assert.strictEqual(getSecret(db, 'device_token'), token, 'legacy plaintext must migrate once');
const migrated = db.prepare('SELECT value FROM sync_local_kv WHERE key=?').pluck().get('device_token');
assert.ok(migrated.startsWith(ENVELOPE_PREFIX), 'legacy plaintext must be replaced');
assert.ok(!migrated.includes(token), 'migration must remove plaintext');

delete process.env.JWT_SECRET;
assert.throws(
  () => setSecret(db, 'another_secret', 'value'),
  error => error && error.code === 'E_LOCAL_SECRET_KEY_REQUIRED',
  'missing encryption key must fail closed'
);
assert.throws(
  () => getSecret(db, 'device_token'),
  error => error && error.code === 'E_LOCAL_SECRET_KEY_REQUIRED',
  'missing decryption key must fail closed without misreporting tampering'
);

db.close();
console.log('OK local secret at rest: encrypted, migrated, tamper-safe, fail-closed');
