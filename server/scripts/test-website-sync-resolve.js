#!/usr/bin/env node
'use strict';
/**
 * Catalog code vs internal id for website stock dry-run / retry.
 * node server/scripts/test-website-sync-resolve.js
 */
const assert = require('assert');
const { resolveSyncProduct, formatDryRunChannel } = require('../lib/website-stock-sync');

function dbOf(rows) {
  return {
    prepare(sql) {
      return {
        get(val) {
          if (String(sql).includes('WHERE id=?')) {
            return rows.find((r) => Number(r.id) === Number(val)) || undefined;
          }
          if (String(sql).includes('WHERE code=?')) {
            return rows.find((r) => String(r.code) === String(val)) || undefined;
          }
          throw new Error('unexpected sql ' + sql);
        },
      };
    },
  };
}

const rows = [
  { id: 14, code: 'K-00014', name: 'دورس محمودی' },
  { id: 101, code: '7141', name: 'اورکت کتان لاله' },
];
const db = dbOf(rows);

const byCode = resolveSyncProduct(db, '7141');
assert.strictEqual(byCode.ok, true);
assert.strictEqual(byCode.via, 'code');
assert.strictEqual(byCode.product.id, 101);
assert.ok(byCode.label.includes('7141'));
assert.ok(byCode.label.includes('101'));

const byId = resolveSyncProduct(db, '101');
assert.strictEqual(byId.via, 'id');
assert.strictEqual(byId.product.code, '7141');

const byTextId = resolveSyncProduct(db, 14);
assert.strictEqual(byTextId.product.code, 'K-00014');

const missing = resolveSyncProduct(db, '999999');
assert.strictEqual(missing.ok, false);
assert.ok(missing.error.includes('999999'));

const blank = resolveSyncProduct(db, '  ');
assert.strictEqual(blank.ok, false);

const clash = dbOf([
  { id: 7141, code: 'OTHER', name: 'کالای دیگر' },
  { id: 101, code: '7141', name: 'اورکت کتان لاله' },
]);
assert.strictEqual(resolveSyncProduct(clash, '7141').product.id, 101);
assert.strictEqual(resolveSyncProduct(clash, '7141').via, 'code');

const kcode = resolveSyncProduct(db, 'K-00014');
assert.strictEqual(kcode.product.id, 14);
assert.strictEqual(kcode.via, 'code');

const noProduct = formatDryRunChannel({
  channel: 'WHOLESALE',
  ok: false,
  reason: 'no_matrix_variants',
  matched: 0,
  unmatched: [],
});
assert.ok(!noProduct.includes('unmatched=—'), noProduct);
assert.ok(noProduct.includes('ماتریس'), noProduct);

const variantMiss = formatDryRunChannel({
  channel: 'RETAIL',
  ok: false,
  matched: 4,
  unmatchedCount: 1,
  unmatched: [{ color: 'سرمه‌ای', size: 'سایز ۱', reason: 'variant_not_matched', erpVariantSku: '7141-x' }],
});
assert.ok(variantMiss.includes('matched=4'), variantMiss);
assert.ok(variantMiss.includes('سرمه‌ای'), variantMiss);
assert.ok(variantMiss.includes('همین رنگ/سایز در سایت نیست'), variantMiss);
assert.ok(!variantMiss.includes('7141-x'), variantMiss);

console.log('test-website-sync-resolve: ok');
