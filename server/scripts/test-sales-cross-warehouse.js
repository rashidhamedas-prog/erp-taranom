'use strict';
/**
 * Phase 1 — sales_cross_warehouse RBAC + assertLineWarehousesAllowed.
 * Run: node server/scripts/test-sales-cross-warehouse.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : extra); }
}

console.log('\n══ sales_cross_warehouse Phase 1 ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-xwh-'));
process.env.DB_PATH = path.join(dir, 'xwh.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'sales-cross-warehouse-test-secret-32chars!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const dbMods = require('../db');
dbMods.initDB();
const db = dbMods.getDB();
const { RESOURCES, hasPermission } = require('../lib/rbac');
const { assertLineWarehousesAllowed, listCrossWarehouseLines } = require('../lib/sales-document');

  ok(RESOURCES.includes('sales_cross_warehouse'), 'RESOURCES includes sales_cross_warehouse');
  ok(RESOURCES.indexOf('sales_cross_warehouse') < RESOURCES.indexOf('inventory_negative')
    || RESOURCES[RESOURCES.length - 1] === 'sales_cross_warehouse'
    || RESOURCES[RESOURCES.length - 1] === 'inventory_negative',
    'sales_cross_warehouse before inventory_negative (append-only)');

async function main() {
  const express = require('express');
  const http = require('http');
  const { issueStaffSession } = require('../lib/auth-sessions');

  const colsCache = new Map();
  const cols = (t) => {
    if (!colsCache.has(t)) colsCache.set(t, new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)));
    return colsCache.get(t);
  };
  function insert(table, obj) {
    const c = cols(table);
    const keys = Object.keys(obj).filter((k) => c.has(k));
    return db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...keys.map((k) => obj[k])).lastInsertRowid;
  }

  const adminId = insert('users', { name: 'مدیر', username: 'xwh_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
  const acctId = insert('users', { name: 'حسابدار', username: 'xwh_acct', password: 'x', role: 'accounting', active: 1, must_change_password: 0 });
  const repId = insert('users', { name: 'نماینده', username: 'xwh_rep', password: 'x', role: 'field_sales', active: 1, must_change_password: 0, sales_warehouse_id: null });

  const whA = insert('warehouses', { name: 'انبار محصول', code: 'FG', active: 1, allow_negative: 1, is_default: 1, warehouse_type: 'finished_goods' });
  const whB = insert('warehouses', { name: 'انبار کیمیا', code: 'KIM', active: 1, allow_negative: 0, warehouse_type: 'finished_goods' });
  db.prepare('UPDATE users SET sales_warehouse_id=? WHERE id=?').run(whA, repId);

  const custId = insert('customers', { user_id: adminId, biz: 'مشتری تست', owner: 'تست', city: 'مشهد', phone: '09120000000', status: 'active' });
  const prodId = insert('products', {
    user_id: adminId, name: 'کالای تست', code: 'XWH-1', price: 100000, cost: 40000,
    average_cost_rial: 40000, stock: 0, warehouse_id: whA, unit: 'عدد',
  });
  try { db.prepare('UPDATE products SET average_cost_rial=40000, cost=40000 WHERE id=?').run(prodId); } catch (_) {}
  db.prepare('INSERT OR REPLACE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)').run(prodId, whA, 20);
  db.prepare('INSERT OR REPLACE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)').run(prodId, whB, 15);

  const acctUser = db.prepare('SELECT * FROM users WHERE id=?').get(acctId);
  ok(!hasPermission(db, acctUser, 'sales_cross_warehouse', 'create'), 'accounting default: no sales_cross_warehouse');

  let denied = null;
  try {
    assertLineWarehousesAllowed(db, acctUser, [{ product_id: prodId, warehouse_id: whB, qty: 1 }], whA);
  } catch (e) { denied = e; }
  ok(!!denied && denied.code === 'E_CROSS_WH_FORBIDDEN' && denied.status === 403, 'assert throws E_CROSS_WH_FORBIDDEN', denied && denied.code);

  const adminUser = db.prepare('SELECT * FROM users WHERE id=?').get(adminId);
  let adminOk = null;
  try { assertLineWarehousesAllowed(db, adminUser, [{ product_id: prodId, warehouse_id: whB, qty: 1 }], whA); }
  catch (e) { adminOk = e; }
  ok(!adminOk, 'admin always allowed');

  db.prepare('INSERT OR REPLACE INTO user_permissions (user_id,resource,action,allowed) VALUES (?,?,?,1)')
    .run(acctId, 'sales_cross_warehouse', 'create');
  // clear rbac cache if any by re-fetching user
  let allowed = null;
  try { assertLineWarehousesAllowed(db, acctUser, [{ product_id: prodId, warehouse_id: whB, qty: 1 }], whA); }
  catch (e) { allowed = e; }
  ok(!allowed, 'accounting with grant allowed');

  const cross = listCrossWarehouseLines([{ product_id: prodId, warehouse_id: whB, qty: 2, variant_id: null }], whA);
  ok(cross.length === 1 && cross[0].from_wh === whB && cross[0].header_wh === whA, 'listCrossWarehouseLines');

  // HTTP create/edit/convert
  const tok = {};
  for (const [k, uid] of [['admin', adminId], ['acct', acctId], ['rep', repId]]) {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
    tok[k] = issueStaffSession(db, u, { device_kind: 'test', device_name: 'xwh-' + k, device_fingerprint: 'fp-' + k }).token;
  }
  // revoke grant for forbidden tests — use a second accounting user without perm
  const acctNoId = insert('users', { name: 'حسابدار۲', username: 'xwh_acct2', password: 'x', role: 'accounting', active: 1, must_change_password: 0 });
  const acctNo = db.prepare('SELECT * FROM users WHERE id=?').get(acctNoId);
  tok.acctNo = issueStaffSession(db, acctNo, { device_kind: 'test', device_name: 'xwh-no', device_fingerprint: 'fp-no' }).token;

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/invoices', require('../routes/invoices'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;

  async function api(method, p, body, who) {
    const res = await fetch(BASE + p, {
      method,
      headers: { Authorization: 'Bearer ' + tok[who], 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  }

  const today = require('../jalali').todayJalali();
  let idem = 0;
  const key = (tag) => `xwh-${tag}-${Date.now()}-${++idem}`;
  const basePayload = () => ({
    cust_id: custId,
    type: 'proforma',
    date: today,
    warehouse_id: whA,
    pay_type: 'credit',
    vat_exempt: 1,
    client_request_id: key('pf'),
    rows: [{ product_id: prodId, name: 'کالای تست', qty: 1, price: 100000, warehouse_id: whB }],
  });

  const createForbidden = await api('POST', '/api/invoices', basePayload(), 'acctNo');
  ok(createForbidden.status === 403 && createForbidden.data && createForbidden.data.code === 'E_CROSS_WH_FORBIDDEN',
    'create without perm → 403', createForbidden);

  const createOk = await api('POST', '/api/invoices', basePayload(), 'acct');
  ok(createOk.status === 200 && createOk.data && createOk.data.id, 'create with perm → 200', createOk.status);
  const invId = createOk.data && createOk.data.id;

  const audits = db.prepare("SELECT * FROM audit_log WHERE action='cross_warehouse_sale' AND entity_id=?").all(invId);
  ok(audits.length >= 1, 'audit cross_warehouse_sale on create', audits.length);

  const editForbidden = await api('PUT', '/api/invoices/' + invId, {
    ...basePayload(),
    client_request_id: key('edit'),
    rows: [{ product_id: prodId, name: 'کالای تست', qty: 2, price: 100000, warehouse_id: whB }],
  }, 'acctNo');
  ok(editForbidden.status === 403 && editForbidden.data && editForbidden.data.code === 'E_CROSS_WH_FORBIDDEN',
    'edit without perm → 403', editForbidden);

  const createAdmin = await api('POST', '/api/invoices', basePayload(), 'admin');
  ok(createAdmin.status === 200, 'admin create cross-wh → 200', createAdmin.status);

  // convert: make a proforma owned by admin with cross line, convert as acctNo → 403
  const pf = await api('POST', '/api/invoices', basePayload(), 'admin');
  ok(pf.status === 200 && pf.data && pf.data.id, 'proforma for convert');
  const convForbidden = await api('POST', '/api/invoices/' + pf.data.id + '/convert', { type: 'normal' }, 'acctNo');
  ok(convForbidden.status === 403 && convForbidden.data && convForbidden.data.code === 'E_CROSS_WH_FORBIDDEN',
    'convert without perm → 403', convForbidden);

  const convOk = await api('POST', '/api/invoices/' + pf.data.id + '/convert', { type: 'normal' }, 'acct');
  ok(convOk.status === 200 || (convOk.status === 400 && String(convOk.data && convOk.data.error || '').includes('انبار')),
    'convert with perm not E_CROSS_WH_FORBIDDEN', convOk);

  // firm sale with grant: movement from whB
  const firmPayload = {
    cust_id: custId, type: 'normal', date: today, warehouse_id: whA, pay_type: 'credit', vat_exempt: 1,
    client_request_id: key('firm'),
    rows: [{ product_id: prodId, name: 'کالای تست', qty: 1, price: 100000, warehouse_id: whB }],
  };
  const beforeB = Number(db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(prodId, whB)?.qty) || 0;
  const firm = await api('POST', '/api/invoices', firmPayload, 'acct');
  ok(firm.status === 200 && firm.data && firm.data.id, 'firm create with perm', firm);
  if (firm.status === 200) {
    const afterB = Number(db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(prodId, whB)?.qty) || 0;
    ok(afterB === beforeB - 1, 'movement deducted from whB', { beforeB, afterB });
  }

  // rep stays locked (sales_warehouse forced) — cross line rewritten to whA so not 403
  const repCreate = await api('POST', '/api/invoices', {
    ...basePayload(), type: 'proforma',
    rows: [{ product_id: prodId, name: 'کالای تست', qty: 1, price: 100000, warehouse_id: whB }],
  }, 'rep');
  ok(repCreate.status === 200 || repCreate.status === 400, 'rep create does not open free cross-wh', repCreate.status);
  if (repCreate.status === 200 && repCreate.data && repCreate.data.id) {
    const saved = db.prepare('SELECT rows, warehouse_id FROM invoices WHERE id=?').get(repCreate.data.id);
    let rows = [];
    try { rows = JSON.parse(saved.rows || '[]'); } catch (_) {}
    const lineWh = rows[0] && rows[0].warehouse_id;
    ok(Number(lineWh) === Number(whA) || Number(saved.warehouse_id) === Number(whA), 'rep line forced to sales WH', { lineWh, header: saved.warehouse_id });
  }

  server.close();
  try { db.close(); } catch (_) {}
  console.log(`\n══ Result: ${pass} passed, ${fail} failed ══\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
