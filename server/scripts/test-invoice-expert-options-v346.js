const { swAtLeast } = require('./lib/sw-at-least');
/**
 * Invoice «کارشناس» dropdown — distribution_office + /auth/expert-options (v346)
 * Static checks only (no live DB/server).
 * Run: node server/scripts/test-invoice-expert-options-v346.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function ok(cond, msg, extra) {
  if (cond) {
    passed++;
    console.log('  PASS', msg);
  } else {
    failed++;
    console.error('  FAIL', msg, extra != null ? String(extra).slice(0, 200) : '');
  }
}

const root = path.join(__dirname, '..');
const salesExpertsSrc = fs.readFileSync(path.join(root, 'lib', 'sales-experts.js'), 'utf8');
const authSrc = fs.readFileSync(path.join(root, 'routes', 'auth.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8').replace(/^\uFEFF/, '');
const swSrc = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

console.log('=== invoice expert-options v346 ===');

const {
  SALES_EXPERT_ROLES,
  isSalesExpertRole,
  salesExpertRolesSql,
} = require('../lib/sales-experts');

ok(Array.isArray(SALES_EXPERT_ROLES) && SALES_EXPERT_ROLES.includes('distribution_office'),
  'sales-experts exports SALES_EXPERT_ROLES with distribution_office');
ok(salesExpertsSrc.includes("'distribution_office'"), 'sales-experts.js source lists distribution_office');
ok(typeof salesExpertRolesSql === 'function', 'sales-experts exports salesExpertRolesSql');
ok(salesExpertRolesSql().includes("'distribution_office'"), 'salesExpertRolesSql includes distribution_office');
ok(isSalesExpertRole('distribution_office'), 'isSalesExpertRole(distribution_office)');

ok(authSrc.includes("router.get('/expert-options'"), 'auth.js defines GET /expert-options');
const expertRoute = authSrc.match(
  /router\.get\('\/expert-options'[^)]*\)[^{]*\{[\s\S]*?\n\}\);/
);
const expertRouteBlock = expertRoute ? expertRoute[0] : authSrc;
ok(/adminOrAccounting/.test(expertRouteBlock), '/expert-options uses adminOrAccounting');
ok(!/router\.get\('\/expert-options'[^)]*adminOnly/.test(authSrc),
  '/expert-options is not guarded by adminOnly');
ok(authSrc.includes('salesExpertRolesSql'), 'auth /expert-options uses salesExpertRolesSql');
ok(expertRouteBlock.includes('req.query.include_id'), '/expert-options reads req.query.include_id');
ok(
  /includeId\s*>\s*0/.test(expertRouteBlock) && expertRouteBlock.includes('users.unshift'),
  '/expert-options unshifts extra user when include_id missing from role list',
);

const listExpertsFn = appJs.match(
  /function listSalesExpertUsers\(users, includeIds\)\{[\s\S]*?\n\}/
);
const listExpertsBlock = listExpertsFn ? listExpertsFn[0] : '';
ok(listExpertsBlock.includes('keep.has(id)') && listExpertsBlock.includes('byId.set(id, u)'),
  'listSalesExpertUsers uses keep.has(id) + byId');
ok(
  /keep\.has\(id\)[\s\S]*?byId\.set[\s\S]*?active===0/.test(listExpertsBlock),
  'listSalesExpertUsers keep.has(id) before active/role filter',
);

const ensureCacheFn = appJs.match(
  /async function ensureExpertUsersCache\(force, includeId\)\{[\s\S]*?\n\}/
);
const ensureCacheBlock = ensureCacheFn ? ensureCacheFn[0] : '';
ok(ensureCacheBlock.includes('includeId'), 'ensureExpertUsersCache accepts includeId');
ok(
  ensureCacheBlock.includes('include_id') && ensureCacheBlock.includes('/auth/expert-options'),
  'ensureExpertUsersCache calls /auth/expert-options?include_id= when includeId set',
);

ok(appJs.includes('distribution_office') && /SALES_EXPERT_ROLES\s*=\s*\[[^\]]*distribution_office/.test(appJs),
  'app.js SALES_EXPERT_ROLES includes distribution_office');
ok(/ensureExpertUsersCache\s*\(\s*true\b/.test(appJs), 'app.js calls ensureExpertUsersCache(true, …)');
ok(
  ensureCacheBlock.includes("api('GET','/auth/expert-options'+q)")
    || appJs.includes("api('GET','/auth/expert-options')")
    || appJs.includes('api("GET","/auth/expert-options")'),
  'app.js fetches /auth/expert-options',
);

const openInvFn = appJs.match(/async function _openInvBuilder\(id\)\{[\s\S]*?id="inv-expert"/);
const openInvChunk = openInvFn ? openInvFn[0] : '';
ok(openInvChunk.includes('ensureExpertUsersCache(true, defExpert'), '_openInvBuilder passes defExpert to ensureExpertUsersCache');
ok(openInvChunk.includes('ensureExpertId'), '_openInvBuilder defines ensureExpertId for legacy expert');
ok(
  openInvChunk.includes('seller_name') && openInvChunk.includes('salesperson'),
  '_openInvBuilder legacy stub uses seller_name/salesperson fallback',
);
ok(
  /ensureExpertId[\s\S]*salesUsers\.unshift/.test(openInvChunk),
  '_openInvBuilder unshifts stub when expert missing from salesUsers',
);

const invExpertIdx = appJs.indexOf('id="inv-expert"');
ok(invExpertIdx >= 0, 'app.js has inv-expert control');
const invExpertCtx = invExpertIdx >= 0
  ? appJs.slice(Math.max(0, invExpertIdx - 4500), invExpertIdx + 800)
  : '';
const OLD_NARROW_ROLES =
  "['admin','accounting','field_sales','inside_sales','salesperson','sales_manager']";
ok(!invExpertCtx.includes(OLD_NARROW_ROLES),
  'openInvBuilder region does not use old SALES_EXPERT_ROLES without distribution_office');
ok(invExpertCtx.includes('listSalesExpertUsers') || invExpertCtx.includes('ensureExpertUsersCache'),
  'inv-expert region uses expert cache helpers');

ok(swAtLeast(swSrc, 346), 'sw.js CACHE erp-taranom-v346+');
ok(/app\.js\?v=34[6-9]/.test(indexSrc), 'index.html app.js?v=346+');

const helpExpert = appJs.match(/کارشناس فاکتور[\s\S]{0,800}/);
const helpChunk = helpExpert ? helpExpert[0] : '';
ok(
  helpChunk.includes('expert-options') || helpChunk.includes('/auth/expert-options') || helpChunk.includes('دفتر پخش'),
  'help mentions expert-options or دفتر پخش in کارشناس فاکتور context',
);

try {
  new Function(appJs);
  ok(true, 'app.js parses with new Function()');
} catch (e) {
  ok(false, 'app.js parses with new Function()', e && e.message);
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
