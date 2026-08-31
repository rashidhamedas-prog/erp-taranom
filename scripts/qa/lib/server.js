'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pickFreePort, killProcessTree, sleep } = require('../../../server/scripts/lib/test-server-boot');
const { QA_JWT } = require('./constants');

async function startQaServer({ repoRoot, dbPath, companiesDir, jwtSecret, portHint, backupDir }) {
  fs.mkdirSync(companiesDir, { recursive: true });
  const port = await pickFreePort(portHint || 0, { allowFallback: true });
  const env = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    WINDIR: process.env.WINDIR || process.env.SYSTEMROOT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    USERNAME: process.env.USERNAME,
    COMSPEC: process.env.COMSPEC,
    PATHEXT: process.env.PATHEXT,
    PORT: String(port),
    LISTEN_HOST: '127.0.0.1',
    SYNC_ROLE: 'central',
    NODE_ENV: 'test',
    JWT_SECRET: jwtSecret || QA_JWT,
    DB_PATH: dbPath,
    COMPANIES_DIR: companiesDir,
    ERP_TEST_ISOLATION: '1',
    QA_RUN_ID: process.env.QA_RUN_ID || '',
    ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
    MOADIAN_ENABLED: '0',
    SMS_API_KEY: '',
    SMS_DISABLED: '1',
    BACKUP_DIR: backupDir || path.join(companiesDir, 'backups'),
  };
  Object.keys(env).forEach((k) => { if (env[k] == null || env[k] === '') delete env[k]; });
  const child = spawn(process.execPath, [path.join(repoRoot, 'server', 'server.js')], {
    cwd: path.join(repoRoot, 'server'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > 200000) stdout = stdout.slice(-100000); });
  child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 200000) stderr = stderr.slice(-100000); });

  const started = Date.now();
  const { createHttp } = require('./http');
  const httpc = createHttp(port);
  const bootMs = Number(process.env.QA_SERVER_BOOT_TIMEOUT_MS) || 120000;
  while (Date.now() - started < bootMs) {
    try {
      const r = await httpc.get('/system/health');
      if (r.status === 200) {
        return {
          port, child, http: httpc, stdout, stderr,
          baseUrl: `http://127.0.0.1:${port}`,
          async stop() {
            await killProcessTree(child, { graceMs: 1500 });
            await sleep(200);
          },
        };
      }
    } catch { /* retry */ }
    if (child.exitCode != null) {
      throw new Error('QA server exited early: ' + (stderr || stdout).slice(-2000));
    }
    await sleep(250);
  }
  await killProcessTree(child, { graceMs: 500 });
  throw new Error('QA server health timeout: ' + (stderr || stdout).slice(-2000));
}

module.exports = { startQaServer };
