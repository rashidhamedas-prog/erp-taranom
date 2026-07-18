'use strict';
/**
 * Production module smoke — route/lib load + export contracts (no HTTP server)
 */
const { ok, freshDb, summary } = require('./lib/test-harness');
const reports = require('../lib/production/reports');
const close = require('../lib/production/close');
const adv = require('../lib/production/engine-advanced');

console.log('\n══ Production API Smoke Tests ══\n');

const { cleanup } = freshDb();

const ROUTE_MODULES = [
  '../routes/production.js',
  '../routes/production-boms.js',
  '../routes/production-orders.js',
  '../routes/production-execution.js',
  '../routes/production-close.js',
  '../routes/production-reports.js',
  '../routes/production-mrp.js',
  '../routes/production-cost-centers.js',
  '../routes/production-access.js',
];

for (const rel of ROUTE_MODULES) {
  try {
    const router = require(rel);
    const isRouter = typeof router === 'function' && Array.isArray(router.stack);
    ok(`route ${rel} exports router`, isRouter);
  } catch (e) {
    ok(`route ${rel} loads`, false, e.message);
  }
}

const LIB_MODULES = [
  '../lib/production/schema.js',
  '../lib/production/bom.js',
  '../lib/production/bom-advanced.js',
  '../lib/production/engine.js',
  '../lib/production/engine-advanced.js',
  '../lib/production/estimate.js',
  '../lib/production/mrp.js',
  '../lib/production/close.js',
  '../lib/production/reports.js',
  '../lib/production/posting.js',
  '../lib/production/costing.js',
  '../lib/production/access.js',
  '../lib/production/health-check.js',
  '../lib/production/subcontract.js',
  '../lib/production/waste.js',
  '../lib/production/overhead.js',
  '../lib/production/labor.js',
  '../lib/production/report-export.js',
];

for (const rel of LIB_MODULES) {
  try {
    require(rel);
    ok(`lib ${rel.split('/').pop()} loads`, true);
  } catch (e) {
    ok(`lib ${rel.split('/').pop()} loads`, false, e.message);
  }
}

{
  const cat = reports.catalog();
  ok('catalog non-empty', cat.length >= 24);
  for (let i = 1; i <= 24; i++) {
    const code = `PR-${String(i).padStart(2, '0')}`;
    ok(`REPORTS registry ${code}`, cat.some(r => r.code === code));
  }
}

ok('close.precheck', typeof close.precheck === 'function');
ok('close.calculate', typeof close.calculate === 'function');
ok('close.execute', typeof close.execute === 'function');
ok('close.reopen', typeof close.reopen === 'function');

ok('releaseAdvancedOrder', typeof adv.releaseAdvancedOrder === 'function');
ok('postStageOutputFixed', typeof adv.postStageOutputFixed === 'function');
ok('postStageOutputVariable', typeof adv.postStageOutputVariable === 'function');
ok('finalizeAdvancedOrder', typeof adv.finalizeAdvancedOrder === 'function');
ok('skipStage', typeof adv.skipStage === 'function');
ok('blockStage', typeof adv.blockStage === 'function');
ok('issueStageMaterials', typeof adv.issueStageMaterials === 'function');
ok('reverseStage', typeof adv.reverseStage === 'function');

cleanup();
summary('Production API Smoke');
