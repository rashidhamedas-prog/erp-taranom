'use strict';
/**
 * Audit wave 8A — server guards + matrix defaults (#84, #95–#98, #101).
 *
 * Run:
 *   $env:DB_PATH="server/.tmp-test-artifacts/wave-test-8a.db"
 *   npm --prefix server run test:audit-8a
 *
 * Guard: refuses empty DB_PATH or basename matching crm*.db.
 * HTTP half runs only when better-sqlite3 native bindings load (Node 20/22).
 * On Node 24 Windows without rebuilt bindings: matrix + hasPermission stub + source gates still run.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const {
  fillRoleDefaults, hasPermission, assertBranchScope, applyBranchScopeSql, CLOSED_DEFAULT_NONE,
} = require('../lib/rbac');

(function guardDbPath() {
  const raw = process.env.DB_PATH || '';
  if (!raw) {
    console.error('FATAL: DB_PATH is required (refuse default crm.db). Example:');
    console.error('  $env:DB_PATH="server/.tmp-test-artifacts/wave-test-8a.db"');
    process.exit(1);
  }
  const base = path.basename(raw);
  if (/^crm.*\.db$/i.test(base)) {
    console.error('FATAL: DB_PATH looks like a production crm*.db:', base);
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

/** Minimal DB stub: no user_permissions rows → role defaults only. */
function stubDb() {
  return {
    prepare() {
      return {
        all() { return []; },
        get() { return null; },
        run() { return { changes: 0 }; },
      };
    },
  };
}

