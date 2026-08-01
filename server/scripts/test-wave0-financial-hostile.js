'use strict';
/**
 * Wave 0 gate: financial cycle smoke + hostile cross-company isolation.
 * API-level (stable in CI). Browser Playwright login is a separate e2e job.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w0-fin-'));
const DB = path.join(TMP, 'main.db');
const COMPANIES_DIR = path.join(TMP, 'companies');
const PORT = 4410 + Math.floor(Math.random() * 200);
const JWT_SECRET = 'wave0-financial-hostile-secret-32b';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg); }
  else { failed++; console.error('  ❌', msg); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function req(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: '127.0.0.1', port: PORT, path: '/api' + urlPath, method,
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

async function waitHealth(timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await req('GET', '/system/health');
      if (r.status === 200) return;
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('server health timeout');
}

async function loginAdmin() {
  let login = await req('POST', '/auth/login', { username: 'admin', password: 'admin123' });
  let token = login.body?.token;
  let pass = 'admin123';
  if (login.body?.must_change_password) {
    const ch = await req('POST', '/auth/change-password', {
      oldPass: 'admin123', newPass: 'AdminWave0#1405',
    }, token);
    assert(ch.status === 200, 'force password change');
    pass = 'AdminWave0#1405';
    login = await req('POST', '/auth/login', { username: 'admin', password: pass });
    token = login.body?.token;
  } else if (!token) {
    // After company switch, sessions are revoked — login with current password.
    login = await req('POST', '/auth/login', { username: 'admin', password: 'AdminWave0#1405' });
    if (login.body?.token) {
      token = login.body.token;
      pass = 'AdminWave0#1405';
    }
  }
  assert(!!token, 'admin login');
  return { token, pass };
}

async function relogin(pass) {
  const login = await req('POST', '/auth/login', { username: 'admin', password: pass });
  assert(login.status === 200 && !!login.body?.token, 're-login after company switch');
  return login.body.token;
}

async function main() {
  console.log('TMP', TMP, 'PORT', PORT);
  fs.mkdirSync(COMPANIES_DIR, { recursive: true });
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: DB,
      COMPANIES_DIR,
      JWT_SECRET,
      SYNC_ROLE: 'central',
      LISTEN_HOST: '127.0.0.1',
      NODE_ENV: 'test',
      ALLOWED_ORIGINS: 'http://127.0.0.1:' + PORT,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  try {
    await waitHealth();
    const { token: loginToken, pass } = await loginAdmin();
    let token = loginToken;

    // ── Financial smoke: customer → product → final invoice ─────────────
    const cust = await req('POST', '/customers', {
      biz: 'مشتری تست موج‌صفر', owner: 'تست', city: 'مشهد', phone: '09120000001', status: 'active',
    }, token);
    assert(cust.status === 200 || cust.status === 201, 'create customer: ' + JSON.stringify(cust.body));
    const custId = cust.body?.id || cust.body?.customer?.id;
    assert(!!custId, 'customer id');

    const prod = await req('POST', '/products', {
      name: 'کالای تست موج‌صفر', code: 'W0-P1', price: 100000, stock: 50, unit: 'عدد',
    }, token);
    assert(prod.status === 200 || prod.status === 201, 'create product: ' + JSON.stringify(prod.body));
    const prodId = prod.body?.id || prod.body?.product?.id;
    assert(!!prodId, 'product id');

    const inv = await req('POST', '/invoices', {
      cust_id: custId,
      type: 'final',
      rows: [{ product_id: prodId, qty: 2, price: 100000 }],
      pay_type: 'credit',
    }, token);
    assert(inv.status === 200 || inv.status === 201, 'create final invoice: ' + JSON.stringify(inv.body));
    const invId = inv.body?.id || inv.body?.invoice?.id;
    assert(!!invId, 'invoice id');
    const invNum = inv.body?.num || inv.body?.invoice?.num;
    assert(!!invNum, 'invoice number allocated');

    const getInv = await req('GET', '/invoices/' + invId, null, token);
    assert(getInv.status === 200, 'get invoice');
    assert(Number(getInv.body?.final || getInv.body?.total || 0) > 0 || !!getInv.body?.id, 'invoice has amount/id');

    // ── Hostile cross-company: data in A must not appear after activate B ─
    const cos = await req('GET', '/companies', null, token);
    assert(cos.status === 200, 'list companies');
    const defaultId = cos.body.activeCompanyId;

    const created = await req('POST', '/companies', {
      name: 'شرکت ایزوله موج‌صفر',
      code: 'W0H',
      fiscal_label: 'سال تست',
      start_date: '1405/01/01',
      activate: false,
    }, token);
    assert(created.status === 200 && created.body?.ok, 'create company B: ' + JSON.stringify(created.body));
    const bId = created.body.company.id;

    const actB = await req('POST', `/companies/${bId}/activate`, {}, token);
    assert(actB.status === 200 && actB.body?.ok, 'activate company B');
    // Company switch revokes all staff sessions (P0-S3) — must re-authenticate.
    token = await relogin(pass);

    const listB = await req('GET', '/invoices', null, token);
    assert(listB.status === 200, 'list invoices on B');
    const rowsB = Array.isArray(listB.body) ? listB.body : (listB.body?.invoices || []);
    assert(!rowsB.some((i) => i.id === invId || i.num === invNum), 'hostile: company B must not see company A invoice');

    const leak = await req('GET', '/invoices/' + invId, null, token);
    assert(leak.status === 404 || leak.status === 403 || !leak.body?.id || leak.body?.id !== invId,
      'hostile: direct GET invoice id from A must not succeed on B (' + leak.status + ')');

    const back = await req('POST', `/companies/${defaultId}/activate`, {}, token);
    assert(back.status === 200, 'return to company A');
    token = await relogin(pass);
    const again = await req('GET', '/invoices/' + invId, null, token);
    assert(again.status === 200 && (again.body?.id === invId || again.body?.num === invNum), 'invoice still on A');

    // cleanup B
    let delCo = await req('DELETE', `/companies/${bId}`, { confirm_password: pass }, token);
    if (delCo.status === 400 && /DELETE-COMPANY/.test(delCo.body?.error || '')) {
      delCo = await req('DELETE', `/companies/${bId}`, {
        confirm_password: pass,
        confirm_text: 'DELETE-COMPANY',
      }, token);
    }
    assert(delCo.status === 200, 'delete company B');

  } catch (e) {
    console.error('FATAL', e);
    failed++;
    if (stderr) console.error('SERVER STDERR:\n', stderr.slice(-2500));
  } finally {
    try { child.kill('SIGTERM'); } catch { /* */ }
    await sleep(400);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
  }

  console.log(`\nWave0 financial/hostile: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
