/**
 * v464 — لایه‌چینی با الزام مرکز هزینه، ضایعات ۵۲۲۱ را روی مرکز برش می‌گذارد.
 * Run: node server/scripts/test-cutting-lay-cc-v464.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const postingSrc = fs.readFileSync(path.join(__dirname, '../lib/production/posting.js'), 'utf8');
const cuttingSrc = fs.readFileSync(path.join(__dirname, '../lib/production/cutting.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

ok(appJs.includes('id="cl-cc"'), 'lay form has waste cost center');
ok(appJs.includes('مرکز هزینه ضایعات لایه‌چینی'), 'admin help');
ok(appJs.includes('ضایعات لایه‌چینی'), 'sales help');
ok(postingSrc.includes('function resolveCuttingCostCenterId'), 'resolver');
ok(cuttingSrc.includes('costCenterId: costCenterId || null'), 'lay waste JE carries CC');
ok(cuttingSrc.includes("ensureColumn") === false || cuttingSrc.includes('cost_center_id'), 'lay stores cost_center_id');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-cc-v464-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-cutting-lay-cc-v464-secret-32b';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

delete require.cache[require.resolve('../db')];
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

(async () => {
  db.prepare("INSERT INTO settings (key,value) VALUES ('require_cc_on_expense','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  const ccCut = db.prepare("SELECT id FROM cost_centers WHERE code='CC-10'").get();
  const ccSew = db.prepare("SELECT id FROM cost_centers WHERE code='CC-30'").get();
  ok(!!ccCut && !!ccSew, 'CC-10 and CC-30 seeded');

  const { resolveCuttingCostCenterId } = require('../lib/production/posting');
  ok(resolveCuttingCostCenterId(db, {}) === ccCut.id, 'empty resolves to cutting center');
  ok(resolveCuttingCostCenterId(db, { explicitId: ccSew.id }) === ccSew.id, 'explicit wins');
  let bad = '';
  try { resolveCuttingCostCenterId(db, { explicitId: 999999 }); }
  catch (e) { bad = e.code; }
  ok(bad === 'E_CC_NOT_FOUND', 'unknown center rejected', bad);

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'cut-cc', device_fingerprint: 'cut-cc-fp',
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
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }

  const raw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get();
  const fgId = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, is_manufactured, item_type)
    VALUES (?, 'مانتو مرکزبرش', 'CUT-CC-FG', 0, 0, 'عدد', 1, 'finished')
  `).run(admin.id).lastInsertRowid;
  const fabId = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, average_cost_rial, item_type)
    VALUES (?, 'کرپ مرکزبرش', 'CUT-CC-FAB', 0, 0, 'متر', 100000, 'raw')
  `).run(admin.id).lastInsertRowid;
  const supId = db.prepare(`INSERT INTO suppliers (name) VALUES ('نساجی مرکزبرش')`).run().lastInsertRowid;
  const rec = await api('POST', '/api/inventory/fabric-rolls', {
    product_id: fabId, warehouse_id: raw.id, color: 'قهوه‌ای', meters: 80,
    unit: 'متر', unit_cost_rial: 100000, supplier_id: supId, roll_no: 'R-CC-1',
    date: '1405/07/27', idempotency_key: 'cut-cc-roll',
  });
  ok(rec.status === 200 && rec.data && rec.data.id, 'roll received', rec.data && rec.data.error);

  const bomLib = require('../lib/production/bom');
  const bom = bomLib.createBom(db, {
    product_id: fgId, name: 'BOM مرکزبرش', base_qty: 1, yield_percent: 100,
  }, admin.id);
  bomLib.addLine(db, bom.id, {
    component_product_id: fabId, qty_per_base: 1.5, scrap_percent: 0,
    line_type: 'material', size_matrix: JSON.stringify({ '38': 1.2 }),
  }, admin.id);
  bomLib.activateBom(db, bom.id, '1405/01/01', admin.id);

  const breakdown = { '38': 2 };
  const posted = await api('POST', '/api/production/cutting-lays', {
    product_id: fgId, warehouse_id: raw.id, color: 'قهوه‌ای',
    marker_length_m: 2, ply_count: 3, actual_meters: 20, width_cm: 150,
    size_breakdown: breakdown,
    rolls: [{ batch_id: rec.data.id, meters: 20 }],
    date: '1405/07/27',
    idempotency_key: 'cut-cc-1',
  });
  ok(posted.status === 200 && posted.data && posted.data.id, 'lay posts under CC policy', posted.data && (posted.data.error || posted.data.message));
  ok(Number(posted.data && posted.data.waste_abnormal_m) > 0, 'abnormal meters', posted.data && posted.data.waste_abnormal_m);
  ok(Number(posted.data && posted.data.cost_center_id) === Number(ccCut.id), 'lay stored CC-10', posted.data && posted.data.cost_center_id);

  const line = db.prepare(`
    SELECT jl.cost_center_id
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.account_code='5221' AND je.ref_id=? AND COALESCE(je.deleted_at,0)=0
    ORDER BY jl.id DESC LIMIT 1
  `).get(posted.data.id);
  ok(line && Number(line.cost_center_id) === Number(ccCut.id), '5221 line is cutting center', line);

  const override = await api('POST', '/api/production/cutting-lays', {
    product_id: fgId, warehouse_id: raw.id, color: 'قهوه‌ای',
    marker_length_m: 2, ply_count: 2, actual_meters: 10, width_cm: 150,
    size_breakdown: breakdown,
    cost_center_id: ccSew.id,
    rolls: [{ batch_id: rec.data.id, meters: 10 }],
    date: '1405/07/27',
    idempotency_key: 'cut-cc-2',
  });
  ok(override.status === 200, 'explicit center posts', override.data && (override.data.error || override.data.message));
  const line2 = db.prepare(`
    SELECT jl.cost_center_id
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.account_code='5221' AND je.ref_id=? AND COALESCE(je.deleted_at,0)=0
    ORDER BY jl.id DESC LIMIT 1
  `).get(override.data && override.data.id);
  ok(line2 && Number(line2.cost_center_id) === Number(ccSew.id), '5221 follows explicit center', line2);

  const missing = await api('POST', '/api/production/cutting-lays', {
    product_id: fgId, warehouse_id: raw.id, color: 'قهوه‌ای',
    marker_length_m: 2, ply_count: 1, actual_meters: 5, width_cm: 150,
    size_breakdown: breakdown,
    cost_center_id: 999999,
    rolls: [{ batch_id: rec.data.id, meters: 5 }],
    date: '1405/07/27',
    idempotency_key: 'cut-cc-bad',
  });
  ok(missing.status === 400 && missing.data && missing.data.code === 'E_CC_NOT_FOUND', 'bad center 400', missing.data);

  server.close();
  try { closeSessionStore(); } catch (_) {}
  console.log('\ncutting lay CC: ' + (fail ? 'FAIL ' : 'OK ') + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
