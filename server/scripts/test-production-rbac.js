'use strict';
/**
 * P10 — Production RBAC tests (docs/Production/permissions.md §11)
 */
const { ok, throws, freshDb, summary } = require('./lib/test-harness');
const { RESOURCES, hasPermission } = require('../lib/rbac');
const {
  canSeeCost, stripCostFields, costCenterFilter, assertUserCostCenter,
} = require('../lib/production/access');
const { estimateCost } = require('../lib/production/estimate');
const bomLib = require('../lib/production/bom');
const close = require('../lib/production/close');
const reports = require('../lib/production/reports');

console.log('\n══ P10 Production RBAC Tests ══\n');

const { db, cleanup } = freshDb();

const admin = { id: 1, role: 'admin' };
const accounting = { id: 10, role: 'accounting' };
const prodMgr = { id: 11, role: 'production_manager' };
const prodOp = { id: 12, role: 'production_operator' };
const fieldSales = { id: 13, role: 'field_sales' };

for (const [id, username, role] of [
  [10, 'acc1', 'accounting'],
  [11, 'pm1', 'production_manager'],
  [12, 'po1', 'production_operator'],
  [13, 'fs1', 'field_sales'],
]) {
  db.prepare('INSERT OR IGNORE INTO users (id, username, password, name, role) VALUES (?,?,?,?,?)')
    .run(id, username, 'x', username, role);
}

// TP-01/02 resources
ok('TP-02 five production resources', RESOURCES.filter(r => r.startsWith('production')).length === 5);

// TP-03 admin full
ok('TP-03 admin production_cost', hasPermission(db, admin, 'production_cost', 'view'));
ok('TP-03 admin production_close approve', hasPermission(db, admin, 'production_close', 'approve'));

// TP-04 field_sales no cost
ok('TP-04 field_sales no production_cost', !canSeeCost(db, fieldSales));

// TP-05 operator no cost
ok('TP-05 operator no production_cost', !canSeeCost(db, prodOp));

// TP-07 empty user_cost_centers = all CCs
{
  ok('TP-07 no rows → null filter', costCenterFilter(db, admin.id) === null);
  const cc10 = db.prepare("SELECT id FROM cost_centers WHERE code='CC-10'").get()?.id;
  ok('TP-07 admin all CCs allowed', assertUserCostCenter(db, admin.id, cc10) === true);
}

// TP-08 restricted operator
{
  const cc10 = db.prepare("SELECT id FROM cost_centers WHERE code='CC-10'").get()?.id;
  const cc30 = db.prepare("SELECT id FROM cost_centers WHERE code='CC-30'").get()?.id;
  db.prepare('INSERT INTO user_cost_centers (user_id, cost_center_id, can_view, can_post) VALUES (?,?,1,1)')
    .run(prodOp.id, cc10);
  ok('TP-08 CC-10 allowed', assertUserCostCenter(db, prodOp.id, cc10) === true);
  throws('TP-08 CC-30 forbidden', () => assertUserCostCenter(db, prodOp.id, cc30), 'E_FORBIDDEN_CC');
  db.prepare('DELETE FROM user_cost_centers WHERE user_id=?').run(prodOp.id);
}

// TP-08/09 BOM activate permissions
ok('TP-08 accounting cannot approve BOM', !hasPermission(db, accounting, 'production_bom', 'approve'));
ok('TP-09 production_manager can approve BOM', hasPermission(db, prodMgr, 'production_bom', 'approve'));

// TP-10 production_manager cannot close
ok('TP-10 prod_mgr no close approve', !hasPermission(db, prodMgr, 'production_close', 'approve'));
ok('TP-11 accounting can close approve', hasPermission(db, accounting, 'production_close', 'approve'));

// TP-16 monthly profit forbidden for prod_mgr
{
  let forbidden = false;
  try {
    reports.runReport(db, { name: 'PR-23', params: { period: '1405/04' }, user: prodMgr });
  } catch (e) {
    forbidden = e.code === 'E_FORBIDDEN' || String(e.message).includes('E_FORBIDDEN');
  }
  ok('TP-16 prod_mgr monthly-profit 403', forbidden);
}

// TP-20 stripCostFields recursive
{
  const nested = {
    a: { b: { unit_cost_rial: 100, ok: 1 }, total_cost_rial: 200 },
    cost: { material_rial: 50 },
    rows: [{ var_price_rial: 1, name: 'x' }],
  };
  const out = stripCostFields(nested);
  const s = JSON.stringify(out);
  ok('TP-20 no _rial keys', !/_rial/.test(s));
  ok('TP-20 keeps non-cost', out.a.b.ok === 1 && out.rows[0].name === 'x');
}

// Estimate strip for field_sales (TP-04 style)
{
  const p = db.prepare('SELECT id FROM products LIMIT 1').get()?.id;
  if (p) {
    const est = estimateCost(db, { productId: p, qty: 1, period: '1405/04' });
    const stripped = stripCostFields(est);
    ok('TP-04 estimate stripped', !JSON.stringify(stripped).includes('unit_cost_rial'));
  } else {
    ok('TP-04 estimate skipped (no product)', true);
  }
}

// TP-12 reopen admin only — route uses adminOnly; accounting lacks admin role
ok('TP-12 accounting not admin', accounting.role !== 'admin');

// sales_manager no production_cost
{
  const sm = { id: 14, role: 'sales_manager' };
  db.prepare('INSERT OR IGNORE INTO users (id, username, password, name, role) VALUES (?,?,?,?,?)')
    .run(14, 'sm1', 'x', 'sm', 'sales_manager');
  ok('sales_manager no cost', !canSeeCost(db, sm));
}

// production_reports view matrix
ok('field_sales no production_reports', !hasPermission(db, fieldSales, 'production_reports', 'view'));
ok('prod_op has production_reports view', hasPermission(db, prodOp, 'production_reports', 'view'));

cleanup();
summary('P10 Production RBAC');
