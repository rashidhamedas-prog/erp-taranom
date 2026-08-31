'use strict';

const SECRET_KEYS = /password|passwd|token|jwt|cookie|authorization|secret|api[_-]?key|iban|national|sheba|card_no/i;
const BEARER = /Bearer\s+[A-Za-z0-9._\-]+/g;
const PHONE = /\b09\d{9}\b/g;

function redactValue(key, value) {
  if (value == null) return value;
  if (SECRET_KEYS.test(String(key || ''))) return '[REDACTED]';
  if (typeof value === 'string') {
    return value.replace(BEARER, 'Bearer [REDACTED]').replace(PHONE, '09*******');
  }
  return value;
}

function redact(obj, depth) {
  if (obj == null || typeof obj !== 'object') {
    if (typeof obj === 'string') return redactValue('', obj);
    return obj;
  }
  if ((depth || 0) > 8) return '[TRUNCATED]';
  if (Array.isArray(obj)) return obj.slice(0, 50).map((v) => redact(v, (depth || 0) + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEYS.test(k)) out[k] = '[REDACTED]';
    else out[k] = redact(v, (depth || 0) + 1);
  }
  return out;
}

function redactText(s) {
  return String(s || '')
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(/("?(?:password|token|jwt|cookie|authorization|secret|api_key)"?\s*[:=]\s*")[^"]+"/gi, '$1[REDACTED]"')
    .replace(PHONE, '09*******');
}

module.exports = { redact, redactText, redactValue };
