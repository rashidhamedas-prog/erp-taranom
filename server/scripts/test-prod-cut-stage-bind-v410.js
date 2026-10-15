'use strict';
/**
 * v410 — اتصال لایه‌چینی به مرحلهٔ برش BOM
 * Run: node server/scripts/test-prod-cut-stage-bind-v410.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let n = 0;
function ok(msg) {
  n += 1;
  console.log('  ✓', msg);
}

const adv = fs.readFileSync(path.join(root, 'lib/production/engine-advanced.js'), 'utf8');
const cut = fs.readFileSync(path.join(root, 'lib/production/cutting.js'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'lib/production/schema.js'), 'utf8');

assert.ok(adv.includes('function resolveCuttingStage'));
assert.ok(adv.includes('function applyCuttingLayToStage'));
assert.ok(adv.includes('function unlinkCuttingLayFromStage'));
assert.ok(adv.includes("issue_type='cutting_lay'") || adv.includes("issue_type === 'cutting_lay'"));
assert.ok(adv.includes("issue_type === 'cutting_lay'") || adv.includes('cutting_lay'));
assert.ok(adv.includes("mode: 'variable'"), 'complete cut stage without backflush');
ok('engine-advanced cut↔stage API present');

assert.ok(cut.includes('bindCuttingLayToOrderStage'));
assert.ok(cut.includes('unbindCuttingLayFromOrderStage'));
assert.ok(cut.includes('bindCuttingLayToOrderStage(db,'));
assert.ok(cut.includes('unbindCuttingLayFromOrderStage(db, row'));
ok('cutting.js wires bind on post/amend/void/link');

assert.ok(schema.includes("ensureColumn(db, 'cutting_lays', 'stage_id'"));
ok('schema stage_id on cutting_lays');

const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
assert.ok(app.includes('v411 اتصال') || app.includes('اتصال لایه‌چینی → مرحلهٔ برش'));
ok('Help mentions cut-stage bind v411');

console.log('\nOK — test-prod-cut-stage-bind-v410:', n, 'checks');
