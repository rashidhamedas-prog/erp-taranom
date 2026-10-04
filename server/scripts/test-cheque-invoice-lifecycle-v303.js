/**
 * v303 — Invoice-created cheques must use lifecycle registered (نزد صندوق)
 * so واگذاری/خرج work. Legacy in_hand alias + free-text «خواباندن» repair.
 * Run: node server/scripts/test-cheque-invoice-lifecycle-v303.js
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheque-inv-lc-v303-'));
const dbFile = path.join(dir, 't.db');
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-cheque-invoice-lifecycle-v303-secret-32b';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';

delete require.cache[require.resolve('../db')];
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const { acct } = require('../lib/coa-map');
const {
  isRegistered, normalizeLifecycle, repairChequeLifecycleAliases, FINANCIAL_STATUS_RE,
} = require('../lib/cheque-lifecycle');
const { applyInvoicePaySplits } = require('../lib/invoice-payments');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra == null ? '' : extra); }
}

(async () => {
  console.log('══ cheque invoice lifecycle v303 ══');

  ok(isRegistered({ lifecycle_status: 'in_hand' }), 'isRegistered(in_hand)');
  ok(isRegistered({ lifecycle_status: 'registered' }), 'isRegistered(registered)');
  ok(isRegistered({ lifecycle_status: '' }), 'isRegistered(empty)');
  ok(!isRegistered({ lifecycle_status: 'in_collection' }), 'not registered when in_collection');
  ok(normalizeLifecycle('in_hand') === 'registered', 'normalize in_hand→registered');
  ok(FINANCIAL_STATUS_RE.test('خواباندن به حساب ملت 9955'), 'free-text خواباندن blocked by regex');

  const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  ok(/function chequeLifecycleRegistered/.test(appJs), 'UI helper chequeLifecycleRegistered');
  ok(/chequeLifecycleRegistered\(r\)/.test(appJs), 'UI gates use helper');
  ok(!/lifecycle_status='in_hand'/.test(fs.readFileSync(path.join(__dirname, '../lib/invoice-payments.js'), 'utf8')),
    'invoice-payments no longer writes in_hand');

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);

  const custId = db.prepare(`
    INSERT INTO customers (user_id, biz, owner, phone, status)
    VALUES (?, 'مشتری چک v303', 'صدوقی', '09151111111', 'active')
  `).run(admin.id).lastInsertRowid;
  try {
    const p = db.prepare(`
      INSERT INTO parties (person_code, party_type, full_name, legacy_table, legacy_id, is_active)
      VALUES ('P-V303','customer','صدوقی','customers',?,1)
    `).run(custId).lastInsertRowid;
    db.prepare('UPDATE customers SET party_id=? WHERE id=?').run(p, custId);
  } catch (_) { /* optional */ }

  const invId = db.prepare(`
    INSERT INTO invoices (user_id, cust_id, num, date, type, status, subtotal, final, pay_type)
    VALUES (?, ?, 'T-V303', '1405/07/01', 'final', 'confirmed', 7400000, 7400000, 'cheque')
  `).run(admin.id, custId).lastInsertRowid;

  const AMT = 74_000_000;
  applyInvoicePaySplits(db, {
    invoiceId: invId,
    custId,
    date: '1405/07/01',
    userId: admin.id,
    num: 'T-V303',
    splits: [{
      pay_type: 'cheque',
      amount: AMT,
      cheque_bank: 'پست بانک',
      cheque_branch: 'زاوه',
      cheque_account: '123',
      cheque_number: '655099',
      sayadi: '5149050050730598',
      cheque_owner: 'صدوقی',
      cheque_due: '1405/07/07',
    }],
  });

  const created = db.prepare(`
    SELECT id, lifecycle_status, status, party_id, customer_id, amount
    FROM cheque_records WHERE invoice_id=? AND cheque_number='655099'
  `).get(invId);
  ok(!!created, 'invoice created cheque_records row');
  ok(created && created.lifecycle_status === 'registered', 'lifecycle=registered not in_hand', created && created.lifecycle_status);
  ok(created && created.status === 'نزد صندوق', 'status نزد صندوق', created && created.status);
  ok(created && Number(created.amount) === AMT, 'amount rial', created && created.amount);

  const legacyId = db.prepare(`
    INSERT INTO cheque_records
      (direction, cheque_number, receive_date, due_date, bank_name, party_name, customer_id,
       status, amount, note, lifecycle_status, record_status)
    VALUES ('in','LEG-INHAND','1405/06/01','1405/08/01','ملت','قدیمی',?,
       'خواباندن به حساب ملت 9955 نامشخص', 1000000, 'legacy', 'in_hand', 'posted')
  `).run(custId).lastInsertRowid;

  db.prepare("DELETE FROM settings WHERE key='cheque_lifecycle_alias_v303b'").run();
  db.prepare("DELETE FROM settings WHERE key='cheque_lifecycle_alias_v303'").run();
  const repaired = repairChequeLifecycleAliases(db);
  ok(repaired && !repaired.skipped, 'repair ran');
  ok(repaired.aliasFixed >= 1, 'aliasFixed>=1', repaired);
  const after = db.prepare('SELECT lifecycle_status, status FROM cheque_records WHERE id=?').get(legacyId);
  ok(after && after.lifecycle_status === 'registered', 'legacy in_hand→registered', after);
  ok(after && after.status === 'نزد صندوق', 'misleading خواباندن reset', after && after.status);

  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test',
    device_name: 'cheque-inv-lc-v303',
    device_fingerprint: 'cheque-inv-lc-v303-fp',
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

  const bankCoa = acct(db, 'coa_bank_default');
  const bankId = db.prepare(`
    INSERT INTO banks (name, account_number, active, coa_code) VALUES ('ملت 9955','9955',1,?)
  `).run(bankCoa.code).lastInsertRowid;

  const settId = db.prepare('SELECT settlement_id FROM cheque_records WHERE id=?').get(created.id).settlement_id;
  const notesBefore = db.prepare(`
    SELECT COUNT(*) AS c FROM journal_entries
    WHERE ref_type='cheque_in' AND ref_id=? AND COALESCE(deleted_at,0)=0
  `).get(created.id).c;
  const custCreditBefore = db.prepare(`
    SELECT COALESCE(SUM(credit),0) AS c FROM customer_ledger
    WHERE customer_id=? AND entry_type<>'reversal'
  `).get(custId).c;

  let r = await api('POST', `/api/cheque-records/${created.id}/send-to-bank`, {
    date: '1405/07/02', collection_bank_id: bankId,
  });
  ok(r.status === 200 && r.data && r.data.lifecycle_status === 'in_collection',
    'واگذاری invoice cheque', r.data && (r.data.error || r.data.lifecycle_status));

  const notesAfter = db.prepare(`
    SELECT COUNT(*) AS c FROM journal_entries
    WHERE ref_type='cheque_in' AND ref_id=? AND COALESCE(deleted_at,0)=0
  `).get(created.id).c;
  const custCreditAfter = db.prepare(`
    SELECT COALESCE(SUM(credit),0) AS c FROM customer_ledger
    WHERE customer_id=? AND entry_type<>'reversal'
  `).get(custId).c;
  const sendJe = db.prepare(`
    SELECT COUNT(*) AS c FROM journal_entries
    WHERE ref_type='cheque_send_to_bank' AND ref_id=? AND COALESCE(deleted_at,0)=0
  `).get(created.id).c;
  ok(Number(notesBefore) === 0 && Number(notesAfter) === 0, 'no cheque_in JE for invoice cheque', { notesBefore, notesAfter, settId });
  ok(Number(custCreditAfter) === Number(custCreditBefore), 'customer credit unchanged on واگذاری', { custCreditBefore, custCreditAfter });
  ok(Number(sendJe) === 1, 'exactly one send-to-bank JE', sendJe);

  r = await api('POST', `/api/cheque-records/${legacyId}/endorse`, {
    date: '1405/07/02', account_key: 'coa_payable',
  });
  ok(r.status === 200 && r.data && r.data.lifecycle_status === 'endorsed',
    'خرج after repair', r.data && (r.data.error || r.data.lifecycle_status));

  const freeId = db.prepare(`
    INSERT INTO cheque_records
      (direction, cheque_number, amount, status, lifecycle_status, record_status, party_name)
    VALUES ('in','FREE-TXT',500000,'نزد صندوق','registered','posted','x')
  `).run().lastInsertRowid;
  r = await api('PATCH', `/api/cheque-records/${freeId}/status`, {
    status: 'خواباندن به حساب ملت',
  });
  ok(r.status === 400 && r.data && r.data.code === 'E_CHEQUE_USE_LIFECYCLE',
    'block free-text خواباندن', r.data);

  server.close();
  try { closeSessionStore(); } catch (_) {}
  console.log('\n' + (fail ? `FAIL ${fail}` : 'PASS') + ` (${pass} ok)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
