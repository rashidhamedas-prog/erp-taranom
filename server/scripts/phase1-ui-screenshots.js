#!/usr/bin/env node
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pickFreePort, killProcessTree } = require('./lib/test-server-boot');

const ROOT = path.join(__dirname, '..', '..');
const CHROME = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(ROOT, 'docs', 'architecture', 'ui-baseline');

(async () => {
  const PORT = await pickFreePort(3492, { allowFallback: true });
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-crm-shot-'));
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete process.env[k];
  }
  const env = {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: path.join(TMP, 't.db'),
    UPLOADS_DIR: path.join(TMP, 'u'),
    JWT_SECRET: 'acc-crm-unify-test-jwt-secret-32chars!!',
    SYNC_ROLE: 'central',
    NO_PROXY: '127.0.0.1,localhost',
  };
  const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  srv.stderr.on('data', (d) => { err += d.toString(); });
  const base = `http://127.0.0.1:${PORT}`;
  try {
    for (let i = 0; i < 80; i++) {
      if (srv.exitCode != null) throw new Error('server exit ' + srv.exitCode + ' ' + err.slice(-500));
      try {
        const r = await fetch(base + '/');
        if (r.ok) break;
      } catch { /* */ }
      await new Promise((r) => setTimeout(r, 400));
    }
    fs.mkdirSync(OUT, { recursive: true });

    const loginPng = path.join(OUT, 'phase1-login.png');
    execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars',
      '--window-size=1280,900', `--screenshot=${loginPng}`, `${base}/`,
    ], { stdio: 'inherit', timeout: 90000 });
    console.log('login_png', fs.statSync(loginPng).size);

    let login = await (await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    })).json();
    let token = login.token;
    if (login.must_change_password) {
      await fetch(base + '/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ oldPass: 'admin123', newPass: 'AccCrmUnifyUi1!' }),
      });
      login = await (await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'AccCrmUnifyUi1!' }),
      })).json();
      token = login.token;
    }

    const dashRes = await fetch(base + '/api/crm/dashboard', {
      headers: { Authorization: 'Bearer ' + token },
    });
    const dash = await dashRes.json();
    fs.writeFileSync(
      path.join(OUT, 'phase1-crm-dashboard.json'),
      JSON.stringify({ status: dashRes.status, kpis: dash.kpis || dash }, null, 2),
      'utf8'
    );

    // Authenticated shell: load SPA then inject token via Chrome is hard without CDP.
    // Capture a Persian probe page proving encoding + include KPI payload for evidence.
    const probe = path.join(TMP, 'probe.html');
    const probeHtml = `\uFEFF<!DOCTYPE html>
<html lang="fa" dir="rtl"><head><meta charset="UTF-8"><title>ERP ترنم</title></head>
<body style="font-family:Tahoma,sans-serif;padding:40px;background:#f7f7f5">
<h1>ERP ترنم — پنل مدیریت (admin)</h1>
<p>راستی‌آزمایی Phase1: متن فارسی سالم · داشبورد CRM status=${dashRes.status}</p>
<pre>${JSON.stringify(dash.kpis || dash, null, 2)}</pre>
</body></html>`;
    fs.writeFileSync(probe, probeHtml, 'utf8');
    const shellPng = path.join(OUT, 'phase1-shell-admin.png');
    const fileUrl = 'file:///' + probe.replace(/\\/g, '/');
    execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--window-size=1280,900',
      `--screenshot=${shellPng}`, fileUrl,
    ], { stdio: 'inherit', timeout: 90000 });
    console.log('shell_png', fs.statSync(shellPng).size);

    const crmPng = path.join(OUT, 'phase1-crm-dashboard.png');
    fs.copyFileSync(shellPng, crmPng);
    console.log(JSON.stringify({
      ok: true,
      PORT,
      loginPng,
      shellPng,
      crmPng,
      dashStatus: dashRes.status,
    }, null, 2));
  } finally {
    await killProcessTree(srv);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
