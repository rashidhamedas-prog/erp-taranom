'use strict';
/**
 * NONTAX-P1 (package 10) — website stock sync success predicate.
 *
 * Pure fixtures only: no DB, no network, no better-sqlite3.
 *   node server/scripts/test-nontax-website-sku.js
 *
 * Contract under test (server/lib/website-stock-sync.js):
 *   - all sellable rows matched            => ok:true,  status 'done'
 *   - any sellable row unmatched           => ok:false, status !== 'done',
 *                                             unmatchedCount + ≤5 examples + Persian message
 *   - transport failure                    => ok:false, code 'transport_failed'
 *   - rerun on the same payload            => identical verdict, inputs untouched
 *   - no fuzzy-name merge: a site "suggestion" never turns unmatched into success
 */
const assert = require('assert');
const {
  classifyMatrixPushResult,
  formatUnmatchedExample,
  summarizeOutboxRow,
  UNMATCHED_EXAMPLE_LIMIT,
} = require('../lib/website-stock-sync');

let n = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  n += 1;
  console.log('  PASS', msg);
}
const PERSIAN = /[\u0600-\u06FF]/;

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const k of Object.keys(obj)) deepFreeze(obj[k]);
  }
  return obj;
}

// Payload as produced by buildMatrixPayload(): only active, non-default rows.
const payload = deepFreeze({
  productSku: '7080',
  channel: 'WHOLESALE',
  warehouseId: 3,
  idempotencyKey: 'erp:WHOLESALE:p80:wh3:hfixture',
  variants: [
    { erpVariantSku: '7080-BLK-M', color: 'مشکی', size: 'M', qty: 4 },
    { erpVariantSku: '7080-BLK-L', color: 'مشکی', size: 'L', qty: 2 },
    { erpVariantSku: '7080-WHT-M', color: 'سفید', size: 'M', qty: 0 },
  ],
});

// ── 1) all matched ⇒ success ────────────────────────────────────────────────
console.log('all matched');
const allMatched = classifyMatrixPushResult(deepFreeze({
  ok: true,
  status: 200,
  matched: ['7080-BLK-M', '7080-BLK-L', '7080-WHT-M'],
  unmatched: [],
}), payload);
ok(allMatched.ok === true, 'all matched => ok:true');
ok(allMatched.status === 'done', 'all matched => status done');
ok(allMatched.code === 'all_matched', 'all matched => code all_matched');
ok(allMatched.unmatchedCount === 0 && allMatched.examples.length === 0, 'all matched => zero unmatched, no examples');
ok(allMatched.matched === 3 && allMatched.expected === 3, 'matched array counted; expected = sellable rows in payload');
ok(PERSIAN.test(allMatched.message), 'success message is Persian');

// matched reported as a number (older site shape) is accepted too
const numMatched = classifyMatrixPushResult({ ok: true, status: 200, matched: 3, unmatched: [] }, payload);
ok(numMatched.ok === true && numMatched.matched === 3, 'numeric matched count accepted');

// ── 2) one unmatched ⇒ not success, examples present ────────────────────────
console.log('one unmatched');
const oneUnmatchedPush = deepFreeze({
  ok: true,
  status: 200,
  matched: 2,
  unmatched: [{ erpVariantSku: '7080-WHT-M', color: 'سفید', size: 'M', reason: 'variant_not_found' }],
});
const oneUnmatched = classifyMatrixPushResult(oneUnmatchedPush, payload);
ok(oneUnmatched.ok === false, 'one unmatched => ok:false even though HTTP 200');
ok(oneUnmatched.status !== 'done', 'one unmatched => status is not done');
ok(oneUnmatched.code === 'variants_unmatched', 'one unmatched => code variants_unmatched');
ok(oneUnmatched.catalogMissing === false, 'partial unmatched is not a catalog-missing case');
ok(oneUnmatched.unmatchedCount === 1, 'unmatched count = 1');
ok(oneUnmatched.examples.length === 1 && oneUnmatched.examples[0].label === 'سفید / M', 'example label is colour / size');
ok(oneUnmatched.examples[0].erpVariantSku === '7080-WHT-M' && oneUnmatched.examples[0].reason === 'variant_not_found', 'example keeps SKU + reason');
ok(PERSIAN.test(oneUnmatched.message), 'unmatched message is Persian');
ok(oneUnmatched.message.includes('1') && oneUnmatched.message.includes('3'), 'message states unmatched count and expected rows');
ok(oneUnmatched.message.includes('سفید / M'), 'message quotes the example');
ok(/نگاشت/.test(oneUnmatched.message), 'message is actionable (points at mapping)');

