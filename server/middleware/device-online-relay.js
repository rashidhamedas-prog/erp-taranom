'use strict';
// Device-only (SYNC_ROLE=device) online relay for /api/inventory-valuation (v522).
//
// Valuation operations must execute on central against central data, so on a
// device every mutation and every preview is forwarded synchronously through
// the signed relay (client.relayNow → central POST /api/sync/relay-now) and
// central's status/body is returned unchanged. Offline / unpaired → 503
// E_ONLINE_REQUIRED (nothing is queued). GET reads try central first and fall
// back to the local handler when central is unreachable (X-Data-Source header).
// Capture never records these requests (sync/relay-now.js bypassCapture).
const { auth } = require('./auth');
const client = require('../sync/client');
const { isRelayMutation } = require('../sync/relay-now');

const ONLINE_REQUIRED = {
  error: 'این عملیات فقط با اتصال به سرور مرکزی ممکن است',
  code: 'E_ONLINE_REQUIRED',
};
const READ_TIMEOUT_MS = 8000;
const WRITE_TIMEOUT_MS = 60000;

function isRelayLayerFailure(result) {
  // Business answers carry X-Relay-Result (central executed the route); anything
  // else (device auth, proof, rate limit) is a transport/relay problem.
  return !result.relayResult;
}

function deviceOnlineRelay(req, res, next) {
  const method = String(req.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH'].includes(method)) return next();
  req._relayedToCentral = true;
  return auth(req, res, async () => {
    const fullPath = String(req.originalUrl || '');
    try {
      if (method === 'GET') {
        let result = { ok: false };
        if (client.getStatus().online) {
          result = await client.relayNow({ method, path: fullPath, userId: req.user.id, timeoutMs: READ_TIMEOUT_MS })
            .catch(() => ({ ok: false }));
        }
        if (result.ok && !isRelayLayerFailure(result)) {
          res.setHeader('X-Data-Source', 'central');
          return res.status(result.status).json(result.body);
        }
        res.setHeader('X-Data-Source', 'local');
        return next();
      }

      if (req.user.impersonator) {
        return res.status(403).json({ error: 'در ورود به حساب کاربر، عملیات ارزش‌گذاری مرکزی بسته است', code: 'IMPERSONATION_FORBIDDEN' });
      }
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const result = await client.relayNow({ method, path: fullPath, userId: req.user.id, body, timeoutMs: WRITE_TIMEOUT_MS });
      if (!result.ok) return res.status(503).json(ONLINE_REQUIRED);
      res.setHeader('X-Data-Source', 'central');
      if (isRelayLayerFailure(result)) {
        const b = result.body || {};
        return res.status(502).json({ error: b.error || 'رلهٔ عملیات به سرور مرکزی رد شد', code: b.code || 'E_RELAY_FAILED' });
      }
      // A central 401 must not end the local session on the device.
      if (result.status === 401) {
        return res.status(403).json({ ...(result.body || {}), code: (result.body && result.body.code) || 'E_RELAY_UNAUTHORIZED' });
      }
      if (result.status >= 200 && result.status < 300 && isRelayMutation(method, fullPath)) client.syncSoon();
      return res.status(result.status).json(result.body);
    } catch (e) {
      if (method === 'GET') { res.setHeader('X-Data-Source', 'local'); return next(); }
      return res.status(503).json({ ...ONLINE_REQUIRED, detail: client.maskSensitive(e && e.message) });
    }
  });
}

module.exports = deviceOnlineRelay;
module.exports.ONLINE_REQUIRED = ONLINE_REQUIRED;
