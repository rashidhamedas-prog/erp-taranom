'use strict';
// Synchronous signed device→central relay ("online-only" operations, v522).
//
// Some operations must run on central, against central data, at the moment
// the user clicks (inventory valuation: previews hash central state and a post
// must carry the matching preview_hash). Devices therefore do not queue them
// in the outbox; they forward the request here and return central's answer.
//
// Trust model — identical to /api/sync/push plus freshness:
//   1. transport: deviceAuth (token + HMAC'd timestamp/nonce headers)
//   2. attestation: Ed25519 signature by the device's pairing key over a
//      relay-specific canonical envelope {kind,version,device_id,nonce,ts,
//      method,path,user_id,body}. `kind` keeps it disjoint from push envelopes,
//      so a captured push proof can never be replayed here (and vice versa).
//   3. freshness: |now - ts| <= MAX_CLOCK_SKEW_SEC, nonce single-use per device
//      (sync_relay_ops, central-only). A repeated nonce returns the stored
//      outcome for mutations (idempotent retry) and 409 for reads.
//   4. allow-list: only /api/inventory-valuation[/…] with GET/POST/PUT/PATCH.
//   5. authorization: loopback replay with a 5-minute JWT for the acting user,
//      so central's normal auth/RBAC/2FA gates decide — exactly like push.
const crypto = require('crypto');
const { stableJson, MAX_CLOCK_SKEW_SEC, normalizeReplayPublicKey } = require('./device-auth');

const RELAY_PREFIX = '/api/inventory-valuation';
const RELAY_KIND = 'relay_now';
const RELAY_VERSION = 1;
const RELAY_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH']);
const PATH_RE = /^\/api\/inventory-valuation(?:\/[A-Za-z0-9_-]{1,64}){0,6}$/;
const QUERY_RE = /^[A-Za-z0-9_=&%.,+-]{0,400}$/;
const NONCE_RE = /^[a-f0-9]{32}$/;
const MAX_ENVELOPE_BYTES = 1024 * 1024;
const RELAY_RETENTION_SEC = 24 * 60 * 60;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_TOTAL = 120;
const RATE_MAX_MUTATIONS = 30;

function relayError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/**
 * Validate (method, path) against the hard allow-list. Returns the exact string
 * used for the loopback URL. Rejects traversal, encoded separators, double
 * slashes, fragments, and queries on mutations.
 */
function validateRelayTarget(method, rawPath) {
  const m = String(method || '').toUpperCase();
  if (!RELAY_METHODS.has(m) || m !== method) throw relayError(403, 'SYNC_RELAY_METHOD_REJECTED', 'روش درخواست برای رلهٔ همزمان مجاز نیست');
  if (typeof rawPath !== 'string' || rawPath.length > 600) throw relayError(403, 'SYNC_RELAY_PATH_REJECTED', 'مسیر رله مجاز نیست');
  const q = rawPath.indexOf('?');
  const pathname = q === -1 ? rawPath : rawPath.slice(0, q);
  const query = q === -1 ? null : rawPath.slice(q + 1);
  if (!PATH_RE.test(pathname)) throw relayError(403, 'SYNC_RELAY_PATH_REJECTED', 'مسیر رله مجاز نیست');
  if (query != null) {
    if (m !== 'GET' || !QUERY_RE.test(query)) throw relayError(403, 'SYNC_RELAY_PATH_REJECTED', 'مسیر رله مجاز نیست');
  }
  return rawPath;
}

function isRelayMutation(method, rawPath) {
  return method !== 'GET' && !/\/preview(?:\?|$)/.test(String(rawPath || ''));
}

function canonicalRelayEnvelope(input = {}) {
  const deviceId = Number(input.deviceId);
  const userId = Number(input.userId);
  const ts = Number(input.ts);
  const nonce = String(input.nonce || '');
  const method = String(input.method || '');
  const reqPath = String(input.path || '');
  const body = input.body == null ? {} : input.body;
  if (!Number.isSafeInteger(deviceId) || deviceId <= 0 || !Number.isSafeInteger(userId) || userId <= 0
      || !Number.isSafeInteger(ts) || ts <= 0 || !NONCE_RE.test(nonce)) {
    throw new TypeError('Relay envelope identifiers are invalid');
  }
  validateRelayTarget(method, reqPath);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Relay envelope body must be a JSON object');
  const canonical = stableJson({
    body, device_id: deviceId, kind: RELAY_KIND, method, nonce, path: reqPath, ts, user_id: userId, version: RELAY_VERSION,
  });
  if (Buffer.byteLength(canonical, 'utf8') > MAX_ENVELOPE_BYTES) throw new TypeError('Relay envelope is too large');
  return canonical;
}

