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

console.log(`ALL PASS (${n})`);
