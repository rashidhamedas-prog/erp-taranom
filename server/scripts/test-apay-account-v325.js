/**
 * پرداخت به حساب — جستجو دیگر مبلغ فرض نمی‌شود و هر حساب فعال قابل انتخاب است.
 * بدون better-sqlite3: توابع فرانت از app.js استخراج می‌شوند.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const route = fs.readFileSync(path.join(root, 'routes', 'accounting.js'), 'utf8');

function sliceFn(name) {
  const start = app.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing ' + name);
  let i = app.indexOf('{', start);
  let depth = 0;
  for (; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}') {
      depth--;
      if (depth === 0) return app.slice(start, i + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

const src = [
  sliceFn('toEnDigits'),
  sliceFn('isMoneyField'),
  sliceFn('formatMoneyInput'),
  sliceFn('coaSearchKey'),
  sliceFn('coaSearchRank'),
].join('\n');
const fns = new Function(src + `
  return { toEnDigits, isMoneyField, formatMoneyInput, coaSearchKey, coaSearchRank };
`)();

function field(id, extra) {
  const opt = extra || {};
  const classes = new Set(opt.cls || []);
  return {
    tagName: 'INPUT',
    id,
    name: opt.name || '',
    value: opt.value || '',
    selectionStart: (opt.value || '').length,
    classList: { contains: (c) => classes.has(c), add() {} },
    hasAttribute: (n) => !!(opt.attr && opt.attr[n]),
    getAttribute: (n) => (opt.attr && opt.attr[n]) || '',
    setSelectionRange() {},
  };
}

let n = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  n++;
  console.log('ok', msg);
}

function applyMoney(elm) {
  if (fns.isMoneyField(elm)) fns.formatMoneyInput(elm);
}

const search = field('apay-account-search', { cls: ['money'], value: 'صندوق' });
ok(fns.isMoneyField(search) === false, 'account search is not money even with class money');
applyMoney(search);
ok(search.value === 'صندوق', 'a name typed in the search is not stripped');

const code = field('apay-account-search', { value: '1103' });
ok(fns.isMoneyField(code) === false, 'numeric account search is not money');
applyMoney(code);
ok(code.value === '1103', 'account code is not thousand-separated');

const note = field('apay-note', { value: 'بابت پارچه' });
ok(fns.isMoneyField(note) === false, 'payment note is not money');
applyMoney(note);
ok(note.value === 'بابت پارچه', 'payment note text is kept');
ok(fns.isMoneyField(field('apay-date')) === false, 'payment date is not money');
ok(fns.isMoneyField(field('apay-amount', { value: '1500000' })) === true, 'payment amount stays money');
ok(fns.isMoneyField(field('apay-fee', { value: '20000' })) === true, 'bank fee stays money');
ok(fns.isMoneyField(field('arr-account-search')) === false, 'receipt search is not money');

const amount = field('apay-amount', { cls: ['money'], value: '1500000' });
fns.formatMoneyInput(amount);
ok(amount.value === '1,500,000', 'real amount still gets separators');

ok(fns.coaSearchKey('صندوق') === fns.coaSearchKey('صندوق'), 'same name folds to itself');
ok(fns.coaSearchKey('علي') === fns.coaSearchKey('علی'), 'arabic yeh matches persian yeh');
ok(fns.coaSearchKey('كالا') === fns.coaSearchKey('کالا'), 'arabic kaf matches persian kaf');
ok(fns.coaSearchKey('۱۱۰۳') === '1103', 'persian digits fold to latin');
ok(fns.coaSearchKey('١١٠٣') === '1103', 'arabic digits fold to latin');

const parent = { code: '6100', name: 'هزینه‌ها' };
const leaf = { code: '6102', name: 'هزینه اداری' };
ok(fns.coaSearchRank(parent, '6100') === 0, 'exact code ranks first');
ok(fns.coaSearchRank(leaf, '610') === 1, 'code prefix ranks above a loose name');
ok(fns.coaSearchRank({ code: '1103', name: 'حسابهای دریافتنی' }, fns.coaSearchKey('دريافتنی')) < 4,
  'normalized name still matches');

const pay = route.slice(route.indexOf("router.post('/account-payments'"), route.indexOf("router.post('/account-receipts'"));
ok(pay.includes('assertActiveAccount'), 'payment route accepts any active account');
ok(!pay.includes('assertPostableAccount'), 'payment route no longer requires a leaf');
const recv = route.slice(route.indexOf("router.post('/account-receipts'"), route.indexOf('function mirrorAccountVoucherToPartyBooks'));
ok(recv.includes('assertPostableAccount'), 'receipt route still requires a leaf');
ok(app.includes("coaAcctHtml('apay'"), 'payment modal still uses the account picker');
ok(app.includes('{any:true}'), 'payment picker is the any-account mode');
ok(app.includes("data-coa-any=\"${any?'1':'0'}\""), 'scope flag is on the search input');
ok(!app.includes('class="cust-si-drop" id="${prefix}-acct-drop"') && app.includes('class="coa-acct-drop"'),
  'payment dropdown is not the customer dropdown that closes on any click');

console.log('PASS', n);
