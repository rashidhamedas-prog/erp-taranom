'use strict';

/**
 * Boot / drain gate — liveness stays up while schema init or SIGTERM drain runs.
 * Readiness and business APIs wait until markReady(); new work is refused while draining.
 */
const PROBE_PATHS = new Set(['/api/system/health', '/api/system/ready']);

let ready = false;
let draining = false;
let readyAt = 0;

function pathOf(req) {
  return String((req && (req.originalUrl || req.url)) || '').split('?')[0];
}

function isProbeRequest(req) {
  return PROBE_PATHS.has(pathOf(req));
}

function canServe() {
  return ready && !draining;
}

function markReady() {
  ready = true;
  readyAt = Date.now();
}

function markDraining() {
  draining = true;
}

function state() {
  if (draining) return { ready: false, code: 'RESTARTING' };
  if (!ready) return { ready: false, code: 'STARTING' };
  return { ready: true, code: 'OK', uptime_ms: Date.now() - readyAt };
}

function startingMessage(code) {
  if (code === 'RESTARTING') {
    return 'سرور در حال راه‌اندازی مجدد است؛ چند ثانیه دیگر تلاش کنید';
  }
  return 'سرور در حال راه‌اندازی است؛ چند ثانیه دیگر تلاش کنید';
}

function middleware(req, res, next) {
  if (isProbeRequest(req)) return next();
  if (canServe()) return next();
  const st = state();
  res.set('Retry-After', '2');
  return res.status(503).json({
    ok: false,
    ready: false,
    code: st.code,
    error: startingMessage(st.code),
  });
}

module.exports = {
  middleware,
  markReady,
  markDraining,
  canServe,
  state,
  isProbeRequest,
  startingMessage,
};
