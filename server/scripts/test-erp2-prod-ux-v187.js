'use strict';
/**
 * ERP2 + production UX v187 — cutting warehouse resolve + invoice convert API.
 * Run: node server/scripts/test-erp2-prod-ux-v187.js
 */
const fs = require('fs');
const path = require('path');

const testDb = path.join(__dirname, 'erp2-prod-ux-v187-test.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch (_) {}
}
process.env.DB_PATH = testDb;
process.env.SYNC_ROLE = 'central';
process.env.SMS_DISABLED = '1';
process.env.ERP_TEST_ISOLATION = '1';
process.env.JWT_SECRET = 'erp2-prod-ux-v187-secret-32chars!!';

delete require.cache[require.resolve('../db')];
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

const { requireRawWarehouse, isRawWarehouseRow } = require('../lib/production/cutting');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra == null ? '' : extra); }
}

const whWork = db.prepare(`
  INSERT INTO warehouses (code, name, warehouse_type, is_active)
  VALUES ('WH-WORKSHOP', 'کارگاه', 'raw_material', 1)
`).run().lastInsertRowid;

const whOther = db.prepare(`
  INSERT INTO warehouses (code, name, warehouse_type, is_active)
  VALUES ('WH-SALES', 'فروش', 'finished_goods', 1)
`).run().lastInsertRowid;

ok(isRawWarehouseRow(db.prepare('SELECT * FROM warehouses WHERE id=?').get(whWork)), 'workshop is raw');
ok(!isRawWarehouseRow(db.prepare('SELECT * FROM warehouses WHERE id=?').get(whOther)), 'sales not raw');

const fromRolls = requireRawWarehouse(db, null, [whWork]);
ok(Number(fromRolls.id) === Number(whWork), 'resolve from roll warehouse', fromRolls && fromRolls.code);

db.prepare("UPDATE settings SET value='99999' WHERE key='production_wh_raw_id'").run();
try {
  requireRawWarehouse(db, null, [whWork]);
  ok(true, 'ignores bad setting when rolls point to raw');
} catch (e) {
  ok(false, 'ignores bad setting when rolls point to raw', e.message);
}

let threw = false;
try {
  requireRawWarehouse(db, null, [whWork, whOther]);
} catch (e) {
  threw = e.code === 'E_CUT_ROLL_WH';
}
ok(threw, 'multi roll warehouses rejected');

// Invoice convert target_type=normal (API contract)
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');

(async () => {
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'erp2-v187', device_fingerprint: 'erp2-v187-fp',
  }).token;

  const custId = db.prepare(`
    INSERT INTO customers (user_id, biz, owner, phone, status, type)
    VALUES (?, 'تست ERP2', 'مالک', '09120000001', 'active', 'عمده‌فروش')
  `).run(admin.id).lastInsertRowid;

  const invId = db.prepare(`
    INSERT INTO invoices (user_id, cust_id, type, num, date, subtotal, final, status, converted)
    VALUES (?, ?, 'proforma', 'P-ERP2-1', '1405/06/12', 100000, 100000, 'active', 0)
  `).run(admin.id, custId).lastInsertRowid;

  const app = express();
  app.use(express.json());
  app.use('/api/invoices', require('../routes/invoices'));
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

  const conv = await api('POST', '/api/invoices/' + invId + '/convert', { target_type: 'normal' });
  ok(conv.status === 200, 'convert proforma to normal 200', conv.data && conv.data.error);
  const row = db.prepare('SELECT type, converted FROM invoices WHERE id=?').get(invId);
  ok(row.type === 'normal' && row.converted === 1, 'invoice type normal + converted flag');

  // Frontend syntax smoke
  const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  try { new Function(appJs); ok(true, 'app.js parses (new Function)'); }
  catch (e) { ok(false, 'app.js parses', e.message); }

  server.close();
  try { closeSessionStore(); } catch (_) {}
  console.log('\nERP2 prod UX v187: ' + (fail ? '❌ ' : '✅ ') + pass + ' پاس، ' + fail + ' رد');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
