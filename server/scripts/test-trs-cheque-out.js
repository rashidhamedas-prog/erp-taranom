/**
 * TRS-01 — payable/out cheque pay · expense · endorse + R13 cancel.
 * Also guards TRS-02 pay-tab default direction=out.
 * Run: node server/scripts/test-trs-cheque-out.js
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trs-cheque-out-'));
const dbFile = path.join(dir, 't.db');
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-trs-cheque-out-secret-at-least-32b';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';

delete require.cache[require.resolve('../db')];
try { delete require.cache[require.resolve('../lib/coa-map')]; } catch (_) {}

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const { acct } = require('../lib/coa-map');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra == null ? '' : extra); }
}

function jeNetRial(accountCode, sourceType, sourceId) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) AS debit,
      COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) AS credit
    FROM journal_lines jl
    JOIN journal_entries je ON jl.entry_id=je.id
    WHERE jl.account_code=?
      AND je.ref_type=? AND je.ref_id=?
      AND COALESCE(je.deleted_at,0)=0
      AND COALESCE(je.status,'posted')<>'reversed'
  `).get(accountCode, sourceType, sourceId);
  return { debit: Number(row.debit), credit: Number(row.credit) };
}

function accountCreditOpenRial(accountCode) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) AS credit
    FROM journal_lines jl
    JOIN journal_entries je ON jl.entry_id=je.id
    WHERE jl.account_code=?
      AND COALESCE(je.deleted_at,0)=0
      AND COALESCE(je.status,'posted')<>'reversed'
  `).get(accountCode);
  return Number(row.credit);
}

/** Original + reversal (non-deleted) must net to zero after R13 cancel. */
function chequeAccountNetAll(accountCode, chequeId) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) AS debit,
      COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) AS credit
    FROM journal_lines jl
    JOIN journal_entries je ON jl.entry_id=je.id
    WHERE jl.account_code=?
      AND je.ref_id=?
      AND COALESCE(je.deleted_at,0)=0
  `).get(accountCode, chequeId);
  return Number(row.debit) - Number(row.credit);
}

(async () => {
  console.log('══ TRS-01 payable cheque lifecycle ══');

  const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  ok(/payNav\s*\?\s*'out'/.test(appJs), 'TRS-02: pay tab still defaults direction=out');
  ok(/accNavId==='acc-cheques-pay'/.test(appJs), 'TRS-02: pay nav id still wired');
  ok(/cheque-records\/.*\/pay/.test(appJs) || /chequePayOut/.test(appJs), 'pay-tab UI calls /pay');

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test',
    device_name: 'trs-cheque-out',
    device_fingerprint: 'trs-cheque-out-fp',
  }).token;

  const app = express();
  app.use(express.json());
  app.use('/api/cheque-records', require('../routes/cheque-records'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const BASE = `http://127.0.0.1:${port}`;

  async function api(method, p, body) {
    const res = await fetch(BASE + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }

  const payable = acct(db, 'coa_payable');
  const notesPay = acct(db, 'coa_cheques_payable');
  const notesRecv = acct(db, 'coa_cheques_receivable');
  const expense = acct(db, 'coa_admin_expense');
  const AMT = 2_500_000;
  const partyId = db.prepare(`
    INSERT INTO parties (person_code, party_type, full_name, phone, is_active)
    VALUES ('P-TRS01','other','طرف چک تست','09151118801',1)
  `).run().lastInsertRowid;

  // ── Happy path: pay ──
  console.log('\n— pay (issue to payee) —');
  let r = await api('POST', '/api/cheque-records', {
    direction: 'out',
    cheque_number: 'PAY-001',
    amount: AMT,
    party_id: partyId,
    party_name: 'تأمین‌کننده تست',
    due_date: '1405/06/01',
  });
  ok(r.status === 200 && r.data?.id, 'create out cheque', r.data?.error);
  const payId = r.data.id;

  r = await api('GET', '/api/cheque-records?direction=out');
  ok(r.status === 200 && (r.data || []).some((x) => x.id === payId),
    'list direction=out includes new cheque');

  r = await api('POST', `/api/cheque-records/${payId}/pay`, { date: '1405/04/01' });
  ok(r.status === 200 && r.data?.lifecycle_status === 'issued', 'pay → issued', r.data?.error);
  ok(!!r.data?.journal_entry_id, 'pay posts JE');

  const payAp = jeNetRial(payable.code, 'cheque_pay', payId);
  const payNp = jeNetRial(notesPay.code, 'cheque_pay', payId);
  ok(payAp.debit === AMT && payAp.credit === 0, 'pay Dr payable (rial)', JSON.stringify(payAp));
  ok(payNp.credit === AMT && payNp.debit === 0, 'pay Cr notes payable (rial)', JSON.stringify(payNp));

  // ── Illegal transitions ──
  console.log('\n— reject illegal transitions —');
  r = await api('POST', `/api/cheque-records/${payId}/pay`, { date: '1405/04/02' });
  ok(r.status === 400 && r.data?.code === 'E_CHEQUE_LIFECYCLE', 'second pay rejected', r.data?.code);
  r = await api('POST', `/api/cheque-records/${payId}/expense`, { date: '1405/04/02' });
  ok(r.status === 400 && r.data?.code === 'E_CHEQUE_LIFECYCLE', 'expense after pay rejected', r.data?.code);
  r = await api('POST', `/api/cheque-records/${payId}/send-to-bank`, { date: '1405/04/02' });
  ok(r.status === 404 || r.data?.code === 'E_CHEQUE_LIFECYCLE', 'send-to-bank on out rejected');
  r = await api('PATCH', `/api/cheque-records/${payId}/status`, { status: 'پرداخت‌شده دستی' });
  ok(r.status === 400 && r.data?.code === 'E_CHEQUE_USE_LIFECYCLE', 'free-text pay status blocked', r.data?.code);

  // ── Expense / endorse (out) ──
  console.log('\n— expense / endorse —');
  r = await api('POST', '/api/cheque-records', {
    direction: 'out', cheque_number: 'EXP-001', amount: AMT, party_id: partyId, party_name: 'هزینه تست',
  });
  const expId = r.data.id;
  r = await api('POST', `/api/cheque-records/${expId}/expense`, { date: '1405/04/03' });
  ok(r.status === 200 && r.data?.lifecycle_status === 'expensed', 'expense → expensed', r.data?.error);
  const expDr = jeNetRial(expense.code, 'cheque_expense', expId);
  const expCr = jeNetRial(notesPay.code, 'cheque_expense', expId);
  ok(expDr.debit === AMT, 'expense Dr admin expense', JSON.stringify(expDr));
  ok(expCr.credit === AMT, 'expense Cr notes payable', JSON.stringify(expCr));

  r = await api('POST', '/api/cheque-records', {
    direction: 'out', cheque_number: 'END-OUT', amount: AMT, party_id: partyId, party_name: 'خرج تست',
  });
  const endOutId = r.data.id;
  r = await api('POST', `/api/cheque-records/${endOutId}/endorse`, {
    date: '1405/04/04',
    account_key: 'coa_sales_expense',
  });
  ok(r.status === 200 && r.data?.lifecycle_status === 'endorsed', 'out endorse → endorsed', r.data?.error);
  const salesExp = acct(db, 'coa_sales_expense');
  const endDr = jeNetRial(salesExp.code, 'cheque_endorse', endOutId);
  ok(endDr.debit === AMT, 'endorse uses acct(account_key)', JSON.stringify(endDr));

  r = await api('POST', `/api/cheque-records/${endOutId}/endorse`, {
    date: '1405/04/04',
    account_key: 'not_a_real_coa_key',
  });
  ok(r.status === 400 && (r.data?.code === 'E_CHEQUE_ACCOUNT' || r.data?.code === 'E_CHEQUE_LIFECYCLE'),
    'bad account_key or already endorsed', r.data?.code);

  r = await api('POST', '/api/cheque-records', {
    direction: 'out', cheque_number: 'BAD-KEY', amount: AMT, party_id: partyId, party_name: 'کلید بد',
  });
  const badId = r.data.id;
  r = await api('POST', `/api/cheque-records/${badId}/expense`, {
    date: '1405/04/05',
    account_key: 'not_a_real_coa_key',
  });
  ok(r.status === 400 && r.data?.code === 'E_CHEQUE_ACCOUNT', 'unknown account_key rejected', r.data?.code);

  // ── Endorse received cheque (خرج دریافتنی) ──
  r = await api('POST', '/api/cheque-records', {
    direction: 'in', cheque_number: 'END-IN', amount: AMT, party_id: partyId, party_name: 'مشتری تست',
  });
  const endInId = r.data.id;
  r = await api('POST', `/api/cheque-records/${endInId}/endorse`, { date: '1405/04/06' });
  ok(r.status === 200 && r.data?.lifecycle_status === 'endorsed', 'in endorse → endorsed', r.data?.error);
  const inAp = jeNetRial(payable.code, 'cheque_endorse', endInId);
  const inNr = jeNetRial(notesRecv.code, 'cheque_endorse', endInId);
  ok(inAp.debit === AMT, 'in endorse Dr payable', JSON.stringify(inAp));
  ok(inNr.credit === AMT, 'in endorse Cr notes receivable', JSON.stringify(inNr));
  r = await api('POST', `/api/cheque-records/${endInId}/send-to-bank`, { date: '1405/04/07' });
  ok(r.status === 400 && r.data?.code === 'E_CHEQUE_LIFECYCLE', 'send-to-bank after endorse rejected', r.data?.code);

  // ── Cancel reverses JE (R13) ──
  console.log('\n— cancel reverses JE —');
  const npBefore = accountCreditOpenRial(notesPay.code);
  ok(npBefore === AMT * 3, 'three out actions credit NP', npBefore);
  r = await api('POST', `/api/cheque-records/${payId}/cancel`);
  ok(r.status === 200 && r.data?.ok, 'cancel pay cheque', r.data?.error);
  const payAfter = jeNetRial(notesPay.code, 'cheque_pay', payId);
  ok(payAfter.debit === 0 && payAfter.credit === 0, 'pay JE excluded after reverse', JSON.stringify(payAfter));
  ok(chequeAccountNetAll(notesPay.code, payId) === 0, 'cancel nets NP to zero (incl. reversal)', chequeAccountNetAll(notesPay.code, payId));
  ok(chequeAccountNetAll(payable.code, payId) === 0, 'cancel nets AP to zero (incl. reversal)', chequeAccountNetAll(payable.code, payId));
  ok(accountCreditOpenRial(notesPay.code) === AMT * 2, 'open NP credit left on remaining two', accountCreditOpenRial(notesPay.code));
  r = await api('GET', '/api/cheque-records?direction=out');
  ok(!(r.data || []).some((x) => x.id === payId), 'cancelled cheque hidden from list');
  r = await api('POST', `/api/cheque-records/${payId}/cancel`);
  ok(r.status === 400, 'second cancel rejected');

  r = await api('POST', '/api/cheque-records', {
    direction: 'out', cheque_number: 'VOID-DEL', amount: AMT, party_id: partyId, party_name: 'حذف منطقی',
  });
  const delId = r.data.id;
  await api('POST', `/api/cheque-records/${delId}/pay`, { date: '1405/04/08' });
  r = await api('DELETE', `/api/cheque-records/${delId}`);
  ok(r.status === 200 && r.data?.ok, 'DELETE is void not physical');
  const stillThere = db.prepare('SELECT record_status FROM cheque_records WHERE id=?').get(delId);
  ok(stillThere && stillThere.record_status === 'reversed', 'row remains reversed', stillThere?.record_status);

  // opening out cannot pay
  r = await api('POST', '/api/cheque-records', {
    direction: 'out', cheque_number: 'OPEN-1', amount: AMT, party_id: partyId, party_name: 'افتتاحیه', opening: true,
    issue_date: '1405/01/01',
  });
  ok(r.status === 200 && r.data?.journal_entry_id, 'opening out still posts JE');
  r = await api('POST', `/api/cheque-records/${r.data.id}/pay`, { date: '1405/04/09' });
  ok(r.status === 400 && r.data?.code === 'E_CHEQUE_LIFECYCLE', 'opening out cannot pay again', r.data?.error);

  server.close();
  try { closeSessionStore(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

  console.log();
  if (fail) {
    console.log(`TRS-CHEQUE-OUT: ${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  console.log(`TRS-CHEQUE-OUT: ${pass} passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
