'use strict';
/** Isolated env for Playwright webServer — ignore parent env leaks; isolate company registry. */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = process.env.E2E_PORT || '3099';
const BASE = process.env.E2E_BASE_URL || `http://127.0.0.1:${PORT}`;
const root = process.env.E2E_ROOT || path.join(require('os').tmpdir(), `erp-e2e-root-${Date.now()}`);
fs.mkdirSync(root, { recursive: true });
const dbPath = process.env.E2E_DB_PATH || path.join(root, 'crm.db');
const companiesDir = process.env.COMPANIES_DIR || path.join(root, 'companies');

const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
  stdio: 'inherit',
  env: {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    PORT: String(PORT),
    LISTEN_HOST: '127.0.0.1',
    SYNC_ROLE: 'central',
    NODE_ENV: 'test',
    JWT_SECRET: 'e2e-playwright-jwt-secret-32chars!!',
    DB_PATH: dbPath,
    COMPANIES_DIR: companiesDir,
    ALLOWED_ORIGINS: BASE,
  },
});

child.on('exit', (code) => process.exit(code || 0));
process.on('SIGINT', () => child.kill('SIGTERM'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
