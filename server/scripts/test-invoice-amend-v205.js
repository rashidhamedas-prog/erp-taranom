'use strict';
/**
 * Invoice in-place amend v205 — VAT defaults + PUT normal/proforma (no reverse JE).
 * Run: node server/scripts/test-invoice-amend-v205.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

console.log('\n══ Invoice amend v205 ══\n');

const { defaultVatExempt, resolveVatExemptFlag } = require('../lib/amend-invoice');
ok(defaultVatExempt('normal') === 1, 'defaultVatExempt(normal)=1');
ok(defaultVatExempt('proforma') === 1, 'defaultVatExempt(proforma)=1');
ok(defaultVatExempt('final') === 0, 'defaultVatExempt(final)=0');
ok(resolveVatExemptFlag('normal', undefined) === 1, 'omitted vat on normal → 1');
ok(resolveVatExemptFlag('final', undefined) === 0, 'omitted vat on final → 0');
ok(resolveVatExemptFlag('normal', 0) === 0, 'explicit vat_exempt=0 honored');
ok(resolveVatExemptFlag('normal', 1) === 1, 'explicit vat_exempt=1 honored');
ok(resolveVatExemptFlag('normal', undefined, 0) === 0, 'PUT fallback keeps existing 0');

const invoicesSrc = fs.readFileSync(path.join(__dirname, '../routes/invoices.js'), 'utf8');
const ledgerSrc = fs.readFileSync(path.join(__dirname, '../lib/ledger.js'), 'utf8');
const booksSrc = fs.readFileSync(path.join(__dirname, '../lib/customer-books.js'), 'utf8');
const amendSrc = fs.readFileSync(path.join(__dirname, '../lib/amend-invoice.js'), 'utf8');

ok(invoicesSrc.includes('function defaultVatExempt') || invoicesSrc.includes('defaultVatExempt'),
  'invoices.js uses defaultVatExempt');
ok(invoicesSrc.includes('resolveVatExemptFlag'), 'invoices.js resolveVatExemptFlag');
ok(invoicesSrc.includes('amendPostedInvoiceInPlace'), 'PUT calls amendPostedInvoiceInPlace');
ok(
  invoicesSrc.includes("row.type === 'final'")
    && !invoicesSrc.includes('فاکتور قطعی ثبت حسابداری شده است؛ برای اصلاح، آن را ابطال و فاکتور جدید ثبت کنید'),
  'PUT no longer 409s all firm sales'
);
ok(/if \(row\.type === 'normal'\)/.test(invoicesSrc), 'PUT normal → amend path');
ok(ledgerSrc.includes('function rewriteJournalEntry'), 'ledger.js rewriteJournalEntry');
ok(/module\.exports = \{[^}]*rewriteJournalEntry/.test(ledgerSrc.replace(/\n/g, ' ')),
  'rewriteJournalEntry exported');
ok(booksSrc.includes('function updateInvoiceCustomerLedger'), 'updateInvoiceCustomerLedger');
ok(!/entry_type:\s*'reversal'/.test(
  booksSrc.slice(booksSrc.indexOf('function updateInvoiceCustomerLedger'), booksSrc.indexOf('function reverseInvoiceCustomerLedger'))
), 'updateInvoiceCustomerLedger never inserts reversal');
ok(!amendSrc.includes('reverseInventoryMovement'), 'amend-invoice no reverseInventoryMovement');
ok(!amendSrc.includes('reverseStockBySource'), 'amend-invoice no reverseStockBySource');
ok(!amendSrc.includes('invoice_cogs_reversal'), 'amend-invoice no invoice_cogs_reversal');
ok(!amendSrc.includes('postToLedger'), 'amend-invoice does not postToLedger (rewrite only)');
ok(amendSrc.includes("سند فروش این فاکتور پیدا نشد"), 'missing sale JE → 409 Persian');

const putBlock = invoicesSrc.slice(
  invoicesSrc.indexOf("router.put('/:id'"),
  invoicesSrc.indexOf("router.delete('/:id'")
);
ok(putBlock.includes("row.type === 'final'"), 'PUT locks official/final');
ok(putBlock.includes('amendPostedInvoiceInPlace'), 'PUT normal uses in-place amend');
ok(putBlock.includes("row.type === 'proforma'") || putBlock.includes("type === 'proforma'"),
  'PUT proforma still updates row only');
ok(putBlock.includes('E_TYPE_LOCKED') && putBlock.includes('تغییر نوع فاکتور از ویرایش مجاز نیست'),
  'PUT rejects type change in place');

ok(typeof require('../lib/amend-invoice').amendPostedInvoiceInPlace === 'function',
  'amendPostedInvoiceInPlace exported');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-amend-v205-'));
const testDb = path.join(dir, 't.db');
process.env.DB_PATH = testDb;
process.env.SYNC_ROLE = 'central';
process.env.SMS_DISABLED = '1';
process.env.ERP_TEST_ISOLATION = '1';
process.env.JWT_SECRET = 'invoice-amend-v205-secret-32chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.NODE_ENV = 'test';

let db = null;
try {
  delete require.cache[require.resolve('../db')];
  const { initDB, getDB } = require('../db');
  initDB();
  db = getDB();
} catch (e) {
  const abi = /NODE_MODULE_VERSION|better-sqlite3/.test(String(e.message || e));
  if (abi) console.log('  SKIP sqlite amend-v205:', String(e.message || e).split('\n')[0]);
  else ok(false, 'initDB', e.message);
}

(async () => {
  if (!db) {
    console.log(`\n${fail ? '💥' : '🎉'} ${pass} passed, ${fail} failed (sqlite skipped)`);
    process.exitCode = fail ? 1 : 0;
    return;
  }

  const { todayJalali } = require('../jalali');
  const { rewriteJournalEntry } = require('../lib/ledger');
  const { updateInvoiceCustomerLedger } = require('../lib/customer-books');
  ok(typeof rewriteJournalEntry === 'function', 'require rewriteJournalEntry');
  ok(typeof updateInvoiceCustomerLedger === 'function', 'require updateInvoiceCustomerLedger');

  function tableCols(name) {
    return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
  }

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  ok(!!admin, 'admin user');
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);

  let whId = db.prepare("SELECT id FROM warehouses WHERE COALESCE(is_default,0)=1 ORDER BY id LIMIT 1").get()?.id
    || db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get()?.id;
  if (!whId) {
    const whCols = tableCols('warehouses');
    const cols = ['name'];
    const vals = ['انبار تست v205'];
    if (whCols.has('code')) { cols.push('code'); vals.push('WH-V205'); }
    if (whCols.has('warehouse_type')) { cols.push('warehouse_type'); vals.push('finished_goods'); }
    if (whCols.has('active')) { cols.push('active'); vals.push(1); }
    if (whCols.has('is_default')) { cols.push('is_default'); vals.push(1); }
    whId = db.prepare(`INSERT INTO warehouses (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals).lastInsertRowid;
  }
  ok(!!whId, 'warehouse', whId);

  const pCols = tableCols('products');
  const pFields = ['name'];
  const pVals = ['مانتو v205'];
  if (pCols.has('code')) { pFields.push('code'); pVals.push('P-V205'); }
  if (pCols.has('price')) { pFields.push('price'); pVals.push(100000); }
  if (pCols.has('cost')) { pFields.push('cost'); pVals.push(40000); }
  if (pCols.has('stock')) { pFields.push('stock'); pVals.push(50); }
  if (pCols.has('warehouse_id')) { pFields.push('warehouse_id'); pVals.push(whId); }
  if (pCols.has('user_id')) { pFields.push('user_id'); pVals.push(admin.id); }
  if (pCols.has('average_cost_rial')) { pFields.push('average_cost_rial'); pVals.push(40000); }
  const prodId = db.prepare(`INSERT INTO products (${pFields.join(',')}) VALUES (${pFields.map(() => '?').join(',')})`).run(...pVals).lastInsertRowid;
  try {
    db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)').run(prodId, whId, 50);
  } catch (_) { /* optional */ }
  ok(!!prodId, 'product');

  let custId;
  try {
    custId = db.prepare("INSERT INTO customers (biz, owner, phone, user_id) VALUES ('فروشگاه v205','مالک','09150000005',?)").run(admin.id).lastInsertRowid;
  } catch (e) {
    try { custId = db.prepare('INSERT INTO customers (biz, user_id) VALUES (?,?)').run('فروشگاه v205', admin.id).lastInsertRowid; }
    catch (e2) { ok(false, 'customer seed', e2.message); }
  }
  ok(!!custId, 'customer');

  const boxCols = tableCols('cash_boxes');
  const boxFields = ['name'];
  const boxVals = ['صندوق v205'];
  if (boxCols.has('active')) { boxFields.push('active'); boxVals.push(1); }
  if (boxCols.has('is_petty_cash')) { boxFields.push('is_petty_cash'); boxVals.push(0); }
  const cashBoxId = db.prepare(`INSERT INTO cash_boxes (${boxFields.join(',')}) VALUES (${boxFields.map(() => '?').join(',')})`).run(...boxVals).lastInsertRowid;
  ok(!!cashBoxId, 'cash box');

  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'v205', device_fingerprint: 'v205-fp',
  }).token;

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/invoices', require('../routes/invoices'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;

  async function api(method, p, body) {
    const res = await fetch(BASE + p, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const ct = res.headers.get('content-type') || '';
    let data = null;
    if (ct.includes('application/json')) data = await res.json();
    else data = await res.text();
    return { status: res.status, data, ok: res.ok };
  }

  const line = { product_id: prodId, qty: 2, price: 100000, warehouse_id: whId, name: 'مانتو v205' };

  const normalOmit = await api('POST', '/api/invoices', {
    cust_id: custId, type: 'normal', date: todayJalali(),
    pay_type: 'credit', warehouse_id: whId, disc: 0, rows: [line],
  });
  ok(normalOmit.status === 200 && normalOmit.data && normalOmit.data.id,
    'POST normal without vat_exempt',
    normalOmit.status + ' ' + JSON.stringify(normalOmit.data && (normalOmit.data.error || normalOmit.data)).slice(0, 240));
  if (normalOmit.data && normalOmit.data.id) {
    const stored = db.prepare('SELECT vat_exempt FROM invoices WHERE id=?').get(normalOmit.data.id);
    ok(Number(stored.vat_exempt) === 1, 'POST normal omitted → vat_exempt=1', stored && stored.vat_exempt);
  }

  const finalOmit = await api('POST', '/api/invoices', {
    cust_id: custId, type: 'final', date: todayJalali(),
    pay_type: 'credit', warehouse_id: whId, disc: 0, rows: [line],
  });
  ok(finalOmit.status === 200 && finalOmit.data && finalOmit.data.id,
    'POST final without vat_exempt',
    finalOmit.status + ' ' + JSON.stringify(finalOmit.data && (finalOmit.data.error || finalOmit.data)).slice(0, 240));
  if (finalOmit.data && finalOmit.data.id) {
    const stored = db.prepare('SELECT vat_exempt FROM invoices WHERE id=?').get(finalOmit.data.id);
    ok(Number(stored.vat_exempt) === 0, 'POST final omitted → vat_exempt=0', stored && stored.vat_exempt);
  }

  const normalZero = await api('POST', '/api/invoices', {
    cust_id: custId, type: 'normal', date: todayJalali(),
    pay_type: 'credit', warehouse_id: whId, disc: 0, vat_exempt: 0, rows: [line],
  });
  ok(normalZero.status === 200 && normalZero.data && normalZero.data.id,
    'POST normal vat_exempt=0',
    normalZero.status + ' ' + JSON.stringify(normalZero.data && (normalZero.data.error || normalZero.data)).slice(0, 240));
  if (normalZero.data && normalZero.data.id) {
    const stored = db.prepare('SELECT vat_exempt FROM invoices WHERE id=?').get(normalZero.data.id);
    ok(Number(stored.vat_exempt) === 0, 'POST normal vat_exempt=0 stays 0', stored && stored.vat_exempt);
  }

  if (normalOmit.data && normalOmit.data.id) {
    const invId = normalOmit.data.id;
    const jeBefore = db.prepare(`
      SELECT id FROM journal_entries
      WHERE ref_type='invoice' AND ref_id=? AND COALESCE(deleted_at,0)=0
      ORDER BY id ASC
    `).all(invId);
    const ledBefore = db.prepare(
      "SELECT id, debit FROM customer_ledger WHERE ref_type='invoice' AND ref_id=? AND entry_type='invoice'"
    ).get(invId);
    const revBefore = db.prepare(
      "SELECT COUNT(*) AS c FROM journal_entries WHERE ref_type LIKE '%reversal%' AND ref_id=?"
    ).get(invId).c;

    const amended = await api('PUT', '/api/invoices/' + invId, {
      cust_id: custId, type: 'normal', date: todayJalali(),
      pay_type: 'credit', warehouse_id: whId, disc: 0, vat_exempt: 0,
      rows: [{ product_id: prodId, qty: 3, price: 120000, warehouse_id: whId, name: 'مانتو v205' }],
    });
    ok(amended.status === 200 && amended.data && (amended.data.amended === true || amended.data.id),
      'PUT normal amend 200',
      amended.status + ' ' + JSON.stringify(amended.data && (amended.data.error || amended.data)).slice(0, 280));

    const jeAfter = db.prepare(`
      SELECT id FROM journal_entries
      WHERE ref_type='invoice' AND ref_id=? AND COALESCE(deleted_at,0)=0
      ORDER BY id ASC
    `).all(invId);
    ok(jeBefore.length === 1 && jeAfter.length === 1, 'count of invoice JEs still 1',
      JSON.stringify({ before: jeBefore.length, after: jeAfter.length }));
    ok(jeBefore[0] && jeAfter[0] && jeBefore[0].id === jeAfter[0].id,
      'SAME journal_entries.id for ref_type=invoice',
      JSON.stringify({ before: jeBefore[0] && jeBefore[0].id, after: jeAfter[0] && jeAfter[0].id }));

    const revAfter = db.prepare(
      "SELECT COUNT(*) AS c FROM journal_entries WHERE ref_type LIKE '%reversal%' AND ref_id=?"
    ).get(invId).c;
    ok(revAfter === revBefore, 'no ref_type like %reversal%', { revBefore, revAfter });

    const ledAfter = db.prepare(
      "SELECT id, debit FROM customer_ledger WHERE ref_type='invoice' AND ref_id=? AND entry_type='invoice'"
    ).get(invId);
    ok(ledBefore && ledAfter && ledBefore.id === ledAfter.id,
      'customer_ledger invoice row same id',
      JSON.stringify({ before: ledBefore && ledBefore.id, after: ledAfter && ledAfter.id }));
    const invRow = db.prepare('SELECT final, vat_exempt FROM invoices WHERE id=?').get(invId);
    ok(ledAfter && Number(ledAfter.debit) === Number(invRow.final),
      'customer_ledger debit updated to new final',
      JSON.stringify({ debit: ledAfter && ledAfter.debit, final: invRow && invRow.final }));
    ok(Number(invRow.vat_exempt) === 0, 'PUT normal vat_exempt=0 applied', invRow && invRow.vat_exempt);

    const sides = db.prepare(`
      SELECT COALESCE(SUM(debit_rial),0) AS d, COALESCE(SUM(credit_rial),0) AS c
      FROM journal_lines WHERE entry_id=?
    `).get(jeAfter[0].id);
    ok(Math.abs(Number(sides.d) - Number(sides.c)) < 1, 'journal still balanced after amend', sides);
  }

  const proforma = await api('POST', '/api/invoices', {
    cust_id: custId, type: 'proforma', date: todayJalali(),
    pay_type: 'credit', warehouse_id: whId, disc: 0, rows: [line],
  });
  ok(proforma.status === 200 && proforma.data && proforma.data.id, 'POST proforma',
    proforma.status + ' ' + JSON.stringify(proforma.data && (proforma.data.error || proforma.data)).slice(0, 200));
  if (proforma.data && proforma.data.id) {
    const putPf = await api('PUT', '/api/invoices/' + proforma.data.id, {
      cust_id: custId, type: 'proforma', date: todayJalali(),
      pay_type: 'credit', warehouse_id: whId, disc: 0, note: 'اصلاح پیش‌فاکتور',
      rows: [{ product_id: prodId, qty: 4, price: 100000, warehouse_id: whId }],
    });
    ok(putPf.status === 200, 'PUT proforma works', putPf.status + ' ' + JSON.stringify(putPf.data && putPf.data.error));
    const jePf = db.prepare(
      "SELECT COUNT(*) AS c FROM journal_entries WHERE ref_type='invoice' AND ref_id=?"
    ).get(proforma.data.id).c;
    ok(jePf === 0, 'PUT proforma still no sale JE', jePf);
  }

  if (finalOmit.data && finalOmit.data.id) {
    const putFinal = await api('PUT', '/api/invoices/' + finalOmit.data.id, {
      cust_id: custId, type: 'final', date: todayJalali(),
      pay_type: 'credit', warehouse_id: whId, disc: 0, rows: [line],
    });
    ok(putFinal.status === 409, 'PUT final → 409', putFinal.status + ' ' + JSON.stringify(putFinal.data));
  }

  server.close();
  try { closeSessionStore(); } catch (_) {}
  console.log(`\n${fail ? '💥' : '🎉'} ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('TEST HARNESS ERROR:', e);
  process.exitCode = 1;
});
