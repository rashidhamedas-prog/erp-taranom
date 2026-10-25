'use strict';
const { swAtLeast } = require('./lib/sw-at-least');
/**
 * v487 — جستجوی کالای دوخته‌شده در خروجی برش از کاتالوگ کامل و محصولات همان سفارش.
 * Run: node server/scripts/test-cutting-fg-picker-v487.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

let n = 0;
function ok(msg) {
  n += 1;
  console.log('  ✓', msg);
}

new Function(app);
ok('app.js parses');

assert.ok(swAtLeast(sw, 487), 'sw cache');
assert.ok(html.includes('/app.js?v=487'), 'app cache bust');
assert.ok(app.includes('await ensureProductsCache()'), 'lay modal loads full catalog');
assert.ok(app.includes('cuttingBindSewnPickers(po)'), 'order scopes the picker');
assert.ok(app.includes('textMatchesQuery'), 'persian match in generic search');
assert.ok(app.includes('فهرست کالا خالی است'), 'empty catalog message');
assert.ok(app.includes('با این عبارت در فهرست فعلی نیست'), 'miss message');
assert.ok(app.includes('جستجوی کالای دوخته‌شده (v487)'), 'admin help');
ok('markers');

function sliceFn(name) {
  const start = app.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  let i = app.indexOf('{', start);
  let depth = 0;
  for (; i < app.length; i++) {
    const c = app[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return app.slice(start, i + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

const ctx = {
  CACHE: { allProducts: [], _allProductsIsFull: true },
  fmt: (v) => String(v),
};
vm.createContext(ctx);
vm.runInContext(
  sliceFn('_omniNorm') + '\n' + sliceFn('textMatchesQuery') + '\n' + sliceFn('cuttingIsSewnProduct') + '\n' + sliceFn('cuttingSewnPickerProducts'),
  ctx
);

ctx.CACHE.allProducts = [
  { id: 1, name: 'پارچه مموری', item_type: 'material', is_manufactured: 0 },
  { id: 9, name: 'کاپشن دیگر', item_type: 'finished', is_manufactured: 1, code: 'J-9' },
];
const orderOnly = ctx.cuttingSewnPickerProducts({
  product_id: 14,
  fg_plan: [
    { product_id: 14, product_name: 'کاپشن مموری یلدا', qty_planned: 96 },
    { product_id: 15, product_name: 'کاپشن مموری آبان', qty_planned: 96 },
  ],
});
assert.strictEqual(Array.from(orderOnly).map((p) => p.id).join(','), '14,15');
assert.strictEqual(orderOnly[1].name, 'کاپشن مموری آبان');
ok('order products win even when absent from manufactured cache');

ctx.CACHE.allProducts = [{ id: 3, name: 'زیپ', item_type: 'material', is_manufactured: 0 }];
const fallback = ctx.cuttingSewnPickerProducts(null);
assert.strictEqual(Array.from(fallback).length, 1);
assert.strictEqual(fallback[0].name, 'زیپ');
ok('no sewn flag falls back to the loaded catalog');

const hit = ctx.textMatchesQuery('کاپشن مموری یلدا J-14', 'كاپشن\u200cیلدا');
assert.strictEqual(hit, true);
ok('arabic kaf and zwnj still match');

console.log('test-cutting-fg-picker-v487:', n, 'ok');
