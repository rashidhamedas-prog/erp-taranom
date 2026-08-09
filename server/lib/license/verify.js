'use strict';

const crypto = require('crypto');

/**
 * Deterministic JSON for Ed25519 signing (sorted object keys, arrays keep order).
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function decodeSignature(sig) {
  const s = String(sig || '').trim();
  if (!s) throw new Error('امضای لایسنس خالی است');
  // Prefer base64url; fall back to standard base64.
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  return Buffer.from(b64 + pad, 'base64');
}

function encodeSignature(buf) {
  return Buffer.from(buf).toString('base64url');
}

/**
 * Accept SPKI PEM or raw 32-byte public key (base64 / base64url).
 */
function loadPublicKey(publicKeyMaterial) {
  const raw = String(publicKeyMaterial || '').trim();
  if (!raw) throw new Error('کلید عمومی لایسنس تنظیم نشده است');
  if (raw.includes('BEGIN PUBLIC KEY')) {
    return crypto.createPublicKey(raw);
  }
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const derOrRaw = Buffer.from(b64 + pad, 'base64');
  if (derOrRaw.length === 32) {
    // Raw Ed25519 public key → SPKI DER wrapper
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    return crypto.createPublicKey({
      key: Buffer.concat([spkiPrefix, derOrRaw]),
      format: 'der',
      type: 'spki',
    });
  }
  return crypto.createPublicKey({ key: derOrRaw, format: 'der', type: 'spki' });
}

/**
 * Verify an offline license document.
 * Document shape: { ...claims, signature: base64url }
 * Signature covers canonicalJson of claims without the signature field.
 *
 * @returns {{ ok: true, claims: object, message: Buffer } | { ok: false, error: string }}
 */
function verifyLicenseDocument(doc, publicKeyMaterial) {
  try {
    const parsed = typeof doc === 'string' ? JSON.parse(doc) : { ...doc };
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, error: 'قالب لایسنس نامعتبر است' };
    }
    const signature = parsed.signature;
    if (!signature) return { ok: false, error: 'امضای لایسنس موجود نیست' };
    const claims = { ...parsed };
    delete claims.signature;
    const message = Buffer.from(canonicalJson(claims), 'utf8');
    const key = loadPublicKey(publicKeyMaterial);
    const sigBuf = decodeSignature(signature);
    const valid = crypto.verify(null, message, key, sigBuf);
    if (!valid) return { ok: false, error: 'امضای لایسنس نامعتبر است' };
    return { ok: true, claims, message };
  } catch (e) {
    return { ok: false, error: e.message || 'خطا در تأیید لایسنس' };
  }
}

/**
 * Test/helper only — never ship a private signing key in the repo.
 * Signs claims and returns a full license document with signature.
 */
function signLicenseDocument(claims, privateKeyPemOrKeyObject) {
  const payload = { ...claims };
  delete payload.signature;
  const message = Buffer.from(canonicalJson(payload), 'utf8');
  const key =
    typeof privateKeyPemOrKeyObject === 'string' || Buffer.isBuffer(privateKeyPemOrKeyObject)
      ? crypto.createPrivateKey(privateKeyPemOrKeyObject)
      : privateKeyPemOrKeyObject;
  const sig = crypto.sign(null, message, key);
  return { ...payload, signature: encodeSignature(sig) };
}

module.exports = {
  canonicalJson,
  loadPublicKey,
  verifyLicenseDocument,
  signLicenseDocument,
  encodeSignature,
};
