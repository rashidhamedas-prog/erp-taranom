'use strict';
/**
 * Audit 8B — idempotent create keys (client_request_id).
 * Partial UNIQUE indexes are created in db.js (WHERE NOT NULL).
 */

function requireClientRequestId(body, { optional, headers } = {}) {
  let key = String((body && body.client_request_id) || '').trim();
  if (!key && headers) {
    const h = headers;
    key = String(
      h['idempotency-key'] || h['Idempotency-Key'] || h['IDEMPOTENCY-KEY'] || ''
    ).trim();
  }
  key = key.slice(0, 80);
  if (!key) {
    if (optional) return null;
    const e = new Error('شناسهٔ یکتای درخواست (client_request_id) الزامی است');
    e.status = 400;
    e.code = 'E_CLIENT_REQUEST_ID';
    throw e;
  }
  return key;
}

function findByClientRequestId(db, table, key) {
  if (!key) return null;
  try {
    return db.prepare(`SELECT * FROM ${table} WHERE client_request_id=?`).get(key) || null;
  } catch (_) {
    return null;
  }
}

function isUniqueClientRequestConflict(e) {
  const msg = String((e && e.message) || e || '');
  return /client_request_id|idx_.*client_request/i.test(msg);
}

module.exports = {
  requireClientRequestId,
  findByClientRequestId,
  isUniqueClientRequestConflict,
};
