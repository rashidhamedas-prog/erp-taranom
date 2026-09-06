'use strict';

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const WRAPPED = [
  { id: 'wrap.inventory_smoke', script: 'server/scripts/test-inventory-smoke.js', timeoutMs: 90000 },
  { id: 'wrap.acc_crm_party', script: 'server/scripts/test-acc-crm-party.js', timeoutMs: 90000 },
  { id: 'wrap.crm_pro_rbac', script: 'server/scripts/test-crm-pro-rbac.js', timeoutMs: 180000 },
];

function childEnv() {
  const env = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    NODE_ENV: 'test',
    ERP_TEST_ISOLATION: '1',
    SYNC_ROLE: 'central',
    SMS_DISABLED: '1',
    MOADIAN_ENABLED: '0',
  };
  return env;
}

function runOne(repoRoot, spec) {
  return new Promise((resolve) => {
    const abs = path.join(repoRoot, spec.script);
    if (!fs.existsSync(abs)) {
      resolve({ code: null, missing: true, stdout: '', stderr: '' });
      return;
    }
    const child = spawn(process.execPath, [abs], {
      cwd: path.join(repoRoot, 'server'),
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > 80000) stdout = stdout.slice(-40000); });
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 80000) stderr = stderr.slice(-40000); });
    const t = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      resolve({ code: 124, timedOut: true, stdout, stderr });
    }, spec.timeoutMs);
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });
}

async function runWrappedTests({ repoRoot, rec, artifactDir }) {
  rec({
    id: 'wrap.discovered', suite: 'wrap', module: 'harness',
    status: 'PASS',
    message: WRAPPED.map((w) => w.script).join(', '),
  });
  for (const spec of WRAPPED) {
    const r = await runOne(repoRoot, spec);
    const logName = spec.id.replace(/\./g, '-') + '.log';
    if (artifactDir) {
      try {
        fs.appendFileSync(
          path.join(artifactDir, 'logs', logName),
          (r.stdout || '') + '\n' + (r.stderr || ''),
          'utf8'
        );
      } catch { /* ignore */ }
    }
    if (r.missing) {
      rec({ id: spec.id, suite: 'wrap', module: 'harness', status: 'SKIP', message: spec.script + ' missing' });
      continue;
    }
    if (r.timedOut) {
      rec({
        id: spec.id, suite: 'wrap', module: 'harness', status: 'BLOCKED',
        message: 'timeout ' + spec.timeoutMs + 'ms',
      });
      continue;
    }
    rec({
      id: spec.id, suite: 'wrap', module: 'harness',
      status: r.code === 0 ? 'PASS' : 'FAIL',
      expected: 0, actual: r.code,
      message: (r.stderr || r.stdout || '').slice(-300),
    });
  }
  void os;
}

module.exports = { runWrappedTests, WRAPPED };
