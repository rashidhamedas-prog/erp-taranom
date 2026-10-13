/**
 * v364 — R13 in-place amend of posted cutting lays (same lay_no/id).
 * Run: node server/scripts/test-cutting-lay-amend-v364.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-amend-v364-'));
const dbFile = path.join(dir, 't.db');
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-cut-amend-v364-secret-at-least-32-bytes!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

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
      AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
  `).get(code);
  return Math.round(Number(row && row.b) || 0);
}

(async () => {
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'cut-amend', device_fingerprint: 'cut-amend-fp',
  }).token;

  const app = express();
  app.use(express.json());
  app.use('/api/inventory', require('../routes/inventory'));
  app.use('/api/production/cutting-lays', require('../routes/production-cutting'));
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

  const raw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get();
  ok(!!raw, 'WH-RAW');

  const fgId = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, is_manufactured, item_type)
    VALUES (?, 'مانتو amend', 'AMD-FG', 0, 0, 'عدد', 1, 'finished')
  `).run(admin.id).lastInsertRowid;
  const fabId = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, average_cost_rial, item_type)
    VALUES (?, 'کرپ amend', 'AMD-FAB', 0, 0, 'متر', 200000, 'raw')
  `).run(admin.id).lastInsertRowid;
  const supId = db.prepare(`INSERT INTO suppliers (name) VALUES ('نساجی amend')`).run().lastInsertRowid;

  const rec = await api('POST', '/api/inventory/fabric-rolls', {
    product_id: fabId, warehouse_id: raw.id, color: 'مشکی', meters: 50,
    unit: 'متر', unit_cost_rial: 200000, supplier_id: supId, roll_no: 'R-AMD-1',
    date: '1405/07/10', idempotency_key: 'amd-roll-1',
  });
  ok(rec.status === 200 && rec.data && rec.data.id, 'receive roll', rec.data && rec.data.error);

  const bomLib = require('../lib/production/bom');
  const bom = bomLib.createBom(db, {
    product_id: fgId, name: 'BOM amend', base_qty: 1, yield_percent: 100,
  }, admin.id);
  bomLib.addLine(db, bom.id, {
    component_product_id: fabId, qty_per_base: 1.5, scrap_percent: 0,
    line_type: 'material', size_matrix: JSON.stringify({ '38': 1.5, '40': 1.5 }),
  }, admin.id);
  bomLib.activateBom(db, bom.id, '1405/01/01', admin.id);

  const breakdown = { '38': 2, '40': 2 };
  const posted = await api('POST', '/api/production/cutting-lays', {
    product_id: fgId, warehouse_id: raw.id, color: 'مشکی',
    marker_length_m: 2, ply_count: 3, actual_meters: 6, width_cm: 150,
    size_breakdown: breakdown,
    rolls: [{ batch_id: rec.data.id, meters: 6 }],
    date: '1405/07/10',
    idempotency_key: 'amd-lay-1',
  });
  ok(posted.status === 200 && posted.data && posted.data.id, 'post lay', posted.data && posted.data.error);
  const layId = posted.data.id;
  const layNo = posted.data.lay_no;
  ok(Number(db.prepare('SELECT qty_on_hand FROM inventory_batches WHERE id=?').get(rec.data.id).qty_on_hand) === 44, 'roll 44 after post');

  const pack = await api('POST', `/api/production/cutting-lays/${layId}/pack`, {
    idempotency_key: 'amd-pack-block',
  });
  ok(pack.status === 200 && pack.data && pack.data.id, 'pack posted', pack.data && pack.data.error);

  const blocked = await api('PUT', `/api/production/cutting-lays/${layId}`, {
    product_id: fgId, color: 'مشکی',
    marker_length_m: 2, ply_count: 4, actual_meters: 8, width_cm: 150,
    size_breakdown: breakdown,
    rolls: [{ batch_id: rec.data.id, meters: 8 }],
    reason: 'should block',
  });
  ok(blocked.status === 409 && blocked.data && blocked.data.code === 'E_CUT_HAS_PACK', 'edit blocked while packed', blocked.data);

  const voidPack = await api('POST', `/api/production/cutting-lays/${layId}/pack/void`, { reason: 'برای ویرایش' });
  ok(voidPack.status === 200, 'void pack for edit', voidPack.data && voidPack.data.error);

  const prodLock = await api('PUT', `/api/production/cutting-lays/${layId}`, {
    product_id: fabId, color: 'مشکی',
    marker_length_m: 2, ply_count: 4, actual_meters: 8,
    size_breakdown: breakdown,
    rolls: [{ batch_id: rec.data.id, meters: 8 }],
  });
  ok(prodLock.status === 400 && prodLock.data && prodLock.data.code === 'E_CUT_PRODUCT_LOCKED', 'product locked', prodLock.data);

  const amended = await api('PUT', `/api/production/cutting-lays/${layId}`, {
    product_id: fgId, warehouse_id: raw.id, color: 'مشکی',
    marker_length_m: 2, ply_count: 4, actual_meters: 8, width_cm: 150,
    size_breakdown: { '38': 2, '40': 2 },
    rolls: [{ batch_id: rec.data.id, meters: 8 }],
    date: '1405/07/10',
    reason: 'اصلاح متر',
  });
  ok(amended.status === 200 && amended.data && amended.data.id === layId, 'amend same id', amended.data && amended.data.error);
  ok(amended.data.lay_no === layNo, 'same lay_no');
  ok(amended.data.status === 'posted', 'still posted');
  ok(Number(amended.data.actual_meters) === 8, 'actual 8', amended.data.actual_meters);
  ok(Number(amended.data.ply_count) === 4, 'plies 4');
  ok(Number(db.prepare('SELECT qty_on_hand FROM inventory_batches WHERE id=?').get(rec.data.id).qty_on_hand) === 42, 'roll 42 after amend');

  const postedRolls = db.prepare("SELECT * FROM cutting_lay_rolls WHERE lay_id=? AND status='posted'").all(layId);
  const reversedRolls = db.prepare("SELECT * FROM cutting_lay_rolls WHERE lay_id=? AND status='reversed'").all(layId);
  ok(postedRolls.length === 1 && Number(postedRolls[0].meters) === 8, 'one posted roll 8m');
  ok(reversedRolls.length >= 1, 'old rolls reversed');

  const issueAmt = 8 * 200000;
  ok(gl('1111') === issueAmt - Number(amended.data.waste_amount_rial || 0), 'WIP after amend', gl('1111'));
  ok(gl('1110') === 50 * 200000 - issueAmt, 'raw after amend', gl('1110'));

  const liveJe = db.prepare(`
    SELECT COUNT(*) c FROM journal_entries
    WHERE ref_type='production_material_issue' AND ref_id=?
      AND COALESCE(deleted_at,0)=0
      AND COALESCE(status,'posted') NOT IN ('reversed','void')
  `).get(layId);
  ok(Number(liveJe.c) === 1, 'exactly one live PRD-01 JE', liveJe);

  server.close();
  try { closeSessionStore(); } catch (_) {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
