'use strict';
/**
 * v546 — مبلغ پرداخت فاکتور > مبلغ سند (RCA #3: buildRows قیمت کلاینت را برای variant بازنویسی می‌کرد).
 * اجرا: node server/scripts/test-invoice-pay-totals-v546.js
 */
const fs = require('fs');
const path = require('path');
const { swAtLeast } = require('./lib/sw-at-least');

let pass = 0;
let fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg, extra !== undefined ? extra : ''); }
}
function throwsWith(fn, pred, msg) {
  try { fn(); ok(false, msg + ' (خطا نیامد)'); }
  catch (e) { ok(pred(e), msg, e && e.message); }
}

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const { parseMoneyRial, computeInvoiceTotals, formatRial } = require('../lib/invoice-totals');
const { resolveCashPaid } = require('../lib/cash-on-document');
const { resolveInvoicePayments } = require('../lib/invoice-payments');
const { freightChargedToCounterparty } = require('../lib/sales-document');

console.log('— parseMoneyRial');
ok(parseMoneyRial('۱٬۲۳۴٬۵۶۷') === 1234567, 'ارقام فارسی + جداکنندهٔ ٬');
ok(parseMoneyRial('1,234,567') === 1234567, 'کاما لاتین');
ok(parseMoneyRial('١٢٣ ٤٥٦') === 123456, 'ارقام عربی + فاصله');
ok(parseMoneyRial(' 12 345 ') === 12345, 'فاصله‌ها حذف می‌شود');
ok(parseMoneyRial('1234.6') === 1235, 'گرد به ریال صحیح');
ok(parseMoneyRial(null) === 0 && parseMoneyRial('') === 0 && parseMoneyRial(undefined) === 0, 'خالی → ۰');
ok(parseMoneyRial('abc') === 0, 'غیراستریکت: نامعتبر → ۰');
throwsWith(() => parseMoneyRial('abc', { strict: true }), (e) => e.code === 'E_MONEY_INVALID', 'strict: نامعتبر خطا');
throwsWith(() => parseMoneyRial('-5', { strict: true }), (e) => e.code === 'E_MONEY_INVALID', 'strict: منفی خطا');
throwsWith(() => parseMoneyRial(NaN, { strict: true }), (e) => e.status === 400, 'strict: NaN خطا');
ok(parseMoneyRial('۱۰۰٫۴', { strict: true }) === 100, 'strict: ممیز عربی معتبر');

console.log('— computeInvoiceTotals');
{
  const t = computeInvoiceTotals({
    items: [{ qty: 2, price: 1000000 }, { qty: 1, price: 500000, disc: 10 }],
    discPct: 0, vatExempt: true,
  });
  ok(t.subtotal === 2450000 && t.payable === 2450000 && t.vatAmount === 0, 'بدون مالیات/تخفیف سربرگ', JSON.stringify(t));
}
{
  const t = computeInvoiceTotals({
    items: [{ qty: 1, price: 1000000, disc_amount: 100000 }],
    discAmt: 90000, vatExempt: false, vatRate: 10,
  });
  // sub=900000; disc=90000 → base 810000 → vat 81000 → 891000
  ok(t.subtotal === 900000 && t.discAmt === 90000 && t.vatAmount === 81000 && t.payable === 891000, 'تخفیف ردیف + سربرگ + مالیات ۱۰٪', JSON.stringify(t));
}
{
  const t = computeInvoiceTotals({
    items: [{ qty: 1, price: 1000000, product_id: 1 }, { qty: 1, price: 1000000, product_id: 2 }],
    discPct: 10, vatExempt: false, vatRate: 10,
    lineIsVatExempt: (it) => it.product_id === 2,
  });
  // sub=2,000,000; disc=200,000; taxable=1,000,000*(0.9)=900,000 → vat 90,000 → 1,890,000
  ok(t.discAmt === 200000 && t.vatAmount === 90000 && t.payable === 1890000, 'ردیف معاف از مالیات + تخفیف درصدی', JSON.stringify(t));
}
{
  const buyer = computeInvoiceTotals({ items: [{ qty: 1, price: 100000 }], vatExempt: true, freightAmount: 25000, freightType: 'buyer' });
  const unspec = computeInvoiceTotals({ items: [{ qty: 1, price: 100000 }], vatExempt: true, freightAmount: 25000, freightType: '' });
  const seller = computeInvoiceTotals({ items: [{ qty: 1, price: 100000 }], vatExempt: true, freightAmount: 25000, freightType: 'seller' });
  ok(buyer.freightCharged === 25000 && buyer.payable === 125000, 'کرایه خریدار به قابل پرداخت اضافه می‌شود');
  ok(unspec.payable === 125000, 'کرایهٔ بدون نوع = مثل sales-document (طرف حساب)');
  ok(seller.freightCharged === 0 && seller.payable === 100000, 'کرایه فروشنده اضافه نمی‌شود');
  ok(freightChargedToCounterparty('seller') === false && freightChargedToCounterparty('buyer') === true, 'هم‌راستا با freightChargedToCounterparty');
}
{
  const t = computeInvoiceTotals({ items: [{ qty: 0.5, price: 333333 }], vatExempt: true });
  ok(Number.isInteger(t.subtotal) && t.subtotal === 166667, 'ریال صحیح (گرد ردیف)', t.subtotal);
}
ok(formatRial(1234567) === '1,234,567', 'formatRial');

