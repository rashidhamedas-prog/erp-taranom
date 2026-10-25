'use strict';
const { swAtLeast } = require('./lib/sw-at-least');
/**
 * Soft fabric color match: spacing / ZWNJ / optional و (سورمه ای ≈ سرمه‌ای)
 * Run: node server/scripts/test-color-soft-match-v379.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  normalizeFabricColor,
  fabricColorMatchKey,
  colorsMatch,
} = require('../lib/inventory/fabric-rolls');

let n = 0;
function ok(msg) { n += 1; console.log('  ✓', msg); }

assert.strictEqual(normalizeFabricColor('سورمه‌ای'), 'سورمه ای');
assert.strictEqual(fabricColorMatchKey('سورمه ای'), fabricColorMatchKey('سرمه‌ای'));
assert.strictEqual(colorsMatch('سورمه ای', 'سرمه‌ای'), true, 'navy with/without و');
assert.strictEqual(colorsMatch('سورمه ای', 'سورمه‌ای'), true, 'space vs ZWNJ');
assert.strictEqual(colorsMatch('مشکی', ' مشکی '), true);
assert.strictEqual(colorsMatch('سورمه ای', 'مشکی'), false);
assert.strictEqual(colorsMatch('قهوه ای', 'شکلاتی'), false);
ok('colorsMatch soft navy + spacing');

const apparel = fs.readFileSync(path.join(__dirname, '../lib/inventory/apparel-lines.js'), 'utf8');
assert.ok(apparel.includes('colorsMatch'));
ok('apparel-lines uses colorsMatch');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
assert.ok(app.includes('function colorsMatch'));
assert.ok(app.includes('ماتریس کالا'));
assert.ok(app.includes('v379'));
new Function(app);
ok('app.js cutting colorsMatch + matrix-first + parse');

const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const idx = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
assert.ok(swAtLeast(sw, 379));
assert.ok(idx.includes('app.js?v=379'));
ok('SW/index v379');

console.log(`\nPASS ${n}/4 test-color-soft-match-v379`);
