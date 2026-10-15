'use strict';
/**
 * v392: require_cc_on_expense only when period-expense amount is filled.
 * COGS (5101) and zero-amount lines must not block.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-cc-amt-v392-'));
const dbPath = path.join(tmp, 't.db');
process.env.DB_PATH = dbPath;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-v392-cc-amount';

const { getDB, initDB } = require('../db');
const { postToLedger, rewriteJournalEntry } = require('../lib/ledger');
const {
  isRequireExpenseCostCenter,
  isPeriodExpenseForCcPolicy,
  assertExpenseLinesHaveCostCenter,
  assertExpenseDocumentCostCenter,
} = require('../lib/cost-center-policy');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  OK', msg); }
  else { failed++; console.error('  FAIL', msg); }
}

initDB();
const db = getDB();

function setFlag(v) {
  db.prepare("INSERT INTO settings(key,value) VALUES('require_cc_on_expense',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(String(v));
}

function ensureCc() {
  let row = db.prepare('SELECT id FROM cost_centers WHERE COALESCE(active,1)=1 LIMIT 1').get();
  if (row) return row.id;
  const r = db.prepare("INSERT INTO cost_centers (name,code,active) VALUES ('CC-V392','CC-V392',1)").run();
  return r.lastInsertRowid;
}

function ensureAcct(code, name, type) {
  db.prepare(
    "INSERT OR IGNORE INTO chart_of_accounts (code,name,type,is_active) VALUES (?,?,?,1)"
  ).run(code, name, type);
  return db.prepare('SELECT code,name,type FROM chart_of_accounts WHERE code=?').get(code);
}

const ccId = ensureCc();
const cogs = ensureAcct('5101', 'بهای تمام‌شده', 'cogs');
const exp = ensureAcct('6102', 'هزینه اداری', 'expense');
const cash = ensureAcct('1101', 'صندوق', 'asset');

console.log('--- require_cc amount-gated v392 ---');

setFlag('1');
ok(isRequireExpenseCostCenter(db), 'flag ON');
ok(!isPeriodExpenseForCcPolicy(cogs), '5101/cogs is NOT period expense for CC policy');
ok(isPeriodExpenseForCcPolicy(exp), '6102/expense IS period expense for CC policy');

let threw = false;
try {
  assertExpenseLinesHaveCostCenter(db, [
    { code: cogs.code, name: cogs.name, debit: 5000, credit: 0 },
  ], { sourceType: 'invoice_cogs' });
} catch (e) {
  threw = true;
}
ok(!threw, 'COGS debit without CC does not throw when flag ON');

threw = false;
try {
  assertExpenseLinesHaveCostCenter(db, [
    { code: exp.code, name: exp.name, debit: 0, credit: 0 },
  ], { sourceType: 'expense_payment' });
} catch (e) {
  threw = true;
}
ok(!threw, 'zero-amount expense line does not throw');

threw = false;
try {
  assertExpenseLinesHaveCostCenter(db, [
    { code: exp.code, name: exp.name, debit: 1000, credit: 0 },
  ], { sourceType: 'expense_payment' });
} catch (e) {
  threw = e.code === 'CC_REQUIRED_ON_EXPENSE';
}
ok(threw, 'period expense debit > 0 still requires CC when flag ON');

threw = false;
try {
  assertExpenseDocumentCostCenter(db, { cost_center_id: null, section: 'admin', amount: 0 });
} catch (e) {
  threw = true;
}
ok(!threw, 'document assert skips when amount is 0');

threw = false;
try {
  assertExpenseDocumentCostCenter(db, { cost_center_id: null, section: 'admin', amount: 100 });
} catch (e) {
  threw = e.code === 'CC_REQUIRED_ON_EXPENSE';
}
ok(threw, 'document assert still requires CC when amount > 0');

let jeId = null;
try {
  jeId = postToLedger(db, {
    sourceType: 'invoice_cogs', sourceId: 992001,
    date: '1405/01/01', description: 'cogs no cc', createdBy: 1,
    lines: [
      { code: cogs.code, name: cogs.name, debit: 20, credit: 0 },
      { code: cash.code, name: cash.name, debit: 0, credit: 20 },
    ],
  });
} catch (e) {
  console.error(e);
}
ok(!!jeId, 'postToLedger accepts invoice_cogs without CC when flag ON');

threw = false;
try {
  postToLedger(db, {
    sourceType: 'expense_payment', sourceId: 992002,
    date: '1405/01/01', description: 'exp no cc', createdBy: 1,
    lines: [
      { code: exp.code, name: exp.name, debit: 15, credit: 0 },
      { code: cash.code, name: cash.name, debit: 0, credit: 15 },
    ],
  });
} catch (e) {
  threw = e.code === 'CC_REQUIRED_ON_EXPENSE' || e.status === 422;
}
ok(threw, 'postToLedger still blocks period expense without CC');

const withCc = postToLedger(db, {
  sourceType: 'expense_payment', sourceId: 992003,
  date: '1405/01/01', description: 'exp with cc', createdBy: 1,
  costCenterId: ccId,
  lines: [
    { code: exp.code, name: exp.name, debit: 12, credit: 0 },
    { code: cash.code, name: cash.name, debit: 0, credit: 12 },
  ],
});
ok(!!withCc, 'postToLedger accepts period expense with CC');

// Soft-stamp COGS from warehouseId when available
const wh = db.prepare('SELECT id, cost_center_id FROM warehouses WHERE COALESCE(active,1)=1 LIMIT 1').get();
if (wh) {
  db.prepare('UPDATE warehouses SET cost_center_id=? WHERE id=?').run(ccId, wh.id);
  const lines = [
    { code: cogs.code, name: cogs.name, debit: 8, credit: 0 },
    { code: cash.code, name: cash.name, debit: 0, credit: 8 },
  ];
  assertExpenseLinesHaveCostCenter(db, lines, {
    sourceType: 'invoice_cogs', warehouseId: wh.id,
  });
  ok(Number(lines[0].cost_center_id) === Number(ccId), 'COGS soft-stamps warehouse CC without throw');
} else {
  ok(true, 'skip warehouse soft-stamp (no warehouse in seed)');
}

// rewrite COGS without CC must not throw
const rewriteOk = rewriteJournalEntry(db, {
  sourceType: 'invoice_cogs', sourceId: 992001,
  date: '1405/01/01', description: 'cogs rewrite',
  lines: [
    { code: cogs.code, name: cogs.name, debit: 25, credit: 0 },
    { code: cash.code, name: cash.name, debit: 0, credit: 25 },
  ],
});
ok(!!rewriteOk, 'rewriteJournalEntry accepts invoice_cogs without CC');

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
