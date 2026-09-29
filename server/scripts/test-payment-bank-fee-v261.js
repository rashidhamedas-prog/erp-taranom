/**
 * Bank transfer fee (کارمزد انتقال) on outbound payments — JE + R13 reverse.
 * Run: node server/scripts/test-payment-bank-fee-v261.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pay-fee-v261-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-payment-bank-fee-v261-secret-32b!!';
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
  return db.prepare('SELECT account_code, debit, credit FROM journal_lines WHERE entry_id=? ORDER BY id').all(je.id);
}

(async () => {
  const {
    parseFeeRial, outboundPaymentLines, outboundPaymentReversalLines, transferLines,
  } = require('../lib/payment-bank-fee');
  const { acct } = require('../lib/coa-map');
  const { rialToLedger } = require('../lib/money');

  ok(parseFeeRial(12000, 'bank') === 12000, 'parseFee accepts bank');
  ok(parseFeeRial(12000, 'cash') === 0, 'parseFee ignores cash');
  ok(parseFeeRial(12000, 'cheque') === 0, 'parseFee ignores cheque');

  const feeAcct = acct(db, 'coa_bank_fee');
  ok(String(feeAcct.code) === '6115' || String(feeAcct.code).startsWith('6115'), 'coa_bank_fee → 6115', feeAcct);

  const built = outboundPaymentLines(db, {
    amount: 1_000_000, feeRial: 12_000, payType: 'bank',
    dest: { code: '6102', name: 'هزینه' },
    cash: { code: '1102-1', name: 'بانک' },
  });
  ok(built.lines.length === 3, 'outbound has 3 lines with fee');
  ok(built.bankOutRial === 1_012_000, 'bank credits amount+fee');
  ok(built.lines.some(l => l.code === feeAcct.code && l.debit === rialToLedger(12000)), 'fee debit on 6115');

  const rev = outboundPaymentReversalLines(db, {
    amount: 1_000_000, feeRial: 12_000,
    dest: { code: '6102', name: 'هزینه' },
    cash: { code: '1102-1', name: 'بانک' },
  });
  ok(rev.lines.length === 3, 'reversal has 3 lines');
  ok(rev.bankInRial === 1_012_000, 'reversal restores amount+fee to bank');

  const tr = transferLines(db, {
    amount: 500_000, feeRial: 5_000, fromType: 'bank',
    src: { code: '1102-1', name: 'بانک الف' },
    dst: { code: '1101-1', name: 'صندوق' },
  });
  ok(tr.lines.length === 3 && tr.feeRial === 5000, 'transfer from bank posts fee');
  const trCash = transferLines(db, {
    amount: 500_000, feeRial: 5_000, fromType: 'cash',
    src: { code: '1101-1', name: 'صندوق' },
    dst: { code: '1102-1', name: 'بانک' },
  });
  ok(trCash.lines.length === 2 && trCash.feeRial === 0, 'transfer from cash ignores fee');

  for (const tbl of ['expense_payments', 'supplier_payments', 'incentive_payments', 'account_transfers']) {
    const cols = db.prepare(`PRAGMA table_info(${tbl})`).all().map(c => c.name);
    ok(cols.includes('fee_rial'), `${tbl}.fee_rial exists`);
  }

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'fee-v261', device_fingerprint: 'fee-v261-fp',
  }).token;

  const COA = '11028861';
  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES (?, 'بانک تست کارمزد', 'asset', '1102', 3, 1)
  `).run(COA);
  const bankId = db.prepare(`
    INSERT INTO banks (name, account_number, branch, active, coa_code, currency, is_foreign)
    VALUES ('بانک کارمزد','8861','مرکزی',1, ?, 'IRR', 0)
  `).run(COA).lastInsertRowid;

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/expenses', require('../routes/expenses'));
  app.use('/api/transfers', require('../routes/transfers'));
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
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

  const created = await api('POST', '/api/expenses', {
    category: 'admin', title: 'پرداخت به شخص: تست کارمزد',
    amount: 2_000_000, pay_type: 'bank', bank_id: bankId,
    fee_rial: 15_000, date: '1405/07/07', note: 'fee-test',
  });
  ok(created.status === 200 && created.data.id, 'POST expense with fee', created);
  const expId = created.data.id;
  const exp = db.prepare('SELECT * FROM expense_payments WHERE id=?').get(expId);
  ok(Number(exp.fee_rial) === 15000, 'fee_rial persisted', exp && exp.fee_rial);
  const jl = linesOf('expense_payment', expId);
  const feeLine = jl.find(l => l.account_code === feeAcct.code);
  const bankLine = jl.find(l => l.account_code === COA);
  ok(!!feeLine && Number(feeLine.debit) === rialToLedger(15000), 'JE fee debit', feeLine);
  ok(!!bankLine && Number(bankLine.credit) === rialToLedger(2_015_000), 'JE bank credit amount+fee', bankLine);

  const del = await api('DELETE', '/api/expenses/' + expId);
  ok(del.status === 200, 'DELETE expense reverses');
  const revLines = linesOf('expense_payment_reversal', expId);
  const revBank = revLines.find(l => l.account_code === COA);
  ok(!!revBank && Number(revBank.debit) === rialToLedger(2_015_000), 'reversal restores amount+fee', revBank);

  const trRes = await api('POST', '/api/transfers', {
    date: '1405/07/07', from_type: 'bank', from_id: bankId,
    to_type: 'cash', to_id: null, amount: 100_000, fee_rial: 2_500, note: 'tr-fee',
  });
  ok(trRes.status === 200 && trRes.data.id, 'POST transfer with fee', trRes);
  const trRow = db.prepare('SELECT * FROM account_transfers WHERE id=?').get(trRes.data.id);
  ok(Number(trRow.fee_rial) === 2500, 'transfer fee persisted');
  const trJl = linesOf('transfer', trRes.data.id);
  ok(trJl.some(l => l.account_code === feeAcct.code && Number(l.debit) === rialToLedger(2500)), 'transfer JE fee');
  ok(trJl.some(l => l.account_code === COA && Number(l.credit) === rialToLedger(102_500)), 'transfer bank out amount+fee');

  const cap = fs.readFileSync(path.join(__dirname, '../sync/capture.js'), 'utf8');
  ok(cap.includes("['/api/accounting/incentive-payments', 'incentive_payments']"), 'incentive-payments PATH_TABLE_MAP');

  server.close();
  try { closeSessionStore(); } catch (_) {}
  closeDB();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
