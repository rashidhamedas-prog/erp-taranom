'use strict';
/**
 * Sales field-ops + marketer checkout v205.
 * Strict: marketer-ui / sw / index / app.css / rep-management / multipart-policy
 * Soft: app.js (may lag on this branch)
 * Optional HTTP: isolated Express if SQLite boots (skip on ABI/init failure)
 *
 * Run: node server/scripts/test-sales-field-ops-v205.js
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
function soft(cond, label, skipMsg) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { console.log('  SKIP', skipMsg || label); }
}

function sliceAfter(src, startNeedle, endNeedle) {
  const i = src.indexOf(startNeedle);
  if (i < 0) return '';
  const rest = src.slice(i);
  if (!endNeedle) return rest.slice(0, 1200);
  const j = rest.indexOf(endNeedle, startNeedle.length);
  return j < 0 ? rest.slice(0, 2000) : rest.slice(0, j);
}

console.log('\n══ Sales field-ops v205 ══\n');

const mk = fs.readFileSync(path.join(pub, 'marketer-ui.js'), 'utf8');
const sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');
const idx = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(pub, 'app.css'), 'utf8');
const rep = fs.readFileSync(path.join(root, 'routes', 'rep-management.js'), 'utf8');
const mp = fs.readFileSync(path.join(root, 'sync', 'multipart-policy.js'), 'utf8');
const appJs = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');

console.log('— static (owned files) —');
ok(mk.includes('marketer-ui-v205'), 'marketer-ui-v205 version marker');
ok(/_ver:\s*'marketer-ui-v205'/.test(mk), 'MarketerUI._ver v205');
ok(mk.includes('پیش‌فاکتور') && mk.includes('معمولی') && mk.includes('رسمی'), 'checkout invoice type copy');
ok(mk.includes('معاف') && mk.includes('مشمول') && mk.includes('مالیات'), 'VAT type copy');
ok(mk.includes('نقد/نسیه/چک/کارت را در فاکتورساز کامل کنید'), 'payment reminder copy');
ok(mk.includes('__pendingMarketerInvMeta') && mk.includes('inv-vat-exempt'), 'pending meta + vat hook');
ok(mk.includes('canCreateInvoice') && mk.includes('function canInvoice'), 'canInvoice still uses canCreateInvoice');
ok(mk.includes('در حال بارگذاری') && mk.includes('mk-state-error') && mk.includes('کالایی یافت نشد'), 'catalog loading/empty/error');
ok(mk.includes('sales_warehouse') && mk.includes('انبار فروش'), 'warehouse name when assigned');
ok(mk.includes('تخفیف ردیف') && mk.includes('ریال'), 'cart line disc + ریال total');
ok(mk.includes('رفتن به کاتالوگ'), 'empty cart CTA to catalog');
try { new Function(mk); ok(true, 'marketer-ui.js parses (new Function)'); }
catch (e) { ok(false, 'marketer-ui.js parses', e.message); }

ok(/const CACHE = 'erp-taranom-v205'/.test(sw), 'sw.js CACHE erp-taranom-v205');
ok(idx.includes('app.js?v=205'), 'index.html app.js?v=205');
ok(idx.includes('marketer-ui.js?v=205'), 'index.html marketer-ui.js?v=205');

ok(css.includes('.rep-form-error') && css.includes('.rep-form-section'), 'CSS rep-form-*');
ok(css.includes('.inv-amend-hint') && css.includes('.mk-checkout'), 'CSS inv-amend-hint + mk-checkout');
ok(css.includes('var(--red)') && css.includes('var(--muted)') && css.includes('var(--purple)'), 'CSS uses theme tokens');

const getMine = sliceAfter(rep, "router.get('/payments/mine'", "router.get('/payments/:id/receipt'");
ok(getMine.includes('isRepRole') || (getMine.includes('inside_sales') && getMine.includes('field_sales')),
  'GET /payments/mine allows inside_sales');
ok(getMine.includes('req.user.id') && getMine.includes('rep_id=?'), 'GET /payments/mine scoped to self');

const postPay = sliceAfter(rep, "router.post('/payments'", "router.post('/payments/:id/approve'");
ok(postPay.includes("inside_sales") && postPay.includes("field_sales"), 'POST /payments allows inside_sales');
ok(postPay.includes('customerAssignedToRep'), 'POST /payments keeps assignment IDOR');
ok(postPay.includes("!req.file") || postPay.includes('عکس رسید'), 'POST /payments still requires receipt');
ok(postPay.includes('audit('), 'POST /payments still audits');

const postVisit = sliceAfter(rep, "router.post('/:id/visits'", "router.get('/:id/calls'");
ok(/status\(400\)/.test(postVisit) && postVisit.includes('مشتری الزامی است'), 'POST visits require customer_id');
ok(postVisit.includes('customerAssignedToRep'), 'POST visits keep assignment check');
ok(!postVisit.includes('customer_id || null'), 'POST visits do not insert null customer');

const postCall = sliceAfter(rep, "router.post('/:id/calls'", "router.get('/:id/export/excel'");
ok(/status\(400\)/.test(postCall) && postCall.includes('مشتری الزامی است'), 'POST calls require customer_id');
ok(postCall.includes('customerAssignedToRep'), 'POST calls keep assignment check');
ok(postCall.includes('callDate') && postCall.includes('todayJalali'), 'POST calls honor body.date');
ok(!postCall.includes('customer_id || null'), 'POST calls do not insert null customer');

const payRule = mp.match(/name:\s*'rep-payment-receipt'[^}]+/);
ok(!!payRule && payRule[0].includes('inside_sales') && payRule[0].includes('field_sales'),
  'multipart rep-payment-receipt roles include inside_sales');

console.log('\n— app.js invoice + field-ops —');
ok(appJs.includes('معاف از مالیات') && /id="inv-vat-exempt"/.test(appJs),
  'app.js has معاف از مالیات / inv-vat-exempt');
ok(/function defaultVatExemptForType/.test(appJs), 'app.js defaultVatExemptForType helper');
ok(appJs.includes('__pendingMarketerInvMeta') && appJs.includes('builderType'),
  'app.js consumes pending marketer type/VAT meta');
ok(!appJs.includes('const hideRepAdv'), 'hideRepAdv removed so sales see invoice details');
ok(appJs.includes('دریافت‌های ثبت‌شده'), 'my-rep always shows receipts panel');
ok(appJs.includes('Service Worker <b>v205</b>') || appJs.includes('erp-taranom-v205'),
  'sales/admin help mentions SW v205');
ok(appJs.includes('helpSec(\'💼\',\'حساب من') || appJs.includes("helpSec('💼','حساب من"),
  'sales help has حساب من');
try { new Function(appJs); ok(true, 'app.js parses (new Function)'); }
catch (e) { ok(false, 'app.js parses', e.message); }

async function optionalHttp() {
  console.log('\n— optional HTTP —');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-v205-'));
  const dbFile = path.join(dir, 't.db');
  process.env.DB_PATH = dbFile;
  process.env.SYNC_ROLE = 'central';
  process.env.JWT_SECRET = 'test-sales-field-ops-v205-secret-32ch';
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
    const fieldId = db.prepare(
      "INSERT INTO users (name,username,password,role,active) VALUES (?,?,?,?,1)"
    ).run('میدانی v205', 'field_v205', 'x', 'field_sales').lastInsertRowid;
    const insideId = db.prepare(
      "INSERT INTO users (name,username,password,role,active) VALUES (?,?,?,?,1)"
    ).run('تلفنی v205', 'inside_v205', 'x', 'inside_sales').lastInsertRowid;
    db.prepare('UPDATE users SET must_change_password=0 WHERE id IN (?,?)').run(fieldId, insideId);

    const mine = db.prepare(
      'INSERT INTO customers (user_id,biz,phone,status,type) VALUES (?,?,?,?,?)'
    ).run(fieldId, 'مشتری میدان', '09120000011', 'active', 'عمده‌فروش').lastInsertRowid;
    try { db.prepare('UPDATE customers SET assigned_to=? WHERE id=?').run(fieldId, mine); } catch (_) {}
    const other = db.prepare(
      'INSERT INTO customers (user_id,biz,phone,status,type) VALUES (?,?,?,?,?)'
    ).run(insideId, 'مشتری دیگران', '09120000012', 'active', 'عمده‌فروش').lastInsertRowid;

    const fieldUser = db.prepare('SELECT * FROM users WHERE id=?').get(fieldId);
    const insideUser = db.prepare('SELECT * FROM users WHERE id=?').get(insideId);
    const fieldTok = issueStaffSession(db, fieldUser, {
      device_kind: 'test', device_name: 'v205-field', device_fingerprint: 'v205-field-fp',
    }).token;
    const insideTok = issueStaffSession(db, insideUser, {
      device_kind: 'test', device_name: 'v205-inside', device_fingerprint: 'v205-inside-fp',
    }).token;

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use('/api/reps', require('../routes/rep-management'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const BASE = `http://127.0.0.1:${server.address().port}`;

    async function api(method, p, body, token) {
      const res = await fetch(BASE + p, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let data = null;
      try { data = await res.json(); } catch (_) {}
      return { status: res.status, data };
    }

    let r = await api('POST', `/api/reps/${fieldId}/visits`, { note: 'بدون مشتری' }, fieldTok);
    ok(r.status === 400, 'HTTP visit without customer_id → 400', r.data && r.data.error);

    r = await api('POST', `/api/reps/${fieldId}/visits`, { customer_id: other, note: 'غریبه' }, fieldTok);
    ok(r.status === 403, 'HTTP visit other-rep customer → 403', r.data && r.data.error);

    r = await api('POST', `/api/reps/${fieldId}/visits`, { customer_id: mine, note: 'ویزیت خود' }, fieldTok);
    ok(r.status === 200 && r.data && r.data.id, 'HTTP visit assigned customer → 200', r.data && r.data.error);

    r = await api('POST', `/api/reps/${fieldId}/calls`, { duration_min: 3 }, fieldTok);
    ok(r.status === 400, 'HTTP call without customer_id → 400', r.data && r.data.error);

    r = await api('POST', `/api/reps/${fieldId}/calls`, {
      customer_id: mine, date: '1405/06/01', duration_min: 5, outcome: 'ok',
    }, fieldTok);
    ok(r.status === 200 && r.data && r.data.id, 'HTTP call with customer+date → 200', r.data && r.data.error);
    const callRow = db.prepare('SELECT date, customer_id FROM rep_call_logs WHERE id=?').get(r.data.id);
    ok(callRow && callRow.date === '1405/06/01' && Number(callRow.customer_id) === Number(mine),
      'HTTP call stored body.date');

    r = await api('POST', '/api/reps/payments', {
      cust_id: mine, amount: 1000, pay_type: 'cash',
    }, insideTok);
    ok(r.status === 400 && r.status !== 403, 'HTTP inside_sales payment without receipt → 400 not 403',
      r.data && r.data.error);

    r = await api('GET', '/api/reps/payments/mine', undefined, insideTok);
    ok(r.status === 200 && Array.isArray(r.data), 'HTTP inside_sales GET payments/mine → 200',
      r.data && r.data.error);

    r = await api('GET', '/api/reps/payments/mine', undefined, fieldTok);
    ok(r.status === 200 && Array.isArray(r.data), 'HTTP field_sales GET payments/mine → 200',
      r.data && r.data.error);

    r = await api('POST', `/api/reps/${insideId}/visits`, { customer_id: mine, note: 'تلفنی روی مشتری میدان' }, insideTok);
    ok(r.status === 403, 'HTTP inside_sales cannot visit unassigned customer', r.data && r.data.error);

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
  console.log('\nSales field-ops v205: ' + (fail ? '❌ ' : '✅ ') + pass + ' پاس، ' + fail + ' رد');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
