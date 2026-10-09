/**
 * Treasury Option 1 (ADR-001): cheque→1109, overdraft, float ceiling, sheba, inactive.
 * Run: node server/scripts/test-treasury-option1-v335.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treasury-v335-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-treasury-option1-v335-secret-32b!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra != null ? JSON.stringify(extra) : ''); }
}

function linesOf(refType, refId) {
  const je = db.prepare(`
    SELECT id FROM journal_entries
    WHERE ref_type=? AND ref_id=? AND COALESCE(deleted_at,0)=0
    ORDER BY id DESC LIMIT 1
  `).get(refType, refId);
  if (!je) return [];
  return db.prepare('SELECT account_code, debit, credit FROM journal_lines WHERE entry_id=? ORDER BY id').all(je.id);
}

(async () => {
  const { acct } = require('../lib/coa-map');
  const {
    assertValidSheba, assertBankOverdraftOk, assertCashFloatCeilingOk,
  } = require('../lib/treasury-guards');
  const { settlementAssetAccount } = require('../lib/invoice-payments');
  const { postToLedger } = require('../lib/ledger');
  const { rialToLedger } = require('../lib/money');
  const { todayJalali } = require('../jalali');

  const bankCols = db.prepare("PRAGMA table_info(banks)").all().map((c) => c.name);
  const cashCols = db.prepare("PRAGMA table_info(cash_boxes)").all().map((c) => c.name);
  ok(bankCols.includes('overdraft_limit_rial'), 'banks.overdraft_limit_rial column');
  ok(cashCols.includes('float_ceiling_rial'), 'cash_boxes.float_ceiling_rial column');

  ok(assertValidSheba('') === '', 'empty sheba ok');
  ok(assertValidSheba('IR123456789012345678901234') === 'IR123456789012345678901234', 'valid IR sheba');
  ok(assertValidSheba('123456789012345678901234') === 'IR123456789012345678901234', '24 digits → IR');
  let shebaBad = false;
  try { assertValidSheba('IR12'); } catch (e) { shebaBad = e.code === 'E_SHEBA'; }
  ok(shebaBad, 'invalid sheba rejected');

  const chequeAsset = settlementAssetAccount(db, { pay_type: 'cheque' });
  ok(String(chequeAsset.code) === '1109' || String(chequeAsset.code).startsWith('1109'), 'cheque asset → 1109', chequeAsset);

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'treasury-v335', device_fingerprint: 'treasury-v335-fp',
  }).token;

  const bankCoa = '11023351';
  const boxCoa = '11013351';
  db.prepare(`INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES (?, 'بانک خزانه', 'asset', '1102', 3, 1)`).run(bankCoa);
  db.prepare(`INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES (?, 'صندوق خزانه', 'asset', '1101', 3, 1)`).run(boxCoa);
  const bankId = db.prepare(`
    INSERT INTO banks (name, account_number, branch, active, coa_code, currency, is_foreign, overdraft_limit_rial)
    VALUES ('بانک سقف','335','مرکزی',1,?, 'IRR', 0, 0)
  `).run(bankCoa).lastInsertRowid;
  const boxId = db.prepare(`
    INSERT INTO cash_boxes (name, active, coa_code, currency, is_foreign, is_petty_cash, float_ceiling_rial)
    VALUES ('صندوق سقف',1,?, 'IRR', 0, 1, 500000)
  `).run(boxCoa).lastInsertRowid;
  const deadBank = db.prepare(`
    INSERT INTO banks (name, account_number, branch, active, coa_code, currency, is_foreign)
    VALUES ('بانک خاموش','999','x',0,'1102999', 'IRR', 0)
  `).run().lastInsertRowid;
  db.prepare(`INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES ('1102999','بانک خاموش','asset','1102',3,1)`).run();

  // Seed bank with 100k so overdraft=0 blocks 200k outflow
  postToLedger(db, {
    sourceType: 'manual', sourceId: 1, date: todayJalali(), description: 'seed bank',
    createdBy: admin.id,
    lines: [
      { code: bankCoa, name: 'بانک', debit: rialToLedger(100_000), credit: 0 },
      { code: acct(db, 'coa_opening_balance').code, name: 'افتتاحیه', debit: 0, credit: rialToLedger(100_000) },
    ],
  });

  let odBlocked = false;
  try { assertBankOverdraftOk(db, bankId, 200_000); } catch (e) { odBlocked = e.code === 'E_OVERDRAFT'; }
  ok(odBlocked, 'overdraft 0 blocks excess credit');

  let ceilBlocked = false;
  try { assertCashFloatCeilingOk(db, boxId, 600_000); } catch (e) { ceilBlocked = e.code === 'E_FLOAT_CEILING'; }
  ok(ceilBlocked, 'float ceiling blocks transfer in');

  const custId = db.prepare(`INSERT INTO customers (user_id, biz, phone, status) VALUES (?,?,?,?)`)
    .run(admin.id, 'مشتری خزانه', '09123350001', 'active').lastInsertRowid;

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/accounting', require('../routes/accounting'));
  app.use('/api/transfers', require('../routes/transfers'));
  app.use('/api/banks', require('../routes/banks'));
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

  const chq = await api('POST', '/api/accounting/settlements', {
    cust_id: custId,
    amount: 250_000,
    pay_type: 'cheque',
    bank_id: bankId,
    date: todayJalali(),
    cheque_bank: 'ملت',
    cheque_sayadi: '1234567890123456',
    cheque_due: '1405/08/01',
    note: 'چک standalone',
  });
  ok(chq.status === 200 && chq.data.id, 'POST cheque settlement', chq.data);
  const chqLines = linesOf('settlement', chq.data.id);
  ok(chqLines.some((l) => String(l.account_code).startsWith('1109') && Number(l.debit) > 0),
    'cheque settlement Dr 1109', chqLines);

  const inactive = await api('POST', '/api/transfers', {
    date: todayJalali(), from_type: 'bank', from_id: deadBank,
    to_type: 'cash', to_id: boxId, amount: 10_000,
  });
  ok(inactive.status === 400 && inactive.data.code === 'E_BANK_INACTIVE', 'inactive bank blocked', inactive.data);

  const badSheba = await api('PUT', '/api/banks/' + bankId, {
    name: 'بانک سقف', sheba: 'IR12',
  });
  ok(badSheba.status === 400 && badSheba.data.code === 'E_SHEBA', 'bank sheba validated', badSheba.data);

  const odXfer = await api('POST', '/api/transfers', {
    date: todayJalali(), from_type: 'bank', from_id: bankId,
    to_type: 'cash', to_id: boxId, amount: 200_000,
  });
  ok(odXfer.status === 409 && odXfer.data.code === 'E_OVERDRAFT', 'transfer overdraft blocked', odXfer.data);

  // Lift overdraft; hit float ceiling instead
  db.prepare('UPDATE banks SET overdraft_limit_rial=NULL WHERE id=?').run(bankId);
  const ceilXfer = await api('POST', '/api/transfers', {
    date: todayJalali(), from_type: 'bank', from_id: bankId,
    to_type: 'cash', to_id: boxId, amount: 600_000,
  });
  ok(ceilXfer.status === 409 && ceilXfer.data.code === 'E_FLOAT_CEILING', 'float ceiling on transfer', ceilXfer.data);

  const okXfer = await api('POST', '/api/transfers', {
    date: todayJalali(), from_type: 'bank', from_id: bankId,
    to_type: 'cash', to_id: boxId, amount: 50_000,
  });
  ok(okXfer.status === 200 && okXfer.data.ok, 'transfer within limits ok', okXfer.data);

  server.close();
  closeSessionStore();
  closeDB();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
