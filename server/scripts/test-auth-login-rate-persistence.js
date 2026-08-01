'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const root = path.join(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-login-rate-'));
const port = 4900 + crypto.randomInt(0, 500);
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  JWT_SECRET: 'persistent-login-rate-test-secret-32-bytes',
  PORT: String(port),
  LISTEN_HOST: '127.0.0.1',
  DB_PATH: path.join(tempRoot, 'business.db'),
  AUTH_SESSION_DB_PATH: path.join(tempRoot, 'sessions.db'),
  COMPANIES_DIR: path.join(tempRoot, 'companies'),
  UPLOADS_DIR: path.join(tempRoot, 'uploads'),
  BACKUP_DIR: path.join(tempRoot, 'backups'),
};

let child;
async function start() {
  child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server exited: ${stderr.slice(-2000)}`);
    try {
      const response = await fetch(base + '/api/system/time');
      if (response.ok) return;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('server readiness timeout');
}

async function stop() {
  if (!child) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  child = null;
}

async function login(username, password) {
  const response = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, device_fingerprint: 'rate-test', device_kind: 'web' }),
  });
  return { status: response.status, body: await response.json() };
}

async function main() {
  await start();
  const known = await login('admin', 'definitely-wrong');
  const unknown = await login('no-such-account', 'definitely-wrong');
  assert.strictEqual(known.status, unknown.status);
  assert.deepStrictEqual(known.body, unknown.body, 'known/unknown login failures must be indistinguishable');
  console.log('  PASS known and unknown accounts receive an identical failure');

  for (let i = 0; i < 3; i += 1) await login('admin', 'definitely-wrong');
  let rateDb = new Database(env.AUTH_SESSION_DB_PATH, { readonly: true });
  const ipAttemptsBeforeSuccess = rateDb.prepare("SELECT attempts FROM auth_rate_limits WHERE action='login_ip'").get().attempts;
  rateDb.close();
  assert.strictEqual((await login('admin', 'admin123')).status, 200, 'valid login succeeds and clears failures');
  rateDb = new Database(env.AUTH_SESSION_DB_PATH, { readonly: true });
  const ipAttemptsAfterSuccess = rateDb.prepare("SELECT attempts FROM auth_rate_limits WHERE action='login_ip'").get().attempts;
  rateDb.close();
  assert.strictEqual(ipAttemptsAfterSuccess, ipAttemptsBeforeSuccess,
    'a valid credential must not reset the shared IP anti-stuffing bucket');
  assert.strictEqual((await login('admin', 'definitely-wrong')).status, 401, 'successful login clears persistent identity bucket');
  console.log('  PASS success clears only its identity bucket, never the shared IP bucket');

  let blocked;
  // The unknown identity already has one failure above; attempt until its
  // configured persistent threshold is crossed.
  for (let i = 0; i < 10; i += 1) blocked = await login('no-such-account', 'definitely-wrong');
  assert.strictEqual(blocked.status, 429);
  assert.strictEqual(blocked.body.code, 'LOGIN_REJECTED');
  console.log('  PASS repeated credential failures are persistently blocked');

  await stop();
  await start();
  const afterRestart = await login('no-such-account', 'definitely-wrong');
  assert.strictEqual(afterRestart.status, 429, 'lockout must survive server restart');
  assert.deepStrictEqual(afterRestart.body, blocked.body);
  console.log('  PASS lockout survives process restart with the same generic response');
  console.log('Auth login rate persistence: 4 passed, 0 failed');
}

main()
  .finally(async () => {
    await stop();
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* exact test root */ }
  })
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
