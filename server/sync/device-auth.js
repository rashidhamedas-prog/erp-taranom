'use strict';
const crypto = require('crypto');

const MAX_CLOCK_SKEW_SEC = 5 * 60;

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

module.exports = { MAX_CLOCK_SKEW_SEC, tokenHash, signature, createDeviceHeaders, timingSafeHexEqual };
