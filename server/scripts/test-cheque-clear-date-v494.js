/**
 * v494 — cheque clear/bounce date UX + API settlement-date rules.
 * Run: node server/scripts/test-cheque-clear-date-v494.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra == null ? '' : extra); }
}

console.log('══ cheque clear date v494 (static) ══');
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(/function chequeClearSave/.test(appJs), 'UI chequeClearSave');
ok(/id="cclear-date"/.test(appJs), 'UI clear date field');
ok(/id="cclear-bank"/.test(appJs), 'UI clear bank field');
ok(!/confirm\('وصول چک ثبت شود\?'\)/.test(appJs), 'no confirm-only clear');
ok(/function chequeBounceSave/.test(appJs), 'UI bounce date modal');
ok(/تاریخ وصول/.test(appJs), 'help mentions clear date');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
ok(/erp-taranom-v494/.test(sw), 'SW bumped to v494');
const routesSrc = fs.readFileSync(path.join(__dirname, '../routes/cheque-records.js'), 'utf8');
ok(/resolveChequeEntryDate/.test(routesSrc), 'API date helper');
ok(/E_CHEQUE_CLEAR_BEFORE_SEND/.test(routesSrc), 'API clear-before-send guard');

let db;
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheque-clear-v494-'));
  const dbFile = path.join(dir, 't.db');
  process.env.DB_PATH = dbFile;
  process.env.SYNC_ROLE = 'central';
  process.env.JWT_SECRET = 'test-cheque-clear-date-v494-secret-32bytes!!';
  process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
  process.env.ERP_TEST_ISOLATION = '1';
  delete require.cache[require.resolve('../db')];
  const { initDB, getDB } = require('../db');
  initDB();
  db = getDB();
} catch (e) {
  console.log('  SKIP runtime DB tests (better-sqlite3 unavailable):', e.message.split('\n')[0]);
  console.log(`\n══ result: ${pass} pass, ${fail} fail (static only) ══`);
  process.exit(fail ? 1 : 0);
}
const { acct } = require('../lib/coa-map');

function req(app, method, url, body, token) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const data = body ? JSON.stringify(body) : null;
      const r = http.request({
        hostname: '127.0.0.1', port, path: url, method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          server.close();
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { parsed = raw; }
          resolve({ status: res.statusCode, data: parsed });
        });
      });
      r.on('error', (e) => { server.close(); reject(e); });
      if (data) r.write(data);
      r.end();
    });
  });
}

(async () => {
  console.log('══ cheque clear date v494 (runtime) ══');

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test',
    user_agent: 'test-cheque-clear-v494',
  });

  let party = db.prepare("SELECT id FROM parties WHERE COALESCE(is_active,1)=1 LIMIT 1").get();
  if (!party) {
    const info = db.prepare(`
      INSERT INTO parties (full_name, company_name, biz, is_active, created_at)
      VALUES ('طرف تست وصول v494', 'طرف تست وصول v494', 'طرف تست وصول v494', 1, strftime('%s','now'))
    `).run();
    party = { id: info.lastInsertRowid };
  }

  let bank = db.prepare('SELECT id FROM banks WHERE COALESCE(active,1)=1 LIMIT 1').get();
  if (!bank) {
    const bankAcct = acct(db, 'coa_bank_default');
    const info = db.prepare(`
      INSERT INTO banks (name, account_number, coa_code, active)
      VALUES ('بانک تست وصول v494', '000494', ?, 1)
    `).run(bankAcct.code);
    bank = { id: info.lastInsertRowid };
  }

  const fy = db.prepare("SELECT id FROM fiscal_years WHERE status='open' ORDER BY id DESC LIMIT 1").get();
  if (!fy) {
    db.prepare(`
      INSERT INTO fiscal_years (label, start_date, status) VALUES ('1405', '1405/01/01', 'open')
    `).run();
  }

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/cheque-records', require('../routes/cheque-records'));

  const AMT = 1_500_000;
  let r = await req(app, 'POST', '/api/cheque-records', {
    direction: 'in',
    cheque_number: 'CLR-494',
    amount: AMT,
    party_id: party.id,
    due_date: '1405/07/20',
  }, token);
  ok(r.status === 200 && r.data && r.data.id, 'create receivable cheque', r.data && r.data.error);
  const chequeId = r.data.id;

  r = await req(app, 'POST', `/api/cheque-records/${chequeId}/send-to-bank`, {
    collection_bank_id: bank.id,
    date: '1405/07/10',
  }, token);
  ok(r.status === 200 && r.data && r.data.lifecycle_status === 'in_collection', 'send to bank', r.data && r.data.error);

  r = await req(app, 'POST', `/api/cheque-records/${chequeId}/clear`, {
    bank_id: bank.id,
    date: '1405/07/09',
  }, token);
  ok(r.status === 400 && r.data && r.data.code === 'E_CHEQUE_CLEAR_BEFORE_SEND',
    'reject clear before send date', r.data);

  r = await req(app, 'POST', `/api/cheque-records/${chequeId}/clear`, {
    bank_id: bank.id,
    date: 'bad-date',
  }, token);
  ok(r.status === 400 && r.data && r.data.code === 'E_CHEQUE_DATE',
    'reject invalid clear date', r.data);

  r = await req(app, 'POST', `/api/cheque-records/${chequeId}/clear`, {
    bank_id: bank.id,
    date: '1405/07/15',
  }, token);
  ok(r.status === 200 && r.data && r.data.lifecycle_status === 'cleared',
    'clear with manual date', r.data && r.data.error);
  ok(r.data && r.data.date === '1405/07/15', 'response echoes clear date', r.data);

  const je = db.prepare(`
    SELECT entry_date FROM journal_entries
    WHERE ref_type='cheque_clear' AND ref_id=? AND COALESCE(deleted_at,0)=0
  `).get(chequeId);
  ok(je && je.entry_date === '1405/07/15', 'JE uses manual clear date', je);

  const row = db.prepare('SELECT lifecycle_status, collection_bank_id FROM cheque_records WHERE id=?').get(chequeId);
  ok(row && row.lifecycle_status === 'cleared' && Number(row.collection_bank_id) === Number(bank.id),
    'row cleared with bank', row);

  console.log(`\n══ result: ${pass} pass, ${fail} fail ══`);
  try { closeSessionStore(); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