function canOpenSqlite() {
  try {
    const Database = require('better-sqlite3');
    const p = path.join(os.tmpdir(), 'audit-8a-abi-' + process.pid + '.db');
    const db = new Database(p);
    db.close();
    try { fs.unlinkSync(p); } catch { /* */ }
    return true;
  } catch (e) {
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
  let login = await req(port, 'POST', '/auth/login', { username, password });
  let tok = login.body?.token;
  if (login.body?.must_change_password && tok) {
    const np = password + 'x';
    await req(port, 'POST', '/auth/change-password', { oldPass: password, newPass: np }, tok);
    login = await req(port, 'POST', '/auth/login', { username, password: np });
    tok = login.body?.token;
    return { token: tok, password: np };
  }
  return { token: tok, password };
}

function assertRouteWired(rel, needle, label) {
  const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  ok(label, src.includes(needle), 'missing in ' + rel);
}

(async () => {
  console.log('\n══ Audit 8A RBAC guards ══\n');
  console.log('DB_PATH=', process.env.DB_PATH);
  console.log('Node=', process.version);

  const prodOp = fillRoleDefaults('production_operator');
  const store = fillRoleDefaults('store_retail');
  const acc = fillRoleDefaults('accounting');
  const fsRole = fillRoleDefaults('field_sales');
  ok('prod_op customers.create false', prodOp.customers.create === false);
  ok('prod_op banks.view false', prodOp.banks.view === false);
  ok('prod_op backup.view false', prodOp.backup.view === false);
  ok('prod_op users.view false', prodOp.users.view === false);
  ok('prod_op payroll.view false', prodOp.payroll.view === false);
  ok('prod_op journal_vouchers.view false', prodOp.journal_vouchers.view === false);
  ok('prod_op moadian.view false', prodOp.moadian.view === false);
  ok('prod_op production.create true', prodOp.production.create === true);
  ok('store banks.view false', store.banks.view === false);
  ok('store backup.view false', store.backup.view === false);
  ok('store orders.create false', store.orders.create === false);
  ok('field_sales customers.create true', fsRole.customers.create === true);
  ok('field_sales orders.create true', fsRole.orders.create === true);
  ok('field_sales banks.view false', fsRole.banks.view === false);
  ok('accounting banks.view true', acc.banks.view === true);
  ok('accounting customers.create true', acc.customers.create === true);
  ok('accounting payroll.view true', acc.payroll.view === true);
  ok('CLOSED_DEFAULT_NONE has banks+orders+rfq',
    CLOSED_DEFAULT_NONE.has('banks') && CLOSED_DEFAULT_NONE.has('orders') && CLOSED_DEFAULT_NONE.has('rfq'));

  const db = stubDb();
  const uProd = { id: 12, role: 'production_operator' };
  const uStore = { id: 13, role: 'store_retail' };
  const uAcc = { id: 10, role: 'accounting' };
  const uFs = { id: 14, role: 'field_sales' };
  const uAdmin = { id: 1, role: 'admin' };
  ok('hasPermission prod_op customers.create false', !hasPermission(db, uProd, 'customers', 'create'));
  ok('hasPermission store banks.view false', !hasPermission(db, uStore, 'banks', 'view'));
  ok('hasPermission prod_op orders.create false', !hasPermission(db, uProd, 'orders', 'create'));
  ok('hasPermission prod_op rfq.create false', !hasPermission(db, uProd, 'rfq', 'create'));
  ok('hasPermission prod_op production.create true', hasPermission(db, uProd, 'production', 'create'));
  ok('hasPermission fs customers.create true', hasPermission(db, uFs, 'customers', 'create'));
  ok('hasPermission acc banks.view true', hasPermission(db, uAcc, 'banks', 'view'));
  ok('hasPermission admin banks.view true', hasPermission(db, uAdmin, 'banks', 'view'));
  ok('hasPermission fs production.create false', !hasPermission(db, uFs, 'production', 'create'));

  let branchDenied = false;
  try {
    assertBranchScope({ id: 9, role: 'production_operator', branch_id: null }, 1);
  } catch (e) {
    branchDenied = e.code === 'E_BRANCH_SCOPE';
  }
  ok('prod_op no branch → assertBranchScope deny', branchDenied);
  let branchOk = true;
  try {
    assertBranchScope({ id: 2, role: 'accounting', branch_id: null }, 1);
  } catch (_) { branchOk = false; }
  ok('accounting no branch → assertBranchScope allow', branchOk);
  const closedSql = applyBranchScopeSql({ id: 9, role: 'field_sales', branch_id: null }, 't');
  ok('field_sales no branch → SQL fail-closed', closedSql.sql.includes('1=0'));

  assertRouteWired('routes/customers.js', "requirePermission('customers', 'create')", 'customers POST wired');
  assertRouteWired('routes/orders.js', "requirePermission('orders', 'create')", 'orders POST wired');
  assertRouteWired('routes/rfq.js', "requirePermission('rfq', 'create')", 'rfq POST wired');
  assertRouteWired('routes/banks.js', "requirePermission('banks', 'view')", 'banks GET wired');
  assertRouteWired('routes/production-mrp.js', "requirePermission('production', 'create')", 'mrp/run create wired');
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  ok('db.js uses resolveCopiedUserRole', dbSrc.includes('resolveCopiedUserRole'));
  ok('db.js no role||admin in copyUsersInto', !/u\.role\s*\|\|\s*'admin'/.test(dbSrc));

  if (!canOpenSqlite()) {
    skip('HTTP live suite', 'better-sqlite3 native ABI missing for ' + process.version + ' — run on Node 20/Iran');
    console.log('\naudit-8a:', pass, 'pass ·', fail, 'fail ·', skipped, 'skip');
    process.exit(fail ? 1 : 0);
  }

  const { pickFreePort, killProcessTree } = require('./lib/test-server-boot');
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];
  const PORT = await pickFreePort(0, { allowFallback: true });
  const artifactDir = path.resolve(process.env.DB_PATH, '..');
  fs.mkdirSync(artifactDir, { recursive: true });
  const DB_PATH = path.resolve(process.env.DB_PATH);
  try { fs.unlinkSync(DB_PATH); } catch { /* fresh */ }
  try { fs.unlinkSync(DB_PATH + '-wal'); } catch { /* */ }
  try { fs.unlinkSync(DB_PATH + '-shm'); } catch { /* */ }

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-8a-'));
  const env = {
    ...process.env,
    PORT: String(PORT), LISTEN_HOST: '127.0.0.1',
    DB_PATH,
    COMPANIES_DIR: path.join(TMP, 'c'),
    JWT_SECRET: 'audit-8a-rbac-guards-secret-32ch!!',
    SYNC_ROLE: 'central', NODE_ENV: 'test', SMS_DISABLED: '1', MOADIAN_ENABLED: '0',
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
        if ((await req(PORT, 'GET', '/system/health')).status === 200) { up = true; break; }
      } catch { /* boot */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    ok('server up', up, stderr.slice(-400));
    if (!up) throw new Error('server down');

    const adminLogin = await loginAs(PORT, 'admin', 'admin123');
    ok('admin login', !!adminLogin.token);
    const adminTok = adminLogin.token;

    async function makeUser(role, username) {
      const created = await req(PORT, 'POST', '/admin/users', {
        name: '8A ' + role, username, password: 'Audit8a#1405', role,
      }, adminTok);
      ok(`create user ${role}`, created.status === 200 || created.status === 201, created.body?.error);
      const lg = await loginAs(PORT, username, 'Audit8a#1405');
      ok(`login ${role}`, !!lg.token);
      return lg.token;
    }

    const prodTok = await makeUser('production_operator', 'qa8a_prod_op');
    const storeTok = await makeUser('store_retail', 'qa8a_store');
    const accTok = await makeUser('accounting', 'qa8a_acc');
    const fsTok = await makeUser('field_sales', 'qa8a_fs');

    const custBody = { biz: 'تست ۸A', phone: '09120000001', city: 'مشهد', client_request_id: '8a-' + Date.now() };
    ok('prod_op POST /customers → 403', (await req(PORT, 'POST', '/customers', custBody, prodTok)).status === 403);
    ok('store POST /customers → 403', (await req(PORT, 'POST', '/customers', custBody, storeTok)).status === 403);
    const fsCust = await req(PORT, 'POST', '/customers', { ...custBody, biz: 'تست ۸A فروش', client_request_id: '8a-fs-' + Date.now() }, fsTok);
    ok('field_sales POST /customers allow', fsCust.status < 400, 'status=' + fsCust.status);
    const accCust = await req(PORT, 'POST', '/customers', { ...custBody, biz: 'تست ۸A حسابدار', client_request_id: '8a-acc-' + Date.now() }, accTok);
    ok('accounting POST /customers allow', accCust.status < 400, 'status=' + accCust.status);

    const orderBody = { cust_id: fsCust.body?.id || accCust.body?.id || 1, total: 1000, qty: 1 };
    ok('prod_op POST /orders → 403', (await req(PORT, 'POST', '/orders', orderBody, prodTok)).status === 403);
    ok('store POST /orders → 403', (await req(PORT, 'POST', '/orders', orderBody, storeTok)).status === 403);

    const rfqBody = { kind: 'sales', rows: [{ product_id: 1, qty: 1, price: 100 }] };
    ok('prod_op POST /rfq → 403', (await req(PORT, 'POST', '/rfq', rfqBody, prodTok)).status === 403);

    ok('prod_op GET /banks → 403', (await req(PORT, 'GET', '/banks', null, prodTok)).status === 403);
    ok('store GET /banks → 403', (await req(PORT, 'GET', '/banks', null, storeTok)).status === 403);
    ok('accounting GET /banks allow', (await req(PORT, 'GET', '/banks', null, accTok)).status === 200);
    ok('admin GET /banks allow', (await req(PORT, 'GET', '/banks', null, adminTok)).status === 200);

    const mrp = await req(PORT, 'POST', '/production/mrp/run', { horizon_days: 7 }, prodTok);
    ok('prod_op MRP not 403 (create gate)', mrp.status !== 403, 'status=' + mrp.status);
    ok('field_sales MRP → 403', (await req(PORT, 'POST', '/production/mrp/run', { horizon_days: 7 }, fsTok)).status === 403);
  } finally {
    await killProcessTree(srv);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
  }

  console.log('\naudit-8a:', pass, 'pass ·', fail, 'fail ·', skipped, 'skip');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
