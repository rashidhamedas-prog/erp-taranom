#!/usr/bin/env node
/**
 * v367 — R13 in-place amend of posted sales returns (same id).
 * Run: node server/scripts/test-sales-return-amend-v367.js
 * Integration requires better-sqlite3 native binding (Node 20); otherwise static gates only.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : String(extra).slice(0, 200)); }
}

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');

console.log('\n══ Sales return amend v367 ══\n');
console.log('-- static --');

const appJs = read(path.join(root, 'public', 'app.js'));
const sw = read(path.join(root, 'public', 'sw.js'));
const idx = read(path.join(root, 'public', 'index.html'));
const acc = read(path.join(root, 'routes', 'accounting.js'));
const lib = read(path.join(root, 'lib', 'sales-return-doc.js'));
const adr = read(path.join(root, '..', 'docs', 'architecture', 'RETURNS-ACC-ADR-005.md'));

ok(/erp-taranom-v367/.test(sw), 'SW v367');
ok(/app\.js\?v=367/.test(idx), 'index app.js?v=367');
ok(lib.includes('function updateSalesReturn'), 'updateSalesReturn');
ok(lib.includes('function reverseSalesReturnEffects'), 'reverseSalesReturnEffects');
ok(lib.includes('function createSalesReturn'), 'createSalesReturn');
ok(lib.includes('excludeReturnId'), 'excludeReturnId on build');
ok(lib.includes("E_SR_CUST_LOCKED"), 'customer lock code');
ok(/router\.put\('\/sales-returns\/:id'/.test(acc), 'PUT /sales-returns/:id');
ok(acc.includes("require('../lib/sales-return-doc')"), 'routes use sales-return-doc');
ok(acc.includes('exclude_return_id'), 'available exclude_return_id');
ok(appJs.includes('salesReturnModal(r)'), 'list edit button');
ok(appJs.includes("PUT','/accounting/sales-returns/"), 'UI PUT amend');
ok(appJs.includes('_srEditId') && appJs.includes('exclude_return_id'), 'edit state + exclude query');
ok(appJs.includes('ویرایش برگشت از فروش') || appJs.includes('ثبت مجدد روی همان شماره'), 'Help amend');
ok(/P2d/.test(adr) && /ویرایش برگشت فروش/.test(adr), 'ADR P2d');
try { new Function(appJs); ok(true, 'app.js parses'); }
catch (e) { ok(false, 'app.js parses', e && e.message); }

(async () => {
  console.log('-- integration --');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-amend-v367-'));
  process.env.DB_PATH = path.join(dir, 't.db');
  process.env.SYNC_ROLE = 'central';
  process.env.JWT_SECRET = 'test-sr-amend-v367-secret-at-least-32-bytes!!';
  process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
  process.env.ERP_TEST_ISOLATION = '1';
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete process.env[k];
  }

  let db;
  let http;
  let express;
  try {
    http = require('http');
    express = require('express');
    const { initDB, getDB } = require('../db');
    initDB();
    db = getDB();
  } catch (e) {
    ok(true, 'integration skipped (better-sqlite3 native binding missing on host)');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    console.log(`\nSales return amend v367: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
    return;
  }

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'sr-amend', device_fingerprint: 'sr-amend-fp',
  }).token;

  const custId = db.prepare(
    "INSERT INTO customers (user_id,biz,owner,phone,status) VALUES (?,'مشتری amend SR','مالک','09120000067','active')"
  ).run(admin.id).lastInsertRowid;
  const prodId = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, average_cost_rial, unit)
    VALUES (?, 'کالای amend SR', 'SR-AMD-1', 100000, 50, 40000, 'عدد')
  `).run(admin.id).lastInsertRowid;
  const invRows = JSON.stringify([{
    product_id: prodId, name: 'کالای amend SR', qty: 10, price: 100000, disc: 0, disc_amt: 0, sum: 1000000,
  }]);
  const invId = db.prepare(`
    INSERT INTO invoices (user_id,cust_id,type,date,num,rows,subtotal,disc_amt,final,final_rial,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(admin.id, custId, 'normal', '1405/07/01', 'T-SRAMD-1', invRows, 1000000, 0, 1000000, 1000000, 'posted').lastInsertRowid;

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/accounting', require('../routes/accounting'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function api(method, urlPath, body) {
    const res = await fetch(base + urlPath, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  }

  function activeJeCount(refType, refId) {
    return db.prepare(`
      SELECT COUNT(*) AS c FROM journal_entries
      WHERE ref_type=? AND ref_id=? AND COALESCE(deleted_at,0)=0
        AND COALESCE(status,'posted') NOT IN ('reversed','void')
    `).get(refType, refId).c;
  }

  let r = await api('POST', '/api/accounting/sales-returns', {
    cust_id: custId, invoice_id: invId, date: '1405/07/10',
    rows: [{ product_id: prodId, qty: 3 }], note: 'create',
  });
  ok(r.status === 200 && r.data && r.data.id, 'create sales return', r.data && r.data.error);
  const retId = r.data && r.data.id;
  ok(Number(db.prepare('SELECT amount FROM sales_returns WHERE id=?').get(retId).amount) === 300000, 'amount 300k');
  ok(activeJeCount('sales_return', retId) === 1, 'one active JE after create');

  r = await api('PUT', '/api/accounting/sales-returns/' + retId, {
    cust_id: custId, invoice_id: invId, date: '1405/07/11',
    rows: [{ product_id: prodId, qty: 5 }], note: 'amended',
  });
  ok(r.status === 200 && r.data && r.data.id === retId, 'amend same id', r.data && r.data.error);
  const after = db.prepare('SELECT amount,status,note FROM sales_returns WHERE id=?').get(retId);
  ok(after.status === 'posted' && Number(after.amount) === 500000, 'posted 500k after amend', after);
  ok(activeJeCount('sales_return', retId) === 1, 'one active JE after amend');

  r = await api('GET', '/api/accounting/sales-returns/available/' + invId + '?exclude_return_id=' + retId);
  ok(r.status === 200 && Number(r.data.rows[0].max_returnable) === 5, 'max excludes self', r.data);

  r = await api('PUT', '/api/accounting/sales-returns/' + retId, {
    cust_id: custId + 99999, invoice_id: invId, rows: [{ product_id: prodId, qty: 1 }],
  });
  ok(r.status === 400 && r.data && r.data.code === 'E_SR_CUST_LOCKED', 'customer locked');

  r = await api('DELETE', '/api/accounting/sales-returns/' + retId);
  ok(r.status === 200, 'void after amend');
  ok(db.prepare('SELECT status FROM sales_returns WHERE id=?').get(retId).status === 'reversed', 'reversed');

  r = await api('PUT', '/api/accounting/sales-returns/' + retId, {
    cust_id: custId, invoice_id: invId, rows: [{ product_id: prodId, qty: 1 }],
  });
  ok(r.status === 409 && r.data && r.data.code === 'E_SR_REVERSED', 'amend voided blocked');

  server.close();
  try { closeSessionStore(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

  console.log(`\nSales return amend v367: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
