'use strict';
const { swAtLeast } = require('./lib/sw-at-least');
/**
 * v538: صندوق کیمیا — افتتاحیه روی شروع سال مالی؛ ویرایش بدون خطای FY؛ یک JE زنده.
 * Run: node server/scripts/test-cash-opening-kimia-fy-v538.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cash-kimia-v538-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-cash-kimia-v538-secret-32bytes!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.NODE_ENV = 'test';

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`).run('coa_opening_balance', '3102');
db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`).run('coa_cash_default', '1101');

const { getActiveFiscalYear } = require('../lib/fiscal-period');
const { addDaysToJalali } = require('../jalali');
const { postToLedger } = require('../lib/ledger');

let pass = 0;
function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log('  OK', label);
  } else {
    console.error(' FAIL', label, extra != null ? JSON.stringify(extra) : '');
    try { closeDB(); } catch (_) { /* */ }
    process.exit(1);
  }
}

function liveCashOpenCount(boxId) {
  return db.prepare(`
    SELECT COUNT(*) AS c FROM journal_entries
    WHERE ref_type='cash_opening' AND ref_id=?
      AND COALESCE(deleted_at,0)=0
      AND COALESCE(status,'posted') NOT IN ('reversed','void')
  `).get(boxId).c;
}

(async () => {
  const fy = getActiveFiscalYear(db);
  ok(fy && fy.start_date, 'active fiscal year has start_date', fy);
  const fyStart = fy.start_date;
  const dayBefore = addDaysToJalali(fyStart, -1);
  ok(dayBefore < fyStart, 'day-before is strictly before FY start', { dayBefore, fyStart });

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  ok(!!admin, 'admin user exists');
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'cash-kimia-v538', device_fingerprint: 'cash-kimia-v538-fp',
  }).token;

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/cash-boxes', require('../routes/cash-boxes'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  async function api(method, url, body) {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  // 1) Create «کیمیا» with opening — must succeed and date = FY start (not day-before)
  let r = await api('POST', '/api/cash-boxes', {
    name: 'کیمیا',
    custodian: 'خانم شرفی',
    opening_balance_rial: 66_300_000,
  });
  ok(r.status === 200 && r.data && r.data.id, 'POST کیمیا opening', r);
  const cashId = r.data.id;
  let box = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(cashId);
  const je1 = box.opening_balance_je_id;
  ok(!!je1, 'JE linked');
  const jeRow = db.prepare('SELECT entry_date FROM journal_entries WHERE id=?').get(je1);
  ok(jeRow.entry_date === fyStart, 'create date = FY start (not day-before)', {
    got: jeRow.entry_date, fyStart, dayBefore,
  });
  ok(jeRow.entry_date !== dayBefore, 'not day-before');
  ok(liveCashOpenCount(cashId) === 1, 'one live JE after create');

  // 2) Edit amount — must NOT return FY-before error; same JE
  r = await api('PUT', `/api/cash-boxes/${cashId}`, {
    name: 'کیمیا',
    custodian: 'خانم شرفی',
    opening_balance_rial: 70_000_000,
  });
  ok(r.status === 200, 'PUT edit amount without FY error', r);
  ok(!(r.data && /قبل از شروع سال مالی/.test(String(r.data.error || ''))), 'no FY-before toast', r.data);
  box = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(cashId);
  ok(box.opening_balance_je_id === je1, 'rewrite keeps same JE id');
  ok(Number(box.opening_balance_rial) === 70_000_000, 'master updated');
  ok(db.prepare('SELECT entry_date FROM journal_entries WHERE id=?').get(je1).entry_date === fyStart, 'date still FY start');
  ok(liveCashOpenCount(cashId) === 1, 'still one live JE');

  // 3) Legacy JE dated day-before → PUT repairs date to FY start, same id
  db.prepare('UPDATE journal_entries SET entry_date=? WHERE id=?').run(dayBefore, je1);
  r = await api('PUT', `/api/cash-boxes/${cashId}`, {
    name: 'کیمیا',
    opening_balance_rial: 71_000_000,
  });
  ok(r.status === 200, 'PUT repairs legacy day-before date', r);
  box = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(cashId);
  ok(box.opening_balance_je_id === je1, 'repair keeps JE id');
  ok(db.prepare('SELECT entry_date FROM journal_entries WHERE id=?').get(je1).entry_date === fyStart, 'repaired to FY start');
  ok(liveCashOpenCount(cashId) === 1, 'one live after repair');

  // 4) Inject duplicate + edit → retire to one
  const orphan = postToLedger(db, {
    sourceType: 'cash_opening',
    sourceId: cashId,
    date: fyStart,
    description: 'orphan kimia',
    createdBy: admin.id,
    voucherType: 'opening',
    lines: [
      { code: '3102', name: 'افتتاحیه', debit: 1000, credit: 0 },
      { code: box.coa_code || ('1101-' + cashId), name: box.name, debit: 0, credit: 1000 },
    ],
  });
  ok(liveCashOpenCount(cashId) === 2, 'two before retire', { orphan });
  r = await api('PUT', `/api/cash-boxes/${cashId}`, {
    name: 'کیمیا',
    opening_balance_rial: 71_000_000,
  });
  ok(r.status === 200, 'PUT retires orphan', r);
  ok(liveCashOpenCount(cashId) === 1, 'exactly one after retire');

  // 5) Source / UI stamps
  const cashSrc = fs.readFileSync(path.join(__dirname, '../routes/cash-boxes.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  ok(!/addDaysToJalali\(start,\s*-1\)/.test(cashSrc), 'no day-before in cash-boxes');
  ok(/شروع سال مالی فعال است — حتی برای صندوق کیمیا/.test(appJs), 'form help mentions FY start for کیمیا');
  ok(swAtLeast(sw, 538), 'SW v538');

  server.close();
  try { closeSessionStore(); } catch (_) { /* */ }
  try { closeDB(); } catch (_) { /* */ }
  console.log(`\nPASS ${pass} assertions — cash opening Kimia FY v538`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
