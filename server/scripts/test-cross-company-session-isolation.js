'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-company-session-'));
const dbPath = path.join(tempRoot, 'company-a.db');
const companiesDir = path.join(tempRoot, 'companies');
const port = 5400 + crypto.randomInt(0, 300);
const base = `http://127.0.0.1:${port}`;
let child;

async function request(method, route, body, token) {
  const response = await fetch(base + route, {
    method,
    headers: {
      ...(body == null ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function waitUp() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(base + '/api/system/time')).ok) return; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('server readiness timeout');
}

async function main() {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      JWT_SECRET: 'cross-company-session-test-secret-32-bytes',
      PORT: String(port), LISTEN_HOST: '127.0.0.1', DB_PATH: dbPath,
      COMPANIES_DIR: companiesDir,
      AUTH_SESSION_DB_PATH: path.join(tempRoot, 'sessions.db'),
      UPLOADS_DIR: path.join(tempRoot, 'uploads'),
      PRIVATE_UPLOADS_DIR: path.join(tempRoot, 'private'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  await waitUp();

  let login = await request('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  let staffA = login.body.token;
  const password = 'CrossTenant1405';
  assert.strictEqual((await request('POST', '/api/auth/change-password', {
    oldPass: 'admin123', newPass: password,
  }, staffA)).status, 200);
  staffA = (await request('POST', '/api/auth/login', { username: 'admin', password })).body.token;

  assert.strictEqual((await request('PUT', '/api/settings', { feature_b2b_portal: '1' }, staffA)).status, 200);
  const customer = await request('POST', '/api/customers', {
    biz: 'Tenant A customer', phone: '09151112222',
  }, staffA);
  assert.strictEqual(customer.status, 200);
  assert.strictEqual((await request('POST', `/api/b2b/admin/customers/${customer.body.id}/access`, {
    enabled: true, phone: '09151112222', password: 'PortalPass1405',
  }, staffA)).status, 200);
  const portalLogin = await request('POST', '/api/b2b/auth/login', {
    phone: '09151112222', password: 'PortalPass1405',
  });
  assert.strictEqual(portalLogin.status, 200);
  const b2bA = portalLogin.body.token;

  const created = await request('POST', '/api/companies', { name: 'Tenant B', code: 'TENANT-B' }, staffA);
  assert.strictEqual(created.status, 200, JSON.stringify(created.body));
  const registry = JSON.parse(fs.readFileSync(path.join(companiesDir, 'registry.json'), 'utf8'));
  const companyB = registry.companies.find((company) => company.id === created.body.company.id);
  const source = new Database(dbPath, { readonly: true });
  const accountA = source.prepare('SELECT * FROM b2b_portal_accounts WHERE customer_id=?').get(customer.body.id);
  source.close();
  const target = new Database(companyB.dbPath);
  target.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('feature_b2b_portal','1')").run();
  target.prepare(`
    INSERT INTO customers (id,user_id,biz,phone,b2b_enabled)
    VALUES (?,?,?,?,1)
  `).run(customer.body.id, 1, 'Tenant B same numeric customer', '09151112222');
  target.prepare(`
    INSERT INTO b2b_portal_accounts
      (id,customer_id,phone,password,active,auth_epoch)
    VALUES (?,?,?,?,1,?)
  `).run(accountA.id, customer.body.id, accountA.phone, accountA.password, Number(accountA.auth_epoch || 0));
  target.close();

  const activated = await request('POST', `/api/companies/${companyB.id}/activate`, {}, staffA);
  assert.strictEqual(activated.status, 200, JSON.stringify(activated.body));

  const staleStaff = await request('GET', '/api/customers', null, staffA);
  assert.strictEqual(staleStaff.status, 401, 'company A staff token must be denied after activating B');
  assert.ok(!Array.isArray(staleStaff.body), 'stale staff token must not receive tenant B rows');
  const stalePortal = await request('GET', '/api/b2b/me/catalog', null, b2bA);
  assert.strictEqual(stalePortal.status, 401, 'company A B2B token must be denied against same numeric account in B');
  assert.ok(!Array.isArray(stalePortal.body), 'stale B2B token must not receive tenant B catalog');
  console.log('  PASS staff and B2B sessions from A cannot map to same numeric ids in B');

  const staffBLogin = await request('POST', '/api/auth/login', { username: 'admin', password });
  assert.strictEqual(staffBLogin.status, 200);
  const rowsB = await request('GET', '/api/customers', null, staffBLogin.body.token);
  assert.strictEqual(rowsB.status, 200);
  assert.ok(rowsB.body.some((row) => row.biz === 'Tenant B same numeric customer'));
  console.log('  PASS a fresh company-B session works only after re-authentication');
  console.log('Cross-company session isolation: 2 passed, 0 failed');
}

main()
  .finally(async () => {
    if (child) {
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* exact test root */ }
  })
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
