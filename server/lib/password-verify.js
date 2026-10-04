'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { argon2id, argon2Verify } = require('hash-wasm');

// OWASP Argon2id baseline: 19 MiB, 2 iterations, parallelism 1.
const ARGON_OPTS = { parallelism: 1, iterations: 2, memorySize: 19456, hashLength: 32 };

// Same dummy-hash pattern as login: always run bcrypt so timing does not
// leak whether the user row or hash exists.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);

function normalizePlain(plain) {
  return String(plain == null ? '' : plain).slice(0, 128);
}

function normalizeHash(hash) {
  if (hash == null) return '';
  if (Buffer.isBuffer(hash)) return hash.toString('utf8').replace(/^\uFEFF/, '').trim();
  return String(hash).replace(/^\uFEFF/, '').trim();
}

function needsRehash(hash) {
  return normalizeHash(hash).startsWith('$2');
}

async function hashPassword(plain) {
  return argon2id({
    password: normalizePlain(plain),
    salt: crypto.randomBytes(16),
    ...ARGON_OPTS,
    outputType: 'encoded',
  });
}

async function verifyPassword(plain, hash) {
  const p = normalizePlain(plain);
  const h = normalizeHash(hash);
  if (h.startsWith('$argon2')) {
    try { return await argon2Verify({ password: p, hash: h }); }
    catch { return false; }
  }
  if (h.startsWith('$2')) {
    try { return bcrypt.compareSync(p, h); }
    catch { return false; }
  }
  try { bcrypt.compareSync(p, DUMMY_HASH); } catch { /* keep timing close for garbage hashes */ }
  return false;
}

function passwordsMatch(plain, hash) {
  const p = normalizePlain(plain);
  const h = normalizeHash(hash);
  if (!h.startsWith('$2')) {
    bcrypt.compareSync(p, DUMMY_HASH);
    return false;
  }
  try {
    return bcrypt.compareSync(p, h);
  } catch {
    bcrypt.compareSync(p, DUMMY_HASH);
    return false;
  }
}

function pickConfirmPassword(body) {
  if (!body || typeof body !== 'object') return '';
  if (body.confirm_password != null && body.confirm_password !== '') return body.confirm_password;
  if (body.password != null && body.password !== '') return body.password;
  if (body.confirmPassword != null && body.confirmPassword !== '') return body.confirmPassword;
  return '';
}

async function requireUserPassword(db, userId, plain) {
  const user = db.prepare('SELECT id, password FROM users WHERE id=?').get(Number(userId));
  const ok = !!(user && await verifyPassword(plain, user.password));
  if (!ok) {
    const err = new Error('رمز عبور نادرست است');
    err.status = 403;
    err.code = 'E_PASSWORD';
    throw err;
  }
  return true;
}

module.exports = {
  DUMMY_HASH,
  normalizePlain,
  normalizeHash,
  passwordsMatch,
  needsRehash,
  hashPassword,
  verifyPassword,
  pickConfirmPassword,
  requireUserPassword,
};