// ── 3) whole product missing on site ⇒ not success, catalog code ────────────
console.log('product sku not found');
const catalog = classifyMatrixPushResult({
  ok: true,
  status: 200,
  matched: 0,
  unmatched: payload.variants.map((v) => ({
    erpVariantSku: v.erpVariantSku, color: v.color, size: v.size, reason: 'product_sku_not_found',
  })),
}, payload);
ok(catalog.ok === false && catalog.status === 'error', 'catalog missing => not success');
ok(catalog.code === 'product_sku_not_found' && catalog.catalogMissing === true, 'catalog missing => dedicated code');
ok(catalog.unmatchedCount === 3 && catalog.examples.length === 3, 'every sellable row reported');
ok(catalog.message.includes('7080'), 'message names the product code');
ok(/وصل|بساز/.test(catalog.message) && /همگام‌سازی/.test(catalog.message), 'message tells operator to map/create then re-sync');
ok(/صریح/.test(catalog.message), 'message states explicit mapping only');

// ── 4) examples capped at UNMATCHED_EXAMPLE_LIMIT ───────────────────────────
console.log('example cap');
const wide = {
  ...payload,
  variants: Array.from({ length: 7 }, (_, i) => ({ erpVariantSku: `W-${i}`, color: 'آبی', size: String(i), qty: 1 })),
};
const many = classifyMatrixPushResult({
  ok: true,
  status: 200,
  matched: 0,
  unmatched: wide.variants.map((v) => ({ erpVariantSku: v.erpVariantSku, color: v.color, size: v.size, reason: 'variant_not_found' })),
}, wide);
ok(UNMATCHED_EXAMPLE_LIMIT === 5, 'example limit is 5');
ok(many.unmatchedCount === 7, 'full unmatched count preserved (7)');
ok(many.examples.length === 5, 'examples capped at 5');
ok(many.message.includes('7') && /…/.test(many.message), 'message carries the full count and an ellipsis');

// ── 5) transport failure ⇒ not success, distinct code ───────────────────────
console.log('transport');
const timeout = classifyMatrixPushResult({
  ok: false,
  status: 0,
  reason: 'مهلت ارتباط با API سایت تمام شد (timeout) — دوباره تلاش می‌شود',
  matched: 0,
  unmatched: [],
}, payload);
ok(timeout.ok === false && timeout.status !== 'done', 'transport failure => not success');
ok(timeout.code === 'transport_failed', 'transport failure => code transport_failed');
ok(/timeout|مهلت/.test(timeout.message), 'transport message is the outbound reason');

const derivedOk = classifyMatrixPushResult({ status: 204, matched: 0, unmatched: [] }, payload);
ok(derivedOk.ok === true, 'without ok flag, 2xx status counts as transport ok');
const derivedFail = classifyMatrixPushResult({ status: 500, matched: 0, unmatched: [] }, payload);
ok(derivedFail.ok === false && derivedFail.code === 'transport_failed' && /HTTP 500/.test(derivedFail.message), 'without ok flag, 5xx fails with HTTP code');

const nothing = classifyMatrixPushResult(null, null);
ok(nothing.ok === false && nothing.code === 'transport_failed' && nothing.expected === null, 'null push/payload is never success');

// ── 6) rerun stability + purity ─────────────────────────────────────────────
console.log('idempotency');
const pushJson = JSON.stringify(oneUnmatchedPush);
const payloadJson = JSON.stringify(payload);
const r1 = classifyMatrixPushResult(oneUnmatchedPush, payload);
const r2 = classifyMatrixPushResult(oneUnmatchedPush, payload);
assert.deepStrictEqual(r1, r2);
ok(true, 'rerun on the same payload yields an identical verdict');
ok(JSON.stringify(oneUnmatchedPush) === pushJson && JSON.stringify(payload) === payloadJson, 'classifier does not mutate push or payload (frozen inputs untouched)');
ok(r1.examples !== r2.examples, 'each call returns fresh arrays — no shared mutable state');
r1.examples.push({ label: 'x' });
ok(classifyMatrixPushResult(oneUnmatchedPush, payload).examples.length === 1, 'mutating a verdict does not leak into later calls');

