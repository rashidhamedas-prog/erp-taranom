#!/usr/bin/env node
/**
 * Seed P&L chart (کل/معین) + mid-year opening JE for given rial balances.
 * Idempotent for accounts (INSERT OR IGNORE / reparent). Opening JE skipped if
 * src_doc_no=OPEN-PL-YTD already exists (unless --force).
 *
 *   node server/scripts/seed-pl-coa-opening.js
 *   DB_PATH=... node server/scripts/seed-pl-coa-opening.js --force
 */
const path = require('path');
const fs = require('fs');

const force = process.argv.includes('--force');
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'crm.db');
process.env.DB_PATH = dbPath;

const { initDB, getDB } = require('../db');
const { postToLedger } = require('../lib/ledger');
const { rialToLedger } = require('../lib/money');
const { todayJalali } = require('../jalali');

initDB();
const db = getDB();

/** [code, name, type, parent, level, nature] */
const ACCOUNTS = [
  // هزینه‌ها
  ['6200', 'هزینه مواد', 'expense', '6000', 2, 'بدهکار'],
  ['6201', 'هزینه مواد مستقیم', 'expense', '6200', 3, 'بدهکار'],
  ['610401', 'هزینه حقوق پایه', 'expense', '6104', 3, 'بدهکار'],
  ['610402', 'هزینه اضافه کار', 'expense', '6104', 3, 'بدهکار'],
  ['610403', 'هزینه عید و پاداش', 'expense', '6104', 3, 'بدهکار'],
  ['610201', 'هزینه پیک و پست', 'expense', '6102', 3, 'بدهکار'],
  ['610202', 'هزینه ملزومات و نوشت افزار', 'expense', '6102', 3, 'بدهکار'],
  ['610203', 'هزینه آگهی', 'expense', '6102', 3, 'بدهکار'],
  ['610204', 'هزینه های رایانه ای', 'expense', '6102', 3, 'بدهکار'],
  ['610205', 'تعمیرات و نگهداری اثاثه و منصوبات', 'expense', '6102', 3, 'بدهکار'],
  ['610206', 'آبدارخانه', 'expense', '6102', 3, 'بدهکار'],
  ['610207', 'هزینه قبوض خدماتی', 'expense', '6102', 3, 'بدهکار'],
  ['610209', 'اجاره مکان', 'expense', '6102', 3, 'بدهکار'],
  ['610301', 'هزینه آگهی و تبلیغات', 'expense', '6103', 3, 'بدهکار'],
  ['610302', 'هزینه حمل', 'expense', '6103', 3, 'بدهکار'],
  ['610303', 'هزینه سوشال مدیا', 'expense', '6103', 3, 'بدهکار'],
  ['610304', 'هزینه پورسانت', 'expense', '6103', 3, 'بدهکار'],
  ['6300', 'هزینه سربار', 'expense', '6000', 2, 'بدهکار'],
  ['6301', 'هزینه مواد غیر مستقیم', 'expense', '6300', 3, 'بدهکار'],
  ['6302', 'هزینه بیمه کالا', 'expense', '6300', 3, 'بدهکار'],
  ['6303', 'هزینه نمونه ها', 'expense', '6300', 3, 'بدهکار'],
  ['6304', 'هزینه مادگی', 'expense', '6300', 3, 'بدهکار'],
  ['6305', 'هزینه گلدوزی', 'expense', '6300', 3, 'بدهکار'],
  ['6306', 'هزینه شست', 'expense', '6300', 3, 'بدهکار'],
  ['6307', 'هزینه دوخت', 'expense', '6300', 3, 'بدهکار'],
  ['6308', 'هزینه اتوکاری', 'expense', '6300', 3, 'بدهکار'],
  ['6309', 'هزینه متفرقه', 'expense', '6300', 3, 'بدهکار'],
  ['6310', 'هزینه های دفتر پخش کیمیا', 'expense', '6300', 3, 'بدهکار'],
  ['6311', 'خالص کسری انبارها', 'expense', '6300', 3, 'بدهکار'],
  ['6400', 'هزینه های مالی', 'expense', '6000', 2, 'بدهکار'],
  ['6401', 'کارمزد و هزینه های بانکی', 'expense', '6400', 3, 'بدهکار'],
  ['6402', 'کارمزد تسهیلات بانکی', 'expense', '6400', 3, 'بدهکار'],
  ['6403', 'بهره تسهیلات بانکی', 'expense', '6400', 3, 'بدهکار'],
  // درآمدها
  ['4200', 'درآمد های عملیاتی', 'revenue', '4000', 2, 'بستانکار'],
  ['4202', 'فروش ضایعات', 'revenue', '4200', 3, 'بستانکار'],
  ['4204', 'تخفیفات دریافتنی (پرداختنی)', 'revenue', '4200', 3, 'بستانکار'],
];

/** Opening balances in RIALSE — only non-zero moein */
const OPENING = [
  { code: '610204', debit: 66330000, credit: 0 },
  { code: '610209', debit: 176000000, credit: 0 },
  { code: '6309', debit: 905600000, credit: 0 },
  { code: '6311', debit: 6572084708, credit: 0 },
  { code: '6401', debit: 322070, credit: 0 },
  { code: '4202', debit: 0, credit: 5750000 },
  { code: '4201', debit: 0, credit: 274740000 },
  { code: '4205', debit: 0, credit: 6439838344 },
  { code: '4204', debit: 0, credit: 114083043 },
];

const SRC_DOC = 'OPEN-PL-YTD';

