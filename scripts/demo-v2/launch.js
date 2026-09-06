#!/usr/bin/env node
'use strict';
/**
 * Start the interactive demo process.
 *
 *   node scripts/demo-v2/launch.js [absolute-demo-root]
 *
 * Loads <root>/secrets/demo.env. Binds LISTEN_HOST=127.0.0.1 by default.
 *
 * Staging over a network must sit behind HTTPS (reverse proxy / TLS terminator).
 * Do not put a public IP in env files or this script.
 *
 * Never uses pm2 --update-env, pm2 save, or pm2 delete erp-taranom.
 * Optional: --pm2 starts only the allowlisted name erp-taranom-demo-v2.
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { assertProcessName, FORBIDDEN_PROCESS_NAMES } = require('../../server/lib/demo-reset');

const PROCESS_NAME = 'erp-taranom-demo-v2';
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const SCRUB_INHERITED_KEYS = [
  'BACKUP_S3_URI',
  'BACKUP_OFFSITE_DIR',
  'BACKUP_ENCRYPTION_KEY',
  'BACKUP_PASSWORD',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_DEFAULT_REGION',
  'AWS_REGION',
  'LISTEN_HOST',
  'JWT_SECRET',
];

function scrubInheritedDangerousEnv() {
  for (const key of SCRUB_INHERITED_KEYS) delete process.env[key];
}

function loadDemoEnvFile(filePath, { overwrite = false } = {}) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1).replace(/\\"/g, '"');
    }
    if (overwrite || process.env[key] == null || process.env[key] === '') process.env[key] = val;
  }
  return true;
}

function resolveDemoRootArg() {
  const args = process.argv.slice(2).filter((a) => !String(a).startsWith('--'));
  if (args[0]) return path.resolve(args[0]);
  if (process.env.ERP_DEMO_ROOT) return path.resolve(process.env.ERP_DEMO_ROOT);
  return null;
}

function writePid(root, pid) {
  const logs = path.join(root, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'demo-v2.pid'), String(pid), { mode: 0o600 });
}

function launch() {
  const root = resolveDemoRootArg();
  if (!root) {
    console.error('usage: node scripts/demo-v2/launch.js <absolute-demo-root>');
    process.exit(2);
  }
  const envFile = path.join(root, 'secrets', 'demo.env');
  scrubInheritedDangerousEnv();
  if (!loadDemoEnvFile(envFile, { overwrite: true })) {
    console.error('missing secrets/demo.env — run scripts/demo-v2/provision.js first');
    process.exit(2);
  }
  delete process.env.BACKUP_S3_URI;
  delete process.env.BACKUP_OFFSITE_DIR;
  delete process.env.BACKUP_ENCRYPTION_KEY;
  delete process.env.BACKUP_PASSWORD;
  process.env.ERP_DEMO_ROOT = process.env.ERP_DEMO_ROOT || root;
  if (process.env.ERP_DEMO_BIND_PUBLIC !== 'true') {
    process.env.LISTEN_HOST = '127.0.0.1';
  } else {
    process.env.LISTEN_HOST = process.env.LISTEN_HOST || '127.0.0.1';
  }
  process.env.PORT = process.env.PORT || '3002';
  process.env.SYNC_ROLE = process.env.SYNC_ROLE || 'central';

  if (!/^(true|1|yes)$/i.test(String(process.env.ERP_DEMO_MODE || ''))) {
    console.error('launch requires ERP_DEMO_MODE=true');
    process.exit(2);
  }
  const marker = path.join(process.env.ERP_DEMO_ROOT, '.erp-demo-root');
  if (!fs.existsSync(marker)) {
    console.error('demo marker missing — refuse to start');
    process.exit(2);
  }

  const serverJs = path.join(REPO_ROOT, 'server', 'server.js');
  const usePm2 = process.argv.includes('--pm2');
  const host = process.env.LISTEN_HOST;
  const port = process.env.PORT;

  if (usePm2) {
    assertProcessName(PROCESS_NAME);
    if (FORBIDDEN_PROCESS_NAMES.has(PROCESS_NAME)) {
      throw new Error('refusing forbidden process name');
    }
    const r = spawnSync('pm2', ['start', serverJs, '--name', PROCESS_NAME], {
      env: process.env,
      cwd: path.join(REPO_ROOT, 'server'),
      stdio: 'inherit',
    });
    if (r.status !== 0) process.exit(r.status || 1);
    console.log(`demo process ${PROCESS_NAME} requested on ${host}:${port}`);
    console.log('HTTPS: terminate TLS in front of this loopback bind; do not expose raw HTTP.');
    return;
  }

  const child = spawn(process.execPath, [serverJs], {
    env: process.env,
    cwd: path.join(REPO_ROOT, 'server'),
    stdio: 'inherit',
  });
  writePid(process.env.ERP_DEMO_ROOT, child.pid);
  console.log(`demo listening on ${host}:${port} (pid ${child.pid})`);
  console.log('HTTPS: terminate TLS in front of this loopback bind; do not expose raw HTTP.');
  child.on('exit', (code) => process.exit(code || 0));
}

module.exports = {
  PROCESS_NAME,
  SCRUB_INHERITED_KEYS,
  loadDemoEnvFile,
  resolveDemoRootArg,
  scrubInheritedDangerousEnv,
  launch,
};

if (require.main === module) {
  try {
    launch();
  } catch (e) {
    console.error('launch failed:', e.message || e);
    process.exit(1);
  }
}
