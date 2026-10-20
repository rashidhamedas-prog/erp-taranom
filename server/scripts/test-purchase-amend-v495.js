'use strict';
/**
 * Purchase in-place amend v495 — PUT /purchases/:id mirrors sales amend.
 * Run: node server/scripts/test-purchase-amend-v495.js
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

console.log('\n══ Purchase amend v495 ══\n');

const root = path.join(__dirname, '..');
const routesSrc = fs.readFileSync(path.join(root, 'routes', 'purchases.js'), 'utf8');
const amendSrc = fs.readFileSync(path.join(root, 'lib', 'amend-purchase.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');

ok(routesSrc.includes("router.put('/:id'"), 'PUT /purchases/:id exists');
ok(routesSrc.includes('amendPostedPurchaseInPlace'), 'route calls amendPostedPurchaseInPlace');
ok(amendSrc.includes('function amendPostedPurchaseInPlace'), 'amend-purchase.js defines amend');
ok(amendSrc.includes('rewriteJournalEntry'), 'amend rewrites JE in place');
ok(amendSrc.includes('E_GRNI_QTY_LOCKED'), 'GRNI qty lock');
ok(amendSrc.includes('E_AMEND_SPLIT_COUNT'), 'later payment split gate');
ok(amendSrc.includes('rewriteInvoiceTimePays') || amendSrc.includes('reverseSupplierPaymentInTx'),
  'invoice-time payment rewrite');
ok(amendSrc.includes("sourceType: 'purchase'"), 'rewrites purchase JE');
ok(!amendSrc.includes("status='reversed'") || amendSrc.includes('supplier_payments'),
  'void soft-status only for payments not PO header');
ok(appSrc.includes('purchaseInvoiceModal(id)'), 'UI modal accepts id');
ok(appSrc.includes("api('PUT','/purchases/'+editId"), 'UI save uses PUT on edit');
ok(appSrc.includes('ویرایش فاکتور خرید'), 'list has edit pencil');
ok(appSrc.includes('اصلاح در محل روی همان شماره') || appSrc.includes('اصلاح در محل'),
  'help mentions in-place amend');
ok(swSrc.includes('erp-taranom-v495'), 'SW bumped to v495');

try {
  // eslint-disable-next-line no-new-func
  new Function(appSrc);
  ok(true, 'app.js parses with new Function');
} catch (e) {
  ok(false, 'app.js parse', e.message);
}

const { amendPostedPurchaseInPlace } = require('../lib/amend-purchase');
ok(typeof amendPostedPurchaseInPlace === 'function', 'export amendPostedPurchaseInPlace');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-amend-v495-'));
const testDb = path.join(dir, 't.db');
process.env.DB_PATH = testDb;
process.env.SYNC_ROLE = 'central';
process.env.SMS_DISABLED = '1';
process.env.ERP_TEST_ISOLATION = '1';
process.env.JWT_SECRET = 'purchase-amend-v495-secret-32chars!!';
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
  if (abi) console.log('  SKIP sqlite purchase-amend-v495:', String(e.message || e).split('\n')[0]);
  else ok(false, 'initDB', e.message);
}

(async () => {
  if (!db) {
    console.log(`\n${fail ? '💥' : '🎉'} ${pass} passed, ${fail} failed (sqlite skipped)`);
    process.exitCode = fail ? 1 : 0;
    return;
  }

  const { todayJalali } = require('../jalali');
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  ok(!!admin, 'admin user');
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);

  let whId = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get()?.id;
  if (!whId) {
    whId = db.prepare("INSERT INTO warehouses (name,active) VALUES ('WH-AMEND-PO',1)").run().lastInsertRowid;
  }

  function tableCols(name) {
    return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
  }

  let supId = db.prepare('SELECT id FROM suppliers ORDER BY id LIMIT 1').get()?.id;
  if (!supId) {
    const sc = tableCols('suppliers');
    const cols = ['name'];
    const vals = ["'تأمین‌کننده amend v495'"];
    if (sc.has('phone')) { cols.push('phone'); vals.push("'09120000000'"); }
    if (sc.has('active')) { cols.push('active'); vals.push('1'); }
    supId = db.prepare(`INSERT INTO suppliers (${cols.join(',')}) VALUES (${vals.join(',')})`).run().lastInsertRowid;
  }
  ok(!!supId, 'supplier id');

  let prodId = db.prepare('SELECT id FROM products ORDER BY id LIMIT 1').get()?.id;
  if (!prodId) {
    const pc = tableCols('products');
    const cols = ['name', 'code', 'cost', 'price', 'stock', 'unit'];
    const vals = ["'کالای amend خرید'", "'PO-AMEND-1'", '10000', '20000', '0', "'عدد'"];
    if (pc.has('user_id')) { cols.push('user_id'); vals.push(String(admin.id)); }
    if (pc.has('active')) { cols.push('active'); vals.push('1'); }
    prodId = db.prepare(`INSERT INTO products (${cols.join(',')}) VALUES (${vals.join(',')})`).run().lastInsertRowid;
  }
  ok(!!prodId, 'product id');

  const express = require('express');
  const http = require('http');
  const authPath = require.resolve('../middleware/auth');
  delete require.cache[authPath];
  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: {
      auth: (req, _res, next) => {
        req.user = { id: admin.id, role: 'admin', username: 'admin', name: admin.name || 'admin' };
        next();
      },
      adminOrAccounting: (_req, _res, next) => next(),
      requirePermission: () => (_req, _res, next) => next(),
      centralOnly: (_req, _res, next) => next(),
    },
  };
  delete require.cache[require.resolve('../routes/purchases')];
  const purchasesRouter = require('../routes/purchases');

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/purchases', purchasesRouter);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  async function api(method, urlPath, body) {
    const res = await fetch('http://127.0.0.1:' + port + urlPath, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* */ }
    return { status: res.status, json, text };
  }

  const create = await api('POST', '/api/purchases', {
    supplier_id: supId,
    date: todayJalali(),
    note: 'create for amend v495',
    disc: 0,
    pay_type: 'credit',
    warehouse_id: whId,
    vat_exempt: 1,
    rows: [{ product_id: prodId, qty: 2, price: 10000 }],
  });
  ok(create.status === 200 && create.json && create.json.id, 'create purchase', create.status + ' ' + (create.json?.error || ''));
  const poId = create.json && create.json.id;
  const poNum = create.json && create.json.num;
  const final1 = create.json && create.json.final;

  if (poId) {
    const amend = await api('PUT', '/api/purchases/' + poId, {
      supplier_id: supId,
      date: todayJalali(),
      note: 'amended v495',
      disc: 0,
      pay_type: 'credit',
      warehouse_id: whId,
      vat_exempt: 1,
      rows: [{ product_id: prodId, qty: 3, price: 12000 }],
    });
    ok(amend.status === 200 && amend.json && amend.json.amended, 'amend returns amended',
      amend.status + ' ' + (amend.json?.error || amend.text || ''));
    ok(amend.json && amend.json.num === poNum, 'same PO number after amend', amend.json && amend.json.num);
    ok(Number(amend.json && amend.json.final) > Number(final1 || 0), 'final increased after qty/price amend');

    const jeLive = db.prepare(`
      SELECT COUNT(*) c FROM journal_entries
      WHERE ref_type='purchase' AND ref_id=? AND COALESCE(deleted_at,0)=0
        AND COALESCE(status,'posted') NOT IN ('reversed','void')
    `).get(poId);
    ok(Number(jeLive.c) === 1, 'exactly one live purchase JE', jeLive.c);

    const led = db.prepare(`
      SELECT credit FROM supplier_ledger
      WHERE ref_type IN ('purchase','purchase_invoice') AND ref_id=? AND entry_type='purchase'
      LIMIT 1
    `).get(poId);
    ok(led && Number(led.credit) === Number(amend.json.final), 'supplier ledger credit matches final',
      led && led.credit);

    const dead = await api('PUT', '/api/purchases/' + poId, {
      supplier_id: supId, date: todayJalali(), pay_type: 'credit', vat_exempt: 1,
      rows: [{ product_id: prodId, qty: 1, price: 1000 }],
    });
    // still live — should work again
    ok(dead.status === 200, 'second amend ok', dead.status + ' ' + (dead.json?.error || ''));
  }

  server.close();
  console.log(`\n${fail ? '💥' : '🎉'} ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
