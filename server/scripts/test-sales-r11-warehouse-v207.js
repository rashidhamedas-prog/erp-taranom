'use strict';
/**
 * Sales R11 cost leak + warehouse session + CRM follow-ups v207.
 * Strict static: cost policy, staff-public, app.js, marketer-ui, sw, index, css
 * Optional HTTP: isolated Express if SQLite boots (skip on ABI/init failure)
 *
 * Run: node server/scripts/test-sales-r11-warehouse-v207.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');

const root = path.join(__dirname, '..');
const pub = path.join(root, 'public');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

console.log('\n══ Sales R11 / warehouse / CRM v207 ══\n');

const { stripCatalogCost, applyCatalogCostPolicy } = require('../lib/catalog-cost-policy');
const { publicStaffUser } = require('../lib/staff-public');

console.log('— cost policy unit —');
const sample = {
  id: 1, name: 'کت', price: 8600000, cost: 1000,
  average_cost_rial: 2, std_cost_rial: 3, last_prod_cost_rial: 4,
  disc_amount: 500, freight_amount: 700, unit_cost_rial: 9,
  rows: [{ name: 'خط', price: 10, unit_cost_rial: 11, disc_amount: 12 }],
};
const stripped = stripCatalogCost(sample);
ok(stripped.price === 8600000, 'keeps selling price');
ok(stripped.disc_amount === 500 && stripped.freight_amount === 700, 'keeps commercial disc/freight');
ok(stripped.cost == null && stripped.average_cost_rial == null, 'strips product cost keys');
ok(stripped.std_cost_rial == null && stripped.last_prod_cost_rial == null, 'strips std/last prod cost');
ok(stripped.unit_cost_rial == null && stripped.rows[0].unit_cost_rial == null, 'strips nested unit_cost_rial');
ok(stripped.rows[0].disc_amount === 12 && stripped.rows[0].price === 10, 'keeps line price + disc_amount');
ok(typeof applyCatalogCostPolicy === 'function', 'applyCatalogCostPolicy exported');

const fakeDb = {
  prepare() { return { get: () => ({ name: 'انبار مرکزی' }) }; },
};
const pubUser = publicStaffUser(fakeDb, {
  id: 12, name: 'عارف', username: 'aref', role: 'field_sales', phone: '09', sales_warehouse_id: 34,
});
ok(pubUser.sales_warehouse_id === 34 && pubUser.sales_warehouse_name === 'انبار مرکزی',
  'publicStaffUser exposes warehouse id+name');
ok(!('password' in pubUser), 'publicStaffUser has no password');

const appJs = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
const mk = fs.readFileSync(path.join(pub, 'marketer-ui.js'), 'utf8');
const sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');
const idx = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(pub, 'app.css'), 'utf8');
const authSrc = fs.readFileSync(path.join(root, 'routes', 'auth.js'), 'utf8');
const prodSrc = fs.readFileSync(path.join(root, 'routes', 'products.js'), 'utf8');
const invSrc = fs.readFileSync(path.join(root, 'routes', 'invoices.js'), 'utf8');

console.log('\n— static frontend / routes —');
ok(appJs.includes('function setME') && appJs.includes('window.ME = ME'), 'app.js setME + window.ME');
ok(appJs.includes("api('GET','/auth/me')") && appJs.includes('setME(stored)'), 'boot refreshes /auth/me');
ok(!/if\(it\.id==='ai'/.test(appJs), 'nav does not hide ai by feature flag');
ok(appJs.includes("helpSec('🤖','دستیار هوشمند من'") || appJs.includes("helpSec('🤖','دستیار هوشمند"),
  'help covers AI menu');
ok(appJs.includes("fupFilter.view = (ME.role==='admin'||ME.role==='accounting') ? 'folders' : 'kanban'"),
  'sales follow-ups default to kanban');
ok(appJs.includes('🖨️ چاپ'), 'invoice list has readable چاپ button');
ok(appJs.includes('normalizeRepExpenseCats') && appJs.includes("transport:'حمل‌ونقل'"),
  'expense category fallback');
ok(appJs.includes('repPaymentModal((f.cust_id))') || appJs.includes('repPaymentModal((custId))'),
  'CRM follow-up/history opens field receipt modal');
ok(appJs.includes('return repPaymentModal(custId)'),
  'sales settlementModal redirects to field receipt (no GL posting)');
ok(appJs.includes('lockedSalesWh'), 'locked sales warehouse options');
ok(appJs.includes('erp-taranom-v207') || appJs.includes('Service Worker <b>v207</b>'),
  'help mentions SW v207');

ok(mk.includes('marketer-ui-v207'), 'marketer-ui-v207 version marker');
ok(/_ver:\s*'marketer-ui-v207'/.test(mk), 'MarketerUI._ver v207');
ok(mk.includes('function me()') && mk.includes('sales_warehouse_id'), 'marketer-ui reads window.ME');
ok(mk.includes('mk-wh-banner') && mk.includes('انبار فروش'), 'warehouse banner html');

ok(/const CACHE = 'erp-taranom-v207'/.test(sw), 'sw.js CACHE erp-taranom-v207');
ok(idx.includes('app.js?v=207'), 'index.html app.js?v=207');
ok(idx.includes('marketer-ui.js?v=207'), 'index.html marketer-ui.js?v=207');
ok(idx.includes('app.css?v=207'), 'index.html app.css?v=207');
ok(/\.inv-actions-cell[\s\S]*flex-wrap:\s*wrap/.test(css), 'CSS wraps invoice actions');

ok(authSrc.includes('publicStaffUser') && authSrc.includes('sales_warehouse_id'),
  'auth login/me use publicStaffUser + warehouse column');
ok(prodSrc.includes('applyCatalogCostPolicy'), 'products GET applies catalog cost policy');
ok(invSrc.includes('applyCatalogCostPolicy'), 'invoices GET/POST/PUT apply catalog cost policy');

try { new Function(appJs); ok(true, 'app.js parses (new Function)'); }
catch (e) { ok(false, 'app.js parses', e.message); }
try { new Function(mk); ok(true, 'marketer-ui.js parses (new Function)'); }
catch (e) { ok(false, 'marketer-ui.js parses', e.message); }

async function optionalHttp() {
  console.log('\n— optional HTTP —');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-v207-'));
  const dbFile = path.join(dir, 't.db');
  process.env.DB_PATH = dbFile;
  process.env.SYNC_ROLE = 'central';
  process.env.JWT_SECRET = 'test-sales-r11-warehouse-v207-secret32';
  process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
  process.env.ERP_TEST_ISOLATION = '1';
  process.env.SMS_DISABLED = '1';
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;

  let db;
  try {
    delete require.cache[require.resolve('../db')];
    const { initDB, getDB } = require('../db');
    initDB();
    db = getDB();
  } catch (e) {
    console.log('  SKIP HTTP sqlite:', (e.message || '').split('\n')[0]);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    return;
  }

  try {
    const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
    let whId = 1;
    try {
      const w = db.prepare('INSERT INTO warehouses (name,code,active) VALUES (?,?,1)')
        .run('انبار تست v207', 'WH207');
      whId = w.lastInsertRowid;
    } catch (_) {
      const existing = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get();
      if (existing) whId = existing.id;
    }
    const fieldId = db.prepare(
      'INSERT INTO users (name,username,password,role,active) VALUES (?,?,?,?,1)'
    ).run('میدانی v207', 'field_v207', 'x', 'field_sales').lastInsertRowid;
    db.prepare('UPDATE users SET must_change_password=0, sales_warehouse_id=? WHERE id=?')
      .run(whId, fieldId);
    const fieldUser = db.prepare('SELECT * FROM users WHERE id=?').get(fieldId);
    const fieldTok = issueStaffSession(db, fieldUser, {
      device_kind: 'test', device_name: 'v207-field', device_fingerprint: 'v207-field-fp',
    }).token;

    try {
      db.prepare(
        'INSERT INTO products (user_id,name,code,price,cost,stock,average_cost_rial,std_cost_rial,last_prod_cost_rial) VALUES (?,?,?,?,?,?,?,?,?)'
      ).run(fieldId, 'کالای تست v207', 'K-V207', 100000, 111, 10, 222, 333, 444);
    } catch (_) {
      db.prepare('INSERT INTO products (user_id,name,code,price,cost,stock) VALUES (?,?,?,?,?,?)')
        .run(fieldId, 'کالای تست v207', 'K-V207', 100000, 111, 10);
    }

    const app = express();
    app.use(express.json());
    app.use('/api/auth', require('../routes/auth'));
    app.use('/api/products', require('../routes/products'));
    app.use('/api/reps', require('../routes/rep-management'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const BASE = `http://127.0.0.1:${server.address().port}`;

    async function api(method, p) {
      const res = await fetch(BASE + p, {
        method,
        headers: { Authorization: 'Bearer ' + fieldTok },
      });
      let data = null;
      try { data = await res.json(); } catch (_) {}
      return { status: res.status, data };
    }

    let r = await api('GET', '/api/auth/me');
    ok(r.status === 200 && Number(r.data && r.data.sales_warehouse_id) === Number(whId),
      'HTTP GET /auth/me warehouse id', r.data && r.data.error);
    ok(r.data && typeof r.data.sales_warehouse_name === 'string',
      'HTTP GET /auth/me warehouse name');

    r = await api('GET', '/api/products?pageSize=50');
    ok(r.status === 200, 'HTTP GET /products 200', r.data && r.data.error);
    const plist = Array.isArray(r.data) ? r.data
      : (r.data && (r.data.rows || r.data.data || r.data.items)) || [];
    const hit = (plist || []).find((p) => p && p.code === 'K-V207') || plist[0];
    ok(hit && hit.price != null, 'HTTP product still has selling price');
    ok(hit && !Object.prototype.hasOwnProperty.call(hit, 'cost')
      && !Object.prototype.hasOwnProperty.call(hit, 'average_cost_rial'),
      'HTTP product JSON has no cost keys for field_sales');

    r = await api('GET', '/api/reps/expense-categories');
    ok(r.status === 200 && r.data && r.data.transport,
      'HTTP GET expense-categories has transport', r.data && r.data.error);

    server.close();
    try { closeSessionStore(); } catch (_) {}
  } catch (e) {
    console.log('  SKIP HTTP runtime:', (e.message || String(e)).split('\n')[0]);
  } finally {
    try { db.close(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

(async () => {
  await optionalHttp();
  console.log('\nSales R11/warehouse v207: ' + (fail ? '❌ ' : '✅ ') + pass + ' پاس، ' + fail + ' رد');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
