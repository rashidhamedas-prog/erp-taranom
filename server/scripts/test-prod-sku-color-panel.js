'use strict';
/**
 * Unit tests for prod-sku-color-panel pure helpers (faNorm, filter, classify, size label).
 */
const assert = require('assert');
const {
  faNorm,
  prodColorFilter,
  prodSkuClassifyColors,
  splitSizeLabel,
} = require('../lib/prod-sku-color-panel');

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed += 1;
  console.log('  ✓', msg);
}

console.log('prod-sku-color-panel');

ok(faNorm('آبي') === faNorm('آبی') || faNorm('آبي').includes('ابی'), 'ي عربی → ی');
ok(faNorm('آبي') === 'ابی' || faNorm('آبي') === faNorm('ابی'), 'آبي folds to ابی');
ok(faNorm('قهوه‌ای') === faNorm('قهوه ای') || faNorm('قهوه‌ای').replace(/\s/g,'') === faNorm('قهوه ای').replace(/\s/g,''), 'ZWNJ vs space');
ok(faNorm('كرم') === 'کرم' || faNorm('كرم').includes('کرم'), 'ك → ک');
ok(faNorm('۱۲۳') === '123', 'Persian digits');

const list = [
  { id: 1, name: 'آبی کاربنی', code: 'BL' },
  { id: 2, name: 'قهوه ای', code: 'BR' },
  { id: 3, name: 'مشکی', code: 'BK' },
];
ok(prodColorFilter(list, 'آبي').some((c) => c.id === 1), 'filter آبي finds آبی');
ok(prodColorFilter(list, 'قهوه').some((c) => c.id === 2), 'filter قهوه');
ok(prodColorFilter(list, 'BK').some((c) => c.id === 3), 'filter by code');
ok(prodColorFilter(list, '').length === 3, 'empty query returns all');

const styleVars = [
  { color_id: 10, size_id: 1, stock: 1, active: 1, warehouse_id: 34 },
  { color_id: 11, size_id: 1, stock: 0, active: 1, warehouse_id: 34 },
  { color_id: 12, size_id: 1, stock: 2, active: 1, warehouse_id: 35 }, // other wh only if scoped
];
const helpers = {
  styleColorIds: () => new Set([10, 11, 12]),
  matrixColorIds: () => new Set([10]),
  preserveColorIds: () => [12],
};
const cls = prodSkuClassifyColors(styleVars, 34, helpers);
ok(cls.withStock.includes(10), 'withStock has 10');
ok(cls.withoutStock.includes(11), 'withoutStock has 11');
ok(cls.otherWh.includes(12), 'otherWh has 12');
ok(!cls.withoutStock.includes(12), 'otherWh not double-counted as withoutStock');

const sz = splitSizeLabel('فری سایز (مناسب تا ۴۸)');
ok(sz.main === 'فری سایز', 'size main');
ok(sz.sub.includes('۴۸') || sz.sub.includes('48'), 'size sub');
ok(splitSizeLabel('سایز ۱').main === 'سایز ۱' && !splitSizeLabel('سایز ۱').sub, 'plain size');

console.log(`OK ${passed} assertions`);
process.exit(0);
