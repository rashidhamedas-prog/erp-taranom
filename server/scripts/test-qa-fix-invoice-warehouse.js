'use strict';
/**
 * Regression: firm invoices require header warehouse_id; copy onto lines;
 * line warehouse override is allowed (no E_WH_MISMATCH).
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
  console.log('\n══ QA-FIX firm invoice warehouse ══\n');
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];
  const PORT = await pickFreePort(0, { allowFallback: true });
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-fix-wh-'));
  const env = {
    ...process.env,
    PORT: String(PORT),
    LISTEN_HOST: '127.0.0.1',
    DB_PATH: path.join(TMP, 't.db'),
    COMPANIES_DIR: path.join(TMP, 'c'),
    JWT_SECRET: 'qa-fix-invoice-wh-secret-32chars!!',
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
      await req(PORT, 'POST', '/auth/change-password', { oldPass: 'admin123', newPass: 'QaFixWh#1405' }, token);
      login = await req(PORT, 'POST', '/auth/login', { username: 'admin', password: 'QaFixWh#1405' });
      token = login.body?.token;
    }
    ok('admin login', !!token);

    const whs = await req(PORT, 'GET', '/warehouses', null, token);
    const list = Array.isArray(whs.body) ? whs.body : (whs.body?.data || []);
    const whA = list[0]?.id;
    const whB = list[1]?.id || (await req(PORT, 'POST', '/warehouses', { name: 'انبار QA2', code: 'QA2' }, token)).body?.id;
    ok('warehouses available', !!whA && !!whB, String(whA) + ',' + String(whB));

    const cust = await req(PORT, 'POST', '/customers', {
      biz: 'مشتری انبار QA', phone: '09152220001', city: 'مشهد', status: 'active',
    }, token);
    const custId = cust.body?.id;
    ok('customer', !!custId, cust.body?.error);

    const prod = await req(PORT, 'POST', '/products', {
      name: 'کالای انبار QA', code: 'WH-QA-1', price: 100000, cost: 40000, stock: 20,
      warehouse_id: whA, unit: 'عدد',
    }, token);
    const prodId = prod.body?.id;
    ok('product', !!prodId, prod.body?.error);

    const noWh = await req(PORT, 'POST', '/invoices', {
      cust_id: custId, type: 'final', pay_type: 'credit', date: '1405/01/15',
      rows: [{ product_id: prodId, qty: 1, price: 100000 }],
    }, token);
    ok('firm without header WH rejected', noWh.status >= 400, 'status=' + noWh.status);

    const copied = await req(PORT, 'POST', '/invoices', {
      cust_id: custId, type: 'final', pay_type: 'credit', date: '1405/01/15',
      warehouse_id: whA,
      rows: [{ product_id: prodId, qty: 1, price: 100000 }],
    }, token);
    ok('firm with header WH accepted', copied.status === 200 || copied.status === 201, copied.body?.error);
    ok('header warehouse stored', Number(copied.body?.warehouse_id) === Number(whA), String(copied.body?.warehouse_id));
    const copiedRows = Array.isArray(copied.body?.rows) ? copied.body.rows : [];
    ok('line inherited header WH', Number(copiedRows[0]?.warehouse_id) === Number(whA), JSON.stringify(copiedRows[0]));

    const override = await req(PORT, 'POST', '/invoices', {
      cust_id: custId, type: 'final', pay_type: 'credit', date: '1405/01/15',
      warehouse_id: whA,
      rows: [{ product_id: prodId, qty: 1, price: 100000, warehouse_id: whB }],
    }, token);
    ok('line WH override not E_WH_MISMATCH', override.body?.code !== 'E_WH_MISMATCH',
      'status=' + override.status + ' ' + (override.body?.code || override.body?.error || ''));
    if (override.status === 200 || override.status === 201) {
      ok('line kept override WH', Number(ovRows[0]?.warehouse_id) === Number(whB), JSON.stringify(ovRows[0]));
    } else {
      ok('override rejected only for stock/other, not mismatch', override.status >= 400 && override.body?.code !== 'E_WH_MISMATCH',
        String(override.body?.code));
    }

    const pf = await req(PORT, 'POST', '/invoices', {
      cust_id: custId, type: 'proforma', pay_type: 'credit', date: '1405/01/15',
      rows: [{ product_id: prodId, qty: 1, price: 100000 }],
    }, token);
    ok('proforma without WH still ok', pf.status === 200 || pf.status === 201, pf.body?.error);
    const convNo = await req(PORT, 'POST', `/invoices/${pf.body?.id}/convert`, { type: 'final' }, token);
    ok('convert without WH rejected', convNo.status >= 400, 'status=' + convNo.status);

    const pf2 = await req(PORT, 'POST', '/invoices', {
      cust_id: custId, type: 'proforma', pay_type: 'credit', date: '1405/01/15',
      warehouse_id: whA,
      rows: [{ product_id: prodId, qty: 1, price: 100000 }],
    }, token);
    const convOk = await req(PORT, 'POST', `/invoices/${pf2.body?.id}/convert`, { type: 'final', warehouse_id: whA }, token);
    ok('convert with WH accepted', convOk.status === 200 || convOk.status === 201, convOk.body?.error);
  } finally {
    await killProcessTree(srv);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log('\ninvoice warehouse:', pass, 'pass ·', fail, 'fail');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
