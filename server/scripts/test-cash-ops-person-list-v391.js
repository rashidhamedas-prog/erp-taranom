/**
 * Cash-ops list includes person/account voucher payments (v391).
 * Root bug: savePersonPayment(party) → /vouchers but list only merged
 * supplier + incentive + expense.
 * Run: node server/scripts/test-cash-ops-person-list-v391.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cash-ops-v391-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-cash-ops-person-list-v391-secret-32!!';
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
  const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  ok(appSrc.includes("/accounting/cash-ops/outgoing"), 'UI fetches cash-ops outgoing');
  ok(appSrc.includes("/accounting/cash-ops/incoming-extra"), 'UI fetches cash-ops incoming-extra');
  ok(appSrc.includes("person:'👤 شخص'"), 'UI labels person kind');
  const cashOpsChunk = appSrc.slice(
    appSrc.indexOf('async function renderCashOpsTab'),
    appSrc.indexOf('async function renderPaymentOpsTab')
  );
  ok(cashOpsChunk.includes('cash-ops/outgoing'), 'renderCashOpsTab loads outgoing vouchers');
  ok(cashOpsChunk.includes('softGet(\'/expenses\')'), 'still loads expenses');

  const access = require('../lib/accounting-access');
  const hit = access.matchAccResources('/api/accounting/cash-ops/outgoing');
  ok(hit.some((h) => h.resource === 'acc_settlements'), 'cash-ops API maps to acc_settlements');

  const cashCode = '11019991';
  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES (?, 'صندوق تست v391', 'asset', '1101', 3, 1)
  `).run(cashCode);
  try {
    db.prepare('INSERT INTO cash_boxes (name, coa_code, active) VALUES (?,?,1)')
      .run('صندوق تست v391', cashCode);
  } catch (_) { /* optional */ }

  const partyId = db.prepare(`
    INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, is_active)
    VALUES ('P-V391','other','["other"]','حامد رشید تست','09120003911',1)
  `).run().lastInsertRowid;
  const { ensurePersonForParty } = require('../lib/party-turnover');
  const personId = ensurePersonForParty(db, partyId);
  ok(!!personId, 'person ensured for party', personId);

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'cash-ops-v391', device_fingerprint: 'cash-ops-v391-fp',
  }).token;

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/accounting', require('../routes/accounting'));
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

  const amt = 100_000_000;
  const voucher = await api('POST', '/api/accounting/vouchers', {
    date: '1405/07/01',
    description: 'پرداخت به شخص',
    lines: [
      { target_type: 'person', party_id: partyId, debit: amt, credit: 0, description: 'پرداخت به شخص' },
      { target_type: 'account', code: cashCode, debit: 0, credit: amt, description: 'پرداخت از صندوق/بانک' },
    ],
  });
  ok(voucher.status === 200 && voucher.data.id, 'person payment voucher created', voucher);
  const payJe = voucher.data.id;

  const list = await api('GET', '/api/accounting/cash-ops/outgoing');
  ok(list.status === 200 && Array.isArray(list.data), 'GET outgoing 200 array', list.status);
  const hitPay = (list.data || []).find((r) => Number(r.id) === Number(payJe));
  ok(!!hitPay, 'person payment in outgoing list', { payJe, n: (list.data || []).length });
  ok(hitPay && hitPay.kind === 'person', 'kind=person', hitPay);
  ok(hitPay && Number(hitPay.amount) === amt, 'amount matches', hitPay && hitPay.amount);
  ok(hitPay && /حامد|رشید/.test(String(hitPay.target || '')), 'target has person name', hitPay && hitPay.target);

  const destCode = '61039991';
  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES (?, 'هزینه تست v391', 'expense', '6103', 3, 1)
  `).run(destCode);
  const acctPay = await api('POST', '/api/accounting/account-payments', {
    date: '1405/07/01', amount: 50_000, account_code: destCode, pay_type: 'cash', note: 'پرداخت به حساب تست',
  });
  // cash_box_id may be required — if fail, post voucher-style account_payment via ledger helper path
  let acctId = acctPay.data && acctPay.data.id;
  if (!(acctPay.status === 200 && acctId)) {
    const { postToLedger } = require('../lib/ledger');
    const { rialToLedger } = require('../lib/money');
    acctId = db.transaction(() => {
      const id = postToLedger(db, {
        sourceType: 'account_payment', sourceId: null,
        date: '1405/07/01', description: 'پرداخت به حساب تست', createdBy: admin.id,
        lines: [
          { code: destCode, name: 'هزینه تست', debit: rialToLedger(50_000), credit: 0 },
          { code: cashCode, name: 'صندوق', debit: 0, credit: rialToLedger(50_000) },
        ],
      });
      try { db.prepare('UPDATE journal_entries SET ref_id=? WHERE id=?').run(id, id); } catch (_) {}
      return id;
    })();
  }
  const list2 = await api('GET', '/api/accounting/cash-ops/outgoing');
  const hitAcct = (list2.data || []).find((r) => Number(r.id) === Number(acctId));
  ok(!!hitAcct && hitAcct.kind === 'account', 'account payment in outgoing', hitAcct);

  const recvAmt = 2_000_000;
  const recv = await api('POST', '/api/accounting/vouchers', {
    date: '1405/07/02',
    description: 'دریافت از شخص',
    lines: [
      { target_type: 'account', code: cashCode, debit: recvAmt, credit: 0, description: 'دریافت' },
      { target_type: 'person', party_id: partyId, debit: 0, credit: recvAmt, description: 'بستانکار شخص' },
    ],
  });
  ok(recv.status === 200 && recv.data.id, 'person receipt voucher created', recv);
  const inList = await api('GET', '/api/accounting/cash-ops/incoming-extra');
  ok(inList.status === 200 && Array.isArray(inList.data), 'GET incoming-extra 200');
  const hitRecv = (inList.data || []).find((r) => Number(r.id) === Number(recv.data.id));
  ok(!!hitRecv && hitRecv.kind === 'person_receipt', 'person receipt in incoming-extra', hitRecv);

  const { listCashOpsOutgoing } = require('../lib/cash-ops-list');
  const libRows = listCashOpsOutgoing(db);
  ok(libRows.some((r) => Number(r.id) === Number(payJe)), 'lib listCashOpsOutgoing sees person pay');

  server.close();
  try { closeSessionStore(); } catch (_) {}
  closeDB();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
