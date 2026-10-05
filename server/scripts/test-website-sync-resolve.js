#!/usr/bin/env node
'use strict';
/**
 * Catalog code vs internal id for website stock dry-run / retry.
 * node server/scripts/test-website-sync-resolve.js
 */
const assert = require('assert');
const { resolveSyncProduct, formatDryRunChannel, chunkMatrixRequests } = require('../lib/website-stock-sync');

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
const counted = formatDryRunChannel({
  channel: 'WHOLESALE',
  ok: true,
  matched: [{ qty: 9 }, { qty: 8 }, { qty: 9 }],
  unmatched: [],
  unmatchedCount: 0,
});
assert.ok(counted.includes('OK'), counted);
assert.ok(counted.includes('matched=3'), counted);
assert.ok(variantMiss.includes('سرمه‌ای'), variantMiss);
assert.ok(variantMiss.includes('همین رنگ/سایز در سایت نیست'), variantMiss);
assert.ok(!variantMiss.includes('7141-x'), variantMiss);

const variants = Array.from({ length: 14 }, (_, i) => ({ sku: 'v' + i, qty: i }));
const chunks = chunkMatrixRequests({
  idempotencyKey: 'erp:WHOLESALE:p101:h1',
  channel: 'WHOLESALE',
  productSku: '7141',
  variants,
}, { dryRun: true });
assert.deepStrictEqual(chunks.map((c) => c.variants.length), [6, 6, 2]);
assert.strictEqual(new Set(chunks.map((c) => c.idempotencyKey)).size, 3);
assert.ok(chunks.every((c) => c.idempotencyKey.startsWith('erp:WHOLESALE:p101:h1:c')));
assert.ok(chunks.every((c) => c.dryRun === true && c.productSku === '7141'));
assert.strictEqual(chunks[0].variants[0].sku, 'v0');
assert.strictEqual(chunks[2].variants[1].sku, 'v13');

const seven = chunkMatrixRequests({ idempotencyKey: 'k', variants: variants.slice(0, 7) });
assert.deepStrictEqual(seven.map((c) => c.variants.length), [6, 1]);
const one = chunkMatrixRequests({ idempotencyKey: 'k', variants: variants.slice(0, 1) });
assert.deepStrictEqual(one.map((c) => c.variants.length), [1]);
assert.strictEqual(one[0].idempotencyKey, 'k:c0');

console.log('test-website-sync-resolve: ok');
