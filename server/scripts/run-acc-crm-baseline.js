#!/usr/bin/env node
/**
 * Phase-0 baseline runner for ACC-CRM-UNIFY.
 * Runs claimed ACC-CRM tests + sms + sync diag serially with isolated DB/ports.
 * Env:
 *   ACC_CRM_TEST_PORT     — preferred perpetual harness port (fallback if busy)
 *   SYNC_TEST_PORT_BASE   — sync e2e base port (default 4100)
 *   ACC_CRM_BASELINE_SKIP_SYNC=1 — skip full test-sync (slow)
 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = __dirname;

const steps = [
  { name: 'test-acc-crm-party', cmd: ['node', path.join(SCRIPTS, 'test-acc-crm-party.js')] },
  { name: 'test-acc-crm-dashboard', cmd: ['node', path.join(SCRIPTS, 'test-acc-crm-dashboard.js')] },
  { name: 'test-acc-crm-perpetual', cmd: ['node', path.join(SCRIPTS, 'test-acc-crm-perpetual.js')] },
  { name: 'test-sms', cmd: ['node', path.join(SCRIPTS, 'test-sms.js')] },
  { name: '_diag-sync-gaps', cmd: ['node', path.join(SCRIPTS, '_diag-sync-gaps-b16e78.js')] },
];

if (process.env.ACC_CRM_BASELINE_SKIP_SYNC !== '1') {
  steps.push({ name: 'test-sync', cmd: ['node', path.join(SCRIPTS, 'test-sync.js')] });
}

const results = [];
let failed = 0;
const t0 = Date.now();

for (const step of steps) {
  console.log(`\n████ BASELINE ▶ ${step.name} ████`);
  const started = Date.now();
  const r = spawnSync(step.cmd[0], step.cmd.slice(1), {
    cwd: ROOT,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: 'inherit',
  });
  const ms = Date.now() - started;
  const ok = r.status === 0;
  if (!ok) failed++;
  results.push({ name: step.name, ok, status: r.status, ms });
  console.log(`████ ${step.name}: ${ok ? 'PASS' : 'FAIL'} (${ms}ms, exit=${r.status}) ████`);
  if (!ok) {
    console.error('Baseline stopped on first failure — fix before next phase.');
    break;
  }
}

console.log('\n══ ACC-CRM baseline summary ══');
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}  ${r.ms}ms  exit=${r.status}`);
}
console.log(`total_ms=${Date.now() - t0} failed=${failed}`);
process.exit(failed ? 1 : 0);
