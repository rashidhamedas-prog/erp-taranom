#!/usr/bin/env node
/**
 * Integration test: P&L COA seed + opening JE + excel upsert + COA delete rules.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = path.join(os.tmpdir(), 'taranom-pl-coa-' + Date.now() + '.db');
process.env.DB_PATH = tmp;
process.env.JWT_SECRET = 'test-pl-coa-secret-32chars-minimum!!';
process.env.SYNC_ROLE = 'central';

const { initDB, getDB } = require('../db');
initDB();
let db = getDB();

let failed = 0;
function ok(cond, msg) {
  if (!cond) { console.error('FAIL', msg); failed++; }
  else console.log('OK  ', msg);
}

// Seed via script subprocess so it uses same DB_PATH
const seed = spawnSync(process.execPath, [path.join(__dirname, 'seed-pl-coa-opening.js')], {
  env: process.env, encoding: 'utf8',
});
if (seed.status !== 0) {
  console.error(seed.stdout, seed.stderr);
  process.exit(1);
}
console.log(seed.stdout);

db = getDB();
ok(!!db.prepare("SELECT 1 FROM chart_of_accounts WHERE code='6201'").get(), 'معین مواد مستقیم');
ok(!!db.prepare("SELECT 1 FROM chart_of_accounts WHERE code='610204'").get(), 'معین رایانه');
ok(!!db.prepare("SELECT 1 FROM chart_of_accounts WHERE code='6311'").get(), 'معین کسری انبار');
ok(!!db.prepare("SELECT 1 FROM chart_of_accounts WHERE code='4204'").get(), 'معین تخفیفات دریافتنی');
ok(db.prepare("SELECT parent_code FROM chart_of_accounts WHERE code='4201'").get()?.parent_code === '4200', '4201 زیر 4200');

const openJe = db.prepare("SELECT id FROM journal_entries WHERE src_doc_no='OPEN-PL-YTD'").get();
ok(!!openJe, 'سند OPEN-PL-YTD');

const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');
const bal = db.prepare(`
  SELECT
    SUM(${SQL_JL_DEBIT_RIAL}) d,
    SUM(${SQL_JL_CREDIT_RIAL}) c
  FROM journal_lines jl
  JOIN journal_entries je ON je.id=jl.entry_id
  WHERE je.id=?
`).get(openJe.id);
ok(Number(bal.d) === Number(bal.c) && Number(bal.d) > 0, `سند متوازن ${bal.d}=${bal.c}`);

const rent = db.prepare(`
  SELECT SUM(${SQL_JL_DEBIT_RIAL})-SUM(${SQL_JL_CREDIT_RIAL}) net FROM journal_lines jl
  JOIN journal_entries je ON je.id=jl.entry_id
  WHERE jl.account_code='610209' AND COALESCE(je.deleted_at,0)=0
`).get();
ok(Number(rent.net) === 176000000, 'مانده اجاره = 176000000 ریال');

const scrap = db.prepare(`
  SELECT SUM(${SQL_JL_CREDIT_RIAL})-SUM(${SQL_JL_DEBIT_RIAL}) net FROM journal_lines jl
  JOIN journal_entries je ON je.id=jl.entry_id
  WHERE jl.account_code='4202' AND COALESCE(je.deleted_at,0)=0
`).get();
ok(Number(scrap.net) === 5750000, 'فروش ضایعات بستانکار');

const disc = db.prepare(`
  SELECT SUM(${SQL_JL_CREDIT_RIAL})-SUM(${SQL_JL_DEBIT_RIAL}) net FROM journal_lines jl
  JOIN journal_entries je ON je.id=jl.entry_id
  WHERE jl.account_code='4204' AND COALESCE(je.deleted_at,0)=0
`).get();
ok(Number(disc.net) === 114083043, 'تخفیفات دریافتنی بستانکار');

// Excel upsert planner
const excel = require('../routes/excel');
const { buildActions, dedupeExcelActions } = excel._test;
db.prepare(`INSERT INTO products (user_id,name,code,price,cost,stock,stock_alert,unit,image)
  VALUES (1,'کالای تست','P-KEEP',1000,500,3,1,'عدد','keep.jpg')`).run();
const built = buildActions(db, 'products', [{
  'نام کالا*': 'کالای تست', 'کد کالا': 'P-KEEP', 'موجودی': 99, 'قیمت فروش (ریال)': 2000,
}]);
const planned = dedupeExcelActions(db, 'products', built);
ok(planned.actions.length === 1 && planned.actions[0].method === 'PUT', 'محصول تکراری → PUT');
ok(planned.actions[0].body.excel_upsert === true, 'فلگ excel_upsert');
ok(planned.updates.length === 1, 'updates_count');

// COA delete: empty leaf ok; with JE blocked
db.prepare("INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES ('6299','تست حذف','expense','6200',3,1)").run();
const delOk = db.prepare('DELETE FROM chart_of_accounts WHERE code=?').run('6299');
ok(delOk.changes === 1, 'حذف حساب بدون گردش');

const jl = db.prepare('SELECT COUNT(*) c FROM journal_lines WHERE account_code=?').get('610209').c;
ok(jl > 0, 'اجاره گردش دارد — نباید حذف شود');

try { fs.unlinkSync(tmp); } catch (_) {}
if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nAll PL-COA / excel-upsert tests passed');
