/**
 * پرداخت هزینه — انتخاب‌گر هر سطح کدینگ هزینه، نه فقط معین.
 * بدون better-sqlite3: توابع از app.js استخراج می‌شوند.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const route = fs.readFileSync(path.join(root, 'routes', 'expenses.js'), 'utf8');

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

const src = ['toEnDigits', 'coaIsAutoShell', 'expenseCodingAccount', 'isMoneyField', 'coaSearchKey']
  .map(sliceFn).join('\n');
const fns = new Function(src + `
  return { expenseCodingAccount, isMoneyField, coaSearchKey };
`)();

let n = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  n++;
  console.log('ok', msg);
}

function field(id) {
  return {
    tagName: 'INPUT', id, name: '', value: '',
    classList: { contains: () => false, add() {} },
    hasAttribute: () => false,
    getAttribute: () => '',
  };
}

ok(app.indexOf('function exAcctShow(') < 0, 'old moein-only picker is gone');
ok(app.includes("coaAcctHtml('ex'"), 'expense form uses the shared account combobox');
ok(app.includes("scope:'expense'"), 'expense combobox is scoped to expense coding');
ok(app.includes('data-coa-scope'), 'scope is passed into the search field');
ok(route.includes('explicitExpenseAccount'), 'explicit expense code is validated on the server');
ok(route.includes('E_COA_NOT_EXPENSE'), 'non-expense codes are rejected');
ok(!/function expenseCodingAccount[\s\S]{0,500}coaIsAutoShell\(/.test(app), 'expense picker does not reuse the tafsili-shell predicate');

ok(fns.isMoneyField(field('ex-account-search')) === false, 'expense account search is not a money field');
ok(fns.expenseCodingAccount({ code: '6', name: 'هزینه', type: 'expense', is_active: 1 }), 'group is selectable');
ok(fns.expenseCodingAccount({ code: '6000', name: 'کل', type: 'expense', parent_code: '6', is_active: 1 }), 'kol is selectable');
ok(fns.expenseCodingAccount({ code: '6102', name: 'معین', type: 'expense', parent_code: '6000', is_active: 1 }), 'moein is selectable');
ok(fns.expenseCodingAccount({ code: '610277', name: 'تفصیلی', type: 'expense', parent_code: '6102', is_active: 1 }), 'tafsili is selectable');
ok(fns.expenseCodingAccount({ code: '610201', name: 'هزینه پیک و پست', type: 'expense', parent_code: '6102', is_active: 1 }), 'first moein 610201 is a real expense account');
ok(fns.expenseCodingAccount({ code: '610301', name: 'سوشال مدیا', type: 'expense', parent_code: '6103', is_active: 1 }), 'first moein 610301 is selectable');
ok(fns.expenseCodingAccount({ code: '610302', name: 'تبلیغات', type: 'expense', parent_code: '6103', is_active: 1 }), 'later moein 610302 stays selectable');
ok(fns.expenseCodingAccount({ code: '610307', name: 'بسته بندی', type: 'expense', parent_code: '6103', is_active: 1 }), 'later moein 610307 stays selectable');
ok(fns.expenseCodingAccount({ code: '210101', name: 'حساب‌های پرداختنی', type: 'liability', parent_code: '2101', is_active: 1 }) === false, 'control bridge is not an expense account');
ok(fns.expenseCodingAccount({ code: '1101', name: 'صندوق', type: 'asset', parent_code: '1100', is_active: 1 }) === false, 'asset account is hidden');
ok(fns.expenseCodingAccount({ code: '6198', name: 'خاموش', type: 'expense', is_active: 0 }) === false, 'inactive expense is hidden');
ok(fns.coaSearchKey('هزينه ۶۱۰۲') === fns.coaSearchKey('هزینه 6102'), 'arabic yeh and persian digits match');

console.log('\n' + n + ' passed');
