'use strict';

const crypto = require('crypto');

const PII_KEYS = new Set([
  'national_id',
  'phone',
  'password',
  'token',
  'iban',
]);

const REDACTED = '[REDACTED]';

/**
 * Create a short opaque request id (hex). Prefer an incoming client value when
 * it is a safe opaque token (no whitespace / control chars, bounded length).
 */
function createRequestId(incoming) {
  const raw = incoming == null ? '' : String(incoming).trim();
  if (raw && raw.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(raw)) {
    return raw;
  }
  return crypto.randomBytes(16).toString('hex');
}

function isPiiKey(key) {
  if (key == null) return false;
  const k = String(key).toLowerCase();
  if (PII_KEYS.has(k)) return true;
  // nested / compound keys e.g. user_phone, access_token
  for (const pii of PII_KEYS) {
    if (k === pii || k.endsWith('_' + pii) || k.endsWith('.' + pii)) return true;
  }
  return false;
}

/**
 * Strip raw invite tokens from logged request paths. Public URLs stay
 * token-in-path; access logs must not record the bearer value.
 */
function sanitizeLogPath(raw) {
  const input = raw == null ? '' : String(raw);
  if (!input) return input;

  let pathname = input;
  let search = '';
  let hash = '';
  const hashIdx = input.indexOf('#');
  if (hashIdx >= 0) {
    hash = input.slice(hashIdx);
    pathname = input.slice(0, hashIdx);
  }
  const qIdx = pathname.indexOf('?');
  if (qIdx >= 0) {
    search = pathname.slice(qIdx);
    pathname = pathname.slice(0, qIdx);
  }

  const inviteApi = pathname.match(/^(\/api\/auth\/invite)\/([^/]+)(\/accept)?\/?$/i);
  if (inviteApi) {
    pathname = `${inviteApi[1]}/${REDACTED}${inviteApi[3] || ''}`;
  }

  const invitePage = pathname.replace(/\/+$/, '') === '/invite';
  if (invitePage && search) {
    const parts = search.slice(1).split('&');
    search = '?' + parts.map((part) => {
      if (!part) return part;
      const eq = part.indexOf('=');
      const key = eq >= 0 ? part.slice(0, eq) : part;
      let decoded = key;
      try { decoded = decodeURIComponent(key.replace(/\+/g, ' ')); } catch { /* keep raw key */ }
      if (decoded === 'token') return 'token=' + REDACTED;
      return part;
    }).join('&');
  }

  return pathname + search + hash;
}

/** Deep-clone fields with PII keys redacted. Non-objects pass through. */
function redactFields(value, depth = 0) {
  if (value == null || typeof value !== 'object') return value;
  if (depth > 6) return '[TRUNCATED]';
  if (Array.isArray(value)) {
    return value.map((item) => redactFields(item, depth + 1));
  }
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (isPiiKey(key)) {
      out[key] = val == null || val === '' ? val : REDACTED;
    } else if (val && typeof val === 'object') {
      out[key] = redactFields(val, depth + 1);
    } else {
      out[key] = val;
    }
  }
  return out;
}

/**
 * Structured JSON log line to stdout. Always redacts known PII keys.
 * @param {{ level?: string, msg: string, requestId?: string, [k: string]: any }} entry
 */
function jsonLog(entry) {
  const level = String((entry && entry.level) || 'info');
  const msg = String((entry && entry.msg) || '');
  const rest = Object.assign({}, entry);
  delete rest.level;
  delete rest.msg;
  if (typeof rest.path === 'string') rest.path = sanitizeLogPath(rest.path);
  const safe = redactFields(rest);
  const line = Object.assign({ ts: new Date().toISOString(), level, msg }, safe);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(line));
  return line;
}

/** True when SQLite answers SELECT 1 (readiness probe). */
function checkDbReady(getDB) {
  try {
    const db = typeof getDB === 'function' ? getDB() : getDB;
    if (!db || typeof db.prepare !== 'function') return false;
    db.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

function requestIdMiddleware(req, res, next) {
  const incoming = req.headers['x-request-id'];
  const id = createRequestId(incoming);
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  const started = Date.now();
  res.on('finish', () => {
    jsonLog({
      level: 'info',
      msg: 'http_request',
      requestId: id,
      method: req.method,
      path: sanitizeLogPath(req.originalUrl || req.url),
      status: res.statusCode,
      duration_ms: Date.now() - started,
    });
  });
  next();
}

module.exports = {
  PII_KEYS,
  REDACTED,
  createRequestId,
  redactFields,
  sanitizeLogPath,
  jsonLog,
  checkDbReady,
  requestIdMiddleware,
};
