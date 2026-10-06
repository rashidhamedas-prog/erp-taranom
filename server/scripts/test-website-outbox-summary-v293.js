'use strict';
/**
 * v293 — human outbox summary for website stock queue.
 * node server/scripts/test-website-outbox-summary-v293.js
 */
const assert = require('assert');
const { summarizeOutboxRow } = require('../lib/website-stock-sync');

let n = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  n += 1;
  console.log('  PASS', msg);
}

const catalog = summarizeOutboxRow({
  id: 21,
  product_id: 11,
  product_code: 'K-00011',
  product_name: 'شومیز کتان',
  channel: 'WHOLESALE',
  status: 'done',
  attempts: 1,
  last_error: '',
  last_result: JSON.stringify({
    matched: 0,
    unmatched: [
      { color: 'مشکی', size: 'فری', reason: 'product_sku_not_found' },
      { color: 'سفید', size: 'فری', reason: 'product_sku_not_found' },
    ],
  }),
});
ok(catalog.productLabel.includes('شومیز کتان') && catalog.productLabel.includes('K-00011'), 'product label has name+code');
ok(catalog.channelLabel === 'سایت عمده', 'wholesale channel Persian');
ok(catalog.outcome.includes('سایت پیدا نشد'), 'catalog-missing outcome in Persian');
ok(catalog.nextStep.length > 10, 'next step guidance present');
ok(!/unmatched|WHOLESALE|product_sku/i.test(catalog.outcome), 'outcome avoids raw jargon');
ok(catalog.variantHints.length === 2, 'variant hints for colors/sizes');

const timeout = summarizeOutboxRow({
  id: 60,
  product_id: 168,
  product_code: 'X-1',
  product_name: 'مانتو',
  channel: 'RETAIL',
  status: 'pending',
  attempts: 4,
  last_error: 'مهلت ارتباط با API سایت تمام شد (timeout) — دوباره تلاش می‌شود',
  last_result: '',
});
ok(timeout.channelLabel === 'سایت خرده‌فروشی', 'retail channel Persian');
ok(/به‌موقع|پاسخ سایت/.test(timeout.outcome), 'timeout outcome Persian');
ok(timeout.tone === 'warn' || timeout.tone === 'bad', 'timeout tone warn/bad');

const okRow = summarizeOutboxRow({
  id: 1,
  product_id: 2,
  product_code: 'OK-1',
  product_name: 'تیشرت',
  channel: 'RETAIL',
  status: 'done',
  attempts: 1,
  last_error: '',
  last_result: JSON.stringify({ matched: 3, unmatched: [] }),
});
ok(/به‌روز|انجام/.test(okRow.outcome), 'success outcome');
ok(okRow.tone === 'ok', 'success tone ok');
ok(okRow.cause === 'ok', 'success cause ok');
ok(catalog.cause === 'catalog', 'catalog cause is the site SKU dependency');
ok(timeout.cause === 'site', 'timeout cause is the site API dependency');

const http503 = summarizeOutboxRow({
  id: 9,
  product_id: 44,
  product_code: '7200',
  product_name: 'کابشن معمولی یلدا',
  channel: 'RETAIL',
  status: 'pending',
  attempts: 3,
  last_error: 'HTTP 503',
  last_result: '',
});
ok(http503.cause === 'site', 'HTTP 503 is a site dependency, not a missing SKU');
ok(http503.statusLabel === 'در صف ارسال', '503 while pending stays in the queue');
ok(/جواب نداد/.test(http503.outcome) && /503/.test(http503.outcome), '503 outcome is Persian and keeps the code');
ok(!/^HTTP 503$/.test(http503.outcome), '503 is not shown as a raw status line');
ok(/کد کالا را برای این خطا نسازید|نه به کد کالا/.test(http503.nextStep), '503 next step does not send the operator to create a SKU');

const variant = summarizeOutboxRow({
  id: 10,
  product_id: 55,
  product_code: '7136',
  product_name: 'مانتو',
  channel: 'WHOLESALE',
  status: 'error',
  attempts: 2,
  last_error: '',
  last_result: JSON.stringify({
    matched: [{ color: 'مشکی', size: 'فری' }],
    unmatched: [{ color: 'شتری', size: 'فری', reason: 'color_mismatch' }],
    onSite: ['کرم تیره', 'کرم'],
  }),
});
ok(variant.cause === 'variant', 'partial color mismatch is the variant dependency');
ok(/هم‌خوان/.test(variant.outcome), 'variant outcome counts matches');
ok(/کرم تیره/.test(variant.nextStep), 'variant next step quotes on-site colors');

const auth = summarizeOutboxRow({
  id: 11,
  product_id: 1,
  product_code: '1',
  product_name: 'تست',
  channel: 'RETAIL',
  status: 'error',
  attempts: 1,
  last_error: 'HTTP 401',
  last_result: '',
});
ok(auth.cause === 'auth', '401 is the saved API key, not the product');
ok(/کلید/.test(auth.outcome), '401 outcome names the key');

console.log(`ALL PASS (${n})`);
