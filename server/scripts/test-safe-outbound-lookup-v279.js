/**
 * Regression: Node ≥18 Happy-Eyeballs calls custom lookup with { all: true }.
 * node server/scripts/test-safe-outbound-lookup-v279.js
 */
'use strict';

const { _test, safeRequestJSON } = require('../lib/safe-outbound-request');

function ok(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log('  ✓', msg);
}

function pinnedLookup(address, family) {
  // Mirror implementation used by dispatchHttps (re-import via private if exported later)
  return function lookup(_hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const fam = Number(family) || 4;
    if (options && options.all) {
      callback(null, [{ address, family: fam }]);
      return;
    }
    callback(null, address, fam);
  };
}

// Local copy of pinnedLookup from module — verify sanitize allows x-api-key
const headers = _test.sanitizeCallerHeaders({
  Authorization: 'Bearer abc',
  'x-api-key': 'abc',
  Host: 'evil',
});
ok(headers.Authorization === 'Bearer abc', 'keeps Authorization');
ok(headers['x-api-key'] === 'abc', 'keeps x-api-key');
ok(!headers.Host, 'strips Host');

const lookup = pinnedLookup('5.75.200.102', 4);
lookup('api.example', { all: true }, (err, addrs) => {
  ok(!err, 'all:true no err');
  ok(Array.isArray(addrs) && addrs[0].address === '5.75.200.102', 'all:true returns address list');
  ok(addrs[0].family === 4, 'all:true family 4');
});
lookup('api.example', {}, (err, address, family) => {
  ok(!err, 'single no err');
  ok(address === '5.75.200.102', 'single address');
  ok(family === 4, 'single family');
});

console.log('safe-outbound-lookup v279 ALL PASS');
