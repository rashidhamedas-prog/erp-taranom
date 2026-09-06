/**
 * PROD-01 — fabric roll receipt on WH-RAW (ADR-007).
 * Run: node server/scripts/test-prod-01-fabric-rolls.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-01-fabric-'));
const dbFile = path.join(dir, 't.db');
try { fs.unlinkSync(dbFile); } catch (_) {}
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-prod-01-fabric-secret-32-bytes-min';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

delete require.cache[require.resolve('../db')];
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

function gl(code) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}),0) AS b
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0
  `).get(code);
  return Math.round(Number(row && row.b) || 0);
}

(async () => {
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'prod-01', device_fingerprint: 'prod-01-fp',
  }).token;
  const salesId = db.prepare(`
    INSERT INTO users (name, username, password, role, active, must_change_password)
    VALUES ('فروشنده طاقه','sales.fab',?, 'field_sales', 1, 0)
  `).run(bcrypt.hashSync('SalesFab9', 10)).lastInsertRowid;
  const salesUser = db.prepare('SELECT id,username,role,name,phone,auth_epoch FROM users WHERE id=?').get(salesId);
  const salesTok = issueStaffSession(db, salesUser, {
    device_kind: 'test', device_name: 'prod-01-sales', device_fingerprint: 'prod-01-sales-fp',
  }).token;

  const app = express();
  app.use(express.json());
  app.use('/api/inventory', require('../routes/inventory'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const BASE = `http://127.0.0.1:${port}`;

  async function api(method, p, body, tok) {
    const res = await fetch(BASE + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (tok || token),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }

  const raw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get();
  const fg = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get();
  ok(!!raw && !!raw.id, 'WH-RAW exists');
  ok(!!fg && !!fg.id, 'WH-FG exists');
  const col = db.prepare("PRAGMA table_info(inventory_batches)").all().some((c) => c.name === 'kind');
  ok(col, 'inventory_batches.kind column');

  const prodId = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit)
    VALUES (?, 'کرپ مشکی', 'FAB-01', 0, 0, 'متر')
  `).run(admin.id).lastInsertRowid;
  const supId = db.prepare(`INSERT INTO suppliers (name) VALUES ('نساجی تست')`).run().lastInsertRowid;
  const { syncSupplierToParty } = require('../lib/parties-sync');
  const partyId = syncSupplierToParty(db, supId);
  const daId = db.prepare(`
    INSERT INTO detail_accounts (code, name, linked_table, linked_id)
    VALUES ('DA-FAB-T1', 'تأمین‌کننده طاقه', 'suppliers', ?)
  `).run(supId).lastInsertRowid;
  db.prepare('UPDATE parties SET detail_account_id=? WHERE id=?').run(daId, partyId);

  console.log('\n— receive on WH-RAW —');
  const rec = await api('POST', '/api/inventory/fabric-rolls', {
    product_id: prodId,
    warehouse_id: raw.id,
    color: 'مشکی',
    pattern: 'ساده',
    width_cm: 150,
    meters: 40,
    unit: 'متر',
    unit_cost_rial: 250000,
    supplier_id: supId,
    roll_no: 'R-1001',
    date: '1405/05/29',
    idempotency_key: 'fab-1',
  });
  ok(rec.status === 200 && rec.data && rec.data.id, 'receive 200', rec.data && rec.data.error);
  ok(rec.data && rec.data.kind === 'fabric', 'kind=fabric');
  ok(rec.data && rec.data.color === 'مشکی', 'color');
  ok(Number(rec.data && rec.data.qty_on_hand) === 40, 'qty 40m');
  const stock = db.prepare('SELECT stock FROM products WHERE id=?').get(prodId).stock;
  ok(Number(stock) === 40, 'product stock 40', stock);
  ok(gl('1110') === 40 * 250000, 'GL raw 10,000,000', gl('1110'));
  ok(gl('2101') === -40 * 250000, 'GL payable credit', gl('2101'));
  const sl1 = db.prepare(`
    SELECT COALESCE(SUM(credit),0) c, COALESCE(SUM(debit),0) d
    FROM supplier_ledger WHERE supplier_id=? AND ref_type='fabric_roll' AND ref_id=?
  `).get(supId, rec.data.id);
  ok(Number(sl1.c) === 40 * 250000 && Number(sl1.d) === 0, 'supplier_ledger credit', sl1);
  const tafsili = db.prepare(`
    SELECT jl.detail_account_id FROM journal_lines jl
    JOIN journal_entries je ON je.id=jl.entry_id
    WHERE je.id=? AND COALESCE(jl.credit,0)+COALESCE(jl.credit_rial,0)>0
    LIMIT 1
  `).get(rec.data.journal_id);
  ok(Number(tafsili && tafsili.detail_account_id) === daId, 'JE tafsili via party_id', tafsili);

  const noKey = await api('POST', '/api/inventory/fabric-rolls', {
    product_id: prodId, warehouse_id: raw.id, color: 'آبی', meters: 2,
  });
  ok(noKey.status === 400, 'missing idempotency_key 400', noKey.data);

  const dup = await api('POST', '/api/inventory/fabric-rolls', {
    product_id: prodId, warehouse_id: raw.id, color: 'مشکی', meters: 1,
    unit_cost_rial: 1, supplier_id: supId, idempotency_key: 'fab-1',
  });
  ok(dup.status === 200 && dup.data && dup.data.id === rec.data.id, 'idempotent 200 same id', dup.data);

  console.log('\n— FG warehouse rejected —');
  const onFg = await api('POST', '/api/inventory/fabric-rolls', {
    product_id: prodId, warehouse_id: fg.id, color: 'سفید', meters: 5,
    unit_cost_rial: 1000, supplier_id: supId, idempotency_key: 'fab-fg',
  });
  ok(onFg.status === 400, 'FG 400', onFg.data);

  const sales = await api('POST', '/api/inventory/fabric-rolls', {
    product_id: prodId, warehouse_id: raw.id, color: 'x', meters: 1, idempotency_key: 'fab-sales',
  }, salesTok);
  ok(sales.status === 403, 'field_sales 403');

  const listed = await api('GET', '/api/inventory/fabric-rolls');
  ok(listed.status === 200 && (listed.data.rows || []).length === 1, 'list 1 live roll', listed.data && listed.data.error);

  console.log('\n— R13 void —');
  const voided = await api('POST', `/api/inventory/fabric-rolls/${rec.data.id}/void`, { reason: 'تست' });
  ok(voided.status === 200 && voided.data.status === 'reversed', 'void reversed');
  ok(Number(db.prepare('SELECT stock FROM products WHERE id=?').get(prodId).stock) === 0, 'stock back to 0');
  ok(gl('1110') === 0, 'GL raw 0 after void', gl('1110'));
  ok(gl('2101') === 0, 'GL payable 0 after void', gl('2101'));
  const sl2 = db.prepare(`
    SELECT COALESCE(SUM(credit),0) c, COALESCE(SUM(debit),0) d
    FROM supplier_ledger WHERE supplier_id=? AND ref_type='fabric_roll' AND ref_id=?
  `).get(supId, rec.data.id);
  ok(Number(sl2.c) === Number(sl2.d) && Number(sl2.c) === 40 * 250000, 'supplier_ledger reversed', sl2);
  const void2 = await api('POST', `/api/inventory/fabric-rolls/${rec.data.id}/void`, {});
  ok(void2.status === 409, 'second void 409');

  server.close();
  try { closeSessionStore(); } catch (_) {}
  console.log('\nPROD-01 fabric: ' + (fail ? '❌ ' : '✅ ') + pass + ' پاس، ' + fail + ' رد');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
