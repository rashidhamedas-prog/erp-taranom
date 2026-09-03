'use strict';
/**
 * Invoice documents v194 — fabric live meters after untagged purchase receipt,
 * sales journal header-discount balance, print HTML (no inline style).
 * Run: node server/scripts/test-invoice-docs-v194.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-docs-v194-'));
const testDb = path.join(dir, 't.db');
process.env.DB_PATH = testDb;
process.env.SYNC_ROLE = 'central';
process.env.SMS_DISABLED = '1';
process.env.ERP_TEST_ISOLATION = '1';
process.env.JWT_SECRET = 'invoice-docs-v194-secret-32chars!!!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.NODE_ENV = 'test';

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra == null ? '' : extra); }
}

delete require.cache[require.resolve('../db')];
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

const {
  liveBatchMeters, availableBatchMeters,
} = require('../lib/inventory/fabric-rolls');
const { postPurchaseStockMovements, postSaleStockMovements } = require('../lib/sales-document');
const { salesJournalLines, sumJournalSides } = require('../lib/customer-books');
const { renderInvoicePrintHtml } = require('../lib/invoice-print');
const { sendSecureHtml } = require('../lib/secure-html-response');
const { todayJalali } = require('../jalali');

function tableCols(name) {
  return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
}

console.log('\n— Seed WH / product / fabric purchase identity —');
let rawId = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get()?.id;
if (!rawId) {
  const whCols = tableCols('warehouses');
  const cols = ['name'];
  const vals = ['مواد'];
  if (whCols.has('code')) { cols.push('code'); vals.push('WH-RAW'); }
  if (whCols.has('warehouse_type')) { cols.push('warehouse_type'); vals.push('raw_material'); }
  if (whCols.has('kind')) { cols.push('kind'); vals.push('raw'); }
  if (whCols.has('active')) { cols.push('active'); vals.push(1); }
  rawId = db.prepare(`INSERT INTO warehouses (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals).lastInsertRowid;
}
ok(!!rawId, 'WH-RAW id', rawId);

const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
ok(!!admin, 'admin user');

const pCols = tableCols('products');
const pFields = ['name'];
const pVals = ['کرپ طاقه v194'];
if (pCols.has('code')) { pFields.push('code'); pVals.push('FAB-V194'); }
if (pCols.has('price')) { pFields.push('price'); pVals.push(200000); }
if (pCols.has('cost')) { pFields.push('cost'); pVals.push(100000); }
if (pCols.has('stock')) { pFields.push('stock'); pVals.push(0); }
if (pCols.has('unit')) { pFields.push('unit'); pVals.push('متر'); }
if (pCols.has('user_id')) { pFields.push('user_id'); pVals.push(admin.id); }
const prodId = db.prepare(`INSERT INTO products (${pFields.join(',')}) VALUES (${pFields.map(() => '?').join(',')})`).run(...pVals).lastInsertRowid;
ok(!!prodId, 'fabric product');

const purchaseRows = [{
  product_id: prodId, name: 'کرپ طاقه v194', qty: 100, price: 100000,
  is_fabric_roll: 1, color: 'سرمه‌ای', warehouse_id: rawId, unit_cost_rial: 100000,
}];

let purchaseMv;
db.transaction(() => {
  purchaseMv = postPurchaseStockMovements(db, {
    rows: purchaseRows, warehouseId: rawId, sourceType: 'purchase', sourceId: 19401,
    userId: admin.id, date: todayJalali(), note: 'خرید طاقه v194', supplierId: null,
  });
})();
const batch = db.prepare(
  "SELECT * FROM inventory_batches WHERE source_type='purchase' AND source_id=19401 AND kind='fabric' ORDER BY id DESC LIMIT 1"
).get();
ok(!!batch, 'purchase created fabric batch');
const tagged = db.prepare(
  'SELECT batch_id FROM inventory_ledger WHERE id=?'
).get(purchaseMv.movements[0].id);
ok(Number(tagged && tagged.batch_id) === Number(batch.id), 'receipt ledger stamped with batch_id', tagged && tagged.batch_id);
ok(Math.abs(availableBatchMeters(db, batch.id) - 100) < 1e-6, 'available 100m after tagged purchase');

console.log('\n— Legacy untagged receipt (the 0007 bug) —');
db.prepare('UPDATE inventory_ledger SET batch_id=NULL WHERE id=?').run(purchaseMv.movements[0].id);
const untagged = db.prepare('SELECT batch_id FROM inventory_ledger WHERE id=?').get(purchaseMv.movements[0].id);
ok(!untagged.batch_id, 'receipt untagged for replay');
ok(Math.abs(availableBatchMeters(db, batch.id) - 100) < 1e-6, 'heal restores 100m available');
const retagged = db.prepare('SELECT batch_id FROM inventory_ledger WHERE id=?').get(purchaseMv.movements[0].id);
ok(Number(retagged.batch_id) === Number(batch.id), 'heal stamps batch_id again');

let saleErr = null;
try {
  db.transaction(() => {
    postSaleStockMovements(db, {
      rows: [{
        product_id: prodId, qty: 40, warehouse_id: rawId, batch_id: batch.id,
        is_fabric_roll: 1, name: 'کرپ طاقه v194',
      }],
      warehouseId: rawId, sourceType: 'invoice', sourceId: 19402,
      userId: admin.id, date: todayJalali(), note: 'فروش طاقه 0007',
    });
  })();
} catch (e) { saleErr = e; }
ok(!saleErr, 'sale 40 of 100 succeeds after untagged-receipt heal', saleErr && saleErr.message);
ok(Math.abs(liveBatchMeters(db, batch.id) - 60) < 1e-6, 'live 60 after sale', liveBatchMeters(db, batch.id));

let oversell = null;
try {
  db.transaction(() => {
    postSaleStockMovements(db, {
      rows: [{ product_id: prodId, qty: 80, warehouse_id: rawId, batch_id: batch.id, is_fabric_roll: 1 }],
      warehouseId: rawId, sourceType: 'invoice', sourceId: 19403,
      userId: admin.id, date: todayJalali(), note: 'oversell',
    });
  })();
} catch (e) { oversell = e; }
ok(!!oversell && oversell.code === 'E_FABRIC_QTY', 'oversell rejected E_FABRIC_QTY', oversell && oversell.message);

console.log('\n— Sales journal header discount is balanced —');
try {
  db.prepare("INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES ('1103','دریافتنی','asset',NULL,1,1)").run();
} catch (_) {}
['4101', '4102', '4105', '6103', '2101', '2103'].forEach((code) => {
  try {
    db.prepare('INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES (?,?,?,?,1,1)')
      .run(code, code, code.startsWith('4') || code.startsWith('6') ? 'income' : 'liability', null);
  } catch (_) {}
});
try { db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_receivable','1103')").run(); } catch (_) {}
try { db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_sales','4101')").run(); } catch (_) {}
try { db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_sales_discount','4102')").run(); } catch (_) {}
try { db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_vat_payable','2103')").run(); } catch (_) {}
try { db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_other_income','4105')").run(); } catch (_) {}
try { db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_sales_expense','6103')").run(); } catch (_) {}
try { db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_payable','2101')").run(); } catch (_) {}

let custId;
try {
  custId = db.prepare("INSERT INTO customers (biz, owner, phone, user_id) VALUES ('فروشگاه v194','مالک','09150000001',?)").run(admin.id).lastInsertRowid;
} catch (e) {
  try { custId = db.prepare('INSERT INTO customers (biz, user_id) VALUES (?,?)').run('فروشگاه v194', admin.id).lastInsertRowid; } catch (e2) {
    console.log('  customer seed', e2.message);
  }
}
ok(!!custId, 'customer');

if (custId) {
  const discLines = salesJournalLines(db, custId, {
    subtotal: 1000000, discAmt: 100000, final: 900000, vatAmount: 0, netBeforeVat: 900000,
  }, false, { payType: 'credit', rows: [{ product_id: prodId, sum: 1000000 }] });
  const sides = sumJournalSides(discLines);
  ok(sides.ok, 'header discount journal balanced', JSON.stringify(sides));
  const rev = salesJournalLines(db, custId, {
    subtotal: 1000000, discAmt: 100000, final: 900000, vatAmount: 0, netBeforeVat: 900000,
  }, true, { payType: 'credit', rows: [{ product_id: prodId, sum: 1000000 }] });
  ok(sumJournalSides(rev).ok, 'reversal with discount balanced');

  const vatFreight = salesJournalLines(db, custId, {
    subtotal: 1000000, discAmt: 50000, final: 1045000, vatAmount: 95000, netBeforeVat: 950000,
  }, false, {
    payType: 'credit', freightRial: 20000, freightType: 'buyer',
    rows: [{ product_id: prodId, sum: 1000000 }],
  });
  ok(sumJournalSides(vatFreight).ok, 'discount + buyer freight + VAT balanced', JSON.stringify(sumJournalSides(vatFreight)));
}

console.log('\n— Print HTML has Persian digits and no inline style —');
const printHtml = renderInvoicePrintHtml({
  inv: {
    num: 'T-194', type: 'normal', date: '1405/06/13', cust_biz: 'فروشگاه v194',
    cust_owner: 'مالک', cust_city: 'مشهد', cust_phone: '0915', pay_type: 'credit',
    subtotal: 1000000, disc_amt: 100000, disc: 10, final: 900000, vat_amount: 0,
    freight_amount: 0, note: 'تست چاپ',
  },
  rows: [{ name: 'کرپ', qty: 2, price: 500000, disc_amount: 0, sum: 1000000, code: 'FAB' }],
  settings: { company_name: 'پوشاک ترنم', invoice_template_formal: 'formal-premium' },
  paper: 'A4',
  templateOverride: 'formal-premium',
});
ok(/[۰-۹]/.test(printHtml), 'print uses Persian digits');
ok(!/\sstyle\s*=/i.test(printHtml), 'print has no inline style=');
ok(/<head\b/i.test(printHtml), 'print has head');

const captured = {};
const mockRes = {
  status(n) { captured.status = n; return this; },
  type() { return this; },
  setHeader(k, v) { captured[k] = v; return this; },
  send(html) { captured.html = html; return this; },
};
let secureErr = null;
try { sendSecureHtml(mockRes, printHtml, { allowPrintScript: true }); } catch (e) { secureErr = e; }
ok(!secureErr && captured.status === 200 && captured['X-Taranom-Safe-HTML'] === '1',
  'sendSecureHtml accepts print HTML', secureErr && secureErr.message);

const buyHtml = renderInvoicePrintHtml({
  inv: {
    num: 'PO-194', type: 'purchase', doc_kind: 'purchase', date: '1405/06/13',
    cust_biz: 'تأمین‌کننده تست', pay_type: 'credit', subtotal: 100000, final: 100000,
  },
  rows: [{ name: 'کرپ', qty: 1, price: 100000, sum: 100000 }],
  settings: { company_name: 'پوشاک ترنم' },
  paper: 'A4',
  templateOverride: 'casual-simple',
});
ok(buyHtml.includes('فاکتور خرید'), 'purchase print title');
ok(buyHtml.includes('مشخصات فروشنده'), 'purchase labels supplier as seller');
ok(!/\sstyle\s*=/i.test(buyHtml), 'purchase print no inline style');

(async () => {
  console.log('\n— HTTP purchase → sale → print —');
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  let supplierId;
  try {
    supplierId = db.prepare("INSERT INTO suppliers (name) VALUES ('نساجی v194')").run().lastInsertRowid;
  } catch (e) {
    try { supplierId = db.prepare('INSERT INTO suppliers (name, phone) VALUES (?,?)').run('نساجی v194', '09150000002').lastInsertRowid; }
    catch (e2) { console.log('  supplier seed', e2.message); }
  }
  ok(!!supplierId, 'supplier');

  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'v194', device_fingerprint: 'v194-fp',
  }).token;

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/invoices', require('../routes/invoices'));
  app.use('/api/purchases', require('../routes/purchases'));
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
    return { status: res.status, data, headers: res.headers, ok: res.ok };
  }

  const po = await api('POST', '/api/purchases', {
    supplier_id: supplierId,
    date: todayJalali(),
    pay_type: 'credit',
    warehouse_id: rawId,
    vat_exempt: 1,
    disc: 0,
    rows: [{
      product_id: prodId, qty: 50, price: 80000, is_fabric_roll: 1,
      color: 'کرم', warehouse_id: rawId, unit_cost_rial: 80000,
    }],
  });
  ok(po.status === 200 && po.data && po.data.id, 'POST purchase 200', po.status + ' ' + JSON.stringify(po.data && po.data.error || po.data).slice(0, 240));

  if (po.data && po.data.id) {
    const poBatch = db.prepare(
      'SELECT * FROM inventory_batches WHERE source_type=? AND source_id=? AND kind=? ORDER BY id DESC LIMIT 1'
    ).get('purchase', po.data.id, 'fabric');
    ok(!!poBatch, 'HTTP purchase created roll');
    if (poBatch) {
      const led = db.prepare(
        'SELECT batch_id FROM inventory_ledger WHERE source_type=? AND source_id=? AND qty_in>0'
      ).get('purchase', po.data.id);
      ok(Number(led && led.batch_id) === Number(poBatch.id), 'HTTP purchase receipt tagged');
      ok(Math.abs(availableBatchMeters(db, poBatch.id) - 50) < 1e-6, 'HTTP roll 50m');

      const sale = await api('POST', '/api/invoices', {
        cust_id: custId,
        type: 'normal',
        date: todayJalali(),
        pay_type: 'credit',
        warehouse_id: rawId,
        vat_exempt: 1,
        disc: 10,
        rows: [{
          product_id: prodId, qty: 20, price: 120000, warehouse_id: rawId,
          batch_id: poBatch.id, is_fabric_roll: 1, name: 'کرپ طاقه v194',
        }],
      });
      ok(sale.status === 200 && sale.data && sale.data.id, 'POST sale with roll + header discount',
        sale.status + ' ' + JSON.stringify(sale.data && (sale.data.error || sale.data.message) || sale.data).slice(0, 280));

      if (sale.data && sale.data.id) {
        const pr = await api('GET', '/api/invoices/' + sale.data.id + '/print?paper=A4&template=casual-simple');
        ok(pr.status === 200 && pr.headers.get('X-Taranom-Safe-HTML') === '1', 'GET sale print 200 attested', pr.status);
        ok(typeof pr.data === 'string' && !/\sstyle\s*=/i.test(pr.data), 'sale print HTML has no style=');
        ok(typeof pr.data === 'string' && /[۰-۹]/.test(pr.data), 'sale print Persian digits');

        const byNum = await api('GET', '/api/invoices/' + encodeURIComponent(sale.data.num) + '/print?paper=A4');
        ok(byNum.status === 200, 'GET print by invoice number', byNum.status);
      }

      const missing = await api('GET', '/api/invoices/undefined/print');
      ok(missing.status === 404 && /پیدا نشد/.test(String(missing.data)), 'undefined id → 404 پیدا نشد', missing.status + ' ' + String(missing.data).slice(0, 80));
    }

    const poPrint = await api('GET', '/api/purchases/' + po.data.id + '/print?paper=A4');
    ok(poPrint.status === 200 && poPrint.headers.get('X-Taranom-Safe-HTML') === '1', 'GET purchase print 200', poPrint.status);
    ok(typeof poPrint.data === 'string' && poPrint.data.includes('فاکتور خرید'), 'purchase print body');
  }

  server.close();
  try { closeSessionStore(); } catch (_) {}
  console.log(`\n${fail ? '💥' : '🎉'} ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('TEST HARNESS ERROR:', e);
  process.exitCode = 1;
});
