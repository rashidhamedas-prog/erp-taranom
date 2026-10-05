'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-impersonate-'));
const DB_PATH = path.join(TMP, 'business.db');
const SESSION_DB = path.join(TMP, 'sessions.db');
const PORT = 4900 + crypto.randomInt(0, 400);
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'impersonate-auth-secret-32-bytes-minimum';
const DATA_ENCRYPTION_KEY = 'impersonate-data-key-32-bytes-minimum';
const BOOTSTRAP_PASSWORD = 'BootstrapAdmin1405';

let passed = 0;
let failed = 0;
function check(condition, label) {
  if (condition) {
    passed += 1;
    console.log('  PASS', label);
  } else {
    failed += 1;
    console.error('  FAIL', label);
  }
}

async function request(method, route, body, token) {
  const response = await fetch(BASE + route, {
    method,
    headers: {
      ...(body == null ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

async function waitForServer(child) {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server exited early (${child.exitCode})`);
    try {
      const response = await fetch(BASE + '/api/system/time');
      if (response.ok) return;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('server readiness timeout');
}

async function login(username, password, fingerprint) {
  return request('POST', '/api/auth/login', {
    username, password,
    device_fingerprint: fingerprint,
    device_name: fingerprint,
    device_kind: 'web',
  });
}

async function main() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      JWT_SECRET,
      DATA_ENCRYPTION_KEY,
      BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
      ALLOWED_ORIGINS: 'https://erp.security.test',
      PORT: String(PORT),
      LISTEN_HOST: '127.0.0.1',
      DB_PATH,
      AUTH_SESSION_DB_PATH: SESSION_DB,
      COMPANIES_DIR: path.join(TMP, 'companies'),
      UPLOADS_DIR: path.join(TMP, 'uploads'),
      BACKUP_DIR: path.join(TMP, 'backups'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    await waitForServer(child);
    let result = await login('admin', BOOTSTRAP_PASSWORD, 'admin-web');
    check(result.status === 200 && !!result.data?.token, 'admin bootstrap login');
    const bootstrap = result.data.token;
    result = await request('POST', '/api/auth/change-password', {
      oldPass: BOOTSTRAP_PASSWORD, newPass: 'AdminSecure1405',
    }, bootstrap);
    check(result.status === 200, 'admin sets a real password');
    result = await login('admin', 'AdminSecure1405', 'admin-web');
    check(result.status === 200, 'admin login after password change');
    let adminToken = result.data.token;

    const sales = await request('POST', '/api/admin/users', {
      name: 'کارشناس آزمایش', username: 'sales-imp', password: 'SalesPass1405', role: 'field_sales', phone: '09120000001',
    }, adminToken);
    check(sales.status === 200 && !!sales.data?.id, 'sales user created');
    result = await login('sales-imp', 'SalesPass1405', 'sales-web');
    check(result.status === 200 && !!result.data?.token, 'sales login keeps its own web session');
    const salesToken = result.data.token;
    const salesMe = await request('GET', '/api/auth/me', null, salesToken);
    check(salesMe.status === 200 && salesMe.data?.role === 'field_sales', 'sales token reads own profile');
    const salesCustomers = await request('GET', '/api/customers', null, salesToken);
    check(salesCustomers.status === 403 && salesCustomers.data?.code === 'must_change_password',
      'sales is still inside the forced password-change gate');

    const business = new Database(DB_PATH, { readonly: true });
    const beforeDevice = business.prepare(
      'SELECT session_id, device_slot FROM user_device_sessions WHERE user_id=? AND device_slot=?'
    ).get(sales.data.id, 'web');
    business.close();
    check(!!beforeDevice?.session_id, 'sales web device row exists before impersonation');

    result = await request('POST', '/api/auth/impersonate', { user_id: sales.data.id }, adminToken);
    check(result.status === 200 && !!result.data?.token && result.data.user?.role === 'field_sales'
      && result.data.user?.impersonation?.actor_username === 'admin',
    'admin receives a target-scoped token');
    const impToken = result.data.token;
    check(jwtSid(adminToken) !== jwtSid(impToken), 'impersonation token is not the admin session');

    check((await request('GET', '/api/auth/me', null, salesToken)).status === 200,
      'sales web token still works after impersonation starts');
    check((await request('GET', '/api/auth/me', null, adminToken)).status === 200,
      'admin web token still works during impersonation');
    const impMe = await request('GET', '/api/auth/me', null, impToken);
    check(impMe.status === 200 && impMe.data?.id === sales.data.id && impMe.data?.role === 'field_sales'
      && impMe.data?.impersonation?.actor_id > 0 && impMe.data?.must_change_password === 0,
    'impersonation profile is the target user with the admin actor attached');
    const impCustomers = await request('GET', '/api/customers', null, impToken);
    check(impCustomers.status !== 401 && impCustomers.data?.code !== 'must_change_password'
      && impCustomers.data?.code !== 'twofa_setup_required',
    'impersonation is not trapped in the target password or 2FA setup gate');
    check((await request('GET', '/api/admin/users', null, impToken)).status === 403,
      'impersonation does not keep admin authority');

    const kick = await request('POST', '/api/auth/logout-all', {}, impToken);
    check(kick.status === 403 && kick.data?.code === 'IMPERSONATION_FORBIDDEN',
      'logout-all is refused so the target sessions stay');
    const passBlock = await request('POST', '/api/auth/change-password', {
      oldPass: 'SalesPass1405', newPass: 'SalesChanged1405',
    }, impToken);
    check(passBlock.status === 403 && passBlock.data?.code === 'IMPERSONATION_FORBIDDEN',
      'password change is refused during impersonation');
    check((await request('GET', '/api/auth/me', null, salesToken)).status === 200,
      'refused kick and password change left the sales token valid');

    const sessions = new Database(SESSION_DB, { readonly: true });
    const liveSlots = sessions.prepare(`
      SELECT device_slot FROM staff_sessions
      WHERE user_id=? AND revoked_at IS NULL
    `).all(sales.data.id).map((row) => row.device_slot).sort();
    const liveWeb = sessions.prepare(`
      SELECT COUNT(*) AS c FROM staff_sessions
      WHERE device_slot='web' AND revoked_at IS NULL AND actor_user_id IS NULL
    `).get();
    sessions.close();
    check(liveSlots.includes('web') && liveSlots.includes('impersonation'),
      `sales keeps web slot and gains a separate impersonation slot (${liveSlots.join(',')})`);
    check(Number(liveWeb?.c || 0) >= 2, 'admin and sales web slots both stay open');

    const afterBusiness = new Database(DB_PATH, { readonly: true });
    const afterDevice = afterBusiness.prepare(
      'SELECT session_id FROM user_device_sessions WHERE user_id=? AND device_slot=?'
    ).get(sales.data.id, 'web');
    const auditRow = afterBusiness.prepare(
      "SELECT user_id, action FROM audit_log WHERE action='impersonate_start' ORDER BY id DESC LIMIT 1"
    ).get();
    afterBusiness.close();
    check(afterDevice && afterDevice.session_id === beforeDevice.session_id,
      'sales device-session mirror was not replaced');
    check(auditRow && auditRow.action === 'impersonate_start', 'start is written to the audit log');

    const nested = await request('POST', '/api/auth/impersonate', { user_id: sales.data.id }, impToken);
    check(nested.status === 403 && nested.data?.code === 'IMPERSONATION_FORBIDDEN',
      'nested impersonation is refused');
    const self = await request('POST', '/api/auth/impersonate', { user_id: impMe.data.impersonation.actor_id }, adminToken);
    check(self.status === 400 && self.data?.code === 'IMPERSONATION_SELF', 'admin cannot impersonate self');
    const stopped = await request('POST', '/api/auth/impersonate/stop', {}, impToken);
    check(stopped.status === 200, 'stop revokes only the impersonation session');
    check((await request('GET', '/api/auth/me', null, impToken)).status === 401, 'stopped impersonation token is dead');
    check((await request('GET', '/api/auth/me', null, adminToken)).status === 200, 'admin token survives stop');
    check((await request('GET', '/api/auth/me', null, salesToken)).status === 200, 'sales token survives stop');

    const admin2 = await request('POST', '/api/admin/users', {
      name: 'مدیر دوم', username: 'admin-two', password: 'AdminTwo1405', role: 'admin', phone: '09120000002',
    }, adminToken);
    check(admin2.status === 200 && !!admin2.data?.id, 'second admin created');
    result = await login('admin-two', 'AdminTwo1405', 'admin-two-web');
    const admin2Bootstrap = result.data.token;
    await request('POST', '/api/auth/change-password', {
      oldPass: 'AdminTwo1405', newPass: 'AdminTwoSecure1405',
    }, admin2Bootstrap);
    result = await login('admin-two', 'AdminTwoSecure1405', 'admin-two-web');
    const admin2Token = result.data?.token;
    check(result.status === 200 && !!admin2Token, 'second admin has a live web session');

    result = await request('POST', '/api/auth/impersonate', { user_id: admin2.data.id }, adminToken);
    check(result.status === 200, 'admin can enter another admin account');
    const adminImp = result.data.token;
    check((await request('GET', '/api/auth/me', null, admin2Token)).status === 200,
      'second admin web token stays valid');
    const companyBlock = await request('POST', '/api/companies/1/activate', {}, adminImp);
    check(companyBlock.status === 403 && companyBlock.data?.code === 'IMPERSONATION_FORBIDDEN',
      'company switch is refused because it would revoke every session');
    check((await request('GET', '/api/auth/me', null, admin2Token)).status === 200
      && (await request('GET', '/api/auth/me', null, adminToken)).status === 200
      && (await request('GET', '/api/auth/me', null, salesToken)).status === 200,
    'refused company switch left admin, second admin, and sales tokens valid');

    result = await request('POST', '/api/auth/change-password', {
      oldPass: 'AdminSecure1405', newPass: 'AdminSecure1406',
    }, adminToken);
    check(result.status === 200, 'actor password change bumps only the actor epoch');
    check((await request('GET', '/api/auth/me', null, adminImp)).status === 401,
      'impersonation dies when the actor epoch changes');
    check((await request('GET', '/api/auth/me', null, admin2Token)).status === 200,
      'target admin token stays valid after the actor changes password');
    check((await request('GET', '/api/auth/me', null, salesToken)).status === 200,
      'unrelated sales token stays valid');

    const stranger = await login('sales-imp', 'SalesPass1405', 'sales-web-other');
    check(stranger.status === 409 && stranger.data?.code === 'DEVICE_SESSION_ACTIVE',
      'sales password is unchanged and the original web slot is still occupied');
  } finally {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (stderr) console.error(stderr.slice(-4000));
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`Impersonation: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

function jwtSid(token) {
  const part = String(token || '').split('.')[1] || '';
  const json = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  return json.sid || '';
}

main().catch((error) => {
  console.error('FATAL', error.stack || error.message);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
