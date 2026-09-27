#!/usr/bin/env node
'use strict';
/** Master gate for native Phase 0/1 — run all local native checks. */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const node = process.execPath;
const steps = [
  ['scripts/native/check-drift.js'],
  ['scripts/native/run-golden-fixtures.js'],
  ['scripts/native/run-golden-expanded.js'],
  ['scripts/native/run-print-fixtures.js'],
  ['win-native/DomainHost/scripts/test-pipe-ping.js'],
  ['win-native/DomainHost/scripts/test-invoke-slice.js'],
  ['win-native/DomainHost/scripts/test-airgap-smoke.js'],
  ['win-native/DomainHost/scripts/test-wave2-stock.js'],
  ['win-native/DomainHost/scripts/test-wave3-treasury.js'],
  ['win-native/DomainHost/scripts/test-wave4-purchase.js'],
  ['win-native/DomainHost/scripts/test-wave5-accounting.js'],
  ['win-native/DomainHost/scripts/test-wave6-production.js'],
  ['win-native/DomainHost/scripts/test-wave7-reports.js'],
  ['win-native/DomainHost/scripts/test-wave8-crm-pos.js'],
  ['win-native/DomainHost/scripts/test-wave9-10-ops.js'],
];

let failed = 0;
for (const args of steps) {
  console.log('\n══', args[0], '══');
  const r = spawnSync(node, [path.join(ROOT, args[0])], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (r.status !== 0) {
    failed++;
    console.error('FAIL', args[0], 'exit', r.status);
  }
}
console.log(failed ? `\n💥 ${failed} gate(s) failed` : '\n🎉 all native gates passed');
process.exit(failed ? 1 : 0);
