'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
  generateReplaySigningKeyPair,
  signReplayEnvelope,
  verifyReplayEnvelope,
  normalizeReplayPublicKey,
  sha256Buffer,
} = require('../sync/device-auth');

let passed = 0;
function ok(condition, label) {
  assert.ok(condition, label);
  passed += 1;
  console.log('  PASS', label);
}

const keys = generateReplaySigningKeyPair();
const file = Buffer.from('signed-file-content');
const envelope = {
  deviceId: 12,
  seq: 41,
  method: 'POST',
  path: '/api/reps/payments',
  userId: 7,
  body: { amount: 125000, nested: { b: 2, a: 1 } },
  fileHash: sha256Buffer(file),
  fileField: 'receipt',
};
const proof = signReplayEnvelope(keys.privateKey, envelope);

ok(verifyReplayEnvelope(keys.publicKey, proof, envelope), 'valid captured replay envelope verifies');
ok(verifyReplayEnvelope(keys.publicKey, proof, {
  ...envelope,
  body: { nested: { a: 1, b: 2 }, amount: 125000 },
}), 'canonical JSON key order is stable');
ok(!verifyReplayEnvelope(keys.publicKey, proof, { ...envelope, userId: 1 }),
  'changing acting user to admin invalidates proof');
ok(!verifyReplayEnvelope(keys.publicKey, proof, { ...envelope, path: '/api/admin/users' }),
  'changing replay path invalidates proof');
ok(!verifyReplayEnvelope(keys.publicKey, proof, { ...envelope, body: { amount: 1 } }),
  'changing request body invalidates proof');
ok(!verifyReplayEnvelope(keys.publicKey, proof, { ...envelope, fileHash: sha256Buffer(Buffer.from('tampered')) }),
  'changing file bytes invalidates proof');
ok(!verifyReplayEnvelope(keys.publicKey, proof, { ...envelope, fileField: 'file' }),
  'changing multipart field invalidates proof');

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
assert.throws(() => normalizeReplayPublicKey(rsa.publicKey.export({ type: 'spki', format: 'pem' })), /Ed25519/);
passed += 1;
console.log('  PASS non-Ed25519 pairing key is rejected');

console.log(`Sync replay attestation: ${passed} passed, 0 failed`);
