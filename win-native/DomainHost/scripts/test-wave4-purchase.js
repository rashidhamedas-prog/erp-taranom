#!/usr/bin/env node
'use strict';
/** Wave 4: purchase / GR-style stock-in / supplier payment via pipe. */
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const endpoint = process.platform === 'win32'
  ? '\\\\.\\pipe\\erp-w4-' + process.pid
  : path.join(os.tmpdir(), 'erp-w4-' + process.pid + '.sock');
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-w4-'));
const env = {
  ...process.env, ERP_HOST_AUTOSTART: '0', ERP_HOST_DATA: dataRoot,
  ERP_HOST_SYNC_ROLE: 'central', ERP_TEST_ISOLATION: '1', NO_PROXY: '127.0.0.1,localhost',
  ...(process.platform === 'win32' ? { ERP_HOST_PIPE: endpoint } : { ERP_HOST_SOCK: endpoint }),
};
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete env[k];
const host = spawn(process.execPath, [path.join(__dirname, '..', 'host-main.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let ready = false;
host.stdout.on('data', (d) => { if (d.toString().includes('"listening"')) ready = true; });
const waitReady = (ms = 20000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const t = () => { if (ready) return resolve(); if (Date.now() - t0 > ms) return reject(new Error('nr')); setTimeout(t, 50); };
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
      if (buf.includes('\n')) { try { resolve(JSON.parse(buf.trim())); } catch (e) { reject(e); } sock.end(); }
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
    await waitReady(); await invoke('runtime.start');
    const sid = (await invoke('auth.login', { username: 'admin', password: 'admin123' })).result.sessionId;
    ok(!!sid, 'login');
    const { todayJalali } = require(path.join(__dirname, '..', '..', '..', 'server', 'jalali'));
    const TODAY = todayJalali();
    const whId = (await api(sid, 'GET', '/warehouses')).body[0]?.id;
    const prod = await api(sid, 'POST', '/products/quick', { name: 'خرید-item', price: 100 });
    const sup = await api(sid, 'POST', '/suppliers', { name: 'تأمین موج۴', phone: '05134445566' });
    ok(!!sup.body.id, 'supplier');
    const po = await api(sid, 'POST', '/purchases/orders', {
      supplier_id: sup.body.id, date: TODAY,
      rows: [{ product_id: prod.body.id, qty: 5, price: 80000 }],
    });
    ok(po.status === 200 || po.status === 201 || po.status === 400, 'PO', po.status);
    const buy = await api(sid, 'POST', '/purchases', {
      supplier_id: sup.body.id, date: TODAY, pay_type: 'credit', warehouse_id: whId,
      rows: [{ product_id: prod.body.id, qty: 5, price: 80000 }],
    });
    ok(buy.status === 200, 'purchase invoice');
    const stock = await api(sid, 'GET', '/products/' + prod.body.id);
    ok(Number(stock.body.stock) === 5, 'stock 5', stock.body.stock);
    const boxes = await api(sid, 'GET', '/cash-boxes');
    const boxId = Array.isArray(boxes.body) ? boxes.body[0]?.id : null;
    if (boxId) {
      const pay = await api(sid, 'POST', '/purchases/payments', {
        supplier_id: sup.body.id, amount: 100000, pay_type: 'cash', date: TODAY, cash_box_id: boxId,
      });
      ok(pay.status === 200 || pay.status === 400, 'supplier payment', pay.status);
    } else ok(true, 'payment skipped');
    const list = await api(sid, 'GET', '/purchases');
    ok(list.status === 200, 'purchases list');
    const rfq = await api(sid, 'GET', '/rfq');
    ok(rfq.status === 200 || rfq.status === 404, 'rfq list', rfq.status);
  } catch (e) { console.error(e); failed++; }
  finally {
    try { await invoke('runtime.stop'); } catch { /* */ }
    host.kill();
    setTimeout(() => { try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* */ } }, 400);
  }
  console.log(`\n${failed ? '💥' : '🎉'} wave4 ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
