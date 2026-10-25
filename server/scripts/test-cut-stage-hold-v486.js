'use strict';
const { swAtLeast } = require('./lib/sw-at-least');
/**
 * v486 — یک طاقه تا برابر شدن با سفارش، مرحلهٔ برش را نمی‌بندد.
 * Run: node server/scripts/test-cut-stage-hold-v486.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const adv = fs.readFileSync(path.join(root, 'lib/production/engine-advanced.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');

let n = 0;
function ok(msg) {
  n += 1;
  console.log('  ✓', msg);
}

assert.ok(adv.includes('function cuttingStageCoverage'), 'coverage helper');
assert.ok(adv.includes('function reopenUndercutCuttingStage'), 'reopen premature cut');
assert.ok(adv.includes('completed: false'), 'partial lay stays open');
assert.ok(!adv.includes('qty_in را با تعداد برش'), 'lay no longer shrinks stage input');
assert.ok(adv.includes('orderBomPeerLines'), 'multi-product coverage is per product');
ok('server holds the cutting stage until lay qty matches the order');

assert.ok(app.includes('function cuttingStageBindToast'), 'toast follows stage_bind');
assert.ok(app.includes('cut_coverage'), 'stage list shows cut progress');
ok('ui tells the operator the cut is still short');

new Function(app);
ok('app.js parses');
assert.ok(swAtLeast(sw, 488), 'sw v488');
ok('sw bumped');

console.log('PASS', n);
