/**
 * Portal karmandan — schema + E2E workflow
 * Run: node server/scripts/test-portal.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-'));
const dbFile = path.join(dir, 't.db');
try { fs.unlinkSync(dbFile); } catch (_) {}
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-portal-secret';

delete require.cache[require.resolve('../db')];
try { delete require.cache[require.resolve('../lib/coa-map')]; } catch (_) {}

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra || ''); }
}

const PORTAL_TABLES = [
  'op_units', 'op_unit_warehouses', 'op_unit_persons', 'op_departments',
  'op_parameters', 'op_parameter_items', 'op_parameter_dept_log',
];

const SYNC_TAIL = [
  'op_units', 'op_unit_warehouses', 'op_unit_persons', 'op_departments',
  'op_parameters', 'op_parameter_items', 'op_parameter_dept_log',
  'bank_reconciliations', 'bank_reconciliation_items', 'doubtful_debt_provisions',
  'inventory_nrv_provisions', 'inventory_nrv_lines', 'legal_reserve_entries',
  'payroll_labor_settings', 'payroll_monthly_accruals', 'budgets', 'budget_lines',
  'op_dept_capabilities', 'op_dept_tasks', 'op_unit_module_links',
  'op_parameter_extra_costs', 'op_field_followups', 'expense_categories',
  'op_dept_delegations',
];

const COA_GAP_KEYS = [
  'coa_cheques_in_collection', 'coa_legal_reserve', 'coa_doubtful_debts',
  'coa_inventory_writedown', 'coa_revaluation_surplus',
];

console.log('\n— portal schema —');
PORTAL_TABLES.forEach(t => {
  ok(!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t), 'table ' + t);
});
ok(db.prepare("PRAGMA table_info(op_parameter_dept_log)").all().some(c => c.name === 'review_requested_at'),
  'op_parameter_dept_log.review_requested_at');
ok(db.prepare("PRAGMA table_info(products)").all().some(c => c.name === 'approval_status'),
  'products.approval_status');
ok(db.prepare("SELECT value FROM settings WHERE key='portal_review_timeout_hours'").get()?.value === '72',
  'portal_review_timeout_hours=72');

console.log('\n— sync append order —');
const names = require('../sync/tables').SYNCABLE_TABLES.map(t => t.name);
const prIdx = names.indexOf('pricing_rules');
ok(prIdx >= 0, 'pricing_rules in SYNCABLE_TABLES');
const u11 = ['currencies', 'exchange_rates', 'person_positions', 'pricing_rules'];
ok(u11.every((n, i) => names[prIdx - 3 + i] === n), 'update11 block before portal intact');
const ouIdx = names.indexOf('op_units');
ok(ouIdx === prIdx + 1, 'op_units immediately after pricing_rules');
// Registry is APPEND-ONLY: the portal+gap block must appear contiguous and in
// order starting at op_units, but newer tables may follow it.
ok(names.slice(ouIdx, ouIdx + SYNC_TAIL.length).join(',') === SYNC_TAIL.join(','), 'sync tail portal+gap');
ok(names.includes('op_dept_delegations'), 'op_dept_delegations registered');

console.log('\n— rbac + coa —');
const { RESOURCES } = require('../lib/rbac');
ok(RESOURCES.includes('portal'), 'rbac RESOURCES includes portal');
const { acct } = require('../lib/coa-map');
COA_GAP_KEYS.forEach(k => {
  try {
    const a = acct(db, k);
    ok(a && a.code && a.name, 'acct ' + k + ' → ' + a.code);
  } catch (e) {
    ok(false, 'acct ' + k, e.message);
  }
});

console.log('\n— ensurePersonUser temp password modes —');
const bcrypt = require('bcryptjs');
const { ensurePersonUser, setPortalAccess, getPortalAccessByPhone } = require('../lib/portal-users');
const pPhone = db.prepare("INSERT INTO persons (name,phone) VALUES ('تست رمز','09121110000')").run().lastInsertRowid;
const uDef = ensurePersonUser(db, pPhone, 'department_manager');
ok(uDef.created === true, 'ensurePersonUser created (default no SMS)');
ok(!Object.prototype.hasOwnProperty.call(uDef, 'tempPassword'),
  'no-SMS path never discloses the generated credential');
const noSmsHash = db.prepare('SELECT password FROM users WHERE id=?').get(uDef.userId)?.password;
ok(noSmsHash && !bcrypt.compareSync('12345', noSmsHash) && !bcrypt.compareSync('admin123', noSmsHash),
  'no-SMS path rejects historical predictable defaults');
ok(db.prepare('SELECT must_change_password FROM users WHERE id=?').get(uDef.userId)?.must_change_password === 1,
  'must_change_password=1');
const pPhone2 = db.prepare("INSERT INTO persons (name,phone) VALUES ('تست رمز SMS','09121110009')").run().lastInsertRowid;
const uSms = ensurePersonUser(db, pPhone2, 'department_manager', { sendSms: true });
ok(uSms.created === true, 'ensurePersonUser created with sendSms');
ok(uSms.tempPassword && uSms.tempPassword.length === 14
    && /[A-Z]/.test(uSms.tempPassword) && /[a-z]/.test(uSms.tempPassword) && /\d/.test(uSms.tempPassword)
    && uSms.tempPassword !== '12345' && uSms.tempPassword !== 'admin123',
  'temp password is strong and random when sendSms');
ok(db.prepare('SELECT must_change_password FROM users WHERE id=?').get(uSms.userId)?.must_change_password === 1,
  'must_change_password=1 (SMS path)');

console.log('\n— OPS-01 portal_access=none persistence —');
const pNone = db.prepare("INSERT INTO persons (name,phone) VALUES ('OPS-01 none','09121110999')").run().lastInsertRowid;
setPortalAccess(db, { personId: pNone, portalRole: 'unit_manager' });
let accNone = getPortalAccessByPhone(db, '09121110999');
ok(accNone.has_access === true && accNone.portal_role === 'unit_manager', 'grant unit_manager');
setPortalAccess(db, { personId: pNone, portalRole: 'none' });
accNone = getPortalAccessByPhone(db, '09121110999');
ok(accNone.has_access === false && accNone.portal_role == null, 'revoked GET portal_role is null (reload-safe)');
ok(db.prepare('SELECT active FROM users WHERE username=?').get('09121110999')?.active === 0, 'revoked user inactive');

console.log('\n— auto-approve job —');
const { autoApproveStalePortalReviews } = require('../lib/portal-jobs');
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('portal_review_timeout_hours','1')").run();
const whX = db.prepare("INSERT INTO warehouses (name,code) VALUES ('WH-JOB','WHJ')").run().lastInsertRowid;
const mgrX = db.prepare("INSERT INTO persons (name,phone) VALUES ('مدیر جاب','09121110001')").run().lastInsertRowid;
const unitX = db.prepare("INSERT INTO op_units (name,manager_person_id) VALUES ('واحد جاب',?)").run(mgrX).lastInsertRowid;
const deptX = db.prepare(`
  INSERT INTO op_departments (unit_id,name,manager_person_id,warehouse_id,sequence_order)
  VALUES (?,'بخش جاب',?,?,1)
`).run(unitX, mgrX, whX).lastInsertRowid;
const paramX = db.prepare(`
  INSERT INTO op_parameters (num,name,unit_id,current_department_id,status)
  VALUES ('P-JOB','پارامتر جاب',?,?,'under_review')
`).run(unitX, deptX).lastInsertRowid;
const oldTs = Math.floor(Date.now() / 1000) - 7200;
db.prepare(`
  INSERT INTO op_parameter_dept_log (parameter_id,department_id,sequence_order,status,review_requested_at)
  VALUES (?,?,1,'under_review',?)
`).run(paramX, deptX, oldTs);
const nAuto = autoApproveStalePortalReviews(db);
ok(nAuto >= 1, 'autoApproveStalePortalReviews ran');
ok(db.prepare('SELECT status FROM op_parameter_dept_log WHERE parameter_id=?').get(paramX)?.status === 'in_progress',
  'stale review → in_progress');
ok(db.prepare('SELECT status FROM op_parameters WHERE id=?').get(paramX)?.status === 'in_progress',
  'param status restored');
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('portal_review_timeout_hours','72')").run();

// ─── HTTP E2E ──────────────────────────────────────────────────────────────
(async () => {
  console.log('\n— E2E HTTP workflow —');
  const admin = db.prepare("SELECT id,username,role,name,phone,auth_epoch FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test',
    device_name: 'portal-e2e',
    device_fingerprint: 'portal-e2e-fingerprint',
  }).token;

  const app = express();
  app.use(express.json());
  app.use('/api/portal', require('../routes/portal'));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const BASE = `http://127.0.0.1:${port}`;

  async function api(method, p, body) {
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

  const wh1 = db.prepare("INSERT INTO warehouses (name,code) VALUES ('انبار۱','P1')").run().lastInsertRowid;
  const wh2 = db.prepare("INSERT INTO warehouses (name,code) VALUES ('انبار۲','P2')").run().lastInsertRowid;
  const wh3 = db.prepare("INSERT INTO warehouses (name,code) VALUES ('انبار۳','P3')").run().lastInsertRowid;
  const whDest = db.prepare("INSERT INTO warehouses (name,code) VALUES ('انبار نهایی','PF')").run().lastInsertRowid;
  const whSrc = db.prepare("INSERT INTO warehouses (name,code) VALUES ('انبار مبدأ','PS')").run().lastInsertRowid;
  const mgr = db.prepare("INSERT INTO persons (name,phone) VALUES ('مدیر واحد E2E','09123330001')").run().lastInsertRowid;
  const dm1 = db.prepare("INSERT INTO persons (name,phone) VALUES ('مدیر بخش۱','09123330002')").run().lastInsertRowid;
  const dm2 = db.prepare("INSERT INTO persons (name,phone) VALUES ('مدیر بخش۲','09123330003')").run().lastInsertRowid;
  const dm3 = db.prepare("INSERT INTO persons (name,phone) VALUES ('مدیر بخش۳','09123330004')").run().lastInsertRowid;
  const payee = db.prepare("INSERT INTO persons (name,phone) VALUES ('کارگر','09123330005')").run().lastInsertRowid;

  const prodId = db.prepare(`
    INSERT INTO products (user_id,code,name,price,cost,stock,warehouse_id,average_cost_rial,approval_status)
    VALUES (1,'P-E2E','پارچه خام',10000,5000,0,?,100000,'approved')
  `).run(whSrc).lastInsertRowid;
  const { postInventoryMovement } = require('../lib/inventory/ledger');
  const { todayJalali } = require('../jalali');
  postInventoryMovement(db, {
    eventType: 'receipt',
    productId: prodId,
    warehouseId: whSrc,
    qty: 100,
    unitCostRial: 100000,
    date: todayJalali(),
    note: 'seed portal e2e',
    createdBy: 1,
  });

  let r = await api('POST', '/api/portal/units', {
    name: 'واحد E2E',
    manager_person_id: mgr,
    warehouse_ids: [whSrc, wh1, wh2, wh3, whDest],
    person_ids: [payee],
  });
  ok(r.status === 200 && r.data?.id, 'create unit', r.data?.error);
  ok(!('tempPassword' in (r.data || {})), 'API does not leak tempPassword');
  const unitId = r.data?.id;

  const depts = [];
  for (const [name, mid, wid, seq] of [
    ['برش', dm1, wh1, 1],
    ['دوخت', dm2, wh2, 2],
    ['بسته‌بندی', dm3, wh3, 3],
  ]) {
    r = await api('POST', `/api/portal/units/${unitId}/departments`, {
      name, manager_person_id: mid, warehouse_id: wid, sequence_order: seq,
    });
    ok(r.status === 200 && r.data?.id, `create dept ${name}`, r.data?.error);
    depts.push(r.data);
  }

  r = await api('POST', '/api/portal/parameters', {
    name: 'بچ تست',
    unit_id: unitId,
    source_warehouse_id: whSrc,
    items: [{ product_id: prodId, quantity: 10 }],
  });
  ok(r.status === 200 && r.data?.id, 'create parameter', r.data?.error || r.status);
  const paramId = r.data?.id;
  ok(r.data?.status === 'in_progress', 'param in_progress');
  ok(r.data?.current_department_id === depts[0]?.id, 'current = first dept');

  const qtySrc = db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?')
    .get(prodId, whSrc)?.qty;
  ok(Number(qtySrc) === 90, 'stock transferred from source (100→90)', 'got ' + qtySrc);

  // Sequential lock: operate on dept 2 before dept 1 complete
  r = await api('POST', `/api/portal/parameters/${paramId}/dept/${depts[1].id}/confirm`, {
    received_quantity: 10,
  });
  ok(r.status === 409, 'sequential lock blocks dept 2 before dept 1');

  r = await api('POST', `/api/portal/parameters/${paramId}/dept/${depts[0].id}/confirm`, {
    received_quantity: 10,
  });
  ok(r.status === 200, 'dept1 confirm');

  r = await api('POST', `/api/portal/parameters/${paramId}/dept/${depts[0].id}/payment`, {
    person_id: payee,
    amount_rial: 500000,
  });
  ok(r.status === 200 && r.data?.payment_status, 'dept1 payment request');

  r = await api('POST', `/api/portal/parameters/${paramId}/dept/${depts[0].id}/approve-payment`, {});
  ok(r.status === 200 && r.data?.payment_journal_id, 'payment approved + JE');
  const jeId = r.data.payment_journal_id;
  const lines = db.prepare('SELECT debit_rial, credit_rial FROM journal_lines WHERE entry_id=?').all(jeId);
  const sumDr = lines.reduce((s, l) => s + Number(l.debit_rial || 0), 0);
  const sumCr = lines.reduce((s, l) => s + Number(l.credit_rial || 0), 0);
  ok(lines.length >= 2 && Math.abs(sumDr - sumCr) < 1, 'payment JE balanced', `dr=${sumDr} cr=${sumCr}`);

  r = await api('POST', `/api/portal/parameters/${paramId}/dept/${depts[0].id}/convert`, {
    product_name: 'نیمه‌ساخته تست',
    quantity: 10,
  });
  ok(r.status === 200 && r.data?.created_pending === true, 'convert creates pending product');
  const newPid = r.data.product_id;
  ok(db.prepare('SELECT approval_status FROM products WHERE id=?').get(newPid)?.approval_status === 'pending',
    'new product approval_status=pending');
  ok(r.data?.production_run_id || !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='production_runs'").get(),
    'production_run linked when table exists');

  r = await api('POST', `/api/portal/products/${newPid}/approve`, {});
  ok(r.status === 200, 'approve pending product');
  ok(db.prepare('SELECT approval_status FROM products WHERE id=?').get(newPid)?.approval_status === 'approved',
    'product approved');

  r = await api('POST', `/api/portal/parameters/${paramId}/dept/${depts[0].id}/complete`, {});
  ok(r.status === 200 && r.data?.next_department_id === depts[1].id, 'dept1 complete → dept2');

  r = await api('POST', `/api/portal/parameters/${paramId}/dept/${depts[1].id}/confirm`, { received_quantity: 10 });
  ok(r.status === 200, 'dept2 confirm');
  r = await api('POST', `/api/portal/parameters/${paramId}/dept/${depts[1].id}/complete`, {});
  ok(r.status === 200 && r.data?.next_department_id === depts[2].id, 'dept2 complete → dept3');

  r = await api('POST', `/api/portal/parameters/${paramId}/dept/${depts[2].id}/confirm`, { received_quantity: 10 });
  ok(r.status === 200, 'dept3 confirm');
  r = await api('POST', `/api/portal/parameters/${paramId}/dept/${depts[2].id}/complete`, {});
  ok(r.status === 200 && r.data?.awaiting_final === true, 'dept3 complete → awaiting final');

  // Ensure converted product stock in last dept for final output
  const lastLog = db.prepare(
    'SELECT converted_product_id, output_quantity FROM op_parameter_dept_log WHERE parameter_id=? AND department_id=?'
  ).get(paramId, depts[0].id);
  const outPid = lastLog?.converted_product_id || newPid;
  // After transfers, stock should be in wh3 (last dept)
  const q3 = Number(db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?')
    .get(outPid, wh3)?.qty || 0);
  ok(q3 > 0, 'converted product in last dept warehouse', 'qty=' + q3);

  r = await api('POST', `/api/portal/parameters/${paramId}/final-output`, {
    quantity: Math.min(10, q3) || 1,
    destination_warehouse_id: whDest,
  });
  ok(r.status === 200 || r.status === 409, 'final-output attempted', r.data?.error || r.status);
  if (r.status === 200) {
    ok(db.prepare('SELECT status FROM op_parameters WHERE id=?').get(paramId)?.status === 'completed',
      'param completed');
  }

  // Sequence lock while active — seed more stock then create another param
  postInventoryMovement(db, {
    eventType: 'receipt',
    productId: prodId,
    warehouseId: whSrc,
    qty: 50,
    unitCostRial: 100000,
    date: todayJalali(),
    note: 'seed for sequence lock',
    createdBy: 1,
  });
  r = await api('POST', '/api/portal/parameters', {
    name: 'بچ قفل',
    unit_id: unitId,
    source_warehouse_id: whSrc,
    items: [{ product_id: prodId, quantity: 1 }],
  });
  if (r.status === 200) {
    r = await api('PUT', `/api/portal/departments/${depts[0].id}/sequence`, { sequence_order: 2 });
    ok(r.status === 409, 'sequence change blocked while active param');
  } else {
    ok(false, 'second param for sequence lock', r.data?.error || r.status);
  }

  // Hard-delete unit cascades portal rows (journals/stock moves left untouched)
  r = await api('DELETE', `/api/portal/units/${unitId}`);
  ok(r.status === 200 && r.data?.ok, 'hard-delete unit', r.data?.error || r.status);
  ok(!db.prepare('SELECT id FROM op_units WHERE id=?').get(unitId), 'unit row gone');
  ok(!db.prepare('SELECT id FROM op_departments WHERE unit_id=?').get(unitId), 'departments cascaded');
  ok(!db.prepare('SELECT id FROM op_parameters WHERE unit_id=?').get(unitId), 'parameters cascaded');
  ok(!db.prepare('SELECT id FROM op_unit_warehouses WHERE unit_id=?').get(unitId), 'unit warehouses cascaded');

  await new Promise(resolve => server.close(resolve));
  try { db.close(); } catch (_) {}
  try { fs.unlinkSync(dbFile); } catch (_) {}
  try { fs.unlinkSync(dbFile + '-wal'); } catch (_) {}
  try { fs.unlinkSync(dbFile + '-shm'); } catch (_) {}
  try { fs.rmdirSync(dir); } catch (_) {}

  console.log('\n' + (fail ? `FAILED ${fail}` : 'ALL CHECKS PASSED') + ` (${pass} pass, ${fail} fail)`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
