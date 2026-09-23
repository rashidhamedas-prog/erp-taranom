/**
 * Dashboard AR/AP books stay per unique tafsili, and cheque alerts use Jalali dates.
 * Run: node server/scripts/test-dashboard-hotpath.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-hotpath-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-dashboard-hotpath-secret-32b!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const { addDaysToJalali, todayJalali } = require('../jalali');
const { glCustomersTafsiliBalance, customerLedgerTafsiliBalance } = require('../lib/customer-books');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}

(async () => {
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  for (let i = 1; i <= 3; i++) {
    db.prepare('INSERT INTO customers (user_id, biz, coa_code) VALUES (?,?,?)')
      .run(admin.id, 'مشتری ' + i, '11039' + String(100 + i));
  }
  const codeA = db.prepare(`SELECT coa_code, id FROM customers WHERE biz='مشتری 1'`).get();
  const codeB = db.prepare(`SELECT coa_code, id FROM customers WHERE biz='مشتری 2'`).get();
  const codeC = db.prepare(`SELECT coa_code, id FROM customers WHERE biz='مشتری 3'`).get();
  const shared = db.prepare('INSERT INTO customers (user_id, biz, coa_code) VALUES (?,?,?)')
    .run(admin.id, 'مشتری مشترک', codeA.coa_code).lastInsertRowid;

  function je(date, lines) {
    const id = db.prepare(`INSERT INTO journal_entries (entry_date, description, ref_type, status) VALUES (?,?,'manual','posted')`).run(date, 'hotpath').lastInsertRowid;
    const ins = db.prepare(`INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial) VALUES (?,?,?,?,?,?,?)`);
    for (const l of lines) ins.run(id, l.code, 'x', l.d || 0, l.c || 0, l.d || 0, l.c || 0);
  }
  je('1405/06/01', [{ code: codeA.coa_code, d: 100 }, { code: '3102', c: 100 }]);
  je('1405/06/01', [{ code: codeB.coa_code, d: 50 }, { code: '3102', c: 50 }]);
  je('1405/06/01', [{ code: codeC.coa_code, c: 20 }, { code: '3102', d: 20 }]);
  je('1405/08/01', [{ code: codeA.coa_code, d: 70 }, { code: '3102', c: 70 }]);

  const insLed = db.prepare(`INSERT INTO customer_ledger (customer_id, date, entry_type, description, debit, credit, user_id) VALUES (?,?, 'opening', 'hotpath', ?, ?, ?)`);
  insLed.run(codeA.id, '1405/06/01', 80, 0, admin.id);
  insLed.run(shared, '1405/06/01', 999, 0, admin.id);
  insLed.run(codeB.id, '1405/06/01', 10, 0, admin.id);
  insLed.run(codeB.id, '1405/08/01', 5, 0, admin.id);

  const glAll = glCustomersTafsiliBalance(db);
  ok(glAll.display === 220 && glAll.creditor === 20, 'GL display sums each tafsili once', glAll);
  const glAsOf = glCustomersTafsiliBalance(db, { asOf: '1405/07/01' });
  ok(glAsOf.display === 150 && glAsOf.creditor === 20, 'GL asOf drops later journal', glAsOf);
  const ledAll = customerLedgerTafsiliBalance(db);
  ok(ledAll.display === 95, 'ledger ignores the second customer on a shared code', ledAll);
  const ledAsOf = customerLedgerTafsiliBalance(db, { asOf: '1405/07/01' });
  ok(ledAsOf.display === 90, 'ledger asOf drops the later row', ledAsOf);

  const today = todayJalali();
  const horizon = addDaysToJalali(today, 7);
  const insChq = db.prepare(`INSERT INTO settlements (user_id, cust_id, amount, pay_type, date, cheque_due, cheque_status) VALUES (?,?,?,?,?,?,?)`);
  insChq.run(admin.id, codeA.id, 1, 'cheque', today, horizon, 'pending');
  insChq.run(admin.id, codeA.id, 1, 'cheque', today, '', 'pending');
  insChq.run(admin.id, codeA.id, 1, 'cheque', today, addDaysToJalali(today, -2), 'pending');
  insChq.run(admin.id, codeA.id, 1, 'cheque', today, addDaysToJalali(today, 40), 'pending');
  const sqliteCount = db.prepare(`
    SELECT COUNT(*) c FROM settlements
    WHERE pay_type='cheque' AND cheque_status='pending' AND cheque_due <= date(?, '+7 days')
  `).get(today).c;
  ok(sqliteCount === 0, 'sqlite date() on Jalali matches nothing', sqliteCount);

  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'hotpath', device_fingerprint: 'hotpath-fp',
  }).token;
  const app = express();
  app.use('/api/dashboard', require('../routes/dashboard'));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const r = await fetch(`http://127.0.0.1:${port}/api/dashboard/alerts`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  const body = await r.json();
  const cheque = (body.data && body.data.alerts || []).find((a) => a.type === 'cheque_due');
  ok(r.status === 200 && cheque && cheque.count === 2, 'alert counts overdue and next 7 Jalali days only', body);
  server.close();
  closeSessionStore();
  console.log(fail ? `FAIL ${fail}` : `PASS ${pass}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
