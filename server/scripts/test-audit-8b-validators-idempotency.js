'use strict';
/**
 * Audit wave 8B — shared validators + client_request_id idempotency.
 *
 * Run:
 *   $env:DB_PATH="server/.tmp-test-artifacts/wave-test-8b.db"
 *   npm --prefix server run test:audit-8b
 *
 * HTTP half needs better-sqlite3 bindings (Node 20/22). Pure validator +
 * source/wiring gates always run.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const V = require('../lib/validators');
const { requireClientRequestId } = require('../lib/client-request-id');
const { swAtLeast } = require('./lib/sw-at-least');

(function guardDbPath() {
  const raw = process.env.DB_PATH || '';
  if (!raw) {
    console.error('FATAL: DB_PATH is required. Example:');
    console.error('  $env:DB_PATH="server/.tmp-test-artifacts/wave-test-8b.db"');
    process.exit(1);
  }
  const base = path.basename(raw);
  if (/^crm.*\.db$/i.test(base)) {
    console.error('FATAL: DB_PATH looks like production crm*.db:', base);
    process.exit(1);
  }
})();

let pass = 0;
let fail = 0;
let skipped = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✅', name); }
  else { fail += 1; console.log('  ❌', name, extra == null ? '' : extra); }
}
function skip(name, reason) {
  skipped += 1;
  console.log('  ⏭', name, '—', reason);
}

function canOpenSqlite() {
  try {
    const Database = require('better-sqlite3');
    const p = path.join(os.tmpdir(), 'audit-8b-abi-' + process.pid + '.db');
    const db = new Database(p);
    db.close();
    try { fs.unlinkSync(p); } catch { /* */ }
    return true;
  } catch (_) {
    return false;
  }
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

async function loginAs(port, username, password) {
  const login = await req(port, 'POST', '/auth/login', { username, password });
  return login.body?.token || null;
}

function startServer(dbPath, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '../server.js')], {
      env: {
        ...process.env,
        DB_PATH: dbPath,
        PORT: String(port),
        JWT_SECRET: 'audit-8b-test-secret',
        SYNC_ROLE: 'central',
        NODE_ENV: 'test',
      },
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    const onData = (buf) => {
      const t = String(buf);
      if (!ready && /listening|ERP|server/i.test(t)) {
        ready = true;
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    setTimeout(() => {
      if (!ready) { ready = true; resolve(child); }
    }, 4000);
  });
}

console.log('\n══ Audit 8B — validators + idempotency ══\n');

// --- Pure validators ---
ok('national id 10 valid sample', V.isNationalId10('0013542419'));
ok('national id rejects 1111111111', !V.isNationalId10('1111111111'));
ok('economic code 12 digits', V.isEconomicCode('123456789012'));
ok('postal 10 digits', V.isPostalCode('1234567890'));
ok('mobile 09…', V.isMobile09('09121234567'));
ok('email basic', V.isEmail('a@b.co'));
ok('jalali valid', V.isJalaliDate('1405/01/01'));
ok('jalali invalid month', !V.isJalaliDate('1405/14/01'));
ok('empty customer fields ok', (() => { try { V.validateCustomerFields({}); return true; } catch { return false; } })());
ok('bad national_id throws', (() => {
  try { V.validateCustomerFields({ national_id: '123' }); return false; }
  catch (e) { return e.code === 'E_NATIONAL_ID'; }
})());
ok('requireClientRequestId throws without key', (() => {
  try { requireClientRequestId({}); return false; }
  catch (e) { return e.code === 'E_CLIENT_REQUEST_ID'; }
})());
ok('requireClientRequestId trims', requireClientRequestId({ client_request_id: '  abc  ' }) === 'abc');

