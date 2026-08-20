/**
 * PROD-02/03 — spreading + size matrix + cutting waste.
 * Run: node server/scripts/test-prod-02-cutting.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-02-cut-'));
const dbFile = path.join(dir, 't.db');
try { fs.unlinkSync(dbFile); } catch (_) {}
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-prod-02-cutting-secret-32-bytes-min';
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
    device_kind: 'test', device_name: 'prod-02', device_fingerprint: 'prod-02-fp',
  }).token;
  const salesId = db.prepare(`
    INSERT INTO users (name, username, password, role, active, must_change_password)
    VALUES ('فروشنده برش','sales.cut',?, 'field_sales', 1, 0)
  `).run(bcrypt.hashSync('SalesCut9', 10)).lastInsertRowid;
  const salesUser = db.prepare('SELECT id,username,role,name,phone,auth_epoch FROM users WHERE id=?').get(salesId);
  const salesTok = issueStaffSession(db, salesUser, {
    device_kind: 'test', device_name: 'prod-02-sales', device_fingerprint: 'prod-02-sales-fp',
  }).token;

  const app = express();
  app.use(express.json());
  app.use('/api/inventory', require('../routes/inventory'));
  app.use('/api/production/cutting-lays', require('../routes/production-cutting'));
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
  ok(!!raw && !!raw.id, 'WH-RAW exists');
  ok(!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='cutting_lays'").get(), 'cutting_lays table');

  const fgId = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, is_manufactured, item_type)
    VALUES (?, 'مانتو تست برش', 'CUT-FG', 0, 0, 'عدد', 1, 'finished')
  `).run(admin.id).lastInsertRowid;
  const fabId = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, average_cost_rial, item_type)
    VALUES (?, 'کرپ مشکی برش', 'CUT-FAB', 0, 0, 'متر', 250000, 'raw')
  `).run(admin.id).lastInsertRowid;
  const supId = db.prepare(`INSERT INTO suppliers (name) VALUES ('نساجی برش')`).run().lastInsertRowid;

  const rec = await api('POST', '/api/inventory/fabric-rolls', {
    product_id: fabId, warehouse_id: raw.id, color: 'مشکی', meters: 40,
    unit: 'متر', unit_cost_rial: 250000, supplier_id: supId, roll_no: 'R-CUT-1',
    date: '1405/05/29', idempotency_key: 'cut-roll-1',
  });
  ok(rec.status === 200 && rec.data && rec.data.id, 'receive roll 200', rec.data && rec.data.error);

  const bomLib = require('../lib/production/bom');
  const SIZE_MATRIX = { '38': 1.45, '40': 1.50 };
  const bom = bomLib.createBom(db, {
    product_id: fgId, name: 'BOM برش', base_qty: 1, yield_percent: 100,
  }, admin.id);
  bomLib.addLine(db, bom.id, {
    component_product_id: fabId, qty_per_base: 1.50, scrap_percent: 0,
    line_type: 'material', size_matrix: JSON.stringify(SIZE_MATRIX),
  }, admin.id);
  bomLib.activateBom(db, bom.id, '1405/01/01', admin.id);

  const breakdown = { '38': 2, '40': 2 };
  const preview = await api('GET',
    '/api/production/cutting-lays/preview?product_id=' + fgId
    + '&marker_length_m=2&ply_count=3&actual_meters=7'
    + '&size_breakdown=' + encodeURIComponent(JSON.stringify(breakdown)));
  ok(preview.status === 200, 'preview 200', preview.data);
  ok(Math.abs(Number(preview.data && preview.data.matrix_meters) - 5.9) < 0.001, 'matrix 5.9m', preview.data);
  ok(Number(preview.data && preview.data.planned_meters) === 6, 'planned 6m', preview.data);
  ok(Number(preview.data && preview.data.waste_abnormal_m) > 0, 'abnormal waste on 7m', preview.data);

  const sales = await api('POST', '/api/production/cutting-lays', {
    product_id: fgId, marker_length_m: 2, ply_count: 3, actual_meters: 6,
    size_breakdown: breakdown, rolls: [{ batch_id: rec.data.id, meters: 6 }],
    idempotency_key: 'cut-sales',
  }, salesTok);
  ok(sales.status === 403, 'field_sales 403');

  const noKey = await api('POST', '/api/production/cutting-lays', {
    product_id: fgId, marker_length_m: 2, ply_count: 3, actual_meters: 6,
    size_breakdown: breakdown, rolls: [{ batch_id: rec.data.id, meters: 6 }],
  });
  ok(noKey.status === 400, 'missing key 400');

  const posted = await api('POST', '/api/production/cutting-lays', {
    product_id: fgId, warehouse_id: raw.id, color: 'مشکی',
    marker_length_m: 2, ply_count: 3, actual_meters: 7, width_cm: 150,
    size_breakdown: breakdown,
    rolls: [{ batch_id: rec.data.id, meters: 7 }],
    date: '1405/05/29',
    idempotency_key: 'cut-1',
  });
  ok(posted.status === 200 && posted.data && posted.data.id, 'post lay 200', posted.data && posted.data.error);
  ok(posted.data && posted.data.status === 'posted', 'status posted');
  ok(Number(posted.data && posted.data.qty_pieces) === 4, '4 pieces');
  ok(Number(db.prepare('SELECT qty_on_hand FROM inventory_batches WHERE id=?').get(rec.data.id).qty_on_hand) === 33, 'roll 33m left');
  ok(Number(db.prepare('SELECT stock FROM products WHERE id=?').get(fabId).stock) === 33, 'fabric stock 33');
  ok(Number(db.prepare('SELECT stock FROM products WHERE id=?').get(fgId).stock) === 0, 'FG stock unchanged');
  const issueAmt = 7 * 250000;
  ok(gl('1110') === 40 * 250000 - issueAmt, 'GL raw after issue', gl('1110'));
  ok(gl('1111') === issueAmt - Number(posted.data.waste_amount_rial || 0), 'GL wip net', gl('1111'));
  ok(gl('5221') === Number(posted.data.waste_amount_rial || 0), 'GL abnormal waste', gl('5221'));
  ok(Number(posted.data.waste_abnormal_m) > 0, 'abnormal meters recorded');

  const dup = await api('POST', '/api/production/cutting-lays', {
    product_id: fgId, marker_length_m: 2, ply_count: 3, actual_meters: 7,
    size_breakdown: breakdown, rolls: [{ batch_id: rec.data.id, meters: 7 }],
    idempotency_key: 'cut-1',
  });
  ok(dup.status === 200 && dup.data && dup.data.id === posted.data.id, 'idempotent same id');

  const listed = await api('GET', '/api/production/cutting-lays');
  ok(listed.status === 200 && (listed.data.rows || []).length === 1, 'list 1 live lay');

  const voided = await api('POST', `/api/production/cutting-lays/${posted.data.id}/void`, { reason: 'تست' });
  ok(voided.status === 200 && voided.data.status === 'reversed', 'void reversed');
  ok(Number(db.prepare('SELECT qty_on_hand FROM inventory_batches WHERE id=?').get(rec.data.id).qty_on_hand) === 40, 'roll restored 40');
  ok(gl('1111') === 0, 'WIP 0 after void', gl('1111'));
  ok(gl('5221') === 0, 'waste GL 0 after void', gl('5221'));
  const void2 = await api('POST', `/api/production/cutting-lays/${posted.data.id}/void`, {});
  ok(void2.status === 409, 'second void 409');

  const mismatch = await api('POST', '/api/production/cutting-lays', {
    product_id: fgId, marker_length_m: 2, ply_count: 3, actual_meters: 6,
    size_breakdown: breakdown, rolls: [{ batch_id: rec.data.id, meters: 5 }],
    idempotency_key: 'cut-mismatch',
  });
  ok(mismatch.status === 400, 'roll sum mismatch 400');

  const full = await api('POST', '/api/production/cutting-lays', {
    product_id: fgId, warehouse_id: raw.id,
    marker_length_m: 2, ply_count: 20, actual_meters: 40,
    size_breakdown: breakdown,
    rolls: [{ batch_id: rec.data.id, meters: 40 }],
    date: '1405/05/29',
    idempotency_key: 'cut-full',
  });
  ok(full.status === 200, 'consume remaining 40m', full.data && full.data.error);
  ok(db.prepare('SELECT status FROM inventory_batches WHERE id=?').get(rec.data.id).status === 'empty', 'roll empty after full consume');
  ok(Number(db.prepare('SELECT stock FROM products WHERE id=?').get(fgId).stock) === 0, 'FG still 0 after full consume');
  const voidFull = await api('POST', `/api/production/cutting-lays/${full.data.id}/void`, { reason: 'تست خالی' });
  ok(voidFull.status === 200, 'void full consume');
  const restored = db.prepare('SELECT qty_on_hand, status FROM inventory_batches WHERE id=?').get(rec.data.id);
  ok(Number(restored.qty_on_hand) === 40 && restored.status === 'active', 'roll reactivated 40m', restored);

  server.close();
  try { closeSessionStore(); } catch (_) {}
  console.log('\nPROD-02/03 cutting: ' + (fail ? '❌ ' : '✅ ') + pass + ' پاس، ' + fail + ' رد');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
