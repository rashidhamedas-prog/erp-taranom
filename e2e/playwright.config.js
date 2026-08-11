'use strict';
const { defineConfig } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = Number(process.env.E2E_PORT || 3099);
const BASE = process.env.E2E_BASE_URL || `http://127.0.0.1:${PORT}`;
const ROOT = path.join(os.tmpdir(), `erp-e2e-root-${Date.now()}-${process.pid}`);
fs.mkdirSync(ROOT, { recursive: true });

module.exports = defineConfig({
  testDir: '.',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: BASE,
    headless: true,
  },
  webServer: {
    command: 'node start-e2e-server.js',
    cwd: __dirname,
    url: `${BASE}/api/system/health`,
    timeout: 90_000,
    reuseExistingServer: false,
    env: {
      E2E_PORT: String(PORT),
      E2E_BASE_URL: BASE,
      E2E_ROOT: ROOT,
      E2E_DB_PATH: path.join(ROOT, 'crm.db'),
      COMPANIES_DIR: path.join(ROOT, 'companies'),
    },
  },
});
