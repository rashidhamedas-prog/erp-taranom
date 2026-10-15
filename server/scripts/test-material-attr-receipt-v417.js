/**
 * v417 — attributed material receipt (kind=attr) + fabric regression + cutting isolation.
 * Run: node server/scripts/test-material-attr-receipt-v417.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-attr-v417-'));
const dbFile = path.join(dir, 't.db');
try { fs.unlinkSync(dbFile); } catch (_) {}
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-material-attr-v417-secret-32b-min';
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

(async () => {
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'v417', device_fingerprint: 'v417-fp',
  }).token;

  const rawWh = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get();
  ok(!!rawWh, 'WH-RAW exists');

  const meterProd = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit)
    VALUES (?, 'کرپ v417', 'FAB-V417', 0, 0, 'متر')
  `).run(admin.id).lastInsertRowid;
  const btnProd = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit)
    VALUES (?, 'دکمه v417', 'BTN-V417', 0, 0, 'عدد')
  `).run(admin.id).lastInsertRowid;
  const supId = db.prepare(`INSERT INTO suppliers (name) VALUES ('تأمین v417')`).run().lastInsertRowid;
  try {
    const { syncSupplierToParty } = require('../lib/parties-sync');
    syncSupplierToParty(db, supId);
  } catch (_) { /* optional */ }

  const app = express();
  app.use(express.json());
  app.use('/api/inventory', require('../routes/inventory'));
  const {
    listFabricRolls, resolveReceiptProfile, isMeterProductUnit,
  } = require('../lib/inventory/fabric-rolls');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const BASE = `http://127.0.0.1:${port}`;

  async function api(method, p, body) {
    const res = await fetch(BASE + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }

  ok(isMeterProductUnit('متر'), 'isMeterProductUnit متر');
  ok(!isMeterProductUnit('عدد'), 'isMeterProductUnit عدد');
  ok(resolveReceiptProfile({ unit: 'متر' }, {}) === 'fabric', 'auto fabric for meter');
  ok(resolveReceiptProfile({ unit: 'عدد' }, {}) === 'attr', 'auto attr for pcs');
  ok(resolveReceiptProfile({ unit: 'عدد' }, { profile: 'fabric' }) === 'fabric', 'explicit fabric override');

  const fabric = await api('POST', '/api/inventory/fabric-rolls', {
    product_id: meterProd,
    warehouse_id: rawWh.id,
    color: 'مشکی',
    pattern: 'ساده',
    width_cm: 150,
    meters: 12,
    unit_cost_rial: 10000,
    supplier_id: supId,
    unit: 'm',
    profile: 'fabric',
    idempotency_key: 'v417-fab-1',
  });
  ok(fabric.status === 200 && fabric.data && fabric.data.kind === 'fabric', 'receive fabric', fabric.data && fabric.data.error);
  ok(Number(fabric.data && fabric.data.qty_on_hand) === 12, 'fabric qty 12');

  const attr = await api('POST', '/api/inventory/fabric-rolls', {
    product_id: btnProd,
    warehouse_id: rawWh.id,
    color: 'طلایی',
    pattern: 'بسته ۲۰تایی',
    qty: 200,
    unit_cost_rial: 500,
    supplier_id: supId,
    profile: 'attr',
    quality_grade: 'A',
    idempotency_key: 'v417-attr-1',
  });
  ok(attr.status === 200 && attr.data && attr.data.kind === 'attr', 'receive attr', attr.data && (attr.data.error || attr.data.message));
  ok(Number(attr.data && attr.data.qty_on_hand) === 200, 'attr qty 200');
  ok(String(attr.data && attr.data.unit || '') === 'عدد' || String(attr.data && attr.data.unit) === 'pcs', 'attr unit', attr.data && attr.data.unit);

  const onlyFabric = listFabricRolls(db, { kind: 'fabric' });
  ok(onlyFabric.every((r) => r.kind === 'fabric'), 'list kind=fabric excludes attr');
  ok(onlyFabric.some((r) => Number(r.id) === Number(fabric.data.id)), 'list includes fabric roll');

  const all = listFabricRolls(db, { kind: 'all' });
  ok(all.some((r) => r.kind === 'attr') && all.some((r) => r.kind === 'fabric'), 'list kind=all has both');

  const listApi = await api('GET', '/api/inventory/fabric-rolls?kind=all');
  ok(listApi.status === 200 && (listApi.data.rows || []).length >= 2, 'GET kind=all');

  const defaultList = await api('GET', '/api/inventory/fabric-rolls');
  const defRows = (defaultList.data && defaultList.data.rows) || [];
  ok(defRows.every((r) => r.kind === 'fabric'), 'GET default is fabric-only (cutting safety)');
  ok(defRows.length === 1, 'default list only fabric live row', defRows.length);

  const voidAttr = await api('POST', `/api/inventory/fabric-rolls/${attr.data.id}/void`, { reason: 'test' });
  ok(voidAttr.status === 200 && voidAttr.data && voidAttr.data.status === 'reversed', 'void attr unused');

  const idem = await api('POST', '/api/inventory/fabric-rolls', {
    product_id: btnProd,
    warehouse_id: rawWh.id,
    qty: 5,
    profile: 'attr',
    unit_cost_rial: 0,
    idempotency_key: 'v417-attr-1',
  });
  ok(idem.status === 200 && Number(idem.data && idem.data.id) === Number(attr.data.id), 'idempotency returns same batch');

  const batches = await api('GET', '/api/inventory/batches');
  const batchRows = (batches.data && batches.data.rows) || [];
  ok(!batchRows.some((r) => r.kind === 'fabric' || r.kind === 'attr'), 'generic batches exclude tracked kinds');

  server.close();
  try { closeSessionStore(); } catch (_) {}
  console.log('\nv417 material-attr: ' + (fail ? '❌ ' : '✅ ') + pass + ' پاس، ' + fail + ' رد');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
