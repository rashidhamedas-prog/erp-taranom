#!/usr/bin/env node
'use strict';
/**
 * Wave 2 smoke via Domain Host pipe: colors/sizes/variants + warehouse stock/move.
 */
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const endpoint = process.platform === 'win32'
  ? '\\\\.\\pipe\\erp-w2-' + process.pid
  : path.join(os.tmpdir(), 'erp-w2-' + process.pid + '.sock');
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-w2-'));

const env = {
  ...process.env,
  ERP_HOST_AUTOSTART: '0',
  ERP_HOST_DATA: dataRoot,
  ERP_HOST_SYNC_ROLE: 'central',
  ERP_TEST_ISOLATION: '1',
  NO_PROXY: '127.0.0.1,localhost',
  ...(process.platform === 'win32' ? { ERP_HOST_PIPE: endpoint } : { ERP_HOST_SOCK: endpoint }),
};
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete env[k];

const host = spawn(process.execPath, [path.join(__dirname, '..', 'host-main.js')], {
  env, stdio: ['ignore', 'pipe', 'pipe'],
});
let ready = false;
host.stdout.on('data', (d) => { if (d.toString().includes('"listening"')) ready = true; });
host.stderr.on('data', (d) => process.stderr.write('[host] ' + d));

const waitReady = (ms = 20000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const t = () => {
    if (ready) return resolve();
    if (Date.now() - t0 > ms) return reject(new Error('not ready'));
    setTimeout(t, 50);
  };
  t();
});

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

async function api(sid, method, p, body, key) {
  const r = await invoke('api.call', {
    sessionId: sid, method, path: p, body, idempotencyKey: key,
  });
  if (!r.ok) throw new Error(r.error?.message || 'api fail');
  return r.result;
}

(async () => {
  let passed = 0, failed = 0;
  const ok = (c, n, e) => { console.log(c ? '  ✅' : '  ❌', n, e != null ? e : ''); c ? passed++ : failed++; };
  try {
    await waitReady();
    await invoke('runtime.start');
    const login = await invoke('auth.login', { username: 'admin', password: 'admin123' });
    ok(login.ok, 'login');
    const sid = login.result.sessionId;

    const whs = await api(sid, 'GET', '/warehouses');
    const whId = Array.isArray(whs.body) ? whs.body[0]?.id : null;
    ok(!!whId, 'warehouse', whId);

    const prod = await api(sid, 'POST', '/products/quick', { name: 'مانتو موج۲', price: 900000 }, 'w2-prod');
    ok(prod.status === 200 && prod.body.id, 'product', prod.body.id);

    const color = await api(sid, 'POST', '/product-variants/colors', { name: 'سبز موج۲', code: 'W2G' }, 'w2-color');
    ok(color.status === 200 || color.status === 201 || color.status === 409, 'color', color.status);

    const size = await api(sid, 'POST', '/product-variants/sizes', { name: 'L', code: 'L' }, 'w2-size');
    ok(size.status === 200 || size.status === 201 || size.status === 409, 'size', size.status);

    const matrix = await api(sid, 'POST', '/product-variants/generate-matrix', {
      product_id: prod.body.id,
    }, 'w2-matrix');
    ok(matrix.status === 200 || matrix.status === 201 || matrix.status === 400, 'generate-matrix', matrix.status);

    const variants = await api(sid, 'GET', `/product-variants?product_id=${prod.body.id}`);
    ok(variants.status === 200, 'list variants');

    const stockOverview = await api(sid, 'GET', '/warehouses/stock/overview');
    ok(stockOverview.status === 200, 'stock overview');

    const { todayJalali } = require(path.join(__dirname, '..', '..', '..', 'server', 'jalali'));
    const TODAY = todayJalali();
    const sup = await api(sid, 'POST', '/suppliers', { name: 'تأمین موج۲', phone: '05139998877' });
    const buy = await api(sid, 'POST', '/purchases', {
      supplier_id: sup.body.id, date: TODAY, pay_type: 'credit', warehouse_id: whId,
      rows: [{ product_id: prod.body.id, qty: 4, price: 400000 }],
    });
    ok(buy.status === 200, 'stock-in purchase');

    const p2 = await api(sid, 'GET', '/products/' + prod.body.id);
    ok(Number(p2.body.stock) >= 4, 'product stock >=4', p2.body.stock);

    // transfer if second warehouse exists
    const allWh = Array.isArray(whs.body) ? whs.body : [];
    if (allWh.length >= 2) {
      const mv = await api(sid, 'POST', '/warehouses/moves/transfer', {
        from_warehouse_id: allWh[0].id,
        to_warehouse_id: allWh[1].id,
        product_id: prod.body.id,
        qty: 1,
        date: TODAY,
      });
      ok(mv.status === 200 || mv.status === 400, 'warehouse transfer attempt', mv.status);
    } else {
      ok(true, 'transfer skipped (single warehouse)');
    }

    const report = await api(sid, 'GET', '/warehouses/stock/report');
    ok(report.status === 200, 'stock report');
  } catch (e) {
    console.error(e);
    failed++;
  } finally {
    try { await invoke('runtime.stop'); } catch { /* */ }
    host.kill();
    setTimeout(() => { try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* */ } }, 400);
  }
  console.log(`\n${failed ? '💥' : '🎉'} wave2 ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
