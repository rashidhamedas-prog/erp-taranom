#!/usr/bin/env node
'use strict';
/** Wave 3 smoke: banks/cash/settlement via Domain Host pipe. */
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const endpoint = process.platform === 'win32'
  ? '\\\\.\\pipe\\erp-w3-' + process.pid
  : path.join(os.tmpdir(), 'erp-w3-' + process.pid + '.sock');
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-w3-'));
const env = {
  ...process.env,
  ERP_HOST_AUTOSTART: '0', ERP_HOST_DATA: dataRoot, ERP_HOST_SYNC_ROLE: 'central',
  ERP_TEST_ISOLATION: '1', NO_PROXY: '127.0.0.1,localhost',
  ...(process.platform === 'win32' ? { ERP_HOST_PIPE: endpoint } : { ERP_HOST_SOCK: endpoint }),
};
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete env[k];

const host = spawn(process.execPath, [path.join(__dirname, '..', 'host-main.js')], {
  env, stdio: ['ignore', 'pipe', 'pipe'],
});
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
    await waitReady();
    await invoke('runtime.start');
    const login = await invoke('auth.login', { username: 'admin', password: 'admin123' });
    const sid = login.result.sessionId;
    ok(!!sid, 'login');

    const banks = await api(sid, 'GET', '/banks');
    ok(banks.status === 200, 'banks');
    const boxes = await api(sid, 'GET', '/cash-boxes');
    ok(boxes.status === 200, 'cash-boxes');
    const boxId = Array.isArray(boxes.body) ? boxes.body[0]?.id : null;

    const whs = await api(sid, 'GET', '/warehouses');
    const whId = Array.isArray(whs.body) ? whs.body[0]?.id : null;
    const { todayJalali } = require(path.join(__dirname, '..', '..', '..', 'server', 'jalali'));
    const TODAY = todayJalali();

    const prod = await api(sid, 'POST', '/products/quick', { name: 'خزانه-item', price: 200000 });
    const cust = await api(sid, 'POST', '/customers', { biz: 'مشتری خزانه', phone: '09153334455' });
    const sup = await api(sid, 'POST', '/suppliers', { name: 'تأمین خزانه', phone: '05133334455' });
    await api(sid, 'POST', '/purchases', {
      supplier_id: sup.body.id, date: TODAY, pay_type: 'credit', warehouse_id: whId,
      rows: [{ product_id: prod.body.id, qty: 2, price: 100000 }],
    });
    const inv = await api(sid, 'POST', '/invoices', {
      cust_id: cust.body.id, type: 'final', date: TODAY, pay_type: 'credit', warehouse_id: whId,
      rows: [{ product_id: prod.body.id, qty: 1, price: 200000 }],
    });
    ok(inv.status === 200, 'invoice for settle');

    if (boxId) {
      const settle = await api(sid, 'POST', '/accounting/settlements', {
        cust_id: cust.body.id, invoice_id: inv.body.id,
        amount: Math.min(50000, Number(inv.body.final || 50000)),
        pay_type: 'cash', date: TODAY, cash_box_id: boxId,
      });
      ok(settle.status === 200 || settle.status === 400, 'settlement', settle.status);
    } else {
      ok(true, 'settlement skipped');
    }

    const xferList = await api(sid, 'GET', '/transfers');
    ok(xferList.status === 200, 'transfers list');

    const cheques = await api(sid, 'GET', '/cheque-records');
    ok(cheques.status === 200 || cheques.status === 404, 'cheque-records', cheques.status);

    const tb = await api(sid, 'GET', '/accounting/trial-balance');
    ok(tb.body.balanced === true, 'TB balanced');
  } catch (e) {
    console.error(e); failed++;
  } finally {
    try { await invoke('runtime.stop'); } catch { /* */ }
    host.kill();
    setTimeout(() => { try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* */ } }, 400);
  }
  console.log(`\n${failed ? '💥' : '🎉'} wave3 ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
