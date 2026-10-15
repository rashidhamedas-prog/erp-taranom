/**
 * Bank fee COA must post to a leaf when 6115 has معین children.
 * Covers: ensureLogicalPostable, bankFeeAccount, party voucher coerce, UI hardcode gone.
 * Run: node server/scripts/test-bank-fee-leaf-v388.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-fee-leaf-v388-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-bank-fee-leaf-v388-secret-32bytes!!';
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
  const {
    isPostableCode, resolvePostableLeaf, ensureLogicalPostable, coerceSystemPostableCode, acct,
  } = require('../lib/coa-map');
  const { bankFeeAccount, outboundPaymentLines } = require('../lib/payment-bank-fee');
  const { rialToLedger } = require('../lib/money');

  ok(isPostableCode(db, '6115'), '6115 starts as leaf on fresh DB');

  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES ('611501','کارمزد حواله','expense','6115',3,1)
  `).run();
  ok(!isPostableCode(db, '6115'), '6115 not postable after child');
  ok(isPostableCode(db, '611501'), '611501 is leaf');

  const leaf = resolvePostableLeaf(db, '6115', { create: false });
  ok(leaf && leaf.code === '611501', 'resolvePostableLeaf picks 611501', leaf);

  const ensured = ensureLogicalPostable(db, 'coa_bank_fee');
  ok(ensured.code === '611501', 'ensureLogicalPostable → 611501', ensured);
  const setRow = db.prepare("SELECT value FROM settings WHERE key='coa_bank_fee'").get();
  ok(setRow && setRow.value === '611501', 'settings.coa_bank_fee remapped', setRow);

  const feeAcct = bankFeeAccount(db);
  ok(feeAcct.code === '611501', 'bankFeeAccount returns leaf', feeAcct);

  const built = outboundPaymentLines(db, {
    amount: 100_000_000, feeRial: 42_500, payType: 'bank',
    dest: { code: '1106', name: 'اشخاص' },
    cash: { code: '1102', name: 'بانک' },
  });
  ok(built.lines.some(l => l.code === '611501' && l.debit === rialToLedger(42500)), 'outbound fee on leaf');
  ok(!built.lines.some(l => l.code === '6115'), 'outbound never posts parent 6115');

  ok(coerceSystemPostableCode(db, '6115') === '611501', 'coerce 6115 → leaf');
  ok(coerceSystemPostableCode(db, '611501') === '611501', 'coerce leaf stays');
  ok(coerceSystemPostableCode(db, '6102') === '6102', 'coerce ignores unrelated');

  // Second child: still prefer lowest existing leaf (611501)
  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES ('611502','کارمزد پایا','expense','6115',3,1)
  `).run();
  const again = resolvePostableLeaf(db, '6115', { create: false });
  ok(again && again.code === '611501', 'stable pick lowest leaf', again);

  // Create path when parent has only non-leaf children (empty tree under new parent)
  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES ('6116','تست والد','expense','6000',2,1)
  `).run();
  const created = resolvePostableLeaf(db, '6116', { create: true });
  ok(created && created.code === '611601', 'creates 611601 under empty parent', created);
  ok(isPostableCode(db, '611601'), 'created child is leaf');

  // HTTP: party-style voucher with hardcoded 6115 + fee must succeed via coerce
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'fee-leaf', device_fingerprint: 'fee-leaf-fp',
  }).token;

  const personId = db.prepare(`
    INSERT INTO persons (name, phone, active) VALUES ('حامد تست کارمزد','09120000000',1)
  `).run().lastInsertRowid;

  const bankCoa = '11028888';
  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES (?, 'بانک تست برگ', 'asset', '1102', 3, 1)
  `).run(bankCoa);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/accounting', require('../routes/accounting'));
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

  const voucher = await api('POST', '/api/accounting/vouchers', {
    date: '1405/07/01',
    description: 'پرداخت به شخص — تست کارمزد برگ',
    lines: [
      { target_type: 'person', person_id: personId, debit: 100_000_000, credit: 0, description: 'پرداخت به شخص' },
      { target_type: 'account', code: '6115', debit: 42_500, credit: 0, description: 'کارمزد انتقال' },
      { target_type: 'account', code: bankCoa, debit: 0, credit: 100_042_500, description: 'پرداخت از بانک' },
    ],
  });
  ok(voucher.status === 200 && (voucher.data.id || voucher.data.ok), 'voucher with parent 6115 accepted', voucher);
  if (voucher.data && voucher.data.id) {
    const jl = db.prepare('SELECT account_code, debit, credit FROM journal_lines WHERE entry_id=?').all(voucher.data.id);
    ok(jl.some(l => l.account_code === '611501'), 'JE fee on leaf 611501', jl);
    ok(!jl.some(l => l.account_code === '6115'), 'JE has no parent 6115 line', jl);
  }

  const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  ok(!/code:'6115',\s*debit:fee/.test(appSrc), 'UI no longer hardcodes 6115 for fee');
  ok(appSrc.includes('resolveBankFeeCodeForUi'), 'UI uses resolveBankFeeCodeForUi');

  const settingsSrc = fs.readFileSync(path.join(__dirname, '../routes/settings.js'), 'utf8');
  ok(settingsSrc.includes("'coa_bank_fee'"), 'settings allowlist includes coa_bank_fee');

  // acct() after heal should follow settings
  const mapped = acct(db, 'coa_bank_fee');
  ok(mapped.code === '611501', 'acct(coa_bank_fee) after clear cache', mapped);

  server.close();
  try { closeSessionStore(); } catch (_) {}
  closeDB();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
