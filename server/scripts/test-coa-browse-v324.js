/**
 * کدهای حسابداری: تفصیلی زنده زیر معین ۴رقمی، بدون نمایش پوستهٔ ۶رقمی.
 * Run: node server/scripts/test-coa-browse-v324.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { tafsiliUnderMoin, tafsiliCreateParent } = require('../lib/coa-browse');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra != null ? extra : ''); }
}

const tree = [
  { code: '2000', name: 'بدهی‌ها', parent_code: null, level: 1, type: 'liability' },
  { code: '2100', name: 'بدهی‌های جاری', parent_code: '2000', level: 2, type: 'liability' },
  { code: '2101', name: 'حساب‌های پرداختنی', parent_code: '2100', level: 2, type: 'liability' },
  { code: '210101', name: 'حساب‌های پرداختنی', parent_code: '2101', level: 3, type: 'liability' },
  { code: '210101000001', name: 'پارچه مشهد', parent_code: '210101', level: 4, type: 'liability', tafsili_type: 'اشخاص' },
  { code: '210101000002', name: 'دکمه آسیا', parent_code: '210101', level: 4, type: 'liability', tafsili_type: 'اشخاص' },
  { code: '2103', name: 'مالیات بر ارزش افزوده پرداختنی', parent_code: '2100', level: 2, type: 'liability' },
  { code: '1000', name: 'دارایی‌ها', parent_code: null, level: 1, type: 'asset' },
  { code: '1100', name: 'دارایی‌های جاری', parent_code: '1000', level: 2, type: 'asset' },
  { code: '1102', name: 'موجودی بانک', parent_code: '1100', level: 2, type: 'asset' },
  { code: '110201', name: 'موجودی بانک', parent_code: '1102', level: 3, type: 'asset' },
  { code: '110201000004', name: 'ملت ۹۹۵۵', parent_code: '110201', level: 4, type: 'asset', tafsili_type: 'بانک ها' },
  { code: '1102-9', name: 'بانک قدیمی', parent_code: '1102', level: 0, type: 'asset' },
  { code: '1103', name: 'حساب‌های دریافتنی', parent_code: '1100', level: 2, type: 'asset' },
  { code: '110301', name: 'حساب‌های دریافتنی', parent_code: '1103', level: 3, type: 'asset' },
  { code: '110301000007', name: 'بوتیک نیلوفر', parent_code: null, level: 4, type: 'asset', tafsili_type: 'اشخاص' },
  { code: '6000', name: 'هزینه‌ها', parent_code: null, level: 1, type: 'expense' },
  { code: '6102', name: 'هزینه‌های عمومی و اداری', parent_code: '6000', level: 2, type: 'expense' },
  { code: '610201', name: 'پوسته', parent_code: '6102', level: 3, type: 'expense' },
  { code: '610204', name: 'اجاره', parent_code: '6102', level: 2, type: 'expense' },
  { code: '206001000088', name: 'بانک محک', parent_code: '206001', level: 4, type: 'asset' },
];

const pay = tafsiliUnderMoin(tree, '2101').map((a) => a.code);
ok(pay.includes('210101000001') && pay.includes('210101000002'), 'supplier tafsili under 2101', pay.join(','));
ok(!pay.includes('210101'), 'shell 210101 is not a تفصیلی', pay.join(','));
ok(!pay.includes('2101') && !pay.includes('2103'), 'control accounts stay out of تفصیلی', pay.join(','));

ok(tafsiliUnderMoin(tree, '2103').length === 0, 'VAT payable stays a leaf معین');

const bank = tafsiliUnderMoin(tree, '1102').map((a) => a.code);
ok(bank.includes('110201000004') && bank.includes('1102-9'), 'bank tafsili and legacy 1102-id', bank.join(','));
ok(!bank.includes('110201'), 'bank shell hidden', bank.join(','));
ok(!bank.includes('206001000088'), 'Mahak 206001 is not pulled under 1102', bank.join(','));

const recv = tafsiliUnderMoin(tree, '1103').map((a) => a.code);
ok(recv.includes('110301000007'), 'customer with broken parent still shows under 1103', recv.join(','));
ok(!recv.includes('110301'), 'receivable shell hidden');

const exp = tafsiliUnderMoin(tree, '6102').map((a) => a.code);
ok(exp.includes('610204'), 'real 6-digit expense child shows', exp.join(','));
ok(!exp.includes('610201'), 'auto shell 610201 hidden', exp.join(','));

ok(tafsiliCreateParent(tree, '2101') === '210101', 'new تفصیلی is created under the shell');
ok(tafsiliCreateParent(tree, '2103') === '2103', 'leaf معین has no shell parent');

const inactive = tafsiliUnderMoin([
  { code: '2101', name: 'حساب‌های پرداختنی', parent_code: '2100' },
  { code: '210101000009', name: 'حذف‌شده', parent_code: '210101', level: 4, is_active: 0 },
], '2101');
ok(inactive.length === 0, 'inactive tafsili hidden');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(appJs.includes('function coaTafsiliUnder(accounts, moinCode)'), 'chart page uses the same تفصیلی walk');
ok(appJs.includes("c===m+'01'"), 'chart page hides the 6-digit shell');
ok(appJs.includes('coaTafsiliUnder(accounts, col.parent)'), 'تفصیلی column is not direct-parent only');

console.log(fail ? `\n${fail} failed, ${pass} passed` : `\n${pass} passed`);
process.exit(fail ? 1 : 0);
