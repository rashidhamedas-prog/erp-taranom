'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const root = path.join(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-bootstrap-admin-'));
const dbPath = path.join(tempRoot, 'production.db');
const baseEnv = {
  ...process.env,
  NODE_ENV: 'production',
  DB_PATH: dbPath,
  COMPANIES_DIR: path.join(tempRoot, 'companies'),
  JWT_SECRET: 'bootstrap-test-jwt-secret-at-least-32-bytes',
  DATA_ENCRYPTION_KEY: 'bootstrap-test-data-key-at-least-32-bytes',
};

function init(extra = {}, removeBootstrap = false) {
  const env = { ...baseEnv, ...extra };
  if (removeBootstrap) delete env.BOOTSTRAP_ADMIN_PASSWORD;
  return spawnSync(process.execPath, ['-e', "require('./db').initDB()"], {
    cwd: root, env, encoding: 'utf8', timeout: 30_000,
  });
}

try {
  let result = init({}, true);
  assert.notStrictEqual(result.status, 0, 'fresh production DB must fail without bootstrap password');
  assert.ok((result.stderr + result.stdout).includes('BOOTSTRAP_ADMIN_PASSWORD'));
  console.log('  PASS fresh production database fails closed without bootstrap secret');

  const bootstrap = 'FreshBootstrap1405';
  result = init({ BOOTSTRAP_ADMIN_PASSWORD: bootstrap });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(bootstrap) && !result.stdout.includes('admin123'), 'logs must not expose credentials');
  const db = new Database(dbPath, { readonly: true });
  const admin = db.prepare("SELECT password,must_change_password FROM users WHERE username='admin'").get();
  db.close();
  assert.ok(admin && bcrypt.compareSync(bootstrap, admin.password) && admin.must_change_password === 1);
  console.log('  PASS supplied strong bootstrap secret creates the forced-change admin without logging it');

  result = init({}, true);
  assert.strictEqual(result.status, 0, 'existing production DB must not require bootstrap secret again');
  console.log('  PASS existing production database is unaffected when bootstrap env is later absent');
  console.log('Production bootstrap admin: 3 passed, 0 failed');
} finally {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* exact test root */ }
}
