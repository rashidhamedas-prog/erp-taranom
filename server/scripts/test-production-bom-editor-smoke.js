'use strict';
/**
 * PROD-P5-R2 Medium-1 — BOM editor smoke (no browser).
 *
 * Role expectations (DEFAULT_ROLE_PERMISSIONS in lib/rbac.js):
 *   admin               — production_bom edit+create; production_cost view → sees cost tab + mutators
 *   accounting          — production_bom edit; production_cost ALL → cost tab + mutators
 *   production_operator — production_bom view-only; production_cost NONE → no mutators; cost fields stripped
 *   field_sales         — production_bom NONE; production_cost NONE → no BOM UI access / no cost
 *
 * Checks:
 *   1) UI source markers in app.js (ops CRUD, outputs edit/delete/auto-share, RBAC, Help path, cost gate)
 *   2) prodFriendly E_* map keys for advanced BOM errors
 *   3) applyCostPolicy strips *_rial for operator-shaped user (freshDb)
 *   4) routes/production-boms.js wraps auto-share with applyCostPolicy
 */
const fs = require('fs');
const path = require('path');
const { ok, freshDb, summary } = require('./lib/test-harness');
const { applyCostPolicy } = require('../lib/production/access');
const { DEFAULT_ROLE_PERMISSIONS, hasPermission } = require('../lib/rbac');

console.log('\n══ Production BOM Editor Smoke (Medium-1) ══\n');

const ROOT = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const routesJs = fs.readFileSync(path.join(ROOT, 'routes', 'production-boms.js'), 'utf8');

// ── Role matrix documentation (assert defaults) ──
const roles = DEFAULT_ROLE_PERMISSIONS;
ok('role admin: production_bom.edit', !!roles.admin?.production_bom?.edit);
ok('role admin: production_cost.view', !!roles.admin?.production_cost?.view);
ok('role accounting: production_bom.edit', !!roles.accounting?.production_bom?.edit);
ok('role accounting: production_cost.view', !!roles.accounting?.production_cost?.view);
ok('role production_operator: no production_bom.edit', !roles.production_operator?.production_bom?.edit);
ok('role production_operator: no production_cost.view', !roles.production_operator?.production_cost?.view);
ok('role field_sales: no production_bom.view', !roles.field_sales?.production_bom?.view);
ok('role field_sales: no production_cost.view', !roles.field_sales?.production_cost?.view);

// ── UI markers: ops CRUD + template/resequence ──
[
  'prodBomSaveOperation',
  'prodBomDeleteOperation',
  'prodBomFillOpForm',
  'prodBomApplyRoutingInEditor',
  'prodBomResequenceOps',
  "/production/boms/'+id+'/operations",
  "/operations/resequence",
  'از الگوی ترنم',
].forEach(m => ok(`app.js ops marker: ${m}`, appJs.includes(m)));

// ── UI markers: outputs edit/delete + auto-share ──
[
  'prodBomSaveOutput',
  'prodBomDeleteOutput',
  'prodBomFillOutputForm',
  'prodBomAutoShare',
  "/outputs/auto-share",
  'sales_value',
  'physical',
  'تسهیم خودکار (ارزش فروش)',
  'تسهیم خودکار (فیزیکی)',
].forEach(m => ok(`app.js outputs marker: ${m}`, appJs.includes(m)));

// ── RBAC gate on mutators + cost tab ──
ok('app.js gates mutators with canPerm(production_bom,edit)',
  appJs.includes("canPerm('production_bom','edit')"));
ok('app.js cost tab gated by canSeeCost / production_cost view',
  appJs.includes("canPerm('production_cost','view')") && appJs.includes('canSeeCost'));
ok('app.js cost panel marker prodBomCostPanelHtml', appJs.includes('function prodBomCostPanelHtml'));
ok('app.js cost tab label بهای تمام‌شده', appJs.includes('بهای تمام‌شده'));

// ── Help / list path to four tabs ──
ok('app.js Help/list path حسابداری → عملیات تولید → فرمول تولید',
  appJs.includes('حسابداری → عملیات تولید → فرمول تولید'));
ok('app.js four-tab hint اقلام | مسیر',
  appJs.includes('اقلام') && appJs.includes('مسیر') && appJs.includes('خروجی') && appJs.includes('بها'));

// ── E_* map keys (advanced) ──
const eKeys = [
  'E_BAD_SHARE_METHOD', 'E_SHARE_NOT_100', 'E_NO_MAIN_OUTPUT', 'E_SEQ_DUPLICATE',
  'E_ROUTING_EMPTY', 'E_YIELD_DOUBLE_COUNT', 'E_OP_YIELD_RANGE', 'E_CC_NOT_STAGE',
  'E_OUTPUT_DUPLICATE', 'E_NRV_ZERO', 'E_NRV_EXCEEDS_WIP', 'E_FORBIDDEN',
  'E_MAIN_MISMATCH', 'E_SEQ_REQUIRED', 'E_OP_WASTE_RANGE', 'E_STAGE_NOT_IN_ROUTING',
];
for (const k of eKeys) {
  ok(`prodFriendly has ${k}`, new RegExp(`${k}\\s*:`).test(appJs));
}

// ── API: auto-share wrapped with applyCostPolicy ──
ok('routes auto-share uses applyCostPolicy',
  /outputs\/auto-share[\s\S]{0,400}applyCostPolicy/.test(routesJs)
  || /auto-share[\s\S]{0,500}return applyCostPolicy/.test(routesJs));

// ── applyCostPolicy strips *_rial for operator-shaped user ──
const { db, cleanup } = freshDb();
try {
  const fakeOp = { id: 901, role: 'production_operator' };
  ok('hasPermission operator cannot see production_cost',
    !hasPermission(db, fakeOp, 'production_cost', 'view'));
  const sample = {
    method: 'sales_value',
    rows: [{ id: 1, product_id: 2, cost_share_percent: 50, nrv_rial: 12000, labor_rate_rial: 500 }],
    unit_cost_rial: 999,
    breakdown: { net_rial: 100, unit_cost_rial: 50 },
  };
  const filtered = applyCostPolicy(db, fakeOp, sample);
  ok('applyCostPolicy strips unit_cost_rial for operator', filtered.unit_cost_rial === undefined);
  ok('applyCostPolicy strips nested *_rial for operator',
    !filtered.rows?.some(r => 'nrv_rial' in r || 'labor_rate_rial' in r));
  ok('applyCostPolicy strips breakdown block for operator', filtered.breakdown === undefined);
  ok('applyCostPolicy keeps non-cost fields for operator',
    filtered.method === 'sales_value' && filtered.rows?.[0]?.cost_share_percent === 50);

  const adminUser = { id: 1, role: 'admin' };
  const kept = applyCostPolicy(db, adminUser, sample);
  ok('applyCostPolicy keeps *_rial for admin', kept.unit_cost_rial === 999 && kept.rows[0].nrv_rial === 12000);
} catch (e) {
  ok('applyCostPolicy freshDb checks', false, e.message);
} finally {
  cleanup();
}

summary('Production BOM Editor Smoke');
