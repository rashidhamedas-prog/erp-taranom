/**
 * Amend «پرداخت به شخص» keeps same JE id + voucher_number (v394).
 * Run: node server/scripts/test-cash-ops-person-amend-v394.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cash-ops-amend-v394-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-cash-ops-person-amend-v394-secret-32!';
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
  ok(appSrc.includes("path='/accounting/vouchers/'+id"), 'UI PUT vouchers for person/account');
  const blockFn = appSrc.slice(
    appSrc.indexOf('function cashDocBlockedReason'),
    appSrc.indexOf('async function editCashDoc')
  );
  ok(blockFn.includes("person_receipt") && blockFn.includes('account_receipt'),
    'cashDocBlockedReason still blocks receipts');
  ok(!/kind==='person'\|\|kind==='account'/.test(blockFn),
    'cashDocBlockedReason does not block person/account pay');
  ok(appSrc.includes("person:'اصلاح پرداخت به شخص'") || appSrc.includes("اصلاح پرداخت به شخص"),
    'edit modal title for person');
  ok(!appSrc.includes("voucherKinds.has(r.kind)?'':"),
    'person/account pencil no longer hidden via voucherKinds');

  const cashCode = '11019994';
  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES (?, 'صندوق تست v394', 'asset', '1101', 3, 1)
  `).run(cashCode);
  try {
    db.prepare('INSERT INTO cash_boxes (name, coa_code, active) VALUES (?,?,1)')
      .run('صندوق تست v394', cashCode);
  } catch (_) {}

  const partyId = db.prepare(`
    INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, is_active)
    VALUES ('P-V394','other','["other"]','حامد رشید amend','09120003941',1)
  `).run().lastInsertRowid;
  const { ensurePersonForParty } = require('../lib/party-turnover');
  const personId = ensurePersonForParty(db, partyId);
  ok(!!personId, 'person ensured');

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'amend-v394', device_fingerprint: 'amend-v394-fp',
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

  const created = await api('POST', '/api/accounting/vouchers', {
    date: '1405/07/01',
    description: 'پرداخت به شخص',
    lines: [
      { target_type: 'person', party_id: partyId, debit: 100_000_000, credit: 0, description: 'پرداخت به شخص' },
      { target_type: 'account', code: cashCode, debit: 0, credit: 100_000_000, description: 'پرداخت از صندوق/بانک' },
    ],
  });
  ok(created.status === 200 && created.data.id, 'create person pay', created);
  const jeId = created.data.id;
  const before = db.prepare('SELECT id, voucher_number, ref_type FROM journal_entries WHERE id=?').get(jeId);
  ok(!!before && before.ref_type === 'manual_voucher', 'JE is manual_voucher');

  const box = db.prepare('SELECT id FROM cash_boxes WHERE coa_code=? LIMIT 1').get(cashCode);
  const cashBoxId = box?.id || null;

  const amended = await api('PUT', '/api/accounting/vouchers/' + jeId, {
    party_id: partyId,
    amount: 120_000_000,
    pay_type: 'cash',
    cash_box_id: cashBoxId,
    date: '1405/07/01',
    note: 'پرداخت به شخص — اصلاح‌شده',
    fee_rial: 0,
  });
  ok(amended.status === 200 && amended.data.ok, 'PUT amend 200', amended);
  ok(Number(amended.data.id) === Number(jeId), 'same JE id', amended.data);

  const after = db.prepare('SELECT id, voucher_number, description FROM journal_entries WHERE id=?').get(jeId);
  ok(after && after.voucher_number === before.voucher_number, 'voucher_number unchanged', {
    before: before.voucher_number, after: after && after.voucher_number,
  });
  ok(String(after.description || '').includes('اصلاح'), 'description updated', after.description);

  const pl = db.prepare(`
    SELECT debit, credit FROM person_ledger
    WHERE ref_type='manual_voucher' AND ref_id=? AND person_id=?
  `).get(jeId, personId);
  ok(pl && Number(pl.debit) === 120_000_000, 'person_ledger debit updated', pl);

  const list = await api('GET', '/api/accounting/cash-ops/outgoing');
  const hit = (list.data || []).find((r) => Number(r.id) === Number(jeId));
  ok(!!hit && hit.kind === 'person' && Number(hit.amount) === 120_000_000, 'list shows new amount', hit);
  ok(hit && hit.amendable === true, 'list amendable true', hit);
  ok(hit && (hit.party_id || hit.person_id), 'list has party/person id', hit);

  const jeCount = db.prepare("SELECT COUNT(*) c FROM journal_entries WHERE ref_type='manual_voucher' AND description LIKE '%اصلاح%'").get().c;
  ok(jeCount === 1, 'no second JE minted for amend', jeCount);

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
