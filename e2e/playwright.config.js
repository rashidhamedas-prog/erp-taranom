'use strict';
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:3099',
    headless: true,
  },
  webServer: {
    command: 'node ../server/server.js',
    cwd: __dirname,
    url: 'http://127.0.0.1:3099/api/system/health',
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: '3099',
      LISTEN_HOST: '127.0.0.1',
      SYNC_ROLE: 'central',
      NODE_ENV: 'test',
      JWT_SECRET: 'e2e-playwright-jwt-secret-32chars!!',
      DB_PATH: require('path').join(require('os').tmpdir(), 'erp-e2e-' + Date.now() + '.db'),
      ALLOWED_ORIGINS: 'http://127.0.0.1:3099',
    },
  },
});
