'use strict';
/**
 * Editable bank/cash opening balance (SW v379).
 * Upsert JE amount via rewriteJournalEntry; date = active FY start_date.
 * Run: node server/scripts/test-bank-opening-edit-v379.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-open-v379-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-bank-open-v379-secret-32bytes!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.NODE_ENV = 'test';

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`).run('coa_opening_balance', '3102');
db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`).run('coa_bank_default', '1102');
db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`).run('coa_cash_default', '1101');

const { getActiveFiscalYear } = require('../lib/fiscal-period');
const { SQL_JL_DEBIT_RIAL } = require('../lib/money');

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

function jeDebitRial(jeId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) AS d
    FROM journal_lines WHERE entry_id=?
  `).get(jeId);
  return Math.round(Number(row && row.d) || 0);
}

(async () => {
  const fy = getActiveFiscalYear(db);
  ok(fy && fy.start_date, 'active fiscal year has start_date', fy);
  const fyStart = fy.start_date;

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  ok(!!admin, 'admin user exists');
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'bank-open-v379', device_fingerprint: 'bank-open-v379-fp',
  }).token;

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/banks', require('../routes/banks'));
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

  // 1) Create bank with opening
  let r = await api('POST', '/api/banks', {
    name: 'بانک تست v379',
    opening_balance_rial: 14_520_000,
  });
  ok(r.status === 200 && r.data && r.data.id, 'POST bank with opening', r);
  const bankId = r.data.id;
  let bank = db.prepare('SELECT * FROM banks WHERE id=?').get(bankId);
  ok(Number(bank.opening_balance_rial) === 14_520_000, 'master opening = 14.52M');
  ok(!!bank.opening_balance_je_id, 'opening JE linked');
  const je1 = bank.opening_balance_je_id;
  ok(db.prepare('SELECT entry_date FROM journal_entries WHERE id=?').get(je1).entry_date === fyStart, 'opening JE date = FY start (create)');
  ok(jeDebitRial(je1) === 14_520_000, 'JE debit = 14.52M rial');

  // 2) PUT same amount — same JE id
  r = await api('PUT', `/api/banks/${bankId}`, {
    name: 'بانک تست v379',
    opening_balance_rial: 14_520_000,
  });
  ok(r.status === 200, 'PUT same amount', r);
  bank = db.prepare('SELECT * FROM banks WHERE id=?').get(bankId);
  ok(bank.opening_balance_je_id === je1, 'JE id unchanged on same amt');

  // 3) PUT higher amount — rewrite same JE
  r = await api('PUT', `/api/banks/${bankId}`, {
    name: 'بانک تست v379',
    opening_balance_rial: 20_000_000,
  });
  ok(r.status === 200, 'PUT higher opening', r);
  bank = db.prepare('SELECT * FROM banks WHERE id=?').get(bankId);
  ok(bank.opening_balance_je_id === je1, 'rewrite keeps same JE id');
  ok(Number(bank.opening_balance_rial) === 20_000_000, 'master = 20M');
  ok(jeDebitRial(je1) === 20_000_000, 'JE debit rewritten to 20M');
  ok(db.prepare('SELECT entry_date FROM journal_entries WHERE id=?').get(je1).entry_date === fyStart, 'date still FY start after rewrite');

  // 4) Corrupt date mid-year then PUT — snap back to FY start
  db.prepare('UPDATE journal_entries SET entry_date=? WHERE id=?').run('1405/07/04', je1);
  r = await api('PUT', `/api/banks/${bankId}`, {
    name: 'بانک تست v379',
    opening_balance_rial: 20_000_000,
  });
  ok(r.status === 200, 'PUT after mid-year date corruption', r);
  ok(db.prepare('SELECT entry_date FROM journal_entries WHERE id=?').get(je1).entry_date === fyStart, 'date repaired to FY start');

  // 5) PUT amt=0 — void
  r = await api('PUT', `/api/banks/${bankId}`, {
    name: 'بانک تست v379',
    opening_balance_rial: 0,
  });
  ok(r.status === 200, 'PUT opening to 0', r);
  bank = db.prepare('SELECT * FROM banks WHERE id=?').get(bankId);
  ok(Number(bank.opening_balance_rial) === 0 && !bank.opening_balance_je_id, 'master cleared');
  const voided = db.prepare('SELECT status, deleted_at FROM journal_entries WHERE id=?').get(je1);
  ok(voided.status === 'reversed' || Number(voided.deleted_at) > 0, 'old JE soft-voided', voided);

  // 6) PUT amt>0 after void — new JE
  r = await api('PUT', `/api/banks/${bankId}`, {
    name: 'بانک تست v379',
    opening_balance_rial: 5_000_000,
  });
  ok(r.status === 200, 'PUT reopen opening', r);
  bank = db.prepare('SELECT * FROM banks WHERE id=?').get(bankId);
  ok(bank.opening_balance_je_id && bank.opening_balance_je_id !== je1, 'new JE after void');
  ok(Number(bank.opening_balance_rial) === 5_000_000, 'master = 5M');
  ok(db.prepare('SELECT entry_date FROM journal_entries WHERE id=?').get(bank.opening_balance_je_id).entry_date === fyStart, 'reopen date = FY start');

  // 7) cash_boxes mirror
  r = await api('POST', '/api/cash-boxes', {
    name: 'صندوق تست v379',
    opening_balance_rial: 1_000_000,
  });
  ok(r.status === 200 && r.data && r.data.id, 'POST cash with opening', r);
  const cashId = r.data.id;
  let box = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(cashId);
  const cJe = box.opening_balance_je_id;
  ok(cJe && db.prepare('SELECT entry_date FROM journal_entries WHERE id=?').get(cJe).entry_date === fyStart, 'cash JE date = FY start');
  r = await api('PUT', `/api/cash-boxes/${cashId}`, {
    name: 'صندوق تست v379',
    opening_balance_rial: 3_000_000,
  });
  ok(r.status === 200, 'PUT cash opening rewrite', r);
  box = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(cashId);
  ok(box.opening_balance_je_id === cJe && Number(box.opening_balance_rial) === 3_000_000, 'cash rewrite same id + 3M');
  ok(jeDebitRial(cJe) === 3_000_000, 'cash JE debit = 3M');

  // 8) UI editable
  const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  ok(!/id="bk-opening"[^>]*disabled/.test(appJs), 'bk-opening input not disabled');
  ok(!/id="cb-opening"[^>]*disabled/.test(appJs), 'cb-opening input not disabled');
  ok(/موجودی اول دوره قابل ویرایش است/.test(appJs), 'admin help mentions editable opening');

  server.close();
  try { closeSessionStore(); } catch (_) { /* */ }
  try { closeDB(); } catch (_) { /* */ }
  console.log(`\nPASS ${pass} assertions — bank/cash opening edit v379`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
