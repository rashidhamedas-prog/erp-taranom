#!/usr/bin/env node
'use strict';
/** Wave 7 reports + print-related endpoints smoke. */
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\erp-w7-' + process.pid : path.join(os.tmpdir(), 'erp-w7-' + process.pid + '.sock');
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-w7-'));
const env = { ...process.env, ERP_HOST_AUTOSTART: '0', ERP_HOST_DATA: dataRoot, ERP_HOST_SYNC_ROLE: 'central', ERP_TEST_ISOLATION: '1', NO_PROXY: '127.0.0.1,localhost', ...(process.platform === 'win32' ? { ERP_HOST_PIPE: endpoint } : { ERP_HOST_SOCK: endpoint }) };
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete env[k];
const host = spawn(process.execPath, [path.join(__dirname, '..', 'host-main.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let ready = false; host.stdout.on('data', (d) => { if (d.toString().includes('"listening"')) ready = true; });
const waitReady = (ms = 20000) => new Promise((resolve, reject) => { const t0 = Date.now(); const t = () => { if (ready) return resolve(); if (Date.now() - t0 > ms) return reject(new Error('nr')); setTimeout(t, 50); }; t(); });
function invoke(command, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(endpoint); let buf = ''; const id = crypto.randomBytes(6).toString('hex');
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ id, command, payload: payload || {} }) + '\n'));
    sock.on('data', (c) => { buf += c; if (buf.includes('\n')) { try { resolve(JSON.parse(buf.trim())); } catch (e) { reject(e); } sock.end(); } });
    sock.on('error', reject);
  });
}
async function api(sid, method, p, body) {
  const r = await invoke('api.call', { sessionId: sid, method, path: p, body });
  if (!r.ok) throw new Error(r.error?.message || 'fail');
  return r.result;
}
(async () => {
  let passed = 0, failed = 0;
  const ok = (c, n, e) => { console.log(c ? '  ✅' : '  ❌', n, e != null ? e : ''); c ? passed++ : failed++; };
  try {
    await waitReady(); await invoke('runtime.start');
    const sid = (await invoke('auth.login', { username: 'admin', password: 'admin123' })).result.sessionId;
    ok(!!sid, 'login');
    for (const ep of [
      '/reports/summary', '/reports/monthly', '/reports/top-customers', '/reports/salesperson',
      '/adv-reports/sales-by-product', '/adv-reports/inventory-valuation', '/adv-reports/vat-summary',
      '/dashboard/summary', '/ledgers/financial', '/ledgers/stock',
    ]) {
      const r = await api(sid, 'GET', ep);
      ok([200, 400, 404].includes(r.status), `GET ${ep}`, r.status);
    }
  } catch (e) { console.error(e); failed++; }
  finally { try { await invoke('runtime.stop'); } catch { /* */ } host.kill(); setTimeout(() => { try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* */ } }, 400); }
  console.log(`\n${failed ? '💥' : '🎉'} wave7 ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