console.log('— پیام خطای سرور شامل هر دو مبلغ');
throwsWith(
  () => resolveCashPaid({ pay_type: 'pos_card', pay_amount: 1200000 }, 1000000),
  (e) => e.code === 'E_CASH_OVER_INVOICE' && e.message === 'مبلغ پرداخت (1,200,000) از مبلغ سند (1,000,000) بیشتر است' && e.paid === 1200000 && e.final === 1000000,
  'resolveCashPaid: مبلغ پرداخت (X) از مبلغ سند (Y)'
);
throwsWith(
  () => resolveInvoicePayments({ pay_splits: [{ pay_type: 'bank_transfer', amount: 600000, bank_id: 1 }, { pay_type: 'bank_transfer', amount: 600000, bank_id: 1 }] }, 1000000),
  (e) => e.code === 'E_PAY_SPLIT_OVER' && /\(1,200,000\)/.test(e.message) && /\(1,000,000\)/.test(e.message),
  'assertSplits: هر دو مبلغ در پیام'
);
{
  const r = resolveCashPaid({ pay_type: 'pos_card', pay_amount: 1000000 }, 1000000);
  ok(r.paid === 1000000 && r.remainder === 0, 'برابر سند مجاز است');
}

console.log('— invoices.js buildRows (E)');
const invSrc = read('routes/invoices.js');
ok(/clientPriceGiven\s*=\s*\(parseFloat\(r\.price\)\s*\|\|\s*0\)\s*>\s*0/.test(invSrc), 'clientPriceGiven تعریف شده');
ok(/if\s*\(earlyVariantId\s*&&\s*!clientPriceGiven\)/.test(invSrc), 'unitPriceRialForVariant فقط وقتی قیمت کلاینت خالی/۰');

