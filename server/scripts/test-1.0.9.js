// Smoke test for v1.0.9 changes: invoice sales-channel auto-assign, catalog RBAC,
// Telegram-like messages threads, AI user scoping, settlement-delete reversal.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const PORT = 3479;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-109-'));
const DB_PATH = path.join(TMP, 'test.db');
const { todayJalali } = require('../jalali');
const TODAY = todayJalali();

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name); }
}

async function j(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-json */ }
  return { status: res.status, data };
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/system/time'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('server did not start');
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH, UPLOADS_DIR: path.join(TMP, 'uploads'), JWT_SECRET: '109-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  try {
    await waitUp();
    let r = await j('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
    ok(r.status === 200 && r.data.token, 'admin login');
    // Security hardening: default password must change before any other API call
    if (r.data.must_change_password) {
      const chg = await j('POST', '/api/auth/change-password', { oldPass: 'admin123', newPass: 'Adm109!test' }, r.data.token);
      if (chg.status !== 200) throw new Error('admin change-password failed: ' + JSON.stringify(chg.data));
      r = await j('POST', '/api/auth/login', { username: 'admin', password: 'Adm109!test' });
    }
    const admin = r.data.token;

    console.log('— §1 invoice sales channel + quick product —');
    // field_sales users must have a sales warehouse (invoice stock deducts from it)
    const whList = await j('GET', '/api/warehouses', null, admin);
    const whId = (whList.data && whList.data[0] && whList.data[0].id) || 1;
    r = await j('POST', '/api/admin/users', {
      name: 'کارشناس میدانی', username: 'field1', password: 'field1234', role: 'field_sales',
      sales_warehouse_id: whId,
    }, admin);
    ok(r.status === 200 && r.data.id, 'field_sales user created');
    const fieldId = r.data.id;

    r = await j('POST', '/api/auth/login', { username: 'field1', password: 'field1234' });
    ok(r.status === 200 && r.data.token, 'field_sales login');
    // Admin-set passwords are temporary — the user must set their own first
    if (r.data.must_change_password) {
      const chg = await j('POST', '/api/auth/change-password', { oldPass: 'field1234', newPass: 'Field1!own' }, r.data.token);
      if (chg.status !== 200) throw new Error('field change-password failed: ' + JSON.stringify(chg.data));
      r = await j('POST', '/api/auth/login', { username: 'field1', password: 'Field1!own' });
    }
    const fieldTok = r.data.token;

    r = await j('POST', '/api/products/quick', { name: 'محصول ممنوع' }, fieldTok);
    ok(r.status === 403, 'sales cannot quick-create product (admin-only)');

    r = await j('POST', '/api/products/quick', { name: 'محصول تست', price: 50000 }, admin);
    ok(r.status === 200 && r.data.id, 'admin quick product works');
    const pid = r.data.id;

    r = await j('POST', '/api/customers', { biz: 'فروشگاه ۱۰۹', owner: 'تست' }, fieldTok);
    ok(r.status === 200 && r.data.id, 'customer by field_sales');
    const custId = r.data.id;

    r = await j('POST', '/api/invoices', {
      cust_id: custId, type: 'proforma', date: TODAY,
      rows: [{ product_id: pid, qty: 1 }],
      sales_channel: 'phone', // must be ignored — field role forces 'field'
    }, fieldTok);
    ok(r.status === 200 && r.data.id, 'invoice created by field_sales');
    const invId = r.data.id;

    const tdb = new Database(DB_PATH);
    const invRow = tdb.prepare('SELECT sales_channel FROM invoices WHERE id=?').get(invId);
    ok(invRow && invRow.sales_channel === 'field', 'sales_channel auto-assigned from role (ignores body)');

    console.log('— §2 catalog access —');
    r = await j('GET', '/api/warehouses', null, fieldTok);
    ok(r.status === 200 && Array.isArray(r.data), 'field_sales can list warehouses');

    r = await j('GET', '/api/products/categories', null, fieldTok);
    ok(r.status === 200 && Array.isArray(r.data), 'categories route not shadowed by /:id');

    r = await j('GET', '/api/products', null, fieldTok);
    ok(r.status === 200 && Array.isArray(r.data), 'field_sales can list products (catalog)');

    console.log('— §3 messages threads —');
    r = await j('GET', '/api/messages/threads', null, fieldTok);
    ok(r.status === 200 && Array.isArray(r.data), 'threads endpoint returns array');

    r = await j('POST', '/api/messages', { to_id: 1, body: 'سلام تست ۱.۰.۹' }, fieldTok);
    ok(r.status === 200 && r.data.id, 'field_sales can message admin');

    r = await j('GET', '/api/messages/thread/' + fieldId, null, admin);
    ok(r.status === 200 && r.data.length >= 1, 'admin thread with field_sales');

    r = await j('POST', '/api/messages/thread/' + fieldId + '/read', null, admin);
    ok(r.status === 200 && r.data.ok, 'mark thread read');

    const msg = tdb.prepare('SELECT is_read FROM messages WHERE from_id=? AND to_id=1 ORDER BY id DESC LIMIT 1').get(fieldId);
    ok(msg && msg.is_read === 1, 'read flag set after thread/read');

    console.log('— §5 settlement delete → rep payment rejected —');
    r = await j('POST', '/api/accounting/settlements', {
      cust_id: custId, amount: 100000, pay_type: 'cash', date: TODAY,
    }, admin);
    ok(r.status === 200 && r.data.id, 'settlement created');
    const settId = r.data.id;

    const subIns = tdb.prepare(`
      INSERT INTO rep_payment_submissions
        (rep_id,cust_id,pay_type,amount,date,status,settlement_id,approved_by,approved_at,receipt_file)
      VALUES (?,?,?,?,?,?,?,?,strftime('%s','now'),?)
    `).run(fieldId, custId, 'cash', 100000, TODAY, 'approved', settId, 1, 'test.jpg');
    const subId = subIns.lastInsertRowid;

    r = await j('DELETE', '/api/accounting/settlements/' + settId, null, admin);
    ok(r.status === 200 && r.data.ok, 'settlement deleted');

    const sub = tdb.prepare('SELECT status,rejection_note FROM rep_payment_submissions WHERE id=?').get(subId);
    ok(sub && sub.status === 'rejected' && sub.rejection_note, 'approved rep payment flipped to rejected');

    console.log('— §6 AI user scoping —');
    r = await j('GET', '/api/ai/my-summary', null, fieldTok);
    ok(r.status === 200 && r.data.stats && typeof r.data.stats.week_sales === 'number', 'my-summary for field_sales');

    r = await j('GET', '/api/ai/my-summary', null, admin);
    ok(r.status === 200 && r.data.stats, 'my-summary for admin (own data only)');

    tdb.close();

    console.log(`\n🎉 ${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    console.error('TEST HARNESS ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    srv.kill();
    setTimeout(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }, 500);
  }
})();
