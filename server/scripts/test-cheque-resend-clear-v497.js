/**
 * v497 — resend after bounce posts NEW clear JE on chosen date/bank.
 * Run: node server/scripts/test-cheque-resend-clear-v497.js
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

console.log('══ cheque resend→clear v497 (static) ══');
const routes = fs.readFileSync(path.join(__dirname, '../routes/cheque-records.js'), 'utf8');
ok(/function postReceivableClear/.test(routes), 'helper postReceivableClear');
ok(/function softVoidChequeJe/.test(routes), 'helper softVoidChequeJe');
ok(/cheque_clear_resend_void/.test(routes), 'voids prior clear on resend');
ok(/lifecycle_status: 'cleared'/.test(routes), 'resend response is cleared');
ok(/NEW clear JE/.test(routes), 'comment documents redeposit clear');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(/id="cresend-bank"/.test(appJs), 'UI resend bank field');
ok(/تاریخ وصول/.test(appJs) && /cresend-date/.test(appJs), 'UI resend clear date');
ok(/bank_id/.test(appJs) && /cheque-records\/'\+id\+'\/resend'/.test(appJs), 'UI posts bank_id');

const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
ok(/erp-taranom-v497/.test(sw), 'SW v497');

let db;
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheque-resend-v497-'));
  process.env.DB_PATH = path.join(dir, 't.db');
  process.env.SYNC_ROLE = 'central';
  process.env.JWT_SECRET = 'test-cheque-resend-clear-v497-secret-32bytes!!';
  process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
  process.env.ERP_TEST_ISOLATION = '1';
  delete require.cache[require.resolve('../db')];
  const { initDB, getDB } = require('../db');
  initDB();
  db = getDB();
} catch (e) {
  console.log('  SKIP runtime:', e.message.split('\n')[0]);
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
  console.log('══ cheque resend→clear v497 (runtime) ══');
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'resend-v497', device_fingerprint: 'resend-v497-fp',
  }).token;

  let party = db.prepare('SELECT id FROM parties WHERE COALESCE(is_active,1)=1 LIMIT 1').get();
  if (!party) {
    party = { id: db.prepare(`
      INSERT INTO parties (full_name, company_name, biz, is_active, created_at)
      VALUES ('طرف v497','طرف v497','طرف v497',1,strftime('%s','now'))
    `).run().lastInsertRowid };
  }
  const bankAcct = acct(db, 'coa_bank_default');
  let bank = db.prepare('SELECT id FROM banks WHERE COALESCE(active,1)=1 LIMIT 1').get();
  if (!bank) {
    bank = { id: db.prepare(`
      INSERT INTO banks (name, account_number, coa_code, active) VALUES ('بانک v497','4970',?,1)
    `).run(bankAcct.code).lastInsertRowid };
  }
  if (!db.prepare("SELECT id FROM fiscal_years WHERE status='open' LIMIT 1").get()) {
    db.prepare(`INSERT INTO fiscal_years (label, start_date, status) VALUES ('1405','1405/01/01','open')`).run();
  }

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/cheque-records', require('../routes/cheque-records'));

  const AMT = 74_000_000;
  let r = await req(app, 'POST', '/api/cheque-records', {
    direction: 'in', cheque_number: '655099-v497', amount: AMT,
    party_id: party.id, due_date: '1405/07/20',
  }, token);
  ok(r.status === 200 && r.data.id, 'create', r.data && r.data.error);
  const id = r.data.id;

  r = await req(app, 'POST', `/api/cheque-records/${id}/send-to-bank`, {
    collection_bank_id: bank.id, date: '1405/07/10',
  }, token);
  ok(r.status === 200, 'send', r.data && r.data.error);

  r = await req(app, 'POST', `/api/cheque-records/${id}/clear`, {
    bank_id: bank.id, date: '1405/07/12',
  }, token);
  ok(r.status === 200, 'first clear', r.data && r.data.error);
  const oldClearId = r.data.journal_entry_id;

  r = await req(app, 'POST', `/api/cheque-records/${id}/bounce`, { date: '1405/07/13' }, token);
  ok(r.status === 200 && r.data.lifecycle_status === 'bounced', 'bounce', r.data);

  r = await req(app, 'POST', `/api/cheque-records/${id}/resend`, {
    date: '1405/07/15', bank_id: bank.id,
  }, token);
  ok(r.status === 200 && r.data.lifecycle_status === 'cleared', 'resend→cleared', r.data);
  ok(r.data.date === '1405/07/15', 'resend echoes clear date', r.data);
  ok(r.data.journal_entry_id && r.data.journal_entry_id !== oldClearId,
    'new clear JE id (not old)', { new: r.data.journal_entry_id, old: oldClearId });

  const newJe = db.prepare(`
    SELECT id, entry_date, status, deleted_at FROM journal_entries WHERE id=?
  `).get(r.data.journal_entry_id);
  ok(newJe && newJe.entry_date === '1405/07/15' && Number(newJe.deleted_at || 0) === 0,
    'new clear JE live on selected date', newJe);

  const oldJe = db.prepare('SELECT status, deleted_at FROM journal_entries WHERE id=?').get(oldClearId);
  ok(oldJe && (oldJe.status === 'reversed' || Number(oldJe.deleted_at) > 0),
    'old clear soft-voided', oldJe);

  const row = db.prepare('SELECT lifecycle_status, cleared_je_id, bounced_je_id, collection_bank_id FROM cheque_records WHERE id=?').get(id);
  ok(row.lifecycle_status === 'cleared' && Number(row.cleared_je_id) === Number(r.data.journal_entry_id) && !row.bounced_je_id,
    'row points to new clear', row);

  const bankLine = db.prepare(`
    SELECT jl.debit_rial, jl.account_code FROM journal_lines jl
    WHERE jl.entry_id=? AND jl.debit_rial > 0 LIMIT 1
  `).get(r.data.journal_entry_id);
  ok(bankLine && Number(bankLine.debit_rial) === AMT, 'bank debit rial on new clear', bankLine);

  try { closeSessionStore(); } catch (_) {}
  console.log(`\n══ result: ${pass} pass, ${fail} fail ══`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