function signRelayEnvelope(privateKeyPem, input) {
  const raw = String(privateKeyPem || '');
  if (!raw || raw.length > 2048) throw new TypeError('Device replay private key is invalid');
  const key = crypto.createPrivateKey(raw);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Device replay private key must be Ed25519');
  return crypto.sign(null, Buffer.from(canonicalRelayEnvelope(input), 'utf8'), key).toString('base64url');
}

function verifyRelayEnvelope(publicKeyPem, proof, input) {
  try {
    const supplied = String(proof || '');
    if (!/^[A-Za-z0-9_-]{80,100}$/.test(supplied)) return false;
    const key = crypto.createPublicKey(normalizeReplayPublicKey(publicKeyPem));
    return crypto.verify(null, Buffer.from(canonicalRelayEnvelope(input), 'utf8'), key, Buffer.from(supplied, 'base64url'));
  } catch {
    return false;
  }
}

/** Device side: build the signed wire envelope for one request. */
function buildRelayEnvelope(privateKeyPem, { deviceId, userId, method, path: reqPath, body, ts, nonce }) {
  const env = {
    nonce: nonce || crypto.randomBytes(16).toString('hex'),
    ts: ts || Math.floor(Date.now() / 1000),
    method,
    path: reqPath,
    user_id: Number(userId),
    body: body && typeof body === 'object' && !Array.isArray(body) ? body : {},
  };
  env.replay_proof = signRelayEnvelope(privateKeyPem, {
    deviceId, userId: env.user_id, ts: env.ts, nonce: env.nonce, method: env.method, path: env.path, body: env.body,
  });
  return env;
}

