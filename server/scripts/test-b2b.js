// Smoke test for the B2B customer portal (ported from CRM v4).
// Boots a real server on a temp DB and exercises the portal end-to-end:
// feature flag, account provisioning, login (password + OTP), token scope
// isolation, catalog, order → proforma invoice, statement, access revocation.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const PORT = 3478;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-b2b-'));
const DB_PATH = path.join(TMP, 'test.db');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name); }
}

async function j(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-json */ }
  return { status: res.status, data };
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/system/time'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('server did not start');
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH, UPLOADS_DIR: path.join(TMP, 'uploads'), JWT_SECRET: 'b2b-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  try {
    await waitUp();
    const login = await j('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
    const admin = login.data.token;

    console.log('— feature flag —');
    let r = await j('POST', '/api/b2b/auth/login', { phone: '09150000001', password: 'whatever1' });
    ok(r.status === 403, 'portal login rejected while feature is off');
    r = await j('GET', '/api/system/app-info');
    ok(r.status === 200 && r.data.b2b_portal === false, 'app-info reports portal off');

    r = await j('PUT', '/api/settings', { feature_b2b_portal: '1' }, admin);
    ok(r.status === 200, 'admin enables feature_b2b_portal');
    r = await j('GET', '/api/system/app-info');
    ok(r.status === 200 && r.data.b2b_portal === true, 'app-info reports portal on');

    console.log('— account provisioning —');
    r = await j('POST', '/api/customers', { biz: 'بوتیک آزمون', owner: 'تست', phone: '09150000001' }, admin);
    const custId = r.data.id;
    ok(!!custId, 'customer created');

    r = await j('POST', `/api/b2b/admin/customers/${custId}/access`, { enabled: true, phone: '09150000001', password: '123' }, admin);
    ok(r.status === 400, 'short password rejected');
    r = await j('POST', `/api/b2b/admin/customers/${custId}/access`, { enabled: true, phone: '09150000001', password: 'secret99' }, admin);
    ok(r.status === 200 && r.data.enabled === true, 'B2B access enabled with password');

    r = await j('GET', '/api/customers', null, admin);
    ok(r.status === 200 && r.data.find(c => c.id === custId)?.b2b_enabled === 1, 'customer carries b2b_enabled flag');

    console.log('— portal auth —');
    r = await j('POST', '/api/b2b/auth/login', { phone: '09150000001', password: 'wrongpass' });
    ok(r.status === 401, 'wrong password rejected');
    r = await j('POST', '/api/b2b/auth/login', { phone: '۰۹۱۵۰۰۰۰۰۰۱', password: 'secret99' });
    ok(r.status === 200 && r.data.token && r.data.customer.id === custId, 'login works (Persian digits normalized)');
    const b2bToken = r.data.token;

    r = await j('GET', '/api/customers', null, b2bToken);
    ok(r.status === 401, 'B2B token rejected by internal staff API');
    r = await j('GET', '/api/b2b/me/catalog', null, admin);
    ok(r.status === 401, 'staff token rejected by portal API');

    console.log('— OTP login —');
    r = await j('POST', '/api/b2b/auth/otp', { phone: '09159999999' });
    ok(r.status === 200 && r.data.ok, 'OTP request for unknown phone → uniform response (no enumeration)');
    r = await j('POST', '/api/b2b/auth/otp', { phone: '09150000001' });
    ok(r.status === 200 && r.data.ok, 'OTP request accepted');
    // No SMS provider in test env — plant a known OTP hash directly in the DB
    const Database = require('better-sqlite3');
    const tdb = new Database(DB_PATH);
    tdb.prepare('UPDATE b2b_portal_accounts SET otp_hash=?, otp_expires=? WHERE customer_id=?')
      .run(crypto.createHash('sha256').update('123456').digest('hex'), Math.floor(Date.now() / 1000) + 300, custId);
    tdb.close();
    r = await j('POST', '/api/b2b/auth/otp/verify', { phone: '09150000001', code: '999999' });
    ok(r.status === 401, 'wrong OTP rejected');
    r = await j('POST', '/api/b2b/auth/otp/verify', { phone: '09150000001', code: '123456' });
    ok(r.status === 200 && r.data.token, 'correct OTP → token');

    console.log('— catalog & ordering —');
    r = await j('POST', '/api/products/quick', { name: 'مانتو تست', price: 250000 }, admin);
    const prodId = r.data.id;
    ok(!!prodId, 'product created');

    r = await j('GET', '/api/b2b/me/catalog', null, b2bToken);
    ok(r.status === 200 && r.data.some(p => p.id === prodId), 'catalog lists product');

    r = await j('POST', '/api/b2b/me/orders', { rows: [] }, b2bToken);
    ok(r.status === 400, 'empty order rejected');
    r = await j('POST', '/api/b2b/me/orders', { rows: [{ product_id: prodId, qty: 3, price: 1 }], note: 'تست' }, b2bToken);
    ok(r.status === 200 && r.data.ok && r.data.invoiceNum, 'order placed → proforma invoice number');
    const invNum = r.data.invoiceNum;

    r = await j('GET', '/api/b2b/me/orders', null, b2bToken);
    ok(r.status === 200 && r.data.length === 1 && r.data[0].invoice_num === invNum, 'order history shows order + invoice num');
    ok(r.data[0].rows[0].sum === 750000, 'server-side price used (client price:1 ignored)');

    r = await j('GET', '/api/b2b/me/invoices', null, b2bToken);
    ok(r.status === 200 && r.data.some(i => i.num === invNum && i.type === 'proforma'), 'portal invoice list shows proforma');

    r = await j('GET', '/api/invoices', null, admin);
    ok(r.status === 200 && r.data.some(i => i.num === invNum), 'staff invoice list contains portal proforma');

    r = await j('GET', '/api/b2b/admin/orders', null, admin);
    ok(r.status === 200 && r.data.length === 1 && r.data[0].cust_biz === 'بوتیک آزمون', 'admin orders queue lists order');

    r = await j('GET', '/api/messages', null, admin);
    ok(r.status === 200, 'salesperson notification message endpoint ok');

    console.log('— statement & revocation —');
    r = await j('GET', '/api/b2b/me/statement', null, b2bToken);
    ok(r.status === 200 && r.data.customer && r.data.customer.salesperson === undefined, 'statement works, internal fields stripped');

    r = await j('POST', `/api/b2b/admin/customers/${custId}/access`, { enabled: false }, admin);
    ok(r.status === 200 && r.data.enabled === false, 'access revoked');
    r = await j('GET', '/api/b2b/me/catalog', null, b2bToken);
    ok(r.status === 401, 'revoked account token no longer works');

    console.log(`\n🎉 ${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    console.error('TEST HARNESS ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    srv.kill();
    setTimeout(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }, 500);
  }
})();
