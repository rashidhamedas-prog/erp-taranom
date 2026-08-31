/**
 * v181 — dashboard books align (unique COA) + live fabric meters + circulation.
 * Run: node server/scripts/test-ops-v181.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-v181-'));
const dbFile = path.join(dir, 't.db');
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-ops-v181-secret-at-least-32-bytes';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const { postToLedger } = require('../lib/ledger');
const { acct } = require('../lib/coa-map');
const { rialToLedger } = require('../lib/money');
const { consumeFabricRollOnSale } = require('../lib/inventory/fabric-rolls');
const { postInventoryMovement } = require('../lib/inventory/ledger');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

(async () => {
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'ops-v181', device_fingerprint: 'ops-v181-fp',
  }).token;

  const recv = acct(db, 'coa_receivable');
  const sales = acct(db, 'coa_sales');
  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES ('11030181','تفصیلی v181','asset',?,4,1)
  `).run(recv.code);
  const custId = db.prepare(
    'INSERT INTO customers (user_id,biz,phone,coa_code,balance) VALUES (?,?,?,?,?)'
  ).run(admin.id, 'مشتری v181', '09025050811', '11030181', 0).lastInsertRowid;

  const GAP = 578_270_000;
  postToLedger(db, {
    sourceType: 'test_gl_only_v181', sourceId: custId, date: '1405/05/01',
    description: 'سند کل بدون دفتر مشتری', createdBy: admin.id,
    lines: [
      { code: '11030181', name: 'تفصیلی v181', debit: rialToLedger(GAP), credit: 0 },
      { code: sales.code, name: sales.name, debit: 0, credit: rialToLedger(GAP) },
    ],
  });

  const app = express();
  app.use(express.json());
  app.use('/api/accounting', require('../routes/accounting'));
  app.use('/api/inventory', require('../routes/inventory'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;

  async function api(method, p, body) {
    const res = await fetch(BASE + p, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }

  console.log('\n— books align v3 —');
  let r = await api('GET', '/api/accounting/overview');
  ok(r.status === 200, 'overview 200', r.data && r.data.error);
  ok(Number(r.data?.totalReceivable) === GAP, 'GL KPI = gap', r.data?.totalReceivable);
  ok(Number(r.data?.outstandingLedger) === GAP, 'ledger KPI aligned', r.data?.outstandingLedger);
  ok(r.data?.books_mismatch !== true, 'dashboard warning gone', r.data?.books_mismatch);
  const ledSum = db.prepare(
    'SELECT COALESCE(SUM(debit)-SUM(credit),0) AS bal FROM customer_ledger WHERE customer_id=?'
  ).get(custId);
  ok(Number(ledSum.bal) === GAP, 'customer_ledger signed equals GL', ledSum);
  const copied = db.prepare(
    "SELECT date, debit, ref_type FROM customer_ledger WHERE customer_id=? ORDER BY id"
  ).all(custId);
  ok(copied.some((x) => Number(x.debit) === GAP), 'ledger has the GL amount', copied);

  r = await api('GET', '/api/accounting/overview?asOf=1405/05/01');
  ok(r.data?.books_mismatch !== true, 'asOf cutoff also matched', r.data?.books_mismatch);

  console.log('\n— live fabric + circulation —');
  const raw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get();
  ok(!!raw, 'WH-RAW exists');
  const prodId = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit)
    VALUES (?, 'کرپ v181', 'FAB-181', 0, 0, 'متر')
  `).run(admin.id).lastInsertRowid;
  const supId = db.prepare("INSERT INTO suppliers (name) VALUES ('نساجی v181')").run().lastInsertRowid;

  const rec = await api('POST', '/api/inventory/fabric-rolls', {
    product_id: prodId, warehouse_id: raw.id, color: 'سرمه‌ای',
    meters: 100, unit: 'متر', unit_cost_rial: 0,
    roll_no: 'R-181', date: '1405/06/01', idempotency_key: 'fab-v181',
  });
  ok(rec.status === 200 && rec.data && rec.data.id, 'receive 100m', rec.data && rec.data.error);

  let list = await api('GET', '/api/inventory/fabric-rolls');
  let row = (list.data?.rows || []).find((x) => Number(x.id) === Number(rec.data.id));
  ok(Number(row?.qty_live) === 100 && Number(row?.qty_on_hand) === 100, 'live 100 after receive', row);

  db.transaction(() => {
    consumeFabricRollOnSale(db, { batchId: rec.data.id, qty: 30 });
    postInventoryMovement(db, {
      eventType: 'sale',
      productId: prodId,
      warehouseId: raw.id,
      qtyOut: 30,
      unitCostRial: 0,
      sourceType: 'invoice',
      sourceId: 181,
      batchId: rec.data.id,
      date: '1405/06/02',
      note: 'فروش طاقه تست v181',
      createdBy: admin.id,
    });
  })();

  list = await api('GET', '/api/inventory/fabric-rolls');
  row = (list.data?.rows || []).find((x) => Number(x.id) === Number(rec.data.id));
  ok(Number(row?.qty_live) === 70 && Number(row?.qty_on_hand) === 70, 'live 70 after sale', row);

  const circ = await api('GET', `/api/inventory/fabric-rolls/circulation?batch_id=${rec.data.id}`);
  ok(circ.status === 200 && Array.isArray(circ.data?.rows), 'circulation 200');
  ok((circ.data.rows || []).length >= 2, 'circulation has receive+sale', circ.data?.rows?.length);
  const last = (circ.data.rows || [])[(circ.data.rows || []).length - 1];
  ok(Number(last?.running_meters) === 70, 'running meters 70', last);

  server.close();
  try { closeSessionStore(); } catch (_) {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
