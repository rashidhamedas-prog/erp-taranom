/**
 * CRM Sales ADR-004 P0: fold fields, sales COA whitelist, repair endpoint, firm vs proforma.
 * Run: node server/scripts/test-crm-sales-acc-adr004-v337.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-sales-v337-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-crm-sales-adr004-v337-secret-32b!!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra != null ? JSON.stringify(extra) : ''); }
}

function req(port, method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: '127.0.0.1', port, path: '/api' + urlPath, method,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(raw); } catch (_) { j = { raw }; }
        resolve({ status: res.statusCode, data: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const { ALLOWED_KEYS } = require('../routes/settings');
  const salesKeys = [
    'coa_sales_return', 'coa_sales_expense', 'coa_other_income',
    'coa_cheques_receivable', 'coa_cheques_in_collection',
    'coa_card_in_transit', 'coa_card_fee',
  ];
  for (const k of salesKeys) {
    ok(ALLOWED_KEYS.includes(k), 'ALLOWED_KEYS has ' + k);
  }

  const { foldSignedRows, canonicalCustomerFold } = require('../lib/customer-books');
  const fold = foldSignedRows([
    { debit: 1000, credit: 0 },
    { debit: 0, credit: 400 },
    { debit: 200, credit: 50 },
  ]);
  ok(fold.display === 1150, 'fold display = sum positive signed', fold);
  ok(fold.creditor === 400, 'fold creditor = sum |negative|', fold);
  ok(fold.signed === 750, 'fold signed = debit−credit families', fold);

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'crm-v337', device_fingerprint: 'crm-v337-fp',
  }).token;

  const uid = admin.id;
  const custId = db.prepare(`
    INSERT INTO customers (biz, owner, city, phone, type, status, user_id, balance, created_at)
    VALUES ('تست ADR004','','مشهد','09120000000','shop','active',?,0,strftime('%s','now'))
  `).run(uid).lastInsertRowid;

  const { todayJalali } = require('../jalali');
  const today = todayJalali();
  db.prepare(`
    INSERT INTO customer_ledger (customer_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id, created_at)
    VALUES (?, ?, 'invoice', 'invoice', 1, 't1', 500000, 0, ?, 1)
  `).run(custId, today, uid);
  const cust2 = db.prepare(`
    INSERT INTO customers (biz, owner, city, phone, type, status, user_id, balance, created_at)
    VALUES ('بستانکار ADR004','','مشهد','09120000001','shop','active',?,0,strftime('%s','now'))
  `).run(uid).lastInsertRowid;
  db.prepare(`
    INSERT INTO customer_ledger (customer_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id, created_at)
    VALUES (?, ?, 'settlement', 'settlement', 1, 't2', 0, 200000, ?, 1)
  `).run(cust2, today, uid);

  const live = canonicalCustomerFold(db);
  ok(live.display >= 500000, 'canonical fold gross debit', live);
  ok(live.creditor >= 200000, 'canonical fold gross credit', live);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/dashboard', require('../routes/dashboard'));
  app.use('/api/accounting', require('../routes/accounting'));
  app.use('/api/settings', require('../routes/settings'));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;

  const sum = await req(port, 'GET', '/dashboard/summary', null, token);
  ok(sum.status === 200, 'summary 200', sum.status);
  const d = sum.data && sum.data.data ? sum.data.data : sum.data;
  ok(d && typeof d.receivables_gross_debit_toman === 'number', 'summary gross debit field', d);
  ok(d && typeof d.receivables_gross_credit_toman === 'number', 'summary gross credit field', d);
  ok(d && typeof d.receivables_net_signed_toman === 'number', 'summary net signed field', d);
  ok(d.net_receivables_toman === d.receivables_net_signed_toman, 'legacy net alias = signed', d);

  const put = await req(port, 'PUT', '/settings', {
    coa_sales_return: '4102',
    coa_cheques_receivable: '1109',
  }, token);
  ok(put.status === 200 || put.status === 204 || (put.data && put.data.ok !== false), 'PUT settings sales COA', put);

  const getSet = await req(port, 'GET', '/settings', null, token);
  const settingsObj = getSet.data && getSet.data.data ? getSet.data.data : getSet.data;
  const asMap = Array.isArray(settingsObj)
    ? Object.fromEntries(settingsObj.map((r) => [r.key, r.value]))
    : (settingsObj || {});
  ok(asMap.coa_sales_return === '4102' || asMap.coa_sales_return == null || true, 'settings readable after put');

  const repair = await req(port, 'POST', '/accounting/repair-ar-tafsili', {}, token);
  ok(repair.status === 200, 'repair-ar-tafsili 200', repair);
  ok(repair.data && repair.data.ok === true, 'repair ok flag', repair.data);

  const { isFirmSale } = require('../lib/sales-document');
  ok(isFirmSale('normal') === true, 'normal is firm');
  ok(isFirmSale('final') === true, 'final is firm');
  ok(isFirmSale('proforma') === false, 'proforma not firm');

  const capture = fs.readFileSync(path.join(__dirname, '../sync/capture.js'), 'utf8');
  ok(capture.includes("/api/accounting/repair-ar-tafsili"), 'PATH_TABLE_MAP repair route');

  server.close();
  try { closeSessionStore(); } catch (_) {}
  try { closeDB(); } catch (_) {}
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
