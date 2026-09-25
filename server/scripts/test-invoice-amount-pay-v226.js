'use strict';
/**
 * Invoice amount + payment + stock-amend regression (v226).
 * Run: node server/scripts/test-invoice-amount-pay-v226.js
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

console.log('\n══ Invoice amount / pay / stock v226 ══\n');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const payJs = fs.readFileSync(path.join(__dirname, '../lib/invoice-payments.js'), 'utf8');
const printCss = fs.readFileSync(path.join(__dirname, '../public/invoice-print.css'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');

ok(appJs.includes('disc_amt: discAmtSave') || /disc_amt:\s*discAmtSave/.test(appJs), 'saveInvoice sends disc_amt');
ok(appJs.includes('hardenFormAutofill'), 'hardenFormAutofill present');
ok(appJs.includes('renderInvPayChequeCards'), 'multi-pay cheque cards UI');
ok(appJs.includes('cheque_sayadi') && appJs.includes('inv-cheque-sayadi'), 'single cheque sayadi fields');
ok(appJs.includes('allowSaveEdit'), 'firm invoice save gate allowSaveEdit');
ok(appJs.includes('اسناد دریافتنی'), 'cheque destination label اسناد دریافتنی');
ok(payJs.includes('assertReceivedCheque'), 'backend assertReceivedCheque');
ok(printCss.includes('Jet black') || printCss.includes('#000 !important'), 'print jet-black rules');
ok(/erp-taranom-v22[679]/.test(sw), 'SW v226+');

const { calcDocTotals } = require('../lib/vat');
const { applyFreightToDocTotals } = require('../lib/sales-document');
const { resolveInvoicePayments } = require('../lib/invoice-payments');

const built = {
  subtotal: 1_000_000,
  rows: [{ product_id: 1, sum: 1_000_000 }],
};
const fakeDb = {
  prepare() {
    return { get() { return { vat_class: 'standard' }; } };
  },
};
const byPct = calcDocTotals(fakeDb, built, 3.33, { vatExempt: true });
ok(byPct.discAmt === 33300, 'disc from % rounds to 33300', byPct.discAmt);
const byAmt = calcDocTotals(fakeDb, built, 3.33, { vatExempt: true, discAmt: 33333 });
ok(byAmt.discAmt === 33333, 'disc_amt override wins over %', byAmt.discAmt);
ok(byAmt.final === 1_000_000 - 33333, 'final uses exact disc_amt', byAmt.final);

const withFreight = applyFreightToDocTotals(byAmt, 5000, 'buyer');
ok(withFreight.final === byAmt.final + 5000, 'buyer freight added to final');

try {
  resolveInvoicePayments({
    pay_type: 'cheque',
    pay_amount: byAmt.final,
    cheque_bank: 'ملی',
    cheque_branch: 'مرکزی',
    cheque_account: '123',
    cheque_number: '9',
    cheque_sayadi: '1234567890123456',
    cheque_due_date: '1405/08/01',
    cheque_owner: 'تست',
  }, byAmt.final);
  ok(true, 'structured cheque resolves');
} catch (e) {
  ok(false, 'structured cheque resolves', e.message);
}

try {
  resolveInvoicePayments({
    pay_splits: [
      { pay_type: 'cash', amount: 100000, cash_box_id: 1 },
      {
        pay_type: 'cheque', amount: byAmt.final - 100000,
        cheque_bank: 'صادرات', cheque_branch: '۱', cheque_account: '1',
        cheque_number: '2', sayadi: '6543210987654321',
        cheque_due: '1405/09/01', cheque_owner: 'صادر',
      },
    ],
  }, byAmt.final);
  ok(true, 'mixed cash+cheque splits resolve');
} catch (e) {
  ok(false, 'mixed cash+cheque splits resolve', e.message);
}

try {
  resolveInvoicePayments({
    pay_splits: [{ pay_type: 'cheque', amount: 1000 }],
  }, 1000);
  ok(false, 'incomplete cheque must fail');
} catch (e) {
  ok(e.code === 'E_CHEQUE_FIELDS', 'incomplete cheque → E_CHEQUE_FIELDS', e.code);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-v226-'));
const testDb = path.join(dir, 't.db');
process.env.DB_PATH = testDb;
process.env.SYNC_ROLE = 'central';
process.env.SMS_DISABLED = '1';
process.env.ERP_TEST_ISOLATION = '1';
process.env.JWT_SECRET = 'invoice-amount-v226-secret-32chars!';
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
  if (abi) console.log('  SKIP sqlite live:', String(e.message || e).split('\n')[0]);
  else ok(false, 'initDB', e.message);
}

(async () => {
  if (!db) {
    console.log(`\nResult: ${pass} passed, ${fail} failed (sqlite skipped)\n`);
    process.exit(fail ? 1 : 0);
  }

  function tableCols(name) {
    return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
  }

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  ok(!!admin, 'admin user');
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);

  let whId = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get()?.id;
  if (!whId) {
    const whCols = tableCols('warehouses');
    const cols = ['name'];
    const vals = ['انبار تست v226'];
    if (whCols.has('code')) { cols.push('code'); vals.push('WH-V226'); }
    if (whCols.has('active')) { cols.push('active'); vals.push(1); }
    whId = db.prepare(`INSERT INTO warehouses (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals).lastInsertRowid;
  }

  const pCols = tableCols('products');
  const pFields = ['name'];
  const pVals = ['کالای تست مبلغ'];
  if (pCols.has('code')) { pFields.push('code'); pVals.push('P-V226'); }
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

  let custId;
  try {
    custId = db.prepare("INSERT INTO customers (biz, owner, phone, user_id) VALUES ('معصومی تست','معصومی','09150000226',?)").run(admin.id).lastInsertRowid;
  } catch (_) {
    custId = db.prepare('INSERT INTO customers (biz, user_id) VALUES (?,?)').run('معصومی تست', admin.id).lastInsertRowid;
  }

  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'v226', device_fingerprint: 'v226-fp',
  }).token;

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/invoices', require('../routes/invoices'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function api(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { status: res.status, json, text };
  }

  const stockBefore = () => {
    const ws = db.prepare('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND product_id=?').get(whId, prodId);
    const p = db.prepare('SELECT stock FROM products WHERE id=?').get(prodId);
    return { wh: Number(ws?.qty ?? NaN), prod: Number(p?.stock ?? 0) };
  };

  const payload = {
    cust_id: custId,
    type: 'normal',
    date: '1405/07/02',
    disc: 3.33,
    disc_amt: 33333,
    vat_exempt: 1,
    pay_type: 'credit',
    warehouse_id: whId,
    freight_amount: 0,
    rows: [{ product_id: prodId, qty: 10, price: 100000, disc: 0, disc_amount: 0 }],
  };

  const create = await api('POST', '/api/invoices', payload);
  ok(create.status === 200 || create.status === 201, 'create invoice', create.status + ' ' + (create.json?.error || create.text || ''));
  const inv = create.json;
  ok(inv && Math.round(Number(inv.final)) === 966667, 'stored final uses disc_amt 33333', inv && inv.final);
  const afterCreate = stockBefore();

  const amend = await api('PUT', '/api/invoices/' + inv.id, payload);
  ok(amend.status === 200, 'amend same lines', amend.status + ' ' + (amend.json?.error || amend.text || ''));
  const afterAmend = stockBefore();
  ok(
    (Number.isNaN(afterCreate.wh) && Number.isNaN(afterAmend.wh) ? afterAmend.prod === afterCreate.prod
      : afterAmend.wh === afterCreate.wh) && afterAmend.prod === afterCreate.prod,
    're-save same qty does not re-deduct stock',
    JSON.stringify({ afterCreate, afterAmend })
  );

  const list = await api('GET', '/api/invoices');
  const rows = Array.isArray(list.json) ? list.json : (list.json?.rows || list.json?.items || []);
  const listed = rows.find((x) => Number(x.id) === Number(inv.id));
  ok(listed && Math.round(Number(listed.final)) === 966667, 'list final matches form/storage', listed && listed.final);

  try { closeSessionStore(); } catch (_) {}
  server.close();
  console.log(`\nResult: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
