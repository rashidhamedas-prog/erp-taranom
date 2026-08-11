'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const desktopDir = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(desktopDir, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(desktopDir, 'preload.js'), 'utf8');

const checks = [
  ['DPAPI/safeStorage secret store is wired', /getOrCreateLocalJwtSecret\([\s\S]*safeStorage[\s\S]*isPackaged:\s*app\.isPackaged/],
  ['permission requests are denied', /setPermissionRequestHandler\([\s\S]*callback\(false\)/],
  ['permission checks are denied', /setPermissionCheckHandler\(\(\)\s*=>\s*false\)/],
  ['device permissions are denied', /setDevicePermissionHandler\(\(\)\s*=>\s*false\)/],
  ['redirect guard is installed', /contents\.on\('will-redirect',\s*blockUntrustedNavigation\)/],
  ['webview attachment is rejected', /contents\.on\('will-attach-webview'[\s\S]*event\.preventDefault\(\)/],
  ['window-open uses hardened override options', /overrideBrowserWindowOptions:\s*secureChildWindowOptions\(\)/],
  ['web installers are disabled', /autoUpdater\.disableWebInstaller\s*=\s*true/],
  ['manual update metadata is main-process validated', /validateManualUpdateMetadata\(payload,\s*expected\)/],
  ['manual download uses the behavioral integrity verifier', /createUpdateIntegrityVerifier\(metadata\.sha256,\s*metadata\.size\)/],
  ['signed fallback uses Authenticode verifier', /verifyUpdateCodeSignature\(publishers,\s*installerPath\)/],
  ['IPC sender is restricted to the loopback main renderer', /event\.sender\s*!==\s*mainWindow\.webContents[\s\S]*isLoopbackUrl\(senderUrl,\s*port\)/],
  ['preload forwards only bounded update metadata', /installUpdate:\s*payload\s*=>\s*ipcRenderer\.invoke\('desktop:install-update',\s*sanitizeInstallPayload\(payload\)\)/],
  ['preload listener provides unsubscribe cleanup', /removeListener\('desktop:update-status',\s*listener\)/]
];

let passed = 0;
for (const [name, pattern] of checks) {
  assert.match(name.startsWith('preload') ? preload : main, pattern, name);
  passed += 1;
  process.stdout.write(`ok ${passed} - ${name}\n`);
}

assert.doesNotMatch(main, /shell\.openExternal\(\s*(?:updateState\.)?fallbackUrl/);
passed += 1;
process.stdout.write(`ok ${passed} - raw fallback URL is never opened by the shell\n`);

assert.doesNotMatch(main, /function\s+getOrCreateSecret\s*\(/);
passed += 1;
process.stdout.write(`ok ${passed} - plaintext JWT helper is removed\n`);

console.log(`desktop main hardening static: ${passed}/${passed} pass`);