// ---- Central-only store: single-use nonces + idempotent outcomes ----
function ensureRelayTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS sync_relay_ops (
    idempotency_key TEXT PRIMARY KEY,
    device_id INTEGER NOT NULL,
    nonce TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    http_status INTEGER,
    result_json TEXT,
    created_at INTEGER NOT NULL
  )`);
}

const rateBuckets = new Map();
function rateLimited(deviceId, mutation, nowMs = Date.now()) {
  let b = rateBuckets.get(deviceId);
  if (!b || nowMs - b.start >= RATE_WINDOW_MS) { b = { start: nowMs, total: 0, mut: 0 }; rateBuckets.set(deviceId, b); }
  if (b.total >= RATE_MAX_TOTAL || (mutation && b.mut >= RATE_MAX_MUTATIONS)) return true;
  b.total++;
  if (mutation) b.mut++;
  return false;
}

/**
 * Express handler for POST /api/sync/relay-now (mount after deviceAuth).
 * Body: {nonce, ts, method, path, user_id, body, replay_proof}
 */
function createRelayNowHandler() {
  const jwt = require('jsonwebtoken');
  const { getDB, audit } = require('../db');
  const { SECRET } = require('../middleware/auth');

  function deny(req, res, status, code, message, detail) {
    try {
      audit(req.device.paired_by || null, 'sync_relay_denied', 'sync_device', req.device.id,
        `${code}; ${detail || ''}`.slice(0, 500), req);
    } catch { /* audit is advisory */ }
    return res.status(status).json({ error: message, code });
  }

  return async function relayNowHandler(req, res) {
    const db = getDB();
    const device = req.device;
    const env = req.body || {};
    const allowed = new Set(['nonce', 'ts', 'method', 'path', 'user_id', 'body', 'replay_proof']);
    if (!env || typeof env !== 'object' || Array.isArray(env) || Object.keys(env).some((k) => !allowed.has(k))) {
      return deny(req, res, 400, 'SYNC_RELAY_ENVELOPE_REJECTED', 'پاکت رله نامعتبر است', 'unknown fields');
    }
    const reqPathForLog = typeof env.path === 'string' ? env.path.slice(0, 300) : 'invalid';
    try {
      validateRelayTarget(env.method, env.path);
    } catch (e) {
      return deny(req, res, e.status || 403, e.code || 'SYNC_RELAY_PATH_REJECTED', e.message, `${env.method} ${reqPathForLog}`);
    }
    if (rateLimited(device.id, isRelayMutation(env.method, env.path))) {
      return res.status(429).json({ error: 'تعداد درخواست‌های رله زیاد است؛ کمی صبر کنید', code: 'SYNC_RELAY_RATE_LIMIT' });
    }
    if (!device.signing_public_key || Number(device.signing_key_version || 0) !== 1
        || !Number.isSafeInteger(env.user_id) || env.user_id <= 0
        || !Number.isSafeInteger(env.ts) || typeof env.nonce !== 'string'
        || !verifyRelayEnvelope(device.signing_public_key, env.replay_proof, {
          deviceId: device.id, userId: env.user_id, ts: env.ts, nonce: env.nonce,
          method: env.method, path: env.path, body: env.body == null ? {} : env.body,
        })) {
      return deny(req, res, 403, 'SYNC_RELAY_PROOF_REJECTED', 'اثبات هویت درخواست رله نامعتبر است',
        `user=${Number.isSafeInteger(env.user_id) ? env.user_id : 'invalid'} ${env.method} ${reqPathForLog}`);
    }
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - env.ts) > MAX_CLOCK_SKEW_SEC) {
      return deny(req, res, 403, 'SYNC_RELAY_EXPIRED', 'درخواست رله منقضی است؛ ساعت دستگاه را بررسی کنید', `ts=${env.ts}`);
    }

    const mutation = isRelayMutation(env.method, env.path);
    const key = `relay:${device.id}:${env.nonce}`;
    ensureRelayTable(db);
    db.prepare('DELETE FROM sync_relay_ops WHERE created_at < ?').run(now - RELAY_RETENTION_SEC);
    const prior = db.prepare('SELECT * FROM sync_relay_ops WHERE idempotency_key=?').get(key);
    if (prior) {
      const sameOp = prior.method === env.method && prior.path === env.path && Number(prior.user_id) === env.user_id;
      if (!sameOp || !mutation) {
        return deny(req, res, 409, 'SYNC_RELAY_REPLAYED', 'درخواست رله تکراری رد شد', `nonce reuse ${env.method} ${reqPathForLog}`);
      }
      if (prior.status === 'pending') {
        return res.status(409).json({ error: 'همین عملیات هنوز روی سرور مرکزی در حال اجراست', code: 'SYNC_RELAY_IN_PROGRESS' });
      }
      res.setHeader('X-Relay-Result', 'idempotent');
      return res.status(prior.http_status || 200).json(prior.result_json ? JSON.parse(prior.result_json) : {});
    }

    const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(env.user_id);
    if (!user) {
      return deny(req, res, 403, 'SYNC_RELAY_USER_REJECTED', 'کاربر این عملیات در سرور مرکزی فعال نیست', `user=${env.user_id}`);
    }
    try {
      db.prepare(`INSERT INTO sync_relay_ops (idempotency_key,device_id,nonce,method,path,user_id,status,created_at)
        VALUES (?,?,?,?,?,?,'pending',?)`).run(key, device.id, env.nonce, env.method, env.path, env.user_id, now);
    } catch {
      return res.status(409).json({ error: 'همین عملیات هنوز روی سرور مرکزی در حال اجراست', code: 'SYNC_RELAY_IN_PROGRESS' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, name: user.name, phone: user.phone || '', ae: Number(user.auth_epoch || 0) },
      SECRET, { expiresIn: '5m' }
    );
    const port = process.env.PORT || 3000;
    let status, out;
    try {
      const resp = await fetch(`http://127.0.0.1:${port}${env.path}`, {
        method: env.method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'x-internal-replay': req.app.get('internalReplayToken') || '',
        },
        body: env.method === 'GET' ? undefined : JSON.stringify(env.body == null ? {} : env.body),
      });
      status = resp.status;
      out = await resp.json().catch(() => ({}));
    } catch {
      status = 502;
      out = { error: 'بازپخش داخلی رله ناموفق بود', code: 'SYNC_RELAY_LOOPBACK_FAILED' };
    }
    db.prepare("UPDATE sync_relay_ops SET status='done', http_status=?, result_json=? WHERE idempotency_key=?")
      .run(status, mutation ? JSON.stringify(out == null ? {} : out) : null, key);
    if (mutation) {
      try {
        audit(user.id, 'sync_relay_now', 'sync_device', device.id,
          `${env.method} ${reqPathForLog} → HTTP ${status} (device ${device.id})`, req);
      } catch { /* audit is advisory */ }
    }
    res.setHeader('X-Relay-Result', 'replayed');
    return res.status(status).json(out == null ? {} : out);
  };
}

// ---- Device side ----

/** True for requests the device must never execute/capture locally (they go to central). */
function isDeviceRelayRequest(req) {
  const p = String(req.path || '');
  return p === RELAY_PREFIX || p.startsWith(RELAY_PREFIX + '/');
}

/** Capture-middleware bypass: relayed requests are executed on central, never queued locally. */
function bypassCapture(req) {
  if (req._relayedToCentral) return true;
  if (process.env.SYNC_ROLE !== 'device') return false;
  if (!isDeviceRelayRequest(req)) return false;
  req._relayedToCentral = true;
  return true;
}

module.exports = {
  RELAY_PREFIX,
  RELAY_KIND,
  validateRelayTarget,
  isRelayMutation,
  canonicalRelayEnvelope,
  signRelayEnvelope,
  verifyRelayEnvelope,
  buildRelayEnvelope,
  ensureRelayTable,
  createRelayNowHandler,
  isDeviceRelayRequest,
  bypassCapture,
  _rateLimited: rateLimited,
  _rateBuckets: rateBuckets,
};
