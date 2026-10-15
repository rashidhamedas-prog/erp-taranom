'use strict';
/**
 * Payroll process always requires an active cost center (independent of require_cc_on_expense).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-payroll-cc-'));
const dbPath = path.join(tmp, 't.db');
process.env.DB_PATH = dbPath;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-v396-payroll-cc';

const { getDB, initDB } = require('../db');
const { postToLedger } = require('../lib/ledger');
const {
  assertExpenseLinesHaveCostCenter,
  assertExpenseDocumentCostCenter,
  isRequireExpenseCostCenter,
} = require('../lib/cost-center-policy');
const { acct } = require('../lib/coa-map');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  OK', msg); }
  else { failed++; console.error('  FAIL', msg); }
}

initDB();
const db = getDB();

function setFlag(v) {
  db.prepare(
    "INSERT INTO settings(key,value) VALUES('require_cc_on_expense',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(String(v));
}

function ensureCc() {
  let row = db.prepare('SELECT id FROM cost_centers WHERE COALESCE(active,1)=1 LIMIT 1').get();
  if (row) return row.id;
  const r = db.prepare("INSERT INTO cost_centers (name,code,active) VALUES ('CC-PAY','CC-P',1)").run();
  return r.lastInsertRowid;
}

const ccId = ensureCc();
const cols = new Map(db.prepare('PRAGMA table_info(payroll_records)').all().map(c => [c.name, c]));
ok(!!cols.get('cost_center_id'), 'payroll_records.cost_center_id column exists');

console.log('--- payroll CC required v396 ---');

setFlag('0');
ok(!isRequireExpenseCostCenter(db), 'require_cc_on_expense OFF');

let threw = false;
try {
  assertExpenseDocumentCostCenter(db, { cost_center_id: null, section: 'payroll' });
} catch (e) {
  threw = e.code === 'E_CC_REQUIRED_PAYROLL';
}
ok(threw, 'document assert rejects payroll without CC even when flag OFF');

threw = false;
try {
  assertExpenseLinesHaveCostCenter(db, [
    { ...acct(db, 'coa_payroll_expense'), debit: 1000, credit: 0 },
    { ...acct(db, 'coa_payroll_payable'), debit: 0, credit: 1000 },
  ], { sourceType: 'payroll' });
} catch (e) {
  threw = e.code === 'E_CC_REQUIRED_PAYROLL' || /حقوق/.test(e.message || '');
}
ok(threw, 'ledger assert rejects payroll expense debit without CC when flag OFF');

const jeId = db.transaction(() => postToLedger(db, {
  sourceType: 'payroll', sourceId: 9001, date: '1405/07/01',
  description: 'تست حقوق با مرکز', createdBy: 1, costCenterId: ccId,
  lines: [
    { ...acct(db, 'coa_payroll_expense'), debit: 1000, credit: 0, cost_center_id: ccId },
    { ...acct(db, 'coa_payroll_payable'), debit: 0, credit: 1000 },
  ],
}))();
const lined = db.prepare(
  'SELECT cost_center_id FROM journal_lines WHERE entry_id=? AND debit_rial>0 LIMIT 1'
).get(jeId);
ok(Number(lined?.cost_center_id) === Number(ccId), 'posted payroll expense line carries cost_center_id');

const resolved = assertExpenseDocumentCostCenter(db, { cost_center_id: ccId, section: 'payroll' });
ok(Number(resolved) === Number(ccId), 'active CC accepted for payroll section');

const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(appSrc.includes('id="pc-cc"'), 'processing UI has pc-cc select');
ok(appSrc.includes('id="fk-cc"'), 'farankenou modal has fk-cc select');
ok(/cost_center_id/.test(appSrc.slice(appSrc.indexOf('function payrollCalcPayload'))), 'payload sends cost_center_id');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log('ALL OK');
