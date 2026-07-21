/**
 * Portal karmandan schema + sync tail + ensurePersonUser — run: node server/scripts/test-portal.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-'));
const dbFile = path.join(dir, 't.db');
try { fs.unlinkSync(dbFile); } catch (_) {}
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test';

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

console.log('\n— sync append order —');
const names = require('../sync/tables').SYNCABLE_TABLES.map(t => t.name);
const prIdx = names.indexOf('pricing_rules');
ok(prIdx >= 0, 'pricing_rules in SYNCABLE_TABLES');
const u11 = ['currencies', 'exchange_rates', 'person_positions', 'pricing_rules'];
ok(u11.every((n, i) => names[prIdx - 3 + i] === n), 'update11 block before portal intact');
const ouIdx = names.indexOf('op_units');
ok(ouIdx === prIdx + 1, 'op_units immediately after pricing_rules');
ok(names.slice(ouIdx).join(',') === SYNC_TAIL.join(','), 'sync tail portal+gap');
ok(names[names.length - 1] === 'op_dept_delegations', 'sync ends with op_dept_delegations');

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

console.log('\n— seed + unit/departments —');
const wh1 = db.prepare("INSERT INTO warehouses (name,code) VALUES ('انبار پورتال ۱','WH-P1')").run().lastInsertRowid;
const wh2 = db.prepare("INSERT INTO warehouses (name,code) VALUES ('انبار پورتال ۲','WH-P2')").run().lastInsertRowid;
const mgr = db.prepare("INSERT INTO persons (name,phone) VALUES ('مدیر واحد','09120001111')").run().lastInsertRowid;
const dm1 = db.prepare("INSERT INTO persons (name,phone) VALUES ('مدیر بخش ۱','09120002222')").run().lastInsertRowid;
const dm2 = db.prepare("INSERT INTO persons (name,phone) VALUES ('مدیر بخش ۲','09120003333')").run().lastInsertRowid;
const prodId = db.prepare(`
  INSERT INTO products (user_id,code,name,price,cost,stock,warehouse_id)
  VALUES (1,'P-PORT','کالای پورتال',10000,5000,50,?)
`).run(wh1).lastInsertRowid;
db.prepare('INSERT OR REPLACE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,50)')
  .run(prodId, wh1);
ok(db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(prodId, wh1).qty === 50,
  'warehouse_stock seeded');

const unitId = db.prepare(`
  INSERT INTO op_units (name, manager_person_id, output_type, created_by)
  VALUES ('واحد تست', ?, 'product', 1)
`).run(mgr).lastInsertRowid;
db.prepare('INSERT INTO op_unit_warehouses (unit_id,warehouse_id) VALUES (?,?)').run(unitId, wh1);
db.prepare('INSERT INTO op_unit_warehouses (unit_id,warehouse_id) VALUES (?,?)').run(unitId, wh2);

const { ensurePersonUser } = require('../lib/portal-users');
const u1 = ensurePersonUser(db, dm1, 'department_manager');
const u2 = ensurePersonUser(db, dm2, 'department_manager');
ok(u1.created && u2.created, 'ensurePersonUser created dept managers');
const userRow = db.prepare('SELECT must_change_password FROM users WHERE id=?').get(u1.userId);
ok(userRow && userRow.must_change_password === 1, 'ensurePersonUser must_change_password=1');

db.prepare(`
  INSERT INTO op_departments (unit_id,name,manager_person_id,warehouse_id,sequence_order)
  VALUES (?,?,?,?,1)
`).run(unitId, 'بخش اول', dm1, wh1);
db.prepare(`
  INSERT INTO op_departments (unit_id,name,manager_person_id,warehouse_id,sequence_order)
  VALUES (?,?,?,?,2)
`).run(unitId, 'بخش دوم', dm2, wh2);
const depts = db.prepare('SELECT id,sequence_order FROM op_departments WHERE unit_id=? ORDER BY sequence_order')
  .all(unitId);
ok(depts.length === 2 && depts[0].sequence_order === 1 && depts[1].sequence_order === 2,
  'unit has 2 ordered departments');

try { db.close(); } catch (_) {}
try { fs.unlinkSync(dbFile); } catch (_) {}
try { fs.unlinkSync(dbFile + '-wal'); } catch (_) {}
try { fs.unlinkSync(dbFile + '-shm'); } catch (_) {}
try { fs.rmdirSync(dir); } catch (_) {}

console.log('\n' + (fail ? `FAILED ${fail}` : 'ALL CHECKS PASSED') + ` (${pass} pass, ${fail} fail)`);
process.exit(fail ? 1 : 0);
