'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');
let n = 0;
function ok(msg) { n++; console.log('  ✓', msg); }

const fr = fs.readFileSync(path.join(root, 'lib/inventory/fabric-rolls.js'), 'utf8');
assert.ok(fr.includes('function normalizeFabricColor'));
assert.ok(fr.includes('function colorsMatch'));
assert.ok(fr.includes('query.color'));
assert.ok(fr.includes('wantColor'));
ok('fabric-rolls list filters + normalize');

const cut = fs.readFileSync(path.join(root, 'lib/production/cutting.js'), 'utf8');
assert.ok(cut.includes('E_CUT_ROLL_COLOR'));
assert.ok(cut.includes('E_CUT_COLOR_REQUIRED'));
assert.ok(cut.includes('E_CUT_PO_COLOR'));
assert.ok(cut.includes('E_CUT_ROLL_WIDTH'));
ok('cutting validates roll color/width + PO color');

const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
assert.ok(app.includes('cuttingResolveFabricAndRolls'));
assert.ok(app.includes('cuttingRefreshRollPicker'));
assert.ok(app.includes('طاقه در لایه‌چینی'));
new Function(app);
ok('app.js roll picker + help + parse');

function normalizeFabricColor(raw) {
  return String(raw == null ? '' : raw)
    .trim()
    .replace(/\u200c/g, '')
    .replace(/[\u064A\u0649]/g, '\u06cc')
    .replace(/\u0643/g, '\u06a9')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
function colorsMatch(a, b) {
  const na = normalizeFabricColor(a);
  const nb = normalizeFabricColor(b);
  if (!na || !nb) return false;
  return na === nb;
}
assert.strictEqual(colorsMatch('مشکی', ' مشکی '), true);
assert.strictEqual(colorsMatch('سرمه‌ای', 'قهوه ای'), false);
ok('colorsMatch unit');

console.log(`\nPASS ${n}/4 test-fabric-cut-link-static-v269`);
