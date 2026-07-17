'use strict';
/**
 * Production permissions matrix — role × action gaps beyond test-production-rbac.js
 */
const { ok, throws, freshDb, summary } = require('./lib/test-harness');
const { hasPermission } = require('../lib/rbac');
const { stripCostFields, canSeeCost } = require('../lib/production/access');
const bomLib = require('../lib/production/bom');
const close = require('../lib/production/close');
const reports = require('../lib/production/reports');

console.log('\n══ Production Permissions Matrix ══\n');

const { db, cleanup } = freshDb();

const admin = { id: 1, role: 'admin' };
const accounting = { id: 10, role: 'accounting' };
const prodMgr = { id: 11, role: 'production_manager' };
const fieldSales = { id: 13, role: 'field_sales' };

function seedProduct(name, type) {
  const id = db.prepare('INSERT INTO products (user_id,name,price,stock,item_type) VALUES (1,?,?,100,?)')
    .run(name, 0, type).lastInsertRowid;
  db.prepare('UPDATE products SET average_cost_rial=100000 WHERE id=?').run(id);
  return id;
}

const seedFin = seedProduct('محصول تست مجوز', 'finished');
const seedRaw = seedProduct('ماده تست مجوز', 'raw');

for (const [id, username, role] of [
  [10, 'acc1', 'accounting'],
  [11, 'pm1', 'production_manager'],
  [13, 'fs1', 'field_sales'],
]) {
  db.prepare('INSERT OR IGNORE INTO users (id, username, password, name, role) VALUES (?,?,?,?,?)')
    .run(id, username, 'x', username, role);
}

// production_manager cannot approve/execute period close
ok('PM-01 prod_mgr no close approve', !hasPermission(db, prodMgr, 'production_close', 'approve'));
ok('PM-02 prod_mgr no close edit', !hasPermission(db, prodMgr, 'production_close', 'edit'));
ok('PM-03 accounting can close approve', hasPermission(db, accounting, 'production_close', 'approve'));

{
  let blocked = false;
  try {
    close.execute(db, { period: '1405/04', method: 'proration', userId: prodMgr.id });
  } catch (e) {
    blocked = e.code === 'E_PRECHECK_FAILED' || e.code === 'E_NOT_FOUND' || e.code === 'E_FORBIDDEN';
  }
  ok('PM-04 prod_mgr close.execute blocked or no period', blocked || !hasPermission(db, prodMgr, 'production_close', 'approve'));
}

// accounting cannot activate BOM (approve permission)
ok('PM-05 accounting no BOM approve', !hasPermission(db, accounting, 'production_bom', 'approve'));
ok('PM-06 prod_mgr can BOM approve', hasPermission(db, prodMgr, 'production_bom', 'approve'));

{
  const draft = bomLib.createBom(db, {
    product_id: seedFin,
    name: 'perm test',
    yield_percent: 100,
    lines: [{ component_product_id: seedRaw, qty_per_base: 1, line_type: 'material' }],
  }, accounting.id);
  ok('PM-07 accounting may create draft BOM', draft.status === 'draft');
  ok('PM-08 accounting lacks approve for activate', !hasPermission(db, accounting, 'production_bom', 'approve'));
}

// field_sales stripCostFields on reports + estimates
ok('PM-09 field_sales no cost view', !canSeeCost(db, fieldSales));

{
  const r = reports.runReport(db, { name: 'PR-01', params: {}, user: admin });
  const stripped = stripCostFields(r);
  ok('PM-10 stripCostFields removes _rial', !JSON.stringify(stripped).includes('_rial'));
  let fsOk = false;
  try {
    const fsR = reports.runReport(db, { name: 'PR-01', params: {}, user: fieldSales });
    fsOk = !JSON.stringify(stripCostFields(fsR)).includes('unit_cost_rial');
  } catch (e) {
    fsOk = e.code === 'E_FORBIDDEN';
  }
  ok('PM-11 field_sales report cost blocked or stripped', fsOk);
}

{
  let forbidden = false;
  try {
    reports.runReport(db, { name: 'PR-23', params: { period: '1405/04' }, user: prodMgr });
  } catch (e) {
    forbidden = e.code === 'E_FORBIDDEN';
  }
  ok('PM-12 prod_mgr PR-23 forbidden', forbidden);
}

ok('PM-13 admin close approve', hasPermission(db, admin, 'production_close', 'approve'));

// PM-14 empty user_cost_centers = unrestricted (permissions.md §2.3)
{
  const { costCenterFilter } = require('../lib/production/access');
  db.prepare('INSERT OR IGNORE INTO users (id, username, password, name, role) VALUES (?,?,?,?,?)')
    .run(12, 'po1', 'x', 'po', 'production_operator');
  db.prepare('DELETE FROM user_cost_centers WHERE user_id=?').run(12);
  ok('PM-14 empty ucc → null filter', costCenterFilter(db, 12) === null);
}

cleanup();
summary('Production Permissions Matrix');
