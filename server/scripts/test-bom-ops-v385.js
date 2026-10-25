'use strict';
const { swAtLeast } = require('./lib/sw-at-least');
/**
 * Static + light lib gates for BOM edit/delete with dependency preview (v385).
 * Run: node server/scripts/test-bom-ops-v385.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0;
let fail = 0;
function ok(msg, cond = true) {
  if (!cond) {
    fail += 1;
    console.log('  ✗', msg);
    return;
  }
  n += 1;
  console.log('  ✓', msg);
}

const root = path.join(__dirname, '..');
const bomSrc = fs.readFileSync(path.join(root, 'lib/production/bom.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'routes/production-boms.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/prod-ui.css'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const idx = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

ok('lib getBomDependencies', bomSrc.includes('function getBomDependencies'));
ok('lib countOpenOrdersForBom', bomSrc.includes('function countOpenOrdersForBom'));
ok('lib softDelete checks E_BOM_IN_USE', /function softDeleteBom[\s\S]*E_BOM_IN_USE/.test(bomSrc));
ok('lib archive clears default_bom_id', /function archiveBom[\s\S]*default_bom_id=NULL/.test(bomSrc));
ok('lib exports getBomDependencies', bomSrc.includes('getBomDependencies,'));

ok('route GET /:id/dependencies', routes.includes("router.get('/:id/dependencies'"));
ok('route fa E_BOM_IN_USE', routes.includes('E_BOM_IN_USE:'));
ok('route fa E_BOM_LOCKED kept', routes.includes('E_BOM_LOCKED:'));

ok('UI prodBomEditGate', app.includes('function prodBomEditGate'));
ok('UI prodBomRemoveGate', app.includes('function prodBomRemoveGate'));
ok('UI prodBomDeactivateGate', app.includes('function prodBomDeactivateGate'));
ok('UI calls dependencies API', app.includes("/production/boms/'+id+'/dependencies"));
ok('UI archive confirm', app.includes("'/production/boms/'+id+'/archive'"));
ok('UI Help v385', app.includes('ویرایش و حذف حرفه‌ای فهرست BOM (v385)'));
ok('UI prod-bom-ops cluster', app.includes('prod-bom-ops'));

ok('CSS dep box', css.includes('.prod-bom-dep-box'));
ok('SW v385', swAtLeast(sw, 385));
ok('index app.js?v=385', idx.includes('app.js?v=385'));
ok('index prod-ui.css?v=385', idx.includes('prod-ui.css?v=385'));

try {
  new Function(app);
  ok('app.js parses');
} catch (e) {
  ok('app.js parses: ' + e.message, false);
}

// Runtime deps checks stay in test-production-bom.js (isolated harness).
// Avoid require('lib/production/bom') here — it loads db.js and can touch live DB.

console.log(`\n${fail ? 'FAIL' : 'PASS'} ${n}/${n + fail} test-bom-ops-v385`);
process.exit(fail ? 1 : 0);
