const { swAtLeast } = require('./lib/sw-at-least');
/**
 * v496 — cheque resend after soft-void policy (no paired reverse JE).
 * Run: node server/scripts/test-cheque-resend-softvoid-v496.js
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

console.log('══ cheque resend soft-void v496 (static) ══');
const voidSrc = fs.readFileSync(path.join(__dirname, '../lib/void-journal.js'), 'utf8');
ok(/return alreadyDead \? null : jeId/.test(voidSrc), 'reverseJournalEntry returns jeId when voiding');
ok(!/return alreadyDead \? null : null/.test(voidSrc), 'no always-null return');

const routes = fs.readFileSync(path.join(__dirname, '../routes/cheque-records.js'), 'utf8');
ok(!/معکوس سند برگشت ناموفق بود/.test(routes), 'old resend null-check message gone');
ok(/ابطال نرم سند برگشت ناموفق بود/.test(routes), 'resend verifies soft-void state');
ok(/both OK for resend/.test(routes), 'resend tolerates already-voided bounce JE');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(/ابطال نرم می‌شود/.test(appJs), 'UI resend copy mentions soft-void');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
ok(swAtLeast(sw, 496), 'SW v496');

let db;
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheque-resend-v496-'));
  process.env.DB_PATH = path.join(dir, 't.db');
  process.env.SYNC_ROLE = 'central';
  process.env.JWT_SECRET = 'test-cheque-resend-softvoid-v496-secret-32b!!';
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
const { reverseJournalEntry } = require('../lib/void-journal');

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
  console.log('══ cheque resend soft-void v496 (runtime) ══');

  const retLive = reverseJournalEntry(db, null, {});
  ok(retLive === null, 'reverseJournalEntry(null) → null');

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test',
    device_name: 'cheque-resend-v496',
    device_fingerprint: 'cheque-resend-v496-fp',
  }).token;

  let party = db.prepare('SELECT id FROM parties WHERE COALESCE(is_active,1)=1 LIMIT 1').get();
  if (!party) {
    party = { id: db.prepare(`
      INSERT INTO parties (full_name, company_name, biz, is_active, created_at)
      VALUES ('طرف resend v496','طرف resend v496','طرف resend v496',1,strftime('%s','now'))
    `).run().lastInsertRowid };
  }
  let bank = db.prepare('SELECT id FROM banks WHERE COALESCE(active,1)=1 LIMIT 1').get();
  if (!bank) {
    const bankAcct = acct(db, 'coa_bank_default');
    bank = { id: db.prepare(`
      INSERT INTO banks (name, account_number, coa_code, active) VALUES ('بانک resend v496','4960',?,1)
    `).run(bankAcct.code).lastInsertRowid };
  }
  if (!db.prepare("SELECT id FROM fiscal_years WHERE status='open' LIMIT 1").get()) {
    db.prepare(`INSERT INTO fiscal_years (label, start_date, status) VALUES ('1405','1405/01/01','open')`).run();
  }

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/cheque-records', require('../routes/cheque-records'));

  const AMT = 2_200_000;
  let r = await req(app, 'POST', '/api/cheque-records', {
    direction: 'in', cheque_number: 'RSND-496', amount: AMT,
    party_id: party.id, due_date: '1405/07/20',
  }, token);
  ok(r.status === 200 && r.data && r.data.id, 'create cheque', r.data && r.data.error);
  const id = r.data.id;

  r = await req(app, 'POST', `/api/cheque-records/${id}/send-to-bank`, {
    collection_bank_id: bank.id, date: '1405/07/10',
  }, token);
  ok(r.status === 200, 'send-to-bank', r.data && r.data.error);

  r = await req(app, 'POST', `/api/cheque-records/${id}/bounce`, { date: '1405/07/12' }, token);
  ok(r.status === 200 && r.data.lifecycle_status === 'bounced', 'bounce', r.data && r.data.error);

  const row = db.prepare('SELECT bounced_je_id, lifecycle_status FROM cheque_records WHERE id=?').get(id);
  ok(row && row.bounced_je_id, 'has bounced_je_id', row);

  const voidRet = reverseJournalEntry(db, row.bounced_je_id, {
    userId: 1, reason: 'probe-return', sourceType: 'cheque_resend',
  });
  ok(voidRet === Number(row.bounced_je_id), 'soft-void returns original je id', voidRet);
  const voidRet2 = reverseJournalEntry(db, row.bounced_je_id, {
    userId: 1, reason: 'probe-idempotent', sourceType: 'cheque_resend',
  });
  ok(voidRet2 === null, 'second soft-void returns null (already dead)', voidRet2);

  // Restore bounce JE to posted so the HTTP resend path voids a live entry.
  db.prepare(`
    UPDATE journal_entries SET status='posted', deleted_at=NULL
    WHERE id=?
  `).run(row.bounced_je_id);
  db.prepare(`
    UPDATE cheque_records SET lifecycle_status='bounced', bounced_je_id=?, status='برگشتی'
    WHERE id=?
  `).run(row.bounced_je_id, id);

  r = await req(app, 'POST', `/api/cheque-records/${id}/resend`, { date: '1405/07/14' }, token);
  ok(r.status === 200 && r.data && r.data.ok, 'resend succeeds under soft-void', r.data);
  // v497+: resend = soft-void bounce then redeposit clear (lifecycle ends cleared).
  ok(r.data.lifecycle_status === 'cleared', 'resend redeposits as cleared (v497)', r.data);

  const after = db.prepare('SELECT lifecycle_status, bounced_je_id, cleared_je_id FROM cheque_records WHERE id=?').get(id);
  ok(after && after.lifecycle_status === 'cleared' && !after.bounced_je_id && after.cleared_je_id,
    'row cleared bounce pointer + new clear JE', after);

  const je = db.prepare('SELECT status, deleted_at FROM journal_entries WHERE id=?').get(row.bounced_je_id);
  ok(je && (je.status === 'reversed' || Number(je.deleted_at) > 0), 'bounce JE soft-voided', je);

  try { closeSessionStore(); } catch (_) {}
  console.log(`\n══ result: ${pass} pass, ${fail} fail ══`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
