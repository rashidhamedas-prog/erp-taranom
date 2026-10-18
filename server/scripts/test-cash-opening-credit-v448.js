'use strict';
/**
 * Cash/bank opening: signed (credit) balance, upsert rewrite, retire duplicate JEs (SW v448).
 * Run: node server/scripts/test-cash-opening-credit-v448.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cash-open-v448-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-cash-open-v448-secret-32bytes!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.NODE_ENV = 'test';

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`).run('coa_opening_balance', '3102');
db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`).run('coa_cash_default', '1101');
db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`).run('coa_bank_default', '1102');

const { getActiveFiscalYear } = require('../lib/fiscal-period');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');
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

function openingSideOnJe(jeId) {
  const opening = db.prepare("SELECT value FROM settings WHERE key='coa_opening_balance'").get();
  const code = opening && opening.value;
  const row = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) AS d,
           COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) AS c
    FROM journal_lines jl WHERE jl.entry_id=? AND jl.account_code=?
  `).get(jeId, code);
  return {
    d: Math.round(Number(row && row.d) || 0),
    c: Math.round(Number(row && row.c) || 0),
  };
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
    device_kind: 'test', device_name: 'cash-open-v448', device_fingerprint: 'cash-open-v448-fp',
  }).token;

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/cash-boxes', require('../routes/cash-boxes'));
  app.use('/api/banks', require('../routes/banks'));
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

  // 1) Debit opening create
  let r = await api('POST', '/api/cash-boxes', {
    name: 'صندوق تست v448',
    opening_balance_rial: 6_070_980,
  });
  ok(r.status === 200 && r.data && r.data.id, 'POST cash debit opening', r);
  const cashId = r.data.id;
  let box = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(cashId);
  const je1 = box.opening_balance_je_id;
  ok(!!je1, 'JE linked on create');
  ok(db.prepare('SELECT entry_date FROM journal_entries WHERE id=?').get(je1).entry_date === fyStart, 'date = FY start');
  ok(liveCashOpenCount(cashId) === 1, 'exactly one live opening JE');
  let side = openingSideOnJe(je1);
  ok(side.c === 6_070_980 && side.d === 0, 'debit opening → Cr 3102', side);

  // 2) Rewrite amount — same JE
  r = await api('PUT', `/api/cash-boxes/${cashId}`, {
    name: 'صندوق تست v448',
    opening_balance_rial: 12_345_830,
  });
  ok(r.status === 200, 'PUT higher opening', r);
  box = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(cashId);
  ok(box.opening_balance_je_id === je1, 'rewrite keeps same JE id');
  ok(Number(box.opening_balance_rial) === 12_345_830, 'master = 12.3M');
  ok(liveCashOpenCount(cashId) === 1, 'still one live JE after rewrite');

  // 3) Flip to credit (بستانکار)
  r = await api('PUT', `/api/cash-boxes/${cashId}`, {
    name: 'صندوق تست v448',
    opening_balance_rial: -53_700_000,
  });
  ok(r.status === 200, 'PUT credit opening', r);
  box = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(cashId);
  ok(box.opening_balance_je_id === je1, 'credit flip keeps same JE');
  ok(Number(box.opening_balance_rial) === -53_700_000, 'master signed -53.7M');
  side = openingSideOnJe(je1);
  ok(side.d === 53_700_000 && side.c === 0, 'credit opening → Dr 3102', side);
  ok(liveCashOpenCount(cashId) === 1, 'one live JE after side flip');

  // 4) Inject orphan duplicate JE then PUT — retire orphan
  const orphan = postToLedger(db, {
    sourceType: 'cash_opening',
    sourceId: cashId,
    date: fyStart,
    description: 'orphan duplicate',
    createdBy: admin.id,
    voucherType: 'opening',
    lines: [
      { code: '3102', name: 'افتتاحیه', debit: 1000, credit: 0 },
      { code: box.coa_code || ('1101-' + cashId), name: box.name, debit: 0, credit: 1000 },
    ],
  });
  ok(liveCashOpenCount(cashId) === 2, 'two live JEs before retire', { orphan });
  r = await api('PUT', `/api/cash-boxes/${cashId}`, {
    name: 'صندوق تست v448',
    opening_balance_rial: -53_700_000,
  });
  ok(r.status === 200, 'PUT after orphan inject', r);
  ok(liveCashOpenCount(cashId) === 1, 'orphan retired — one live JE');
  const orphanRow = db.prepare('SELECT status, deleted_at FROM journal_entries WHERE id=?').get(orphan);
  ok(orphanRow.status === 'reversed' || Number(orphanRow.deleted_at) > 0, 'orphan soft-voided', orphanRow);

  // 5) Zero voids
  r = await api('PUT', `/api/cash-boxes/${cashId}`, {
    name: 'صندوق تست v448',
    opening_balance_rial: 0,
  });
  ok(r.status === 200, 'PUT zero voids', r);
  box = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(cashId);
  ok(Number(box.opening_balance_rial) === 0 && !box.opening_balance_je_id, 'master cleared');
  ok(liveCashOpenCount(cashId) === 0, 'no live cash_opening');

  // 6) Bank credit twin
  r = await api('POST', '/api/banks', {
    name: 'بانک تست v448',
    opening_balance_rial: -2_000_000,
  });
  ok(r.status === 200 && r.data && r.data.id, 'POST bank credit opening', r);
  const bankId = r.data.id;
  let bank = db.prepare('SELECT * FROM banks WHERE id=?').get(bankId);
  ok(Number(bank.opening_balance_rial) === -2_000_000 && !!bank.opening_balance_je_id, 'bank master credit');
  side = openingSideOnJe(bank.opening_balance_je_id);
  ok(side.d === 2_000_000 && side.c === 0, 'bank credit → Dr opening', side);

  // 7) UI source checks
  const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  ok(appJs.includes('cb-open-credit') && appJs.includes('bk-open-credit'), 'UI debit/credit radios');
  ok(/مانده بستانکار/.test(appJs), 'admin help mentions credit opening');
  ok(sw.includes('erp-taranom-v448'), 'SW v448');

  server.close();
  try { closeSessionStore(); } catch (_) { /* */ }
  try { closeDB(); } catch (_) { /* */ }
  console.log(`\nPASS ${pass} assertions — cash/bank opening credit upsert v448`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
