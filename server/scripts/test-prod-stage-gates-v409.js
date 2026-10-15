'use strict';
/**
 * v409 — گیت سخت تکمیل مرحله BOM (حواله فقط در جریان + ترتیب + مالکیت مواد)
 * Run: node server/scripts/test-prod-stage-gates-v409.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const engPath = path.join(root, 'lib/production/engine-advanced.js');
const engSrc = fs.readFileSync(engPath, 'utf8');
const engCreate = fs.readFileSync(path.join(root, 'lib/production/engine.js'), 'utf8');

let n = 0;
function ok(msg) {
  n += 1;
  console.log('  ✓', msg);
}

// --- static contracts in engine-advanced ---
assert.ok(engSrc.includes("stage.status !== 'in_progress'"), 'issue requires in_progress');
assert.ok(engSrc.includes("E_PREV_STAGE_OPEN"), 'prev stage gate on issue/skip');
assert.ok(engSrc.includes('assertFabricIssueAllowed'), 'fabric double-issue blocked on stage issue');
assert.ok(engSrc.includes('E_STAGE_MATERIAL_OWNER'), 'materials must belong to stage');
assert.ok(engSrc.includes('E_STAGE_HAS_MATERIALS'), 'skip blocked when stage owns materials');
assert.ok(engSrc.includes('E_JE_REQUIRED'), 'JE required after material issue with amount');
assert.ok(engSrc.includes('material_added_rial = COALESCE(material_added_rial,0) + ?'), 'stage material rollup');
ok('engine-advanced stage issue/skip invariants present');

// --- create/release coerce routing BOM → *_adv ---
assert.ok(engCreate.includes('hasRouting') || engCreate.includes('has_routing'), 'routing detection on create');
assert.ok(engCreate.includes("variable_adv") && engCreate.includes('fixed_adv'), 'adv coercion');
assert.ok(
  engCreate.includes('releaseAdvancedOrder') && engCreate.includes('bom_operations'),
  'simple release upgrades when BOM has ops'
);
ok('create/release force advanced analysis when BOM has routing');

// --- journey gate v409 semantics ---
const Gate = require('../public/prod-journey-gate.js');
const onlyInProgressLegacy = Gate.buildSteps({
  activeBoms: 1,
  releasedOrders: 1,
  hasLay: true,
  hasAdvStages: true,
  stagesProgressed: false,
  kanbanTouched: true,
  postedPacks: 0,
  pendingPack: 0,
  hasUnitCost: false,
});
assert.strictEqual(onlyInProgressLegacy[3].done, false);
assert.ok(onlyInProgressLegacy[3].title.includes('BOM') || onlyInProgressLegacy[3].how.includes('انجام شد'));
ok('journey: stagesProgressed=false keeps step4 locked despite legacy kanbanTouched');

const progressed = Gate.buildSteps({
  activeBoms: 1,
  releasedOrders: 1,
  hasLay: true,
  hasAdvStages: true,
  stagesProgressed: true,
  postedPacks: 1,
  pendingPack: 0,
  hasUnitCost: false,
});
assert.strictEqual(progressed[3].done, true);
ok('journey: stagesProgressed unlocks step4');

// --- UI wiring ---
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
assert.ok(app.includes('buildProdStageStrip'));
assert.ok(app.includes('stagesProgressed'));
assert.ok(app.includes('پیشرفت مراحل BOM'));
assert.ok(app.includes('E_PREV_STAGE_OPEN'));
ok('app.js dashboard stage strip + error map');

const css = fs.readFileSync(path.join(root, 'public/prod-ui.css'), 'utf8');
assert.ok(css.includes('.prod-stage-chip'));
ok('prod-ui.css stage chips');

console.log('\nOK — test-prod-stage-gates-v409:', n, 'checks');
