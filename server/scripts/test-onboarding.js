/**
 * W2-M3 / P1-M3 onboarding MVP tests.
 * Run: node server/scripts/test-onboarding.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-onboarding-'));
const DB = path.join(TMP, 'onboarding.db');
const COMPANIES_DIR = path.join(TMP, 'companies');
fs.mkdirSync(COMPANIES_DIR, { recursive: true });

process.env.DB_PATH = DB;
process.env.COMPANIES_DIR = COMPANIES_DIR;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'onboarding-test-jwt-secret-at-least-32-bytes';
process.env.AUTH_SESSION_DB_PATH = path.join(TMP, 'sessions.db');

delete require.cache[require.resolve('../db')];

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

const {
  bootstrapWorkspace,
  getChecklist,
  dryRunImport,
} = require('../lib/onboarding/bootstrap');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg); }
  else { failed++; console.error('  ❌', msg); }
}

console.log('TMP', TMP);
console.log('\n— lib: checklist / bootstrap —');

let checklist = getChecklist(db);
assert(checklist.coa === true, 'fresh DB has COA');
assert(checklist.users === true, 'fresh DB has users');
assert(checklist.fiscal_year === true, 'fresh DB has open fiscal year');

// Remove cash boxes and warehouses to force ensure paths
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('warehouses_user_cleared','1')").run();
try { db.prepare('UPDATE products SET warehouse_id=NULL').run(); } catch (_) {}
try { db.prepare('DELETE FROM warehouse_stock').run(); } catch (_) {}
db.prepare('DELETE FROM warehouses').run();
db.prepare('DELETE FROM cash_boxes').run();

checklist = getChecklist(db);
assert(checklist.warehouse === false, 'warehouse flag false after wipe');
assert(checklist.cash_box === false, 'cash_box flag false after wipe');
assert(checklist.ready === false, 'ready false without warehouse');

const boot = bootstrapWorkspace(db, {
  company_name: 'شرکت تست آنبوردینگ',
  fiscal_label: 'سال مالی تست آنبوردینگ',
  start_date: '1405/01/01',
  warehouse_name: 'انبار آنبوردینگ',
  cash_box_name: 'صندوق آنبوردینگ',
  created_by: 1,
});
assert(boot.ok === true, 'bootstrap ok');
assert(boot.created.warehouse === true, 'bootstrap created warehouse');
assert(boot.created.cash_box === true, 'bootstrap created cash box');
assert(boot.checklist.ready === true, 'checklist ready after bootstrap');
assert(boot.checklist.company === true, 'company flag true');
assert(String(boot.company.company_name).includes('آنبوردینگ'), 'company name set');

const boot2 = bootstrapWorkspace(db, { company_name: 'شرکت تست آنبوردینگ' });
assert(boot2.created.warehouse === false, 'second bootstrap does not recreate warehouse');
assert(boot2.created.cash_box === false, 'second bootstrap does not recreate cash box');

console.log('\n— lib: dry-run import —');
const dryBadType = dryRunImport({ type: 'unknown', rows: [] });
assert(dryBadType.ok === false && dryBadType.preview_count === 0, 'rejects unknown type');

const dryParties = dryRunImport({
  type: 'parties',
  rows: [
    { full_name: 'مشتری خوب', phone: '09121234567' },
    { full_name: '', phone: '0912' }, // bad: empty name + short phone may fail format
  ],
});
assert(dryParties.ok === false, 'parties dry-run not ok with bad row');
assert(dryParties.preview_count === 1, 'parties preview_count=1 for good row');
assert(dryParties.errors.length >= 1, 'parties errors present for bad row');
assert(
  db.prepare('SELECT COUNT(*) c FROM parties').get().c === 0
    || db.prepare("SELECT COUNT(*) c FROM parties WHERE full_name='مشتری خوب'").get().c === 0,
  'dry-run did not insert party'
);

const dryProducts = dryRunImport({
  type: 'products',
  rows: [
    { name: 'مانتو تست', code: 'PR-ONB-1', price_rial: 1000000 },
    { name: '', code: '' }, // bad
  ],
});
assert(dryProducts.ok === false, 'products dry-run not ok with bad row');
assert(dryProducts.preview_count === 1, 'products preview_count=1');
assert(dryProducts.errors.some(e => e.row === 2), 'product error on row 2');

const dryGood = dryRunImport({
  type: 'products',
  rows: [{ name: 'فقط خوب', code: 'OK-1', price: 10 }],
});
assert(dryGood.ok === true && dryGood.preview_count === 1, 'all-good dry-run ok');

console.log('\n— HTTP routes —');

(async () => {
  const admin = db.prepare("SELECT id,username,role,name,phone,auth_epoch FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test',
    device_name: 'onboarding-e2e',
    device_fingerprint: 'onboarding-e2e-fingerprint',
  }).token;

  const app = express();
  app.use(express.json());
  app.use('/api/onboarding', require('../routes/onboarding'));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const BASE = `http://127.0.0.1:${port}`;

  async function api(method, p, body) {
    const res = await fetch(BASE + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }

  const cl = await api('GET', '/api/onboarding/checklist');
  assert(cl.status === 200 && cl.data?.checklist?.ready === true, 'GET checklist 200 ready');

  const bs = await api('POST', '/api/onboarding/bootstrap', { company_name: 'شرکت تست آنبوردینگ' });
  assert(bs.status === 200 && bs.data?.ok === true, 'POST bootstrap 200');
  assert(bs.data?.checklist?.cash_box === true, 'bootstrap response cash_box true');

  const dry = await api('POST', '/api/onboarding/import/dry-run', {
    type: 'parties',
    rows: [
      { full_name: 'خوب', phone: '09120001122' },
      { full_name: 'بد', phone: '' },
    ],
  });
  assert(dry.status === 200, 'POST dry-run 200 even with row errors');
  assert(dry.data?.ok === false && dry.data?.preview_count === 1, 'HTTP dry-run preview_count=1');

  const bad = await api('POST', '/api/onboarding/import/dry-run', { type: 'x', rows: [] });
  assert(bad.status === 400, 'bad type → 400');

  server.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  if (failed) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
