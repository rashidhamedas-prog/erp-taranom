'use strict';
/**
 * Regression: accounting without payroll.create must get 403 on POST /payroll.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { pickFreePort, killProcessTree } = require('./lib/test-server-boot');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra || ''); }
}

function req(port, method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: '127.0.0.1', port, path: '/api' + urlPath, method,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let j = null;
        try { j = buf ? JSON.parse(buf) : null; } catch { j = { raw: buf }; }
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  console.log('\n══ QA-FIX payroll RBAC ══\n');
  const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  ok('UI gates payroll.create', /canPerm\(\s*['"]payroll['"]\s*,\s*['"]create['"]\s*\)/.test(appJs));

  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];
  const PORT = await pickFreePort(0, { allowFallback: true });
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-fix-pay-'));
  const env = {
    ...process.env,
    PORT: String(PORT), LISTEN_HOST: '127.0.0.1',
    DB_PATH: path.join(TMP, 't.db'), COMPANIES_DIR: path.join(TMP, 'c'),
    JWT_SECRET: 'qa-fix-payroll-rbac-secret-32chars!!',
    SYNC_ROLE: 'central', NODE_ENV: 'test', SMS_DISABLED: '1', MOADIAN_ENABLED: '0',
    ERP_TEST_ISOLATION: '1',
  };
  delete env.HTTP_PROXY; delete env.HTTPS_PROXY;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let up = false;
    for (let i = 0; i < 240; i++) {
      try { if ((await req(PORT, 'GET', '/system/health')).status === 200) { up = true; break; } } catch { /* */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    ok('server up', up);
    if (!up) throw new Error('server down');
    let login = await req(PORT, 'POST', '/auth/login', { username: 'admin', password: 'admin123' });
    let adminTok = login.body?.token;
    if (login.body?.must_change_password && adminTok) {
      await req(PORT, 'POST', '/auth/change-password', { oldPass: 'admin123', newPass: 'QaFixPay#1405' }, adminTok);
      login = await req(PORT, 'POST', '/auth/login', { username: 'admin', password: 'QaFixPay#1405' });
      adminTok = login.body?.token;
    }
    ok('admin login', !!adminTok);

    const person = await req(PORT, 'POST', '/persons', { name: 'کارمند QA حقوق', phone: '09153330001' }, adminTok);
    const personId = person.body?.id;
    ok('person created', !!personId, person.body?.error);

    const mk = await req(PORT, 'POST', '/admin/users', {
      username: 'qa_acc_pay', password: 'AccPay#1405x', name: 'حسابدار QA', role: 'accounting', active: 1,
    }, adminTok);
    ok('accounting user created', mk.status === 200 || mk.status === 201, mk.body?.error);

    let accLogin = await req(PORT, 'POST', '/auth/login', { username: 'qa_acc_pay', password: 'AccPay#1405x' });
    let accTok = accLogin.body?.token;
    if (accLogin.body?.must_change_password && accTok) {
      await req(PORT, 'POST', '/auth/change-password', { oldPass: 'AccPay#1405x', newPass: 'AccPay#1405y' }, accTok);
      accLogin = await req(PORT, 'POST', '/auth/login', { username: 'qa_acc_pay', password: 'AccPay#1405y' });
      accTok = accLogin.body?.token;
    }
    ok('accounting login', !!accTok);

    const view = await req(PORT, 'GET', '/payroll', null, accTok);
    ok('accounting can view payroll', view.status === 200, 'status=' + view.status);

    const denied = await req(PORT, 'POST', '/payroll', {
      person_id: personId, period_label: '1405/01', regular_hours: 1, hourly_rate: 1000,
    }, accTok);
    ok('accounting create payroll 403', denied.status === 403, 'status=' + denied.status);

    const allowed = await req(PORT, 'POST', '/payroll', {
      person_id: personId, period_label: '1405/01', regular_hours: 1, hourly_rate: 1000,
    }, adminTok);
    ok('admin create payroll allowed', allowed.status === 200 || allowed.status === 201, allowed.body?.error);

    for (const p of ['/payroll/farankenou/commit', '/payroll/monthly-batch', '/payroll/year-end/1/post', '/payroll/accruals/monthly']) {
      const alt = await req(PORT, 'POST', p, { rows: [{ selected: true, person_id: personId }], period_label: '1405/01' }, accTok);
      ok('accounting 403 on ' + p, alt.status === 403, 'status=' + alt.status);
    }
  } finally {
    await killProcessTree(srv);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
  }
  console.log('\npayroll rbac:', pass, 'pass ·', fail, 'fail');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
