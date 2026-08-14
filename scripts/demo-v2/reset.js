#!/usr/bin/env node
'use strict';
/**
 * Atomic reset of an interactive demo instance.
 *
 *   node scripts/demo-v2/reset.js [absolute-demo-root]
 *
 * Requires ERP_DEMO_MODE=true and a matching .erp-demo-root marker.
 * Never glob-deletes. Never touches process name erp-taranom.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadDemoEnvFile, resolveDemoRootArg, scrubInheritedDangerousEnv } = require('./launch.js');
const { assertProcessName, resetDemoInstance, FORBIDDEN_PROCESS_NAMES } = require('../../server/lib/demo-reset');
const { validateDemoInvariants } = require('../../server/scripts/validate-demo-invariants');

const PROCESS_NAME = 'erp-taranom-demo-v2';

function readPidCommandLine(pid) {
  if (process.platform === 'win32') {
    const r = spawnSync('wmic', [
      'process', 'where', `ProcessId=${pid}`, 'get', 'Name,CommandLine', '/FORMAT:LIST',
    ], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    return String((r && r.stdout) || '');
  }
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    return '';
  }
}

function pidIsDemoServer(pid, demoRoot) {
  if (!Number.isFinite(pid) || pid <= 1 || pid === process.pid) return false;
  const raw = readPidCommandLine(pid).toLowerCase();
  if (!raw) return false;
  if (!raw.includes('node')) return false;
  if (!raw.includes('server.js')) return false;
  const line = raw.replace(/\\/g, '/');
  const root = String(demoRoot || '').toLowerCase().replace(/\\/g, '/');
  if (root && line.includes(root)) return true;
  if (line.includes('erp-taranom-demo-v2')) return true;
  return false;
}

function stopAllowlistedOnly() {
  assertProcessName(PROCESS_NAME);
  if (FORBIDDEN_PROCESS_NAMES.has(PROCESS_NAME)) {
    throw new Error('refusing forbidden process name');
  }
  const root = process.env.ERP_DEMO_ROOT;
  if (root) {
    const pidFile = path.join(root, 'logs', 'demo-v2.pid');
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (pidIsDemoServer(pid, root)) {
        try {
          if (process.platform === 'win32') {
            spawnSync('taskkill', ['/pid', String(pid), '/F'], { stdio: 'ignore', windowsHide: true });
          } else {
            try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }
    }
  }
  try {
    spawnSync('pm2', ['stop', PROCESS_NAME], { stdio: 'ignore' });
  } catch { /* pm2 optional */ }
}

async function main() {
  const rootArg = resolveDemoRootArg();
  scrubInheritedDangerousEnv();
  if (rootArg) loadDemoEnvFile(path.join(rootArg, 'secrets', 'demo.env'), { overwrite: true });
  else if (process.env.ERP_DEMO_ROOT) {
    loadDemoEnvFile(path.join(process.env.ERP_DEMO_ROOT, 'secrets', 'demo.env'), { overwrite: true });
  }

  if (!/^(true|1|yes)$/i.test(String(process.env.ERP_DEMO_MODE || ''))) {
    console.error('reset requires ERP_DEMO_MODE=true (fail-closed)');
    process.exit(2);
  }
  if (!process.env.ERP_DEMO_ROOT || !process.env.ERP_DEMO_INSTANCE_ID) {
    console.error('reset requires ERP_DEMO_ROOT and ERP_DEMO_INSTANCE_ID');
    process.exit(2);
  }

  const seedScript = path.join(__dirname, '..', '..', 'server', 'scripts', 'seed-demo.js');
  const result = await resetDemoInstance({
    processName: PROCESS_NAME,
    seedScript,
    timeoutMs: Number(process.env.ERP_DEMO_SEED_TIMEOUT_MS || 180000),
    validate: async (tmpDb) => {
      const check = validateDemoInvariants(tmpDb);
      if (!check.ok) {
        const err = new Error((check.failures || check.errors || []).join('; '));
        err.code = 'DEMO_INVARIANTS';
        throw err;
      }
    },
    beforeSwap: async () => { stopAllowlistedOnly(); },
  });
  console.log('demo reset ok:', result.dbPath);
  console.log('start with: node scripts/demo-v2/launch.js');
}

module.exports = { pidIsDemoServer, readPidCommandLine, stopAllowlistedOnly };

if (require.main === module) {
  main().catch((e) => {
    console.error('reset failed:', e.message || e);
    process.exit(1);
  });
}
