/**
 * Cash invoices must appear on the customer statement; AR KPI is tafsili-only;
 * repair backfills missing invoice ledger + reclasses cash-to-AR.
 * Run: node server/scripts/test-ledger-statement-repair.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-stmt-'));
const dbFile = path.join(dir, 't.db');
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-ledger-statement-repair-secret-32b';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const { postToLedger } = require('../lib/ledger');
const { acct } = require('../lib/coa-map');
const { salesJournalLines, postInvoiceCustomerLedger, repairCustomerBooks } = require('../lib/customer-books');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra == null ? '' : extra); }
}

(async () => {
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'ledger-stmt', device_fingerprint: 'ledger-stmt-fp',
  }).token;

  const recv = acct(db, 'coa_receivable');
  const cash = acct(db, 'coa_cash_default');
  const sales = acct(db, 'coa_sales');
  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES ('11030199','تفصیلی تست صورت‌حساب','asset',?,4,1)
  `).run(recv.code);

  const custId = db.prepare(
    "INSERT INTO customers (user_id,biz,phone,coa_code,balance) VALUES (?,?,?,?,?)"
  ).run(admin.id, 'معین تست', '09025050811', '11030199', 1000).lastInsertRowid;
  db.prepare(`
    INSERT INTO customer_ledger (customer_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(custId, '', 'opening', 'opening', custId, 'مانده اولیه حساب', 1000, 0, admin.id);

  const app = express();
  app.use(express.json());
  app.use('/api/accounting', require('../routes/accounting'));
  app.use('/api/customers', require('../routes/customers'));
  app.use('/api/admin', require('../routes/admin'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;

  async function api(method, p, body) {
    const res = await fetch(BASE + p, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }

  const CASH_AMT = 131_736_000;
  const CREDIT_AMT = 224_083_200;
  const SETTLED = 100_000_000;

  const cashInv = db.prepare(`
    INSERT INTO invoices (user_id,cust_id,num,type,date,rows,subtotal,final,pay_type,approved,stock_deducted)
    VALUES (?,?,?,?,?,'[]',?,?, 'cash', 1, 1)
  `).run(admin.id, custId, 'T-CASH', 'normal', '1405/05/26', CASH_AMT, CASH_AMT).lastInsertRowid;
  postToLedger(db, {
    sourceType: 'invoice', sourceId: cashInv, date: '1405/05/26',
    description: 'فاکتور معمولی T-CASH', createdBy: admin.id,
    lines: [
      { code: cash.code, name: cash.name, debit: CASH_AMT / 10, credit: 0 },
      { code: sales.code, name: sales.name, debit: 0, credit: CASH_AMT / 10 },
    ],
  });
  const settId = db.prepare(`
    INSERT INTO settlements (user_id,cust_id,invoice_id,amount,pay_type,date,status)
    VALUES (?,?,?,?, 'bank_transfer', '1405/05/26', 'posted')
  `).run(admin.id, custId, cashInv, SETTLED).lastInsertRowid;
  db.prepare(`
    INSERT INTO customer_ledger (customer_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(custId, '1405/05/26', 'settlement', 'settlement', settId, 'تسویه واریز بانکی', 0, SETTLED, admin.id);
  postToLedger(db, {
    sourceType: 'settlement', sourceId: settId, date: '1405/05/26',
    description: 'تسویه واریز بانکی مشتری', createdBy: admin.id,
    lines: [
      { code: cash.code, name: cash.name, debit: SETTLED / 10, credit: 0 },
      { code: '11030199', name: 'تفصیلی تست صورت‌حساب', debit: 0, credit: SETTLED / 10 },
    ],
  });

  const creditInv = db.prepare(`
    INSERT INTO invoices (user_id,cust_id,num,type,date,rows,subtotal,final,pay_type,approved,stock_deducted)
    VALUES (?,?,?,?,?,'[]',?,?, 'credit', 0, 0)
  `).run(admin.id, custId, 'T-CREDIT', 'normal', '1405/05/31', CREDIT_AMT, CREDIT_AMT).lastInsertRowid;

  postToLedger(db, {
    sourceType: 'opening_balance', sourceId: 9999, date: '1405/05/11',
    description: 'مانده اول دوره — شخص غیرمشتری', createdBy: admin.id,
    voucherType: 'opening',
    lines: [
      { code: recv.code, name: recv.name, debit: 40_000_000_000 / 10, credit: 0 },
      { code: acct(db, 'coa_opening_balance').code, name: 'افتتاحیه', debit: 0, credit: 40_000_000_000 / 10 },
    ],
  });

  let r = await api('GET', '/api/accounting/statement/' + custId);
  ok(r.status === 200, 'statement 200');
  const nums = (r.data?.entries || []).map((e) => String(e.description || '') + ' ' + String(e.ref_type || ''));
  ok(nums.some((s) => s.includes('T-CASH') || s.includes('invoice-' + cashInv) || s.includes(`invoice`)),
    'cash invoice appears on statement', nums);
  const cashRow = (r.data.entries || []).find((e) => e.ref_type === 'invoice' && Number(e.ref_id) === Number(cashInv));
  const creditRow = (r.data.entries || []).find((e) => e.ref_type === 'invoice' && Number(e.ref_id) === Number(creditInv));
  ok(!!cashRow && Number(cashRow.debit) === CASH_AMT, 'cash invoice debit on statement', cashRow);
  ok(!!creditRow && Number(creditRow.debit) === CREDIT_AMT, 'credit invoice debit on statement', creditRow);
  const expectNet = 1000 + CASH_AMT + CREDIT_AMT - SETTLED;
  ok(Math.abs(Number(r.data.ledger_closing) - expectNet) <= 1, 'ledger closing after repair', r.data.ledger_closing);
  ok(Math.abs(Number(r.data.closing) - expectNet) <= 1, 'GL closing matches ledger', r.data.closing);
  ok(r.data.books_mismatch !== true, 'no statement mismatch after repair', r.data.books_mismatch);

  r = await api('GET', '/api/accounting/overview');
  ok(r.status === 200, 'overview 200');
  ok(Number(r.data.totalReceivable) < 1_000_000_000, 'overview AR ignores 40B control dump', r.data.totalReceivable);
  ok(r.data.books_mismatch !== true, 'overview books match after repair', r.data.books_mismatch);

  r = await api('GET', '/api/customers');
  ok(r.status === 200, 'customers list 200');
  const list = Array.isArray(r.data) ? r.data : (r.data?.data || []);
  const listed = list.find((c) => Number(c.id) === Number(custId));
  ok(!!listed, 'test customer on CRM list', list.length);
  ok(Math.abs(Number(listed && listed.balance) - expectNet) <= 1, 'CRM list uses GL net not stale ledger', listed && listed.balance);
  ok(Number(listed && listed.balance) > 0, 'Moein-like customer is debtor after invoices', listed && listed.balance);

  r = await api('GET', '/api/admin/customer-balances');
  ok(r.status === 200, 'admin customer-balances 200');
  const adminRow = (r.data || []).find((c) => Number(c.id) === Number(custId));
  ok(!!adminRow && Math.abs(Number(adminRow.balance) - expectNet) <= 1, 'dashboard balances use GL net', adminRow && adminRow.balance);

  const lines = salesJournalLines(db, custId, {
    subtotal: 10_000, discAmt: 0, final: 10_000, vatAmount: 0, netBeforeVat: 10_000,
  }, false, { payType: 'cash' });
  ok(lines.some((l) => l.code === '11030199' && l.debit > 0), 'new cash invoice still debits customer AR');
  ok(lines.filter((l) => l.code === '11030199').length >= 2, 'new cash invoice also credits AR for receipt');

  postInvoiceCustomerLedger(db, {
    customerId: custId, date: '1405/06/01', invId: 88001, num: 'T-NEW',
    invType: 'normal', final: 5000, userId: admin.id, payType: 'cash',
  });
  const pay = db.prepare("SELECT * FROM customer_ledger WHERE ref_type='invoice_payment' AND ref_id=88001").get();
  ok(!!pay && Number(pay.credit) === 5000, 'immediate-pay writes ledger receipt');

  db.prepare("DELETE FROM settings WHERE key='customer_books_repair_v1'").run();
  const again = repairCustomerBooks(db);
  ok(again.skipped === true || (again.ledger === 0 && again.journal === 0), 'repair is idempotent', again);

  await new Promise((res, rej) => server.close((e) => e ? rej(e) : res()));
  try { closeSessionStore(); } catch (_) {}
  console.log(fail ? `\n❌ ${pass} ok / ${fail} fail` : `\n✅ ${pass} پاس`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
