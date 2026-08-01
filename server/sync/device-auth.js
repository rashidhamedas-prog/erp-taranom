'use strict';
const crypto = require('crypto');

const MAX_CLOCK_SKEW_SEC = 5 * 60;
const REPLAY_PROOF_VERSION = 1;

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function signature(tokenOrHash, timestamp, nonce, alreadyHashed = false) {
  const key = alreadyHashed ? tokenOrHash : tokenHash(tokenOrHash);
  return crypto.createHmac('sha256', key).update(`${timestamp}:${nonce}`).digest('hex');
}

function createDeviceHeaders(cfg) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(18).toString('hex');
  return {
    Authorization: `Device ${cfg.deviceId}:${cfg.deviceToken}`,
    'x-sync-time': String(timestamp),
    'x-sync-nonce': nonce,
    'x-sync-signature': signature(cfg.deviceToken, timestamp, nonce),
  };
}

function timingSafeHexEqual(a, b) {
  if (!/^[a-f0-9]{64}$/i.test(String(a)) || !/^[a-f0-9]{64}$/i.test(String(b))) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function stableJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Replay envelope contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('Replay envelope contains a non-JSON object');
    return `{${Object.keys(value).sort().map((key) => {
      const child = value[key];
      if (child === undefined || typeof child === 'function' || typeof child === 'symbol') {
        throw new TypeError('Replay envelope contains an unsupported value');
      }
      return `${JSON.stringify(key)}:${stableJson(child)}`;
    }).join(',')}}`;
  }
  throw new TypeError('Replay envelope contains an unsupported value');
}

function normalizeReplayEnvelope(input = {}) {
  const deviceId = Number(input.deviceId);
  const seq = Number(input.seq);
  const userId = Number(input.userId);
  const method = String(input.method || '');
  const requestPath = String(input.path || '');
  const fileHash = String(input.fileHash || '').toLowerCase();
  const fileField = String(input.fileField || '');
  const body = input.body == null ? {} : input.body;

  if (!Number.isSafeInteger(deviceId) || deviceId <= 0
      || !Number.isSafeInteger(seq) || seq <= 0
      || !Number.isSafeInteger(userId) || userId <= 0) {
    throw new TypeError('Replay envelope identifiers are invalid');
  }
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    throw new TypeError('Replay envelope method is invalid');
  }
  if (!requestPath.startsWith('/api/') || requestPath.length > 2048
      || /[\u0000-\u001f\u007f]/.test(requestPath)) {
    throw new TypeError('Replay envelope path is invalid');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TypeError('Replay envelope body must be a JSON object');
  }
  if (fileHash && !/^[a-f0-9]{64}$/.test(fileHash)) {
    throw new TypeError('Replay envelope file hash is invalid');
  }
  if (fileField && !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(fileField)) {
    throw new TypeError('Replay envelope file field is invalid');
  }

  const envelope = {
    body,
    device_id: deviceId,
    file_field: fileField,
    file_sha256: fileHash,
    method,
    path: requestPath,
    seq,
    user_id: userId,
    version: REPLAY_PROOF_VERSION,
  };
  const canonical = stableJson(envelope);
  if (Buffer.byteLength(canonical, 'utf8') > (2 * 1024 * 1024 + 8192)) {
    throw new TypeError('Replay envelope is too large');
  }
  return canonical;
}

function generateReplaySigningKeyPair() {
  return crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function normalizeReplayPublicKey(publicKeyPem) {
  const raw = String(publicKeyPem || '');
  if (!raw || raw.length > 1024) throw new TypeError('Device replay public key is invalid');
  const key = crypto.createPublicKey(raw);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Device replay public key must be Ed25519');
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

function signReplayEnvelope(privateKeyPem, input) {
  const raw = String(privateKeyPem || '');
  if (!raw || raw.length > 2048) throw new TypeError('Device replay private key is invalid');
  const key = crypto.createPrivateKey(raw);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Device replay private key must be Ed25519');
  return crypto.sign(null, Buffer.from(normalizeReplayEnvelope(input), 'utf8'), key).toString('base64url');
}

function verifyReplayEnvelope(publicKeyPem, proof, input) {
  try {
    const supplied = String(proof || '');
    if (!/^[A-Za-z0-9_-]{80,100}$/.test(supplied)) return false;
    const key = crypto.createPublicKey(normalizeReplayPublicKey(publicKeyPem));
    return crypto.verify(
      null,
      Buffer.from(normalizeReplayEnvelope(input), 'utf8'),
      key,
      Buffer.from(supplied, 'base64url')
    );
  } catch {
    return false;
  }
}

function sha256Buffer(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Expected a Buffer');
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = {
  MAX_CLOCK_SKEW_SEC,
  REPLAY_PROOF_VERSION,
  tokenHash,
  signature,
  createDeviceHeaders,
  timingSafeHexEqual,
  stableJson,
  normalizeReplayEnvelope,
  generateReplaySigningKeyPair,
  normalizeReplayPublicKey,
  signReplayEnvelope,
  verifyReplayEnvelope,
  sha256Buffer,
};
