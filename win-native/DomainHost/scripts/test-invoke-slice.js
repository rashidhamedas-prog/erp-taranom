#!/usr/bin/env node
'use strict';
/**
 * Phase 1 parity: vertical sales slice entirely through Domain Host pipe (api.call).
 */
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const endpoint = process.platform === 'win32'
  ? '\\\\.\\pipe\\erp-taranom-invoke-' + process.pid
  : path.join(os.tmpdir(), 'erp-taranom-invoke-' + process.pid + '.sock');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-host-data-'));

const env = {
  ...process.env,
  ERP_HOST_AUTOSTART: '0',
  ERP_HOST_DATA: dataRoot,
  ERP_HOST_SYNC_ROLE: 'central',
  ERP_TEST_ISOLATION: '1',
  ...(process.platform === 'win32'
    ? { ERP_HOST_PIPE: endpoint }
    : { ERP_HOST_SOCK: endpoint }),
};
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete env[k];
}

const host = spawn(process.execPath, [path.join(__dirname, '..', 'host-main.js')], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let ready = false;
host.stdout.on('data', (d) => {
  if (d.toString().includes('"listening"')) ready = true;
});
host.stderr.on('data', (d) => process.stderr.write('[host] ' + d));

function waitReady(ms = 15000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (ready) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error('host not ready'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

function invoke(command, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(endpoint);
    let buf = '';
    const id = crypto.randomBytes(8).toString('hex');
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      sock.write(JSON.stringify({ id, command, payload: payload || {} }) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      if (buf.includes('\n')) {
        try { resolve(JSON.parse(buf.trim())); }
        catch (e) { reject(e); }
        sock.end();
      }
    });
    sock.on('error', reject);
  });
}

async function api(sessionId, method, p, body, idempotencyKey) {
  const r = await invoke('api.call', {
    sessionId, method, path: p, body, idempotencyKey,
  });
  if (!r.ok) throw new Error(r.error?.message || 'api.call failed');
  return r.result;
}

(async () => {
  let passed = 0;
  let failed = 0;
  const ok = (cond, name, extra) => {
    console.log(cond ? '  ✅' : '  ❌', name + (extra != null ? ' — ' + extra : ''));
    cond ? passed++ : failed++;
  };

  try {
    await waitReady();
    const started = await invoke('runtime.start');
    ok(started.ok && started.result.running, 'runtime.start', started.result?.port);

    const login = await invoke('auth.login', { username: 'admin', password: 'admin123' });
    ok(login.ok && login.result.sessionId, 'auth.login');
    const sid = login.result.sessionId;

    const me = await invoke('auth.me', { sessionId: sid });
    ok(me.ok && me.result.status === 200, 'auth.me');

    const whs = await api(sid, 'GET', '/warehouses');
    const whId = Array.isArray(whs.body) ? whs.body[0]?.id : whs.body?.rows?.[0]?.id;
    ok(!!whId, 'warehouse', whId);

    const prod = await api(sid, 'POST', '/products/quick', {
      name: 'کالای pipe-slice', price: 500000,
    }, 'idem-prod-1');
    ok(prod.status === 200 && prod.body.id, 'product via pipe', prod.body.id);

    const prodReplay = await api(sid, 'POST', '/products/quick', {
      name: 'کالای pipe-slice', price: 500000,
    }, 'idem-prod-1');
    ok(prodReplay.idempotentReplay === true, 'idempotency replay');

    const cust = await api(sid, 'POST', '/customers', {
      biz: 'مشتری pipe', owner: 'مالک', phone: '09152223344',
    });
    ok(cust.status === 200 && cust.body.id, 'customer via pipe');

    const { todayJalali } = require(path.join(__dirname, '..', '..', '..', 'server', 'jalali'));
    const TODAY = todayJalali();

    const buy = await api(sid, 'POST', '/purchases', {
      supplier_id: (await api(sid, 'POST', '/suppliers', { name: 'تأمین pipe', phone: '05132223344' })).body.id,
      date: TODAY, pay_type: 'credit', warehouse_id: whId,
      rows: [{ product_id: prod.body.id, qty: 3, price: 300000 }],
    });
    ok(buy.status === 200 && buy.body.id, 'purchase stock-in via pipe');

    const stock1 = await api(sid, 'GET', '/products/' + prod.body.id);
    ok(Number(stock1.body.stock) === 3, 'stock=3', stock1.body.stock);

    const inv = await api(sid, 'POST', '/invoices', {
      cust_id: cust.body.id, type: 'final', date: TODAY, pay_type: 'credit', warehouse_id: whId,
      rows: [{ product_id: prod.body.id, qty: 1, price: 500000 }],
    });
    ok(inv.status === 200 && inv.body.id, 'invoice via pipe', inv.body.num);

    const stock2 = await api(sid, 'GET', '/products/' + prod.body.id);
    ok(Number(stock2.body.stock) === 2, 'stock after sale=2', stock2.body.stock);

    const tb = await api(sid, 'GET', '/accounting/trial-balance');
    ok(tb.body.balanced === true, 'TB balanced via pipe');

    const cancel = await api(sid, 'POST', `/accounting/invoices/${inv.body.id}/cancel`, {
      reason: 'pipe-r13',
    });
    ok(cancel.status === 200 || cancel.status === 201, 'R13 via pipe', cancel.status);

    const stock3 = await api(sid, 'GET', '/products/' + prod.body.id);
    ok(Number(stock3.body.stock) === 3, 'stock restored=3', stock3.body.stock);

    const ver = await invoke('version');
    ok(ver.result.version === '0.2.0', 'host version 0.2.0');
  } catch (e) {
    console.error(e);
    failed++;
  } finally {
    try { await invoke('runtime.stop'); } catch { /* */ }
    host.kill();
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(endpoint); } catch { /* */ }
    }
    setTimeout(() => {
      try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* */ }
    }, 500);
  }

  console.log(`\n${failed ? '💥' : '🎉'} ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
