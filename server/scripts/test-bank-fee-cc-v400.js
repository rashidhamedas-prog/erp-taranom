/**
 * Separate cost center on bank-fee (6115) line — expense / transfer / policy.
 * Run: node server/scripts/test-bank-fee-cc-v400.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fee-cc-v400-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-bank-fee-cc-v400-secret-32bytes!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra != null ? extra : ''); }
}

function linesOf(refType, refId) {
  const je = db.prepare(
    "SELECT id FROM journal_entries WHERE ref_type=? AND ref_id=? AND COALESCE(deleted_at,0)=0 ORDER BY id DESC LIMIT 1"
  ).get(refType, refId);
  if (!je) return [];
  return db.prepare(
    'SELECT account_code, debit, credit, cost_center_id FROM journal_lines WHERE entry_id=? ORDER BY id'
  ).all(je.id);
}

(async () => {
  const {
    parseFeeRial, resolveFeeCostCenterId, outboundPaymentLines,
  } = require('../lib/payment-bank-fee');
  const { bankFeeAccount } = require('../lib/payment-bank-fee');
  const { rialToLedger } = require('../lib/money');

  const feeAcct = bankFeeAccount(db);
  const ccA = db.prepare(
    "INSERT INTO cost_centers (code,name,active) VALUES ('CC-FEE-A','مرکز کارمزد الف',1)"
  ).run().lastInsertRowid;
  const ccB = db.prepare(
    "INSERT INTO cost_centers (code,name,active) VALUES ('CC-DOC-B','مرکز سند ب',1)"
  ).run().lastInsertRowid;

  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('require_cc_on_expense','1')").run();

  let threw = false;
  try {
    resolveFeeCostCenterId(db, { feeRial: 1000, payType: 'bank' });
  } catch (e) {
    threw = e.code === 'E_FEE_CC_REQUIRED';
  }
  ok(threw, 'require ON + fee without CC → E_FEE_CC_REQUIRED');

  const def = resolveFeeCostCenterId(db, {
    feeRial: 1000, payType: 'bank', documentCostCenterId: ccB,
  });
  ok(def === ccB, 'defaults fee CC to document CC', def);

  const expl = resolveFeeCostCenterId(db, {
    feeRial: 1000, payType: 'bank', feeCostCenterId: ccA, documentCostCenterId: ccB,
  });
  ok(expl === ccA, 'explicit fee CC wins over document', expl);

  const built = outboundPaymentLines(db, {
    amount: 1_000_000, feeRial: 12_000, payType: 'bank',
    dest: { code: '6102', name: 'هزینه' },
    cash: { code: '1102-1', name: 'بانک' },
    feeCostCenterId: ccA,
  });
  const feeLine = built.lines.find((l) => l.code === feeAcct.code);
  ok(feeLine && feeLine.cost_center_id === ccA, 'outbound fee line stamped with fee CC', feeLine);
  ok(!built.lines[0].cost_center_id, 'dest line not forced to fee CC', built.lines[0]);

  ok(parseFeeRial(5000, 'cash') === 0, 'cash ignores fee');

  for (const tbl of ['expense_payments', 'supplier_payments', 'incentive_payments', 'account_transfers']) {
    const cols = db.prepare(`PRAGMA table_info(${tbl})`).all().map((c) => c.name);
    ok(cols.includes('fee_cost_center_id'), `${tbl}.fee_cost_center_id exists`);
  }

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'fee-cc-v400', device_fingerprint: 'fee-cc-v400-fp',
  }).token;

  const COA = '11028862';
  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES (?, 'بانک تست کارمزد CC', 'asset', '1102', 3, 1)
  `).run(COA);
  const bankId = db.prepare(`
    INSERT INTO banks (name, account_number, branch, active, coa_code, currency, is_foreign)
    VALUES ('بانک کارمزد CC','8862','مرکزی',1, ?, 'IRR', 0)
  `).run(COA).lastInsertRowid;

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/expenses', require('../routes/expenses'));
  app.use('/api/transfers', require('../routes/transfers'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  async function api(method, url, body) {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  const bad = await api('POST', '/api/expenses', {
    category: 'admin', title: 'هزینه بدون CC کارمزد',
    amount: 500_000, pay_type: 'bank', bank_id: bankId,
    fee_rial: 10_000, date: '1405/07/23',
    // no cost_center_id, no fee_cost_center_id — require ON
  });
  ok(bad.status === 422 || bad.status === 400, 'POST expense fee without CC rejected', bad);

  const okExp = await api('POST', '/api/expenses', {
    category: 'admin', title: 'هزینه با CC جدا',
    amount: 500_000, pay_type: 'bank', bank_id: bankId,
    fee_rial: 10_000, date: '1405/07/23',
    cost_center_id: ccB,
    fee_cost_center_id: ccA,
  });
  ok(okExp.status === 200 && okExp.data.id, 'POST expense with distinct fee CC', okExp);
  const expId = okExp.data.id;
  const exp = db.prepare('SELECT * FROM expense_payments WHERE id=?').get(expId);
  ok(Number(exp.fee_cost_center_id) === ccA, 'fee_cost_center_id persisted', exp);
  ok(Number(exp.cost_center_id) === ccB, 'document cost_center_id persisted', exp);
  const jl = linesOf('expense_payment', expId);
  const jeFee = jl.find((l) => l.account_code === feeAcct.code);
  const jeDest = jl.find((l) => Number(l.debit) === rialToLedger(500_000));
  ok(jeFee && Number(jeFee.cost_center_id) === ccA, 'JE fee line CC = fee CC', jeFee);
  ok(jeDest && Number(jeDest.cost_center_id) === ccB, 'JE dest line CC = document CC', jeDest);

  const defExp = await api('POST', '/api/expenses', {
    category: 'admin', title: 'هزینه پیش‌فرض CC کارمزد',
    amount: 200_000, pay_type: 'bank', bank_id: bankId,
    fee_rial: 3_000, date: '1405/07/23',
    cost_center_id: ccB,
    // omit fee_cost_center_id → default to document
  });
  ok(defExp.status === 200, 'POST expense fee CC defaults from document', defExp);
  const defRow = db.prepare('SELECT fee_cost_center_id FROM expense_payments WHERE id=?').get(defExp.data.id);
  ok(Number(defRow.fee_cost_center_id) === ccB, 'defaulted fee CC stored', defRow);
  const defJl = linesOf('expense_payment', defExp.data.id);
  const defFee = defJl.find((l) => l.account_code === feeAcct.code);
  ok(defFee && Number(defFee.cost_center_id) === ccB, 'JE fee line got document CC', defFee);

  const trBad = await api('POST', '/api/transfers', {
    date: '1405/07/23', from_type: 'bank', from_id: bankId,
    to_type: 'cash', to_id: null, amount: 50_000, fee_rial: 1_000,
  });
  ok(trBad.status === 422 || trBad.status === 400, 'transfer fee without CC rejected when require ON', trBad);

  const trOk = await api('POST', '/api/transfers', {
    date: '1405/07/23', from_type: 'bank', from_id: bankId,
    to_type: 'cash', to_id: null, amount: 50_000, fee_rial: 1_000,
    fee_cost_center_id: ccA,
  });
  ok(trOk.status === 200 && trOk.data.id, 'POST transfer with fee CC', trOk);
  const trRow = db.prepare('SELECT * FROM account_transfers WHERE id=?').get(trOk.data.id);
  ok(Number(trRow.fee_cost_center_id) === ccA, 'transfer fee_cost_center_id persisted');
  const trJl = linesOf('transfer', trOk.data.id);
  const trFee = trJl.find((l) => l.account_code === feeAcct.code);
  ok(trFee && Number(trFee.cost_center_id) === ccA, 'transfer JE fee CC', trFee);

  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('require_cc_on_expense','0')").run();
  const off = await api('POST', '/api/transfers', {
    date: '1405/07/23', from_type: 'bank', from_id: bankId,
    to_type: 'cash', to_id: null, amount: 10_000, fee_rial: 500,
  });
  ok(off.status === 200, 'require OFF allows fee without fee CC', off);

  const fk = fs.readFileSync(path.join(__dirname, '../sync/tables.js'), 'utf8');
  ok(fk.includes("['expense_payments', 'fee_cost_center_id']"), 'FK_COLUMNS expense fee CC');
  ok(fk.includes("['account_transfers', 'fee_cost_center_id']"), 'FK_COLUMNS transfer fee CC');

  server.close();
  try { closeSessionStore(); } catch (_) {}
  closeDB();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
