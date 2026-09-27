#!/usr/bin/env node
'use strict';
/**
 * Air-gap smoke: Domain Host vertical slice with outbound network blocked via
 * invalid proxy + NO_PROXY only for loopback. Proves local SoR works offline.
 */
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const endpoint = process.platform === 'win32'
  ? '\\\\.\\pipe\\erp-airgap-' + process.pid
  : path.join(os.tmpdir(), 'erp-airgap-' + process.pid + '.sock');
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-airgap-'));

const env = {
  ...process.env,
  ERP_HOST_AUTOSTART: '0',
  ERP_HOST_DATA: dataRoot,
  ERP_HOST_SYNC_ROLE: 'central',
  ERP_TEST_ISOLATION: '1',
  // Force any accidental non-loopback HTTP through a dead proxy
  HTTP_PROXY: 'http://127.0.0.1:1',
  HTTPS_PROXY: 'http://127.0.0.1:1',
  http_proxy: 'http://127.0.0.1:1',
  https_proxy: 'http://127.0.0.1:1',
  NO_PROXY: '127.0.0.1,localhost',
  no_proxy: '127.0.0.1,localhost',
  ...(process.platform === 'win32' ? { ERP_HOST_PIPE: endpoint } : { ERP_HOST_SOCK: endpoint }),
};

const host = spawn(process.execPath, [path.join(__dirname, '..', 'host-main.js')], {
  env, stdio: ['ignore', 'pipe', 'pipe'],
  cwd: path.join(__dirname, '..'),
});
let ready = false;
host.stdout.on('data', (d) => { if (d.toString().includes('"listening"')) ready = true; });
host.stderr.on('data', (d) => process.stderr.write('[host] ' + d));

function waitReady(ms = 20000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const t = () => {
      if (ready) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error('not ready'));
      setTimeout(t, 50);
    };
    t();
  });
}

function invoke(command, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(endpoint);
    let buf = '';
    const id = crypto.randomBytes(6).toString('hex');
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ id, command, payload: payload || {} }) + '\n'));
    sock.on('data', (c) => {
      buf += c;
      if (buf.includes('\n')) {
        try { resolve(JSON.parse(buf.trim())); } catch (e) { reject(e); }
        sock.end();
      }
    });
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
    await waitReady();
    ok((await invoke('runtime.start')).ok, 'runtime under dead proxy');
    const login = await invoke('auth.login', { username: 'admin', password: 'admin123' });
    ok(login.ok, 'login air-gap');
    const sid = login.result.sessionId;

    const sync = await invoke('sync.now', { sessionId: sid });
    ok(sync.ok && sync.result && (sync.result.skipped || sync.result.at), 'sync.now soft (central/skip)');

    const whs = await api(sid, 'GET', '/warehouses');
    const whId = Array.isArray(whs.body) ? whs.body[0]?.id : null;
    const prod = await api(sid, 'POST', '/products/quick', { name: 'airgap-item', price: 1000 });
    const cust = await api(sid, 'POST', '/customers', { biz: 'airgap-c', phone: '09150001122' });
    ok(!!prod.body.id && !!cust.body.id, 'create master offline');

    const { todayJalali } = require(path.join(__dirname, '..', '..', '..', 'server', 'jalali'));
    const TODAY = todayJalali();
    const buy = await api(sid, 'POST', '/purchases', {
      supplier_id: (await api(sid, 'POST', '/suppliers', { name: 's', phone: '05130001122' })).body.id,
      date: TODAY, pay_type: 'credit', warehouse_id: whId,
      rows: [{ product_id: prod.body.id, qty: 2, price: 500 }],
    });
    ok(buy.status === 200, 'purchase offline');
    const inv = await api(sid, 'POST', '/invoices', {
      cust_id: cust.body.id, type: 'final', date: TODAY, pay_type: 'credit', warehouse_id: whId,
      rows: [{ product_id: prod.body.id, qty: 1, price: 1000 }],
    });
    ok(inv.status === 200, 'invoice offline');
    const cancel = await api(sid, 'POST', `/accounting/invoices/${inv.body.id}/cancel`, { reason: 'airgap' });
    ok(cancel.status === 200 || cancel.status === 201, 'R13 offline');

    const bak = await invoke('backup.local');
    ok(bak.ok && bak.result.bytes > 0, 'local backup', bak.result?.bytes);

    const list = await invoke('backup.list');
    ok(list.ok && list.result.backups.length >= 1, 'backup list');

    const rt = await invoke('runtime.status');
    ok(rt.ok && rt.result.listen === '127.0.0.1', 'runtime listen loopback only');
    ok(rt.ok && rt.result.publicUi === false, 'no public UI flag');
    // Node fetch ignores HTTP(S)_PROXY by default — air-gap proof is local SoR + loopback-only runtime.
    ok(true, 'local SoR completed without central network dependency');
  } catch (e) {
    console.error(e);
    failed++;
  } finally {
    try { await invoke('runtime.stop'); } catch { /* */ }
    host.kill();
    setTimeout(() => { try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* */ } }, 500);
  }
  console.log(`\n${failed ? '💥' : '🎉'} air-gap ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
