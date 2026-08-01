'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-auth-security-'));
const DB_PATH = path.join(TMP, 'business.db');
const SESSION_DB = path.join(TMP, 'sessions.db');
const PORT = 4620 + crypto.randomInt(0, 200);
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'wave0-auth-session-secret-32-bytes-minimum';
const DATA_ENCRYPTION_KEY = 'wave0-data-encryption-key-32-bytes-minimum';
const BOOTSTRAP_PASSWORD = 'BootstrapAdmin1405';
const ALLOWED = 'https://erp.security.test';

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

function configProbe(overrides, remove = []) {
  const env = { ...process.env, ...overrides };
  for (const key of remove) delete env[key];
  return spawnSync(process.execPath, ['-e', "require('./lib/security').assertSecurityConfig()"], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

async function request(method, route, body, token, origin) {
  const response = await fetch(BASE + route, {
    method,
    headers: {
      ...(body == null ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data, headers: response.headers };
}

async function formRequest(route, form, token) {
  const response = await fetch(BASE + route, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}

async function waitForServer(child) {
  const deadline = Date.now() + 30_000;
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

async function main() {
  console.log('Security config');
  const routeDir = path.join(ROOT, 'routes');
  const rawJwtQueryRoutes = fs.readdirSync(routeDir)
    .filter((name) => name.endsWith('.js'))
    .filter((name) => {
      const source = fs.readFileSync(path.join(routeDir, name), 'utf8');
      return /jwt\.verify\s*\([^)]*req\.query/s.test(source)
        || /req\.query(?:\.token|\[['"]token['"]\])[^;]{0,240}jwt\.verify/s.test(source);
    });
  check(rawJwtQueryRoutes.length === 0,
    `routes never verify JWT credentials from query strings${rawJwtQueryRoutes.length ? ` (${rawJwtQueryRoutes.join(', ')})` : ''}`);
  check(configProbe({}, ['JWT_SECRET']).status !== 0, 'missing JWT_SECRET fails fast');
  check(configProbe({ NODE_ENV: 'production', JWT_SECRET }, ['ALLOWED_ORIGINS']).status !== 0,
    'production missing ALLOWED_ORIGINS fails fast');
  check(configProbe({ NODE_ENV: 'production', JWT_SECRET, ALLOWED_ORIGINS: 'http://erp.security.test' }).status !== 0,
    'production HTTP origin is rejected');
  check(configProbe({ NODE_ENV: 'production', JWT_SECRET, ALLOWED_ORIGINS: 'https://erp.security.test/path' }).status !== 0,
    'origin containing path is rejected');
  check(configProbe({ NODE_ENV: 'production', JWT_SECRET, ALLOWED_ORIGINS: ALLOWED }).status === 0,
    'explicit production HTTPS origin passes');

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      JWT_SECRET,
      DATA_ENCRYPTION_KEY,
      BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
      ALLOWED_ORIGINS: ALLOWED,
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

    console.log('Exact CORS');
    let result = await request('GET', '/api/system/time', null, null, ALLOWED);
    check(result.status === 200 && result.headers.get('access-control-allow-origin') === ALLOWED,
      'exact configured origin is allowed');
    result = await request('GET', '/api/system/time', null, null, 'http://erp.security.test');
    check(result.status === 403, 'HTTP scheme swap is denied before route execution');
    result = await request('GET', '/api/system/time', null, null, 'https://evil.security.test');
    check(result.status === 403, 'sibling/host wildcard origin is denied');

    console.log('Staff sessions and password revocation');
    result = await request('POST', '/api/auth/login', {
      username: 'admin', password: BOOTSTRAP_PASSWORD,
      device_fingerprint: 'browser-a', device_name: 'Browser A', device_kind: 'web',
    });
    check(result.status === 200 && !!result.data?.token && result.data.must_change_password === true,
      'default admin login creates a session and requires password change');
    const firstToken = result.data.token;
    check(!!jwt.decode(firstToken)?.sid, 'staff JWT carries a real opaque sid');
    result = await request('POST', '/api/auth/change-password', {
      oldPass: BOOTSTRAP_PASSWORD, newPass: 'AdminSecure1405',
    }, firstToken);
    check(result.status === 200, 'password change succeeds');
    result = await request('GET', '/api/auth/me', null, firstToken);
    check(result.status === 401, 'password change revokes the old token immediately');

    result = await request('POST', '/api/auth/login', {
      username: 'admin', password: 'AdminSecure1405',
      device_fingerprint: 'browser-a', device_name: 'Browser A', device_kind: 'web',
    });
    check(result.status === 200, 'login with changed password succeeds');
    const firstTokenA = result.data.token;
    result = await request('POST', '/api/auth/login', {
      username: 'admin', password: 'AdminSecure1405',
      device_fingerprint: 'browser-a', device_name: 'Browser A', device_kind: 'web',
    });
    check(result.status === 200, 'same device fingerprint can renew its own slot session');
    const tokenA = result.data.token;
    check((await request('GET', '/api/auth/me', null, firstTokenA)).status === 401,
      'same-fingerprint renewal replaces the previous token');
    result = await request('POST', '/api/auth/login', {
      username: 'admin', password: 'AdminSecure1405',
      device_fingerprint: 'browser-b', device_name: 'Browser B', device_kind: 'web',
    });
    check(result.status === 409 && result.data?.code === 'DEVICE_SESSION_ACTIVE',
      'second browser in the same slot is rejected without explicit kick');
    result = await request('POST', '/api/auth/login', {
      username: 'admin', password: 'AdminSecure1405',
      device_fingerprint: 'browser-b', device_name: 'Browser B', device_kind: 'web',
      force_logout_other: true,
    });
    check(result.status === 200, 'explicit kick rotates the slot session');
    let adminToken = result.data.token;
    check((await request('GET', '/api/auth/me', null, tokenA)).status === 401,
      'rotated slot invalidates the previous token immediately');

    const decoded = jwt.decode(adminToken);
    const sessionsDb = new Database(SESSION_DB, { readonly: true });
    const storedSession = sessionsDb.prepare('SELECT sid_hash FROM staff_sessions WHERE user_id=? AND revoked_at IS NULL').get(decoded.id);
    sessionsDb.close();
    check(!!storedSession && storedSession.sid_hash !== decoded.sid && !storedSession.sid_hash.includes(decoded.sid),
      'session store contains only a keyed sid hash, never the bearer sid');

    result = await request('POST', '/api/auth/logout', {}, adminToken);
    check(result.status === 200, 'single-session logout succeeds');
    check((await request('GET', '/api/auth/me', null, adminToken)).status === 401,
      'single-session logout revokes the token immediately');

    result = await request('POST', '/api/auth/login', {
      username: 'admin', password: 'AdminSecure1405',
      device_fingerprint: 'browser-b', device_name: 'Browser B', device_kind: 'web',
    });
    adminToken = result.data.token;

    console.log('Password-reset OTP and enumeration resistance');
    const businessDb = new Database(DB_PATH);
    const admin = businessDb.prepare("SELECT id FROM users WHERE username='admin'").get();
    businessDb.prepare("UPDATE users SET phone='09120000000' WHERE id=?").run(admin.id);
    businessDb.close();
    const knownSend = await request('POST', '/api/auth/forgot', { username: 'admin', phone: '09120000000' });
    const unknownSend = await request('POST', '/api/auth/forgot', { username: 'unknown', phone: '09120000001' });
    check(knownSend.status === 200 && unknownSend.status === 200
      && knownSend.data?.message === unknownSend.data?.message,
    'forgot-password response does not enumerate known accounts when SMS is unavailable');

    const otp = '654321';
    const otpHash = crypto.createHmac('sha256', JWT_SECRET)
      .update(`password-reset:${admin.id}:${otp}`).digest('hex');
    const otpDb = new Database(DB_PATH);
    otpDb.prepare('DELETE FROM password_reset_otps WHERE user_id=?').run(admin.id);
    otpDb.prepare('INSERT INTO password_reset_otps (user_id,code_hash,expires_at) VALUES (?,?,?)')
      .run(admin.id, otpHash, Math.floor(Date.now() / 1000) + 300);
    otpDb.close();
    result = await request('POST', '/api/auth/forgot-reset', {
      username: 'admin', code: otp, newPass: 'AdminReset1405',
    });
    check(result.status === 200, 'valid HMAC-bound reset OTP changes password');
    check((await request('GET', '/api/auth/me', null, adminToken)).status === 401,
      'password reset revokes every prior staff session');
    result = await request('POST', '/api/auth/login', {
      username: 'admin', password: 'AdminReset1405',
      device_fingerprint: 'admin-main', device_name: 'Admin Main', device_kind: 'web',
    });
    adminToken = result.data.token;

    console.log('Representative IDOR and role revocation');
    const repA = await request('POST', '/api/admin/users', {
      name: 'Rep A', username: 'rep-a', password: 'RepPass1405', role: 'field_sales', phone: '09121111111',
    }, adminToken);
    const repB = await request('POST', '/api/admin/users', {
      name: 'Rep B', username: 'rep-b', password: 'RepPass1405', role: 'field_sales', phone: '09122222222',
    }, adminToken);
    check(repA.status === 200 && repB.status === 200 && repA.data?.id && repB.data?.id,
      'two field representatives created');
    const customerA = await request('POST', '/api/customers', {
      biz: 'Customer A', phone: '09123333331', assigned_to: repA.data.id,
    }, adminToken);
    const customerB = await request('POST', '/api/customers', {
      biz: 'Customer B', phone: '09123333332', assigned_to: repB.data.id,
    }, adminToken);
    check(customerA.status === 200 && customerB.status === 200, 'customers assigned to separate representatives');

    result = await request('POST', '/api/auth/login', {
      username: 'rep-a', password: 'RepPass1405',
      device_fingerprint: 'rep-a-web', device_name: 'Rep A Web', device_kind: 'web',
    });
    check(result.status === 200, 'representative A login succeeds');
    let repToken = result.data.token;
    if (result.data.must_change_password) {
      const changed = await request('POST', '/api/auth/change-password', {
        oldPass: 'RepPass1405', newPass: 'RepChanged1405',
      }, repToken);
      check(changed.status === 200, 'representative completes mandatory password change');
      result = await request('POST', '/api/auth/login', {
        username: 'rep-a', password: 'RepChanged1405',
        device_fingerprint: 'rep-a-web', device_name: 'Rep A Web', device_kind: 'web',
      });
      repToken = result.data.token;
    }
    result = await request('POST', `/api/reps/${repA.data.id}/calls`, {
      customer_id: customerB.data.id, duration_min: 1, outcome: 'hostile',
    }, repToken);
    check(result.status === 403, 'representative cannot record a call for another representative customer');
    result = await request('POST', `/api/reps/${repA.data.id}/visits`, {
      customer_id: customerB.data.id, note: 'hostile',
    }, repToken);
    check(result.status === 403, 'representative cannot record a visit for another representative customer');
    result = await request('POST', `/api/reps/${repA.data.id}/calls`, {
      customer_id: customerA.data.id, duration_min: 1, outcome: 'own',
    }, repToken);
    check(result.status === 200, 'representative can record a call for an assigned customer');

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const form = new FormData();
    form.append('cust_id', String(customerB.data.id));
    form.append('pay_type', 'cash');
    form.append('amount', '100000');
    form.append('receipt', new Blob([png], { type: 'image/png' }), 'receipt.png');
    result = await formRequest('/api/reps/payments', form, repToken);
    check(result.status === 403, 'representative cannot submit payment against another representative customer');

    result = await request('PUT', `/api/admin/users/${repA.data.id}`, {
      name: 'Rep A', active: 1, role: 'inside_sales', phone: '09121111111',
      commission_cash: 0, commission_cheque: 0,
    }, adminToken);
    check(result.status === 200, 'admin role change succeeds');
    check((await request('GET', '/api/auth/me', null, repToken)).status === 401,
      'role change revokes the representative token immediately');

    const auditDb = new Database(DB_PATH, { readonly: true });
    const deniedAudits = auditDb.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='idor_denied'").get().c;
    auditDb.close();
    check(deniedAudits >= 3, 'denied cross-account attempts are security-audited');

    console.log('2FA challenge issuer and one-time use');
    result = await request('POST', '/api/auth/2fa/setup', {}, adminToken);
    check(result.status === 200 && !!result.data?.secret, '2FA setup returns a one-time setup secret');
    const tfaSecret = result.data.secret;
    let currentCode = authenticator.generate(tfaSecret);
    result = await request('POST', '/api/auth/2fa/verify', { code: currentCode }, adminToken);
    check(result.status === 200 && result.data?.relogin_required === true, 'enabling 2FA revokes existing sessions');
    check((await request('GET', '/api/auth/me', null, adminToken)).status === 401,
      'pre-enable token is invalid immediately');

    result = await request('POST', '/api/auth/login', {
      username: 'admin', password: 'AdminReset1405',
      device_fingerprint: 'admin-2fa', device_name: 'Admin 2FA', device_kind: 'web',
    });
    check(result.status === 200 && result.data?.twofa_required && result.data?.pre_token,
      'password step issues a server-backed pre-2FA challenge');
    const exhaustedChallenge = result.data.pre_token;
    currentCode = authenticator.generate(tfaSecret);
    const wrongCode = currentCode === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      result = await request('POST', '/api/auth/2fa/verify', { pre_token: exhaustedChallenge, code: wrongCode });
    }
    check(result.status === 429, 'fifth wrong TOTP attempt closes the challenge');
    result = await request('POST', '/api/auth/2fa/verify', { pre_token: exhaustedChallenge, code: currentCode });
    check(result.status === 401, 'exhausted challenge cannot be recovered with a correct code');

    result = await request('POST', '/api/auth/login', {
      username: 'admin', password: 'AdminReset1405',
      device_fingerprint: 'admin-2fa', device_name: 'Admin 2FA', device_kind: 'web',
    });
    const validChallenge = result.data.pre_token;
    currentCode = authenticator.generate(tfaSecret);
    result = await request('POST', '/api/auth/2fa/verify', { pre_token: validChallenge, code: currentCode });
    check(result.status === 200 && !!result.data?.token && !!jwt.decode(result.data.token)?.sid,
      'valid TOTP is exchanged through the unified sid issuer');
    const twofaToken = result.data.token;
    result = await request('POST', '/api/auth/2fa/verify', { pre_token: validChallenge, code: currentCode });
    check(result.status === 401, 'pre-2FA challenge is one-time and rejects replay');
    result = await request('POST', '/api/auth/2fa/disable', { code: authenticator.generate(tfaSecret) }, twofaToken);
    check(result.status === 200 && result.data?.relogin_required, 'disabling 2FA revokes all sessions');
    check((await request('GET', '/api/auth/me', null, twofaToken)).status === 401,
      'token used to disable 2FA is immediately invalid');
  } finally {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (stderr && child.exitCode && child.exitCode !== 0) console.error(stderr.slice(-4000));
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`Auth/session security: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error('FATAL', error.stack || error.message);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
