/**
 * v180 — statement rows from customer tafsili; endorse writes customer_ledger;
 * dashboard AR is Σ max(0, per-customer GL); repair v2 backfills missing ledger.
 * Run: node server/scripts/test-stmt-gl-cheque-v180.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stmt-gl-v180-'));
const dbFile = path.join(dir, 't.db');
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-stmt-gl-cheque-v180-secret-32b';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const { postToLedger } = require('../lib/ledger');
const { acct } = require('../lib/coa-map');
const { rialToLedger } = require('../lib/money');
const {
  glCustomersTafsiliBalance, repairGlLinesToLedger,
} = require('../lib/customer-books');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

(async () => {
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'stmt-v180', device_fingerprint: 'stmt-v180-fp',
  }).token;

  const recv = acct(db, 'coa_receivable');
  const opening = acct(db, 'coa_opening_balance');
  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES ('11030180','تفصیلی معین v180','asset',?,4,1)
  `).run(recv.code);
  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES ('11030181','تفصیلی بستانکار v180','asset',?,4,1)
  `).run(recv.code);

  const custId = db.prepare(
    'INSERT INTO customers (user_id,biz,phone,coa_code,balance) VALUES (?,?,?,?,?)'
  ).run(admin.id, 'معین تست v180', '09025050811', '11030180', 0).lastInsertRowid;
  const credId = db.prepare(
    'INSERT INTO customers (user_id,biz,phone,coa_code,balance) VALUES (?,?,?,?,?)'
  ).run(admin.id, 'بستانکار v180', '09025050812', '11030181', 0).lastInsertRowid;

  const partyId = db.prepare(`
    INSERT INTO parties (person_code, party_type, full_name, phone, is_active, legacy_table, legacy_id, coa_code)
    VALUES ('P-V180','customer','معین تست v180','09025050811',1,'customers',?,'11030180')
  `).run(custId).lastInsertRowid;
  db.prepare('UPDATE customers SET party_id=? WHERE id=?').run(partyId, custId);

  const CHEQUE = 1_200_000_000;
  const DEBTOR = 100_000_000;
  const CREDITOR = 40_000_000;

  postToLedger(db, {
    sourceType: 'opening_ledger', sourceId: credId, date: '1405/05/01',
    description: 'افتتاحیه بستانکار v180', createdBy: admin.id, voucherType: 'opening',
    lines: [
      { code: opening.code, name: opening.name, debit: rialToLedger(CREDITOR), credit: 0 },
      { code: '11030181', name: 'تفصیلی بستانکار v180', debit: 0, credit: rialToLedger(CREDITOR) },
    ],
  });
  postToLedger(db, {
    sourceType: 'opening_ledger', sourceId: custId, date: '1405/05/01',
    description: 'افتتاحیه بدهکار v180', createdBy: admin.id, voucherType: 'opening',
    lines: [
      { code: '11030180', name: 'تفصیلی معین v180', debit: rialToLedger(DEBTOR), credit: 0 },
      { code: opening.code, name: opening.name, debit: 0, credit: rialToLedger(DEBTOR) },
    ],
  });

  const app = express();
  app.use(express.json());
  app.use('/api/accounting', require('../routes/accounting'));
  app.use('/api/cheque-records', require('../routes/cheque-records'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;

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

  let r = await api('POST', '/api/cheque-records', {
    direction: 'in', cheque_number: 'END-MOEIN', amount: CHEQUE,
    party_id: partyId, party_name: 'معین تست v180', due_date: '1405/06/20',
  });
  ok(r.status === 200 && r.data && r.data.id, 'create in cheque', r.data && r.data.error);
  const chequeId = r.data.id;

  r = await api('POST', `/api/cheque-records/${chequeId}/endorse`, {
    date: '1405/05/26', party_id: partyId,
  });
  ok(r.status === 200 && r.data && r.data.lifecycle_status === 'endorsed', 'endorse to customer', r.data && r.data.error);

  const led = db.prepare(`
    SELECT debit, credit, entry_type, ref_type FROM customer_ledger
    WHERE customer_id=? AND ref_type='cheque_endorse' AND ref_id=?
  `).get(custId, chequeId);
  ok(led && Number(led.debit) === CHEQUE && Number(led.credit) === 0, 'customer_ledger debit cheque', led);
  ok(led && led.entry_type === 'cheque', 'endorse entry_type=cheque');

  r = await api('GET', '/api/accounting/statement/' + custId);
  ok(r.status === 200, 'statement 200');
  const chequeRow = (r.data.entries || []).find((e) =>
    e.ref_type === 'cheque' && Number(e.ref_id) === Number(chequeId)
  );
  ok(!!chequeRow && Number(chequeRow.debit) === CHEQUE, 'statement shows endorsed cheque', chequeRow);
  const expectClose = DEBTOR + CHEQUE;
  ok(Math.abs(Number(r.data.closing) - expectClose) <= 1, 'GL closing includes cheque', r.data.closing);
  ok(Math.abs(Number(r.data.ledger_closing) - expectClose) <= 1, 'ledger closing includes cheque', r.data.ledger_closing);
  ok(r.data.books_mismatch !== true, 'no statement mismatch when rows from GL', r.data.books_mismatch);
  ok(r.data.source === 'gl', 'statement source is gl', r.data.source);

  const kpi = glCustomersTafsiliBalance(db);
  ok(Math.abs(Number(kpi.display) - expectClose) <= 1, 'KPI display = debtor only (not net)', kpi);
  ok(Math.abs(Number(kpi.creditor) - CREDITOR) <= 1, 'KPI creditor separate', kpi);

  r = await api('GET', '/api/accounting/overview');
  ok(r.status === 200, 'overview 200');
  ok(Math.abs(Number(r.data.totalReceivable) - expectClose) <= 1, 'overview AR uses per-customer GL', r.data.totalReceivable);
  ok(r.data.books_mismatch !== true, 'overview books match after v2', r.data.books_mismatch);

  db.prepare("DELETE FROM settings WHERE key='customer_books_repair_v2'").run();
  const orphanAmt = 12_000_000;
  postToLedger(db, {
    sourceType: 'manual', sourceId: 880180, date: '1405/05/28',
    description: 'سند دستی یتیم v180', createdBy: admin.id,
    lines: [
      { code: '11030180', name: 'تفصیلی معین v180', debit: rialToLedger(orphanAmt), credit: 0 },
      { code: opening.code, name: opening.name, debit: 0, credit: rialToLedger(orphanAmt) },
    ],
  });
  const v2 = repairGlLinesToLedger(db);
  ok(v2.ledgerFromGl >= 1, 'v2 inserts unmatched GL line', v2);
  const orphan = db.prepare(`
    SELECT debit FROM customer_ledger
    WHERE customer_id=? AND ref_type='manual' AND ref_id=880180
  `).get(custId);
  ok(!!orphan && Number(orphan.debit) === orphanAmt, 'orphan GL line now on customer_ledger', orphan);

  const again = repairGlLinesToLedger(db);
  ok(again.skipped === true, 'v2 repair is idempotent', again);

  const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  ok(appJs.includes('function findInvProduct'), 'addToCart uses findInvProduct');
  ok(appJs.includes('function openNestedModal'), 'nested modal helper present');
  ok(appJs.includes("invoiceFabricRollPicker") && appJs.includes('openNestedModal'), 'roll picker uses nested modal');

  await new Promise((res, rej) => server.close((e) => (e ? rej(e) : res())));
  try { closeSessionStore(); } catch (_) {}
  console.log(fail ? `\n❌ ${pass} ok / ${fail} fail` : `\n✅ ${pass} پاس`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
