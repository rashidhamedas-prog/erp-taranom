#!/usr/bin/env node
'use strict';
/**
 * Wire existing print density/ISO tests into native fixture gate (Phase 0 item 6).
 * Runs as child processes; does not modify print engine.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server');
const OUT = path.join(ROOT, 'docs', 'native', 'fixtures', 'print-smoke.snapshot.json');
const tests = [
  'scripts/test-invoice-paper-iso-v243.js',
  'scripts/test-invoice-print-density-v246.js',
  'scripts/test-print-collapse-v204.js',
];

const results = [];
let failed = 0;
for (const rel of tests) {
  const full = path.join(SERVER, rel);
  if (!fs.existsSync(full)) {
    results.push({ test: rel, ok: false, reason: 'missing' });
    failed++;
    console.log('  ❌ missing', rel);
    continue;
  }
  const r = spawnSync(process.execPath, [full], {
    cwd: SERVER,
    encoding: 'utf8',
    env: { ...process.env, ERP_TEST_ISOLATION: '1' },
    timeout: 120000,
  });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(ok ? '  ✅' : '  ❌', rel, 'exit=' + r.status);
  results.push({
    test: rel,
    ok,
    status: r.status,
    tail: String(r.stdout || '').trim().split('\n').slice(-3).join(' | '),
  });
}

const snapshot = {
  suite: 'print-smoke',
  results,
  asserts: { passed: results.filter((x) => x.ok).length, failed, total: results.length },
};
const hash = crypto.createHash('sha256')
  .update(JSON.stringify({ suite: snapshot.suite, results: results.map((r) => ({ test: r.test, ok: r.ok })) }))
  .digest('hex');
snapshot.content_sha256 = hash;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n');
fs.writeFileSync(path.join(path.dirname(OUT), 'print-smoke.sha256'), hash + '\n');
console.log('OK', OUT);
console.log(failed ? `💥 ${failed} failed` : '🎉 print smoke OK');
process.exit(failed ? 1 : 0);
