#!/usr/bin/env node
'use strict';
/**
 * Phase 0 / v563 — cheque due sync + validation + PATCH due.
 * Run: node server/scripts/test-cheque-due-v563.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const { swAtLeast } = require('./lib/sw-at-least');

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chq-due-v563-'));
const dbFile = path.join(dir, 't.db');
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-cheque-due-v563-secret-32chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

const {
  validateIncomingChequeDue,
  assertChequeDueVsReceive,
} = require('../lib/cheque-due-validate');

console.log('— unit validateIncomingChequeDue');
{
  try {
    assertChequeDueVsReceive({ due: '1405/07/20', receiveDate: '1405/07/26' });
    ok(false, 'due < receive should throw');
  } catch (e) {
    ok(e.code === 'E_CHEQUE_DUE_BEFORE_RECEIVE', 'due < receive → E_CHEQUE_DUE_BEFORE_RECEIVE', e.code);
  }
  try {
    assertChequeDueVsReceive({ due: '1405/07/26', receiveDate: '1405/07/26' });
    ok(false, 'same day without flag should throw');
  } catch (e) {
    ok(e.code === 'E_CHEQUE_DUE_SAME_DAY', 'same day → E_CHEQUE_DUE_SAME_DAY', e.code);
  }
  ok(
    assertChequeDueVsReceive({ due: '1405/07/26', receiveDate: '1405/07/26', allowSameDayDue: true }) === '1405/07/26',
    'same day with flag ok'
  );
  ok(
    assertChequeDueVsReceive({ due: '1405/09/25', receiveDate: '1405/07/26' }) === '1405/09/25',
    'future due ok'
  );
}

(async () => {
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'chq-due-v563', device_fingerprint: 'chq-due-v563-fp',
  }).token;

  const custId = db.prepare(
    'INSERT INTO customers (user_id,biz,phone,balance) VALUES (?,?,?,?)'
  ).run(admin.id, 'مشتری سررسید v563', '09121111111', 0).lastInsertRowid;

  const invId = db.prepare(`
    INSERT INTO invoices (user_id,cust_id,num,date,type,rows,subtotal,final,final_rial,pay_type,pay_splits_json,approved)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,1)
  `).run(
    admin.id, custId, 'T-V563', '1405/07/19', 'final', '[]',
    1000, 1000, 10000000, 'cheque',
    JSON.stringify([
      { pay_type: 'cheque', amount: 5000000, sayadi: '3810050050916587', cheque_number: '519196', cheque_due: '1405/09/25', cheque_bank: 'ملی', cheque_branch: '۱', cheque_account: '1', cheque_owner: 'الف' },
      { pay_type: 'cheque', amount: 5000000, sayadi: '8191050050916588', cheque_number: '519197', cheque_due: '1405/10/25', cheque_bank: 'ملی', cheque_branch: '۱', cheque_account: '1', cheque_owner: 'الف' },
    ])
  ).lastInsertRowid;

  {
    try {
      validateIncomingChequeDue(db, {
        due: '1405/07/26',
        receiveDate: '1405/07/26',
        allowSameDayDue: true,
        invoiceId: invId,
        sayadi: '3810050050916587',
        chequeNumber: '519196',
      });
      ok(false, 'mismatch vs pay_splits should throw');
    } catch (e) {
      ok(e.code === 'E_CHEQUE_DUE_MISMATCH', 'pay_splits mismatch → E_CHEQUE_DUE_MISMATCH', e.code);
    }
    ok(
      validateIncomingChequeDue(db, {
        due: '1405/09/25',
        receiveDate: '1405/07/26',
        invoiceId: invId,
        sayadi: '3810050050916587',
        chequeNumber: '519196',
      }) === '1405/09/25',
      'matching pay_splits due ok'
    );
  }

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

  console.log('— (a) batch two cheques different dues');
  let r = await api('POST', '/api/accounting/settlements/batch', {
    cust_id: custId,
    note: 'v563 batch',
    payments: [
      {
        pay_type: 'cheque', amount: 5000000, date: '1405/07/26', invoice_id: invId,
        cheque_bank: 'ملی', cheque_branch: 'مرکزی', cheque_account: '123',
        cheque_number: '519196', cheque_sayadi: '3810050050916587', cheque_owner: 'الف',
        cheque_due: '1405/09/25', cheque_row: 1,
      },
      {
        pay_type: 'cheque', amount: 5000000, date: '1405/07/26', invoice_id: invId,
        cheque_bank: 'ملی', cheque_branch: 'مرکزی', cheque_account: '123',
        cheque_number: '519197', cheque_sayadi: '8191050050916588', cheque_owner: 'الف',
        cheque_due: '1405/10/25', cheque_row: 2,
      },
    ],
  });
  ok(r.status === 200 && r.data && r.data.created && r.data.created.length === 2, 'batch 2 cheques 200', r.data && r.data.error);
  const dues = db.prepare(`
    SELECT due_date FROM cheque_records
    WHERE customer_id=? AND COALESCE(record_status,'posted')='posted'
    ORDER BY id
  `).all(custId).map((x) => x.due_date);
  ok(dues[0] === '1405/09/25' && dues[1] === '1405/10/25', 'both dues stored correctly', dues);

  console.log('— (b) due < receive → 400');
  r = await api('POST', '/api/accounting/settlements/batch', {
    cust_id: custId,
    payments: [{
      pay_type: 'cheque', amount: 1000, date: '1405/08/01',
      cheque_bank: 'x', cheque_branch: 'y', cheque_account: 'z',
      cheque_number: '999001', cheque_sayadi: '2215300887814712', cheque_owner: 'ب',
      cheque_due: '1405/07/01',
    }],
  });
  ok(r.status === 400 && r.data && r.data.code === 'E_CHEQUE_DUE_BEFORE_RECEIVE', 'due before receive 400', r.data);

  console.log('— (c) mismatch pay_splits → 400');
  r = await api('POST', '/api/accounting/settlements/batch', {
    cust_id: custId,
    payments: [{
      pay_type: 'cheque', amount: 1000, date: '1405/07/26', invoice_id: invId,
      cheque_bank: 'x', cheque_branch: 'y', cheque_account: 'z',
      cheque_number: '519196', cheque_sayadi: '3810050050916587', cheque_owner: 'الف',
      cheque_due: '1405/07/26', allow_same_day_due: true,
    }],
  });
  ok(r.status === 400 && r.data && r.data.code === 'E_CHEQUE_DUE_MISMATCH', 'mismatch 400', r.data);

  console.log('— (d) PATCH due registered ok / cleared 409');
  const chq = db.prepare(`
    SELECT id FROM cheque_records WHERE customer_id=? AND due_date='1405/09/25' LIMIT 1
  `).get(custId);
  ok(!!chq, 'have registered cheque for PATCH');
  r = await api('PATCH', `/api/cheque-records/${chq.id}/due`, {
    due_date: '1405/09/28', reason: 'اصلاح تست v563',
  });
  ok(r.status === 200 && r.data && r.data.due_date === '1405/09/28', 'PATCH due registered', r.data);
  const after = db.prepare('SELECT due_date FROM cheque_records WHERE id=?').get(chq.id);
  ok(after.due_date === '1405/09/28', 'DB due updated');
  const sett = db.prepare(`
    SELECT s.cheque_due FROM settlements s
    JOIN cheque_records cr ON cr.settlement_id=s.id WHERE cr.id=?
  `).get(chq.id);
  ok(sett && sett.cheque_due === '1405/09/28', 'settlement.cheque_due updated', sett);
  const ev = db.prepare(`
    SELECT note FROM cheque_events WHERE cheque_id=? ORDER BY id DESC LIMIT 1
  `).get(chq.id);
  ok(ev && /تغییر سررسید/.test(ev.note || ''), 'cheque_event note', ev);

  db.prepare("UPDATE cheque_records SET lifecycle_status='cleared' WHERE id=?").run(chq.id);
  r = await api('PATCH', `/api/cheque-records/${chq.id}/due`, {
    due_date: '1405/11/01', reason: 'should fail',
  });
  ok(r.status === 409 && r.data && r.data.code === 'E_CHEQUE_DUE_LOCKED', 'PATCH cleared → 409', r.data);

  console.log('— (e) amend keeps due from split (no header fallback)');
  const { insertInvoiceSettlement } = require('../lib/invoice-payments');
  const sid = insertInvoiceSettlement(db, {
    userId: admin.id,
    custId,
    invoiceId: invId,
    split: {
      pay_type: 'cheque', amount: 111000,
      cheque_due: '1405/11/11',
      cheque_bank: 'سپه', cheque_branch: 'الف', cheque_account: '9',
      cheque_number: '888001', sayadi: '2215300887814999', cheque_owner: 'ج',
    },
    date: '1405/08/01',
    note: 'amend-path',
    chequeHeader: { cheque_due_date: '1405/01/01', cheque_info: 'header' },
    skipJournal: true,
  });
  const leaf = db.prepare('SELECT due_date FROM cheque_records WHERE settlement_id=?').get(sid);
  ok(leaf && leaf.due_date === '1405/11/11', 'insertInvoiceSettlement uses split due not header', leaf);

  console.log('— (f) encoding + static UI guards');
  const enc = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'test-public-encoding.js')], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8',
  });
  ok(enc.status === 0, 'encoding guard exit 0', enc.stderr || enc.stdout);

  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  ok(/function stlAddCheque\(\)\{\s*stlSyncChequesFromDom\(\)/.test(appJs), 'stlAddCheque syncs DOM first');
  ok(/function stlRemoveCheque\(i\)\{\s*stlSyncChequesFromDom\(\)/.test(appJs), 'stlRemoveCheque syncs DOM first');
  ok(/function stlNewCheque\(\)\{ return \{[^}]*due:''/.test(appJs), 'stlNewCheque due empty');
  ok(/function prrNewCheque\(\)\{ return \{[^}]*due:''/.test(appJs), 'prrNewCheque due empty');
  ok(/if\(row\.cheque_due==null\) row\.cheque_due=''/.test(appJs), 'invPayEnsureChequeDefaults due empty');
  ok(/dispatchEvent\(new Event\('input',\{bubbles:true\}\)\)/.test(appJs), 'jdate dispatches input+change');
  ok(/chequeFixDueModal|PATCH.*\/due|اصلاح سررسید/.test(appJs), 'UI اصلاح سررسید present');

  const swSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  ok(swAtLeast(swSrc, 563), 'SW >= v563');

  server.close();
  try { closeSessionStore(); } catch (_) {}
  console.log(`\ntest-cheque-due-v563: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