// Ensure parents / control accounts exist (insert if missing from lean init seeds)
const ENSURE = [
  ['6000', 'هزینه‌ها', 'expense', null, 1, 'بدهکار'],
  ['6102', 'هزینه‌های عمومی و اداری', 'expense', '6000', 2, 'بدهکار'],
  ['6103', 'هزینه‌های توزیع و فروش', 'expense', '6000', 2, 'بدهکار'],
  ['6104', 'هزینه حقوق و دستمزد', 'expense', '6000', 2, 'بدهکار'],
  ['6105', 'هزینه استهلاک دارایی ها', 'expense', '6000', 2, 'بدهکار'],
  ['4000', 'درآمدها', 'revenue', null, 1, 'بستانکار'],
  ['4201', 'سایر درآمدهای عملیاتی', 'revenue', '4000', 2, 'بستانکار'],
  ['4205', 'خالص اضافی انبارها', 'revenue', '4000', 2, 'بستانکار'],
  ['3102', 'تراز افتتاحیه', 'equity', '3000', 2, 'بستانکار'],
  ['3000', 'حقوق صاحبان سرمایه', 'equity', null, 1, 'بستانکار'],
];

const cols = db.prepare('PRAGMA table_info(chart_of_accounts)').all().map((c) => c.name);
const hasLevel = cols.includes('level');
const hasNature = cols.includes('nature');

function upsertAccount([code, name, type, parent, level, nature]) {
  const existing = db.prepare('SELECT * FROM chart_of_accounts WHERE code=?').get(code);
  if (!existing) {
    if (hasLevel && hasNature) {
      db.prepare('INSERT INTO chart_of_accounts (code,name,type,parent_code,level,nature,is_active) VALUES (?,?,?,?,?,?,1)')
        .run(code, name, type, parent, level, nature);
    } else if (hasLevel) {
      db.prepare('INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES (?,?,?,?,?,1)')
        .run(code, name, type, parent, level);
    } else {
      db.prepare('INSERT INTO chart_of_accounts (code,name,type,parent_code,is_active) VALUES (?,?,?,?,1)')
        .run(code, name, type, parent);
    }
    return 'created';
  }
  db.prepare('UPDATE chart_of_accounts SET name=?, type=?, parent_code=?, is_active=1 WHERE code=?')
    .run(name, type, parent, code);
  if (hasLevel) db.prepare('UPDATE chart_of_accounts SET level=? WHERE code=?').run(level, code);
  if (hasNature) db.prepare('UPDATE chart_of_accounts SET nature=? WHERE code=?').run(nature, code);
  return 'updated';
}

const stats = { created: 0, updated: 0 };
db.transaction(() => {
  for (const row of ENSURE) {
    const r = upsertAccount(row);
    stats[r === 'created' ? 'created' : 'updated']++;
  }
  for (const row of ACCOUNTS) {
    const r = upsertAccount(row);
    stats[r === 'created' ? 'created' : 'updated']++;
  }
  // Reparent existing operational incomes under 4200
  for (const code of ['4201', '4205']) {
    db.prepare('UPDATE chart_of_accounts SET parent_code=? WHERE code=?').run('4200', code);
  }
  db.prepare("UPDATE chart_of_accounts SET name=? WHERE code='6105'")
    .run('هزینه استهلاک دارایی ها');
})();

console.log('COA:', stats);

const existingOpen = db.prepare(
  "SELECT id FROM journal_entries WHERE src_doc_no=? AND COALESCE(deleted_at,0)=0 AND COALESCE(status,'posted')<>'reversed'"
).get(SRC_DOC);

if (existingOpen && !force) {
  console.log('Opening JE already exists id=', existingOpen.id, '(pass --force to reverse+repost)');
  process.exit(0);
}

if (existingOpen && force) {
  const { reverseJournalEntry } = require('../lib/void-journal');
  reverseJournalEntry(db, existingOpen.id, { userId: 1, reason: 'بازثبت مانده YTD هزینه/درآمد', sourceType: 'opening_balance_reversal' });
  console.log('Reversed previous OPEN-PL-YTD', existingOpen.id);
}

let sumD = 0, sumC = 0;
const lines = [];
for (const o of OPENING) {
  const acc = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(o.code);
  if (!acc) throw new Error('Missing account for opening: ' + o.code);
  sumD += o.debit;
  sumC += o.credit;
  lines.push({
    code: acc.code, name: acc.name,
    debit: rialToLedger(o.debit), credit: rialToLedger(o.credit),
    description: 'مانده YTD از نرم‌افزار قبلی',
  });
}
const diff = sumD - sumC;
const openAcc = db.prepare("SELECT code,name FROM chart_of_accounts WHERE code='3102'").get();
if (diff > 0) {
  lines.push({ code: openAcc.code, name: openAcc.name, debit: 0, credit: rialToLedger(diff), description: 'تراز افتتاحیه YTD' });
} else if (diff < 0) {
  lines.push({ code: openAcc.code, name: openAcc.name, debit: rialToLedger(-diff), credit: 0, description: 'تراز افتتاحیه YTD' });
}

const date = process.env.OPENING_DATE || todayJalali();
const entryId = postToLedger(db, {
  sourceType: 'opening_balance',
  sourceId: null,
  date,
  description: 'مانده YTD هزینه و درآمد عملیاتی (مهاجرت وسط سال)',
  createdBy: 1,
  voucherType: 'opening',
  srcSystem: 'migration',
  docType: 'opening',
  lines,
});
db.prepare('UPDATE journal_entries SET src_doc_no=? WHERE id=?').run(SRC_DOC, entryId);

console.log('Opening JE id=', entryId);
console.log('  debit rial=', sumD.toLocaleString('en-US'), 'credit rial=', sumC.toLocaleString('en-US'), '3102=', Math.abs(diff).toLocaleString('en-US'));
console.log('DB:', dbPath);
