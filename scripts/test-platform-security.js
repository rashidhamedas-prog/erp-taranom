'use strict';
const fs = require('fs');
const path = require('path');
const { isLoopbackUrl, isAllowedExternalUrl } = require('../desktop/security-policy');
let pass = 0, fail = 0;
function ok(name, cond) { cond ? (pass++, console.log('  ✅', name)) : (fail++, console.log('  ❌', name)); }
const manifest = fs.readFileSync(path.join(__dirname, '..', 'android/app/src/main/AndroidManifest.xml'), 'utf8');
const net = fs.readFileSync(path.join(__dirname, '..', 'android/app/src/main/res/xml/network_security_config.xml'), 'utf8');
ok('Android backup disabled', /allowBackup="false"/.test(manifest));
ok('Android global cleartext disabled', /usesCleartextTraffic="false"/.test(manifest));
ok('Android cleartext config has no production host/IP', !/94\.249|45\.90|poshaktaranom/.test(net));
ok('Electron loopback accepted', isLoopbackUrl('http://127.0.0.1:3210/a', 3210));
ok('Electron file/javascript rejected', !isLoopbackUrl('file:///tmp/a', 3210) && !isAllowedExternalUrl('javascript:alert(1)'));
ok('Electron malicious https rejected', !isAllowedExternalUrl('https://evil.example/a'));
ok('Electron allowlisted https accepted', isAllowedExternalUrl('https://erp.poshaktaranom.com/help'));
console.log(`platform security: ${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
