'use strict';
/**
 * Regression: cheque_records POST must require a valid party_id (no free-text party_name).
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
  console.log('\n══ QA-FIX cheque party_id ══\n');
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];
  const PORT = await pickFreePort(0, { allowFallback: true });
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-fix-chq-'));
  const env = {
    ...process.env,
    PORT: String(PORT),
    LISTEN_HOST: '127.0.0.1',
    DB_PATH: path.join(TMP, 't.db'),
    COMPANIES_DIR: path.join(TMP, 'c'),
    JWT_SECRET: 'qa-fix-cheque-party-id-secret-32ch!!',
    SYNC_ROLE: 'central',
    NODE_ENV: 'test',
    SMS_DISABLED: '1',
    MOADIAN_ENABLED: '0',
    ERP_TEST_ISOLATION: '1',
  };
  delete env.HTTP_PROXY; delete env.HTTPS_PROXY;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  srv.stderr.on('data', (d) => { stderr += d.toString(); });
  try {
    let up = false;
    for (let i = 0; i < 240; i++) {
      try {
        const h = await req(PORT, 'GET', '/system/health');
        if (h.status === 200) { up = true; break; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    ok('server up', up, up ? '' : (stderr.slice(-400) || 'health timeout'));
    if (!up) throw new Error('server did not start');
    let login = await req(PORT, 'POST', '/auth/login', { username: 'admin', password: 'admin123' });
    let token = login.body?.token;
    if (login.body?.must_change_password && token) {
      await req(PORT, 'POST', '/auth/change-password', { oldPass: 'admin123', newPass: 'QaFixChq#1405' }, token);
      login = await req(PORT, 'POST', '/auth/login', { username: 'admin', password: 'QaFixChq#1405' });
      token = login.body?.token;
    }
    ok('admin login', !!token);

    const party = await req(PORT, 'POST', '/parties', {
      full_name: 'طرف حساب چک QA', phone: '09151119901', party_roles: ['customer'],
    }, token);
    const partyId = party.body?.data?.id || party.body?.id;
    ok('party created', !!partyId, party.body?.error);

    const freeText = await req(PORT, 'POST', '/cheque-records', {
      direction: 'in', cheque_number: 'FREE-1', amount: 1000000,
      party_name: 'متن آزاد بدون شناسه',
    }, token);
    ok('free-text party_name rejected', freeText.status >= 400, 'status=' + freeText.status);

    const badId = await req(PORT, 'POST', '/cheque-records', {
      direction: 'in', cheque_number: 'BAD-1', amount: 1000000, party_id: 999999,
    }, token);
    ok('unknown party_id rejected', badId.status >= 400, 'status=' + badId.status);

    const okRow = await req(PORT, 'POST', '/cheque-records', {
      direction: 'in', cheque_number: 'PID-1', amount: 2500000, party_id: partyId,
    }, token);
    ok('valid party_id accepted', okRow.status === 200 || okRow.status === 201, okRow.body?.error);
    ok('stored party_id', Number(okRow.body?.party_id) === Number(partyId), String(okRow.body?.party_id));
    ok('party_name derived not free-text-only', !!(okRow.body?.party_name && Number(okRow.body?.party_id)), okRow.body?.party_name);
  } finally {
    await killProcessTree(srv);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log('\ncheque party_id:', pass, 'pass ·', fail, 'fail');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
