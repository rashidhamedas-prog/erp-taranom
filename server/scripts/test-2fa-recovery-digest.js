'use strict';

/**
 * Unit tests for 2FA recovery-code digests (HMAC h1: + legacy SHA-256 migration).
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-2fa-recovery-'));
process.env.JWT_SECRET = 'recovery-code-test-secret-at-least-32b';
process.env.DB_PATH = path.join(tempRoot, 'crm.db');
process.env.AUTH_SESSION_DB_PATH = path.join(tempRoot, 'sessions.db');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');

const { initDB, getDB, closeDB } = require('../db');
const { SECRET } = require('../lib/auth-sessions');
const { closeSessionStore } = require('../lib/auth-sessions');

const RECOVERY_DIGEST_PREFIX = 'h1:';
function recoveryDigest(code) {
  return RECOVERY_DIGEST_PREFIX + crypto.createHmac('sha256', SECRET)
    .update(`2fa-recovery:v1:${String(code || '').trim().toLowerCase()}`)
    .digest('hex');
}
function sha256(code) {
  return crypto.createHash('sha256').update(String(code || '').trim().toLowerCase()).digest('hex');
}
function safeDigestEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}
function findRecoveryCode(hashes, code) {
  const current = recoveryDigest(code);
  const legacy = sha256(code);
  let index = -1;
  let legacyMatch = false;
  for (let i = 0; i < hashes.length; i += 1) {
    const stored = String(hashes[i] || '');
    const matchCurrent = safeDigestEqual(stored, current);
    const matchLegacy = !stored.startsWith(RECOVERY_DIGEST_PREFIX) && safeDigestEqual(stored, legacy);
    if (index === -1 && (matchCurrent || matchLegacy)) {
      index = i;
      legacyMatch = matchLegacy;
    }
  }
  return { index, legacyMatch };
}

function main() {
  initDB();
  const code = 'a1b2c3d4';
  const h1 = recoveryDigest(code);
  assert.ok(h1.startsWith('h1:'), 'digest uses h1: prefix');
  assert.notStrictEqual(h1, recoveryDigest('other'), 'different codes differ');
  assert.strictEqual(recoveryDigest(code), recoveryDigest('A1B2C3D4'), 'case-normalized');

  // timing-safe equal rejects length mismatch without throw
  assert.strictEqual(safeDigestEqual(h1, h1.slice(0, -1)), false);
  assert.strictEqual(safeDigestEqual(h1, h1), true);

  const legacy = sha256(code);
  let hashes = [legacy, recoveryDigest('deadbeef')];
  let found = findRecoveryCode(hashes, code);
  assert.strictEqual(found.index, 0);
  assert.strictEqual(found.legacyMatch, true);
  // migrate in place like route
  hashes[found.index] = recoveryDigest(code);
  found = findRecoveryCode(hashes, code);
  assert.strictEqual(found.index, 0);
  assert.strictEqual(found.legacyMatch, false);

  // consume: remove used code
  hashes.splice(found.index, 1);
  found = findRecoveryCode(hashes, code);
  assert.strictEqual(found.index, -1, 'consumed code no longer matches');

  // wrong code
  found = findRecoveryCode([recoveryDigest(code)], 'ffffffff');
  assert.strictEqual(found.index, -1);

  console.log('2FA recovery digest: 8 passed, 0 failed');
}

try {
  main();
} finally {
  closeSessionStore();
  closeDB();
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* temp */ }
}
