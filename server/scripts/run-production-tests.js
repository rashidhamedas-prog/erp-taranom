'use strict';
/**
 * Wave 0 / P0-A — sequential production test runner with per-script timeout.
 * Usage: node scripts/run-production-tests.js
 * Env: PRODUCTION_TEST_TIMEOUT_MS (default 300000 = 5 min per script)
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const TIMEOUT_MS = Number(process.env.PRODUCTION_TEST_TIMEOUT_MS || 300000);
const ARTIFACT_DIR = path.join(__dirname, '../.tmp-test-artifacts');
const SCRIPTS = [
  'test-production-schema.js',
  'test-production-bom.js',
  'test-production-fixed.js',
  'test-production-variable.js',
  'test-production-bom-advanced.js',
  'test-production-fixed-advanced.js',
  'test-production-variable-advanced.js',
  'test-production-estimation.js',
  'test-production-close.js',
  'test-production-reports.js',
  'test-production-rbac.js',
  'test-production-reports-perf.js',
  'test-production-export.js',
  'test-production-api-smoke.js',
  'test-production-permissions-matrix.js',
  'test-production-health.js',
  'test-production-access-api.js',
  'test-production-ui-smoke.js',
];

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function runOne(script) {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, script);
    const started = Date.now();
    console.log(`\n▶ ${script} (timeout ${TIMEOUT_MS}ms)`);
    const child = spawn(process.execPath, [scriptPath], {
      cwd: path.join(__dirname, '..'),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onChunk = (buf) => {
      const s = buf.toString();
      out += s;
      process.stdout.write(s);
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
    }, TIMEOUT_MS);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const elapsed = Date.now() - started;
      if (timedOut) {
        ensureDir(ARTIFACT_DIR);
        const art = path.join(ARTIFACT_DIR, `${script}.timeout.log`);
        fs.writeFileSync(art, out, 'utf8');
        console.error(`\n✖ TIMEOUT ${script} after ${elapsed}ms — log: ${art}`);
        resolve({ script, ok: false, code: 124, elapsed, timedOut: true, artifact: art });
        return;
      }
      const ok = code === 0;
      console.log(`${ok ? '✔' : '✖'} ${script} exit=${code}${signal ? ' signal=' + signal : ''} (${elapsed}ms)`);
      if (!ok) {
        ensureDir(ARTIFACT_DIR);
        const art = path.join(ARTIFACT_DIR, `${script}.fail.log`);
        fs.writeFileSync(art, out, 'utf8');
        resolve({ script, ok: false, code, elapsed, timedOut: false, artifact: art });
        return;
      }
      resolve({ script, ok: true, code: 0, elapsed, timedOut: false });
    });
  });
}

(async () => {
  const results = [];
  for (const s of SCRIPTS) {
    const r = await runOne(s);
    results.push(r);
    if (!r.ok) {
      console.error('\n══ Production suite STOPPED on failure ══');
      results.forEach((x) => {
        console.log(`  ${x.ok ? '✅' : '❌'} ${x.script} (${x.elapsed}ms)${x.timedOut ? ' TIMEOUT' : ''}`);
      });
      process.exit(r.code || 1);
    }
  }
  console.log('\n══ Production suite ALL GREEN ══');
  results.forEach((x) => console.log(`  ✅ ${x.script} (${x.elapsed}ms)`));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
