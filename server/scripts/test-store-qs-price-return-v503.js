/**
 * v503 — فروش سریع: فی دستی پایدار + برگشت کامل / استرداد وجه
 * Run: node server/scripts/test-store-qs-price-return-v503.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

console.log('\n══ Store QS price + full return v503 ══\n');

const root = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const storeSrc = fs.readFileSync(path.join(root, 'routes/store.js'), 'utf8');
const captureSrc = fs.readFileSync(path.join(root, 'sync/capture.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const idxSrc = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

// --- price bug contract ---
ok(/unit_price=Math\.max\(0,moneyParseInput\(this\)\)/.test(appSrc), 'storeQs price uses moneyParseInput');
ok(!/replace\(\/\[\^\\\\d\]\/g/.test(appSrc) || !/storeQs\.lines\[idx\]\.unit_price=Math\.max\(0,fromInputAmount\(parseInt/.test(appSrc),
  'no digit-stripping regex on storeQs unit_price');
ok(!/storeQs\.lines\[idx\]\.unit_price=Math\.max\(0,fromInputAmount\(parseInt/.test(appSrc),
  'no fromInputAmount(parseInt...) on storeQs price');

// Simulate the old buggy regex vs moneyParseInput path
const sample = '12,700,000';
const buggy = sample.replace(/[^\\d]/g, '');
ok(buggy === '', 'baseline: /[^\\\\d]/ strips digits (known bug)');
const digits = sample.replace(/[^\d]/g, '');
ok(digits === '12700000', 'correct strip keeps digits');

// --- return-only UI ---
ok(appSrc.includes('/store/quick-return'), 'UI posts quick-return');
ok(appSrc.includes("returnOnly") && appSrc.includes('ثبت برگشت کامل + استرداد وجه'), 'return-only checkout label');
ok(appSrc.includes('برگشت کامل'), 'برگشت کامل button');
ok(appSrc.includes('استرداد کامل از صندوق'), 'full refund summary label');
ok(appSrc.includes('خالی = فقط برگشت'), 'optional replacement basket hint');

// --- API ---
ok(storeSrc.includes("router.post('/quick-return'"), 'POST /store/quick-return');
ok(storeSrc.includes("settlement_case: 'return_only'"), 'return_only settlement case');
ok(storeSrc.includes('postStoreExchangeRefund'), 'refund posts via postStoreExchangeRefund');
ok(storeSrc.includes('voidSalesReturn'), 'rollback voids return on failure');

// --- sync hygiene ---
ok(captureSrc.includes("'/api/store/quick-return', 'sales_returns'"), 'capture maps quick-return → sales_returns');
ok(captureSrc.indexOf("'/api/store/quick-return'") < captureSrc.indexOf("'/api/store/quick-exchange'"),
  'quick-return mapped before quick-exchange');

// --- help + SW ---
ok(appSrc.includes('بدون سبد جایگزین') || appSrc.includes('فقط برگشت (بدون سبد جایگزین)'), 'admin help return-only');
ok(appSrc.includes('فی سطر را دستی عوض کنید') || appSrc.includes('جداکننده هزارگان حفظ می‌شود'), 'help mentions price edit');
ok(swSrc.includes('erp-taranom-v503'), 'SW v503');
ok(idxSrc.includes('app.js?v=503'), 'index app.js?v=503');

try {
  // eslint-disable-next-line no-new-func
  new Function(appSrc);
  ok(true, 'app.js parses');
} catch (e) {
  ok(false, 'app.js parses', e && e.message);
}

console.log(`\n══ Result: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail ? 1 : 0);
