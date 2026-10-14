'use strict';
/**
 * Static + pure-unit checks for v378 production cut/pack/issue flow.
 * Run: node server/scripts/test-prod-cut-pack-static-v378.js
 * Full DB harness: test-prod-cut-pack-flow-v378.js (Iran / native better-sqlite3).
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');

let n = 0;
function ok(msg) { n += 1; console.log('  ✓', msg); }

const cut = fs.readFileSync(path.join(root, 'lib/production/cutting.js'), 'utf8');
assert.ok(cut.includes('function fabricIssueAllowance'));
assert.ok(cut.includes('fabricIssueAllowance'));
assert.ok(cut.includes('colorsMatch'));
assert.ok(cut.includes('production_order_lines'));
ok('cutting: allowance + pack color→variant');

const eng = fs.readFileSync(path.join(root, 'lib/production/engine.js'), 'utf8');
assert.ok(eng.includes('fabricIssueAllowance'));
assert.ok(eng.includes('fabric_cut_locked'));
assert.ok(eng.includes('fabric_qty_allowed'));
ok('engine issueTemplate exposes cut lock fields');

const appLines = fs.readFileSync(path.join(root, 'lib/inventory/apparel-lines.js'), 'utf8');
assert.ok(appLines.includes('colorsMatch'));
assert.ok(appLines.includes('stripSizeFitNote'));
assert.ok(appLines.includes('sizesMatch'));
assert.ok(appLines.includes('چند رنگ'));
ok('apparel-lines: colorsMatch + size fit + multi-color message');

const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
assert.ok(app.includes('fabric_cut_locked'));
assert.ok(app.includes("goArg==='pending-pack'"));
assert.ok(app.includes('برش / WIP'));
assert.ok(app.includes('data-fabric-locked'));
assert.ok(app.includes('v378'));
assert.ok(app.includes('colorsMatch'));
new Function(app);
ok('app.js: issue lock UI + journey pack-next + kanban cut column + parse');

const { stripSizeFitNote } = require('../lib/display-labels');
const { colorsMatch, normalizeFabricColor } = require('../lib/inventory/fabric-rolls');

assert.strictEqual(stripSizeFitNote('فری سایز (مناسب تا 48)'), 'فری سایز');
assert.strictEqual(colorsMatch('سورمه ای', 'سورمه‌ای'), true);
assert.strictEqual(colorsMatch('مشکی', 'قهوه ای'), false);
assert.ok(normalizeFabricColor(' سورمه‌ای ') === normalizeFabricColor('سورمه ای'));
ok('pure: stripSizeFitNote + colorsMatch');

const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const idx = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
assert.ok(sw.includes('erp-taranom-v378'));
assert.ok(idx.includes('app.js?v=378'));
ok('SW/index stamp v378');

console.log(`\nPASS ${n}/6 test-prod-cut-pack-static-v378`);
