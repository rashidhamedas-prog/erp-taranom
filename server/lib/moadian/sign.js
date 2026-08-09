'use strict';

const fs = require('fs');

/** Sign-ready helper: returns stub signature or HMAC-like digest when key file exists. */
function signPayload(payload, opts = {}) {
  const keyPath = opts.privateKeyPath || process.env.MOADIAN_PRIVATE_KEY_PATH || '';
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (!keyPath) {
    return { algorithm: 'stub', signature: `STUB-${Buffer.from(body).toString('base64url').slice(0, 32)}` };
  }
  if (!fs.existsSync(keyPath)) {
    const err = new Error('فایل کلید خصوصی مودیان یافت نشد');
    err.code = 'MOADIAN_KEY_MISSING';
    throw err;
  }
  // Do not load/parse PKCS here in MVP — mark ready for ORCH sandbox wiring.
  const meta = fs.statSync(keyPath);
  return {
    algorithm: 'rsa-sha256-pending',
    signature: `PENDING-${meta.size}-${Buffer.from(body).toString('base64url').slice(0, 24)}`,
    keyPathPresent: true,
  };
}

module.exports = { signPayload };