console.log('— app.js (B/C)');
const appSrc = read('public/app.js');
ok(/function computeInvoiceTotals\(/.test(appSrc) && /function parseMoneyRial\(/.test(appSrc), 'آینهٔ کلاینت computeInvoiceTotals/parseMoneyRial');
ok(/invTotalsFor\(discAmt,\s*false\)/.test(appSrc) && /tot\.payable/.test(appSrc), 'renderCart از computeInvoiceTotals');
ok(/payableNow\s*=\s*invTotalsFor\(/.test(appSrc), 'saveInvoice مبلغ قابل پرداخت را دوباره حساب می‌کند');
ok(/amountTouched=true/.test(appSrc), 'amountTouched روی ردیف چندمرحله‌ای');
ok(/data-user-edited|dataset\.userEdited/.test(appSrc), 'userEdited روی فیلد تک‌پرداخت');
{
  const m = appSrc.match(/function syncInvCashPayAmount\(\)\{[\s\S]*?\n\}\n/);
  ok(!!m, 'syncInvCashPayAmount پیدا شد');
  const body = m ? m[0] : '';
  ok(!/pt==='cash'\s*\|\|\s*empty/.test(body), 'دیگر فقط cash/خالی را همگام نمی‌کند (pos_card هم)');
  ok(/if\(!touched\)/.test(body) && /=== ?final|!==final/.test(body), 'دست‌نخورده → برابر final برای همهٔ انواع');
  ok(/مبلغ پرداخت به سقف فاکتور اصلاح شد/.test(body), 'هشدار زرد کلَمپ');
}
ok(/function invPayRefreshGuard\(/.test(appSrc) && /b\.disabled=block/.test(appSrc), 'چندمرحله‌ای: ذخیره غیرفعال هنگام مازاد');
ok(/id="inv-multi-err"/.test(appSrc) && /id="inv-pay-err"/.test(appSrc) && /id="inv-pay-warn"/.test(appSrc), 'عناصر خطا/هشدار درون‌خطی');
ok(/invPayFieldError\(/.test(appSrc) && /scrollIntoView/.test(appSrc), 'highlight + scroll روی خطا');
ok(/renderInvReceiptLedgerCore/.test(appSrc), 'ledger → guard');
ok(/<b>مبلغ پرداخت و سقف فاکتور \(v547\):<\/b>/.test(appSrc) && /مبلغ پرداخت فاکتور \(v547\)/.test(appSrc), 'Help admin + sales');

console.log('— همخوانی آینهٔ کلاینت با سرور');
{
  const a = appSrc.indexOf('function parseMoneyRial(');
  const b = appSrc.indexOf('function lineVatClassExempt(');
  const f = appSrc.indexOf('function freightTypeIsSeller(');
  const fEnd = appSrc.indexOf('function allocateFreightShares(');
  ok(a > 0 && b > a && f > 0 && fEnd > f, 'برش کد کلاینت');
  const code = appSrc.slice(f, fEnd) + appSrc.slice(a, b) + '\nreturn {parseMoneyRial, computeInvoiceTotals};';
  const client = new Function(code)();
  const cases = [
    { items: [{ qty: 3, price: 1250000, disc: 5 }, { qty: 2, price: 777777 }], discPct: 3, vatExempt: false, vatRate: 10, freightAmount: 40000, freightType: 'buyer' },
    { items: [{ qty: 1.5, price: 999999, disc_amount: 12345 }], discAmt: 0, vatExempt: false, vatRate: 9 },
    { items: [{ qty: 4, price: 55555 }], discAmt: 1000, vatExempt: true, freightAmount: 9000, freightType: 'seller' },
    { items: [{ qty: 2, price: 100000, disc: 100 }, { qty: 1, price: 1 }], discPct: 50, vatExempt: false, vatRate: 10 },
  ];
  cases.forEach((c, i) => {
    const s = computeInvoiceTotals(c);
    const k = client.computeInvoiceTotals(c);
    ok(JSON.stringify(s) === JSON.stringify(k), 'کلاینت = سرور (مورد ' + (i + 1) + ')', JSON.stringify([s, k]));
  });
  ok(client.parseMoneyRial('۱٬۲۳۴') === 1234 && client.parseMoneyRial('x') === 0, 'parseMoneyRial کلاینت');
}

console.log('— سناریوی RCA #3 (ماتریس: قیمت کلاینت ≠ ماتریس) — اجرای واقعی buildRows با db ساختگی');
{
  const a = invSrc.indexOf('function buildRows(');
  const b = invSrc.indexOf('function resolveRowWarehouseId(');
  ok(a > 0 && b > a, 'برش buildRows');
  const fakeDb = {
    prepare: () => ({ get: () => ({ id: 7, name: 'شنل', price: 800000, vat_class: 'standard' }) }),
  };
  const matrixPrice = 900000; // قیمت ماتریس سرور
  const fakeRequire = (m) => {
    if (m === '../lib/inventory/pack-unit-price') return { unitPriceRialForVariant: () => matrixPrice };
    if (m === '../lib/product-variants') return { getVariant: () => ({ product_id: 7, color_id: 1, size_id: 2, color_name: 'مشکی', size_name: 'M' }) };
    return require(m);
  };
  const buildRows = new Function('parseQty', 'resolveProductCode', 'require', invSrc.slice(a, b) + '\nreturn buildRows;')(
    (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; },
    () => 'SKU-1',
    fakeRequire
  );
  const withPrice = buildRows(fakeDb, [{ product_id: 7, variant_id: 3, qty: 1, price: 1000000 }], true);
  ok(withPrice.rows[0].price === 1000000 && withPrice.subtotal === 1000000, 'قیمت صریح کلاینت با variant_id حفظ می‌شود', JSON.stringify(withPrice.rows[0].price));
  const noPrice = buildRows(fakeDb, [{ product_id: 7, variant_id: 3, qty: 1 }], true);
  ok(noPrice.rows[0].price === matrixPrice, 'قیمت خالی → از ماتریس');
  const zeroPrice = buildRows(fakeDb, [{ product_id: 7, variant_id: 3, qty: 1, price: 0 }], true);
  ok(zeroPrice.rows[0].price === matrixPrice, 'قیمت ۰ → از ماتریس');
  const client = computeInvoiceTotals({ items: [{ qty: 1, price: 1000000 }], vatExempt: true });
  let threw = false;
  try { resolveCashPaid({ pay_type: 'pos_card', pay_amount: client.payable }, withPrice.subtotal); } catch (_) { threw = true; }
  ok(!threw, 'pay_amount = payable کلاینت ⇒ final سرور (buildRows) برابر ⇒ بدون خطا');
}

console.log('— SW / index / CHANGE-LOG');
const sw = read('public/sw.js');
ok(swAtLeast(sw, 547), 'SW ≥ v547');
const idx = read('public/index.html');
ok(/app\.js\?v=547/.test(idx) && /app\.css\?v=547/.test(idx), 'index.html ?v=547');
ok(/v547/.test(read('../docs/CHANGE-LOG.md')) && /RCA/.test(read('../docs/CHANGE-LOG.md')), 'CHANGE-LOG v547 + RCA');

console.log('— پارس app.js');
try { new Function(appSrc); ok(true, 'app.js بدون خطای نحوی'); }
catch (e) { ok(false, 'app.js خطای نحوی', e.message); }

console.log(`\nنتیجه: ${pass} پاس، ${fail} شکست`);
process.exit(fail ? 1 : 0);
