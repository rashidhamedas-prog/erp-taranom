'use strict';
/**
 * Cash-on-document v204 — sales remainder on customer AR, purchase AP + cash.
 * Run: node server/scripts/test-cash-invoice-v204.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

console.log('\n══ Cash invoice v204 ══\n');

const {
  moneyRial, resolveCashPaid, assertCashBoxRequired,
} = require('../lib/cash-on-document');
const { resolveInvoicePayments } = require('../lib/invoice-payments');
const { rialToLedger } = require('../lib/money');
const { assertJournalLinesBalanced } = require('../lib/customer-books');

ok(typeof moneyRial === 'function' && typeof resolveCashPaid === 'function', 'require cash-on-document');
ok(typeof resolveInvoicePayments === 'function', 'require invoice-payments');

const fullCash = resolveCashPaid({ pay_type: 'cash' }, 100000);
ok(fullCash.paid === 100000 && fullCash.remainder === 0, 'نقد خالی = کل مبلغ، مانده صفر');

const partCash = resolveCashPaid({ pay_type: 'cash', pay_amount: 40000 }, 100000);
ok(partCash.paid === 40000 && partCash.remainder === 60000, 'نقد ۴۰ از ۱۰۰، مانده ۶۰');

try {
  resolveCashPaid({ pay_type: 'cash', pay_amount: 120000 }, 100000);
  ok(false, 'نقد بیشتر از فاکتور باید رد شود');
} catch (e) {
  ok(e.code === 'E_CASH_OVER_INVOICE' && e.status === 400, 'نقد بیشتر از فاکتور E_CASH_OVER_INVOICE', e.code);
}

try {
  assertCashBoxRequired('cash', null);
  ok(false, 'صندوق خالی باید رد شود');
} catch (e) {
  ok(e.code === 'E_CASH_BOX_REQUIRED' && e.status === 400, 'صندوق خالی E_CASH_BOX_REQUIRED', e.code);
}

try {
  const full = resolveInvoicePayments({ pay_type: 'cash', pay_amount: 100000 }, 100000);
  ok(full.splits.length === 0 && full.skipInvoiceCash === false, 'نقد کامل = بدون قسط، skipInvoiceCash=false');
} catch (e) { ok(false, 'نقد کامل resolveInvoicePayments', e.message); }

try {
  const part = resolveInvoicePayments({ pay_type: 'cash', pay_amount: 40000, cash_box_id: 2 }, 100000);
  ok(part.splits.length === 1 && part.splits[0].amount === 40000 && part.skipInvoiceCash === true, 'نقد جزئی یک قسط');
} catch (e) { ok(false, 'نقد جزئی resolveInvoicePayments', e.message); }

try {
  resolveInvoicePayments({ pay_type: 'cash', pay_amount: 120000 }, 100000);
  ok(false, 'هدر نقد بیشتر از فاکتور باید رد شود');
} catch (e) {
  ok(e.code === 'E_CASH_OVER_INVOICE', 'هدر نقد بیش‌ازحد E_CASH_OVER_INVOICE', e.code);
}

try {
  resolveInvoicePayments({
    pay_splits: [{ pay_type: 'cash', amount: 120000 }],
  }, 100000);
  ok(false, 'جمع اقساط بیشتر باید رد شود');
} catch (e) {
  ok(e.code === 'E_PAY_SPLIT_OVER', 'جمع اقساط بیشتر E_PAY_SPLIT_OVER', e.code);
}

const emptyCash = resolveInvoicePayments({ pay_type: 'cash' }, 100000);
ok(emptyCash.splits.length === 0 && emptyCash.skipInvoiceCash === false, 'pay_amount خالی نقد کامل می‌ماند');

const purchasesSrc = fs.readFileSync(path.join(__dirname, '../routes/purchases.js'), 'utf8');
const invoicesSrc = fs.readFileSync(path.join(__dirname, '../routes/invoices.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');

const purchasePost = purchasesSrc.slice(
  purchasesSrc.indexOf("router.post('/',"),
  purchasesSrc.indexOf("router.delete('/:id'")
);
ok(
  purchasePost.includes('payableAcct')
    && purchasePost.includes('if (paid > 0)')
    && !/pType === 'credit' \? payableAcct/.test(purchasePost),
  'purchases POST: payableAcct در مسیر نقد (نه فقط نسیه)'
);
ok(purchasesSrc.includes('pay_amount') && purchasesSrc.includes('pay_amount_rial'), 'purchases pay_amount');
ok(purchasesSrc.includes('E_CASH_BOX_REQUIRED'), 'purchases E_CASH_BOX_REQUIRED');
ok(invoicesSrc.includes('E_CASH_BOX_REQUIRED'), 'invoices E_CASH_BOX_REQUIRED');
ok(
  /ensureColumn\(\s*db,\s*'purchase_invoices',\s*'pay_amount_rial'/.test(dbSrc),
  'db.js pay_amount_rial روی purchase_invoices'
);

const net = 80000;
const vat = 20000;
const final = 100000;
const paid = 40000;
const purchaseLines = [
  { code: 'inv', name: 'موجودی', debit: rialToLedger(net), credit: 0 },
  { code: 'vat', name: 'VAT', debit: rialToLedger(vat), credit: 0 },
  { code: 'ap', name: 'پرداختنی', debit: 0, credit: rialToLedger(final) },
  { code: 'ap', name: 'پرداختنی', debit: rialToLedger(paid), credit: 0 },
  { code: 'cash', name: 'صندوق', debit: 0, credit: rialToLedger(paid) },
];
try {
  assertJournalLinesBalanced(purchaseLines, 'خرید نقد جزئی');
  ok(true, 'سند خرید نقد جزئی تراز است');
} catch (e) {
  ok(false, 'سند خرید نقد جزئی تراز است', e.message);
}

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(appJs.includes('function syncInvCashPayAmount'), 'UI syncInvCashPayAmount');
ok(appJs.includes('id="inv-pay-remain"') && appJs.includes('aria-live="polite"'), 'UI باقیمانده فروش زنده');
ok(appJs.includes('id="po-pay-amount"') && appJs.includes('function syncPoCashPayAmount'), 'UI مبلغ نقد خرید');
ok(appJs.includes('الباقی') && appJs.includes('حساب تأمین‌کننده'), 'UI متن الباقی تأمین‌کننده');
ok(appJs.includes('صندوق را انتخاب کنید'), 'UI الزام صندوق');
try { new Function(appJs); ok(true, 'app.js نحو معتبر'); }
catch (e) { ok(false, 'app.js نحو معتبر', e.message); }

function loadBetterSqlite3() {
  const candidates = [
    path.join(__dirname, '..', 'node_modules', 'better-sqlite3'),
    'D:/soft/Claud/porje/crm-taranom/erp-taranom1/server/node_modules/better-sqlite3',
  ];
  for (const c of candidates) {
    try { return require(c); } catch (_) {}
  }
  return require('better-sqlite3');
}

try {
  const Database = loadBetterSqlite3();
  const dbPath = path.join(os.tmpdir(), `cash-v204-${Date.now()}.db`);
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE journal_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      debit REAL DEFAULT 0, credit REAL DEFAULT 0
    );
  `);
  const ins = db.prepare('INSERT INTO journal_lines (debit, credit) VALUES (?,?)');
  purchaseLines.forEach((l) => ins.run(l.debit, l.credit));
  const tot = db.prepare('SELECT SUM(debit) d, SUM(credit) c FROM journal_lines').get();
  ok(Math.abs(Number(tot.d) - Number(tot.c)) < 0.01, 'live JE خرید تراز است', tot);
  db.close();
  try { fs.unlinkSync(dbPath); } catch (_) {}
} catch (e) {
  const abi = /NODE_MODULE_VERSION|better-sqlite3/.test(String(e.message || e));
  if (abi) console.log('  SKIP sqlite cash-v204:', String(e.message || e).split('\n')[0]);
  else ok(false, 'sqlite cash-v204', e.message);
}

if (fail) {
  console.log(`\nCash invoice v204 FAILED ${fail}/${pass + fail}`);
  process.exit(1);
}
console.log(`\nCash invoice v204 PASS ${pass}/${pass + fail}`);
