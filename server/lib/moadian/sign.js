'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Resolve private-key path under an allowlisted directory.
 * Rejects path traversal / absolute escapes outside the keys root.
 */
function resolveMoadianKeyPath(rawPath) {
  const keyPath = String(rawPath || process.env.MOADIAN_PRIVATE_KEY_PATH || '').trim();
  if (!keyPath) return '';

  const keysRoot = path.resolve(
    process.env.MOADIAN_KEYS_DIR
      || path.join(process.env.PRIVATE_UPLOADS_DIR || process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads'), 'moadian', 'keys')
  );

  const resolved = path.resolve(path.isAbsolute(keyPath) ? keyPath : path.join(keysRoot, keyPath));
  const rootWithSep = keysRoot.endsWith(path.sep) ? keysRoot : keysRoot + path.sep;
  if (resolved !== keysRoot && !resolved.startsWith(rootWithSep)) {
    const err = new Error('مسیر کلید مودیان خارج از پوشه مجاز است');
    err.code = 'MOADIAN_KEY_PATH_REJECTED';
    throw err;
  }
  return resolved;
}

/** Sign-ready helper: returns stub signature when no key; never embeds path/size in client payloads. */
function signPayload(payload, opts = {}) {
  const keyPath = resolveMoadianKeyPath(opts.privateKeyPath);
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (!keyPath) {
    return { algorithm: 'stub', signature: `STUB-${Buffer.from(body).toString('base64url').slice(0, 32)}` };
  }
  if (!fs.existsSync(keyPath)) {
    const err = new Error('فایل کلید خصوصی مودیان یافت نشد');
    err.code = 'MOADIAN_KEY_MISSING';
    throw err;
  }
  // Do not load/parse PKCS here in MVP — mark ready for live adapter.
  fs.statSync(keyPath);
  return {
    algorithm: 'rsa-sha256-pending',
    signature: `PENDING-${Buffer.from(body).toString('base64url').slice(0, 24)}`,
    keyPathPresent: true,
  };
}

module.exports = { signPayload, resolveMoadianKeyPath };
