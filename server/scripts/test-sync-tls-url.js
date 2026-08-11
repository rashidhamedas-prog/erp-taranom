'use strict';
/**
 * P0-S1 — remote HTTP rejected; loopback HTTP allowed; upgrade http→https.
 */
const {
  normalizeCentralUrl,
  assertCentralUrlAllowed,
  upgradeHttpCentralUrl,
  maskSensitive,
  networkErrorMessage,
} = require('../sync/client');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra); }
}

console.log('\n══ P0-S1 TLS central URL ══\n');

ok('normalize adds https', normalizeCentralUrl('erp.example.com') === 'https://erp.example.com');
ok('loopback http allowed', (() => {
  try { return assertCentralUrlAllowed('http://127.0.0.1:4100') === 'http://127.0.0.1:4100'; }
  catch (e) { return false; }
})());
ok('localhost http allowed', (() => {
  try { return assertCentralUrlAllowed('http://localhost:3000').includes('localhost'); }
  catch (e) { return false; }
})());
ok('remote http rejected', (() => {
  try { assertCentralUrlAllowed('http://erp.poshaktaranom.com'); return false; }
  catch (e) { return e.code === 'E_SYNC_HTTPS_REQUIRED'; }
})());
ok('remote https allowed', (() => {
  try { return assertCentralUrlAllowed('https://erp.poshaktaranom.com') === 'https://erp.poshaktaranom.com'; }
  catch (e) { return false; }
})());
ok('upgrade http→https', upgradeHttpCentralUrl('http://erp.poshaktaranom.com') === 'https://erp.poshaktaranom.com');
ok('loopback not upgraded', upgradeHttpCentralUrl('http://127.0.0.1:4100') === 'http://127.0.0.1:4100');
ok('tokens masked in errors', !maskSensitive('Device 7:abcdef012345 Bearer aaa.bbb.ccc?token=secret').includes('abcdef012345'));
ok('invalid certificate becomes safe TLS error', (() => {
  const message = networkErrorMessage(new Error('UNABLE_TO_VERIFY_LEAF_SIGNATURE Device 7:abcdef'), 'sync failed');
  return message.includes('SSL') && !message.includes('abcdef');
})());

console.log(`\n${fail ? '❌' : '🎉'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
