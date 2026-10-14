'use strict';
/**
 * Policy require_cc_on_expense — ledger choke-point + expense posting.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-cc-policy-'));
const dbPath = path.join(tmp, 't.db');
process.env.DB_PATH = dbPath;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-v375-cc-policy';

const { getDB, initDB } = require('../db');
const { postToLedger } = require('../lib/ledger');
const {
  isRequireExpenseCostCenter,
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
  const r = db.prepare("INSERT INTO cost_centers (name,code,active) VALUES ('CC-TEST','CC-T',1)").run();
  return r.lastInsertRowid;
}

function ensureExpenseAcct() {
  let a = db.prepare("SELECT code,name FROM chart_of_accounts WHERE code='6102' LIMIT 1").get();
  if (a) return a;
  db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,is_active) VALUES ('6102','هزینه اداری','expense',1)").run();
  return db.prepare("SELECT code,name FROM chart_of_accounts WHERE code='6102'").get();
}

const ccId = ensureCc();
const exp = ensureExpenseAcct();
const cash = db.prepare("SELECT code,name FROM chart_of_accounts WHERE type IN ('asset','cash') AND is_active=1 LIMIT 1").get()
  || (() => {
    db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,is_active) VALUES ('1101','صندوق','asset',1)").run();
    return { code: '1101', name: 'صندوق' };
  })();

console.log('--- require_cc_on_expense v375 ---');

setFlag('0');
ok(!isRequireExpenseCostCenter(db), 'flag OFF when 0');

setFlag('1');
ok(isRequireExpenseCostCenter(db), 'flag ON when 1');

let threw = false;
try {
  assertExpenseLinesHaveCostCenter(db, [
    { code: exp.code, name: exp.name, debit: 1000, credit: 0 },
  ], { sourceType: 'expense_payment' });
} catch (e) {
  threw = e.code === 'CC_REQUIRED_ON_EXPENSE';
}
ok(threw, 'assertExpenseLinesHaveCostCenter rejects missing CC when ON');

threw = false;
try {
  assertExpenseDocumentCostCenter(db, { cost_center_id: null, section: 'admin' });
} catch (e) {
  threw = e.code === 'CC_REQUIRED_ON_EXPENSE';
}
ok(threw, 'document-level assert rejects admin expense without CC when ON');

threw = false;
try {
  assertExpenseDocumentCostCenter(db, { cost_center_id: null, section: 'production_overhead', is_overhead: true });
} catch (e) {
  threw = e.code === 'E_CC_REQUIRED_OH' || /سربار/.test(e.message || '');
}
ok(threw, 'OH still requires CC');

setFlag('0');
threw = false;
try {
  assertExpenseDocumentCostCenter(db, { cost_center_id: null, section: 'admin' });
} catch (e) {
  threw = true;
}
ok(!threw, 'admin expense without CC allowed when flag OFF');

setFlag('0');
threw = false;
try {
  assertExpenseDocumentCostCenter(db, { cost_center_id: null, section: 'production_overhead', is_overhead: true });
} catch (e) {
  threw = e.code === 'E_CC_REQUIRED_OH' || /سربار|مرکز هزینه/.test(e.message || '');
}
ok(threw, 'OH without CC rejected even when flag OFF');

setFlag('1');
threw = false;
try {
  postToLedger(db, {
    sourceType: 'expense_payment', sourceId: 999001,
    date: '1405/01/01', description: 'test no cc', createdBy: 1,
    lines: [
      { code: exp.code, name: exp.name, debit: 10, credit: 0 },
      { code: cash.code, name: cash.name, debit: 0, credit: 10 },
    ],
  });
} catch (e) {
  threw = e.code === 'CC_REQUIRED_ON_EXPENSE' || e.status === 422;
}
ok(threw, 'postToLedger blocks expense without CC when ON');

let jeId = null;
try {
  jeId = postToLedger(db, {
    sourceType: 'expense_payment', sourceId: 999002,
    date: '1405/01/01', description: 'test with cc', createdBy: 1,
    costCenterId: ccId,
    lines: [
      { code: exp.code, name: exp.name, debit: 10, credit: 0 },
      { code: cash.code, name: cash.name, debit: 0, credit: 10 },
    ],
  });
} catch (e) {
  console.error(e);
}
ok(!!jeId, 'postToLedger accepts expense with CC when ON');

const line = db.prepare(
  'SELECT cost_center_id FROM journal_lines WHERE entry_id=? AND account_code=? AND debit>0'
).get(jeId, exp.code);
ok(Number(line?.cost_center_id) === Number(ccId), 'expense line stamped with CC');

setFlag('0');
jeId = postToLedger(db, {
  sourceType: 'expense_payment', sourceId: 999003,
  date: '1405/01/01', description: 'legacy no cc', createdBy: 1,
  lines: [
    { code: exp.code, name: exp.name, debit: 5, credit: 0 },
    { code: cash.code, name: cash.name, debit: 0, credit: 5 },
  ],
});
ok(!!jeId, 'postToLedger allows expense without CC when OFF');

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
