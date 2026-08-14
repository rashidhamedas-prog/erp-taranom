'use strict';

/**
 * Demo clock. Production/demo runtime uses wall clock.
 * Tests may set ERP_DEMO_NOW (ISO) to simulate expiry without changing the OS clock.
 */
function demoNow() {
  const raw = process.env.ERP_DEMO_NOW;
  if (raw != null && String(raw).trim() !== '') {
    const d = new Date(String(raw).trim());
    if (Number.isNaN(d.getTime())) {
      const err = new Error('ERP_DEMO_NOW is not a valid ISO timestamp');
      err.code = 'DEMO_CLOCK_INVALID';
      throw err;
    }
    return d;
  }
  return new Date();
}

function parseExpiresAt(raw) {
  const d = new Date(String(raw || '').trim());
  if (Number.isNaN(d.getTime())) {
    const err = new Error('ERP_DEMO_EXPIRES_AT is not a valid ISO timestamp');
    err.code = 'DEMO_EXPIRES_INVALID';
    throw err;
  }
  return d;
}

function isExpired(expiresAt, now) {
  const end = expiresAt instanceof Date ? expiresAt : parseExpiresAt(expiresAt);
  const n = now instanceof Date ? now : demoNow();
  return n.getTime() >= end.getTime();
}

module.exports = { demoNow, parseExpiresAt, isExpired };