// --- Source wiring ---
const root = path.join(__dirname, '..');
const custSrc = fs.readFileSync(path.join(root, 'routes/customers.js'), 'utf8');
const invSrc = fs.readFileSync(path.join(root, 'routes/invoices.js'), 'utf8');
const accSrc = fs.readFileSync(path.join(root, 'routes/accounting.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(root, 'db.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const idxSrc = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const swSrc = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const pubVal = fs.readFileSync(path.join(root, 'public/validators.js'), 'utf8');

ok('customers POST requireClientRequestId', /requireClientRequestId/.test(custSrc));
ok('invoices POST requireClientRequestId', /requireClientRequestId/.test(invSrc));
ok('settlements POST requireClientRequestId', /router\.post\('\/settlements'[\s\S]{0,800}requireClientRequestId/.test(accSrc));
ok('account-receipts requireClientRequestId', /router\.post\('\/account-receipts'[\s\S]{0,600}requireClientRequestId/.test(accSrc));
ok('db invoices client_request_id column', /ensureColumn\(db, 'invoices', 'client_request_id'/.test(dbSrc));
ok('db customers client_request_id column', /ensureColumn\(db, 'customers', 'client_request_id'/.test(dbSrc));
ok('db settlements client_request_id column', /ensureColumn\(db, 'settlements', 'client_request_id'/.test(dbSrc));
ok('public validators.js shared', /ErpValidators/.test(pubVal));
ok('index loads validators.js', /validators\.js\?v=545/.test(idxSrc));
ok('app sends invoice client_request_id', /client_request_id\s*=\s*window\._invIdemKey/.test(appSrc));
ok('app sends customer client_request_id', /client_request_id=window\._custIdemKey/.test(appSrc));
ok('app sends settlement client_request_id', /client_request_id:window\._stlIdemKey/.test(appSrc));
ok('SW at least v545', swAtLeast(swSrc, 545));

async function httpHalf() {
  if (!canOpenSqlite()) {
    skip('HTTP idempotency suite', 'better-sqlite3 native bindings unavailable on this Node');
    return;
  }
  const dbPath = path.resolve(process.env.DB_PATH);
  try { fs.mkdirSync(path.dirname(dbPath), { recursive: true }); } catch { /* */ }
  try { fs.unlinkSync(dbPath); } catch { /* */ }
  const port = 18750 + (process.pid % 200);
  let child;
  try {
    child = await startServer(dbPath, port);
    await new Promise((r) => setTimeout(r, 1500));
    const tok = await loginAs(port, 'admin', 'admin');
    if (!tok) {
      skip('HTTP login', 'admin login failed (seed password may differ)');
      return;
    }
    const key = '8b-cust-' + Date.now();
    const body = {
      biz: 'تست ۸B', owner: 'مالک', phone: '09120001122',
      client_request_id: key,
    };
    const a = await req(port, 'POST', '/customers', body, tok);
    const b = await req(port, 'POST', '/customers', body, tok);
    ok('customer create 200', a.status === 200 && a.body && a.body.id);
    ok('customer replay same id', b.status === 200 && b.body && b.body.id === a.body.id && b.body.idempotent_replay === true);
    const miss = await req(port, 'POST', '/customers', { biz: 'بدون کلید' }, tok);
    ok('customer without key 400', miss.status === 400 && (miss.body?.code === 'E_CLIENT_REQUEST_ID' || /client_request_id/.test(miss.body?.error || '')));
    const bad = await req(port, 'POST', '/customers', {
      biz: 'بد', national_id: '123', client_request_id: '8b-bad-' + Date.now(),
    }, tok);
    ok('bad national_id 400', bad.status === 400 && bad.body?.code === 'E_NATIONAL_ID');
  } catch (e) {
    fail += 1;
    console.log('  ❌ HTTP suite error', e.message || e);
  } finally {
    if (child) try { child.kill('SIGTERM'); } catch { /* */ }
  }
}

(async () => {
  await httpHalf();
  console.log(`\n── result: ${pass} pass / ${fail} fail / ${skipped} skip ──\n`);
  process.exit(fail ? 1 : 0);
})();
