'use strict';
/**
 * B2B company credit MVP — unit + HTTP concurrent reserve/release.
 * Run: node server/scripts/test-b2b-credit.js
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const PORT = 3500 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-b2b-credit-'));
const DB_PATH = path.join(TMP, 'test.db');
const JWT_SECRET = 'b2b-credit-test-secret-explicit-32b';

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { passed += 1; console.log('  ✅ ' + name); }
  else { failed += 1; console.log('  ❌ ' + name); }
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
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(BASE + '/api/system/time');
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

function runUnitCreditTests() {
  console.log('— unit credit engine —');
  const unitDbPath = path.join(TMP, 'unit-credit.db');
  const db = new Database(unitDbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, biz TEXT);
    CREATE TABLE b2b_portal_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER UNIQUE NOT NULL,
      phone TEXT, password TEXT, active INTEGER DEFAULT 1
    );
  `);
  require('../lib/b2b/schema').initB2bSchema(db);
  const {
    reserveCredit, releaseCredit, consumeCredit, getCreditSnapshot, CreditError,
  } = require('../lib/b2b/credit');

  db.prepare('INSERT INTO customers (id,biz) VALUES (1,?)').run('شرکت تست');
  db.prepare('INSERT INTO b2b_portal_accounts (customer_id,phone,active) VALUES (1,?,1)').run('09151111111');
  const companyId = db.prepare(`
    INSERT INTO b2b_companies (customer_id,name,credit_limit_rial,active) VALUES (1,?,?,1)
  `).run('شرکت تست', 1_000_000).lastInsertRowid;

  db.transaction(() => {
    reserveCredit(db, { companyId, orderId: 101, amountRial: 600_000 });
  })();
  let snap = getCreditSnapshot(db, companyId);
  ok(snap.reserved_rial === 600_000 && snap.available_rial === 400_000, 'reserve reduces available');

  let blocked = false;
  try {
    db.transaction(() => {
      reserveCredit(db, { companyId, orderId: 102, amountRial: 500_000 });
    })();
  } catch (e) {
    blocked = e instanceof CreditError && e.code === 'INSUFFICIENT_CREDIT';
  }
  ok(blocked, 'over-limit reserve rejected');

  db.transaction(() => {
    releaseCredit(db, { companyId, orderId: 101 });
  })();
  snap = getCreditSnapshot(db, companyId);
  ok(snap.reserved_rial === 0 && snap.available_rial === 1_000_000, 'release restores available');

  db.transaction(() => {
    reserveCredit(db, { companyId, orderId: 201, amountRial: 300_000 });
    consumeCredit(db, { companyId, orderId: 201, amountRial: 300_000 });
  })();
  snap = getCreditSnapshot(db, companyId);
  ok(snap.used_rial === 300_000 && snap.reserved_rial === 0 && snap.available_rial === 700_000,
    'consume moves reserved → used');

  // Contended reserve on a tight limit (second attempt must fail).
  db.prepare('DELETE FROM b2b_credit_ledger WHERE company_id=?').run(companyId);
  db.prepare('UPDATE b2b_companies SET credit_limit_rial=? WHERE id=?').run(100_000, companyId);
  let success = 0;
  let fail = 0;
  for (const orderId of [301, 302]) {
    try {
      db.transaction(() => {
        reserveCredit(db, { companyId, orderId, amountRial: 80_000 });
      })();
      success += 1;
    } catch (e) {
      if (e instanceof CreditError && e.code === 'INSUFFICIENT_CREDIT') fail += 1;
      else throw e;
    }
  }
  ok(success === 1 && fail === 1, 'two contended reserves → one success, one fail');
  snap = getCreditSnapshot(db, companyId);
  ok(snap.reserved_rial === 80_000 && snap.available_rial === 20_000, 'only one 80k reserve stuck');

  db.close();
}

(async () => {
  runUnitCreditTests();

  console.log('— HTTP concurrent portal orders —');
  console.log('  (port ' + PORT + ')');
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      LISTEN_HOST: '127.0.0.1',
      DB_PATH,
      UPLOADS_DIR: path.join(TMP, 'uploads'),
      JWT_SECRET,
      AUTH_SESSION_DB_PATH: path.join(TMP, 'sessions.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvLog = '';
  srv.stderr.on('data', (d) => { srvLog += d; process.stderr.write('[srv] ' + d); });
  srv.stdout.on('data', (d) => { srvLog += d; });
  srv.on('exit', (code) => {
    if (code && code !== 0) console.error('[srv exit]', code, srvLog.slice(-2000));
  });

  try {
    await waitUp();
    let login = await j('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
    if (login.data && login.data.must_change_password) {
      const chg = await j('POST', '/api/auth/change-password', {
        oldPass: 'admin123', newPass: 'AdmB2b!credit9',
      }, login.data.token);
      if (chg.status !== 200) throw new Error('admin change-password failed');
      login = await j('POST', '/api/auth/login', { username: 'admin', password: 'AdmB2b!credit9' });
    }
    const admin = login.data.token;

    await j('PUT', '/api/settings', { feature_b2b_portal: '1' }, admin);
    const cust = await j('POST', '/api/customers', {
      biz: 'شرکت اعتباری', owner: 'تست', phone: '09152222222',
    }, admin);
    const custId = cust.data.id;
    ok(!!custId, 'customer created');

    let r = await j('POST', `/api/b2b/admin/customers/${custId}/access`, {
      enabled: true, phone: '09152222222', password: 'secret99',
    }, admin);
    ok(r.status === 200, 'portal access enabled');

    r = await j('POST', `/api/b2b/admin/customers/${custId}/company`, {
      name: 'شرکت اعتباری', credit_limit_rial: 500_000, active: true, role: 'admin',
    }, admin);
    ok(r.status === 200 && r.data.company?.credit_limit_rial === 500_000, 'admin links customer→company');
    ok(r.data.company?.available_rial === 500_000, 'initial available = limit');

    r = await j('POST', '/api/b2b/auth/login', { phone: '09152222222', password: 'secret99' });
    ok(r.status === 200 && r.data.token, 'portal login still works with company');
    const b2bToken = r.data.token;

    r = await j('GET', '/api/b2b/me', null, b2bToken);
    ok(r.status === 200 && r.data.company_id && r.data.role === 'admin', 'me exposes company_id + role');

    const prod = await j('POST', '/api/products/quick', { name: 'کالا اعتبار', price: 300_000 }, admin);
    const prodId = prod.data.id;

    const [a, b] = await Promise.all([
      j('POST', '/api/b2b/me/orders', { rows: [{ product_id: prodId, qty: 1 }], note: 'A' }, b2bToken),
      j('POST', '/api/b2b/me/orders', { rows: [{ product_id: prodId, qty: 1 }], note: 'B' }, b2bToken),
    ]);
    const statuses = [a.status, b.status].sort();
    ok(statuses[0] === 200 && statuses[1] === 409, 'concurrent HTTP orders: one 200, one 409');
    const okOrder = a.status === 200 ? a : b;
    const failOrder = a.status === 200 ? b : a;
    ok(!!okOrder.data?.orderId, 'winning order has orderId');
    ok(failOrder.data?.code === 'INSUFFICIENT_CREDIT', 'losing order reports INSUFFICIENT_CREDIT');

    r = await j('GET', '/api/b2b/me/credit', null, b2bToken);
    ok(r.status === 200 && r.data.reserved_rial === 300_000 && r.data.available_rial === 200_000,
      'credit snapshot after concurrent reserve');

    r = await j('POST', `/api/b2b/me/orders/${okOrder.data.orderId}/cancel`, null, b2bToken);
    ok(r.status === 200 && r.data.released === 300_000, 'cancel releases reserved credit');

    r = await j('GET', '/api/b2b/me/credit', null, b2bToken);
    ok(r.status === 200 && r.data.reserved_rial === 0 && r.data.available_rial === 500_000,
      'release restores full available');

    // Login without company (second customer) still works — no credit path
    const cust2 = await j('POST', '/api/customers', {
      biz: 'بدون شرکت', owner: 'تست', phone: '09153333333',
    }, admin);
    await j('POST', `/api/b2b/admin/customers/${cust2.data.id}/access`, {
      enabled: true, phone: '09153333333', password: 'secret99',
    }, admin);
    r = await j('POST', '/api/b2b/auth/login', { phone: '09153333333', password: 'secret99' });
    ok(r.status === 200 && r.data.token, 'legacy portal login without company intact');

    console.log(`\n🎉 ${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    console.error('TEST HARNESS ERROR:', e);
    process.exitCode = 1;
  } finally {
    srv.kill();
    setTimeout(() => {
      try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
    }, 500);
  }
})();
