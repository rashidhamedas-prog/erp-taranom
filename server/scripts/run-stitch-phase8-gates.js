#!/usr/bin/env node
/**
 * Stitch Phase 8 hardening gates (no deploy).
 * Run: node server/scripts/run-stitch-phase8-gates.js
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const node = process.execPath;

function run(label, args, cwd) {
  console.log('\n=== ' + label + ' ===');
  const r = spawnSync(node, args, {
    cwd: cwd || root,
    stdio: 'inherit',
    env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '' },
  });
  if (r.status !== 0) {
    console.error('FAIL', label, 'exit', r.status);
    process.exit(r.status || 1);
  }
}

run('POS-01/02 test-pos-stitch-p8', ['server/scripts/test-pos-stitch-p8.js']);
run('POS-03 test-pos-03-report', ['server/scripts/test-pos-03-report.js']);
if (fs.existsSync(path.join(root, 'server/scripts/test-led-stitch-p9.js'))) {
  run('LED-01 test-led-stitch-p9', ['server/scripts/test-led-stitch-p9.js']);
}
run('SMS test-sms', ['server/scripts/test-sms.js']);
run('encoding check-ui-encoding', ['server/scripts/check-ui-encoding.js']);
run('node --check server.js', ['--check', 'server/server.js']);
run('node --check app.js', ['--check', 'server/public/app.js']);
run('node --check pos.js', ['--check', 'server/lib/pos.js']);
run('node --check pos routes', ['--check', 'server/routes/pos.js']);

const appJs = fs.readFileSync(path.join(root, 'server/public/app.js'), 'utf8');
try {
  // eslint-disable-next-line no-new
  new Function(appJs);
  console.log('\n=== app.js new Function parse ===\n  OK');
} catch (e) {
  console.error('FAIL app.js parse', e.message);
  process.exit(1);
}

console.log('\nPhase 8 gates: ✅ all required suites passed (no Iran deploy)');
