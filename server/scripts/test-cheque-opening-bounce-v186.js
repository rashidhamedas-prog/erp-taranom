/**
 * v186 — bouncing an opening receivable cheque debits customer tafsili
 * so the statement closing increases by the cheque amount.
 * Run: node server/scripts/test-cheque-opening-bounce-v186.js
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chq-bounce-v186-'));
const dbFile = path.join(dir, 't.db');
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-cheque-opening-bounce-v186-secret32';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const { acct } = require('../lib/coa-map');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
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
      AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
  `).get(accountCode, sourceType, sourceId);
  return { debit: Number(row.debit), credit: Number(row.credit) };
}

(async () => {
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'chq-v186', device_fingerprint: 'chq-v186-fp',
  }).token;

  const recv = acct(db, 'coa_receivable');
  const notes = acct(db, 'coa_cheques_receivable');
  const tafsili = '1103v186';
  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES (?,?,?,?,?,1)
  `).run(tafsili, 'تفصیلی چک برگشت v186', 'asset', recv.code, 4);

  const custId = db.prepare(
    'INSERT INTO customers (user_id,biz,phone,coa_code,balance) VALUES (?,?,?,?,?)'
  ).run(admin.id, 'مشتری چک اول دوره v186', '09025051860', tafsili, 0).lastInsertRowid;
  const partyId = db.prepare(`
    INSERT INTO parties (person_code, party_type, full_name, phone, is_active, legacy_table, legacy_id, coa_code)
    VALUES ('P-V186','customer','مشتری چک اول دوره v186','09025051860',1,'customers',?,?)
  `).run(custId, tafsili).lastInsertRowid;
  db.prepare('UPDATE customers SET party_id=? WHERE id=?').run(partyId, custId);

  const bankCoa = acct(db, 'coa_bank_default');
  const bankId = db.prepare(`
    INSERT INTO banks (name, account_number, active, coa_code) VALUES ('بانک وصول v186','1860',1,?)
  `).run(bankCoa.code).lastInsertRowid;

  const AMT = 150_000_000;

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
    direction: 'in', cheque_number: '975153', amount: AMT, opening: true,
    party_id: partyId, party_name: 'مشتری چک اول دوره v186',
    due_date: '1405/06/12', note: 'مانده اول دوره',
  });
  ok(r.status === 200 && r.data && r.data.id, 'create opening cheque', r.data && r.data.error);
  const chequeId = r.data.id;

  r = await api('GET', '/api/accounting/statement/' + custId);
  ok(r.status === 200, 'statement before bounce 200');
  const closeBefore = Number(r.data.closing) || 0;

  r = await api('POST', `/api/cheque-records/${chequeId}/send-to-bank`, {
    collection_bank_id: bankId, date: '1405/06/12',
  });
  ok(r.status === 200 && r.data && r.data.lifecycle_status === 'in_collection', 'send to bank', r.data && r.data.error);

  r = await api('POST', `/api/cheque-records/${chequeId}/clear`, { date: '1405/06/12' });
  ok(r.status === 200 && r.data && r.data.lifecycle_status === 'cleared', 'clear opening cheque', r.data && r.data.error);

  r = await api('GET', '/api/accounting/statement/' + custId);
  ok(Math.abs(Number(r.data.closing) - closeBefore) <= 1, 'clear does not change customer GL', r.data.closing);

  r = await api('POST', `/api/cheque-records/${chequeId}/bounce`, { date: '1405/06/12' });
  ok(r.status === 200 && r.data && r.data.lifecycle_status === 'bounced', 'bounce opening cheque', r.data && r.data.error);

  const taf = jeNetRial(tafsili, 'cheque_bounce', chequeId);
  ok(taf.debit === AMT && taf.credit === 0, 'bounce JE Dr customer tafsili', taf);
  const notesBounce = jeNetRial(notes.code, 'cheque_bounce', chequeId);
  ok(notesBounce.debit === 0 && notesBounce.credit === 0, 'bounce does not Dr notes receivable', notesBounce);
  const bankBounce = jeNetRial(bankCoa.code, 'cheque_bounce', chequeId);
  ok(bankBounce.credit === AMT, 'bounce Cr collection bank', bankBounce);

  const led = db.prepare(`
    SELECT debit, credit FROM customer_ledger
    WHERE customer_id=? AND ref_type='cheque_bounce' AND ref_id=? AND entry_type<>'reversal'
  `).get(custId, chequeId);
  ok(led && Number(led.debit) === AMT && Number(led.credit) === 0, 'customer_ledger bounce debit', led);

  r = await api('GET', '/api/accounting/statement/' + custId);
  ok(r.status === 200 && r.data.source === 'gl', 'statement source gl after bounce', r.data.source);
  ok(Math.abs(Number(r.data.closing) - AMT) <= 1, 'statement closing += bounced amount', r.data.closing);
  const bounceRow = (r.data.entries || []).find((e) =>
    (e.raw_ref_type === 'cheque_bounce' || e.ref_type === 'cheque_bounce')
    && Number(e.ref_id) === Number(chequeId)
  );
  ok(!!bounceRow && Number(bounceRow.debit) === AMT, 'statement shows bounce debit row', bounceRow);
  ok(bounceRow && bounceRow.type_label === 'برگشت چک', 'statement label برگشت چک', bounceRow && bounceRow.type_label);

  r = await api('POST', `/api/cheque-records/${chequeId}/resend`, { date: '1405/06/13' });
  ok(r.status === 200 && r.data && r.data.lifecycle_status === 'cleared', 'resend restores cleared', r.data && r.data.error);
  r = await api('GET', '/api/accounting/statement/' + custId);
  ok(Math.abs(Number(r.data.closing) - closeBefore) <= 1, 'resend removes bounce from statement', r.data.closing);
  const bounceRev = db.prepare(`
    SELECT 1 AS ok FROM customer_ledger
    WHERE customer_id=? AND ref_type='cheque_bounce' AND ref_id=? AND entry_type='reversal'
  `).get(custId, chequeId);
  ok(!!bounceRev, 'resend reverses bounce ledger');

  const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  ok(appJs.includes('به بدهی طرف حساب در صورت‌حساب اضافه می‌شود'), 'bounce confirm mentions statement');
  ok(appJs.includes('برگشت مبلغ را به بدهی صورت‌حساب'), 'opening tab hint');
  const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  ok(sw.includes('erp-taranom-v186'), 'SW v186');

  try { new Function(appJs); ok('app.js parses', true); }
  catch (e) { ok('app.js parses', false, e.message); }

  await new Promise((res, rej) => server.close((e) => (e ? rej(e) : res())));
  try { closeSessionStore(); } catch (_) {}
  console.log(fail ? `\n❌ ${pass} ok / ${fail} fail` : `\n✅ ${pass} پاس`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
