const { swAtLeast } = require('./lib/sw-at-least');
/**
 * Cost center DELETE v398: unused → hard delete; referenced/seed → soft deactivate; children → 400.
 * Run: node server/scripts/test-cost-center-delete-v398.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-delete-v398-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-cc-delete-v398-secret-32chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra != null ? extra : ''); }
}

(async () => {
  console.log('\n══ Cost center delete v398 ══\n');

  const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const accSrc = fs.readFileSync(path.join(__dirname, '../routes/accounting.js'), 'utf8');
  ok(appSrc.includes('deactivated') && appSrc.includes('deleteCostCenter'), 'UI handles deactivated toast');
  ok(swAtLeast(fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8'), 398), 'SW v398');
  ok(accSrc.includes("['expense_payments'") && accSrc.includes("['journal_templates'"),
    'probe covers non-FK expense/template refs');
  ok(accSrc.includes("['persons'") && accSrc.includes("['budget_lines'"),
    'probe covers persons/budget refs');

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get()
    || db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get();
  ok(!!admin, 'admin user present');
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'cc-del-v398', device_fingerprint: 'cc-del-v398-fp',
  }).token;

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/accounting', require('../routes/accounting'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  async function api(method, url) {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { Authorization: 'Bearer ' + token },
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  // 1) unused → hard delete
  const tmpId = db.prepare(
    "INSERT INTO cost_centers (name,code,active) VALUES ('موقت تست','CC-TMP-DEL',1)"
  ).run().lastInsertRowid;
  const del1 = await api('DELETE', '/api/accounting/cost-centers/' + tmpId);
  ok(del1.status === 200 && del1.data.ok === true && !del1.data.deactivated, 'unused hard-deleted', del1);
  ok(!db.prepare('SELECT id FROM cost_centers WHERE id=?').get(tmpId), 'row gone from DB');

  // 2) children → 400
  const parent = db.prepare(
    "INSERT INTO cost_centers (name,code,active) VALUES ('والد','CC-P-DEL',1)"
  ).run().lastInsertRowid;
  const child = db.prepare(
    "INSERT INTO cost_centers (name,code,active,parent_id) VALUES ('فرزند','CC-C-DEL',1,?)"
  ).run(parent).lastInsertRowid;
  const delParent = await api('DELETE', '/api/accounting/cost-centers/' + parent);
  ok(delParent.status === 400 && /زیرمجموعه/.test(delParent.data.error || ''), 'parent with children blocked', delParent);
  ok(!!db.prepare('SELECT id FROM cost_centers WHERE id=?').get(parent), 'parent still exists');

  // 3) warehouse ref → soft deactivate
  const whCc = db.prepare(
    "INSERT INTO cost_centers (name,code,active) VALUES ('انبارمحور','CC-WH-DEL',1)"
  ).run().lastInsertRowid;
  const whCols = db.prepare('PRAGMA table_info(warehouses)').all().map((c) => c.name);
  if (whCols.includes('cost_center_id')) {
    db.prepare(
      "INSERT INTO warehouses (code,name,cost_center_id,active) VALUES ('WH-T398','تست',?,1)"
    ).run(whCc);
    const delWh = await api('DELETE', '/api/accounting/cost-centers/' + whCc);
    ok(delWh.status === 200 && delWh.data.deactivated === true, 'warehouse-ref → deactivated', delWh);
    const row = db.prepare('SELECT active FROM cost_centers WHERE id=?').get(whCc);
    ok(row && Number(row.active) === 0, 'active=0 after deactivate');
    const delAgain = await api('DELETE', '/api/accounting/cost-centers/' + whCc);
    ok(delAgain.status === 400, 'already inactive → 400 not 500', delAgain);
  } else {
    ok(false, 'warehouses.cost_center_id missing');
  }

  // 4) seed: children block OR soft deactivate — never 500 / never hard delete
  const seed = db.prepare("SELECT id FROM cost_centers WHERE code='CC-WORKSHOP'").get();
  if (seed) {
    db.prepare('UPDATE cost_centers SET active=1 WHERE id=?').run(seed.id);
    const kids = db.prepare('SELECT COUNT(*) c FROM cost_centers WHERE parent_id=?').get(seed.id).c;
    const delSeed = await api('DELETE', '/api/accounting/cost-centers/' + seed.id);
    if (kids > 0) {
      ok(delSeed.status === 400, 'seed with children → 400', delSeed);
    } else {
      ok(delSeed.status === 200 && delSeed.data.deactivated === true, 'seed → deactivated', delSeed);
    }
    ok(!!db.prepare('SELECT id FROM cost_centers WHERE id=?').get(seed.id), 'seed row retained');
  } else {
    ok(true, 'skip seed (CC-WORKSHOP missing)');
  }

  db.prepare('DELETE FROM cost_centers WHERE id=?').run(child);
  db.prepare('DELETE FROM cost_centers WHERE id=?').run(parent);

  server.close();
  try { closeSessionStore(); } catch (_) {}
  try { closeDB(); } catch (_) {}
  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