// ── 7) no fuzzy-name merge ──────────────────────────────────────────────────
console.log('no fuzzy merge');
const suggested = classifyMatrixPushResult({
  ok: true,
  status: 200,
  matched: 0,
  unmatched: [{
    erpVariantSku: '7080-BLK-M', color: 'مشکی', size: 'M', reason: 'product_sku_not_found',
    suggestion: { sku: 'SKIRT-SUITS00001', name: 'ست کت و دامن کتان کجراه مدل طنین' },
  }],
}, payload);
ok(suggested.ok === false && suggested.unmatchedCount === 1, 'a near-name suggestion never turns an unmatched row into success');
ok(!JSON.stringify(suggested.examples).includes('SKIRT-SUITS00001'), 'suggestion is not adopted as a mapping');

// ── 8) example formatter fallbacks ──────────────────────────────────────────
console.log('example formatter');
ok(formatUnmatchedExample({ erpVariantSku: 'V-12', reason: 'variant_not_found' }).label === 'V-12', 'no colour/size => SKU label');
ok(formatUnmatchedExample({ reason: 'product_sku_not_found' }).label === 'product_sku_not_found', 'no SKU => reason label');
ok(formatUnmatchedExample(null).label === 'نامشخص', 'garbage => نامشخص');

// ── 9) outbox summary renders the new error rows for the manager ────────────
console.log('outbox summary');
const errRow = summarizeOutboxRow({
  id: 5,
  product_id: 80,
  product_code: '7080',
  product_name: 'کت و دامن کتان طنین',
  channel: 'WHOLESALE',
  status: 'error',
  attempts: 1,
  last_error: oneUnmatched.message,
  last_result: JSON.stringify({
    matched: 2,
    unmatched: oneUnmatchedPush.unmatched,
    status: 200,
    catalogMissing: false,
    unmatchedCount: 1,
    examples: oneUnmatched.examples,
    code: oneUnmatched.code,
    message: oneUnmatched.message,
  }),
});
ok(errRow.statusLabel === 'نیاز به رسیدگی', 'partial-unmatched row is labelled needs attention');
ok(/2 مورد هم‌خوان/.test(errRow.outcome) && /1 مورد/.test(errRow.outcome), 'outcome shows matched · unmatched counts');
ok(errRow.nextStep.length > 10 && errRow.tone === 'warn', 'next step present, tone warn');
ok(errRow.variantHints.includes('سفید / M'), 'variant hint lists the unmatched colour/size');
ok(errRow.unmatched === 1, 'summary exposes the unmatched count');

const settledRow = summarizeOutboxRow({
  id: 6,
  product_id: 63,
  product_code: '7063',
  product_name: 'تاپ لینن',
  channel: 'RETAIL',
  status: 'error',
  attempts: 1,
  last_error: catalog.message,
  last_result: JSON.stringify({
    matched: 0, unmatched: [{ color: 'مشکی', size: 'فری', reason: 'product_sku_not_found' }],
    catalogMissing: true, settled: 'product_sku_not_found',
  }),
});
ok(/سایت پیدا نشد/.test(settledRow.outcome), 'settled catalog-missing row keeps its Persian outcome');
ok(settledRow.statusLabel === 'نیاز به رسیدگی', 'settled catalog-missing row is no longer counted as done');

const pendingRow = summarizeOutboxRow({
  id: 7,
  product_id: 80,
  product_code: '7080',
  product_name: 'کت و دامن کتان طنین',
  channel: 'WHOLESALE',
  status: 'pending',
  attempts: 0,
  last_error: '',
  last_result: JSON.stringify({ matched: 2, unmatched: oneUnmatchedPush.unmatched }),
});
ok(pendingRow.tone === 'wait', 're-enqueued row waits for a fresh verdict instead of re-showing the old one');

console.log(`ALL PASS (${n})`);
