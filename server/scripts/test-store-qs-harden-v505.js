/**
 * v505 — فروش سریع: فی خالی→قبلی، بدون focus-steal، R13 void استرداد
 * Run: node server/scripts/test-store-qs-harden-v505.js
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

console.log('\n══ Store QS harden v505 ══\n');

const root = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const storeLib = fs.readFileSync(path.join(root, 'lib/store-quick-sale.js'), 'utf8');
const srDoc = fs.readFileSync(path.join(root, 'lib/sales-return-doc.js'), 'utf8');
const storeRt = fs.readFileSync(path.join(root, 'routes/store.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const idxSrc = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

// --- UX: empty price keeps previous ---
ok(/if\(!raw\)\{this\.value=moneyInit\(_storeQs\.lines\[idx\]\.unit_price/.test(appSrc),
  'empty فی restores previous unit_price');
ok(/storeQsRenderBody\(\{keepFocus:true\}\)/.test(appSrc), 'cart edits pass keepFocus');
ok(/function storeQsRenderBody\(opts\)/.test(appSrc), 'renderBody accepts opts');
ok(/if\(!opts\.keepFocus\)/.test(appSrc), 'scan focus gated by keepFocus');
ok(!/id="storeQsScan"[^>]*autofocus/.test(appSrc), 'storeQsScan has no autofocus');

// discPct + return qty on change (not input wipe)
ok(/تخفیف کل ٪[\s\S]{0,200}data-csp-change=/.test(appSrc), 'discPct uses change');
ok(!/تخفیف کل ٪[\s\S]{0,200}data-csp-input=/.test(appSrc), 'discPct not on input');
ok(/qty_return=v;[\s\S]{0,80}storeQsRenderBody\(\{keepFocus:true\}\)/.test(appSrc),
  'return qty change + keepFocus');

// return-only UI still intact
ok(appSrc.includes('ثبت برگشت کامل + استرداد وجه'), 'return-only checkout label');
ok(appSrc.includes('>برگشت کامل<') || appSrc.includes('}>برگشت کامل</button>'), 'برگشت کامل button');
ok(appSrc.includes('/store/quick-return'), 'UI posts quick-return');

// --- R13 void refund ---
ok(/function voidStoreExchangeRefund/.test(storeLib), 'voidStoreExchangeRefund defined');
ok(/function storeExchangeRefundSourceId/.test(storeLib), 'numeric source id helper');
ok(/voidStoreExchangeRefund\(db,\s*\{[\s\S]*returnId:\s*row\.id/.test(srDoc),
  'reverseSalesReturnEffects voids store refund');
ok(/returnId:\s*retOut\.id/.test(storeRt), 'quick-return/exchange pass returnId');

// --- help + SW ---
ok(appSrc.includes('قیمت قبلی می‌ماند') || appSrc.includes('خالی‌گذاشتن فیلد'), 'help empty price');
ok(appSrc.includes('store_exchange_refund') && appSrc.includes('soft-void'), 'help R13 refund void');
ok(swSrc.includes('erp-taranom-v505'), 'SW v505');
ok(idxSrc.includes('app.js?v=505'), 'index app.js?v=505');

try {
  // eslint-disable-next-line no-new-func
  new Function(appSrc);
  ok(true, 'app.js parses');
} catch (e) {
  ok(false, 'app.js parses', e && e.message);
}

console.log(`\n══ Result: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail ? 1 : 0);
