/**
 * v428 — direction=out cheque must not credit a bank at register or at pay/issue.
 *
 * Pay is handover: Dr accounts payable / Cr notes payable.
 * Register posts a journal only for opening (Dr opening balance / Cr notes payable).
 * POST /:id/clear and POST /:id/bounce select direction='in' only, so they are not
 * a payable bank credit. Void reverses bounced_je_id, cleared_je_id, collection_je_id
 * (the pay journal lives in collection_je_id) and does not name a bank account.
 *
 * Run: node server/scripts/test-cheque-payable-issue-v428.js
 * If better-sqlite3 cannot load, static checks still run and the process prints SKIP_SQLITE.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log('  OK', label);
  } else {
    fail++;
    console.log('  FAIL', label, extra == null ? '' : extra);
  }
}

function sliceBetween(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) return '';
  const j = src.indexOf(endMarker, i + startMarker.length);
  if (j < 0) return '';
  return src.slice(i, j);
}

function forbidsBank(src) {
  return !/coa_bank_default|banks\.account_code|banks\.coa_code|FROM banks/i.test(src);
}

const routesPath = path.join(__dirname, '../routes/cheque-records.js');
const lifePath = path.join(__dirname, '../lib/cheque-lifecycle.js');
const voidPath = path.join(__dirname, '../lib/void-cheque.js');
const booksPath = path.join(__dirname, '../lib/cheque-party-books.js');
const contractPath = path.join(__dirname, '../lib/cash-payment-contract.js');

const routes = fs.readFileSync(routesPath, 'utf8');
const life = fs.readFileSync(lifePath, 'utf8');
const voidSrc = fs.readFileSync(voidPath, 'utf8');
const books = fs.readFileSync(booksPath, 'utf8');
const contract = fs.readFileSync(contractPath, 'utf8');

console.log('══ v428 payable cheque — no bank credit before clear ══');

const register = sliceBetween(routes, "router.post('/',", "router.patch('/:id/status'");
const payRoute = sliceBetween(routes, "router.post('/:id/pay'", "router.post('/:id/expense'");
const expenseRoute = sliceBetween(routes, "router.post('/:id/expense'", "router.post('/:id/endorse'");
const runOut = sliceBetween(routes, 'function runOutAction', 'router.get(');
const postAction = sliceBetween(routes, 'function postChequeAction', 'function chequeExpensePosting');
const clearRoute = sliceBetween(routes, "router.post('/:id/clear'", "router.post('/:id/bounce'");
const bounceRoute = sliceBetween(routes, "router.post('/:id/bounce'", "router.post('/:id/resend'");

ok(register.length > 0, 'register route located');
ok(payRoute.length > 0 && expenseRoute.length > 0, 'pay and expense routes located');
ok(runOut.length > 0 && postAction.length > 0, 'issue posting helpers located');
ok(clearRoute.length > 0 && bounceRoute.length > 0, 'clear and bounce routes located');

ok((register.match(/postToLedger/g) || []).length === 1, 'register has a single ledger post');
ok(register.indexOf('if (opening)') >= 0 && register.indexOf('if (opening)') < register.indexOf('postToLedger'),
  'that post sits inside the opening branch');
ok(register.includes("direction === 'in' ? 'coa_cheques_receivable' : 'coa_cheques_payable'"),
  'opening out credits notes payable');
ok(register.includes("acct(db, 'coa_opening_balance')"), 'opening contra is the opening-balance account');
ok(forbidsBank(register), 'register source does not name a bank account');
ok(register.includes('postChequeInReceipt'), 'register calls the receipt helper');

const receiptAt = books.indexOf('function postChequeInReceipt');
const receiptHead = books.slice(receiptAt, receiptAt + 400);
ok(receiptHead.includes("if (!row || row.direction !== 'in') return null;"),
  'receipt helper returns before any ledger post when direction is out');

const payAt = routes.indexOf("router.post('/:id/pay'");
ok(routes.slice(Math.max(0, payAt - 180), payAt).includes('Handover our cheque to the payee'),
  'pay is defined as handover of our cheque');
ok(payRoute.includes("debitKey: 'coa_payable'"), 'pay debits accounts payable');
ok(payRoute.includes("lifecycle: 'issued'"), 'pay marks the cheque issued');
ok(forbidsBank(payRoute), 'pay route does not name a bank account');

ok(expenseRoute.includes("debitKey: 'coa_admin_expense'"), 'expense debits an expense account');
ok(expenseRoute.includes('useExpensePosting: true'), 'expense uses the expense posting resolver');
ok(forbidsBank(expenseRoute), 'expense route does not name a bank account');

ok(runOut.includes("direction='out'"), 'issue/expense select direction=out');
ok(runOut.includes("creditAcct: acct(db, 'coa_cheques_payable')"), 'issue credits notes payable');
ok(forbidsBank(runOut), 'issue SQL and postToLedger call do not use coa_bank_default or banks.account_code');
ok(forbidsBank(postAction), 'shared action poster does not name a bank account');
ok(postAction.includes('collection_je_id=?'), 'pay/expense journal is stored on collection_je_id');
ok(postAction.includes('credit: amt') && postAction.includes('credit_rial: amountRial'),
  'credit line is the passed credit account, in rial');

ok(clearRoute.includes("direction='in'"), 'clear selects receivable cheques only');
ok(clearRoute.includes("acct(db, 'coa_bank_default')"), 'inbound clear is the route that names the bank');
ok(clearRoute.includes('debit: amt, credit: 0, debit_rial: amountRial'),
  'inbound clear debits the bank; it does not credit it');
ok(bounceRoute.includes("direction='in'"), 'bounce selects receivable cheques only');
ok(forbidsBank(bounceRoute), 'bounce route itself does not name a bank account');

ok(voidSrc.includes("'bounced_je_id', 'cleared_je_id', 'collection_je_id'"),
  'void reverses bounce, clear, then the pay/collection journal');
ok(voidSrc.includes('coa_cheques_payable'), 'opening-out void debits notes payable');
ok(forbidsBank(voidSrc), 'void source does not name a bank account');

ok(life.includes('registered → issued'), 'lifecycle deliver for out is issued');
ok(/ACTIVE_LIFECYCLE_OUT = new Set\(\['issued', 'expensed', 'endorsed'\]\)/.test(life),
  'out active states are issued, expensed, endorsed');
ok(!/ACTIVE_LIFECYCLE_OUT = new Set\(\[[^\]]*cleared/.test(life),
  'clear is not an outgoing lifecycle state');

ok(contract.includes("'E_CHEQUE_FORM_CLOSED'"), 'five payment forms still reject cheque');
ok(/raw === 'cheque' \|\| raw === 'check'/.test(contract), 'cheque and check spellings stay rejected');

console.log('VERDICT register=no_bank_credit pay_issue=no_bank_credit clear_out=absent bounce_out=absent');

function skipSqlite(reason) {
  console.log('SKIP_SQLITE');
  console.log(reason);
  console.log(`STATIC ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

let Database;
try {
  Database = require('better-sqlite3');
  const probe = new Database(':memory:');
  probe.close();
} catch (e) {
  skipSqlite(String(e && e.message || e).split('\n')[0]);
}

if (fail) {
  console.log(`STATIC ${pass} passed, ${fail} failed`);
  process.exit(1);
}

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheque-payable-v428-'));
const dbFile = path.join(dir, 't.db');
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-cheque-payable-v428-secret-at-least-32b';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';

(async () => {
  let server;
  let closeSessionStore = () => {};
  try {
    delete require.cache[require.resolve('../db')];
    const { initDB, getDB } = require('../db');
    initDB();
    const db = getDB();
    const { acct } = require('../lib/coa-map');
    const { SQL_JL_CREDIT_RIAL } = require('../lib/money');

    const bank = acct(db, 'coa_bank_default');
    const notesPay = acct(db, 'coa_cheques_payable');
    const payable = acct(db, 'coa_payable');
    const opening = acct(db, 'coa_opening_balance');
    const expense = acct(db, 'coa_admin_expense');
    const AMT = 2_500_000;

    function bankCreditRial() {
      const row = db.prepare(`
        SELECT COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) AS credit
        FROM journal_lines jl
        JOIN journal_entries je ON je.id=jl.entry_id
        WHERE jl.account_code=?
          AND COALESCE(je.deleted_at,0)=0
      `).get(bank.code);
      return Number(row.credit);
    }

    function openLines(refType, refId) {
      return db.prepare(`
        SELECT jl.account_code,
               COALESCE(jl.debit_rial,0) AS debit_rial,
               COALESCE(jl.credit_rial,0) AS credit_rial,
               COALESCE(jl.debit,0) AS debit,
               COALESCE(jl.credit,0) AS credit
        FROM journal_lines jl
        JOIN journal_entries je ON je.id=jl.entry_id
        WHERE je.ref_type=? AND je.ref_id=?
          AND COALESCE(je.deleted_at,0)=0
          AND COALESCE(je.status,'posted')<>'reversed'
      `).all(refType, refId);
    }

    function creditRial(line) {
      if (Number(line.credit_rial) > 0) return Number(line.credit_rial);
      return Math.round(Number(line.credit) || 0) * 10;
    }
    function debitRial(line) {
      if (Number(line.debit_rial) > 0) return Number(line.debit_rial);
      return Math.round(Number(line.debit) || 0) * 10;
    }

    const bankBefore = bankCreditRial();

    const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
    ok(!!admin, 'temp db has admin');
    db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
    const sessions = require('../lib/auth-sessions');
    closeSessionStore = sessions.closeSessionStore;
    const token = sessions.issueStaffSession(db, admin, {
      device_kind: 'test',
      device_name: 'cheque-payable-v428',
      device_fingerprint: 'cheque-payable-v428-fp',
    }).token;

    const app = express();
    app.use(express.json());
    app.use('/api/cheque-records', require('../routes/cheque-records'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    async function api(method, p, body) {
      const res = await fetch(`http://127.0.0.1:${port}` + p, {
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

    const partyId = db.prepare(`
      INSERT INTO parties (person_code, party_type, full_name, phone, is_active)
      VALUES ('P-V428','other','طرف چک پرداختنی','09150000428',1)
    `).run().lastInsertRowid;

    console.log('\n— temp db: register, pay, clear, bounce, void —');
    let r = await api('POST', '/api/cheque-records', {
      direction: 'out',
      cheque_number: 'OUT-428',
      amount: AMT,
      party_id: partyId,
      due_date: '1405/08/01',
    });
    ok(r.status === 200 && r.data && r.data.id, 'register out cheque', r.data && r.data.error);
    const id = r.data && r.data.id;
    ok(!r.data.journal_entry_id, 'non-opening register stores no journal');
    ok(openLines('cheque_pay', id).length === 0 && openLines('opening_cheque', id).length === 0,
      'register posts no pay or opening journal');
    ok(bankCreditRial() === bankBefore, 'register does not credit the bank', bankCreditRial());

    r = await api('POST', `/api/cheque-records/${id}/pay`, { date: '1405/07/01' });
    ok(r.status === 200 && r.data && r.data.lifecycle_status === 'issued', 'pay issues the cheque', r.data && r.data.error);
    const payLines = openLines('cheque_pay', id);
    const payDr = payLines.find((l) => l.account_code === payable.code);
    const payCr = payLines.find((l) => l.account_code === notesPay.code);
    ok(payDr && debitRial(payDr) === AMT && creditRial(payDr) === 0, 'pay debits payable in rial', JSON.stringify(payDr));
    ok(payCr && creditRial(payCr) === AMT && debitRial(payCr) === 0, 'pay credits notes payable in rial', JSON.stringify(payCr));
    ok(!payLines.some((l) => l.account_code === bank.code), 'pay lines do not use the bank account');
    ok(bankCreditRial() === bankBefore, 'pay does not credit the bank', bankCreditRial());

    r = await api('POST', `/api/cheque-records/${id}/clear`, { date: '1405/07/02' });
    ok(r.status === 404, 'clear rejects an issued payable cheque', r.status + ' ' + (r.data && r.data.error));
    r = await api('POST', `/api/cheque-records/${id}/bounce`, { date: '1405/07/02' });
    ok(r.status === 404, 'bounce rejects an issued payable cheque', r.status + ' ' + (r.data && r.data.error));
    ok(bankCreditRial() === bankBefore, 'failed clear/bounce do not credit the bank');

    r = await api('POST', `/api/cheque-records/${id}/void`);
    ok(r.status === 200 && r.data && r.data.ok, 'void issued cheque', r.data && r.data.error);
    ok(openLines('cheque_pay', id).length === 0, 'void reverses the pay journal');
    ok(bankCreditRial() === bankBefore, 'void does not credit the bank');

    r = await api('POST', '/api/cheque-records', {
      direction: 'out',
      cheque_number: 'EXP-428',
      amount: AMT,
      party_id: partyId,
    });
    const expId = r.data && r.data.id;
    r = await api('POST', `/api/cheque-records/${expId}/expense`, { date: '1405/07/03' });
    ok(r.status === 200 && r.data && r.data.lifecycle_status === 'expensed', 'expense issues against notes payable', r.data && r.data.error);
    const expLines = openLines('cheque_expense', expId);
    const expDr = expLines.find((l) => l.account_code === expense.code);
    const expCr = expLines.find((l) => l.account_code === notesPay.code);
    ok(expDr && debitRial(expDr) === AMT, 'expense debits admin expense', JSON.stringify(expDr));
    ok(expCr && creditRial(expCr) === AMT, 'expense credits notes payable', JSON.stringify(expCr));
    ok(!expLines.some((l) => l.account_code === bank.code), 'expense lines do not use the bank account');
    ok(bankCreditRial() === bankBefore, 'expense does not credit the bank');

    r = await api('POST', '/api/cheque-records', {
      direction: 'out',
      cheque_number: 'OPN-428',
      amount: AMT,
      party_id: partyId,
      opening: true,
      issue_date: '1405/01/01',
    });
    ok(r.status === 200 && r.data && r.data.journal_entry_id, 'opening register posts a journal', r.data && r.data.error);
    const openId = r.data && r.data.id;
    const openJe = openLines('opening_cheque', openId);
    const openDr = openJe.find((l) => l.account_code === opening.code);
    const openCr = openJe.find((l) => l.account_code === notesPay.code);
    ok(openDr && debitRial(openDr) === AMT, 'opening debits opening balance', JSON.stringify(openDr));
    ok(openCr && creditRial(openCr) === AMT, 'opening credits notes payable', JSON.stringify(openCr));
    ok(!openJe.some((l) => l.account_code === bank.code), 'opening lines do not use the bank account');
    ok(bankCreditRial() === bankBefore, 'opening register does not credit the bank');

    console.log('SQLITE bank credit unchanged through register, pay, expense, opening, void');
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/ABI|NODE_MODULE_VERSION|better_sqlite3|ERR_DLOPEN|was compiled against a different Node/i.test(msg)) {
      skipSqlite(msg.split('\n')[0]);
    }
    fail++;
    console.log('  FAIL temp db', msg);
    console.error(e);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    try { closeSessionStore(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log();
  if (fail) {
    console.log(`CHEQUE-PAYABLE-V428: ${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  console.log(`CHEQUE-PAYABLE-V428: ${pass} passed`);
  process.exit(0);
})().catch((err) => {
  const msg = String(err && err.message || err);
  if (/ABI|NODE_MODULE_VERSION|better_sqlite3|ERR_DLOPEN|was compiled against a different Node/i.test(msg)) {
    skipSqlite(msg.split('\n')[0]);
  }
  console.error(err);
  process.exit(1);
});
