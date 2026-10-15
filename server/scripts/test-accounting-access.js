'use strict';
/**
 * Accounting shell access: master tab gate + one resource per acc-* menu id.
 */
const fs = require('fs');
const path = require('path');
const { ok, freshDb, summary } = require('./lib/test-harness');
const {
  ACC_ITEMS, resourceForNav, matchAccResources, flagsAllowMethod, SALES_MANAGER_ACC_NAVIDS,
} = require('../lib/accounting-access');
const { fillRoleDefaults, hasPermission, applyLegacyGrants } = require('../lib/rbac');

const navText = fs.readFileSync(path.join(__dirname, '../public/acc-nav.js'), 'utf8');
const navIds = [...navText.matchAll(/\{\s*id:\s*'(acc-[^']+)'/g)].map((m) => m[1]);
const uniqueNav = [...new Set(navIds)];

ok('menu has accounting pages', uniqueNav.length > 40);
for (const id of uniqueNav) {
  ok('catalog has ' + id, !!ACC_ITEMS[id]);
  ok('resource name ' + id, resourceForNav(id) === 'acc_' + id.slice(4).replace(/-/g, '_'));
}
for (const id of Object.keys(ACC_ITEMS)) {
  ok('catalog id is on the menu ' + id, uniqueNav.includes(id));
}
ok('help is not a section resource', resourceForNav('help') === null);
ok('exit is not a section resource', resourceForNav('exit-acc-shell') === null);

const field = fillRoleDefaults('field_sales');
const accRole = fillRoleDefaults('accounting');
const manager = fillRoleDefaults('sales_manager');
ok('field sales accounting.view off', field.accounting.view === false);
ok('field sales acc_dash off', field.acc_dash.view === false);
ok('field sales acc_parties off', field.acc_parties.view === false);
ok('accountant accounting.view', accRole.accounting.view === true);
ok('accountant acc_trial_balance', accRole.acc_trial_balance.view === true && accRole.acc_trial_balance.delete === true);
ok('manager sees settlements', manager.acc_settlements.view === true);
ok('manager does not see trial balance', manager.acc_trial_balance.view === false);
ok('manager dashboard on', manager.acc_dash.view === true);
for (const id of SALES_MANAGER_ACC_NAVIDS) {
  ok('manager section ' + id, manager[resourceForNav(id)].view === true);
}

const { matchAccAccess, accessHitAllows } = require('../lib/accounting-access');
ok('settlement path maps to settlements', matchAccResources('/api/accounting/settlements/9').includes('acc_settlements'));
ok('trial balance is not settlements', !matchAccResources('/api/accounting/trial-balance').includes('acc_settlements'));
ok('expense categories beat expenses', matchAccResources('/api/expenses/categories').includes('acc_expense_categories')
  && !matchAccResources('/api/expenses/categories').includes('acc_expenses'));
ok('cash-ops incentive maps to settlements', matchAccResources('/api/accounting/incentive-payments').includes('acc_settlements'));
ok('cash-ops vouchers maps to settlements', matchAccResources('/api/accounting/vouchers').includes('acc_settlements'));
ok('cash-ops outgoing list maps to settlements', matchAccResources('/api/accounting/cash-ops/outgoing').includes('acc_settlements'));
ok('cash-ops COA read maps to settlements', matchAccResources('/api/accounting/chart-of-accounts').includes('acc_settlements'));
ok('purchases payments still maps to purchases', matchAccResources('/api/purchases/payments/list').includes('acc_purchases'));
ok('unknown accounting path stays closed', matchAccResources('/api/accounting/not-a-real-path').length === 0);
ok('settings path is not delegated', matchAccResources('/api/settings').length === 0);
ok('backup path is not delegated', matchAccResources('/api/admin/backup-restore').length === 0);
ok('fiscal rollover path is not delegated', matchAccResources('/api/fiscal-year/rollover').length === 0);

const settView = { view: true, create: true, edit: false, delete: false, approve: false, export: false };
const coaHits = matchAccAccess('/api/accounting/chart-of-accounts');
const settCoaRead = coaHits.find((h) => h.resource === 'acc_settlements' && h.readOnly);
ok('settlements COA hit is readOnly', !!settCoaRead);
ok('settlements view can GET COA', accessHitAllows(settCoaRead, settView, 'GET', '/api/accounting/chart-of-accounts'));
ok('settlements create cannot POST COA via readApi', !accessHitAllows(settCoaRead, settView, 'POST', '/api/accounting/chart-of-accounts'));
ok('settlements create can POST incentive', accessHitAllows(
  matchAccAccess('/api/accounting/incentive-payments').find((h) => h.resource === 'acc_settlements' && !h.readOnly),
  settView, 'POST', '/api/accounting/incentive-payments'
));

ok('view allows GET', flagsAllowMethod({ view: true }, 'GET'));
ok('view blocks POST', !flagsAllowMethod({ view: true }, 'POST'));
ok('create allows POST', flagsAllowMethod({ create: true }, 'POST', '/api/accounting/settlements'));
ok('approve blocks plain POST', !flagsAllowMethod({ approve: true }, 'POST', '/api/accounting/settlements'));
ok('approve allows approve POST', flagsAllowMethod({ approve: true }, 'POST', '/api/accounting/invoices/4/approve'));
ok('delete allows DELETE', flagsAllowMethod({ delete: true }, 'DELETE'));

const { db, cleanup } = freshDb();
try {
  db.prepare('INSERT INTO users (id, username, password, name, role, active) VALUES (?,?,?,?,?,1)')
    .run(77, 'acc-grant-user', 'x', 'grant', 'field_sales');
  const user = { id: 77, role: 'field_sales' };
  ok('grant user cannot open parties yet', hasPermission(db, user, 'acc_parties', 'view') === false);
  ok('grant user cannot create payroll yet', hasPermission(db, user, 'payroll', 'create') === false);
  db.prepare('INSERT INTO user_permissions (user_id, resource, action, allowed) VALUES (?,?,?,1)')
    .run(77, 'acc_parties', 'view');
  db.prepare('INSERT INTO user_permissions (user_id, resource, action, allowed) VALUES (?,?,?,1)')
    .run(77, 'accounting', 'view');
  db.prepare('INSERT INTO user_permissions (user_id, resource, action, allowed) VALUES (?,?,?,1)')
    .run(77, 'acc_payroll_processing', 'create');
  ok('stored parties view opens', hasPermission(db, user, 'acc_parties', 'view') === true);
  ok('parties create stays off', hasPermission(db, user, 'acc_parties', 'create') === false);
  ok('tab gate stored', hasPermission(db, user, 'accounting', 'view') === true);
  ok('payroll section implies payroll create', hasPermission(db, user, 'payroll', 'create') === true);
  const me = applyLegacyGrants(require('../lib/rbac').getUserPermissions(db, 77, 'field_sales'));
  ok('me payload keeps section view', me.acc_parties.view === true);
  ok('me payload expands payroll create', me.payroll.create === true);
  ok('me payload does not invent parties create', me.acc_parties.create === false);
} finally {
  cleanup();
}

summary();
