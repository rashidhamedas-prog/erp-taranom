/**
 * v338 — ADR-CHEQUE-LEAF-001: GET /:id + /:id/history reconstruct JE timeline.
 * Run: node server/scripts/test-cheque-leaf-history-v338.js
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheque-leaf-v338-'));
const dbFile = path.join(dir, 't.db');
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-cheque-leaf-history-v338-secret-32bytes!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';

delete require.cache[require.resolve('../db')];
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const { enrichChequeRow, buildChequeHistory } = require('../lib/cheque-history');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra == null ? '' : extra); }
}

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
  console.log('══ cheque leaf history v338 ══');

  const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  ok(/function openChequeLeafModal/.test(appJs), 'UI openChequeLeafModal');
  ok(/ADR-CHEQUE-LEAF-001/.test(appJs), 'UI cites ADR');
  ok(!/prompt\('وضعیت نمایشی چک/.test(appJs), 'no legacy status prompt');

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test',
    device_name: 'cheque-leaf-v338',
    device_fingerprint: 'cheque-leaf-v338-fp',
  }).token;
  ok(!!token, 'session token');

  const partyId = db.prepare(`
    INSERT INTO parties (person_code, party_type, full_name, is_active)
    VALUES ('P-LEAF338','customer','طرف برگه v338',1)
  `).run().lastInsertRowid;

  const bankId = db.prepare(`
    INSERT INTO banks (name, account_number, active)
    VALUES ('بانک تست برگه','123',1)
  `).run().lastInsertRowid;
  try { db.prepare('UPDATE banks SET coa_code=? WHERE id=?').run('1102', bankId); } catch (_) { /* */ }

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/cheque-records', require('../routes/cheque-records'));

  const created = await req(app, 'POST', '/api/cheque-records', {
    direction: 'in',
    amount: 50_000_000,
    cheque_number: 'LEAF338',
    sayadi: '1234567890123456',
    bank_name: 'ملی',
    branch: 'آزمایش',
    due_date: '1405/08/01',
    issue_date: '1405/07/01',
    receive_date: '1405/07/01',
    party_id: partyId,
  }, token);
  ok(created.status === 200 && created.data && created.data.id, 'create cheque', created.status);
  const chequeId = created.data.id;

  const detail = await req(app, 'GET', '/api/cheque-records/' + chequeId, null, token);
  ok(detail.status === 200, 'GET /:id');
  ok(detail.data.lifecycle_label === 'نزد صندوق' || detail.data.lifecycle_normalized === 'registered',
    'enriched lifecycle', detail.data && detail.data.lifecycle_label);
  ok(detail.data.cheque_number === 'LEAF338', 'leaf fields');

  const send = await req(app, 'POST', '/api/cheque-records/' + chequeId + '/send-to-bank', {
    collection_bank_id: bankId,
    date: '1405/07/02',
  }, token);
  ok(send.status === 200, 'send-to-bank', send.data && send.data.error);

  const hist = await req(app, 'GET', '/api/cheque-records/' + chequeId + '/history', null, token);
  ok(hist.status === 200 && Array.isArray(hist.data.events), 'GET history');
  const titles = (hist.data.events || []).map((e) => e.title).join('|');
  ok((hist.data.events || []).some((e) => e.ref_type === 'cheque_send_to_bank' || /واگذاری/.test(e.title || '')),
    'history has send-to-bank', titles);
  ok((hist.data.events || []).some((e) => e.journal_entry_id && (e.lines || []).length >= 2),
    'history JE has lines');

  const local = buildChequeHistory(db, chequeId);
  ok(Array.isArray(local) && local.length >= 1, 'buildChequeHistory local');
  const enriched = enrichChequeRow(db, db.prepare('SELECT * FROM cheque_records WHERE id=?').get(chequeId));
  ok(enriched.collection_bank_name, 'collection bank name enriched');

  const missing = await req(app, 'GET', '/api/cheque-records/99999991/history', null, token);
  ok(missing.status === 404, 'history 404');

  try { closeSessionStore(); } catch (_) { /* */ }
  console.log(`\n══ ${pass} pass / ${fail} fail ══`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
