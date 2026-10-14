'use strict';
/**
 * v382 — دروازهٔ ترتیبی مسیر ۶مرحله‌ای داشبورد تولید
 * Run: node server/scripts/test-prod-journey-gate-v382.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const Gate = require('../public/prod-journey-gate.js');

let n = 0;
function ok(msg) {
  n += 1;
  console.log('  ✓', msg);
}

// --- pure gate ---
const empty = Gate.buildSteps({
  activeBoms: 0,
  releasedOrders: 0,
  hasLay: false,
  hasAdvStages: false,
  kanbanTouched: false,
  postedPacks: 0,
  pendingPack: 0,
  hasUnitCost: false,
});
assert.strictEqual(empty.length, 6);
assert.strictEqual(empty[0].done, false);
assert.strictEqual(empty[3].done, true, 'kanban auto-done without adv stages');
assert.ok(Gate.canEnter(empty, 0).ok);
assert.ok(!Gate.canEnter(empty, 1).ok);
assert.ok(Gate.blockMessage(empty, 5).includes('فرمول ساخت') || Gate.blockMessage(empty, 5).includes('پیش‌نیاز'));
ok('empty metrics: only step1 enterable; kanban auto-done; block message names deps');

const afterBom = Gate.buildSteps({
  activeBoms: 1,
  releasedOrders: 0,
  hasLay: false,
  hasAdvStages: false,
  kanbanTouched: false,
  postedPacks: 0,
  pendingPack: 0,
  hasUnitCost: false,
});
assert.ok(Gate.canEnter(afterBom, 1).ok, 'order enterable after BOM');
assert.ok(!Gate.canEnter(afterBom, 2).ok, 'lay locked without released order');
const layBlock = Gate.blockMessage(afterBom, 2);
assert.ok(layBlock.includes('سفارش') || layBlock.includes('آزاد'), layBlock);
ok('after BOM: order open, lay blocked with order reason');

const mid = Gate.buildSteps({
  activeBoms: 2,
  releasedOrders: 1,
  hasLay: true,
  hasAdvStages: true,
  kanbanTouched: false,
  postedPacks: 0,
  pendingPack: 1,
  hasUnitCost: false,
});
assert.strictEqual(mid[3].done, false, 'adv stages need kanban touch');
assert.ok(!Gate.canEnter(mid, 4).ok, 'pack blocked until kanban when adv');
assert.ok(Gate.blockMessage(mid, 4).includes('تابلوی خط') || Gate.blockMessage(mid, 4).includes('۴'), Gate.blockMessage(mid, 4));
ok('adv path: pack blocked until kanban progress');

const afterKanbanDone = Gate.buildSteps({
  activeBoms: 1,
  releasedOrders: 1,
  hasLay: true,
  hasAdvStages: true,
  kanbanTouched: true, // e.g. all_stages status=done (columns may be empty)
  postedPacks: 0,
  pendingPack: 1,
  hasUnitCost: false,
});
assert.strictEqual(afterKanbanDone[3].done, true);
assert.ok(Gate.canEnter(afterKanbanDone, 4).ok);
ok('adv path: kanbanTouched from done stages unlocks pack');

const readyPack = Gate.buildSteps({
  activeBoms: 1,
  releasedOrders: 1,
  hasLay: true,
  hasAdvStages: false,
  kanbanTouched: false,
  postedPacks: 0,
  pendingPack: 2,
  hasUnitCost: false,
});
assert.ok(Gate.canEnter(readyPack, 4).ok, 'pack enterable when 1–4 prior done (kanban auto)');
assert.ok(readyPack[4].how.includes('2') || readyPack[4].how.includes('۲') || readyPack[4].how.includes('منتظر'), readyPack[4].how);
ok('simple path: pack enterable; how mentions pending packs');

const doneAll = Gate.buildSteps({
  activeBoms: 1,
  releasedOrders: 1,
  hasLay: true,
  hasAdvStages: true,
  kanbanTouched: true,
  postedPacks: 3,
  pendingPack: 0,
  hasUnitCost: true,
});
assert.strictEqual(Gate.nextIndex(doneAll), -1);
assert.ok(Gate.canEnter(doneAll, 5).ok);
ok('all done: nextIndex=-1; cost re-enterable');

assert.strictEqual(Gate.stepIndexForTarget('acc-production-orders'), 1);
assert.strictEqual(Gate.stepIndexForTarget('pending-pack'), 4);
assert.strictEqual(Gate.stepIndexForTarget('acc-production-cost-sheet'), 5);
ok('route target → step index map');

// --- static wiring ---
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
assert.ok(app.includes('prodJourneyTryEnter'));
assert.ok(app.includes('prodJourneyRouteEnter'));
assert.ok(app.includes('is-locked'));
assert.ok(app.includes('v382 دروازه'));
assert.ok(app.includes('all_stages'));
assert.ok(app.includes('همیشه تازه'));
assert.ok(app.includes("prodJourneyRouteEnter('acc-production-orders'"));
assert.ok(app.includes("prodJourneyRouteEnter('acc-cutting-lays'"));
new Function(app);
ok('app.js: gate helpers + locked UI + Help v382 + parse');

const idx = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/prod-ui.css'), 'utf8');
assert.ok(idx.includes('prod-journey-gate.js?v=382'));
assert.ok(idx.includes('app.js?v=382'));
assert.ok(idx.includes('prod-ui.css?v=382'));
assert.ok(sw.includes('erp-taranom-v382'));
assert.ok(css.includes('.prod-journey-card.is-locked'));
ok('SW/index/css stamp v382 + locked style');

console.log(`\nPASS ${n}/9 test-prod-journey-gate-v382`);
