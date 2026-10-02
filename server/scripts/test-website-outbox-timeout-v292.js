'use strict';
/**
 * v292 — outbound failure formatting + matrix timeout constant.
 * node server/scripts/test-website-outbox-timeout-v292.js
 */
const assert = require('assert');
const {
  formatOutboundFailure,
  MATRIX_TIMEOUT_MS,
  DRAIN_BATCH,
} = require('../lib/website-stock-sync');

let n = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  n += 1;
  console.log('  PASS', msg);
}

ok(MATRIX_TIMEOUT_MS >= 40_000, 'matrix timeout >= 40s');
ok(DRAIN_BATCH <= 8, 'drain batch kept small');

const t = formatOutboundFailure({ status: 0, reason: 'OUTBOUND_TIMEOUT' });
ok(/timeout|مهلت/i.test(t), 'timeout maps to Persian guidance');
ok(!/^HTTP 0$/.test(t), 'timeout is not bare HTTP 0');

const bare = formatOutboundFailure({ status: 0, reason: '', body: '' });
ok(/HTTP 0|بدون پاسخ/.test(bare), 'empty failure still explains no response');

const http = formatOutboundFailure({ status: 503, reason: '' });
ok(http === 'HTTP 503', 'nonzero status preserved');

console.log(`ALL PASS (${n})`);
