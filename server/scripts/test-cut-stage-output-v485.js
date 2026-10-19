'use strict';
/**
 * v485 — ثبت خروجی مرحلهٔ برش پارچهٔ طولی فقط از لایه‌چینی.
 * Run: node server/scripts/test-cut-stage-output-v485.js
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

assert.ok(adv.includes('function lengthFabricProduct'), 'length fabric detector');
assert.ok(adv.includes('function assertCuttingOutputHasLay'), 'cut output requires lay');
assert.ok(adv.includes('E_LAY_REQUIRED_ON_CUT'), 'structured lay gate');
assert.ok(adv.includes('via_cutting_lay'), 'issue template marks lay fabric');
assert.ok(adv.includes('cut_lay'), 'issue template tells UI to open lay');
assert.ok(adv.includes('assertCuttingOutputHasLay(db, po, stage, qtyOut)'), 'gate runs on stage output');
ok('server: cutting-stage output cannot stock-issue length fabric');

assert.ok(app.includes('cuttingLayModal(null,{orderId:orderId})'), 'output button opens lay for this order');
assert.ok(app.includes('function cuttingReturnAfterPost'), 'after lay, return to stages');
assert.ok(app.includes('E_LAY_REQUIRED_ON_CUT'), 'client maps lay gate');
assert.ok(app.includes('via_cutting_lay'), 'issue form hides length fabric');
assert.ok(app.includes('خروجی برش — لایه‌چینی'), 'lay modal title when opened from stage');
ok('ui: register-output on uncovered cut opens lay');

new Function(app);
ok('app.js parses');

assert.ok(sw.includes('erp-taranom-v485'), 'sw cache bumped');
ok('sw v485');

console.log('PASS', n);
