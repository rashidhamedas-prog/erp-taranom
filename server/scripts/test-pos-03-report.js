/**
 * POS-03 — card terminal report + GL reconcile (in-transit + bank net).
 * Run: node server/scripts/test-pos-03-report.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-03-report-'));
const dbFile = path.join(dir, 't.db');
try { fs.unlinkSync(dbFile); } catch (_) {}
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-pos-03-report-secret-32-bytes-min';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

delete require.cache[require.resolve('../db')];
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const { glBalanceRial } = require('../lib/pos');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

(async () => {
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test',
    device_name: 'pos-03-report',
    device_fingerprint: 'pos-03-report-fp',
  }).token;

  const salesId = db.prepare(`
    INSERT INTO users (name, username, password, role, active, must_change_password)
    VALUES ('فروشنده گزارش','sales.pos3',?, 'field_sales', 1, 0)
  `).run(bcrypt.hashSync('SalesPos9', 10)).lastInsertRowid;
  const salesUser = db.prepare('SELECT id,username,role,name,phone,auth_epoch FROM users WHERE id=?').get(salesId);
  const salesTok = issueStaffSession(db, salesUser, {
    device_kind: 'test',
    device_name: 'pos-03-sales',
    device_fingerprint: 'pos-03-sales-fp',
  }).token;

  const app = express();
  app.use(express.json());
  app.use('/api/pos', require('../routes/pos'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const BASE = `http://127.0.0.1:${port}`;

  async function api(method, p, tok) {
    const res = await fetch(BASE + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (tok || token),
      },
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = await res.text(); }
    return { status: res.status, data };
  }
  async function post(p, body, tok) {
    const res = await fetch(BASE + p, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (tok || token),
      },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }

  const bankCoa = '1102-pos3';
  db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level) VALUES (?,?,?,?,?)')
    .run(bankCoa, 'بانک تست گزارش POS', 'asset', '1102', 4);
  const bankId = db.prepare(`
    INSERT INTO banks (name, account_number, active, coa_code) VALUES ('ملت گزارش','010204',1,?)
  `).run(bankCoa).lastInsertRowid;
  const term = await post('/api/pos/terminals', {
    name: 'صندوق گزارش', terminal_id: 'T-REP-1', bank_id: bankId,
  });
  ok(term.status === 200 && term.data && term.data.id, 'terminal created', term.data && term.data.error);

  console.log('\n— open receipt: in-transit matches GL —');
  const rec = await post('/api/pos/receipts', {
    terminal_id: term.data.id,
    date: '1405/01/16',
    amount_rial: 1000000,
    idempotency_key: 'pos3-r1',
  });
  ok(rec.status === 200, 'receipt 200', rec.data && rec.data.error);
  ok(glBalanceRial(db, '1118') === 1000000, 'in-transit GL 1,000,000');
  ok(glBalanceRial(db, bankCoa) === 0, 'bank still 0 before settle');

  const before = await api('GET', '/api/pos/report?from=1405/01/16&to=1405/01/16');
  ok(before.status === 200, 'report 200');
  ok(before.data && before.data.totals && before.data.totals.receipt_gross_rial === 1000000, 'period gross', before.data && before.data.totals);
  ok(before.data && before.data.reconcile && before.data.reconcile.in_transit_open_rial === 1000000, 'open remaining');
  ok(before.data && before.data.reconcile && before.data.reconcile.in_transit_gl_rial === 1000000, 'in-transit GL');
  ok(before.data && before.data.reconcile && before.data.reconcile.in_transit_delta_rial === 0, 'in-transit delta 0');
  ok(before.data && before.data.reconcile && before.data.reconcile.ok === true, 'reconcile ok before settle');

  const salesGet = await api('GET', '/api/pos/report', salesTok);
  ok(salesGet.status === 403, 'field_sales report 403', String(salesGet.status));

  console.log('\n— settle next day: bank net matches POS GL —');
  const batch = await post('/api/pos/batches', {
    date: '1405/01/17',
    gross_rial: 1000000,
    fee_rial: 10000,
    shortage_rial: 5000,
    terminal_id: term.data.id,
    receipt_ids: [rec.data.id],
    idempotency_key: 'pos3-b1',
  });
  ok(batch.status === 200, 'batch 200', batch.data && batch.data.error);
  ok(Number(batch.data.net_rial) === 985000, 'net 985000');
  ok(glBalanceRial(db, '1118') === 0, 'in-transit cleared');
  ok(glBalanceRial(db, bankCoa) === 985000, 'bank +net');

  const after = await api('GET', '/api/pos/report?from=1405/01/16&to=1405/01/17');
  ok(after.status === 200 && after.data.reconcile.ok === true, 'reconcile ok after settle');
  ok(after.data.reconcile.in_transit_open_rial === 0, 'open remaining 0');
  ok(after.data.reconcile.in_transit_gl_rial === 0, 'in-transit GL 0');
  ok(after.data.totals.batch_gross_rial === 1000000, 'batch gross');
  ok(after.data.totals.batch_fee_rial === 10000, 'batch fee');
  ok(after.data.totals.batch_shortage_rial === 5000, 'batch shortage');
  ok(after.data.totals.batch_net_rial === 985000, 'batch net');
  const bankRow = (after.data.reconcile.banks || []).find((b) => Number(b.bank_id) === Number(bankId));
  ok(bankRow && bankRow.batch_net_rial === 985000, 'bank row net');
  ok(bankRow && bankRow.pos_gl_net_rial === 985000, 'bank POS GL net');
  ok(bankRow && bankRow.delta_rial === 0, 'bank delta 0');

  const cutoff = await api('GET', '/api/pos/report?from=1405/01/16&to=1405/01/16');
  ok(cutoff.data.reconcile.in_transit_open_rial === 1000000, 'as-of 16 still open (settle on 17)');
  ok(cutoff.data.reconcile.in_transit_gl_rial === 1000000, 'as-of 16 in-transit GL');
  ok(cutoff.data.totals.batch_count === 0, 'no batch on 16');

  const variance = await api('GET', '/api/pos/report?variance=1&from=1405/01/16&to=1405/01/17');
  ok(variance.status === 200 && (variance.data.batches || []).length === 1, 'variance filter keeps shortage batch');
  ok(Number(variance.data.batches[0].shortage_rial) === 5000, 'shortage 5000');

  const termFilter = await api('GET', `/api/pos/report?terminal_id=${term.data.id}`);
  ok(termFilter.status === 200 && termFilter.data.totals.receipt_gross_rial === 1000000, 'terminal filter');

  const csv = await fetch(BASE + '/api/pos/report/export?from=1405/01/16&to=1405/01/17', {
    headers: { Authorization: 'Bearer ' + token },
  });
  const csvText = await csv.text();
  ok(csv.status === 200 && csvText.includes('1000000'), 'csv has gross');
  ok(csvText.includes('985000') || csvText.includes('reconcile'), 'csv has net or reconcile');
  ok(csvText.includes('in_transit'), 'csv has in-transit row');

  server.close();
  try { closeSessionStore(); } catch (_) {}
  console.log('\nPOS-03 report: ' + (fail ? '❌ ' : '✅ ') + pass + ' پاس، ' + fail + ' رد');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
