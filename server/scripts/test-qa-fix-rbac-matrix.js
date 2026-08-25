'use strict';
/**
 * Regression: default matrix must not grant settings.view / accounting.view
 * to roles whose routes are adminOnly / adminOrAccounting / repModuleAdmin.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { pickFreePort, killProcessTree } = require('./lib/test-server-boot');
const { fillRoleDefaults } = require('../lib/rbac');

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
  console.log('\n══ QA-FIX RBAC matrix vs routes ══\n');
  ok('admin settings.view', fillRoleDefaults('admin').settings.view === true);
  ok('admin accounting.view', fillRoleDefaults('admin').accounting.view === true);
  ok('accounting settings.view false', fillRoleDefaults('accounting').settings.view === false);
  ok('accounting accounting.view', fillRoleDefaults('accounting').accounting.view === true);
  ok('sales_manager accounting.view', fillRoleDefaults('sales_manager').accounting.view === true);
  ok('sales_manager settings.view false', fillRoleDefaults('sales_manager').settings.view === false);
  ok('field_sales settings.view false', fillRoleDefaults('field_sales').settings.view === false);
  ok('field_sales accounting.view false', fillRoleDefaults('field_sales').accounting.view === false);

  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];
  const PORT = await pickFreePort(0, { allowFallback: true });
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-fix-rbac-'));
  const env = {
    ...process.env,
    PORT: String(PORT), LISTEN_HOST: '127.0.0.1',
    DB_PATH: path.join(TMP, 't.db'), COMPANIES_DIR: path.join(TMP, 'c'),
    JWT_SECRET: 'qa-fix-rbac-matrix-secret-32chars!!',
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
      await req(PORT, 'POST', '/auth/change-password', { oldPass: 'admin123', newPass: 'QaFixRbac#1405' }, adminTok);
      login = await req(PORT, 'POST', '/auth/login', { username: 'admin', password: 'QaFixRbac#1405' });
      adminTok = login.body?.token;
    }
    ok('admin login', !!adminTok);

    const accUser = await req(PORT, 'POST', '/admin/users', {
      name: 'QA Acc', username: 'qa_acc_matrix', password: 'QaFixRbac#1405', role: 'accounting',
    }, adminTok);
    ok('accounting user', accUser.status === 200, accUser.body?.error);
    let accLogin = await req(PORT, 'POST', '/auth/login', { username: 'qa_acc_matrix', password: 'QaFixRbac#1405' });
    if (accLogin.body?.must_change_password && accLogin.body?.token) {
      await req(PORT, 'POST', '/auth/change-password', { oldPass: 'QaFixRbac#1405', newPass: 'QaFixRbac#1405x' }, accLogin.body.token);
      accLogin = await req(PORT, 'POST', '/auth/login', { username: 'qa_acc_matrix', password: 'QaFixRbac#1405x' });
    }
    const accTok = accLogin.body?.token;
    ok('accounting login', !!accTok);

    const fsUser = await req(PORT, 'POST', '/admin/users', {
      name: 'QA FS', username: 'qa_fs_matrix', password: 'QaFixRbac#1405', role: 'field_sales',
    }, adminTok);
    ok('field_sales user', fsUser.status === 200, fsUser.body?.error);
    let fsLogin = await req(PORT, 'POST', '/auth/login', { username: 'qa_fs_matrix', password: 'QaFixRbac#1405' });
    if (fsLogin.body?.must_change_password && fsLogin.body?.token) {
      await req(PORT, 'POST', '/auth/change-password', { oldPass: 'QaFixRbac#1405', newPass: 'QaFixRbac#1405x' }, fsLogin.body.token);
      fsLogin = await req(PORT, 'POST', '/auth/login', { username: 'qa_fs_matrix', password: 'QaFixRbac#1405x' });
    }
    const fsTok = fsLogin.body?.token;
    ok('field_sales login', !!fsTok);

    const smUser = await req(PORT, 'POST', '/admin/users', {
      name: 'QA SM', username: 'qa_sm_matrix', password: 'QaFixRbac#1405', role: 'sales_manager',
    }, adminTok);
    ok('sales_manager user', smUser.status === 200, smUser.body?.error);
    let smLogin = await req(PORT, 'POST', '/auth/login', { username: 'qa_sm_matrix', password: 'QaFixRbac#1405' });
    if (smLogin.body?.must_change_password && smLogin.body?.token) {
      await req(PORT, 'POST', '/auth/change-password', { oldPass: 'QaFixRbac#1405', newPass: 'QaFixRbac#1405x' }, smLogin.body.token);
      smLogin = await req(PORT, 'POST', '/auth/login', { username: 'qa_sm_matrix', password: 'QaFixRbac#1405x' });
    }
    const smTok = smLogin.body?.token;
    ok('sales_manager login', !!smTok);

    const adminSettings = await req(PORT, 'GET', '/settings', null, adminTok);
    ok('admin GET /settings 200', adminSettings.status === 200, 'status=' + adminSettings.status);
    const accSettings = await req(PORT, 'GET', '/settings', null, accTok);
    ok('accounting GET /settings 403', accSettings.status === 403, 'status=' + accSettings.status);
    const fsSettings = await req(PORT, 'GET', '/settings', null, fsTok);
    ok('field_sales GET /settings 403', fsSettings.status === 403, 'status=' + fsSettings.status);

    const accReps = await req(PORT, 'GET', '/reps', null, accTok);
    ok('accounting GET /reps allow', accReps.status < 400, 'status=' + accReps.status);
    const smReps = await req(PORT, 'GET', '/reps', null, smTok);
    ok('sales_manager GET /reps allow', smReps.status < 400, 'status=' + smReps.status);
    const fsReps = await req(PORT, 'GET', '/reps', null, fsTok);
    ok('field_sales GET /reps 403', fsReps.status === 403, 'status=' + fsReps.status);
    const smReturns = await req(PORT, 'GET', '/accounting/sales-returns', null, smTok);
    ok('sales_manager GET sales-returns 403', smReturns.status === 403, 'status=' + smReturns.status);
  } finally {
    await killProcessTree(srv);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log('\nrbac matrix:', pass, 'pass ·', fail, 'fail');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
