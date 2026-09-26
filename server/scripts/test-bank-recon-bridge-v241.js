/**
 * Bank reconciliation bridge: no double-count, post to the bank subsidiary, void reverses.
 * Run: node server/scripts/test-bank-recon-bridge-v241.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-bridge-v241-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-bank-bridge-v241-secret-32b!!';
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

(async () => {
  const { computeBridge } = require('../lib/bank-recon');
  const { parseBankStatementCsv } = require('../routes/bank-reconciliation');

  const charge = computeBridge(9_250_000, 10_000_000, [
    { side: 'bank', item_kind: 'bank_charge', amount_rial: 750_000, matched: 0 },
  ]);
  ok(charge.can_close === true && charge.unexplained_rial === 0, 'classified fee reconciles', charge.unexplained_rial);
  ok(charge.adjusted_book_rial === 9_250_000, 'book drops by the fee once');

  const raw = computeBridge(9_250_000, 10_000_000, [
    { side: 'bank', item_kind: 'unclassified', amount_rial: 750_000, matched: 0 },
  ]);
  ok(raw.can_close === false, 'unclassified blocks close');
  ok(raw.unexplained_rial === -750_000, 'unclassified is not added twice', raw.unexplained_rial);

  const timing = computeBridge(1_000_000, 800_000, [
    { side: 'book', item_kind: 'outstanding_check', amount_rial: 200_000, matched: 0 },
  ]);
  ok(timing.can_close === true && timing.outstanding_checks_rial === 200_000, 'outstanding check is timing only');

  const csv = parseBankStatementCsv('date,برداشت,واریز,description,ref\n1405/01/10,750000,0,fee,f1\n1405/01/11,0,"5,000,000",in,i1');
  ok(csv.length === 2 && Number(csv[0].amount_rial) === -750000, 'CSV withdraw is negative', csv[0]);
  ok(Number(csv[1].amount_rial) === 5000000, 'CSV deposit is positive', csv[1]);

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'bank-bridge', device_fingerprint: 'bank-bridge-fp',
  }).token;

  const COA = '11028841';
  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES (?, 'بانک تست مغایرت', 'asset', '1102', 3, 1)
  `).run(COA);
  const bankId = db.prepare(`
    INSERT INTO banks (name, account_number, branch, active, coa_code, currency, is_foreign)
    VALUES ('بانک مغایرت','4242','مرکزی',1, ?, 'IRR', 0)
  `).run(COA).lastInsertRowid;

  const { postToLedger } = require('../lib/ledger');
  const { rialToLedger } = require('../lib/money');
  const { acct } = require('../lib/coa-map');
  const opening = acct(db, 'coa_opening_balance');
  postToLedger(db, {
    sourceType: 'test_bank_open', sourceId: 241, date: '1405/07/01',
    description: 'مانده بانک تست', createdBy: admin.id,
    lines: [
      { code: COA, name: 'بانک تست مغایرت', debit: rialToLedger(10_000_000), credit: 0 },
      { code: opening.code, name: opening.name, debit: 0, credit: rialToLedger(10_000_000) },
    ],
  });

  const app = express();
  app.use(express.json());
  app.use('/api/bank-reconciliation', require('../routes/bank-reconciliation'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}/api/bank-reconciliation`;
  async function api(method, p, body) {
    const res = await fetch(BASE + p, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }

  const created = await api('POST', '/', {
    bank_id: bankId, statement_date: '1405/07/04', statement_balance_rial: 9_250_000,
  });
  ok(created.status === 200 && created.data?.id, 'create rial recon', created.data?.error);
  const id = created.data.id;

  const blocked = await api('POST', `/${id}/close`, {});
  ok(blocked.status === 400, 'close refused while unexplained', blocked.data?.error);

  const item = await api('POST', `/${id}/items`, {
    side: 'bank', item_kind: 'bank_charge', amount_rial: 750_000, description: 'کارمزد',
  });
  ok(item.status === 200, 'add fee item', item.data?.error);

  const closed = await api('POST', `/${id}/close`, {});
  ok(closed.status === 200 && closed.data?.ok, 'close when bridge is zero', closed.data?.error);
  const jeId = closed.data?.adjustment_je_id;
  ok(!!jeId, 'adjustment journal posted', closed.data);
  const lines = db.prepare('SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?').all(jeId);
  ok(lines.some(l => l.account_code === COA && Number(l.credit_rial) === 750_000), 'credit hits the bank subsidiary', lines);
  ok(!lines.some(l => l.account_code === '1102' || l.account_code === '9999'), 'control 1102 and plug 9999 are not used', lines);
  ok(lines.some(l => l.account_code === '6115' && Number(l.debit_rial) === 750_000), 'fee hits 6115', lines);

  const voided = await api('POST', `/${id}/void`, { reason: 'تست ابطال' });
  ok(voided.status === 200 && voided.data?.reversal_je_id, 'void reverses the adjustment', voided.data?.error);
  const head = db.prepare('SELECT status FROM bank_reconciliations WHERE id=?').get(id);
  ok(head.status === 'void', 'header is void, not deleted');

  await new Promise((r) => server.close(r));
  try { closeSessionStore(); } catch (_) {}
  try { closeDB(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  console.log('\n' + (fail ? `FAILED ${fail}` : 'ALL CHECKS PASSED') + ` (${pass} pass, ${fail} fail)`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
