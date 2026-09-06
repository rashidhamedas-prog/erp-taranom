/**
 * POS-STITCH-P8 — POS-01 terminals + POS-02 in-transit receipts / batch settle / R13.
 * Run: node server/scripts/test-pos-stitch-p8.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-stitch-p8-'));
const dbFile = path.join(dir, 't.db');
try { fs.unlinkSync(dbFile); } catch (_) {}
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-pos-stitch-p8-secret-32-bytes-min';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

delete require.cache[require.resolve('../db')];
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const { FK_COLUMNS, SYNCABLE_TABLES } = require('../sync/tables');
const { acct } = require('../lib/coa-map');
const { glBalanceRial } = require('../lib/pos');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

function jeBalanced(jeId) {
  if (!jeId) return false;
  const row = db.prepare(`
    SELECT COALESCE(SUM(debit_rial),0) AS d, COALESCE(SUM(credit_rial),0) AS c
    FROM journal_lines WHERE entry_id=?
  `).get(jeId);
  return Math.abs((Number(row.d) || 0) - (Number(row.c) || 0)) < 1;
}

function jeLines(jeId) {
  return db.prepare('SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?').all(jeId);
}

(async () => {
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test',
    device_name: 'pos-stitch-p8',
    device_fingerprint: 'pos-stitch-p8-fp',
  }).token;

  const salesId = db.prepare(`
    INSERT INTO users (name, username, password, role, active, must_change_password)
    VALUES ('فروشنده کارتخوان','sales.pos',?, 'field_sales', 1, 0)
  `).run(bcrypt.hashSync('SalesPos9', 10)).lastInsertRowid;
  const salesUser = db.prepare('SELECT id,username,role,name,phone,auth_epoch FROM users WHERE id=?').get(salesId);
  const salesTok = issueStaffSession(db, salesUser, {
    device_kind: 'test',
    device_name: 'pos-sales',
    device_fingerprint: 'pos-sales-fp',
  }).token;

  const app = express();
  app.use(express.json());
  app.use('/api/pos', require('../routes/pos'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const BASE = `http://127.0.0.1:${port}`;

  async function api(method, p, body, tok) {
    const res = await fetch(BASE + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (tok || token),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }

  console.log('\n— schema + sync + COA —');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
  ['pos_terminals', 'pos_receipts', 'pos_settlement_batches', 'pos_settlement_items']
    .forEach((t) => ok(tables.includes(t), 'table ' + t));
  const names = SYNCABLE_TABLES.map((t) => t.name);
  ok(names.slice(-4).join(',') === 'pos_terminals,pos_receipts,pos_settlement_batches,pos_settlement_items',
    'SYNCABLE_TABLES append-only tail');
  ok(FK_COLUMNS.some((x) => x[0] === 'pos_terminals' && x[1] === 'bank_id'), 'FK terminal bank_id');
  ok(FK_COLUMNS.some((x) => x[0] === 'pos_receipts' && x[1] === 'journal_id'), 'FK receipt journal_id');
  ok(FK_COLUMNS.some((x) => x[0] === 'pos_settlement_items' && x[1] === 'receipt_id'), 'FK item receipt_id');
  const transit = acct(db, 'coa_card_in_transit');
  ok(transit && transit.code === '1118', 'coa_card_in_transit=1118', transit);
  ok(!!db.prepare('SELECT code FROM chart_of_accounts WHERE code=?').get('1118'), 'chart 1118 exists');
  ok(!!db.prepare("SELECT value FROM settings WHERE key='sync_seq_backfill_v11'").get(), 'sync_seq_backfill_v11');

  const bankCoa = '1102-pos1';
  db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level) VALUES (?,?,?,?,?)')
    .run(bankCoa, 'بانک ملت تست POS', 'asset', '1102', 4);
  const bankId = db.prepare(`
    INSERT INTO banks (name, account_number, active, coa_code) VALUES ('ملت تست','010203',1,?)
  `).run(bankCoa).lastInsertRowid;
  const inactiveBankId = db.prepare(`
    INSERT INTO banks (name, account_number, active, coa_code) VALUES ('بانک خاموش','999',0,'1102-pos-off')
  `).run().lastInsertRowid;
  const custId = db.prepare(`
    INSERT INTO customers (user_id, biz, owner, phone, type, status)
    VALUES (?,'فروشگاه تست POS','مالک','09120000000','shop','active')
  `).run(admin.id).lastInsertRowid;
  const invId = db.prepare(`
    INSERT INTO invoices (user_id, cust_id, type, date, num, final, final_rial, status)
    VALUES (?,?,'normal','1405/01/10','T-POS-1',2000000,2000000,'posted')
  `).run(admin.id, custId).lastInsertRowid;

  console.log('\n— POS-01 terminals —');
  const noBank = await api('POST', '/api/pos/terminals', { name: 'صندوق ۱', terminal_id: 'T-100' });
  ok(noBank.status === 400 && noBank.data && noBank.data.code === 'E_POS_BANK_REQUIRED',
    'terminal without bank → 400', noBank.status + ' ' + (noBank.data && noBank.data.code));

  const inactive = await api('POST', '/api/pos/terminals', {
    name: 'صندوق ۲', terminal_id: 'T-101', bank_id: inactiveBankId,
  });
  ok(inactive.status === 400 && inactive.data && inactive.data.code === 'E_POS_BANK_INACTIVE',
    'inactive bank → 400', inactive.status + ' ' + (inactive.data && inactive.data.code));

  const missingBank = await api('POST', '/api/pos/terminals', {
    name: 'صندوق ۳', terminal_id: 'T-102', bank_id: 999999,
  });
  ok(missingBank.status === 400 && missingBank.data && missingBank.data.code === 'E_POS_BANK_MISSING',
    'missing bank → 400', missingBank.data && missingBank.data.code);

  const created = await api('POST', '/api/pos/terminals', {
    name: 'صندوق فروشگاه', terminal_id: 'POS-7788', bank_id: bankId, merchant_id: 'M-1',
  });
  ok(created.status === 200 && created.data && created.data.id, 'create terminal 200', created.data && created.data.error);
  ok(created.data && created.data.bank_id === bankId && created.data.bank_name === 'ملت تست',
    'terminal stores bank dropdown fields');

  const dup = await api('POST', '/api/pos/terminals', {
    name: 'تکراری', terminal_id: 'POS-7788', bank_id: bankId,
  });
  ok((dup.status === 400 || dup.status === 409) && dup.data && dup.data.code === 'E_POS_TERMINAL_DUP',
    'duplicate terminal_id → 400/409', dup.status + ' ' + (dup.data && dup.data.code));

  const listed = await api('GET', '/api/pos/terminals');
  ok(listed.status === 200 && Array.isArray(listed.data) && listed.data.some((t) => t.terminal_id === 'POS-7788'),
    'GET terminals');

  const salesTerm = await api('POST', '/api/pos/terminals', {
    name: 'غیرمجاز', terminal_id: 'POS-X', bank_id: bankId,
  }, salesTok);
  ok(salesTerm.status === 403, 'field_sales terminal mutate 403', String(salesTerm.status));

  console.log('\n— POS-02 receipt in-transit —');
  const bankBefore = glBalanceRial(db, bankCoa);
  const transitBefore = glBalanceRial(db, '1118');
  const rec = await api('POST', '/api/pos/receipts', {
    terminal_id: created.data.id,
    date: '1405/01/15',
    amount_rial: 1000000,
    invoice_id: invId,
    cust_id: custId,
    idempotency_key: 'rec-a-1',
    ref: 'RRN-1',
  });
  ok(rec.status === 200 && rec.data && rec.data.id, 'receipt 200', rec.data && rec.data.error);
  ok(rec.data && rec.data.journal_id && jeBalanced(rec.data.journal_id), 'receipt JE balanced');
  const recLines = jeLines(rec.data.journal_id);
  ok(recLines.some((l) => l.account_code === '1118' && Number(l.debit_rial) === 1000000),
    'receipt Dr in-transit 1118', recLines);
  ok(!recLines.some((l) => l.account_code === bankCoa && Number(l.debit_rial) > 0),
    'receipt does not debit bank');
  ok(recLines.some((l) => Number(l.credit_rial) === 1000000), 'receipt Cr receivable/sales');
  ok(glBalanceRial(db, bankCoa) === bankBefore, 'bank unchanged until settle', glBalanceRial(db, bankCoa));
  ok(glBalanceRial(db, '1118') === transitBefore + 1000000, 'in-transit +gross', glBalanceRial(db, '1118'));
  const sett = db.prepare('SELECT * FROM settlements WHERE id=?').get(rec.data.settlement_id);
  ok(sett && sett.pay_type === 'pos_card' && Number(sett.amount_rial || sett.amount) === 1000000,
    'invoice settlement application', sett);

  const recDup = await api('POST', '/api/pos/receipts', {
    terminal_id: created.data.id, amount_rial: 1000000, idempotency_key: 'rec-a-1',
  });
  ok(recDup.status === 409 && recDup.data && recDup.data.code === 'E_POS_IDEMPOTENT',
    'second receipt same key 409', recDup.status);

  const salesRec = await api('POST', '/api/pos/receipts', {
    terminal_id: created.data.id, amount_rial: 1000, idempotency_key: 'rec-sales',
  }, salesTok);
  ok(salesRec.status === 403, 'field_sales receipt 403', String(salesRec.status));

  console.log('\n— batch settle + fee/shortage —');
  const rec2 = await api('POST', '/api/pos/receipts', {
    terminal_id: created.data.id,
    date: '1405/01/16',
    amount_rial: 500000,
    idempotency_key: 'rec-b-1',
    note: 'بدون فاکتور',
  });
  ok(rec2.status === 200, 'standalone receipt 200', rec2.data && rec2.data.error);
  const rec2Lines = jeLines(rec2.data.journal_id);
  const salesAcct = acct(db, 'coa_sales');
  ok(rec2Lines.some((l) => l.account_code === salesAcct.code && Number(l.credit_rial) === 500000),
    'standalone Cr sales', rec2Lines);

  const bankMid = glBalanceRial(db, bankCoa);
  const batch = await api('POST', '/api/pos/batches', {
    date: '1405/01/17',
    gross_rial: 1500000,
    fee_rial: 15000,
    shortage_rial: 5000,
    terminal_id: created.data.id,
    receipt_ids: [rec.data.id, rec2.data.id],
    idempotency_key: 'batch-1',
    ref: 'SET-1',
  });
  ok(batch.status === 200 && batch.data && batch.data.id, 'batch settle 200', batch.data && batch.data.error);
  ok(batch.data && Number(batch.data.net_rial) === 1480000, 'net = gross-fee-shortage', batch.data);
  ok(batch.data && batch.data.journal_id && jeBalanced(batch.data.journal_id), 'batch JE balanced');
  const bLines = jeLines(batch.data.journal_id);
  ok(bLines.some((l) => l.account_code === bankCoa && Number(l.debit_rial) === 1480000), 'Dr bank net', bLines);
  const feeAcct = acct(db, 'coa_card_fee');
  ok(bLines.some((l) => l.account_code === feeAcct.code && Number(l.debit_rial) === 15000), 'Dr fee', bLines);
  const adminExp = acct(db, 'coa_admin_expense');
  ok(bLines.some((l) => l.account_code === adminExp.code && Number(l.debit_rial) === 5000), 'Dr shortage', bLines);
  ok(bLines.some((l) => l.account_code === '1118' && Number(l.credit_rial) === 1500000), 'Cr in-transit gross', bLines);
  ok(glBalanceRial(db, bankCoa) === bankMid + 1480000, 'bank +net after settle', glBalanceRial(db, bankCoa));
  ok(glBalanceRial(db, '1118') === 0, 'in-transit cleared', glBalanceRial(db, '1118'));

  const batch2 = await api('POST', '/api/pos/batches', {
    date: '1405/01/17', gross_rial: 1500000, receipt_ids: [rec.data.id, rec2.data.id],
    idempotency_key: 'batch-1',
  });
  ok(batch2.status === 409 && batch2.data && batch2.data.code === 'E_POS_IDEMPOTENT',
    'second settle same key 409', batch2.status);
  const batch3 = await api('POST', '/api/pos/batches', {
    date: '1405/01/17', gross_rial: 1500000, receipt_ids: [rec.data.id],
    idempotency_key: 'batch-2',
  });
  ok(batch3.status === 409 && batch3.data && (batch3.data.code === 'E_POS_ALREADY_SETTLED' || batch3.data.code === 'E_POS_GROSS_MISMATCH'),
    'already-settled receipt 409', batch3.status + ' ' + (batch3.data && batch3.data.code));

  const salesBatch = await api('POST', '/api/pos/batches', {
    date: '1405/01/17', gross_rial: 1000, idempotency_key: 'batch-sales',
  }, salesTok);
  ok(salesBatch.status === 403, 'field_sales batch 403', String(salesBatch.status));

  console.log('\n— R13 void receipt / void batch —');
  const recV = await api('POST', '/api/pos/receipts', {
    terminal_id: created.data.id, amount_rial: 200000, idempotency_key: 'rec-void-1',
  });
  ok(recV.status === 200, 'void-target receipt');
  const transitAfterV = glBalanceRial(db, '1118');
  const voided = await api('POST', '/api/pos/receipts/' + recV.data.id + '/void', { reason: 'تست ابطال' });
  ok(voided.status === 200 && voided.data && voided.data.status === 'reversed', 'void receipt 200', voided.data);
  const still = db.prepare('SELECT * FROM pos_receipts WHERE id=?').get(recV.data.id);
  ok(still && still.status === 'reversed', 'receipt row remains reversed');
  ok(glBalanceRial(db, '1118') === transitAfterV - 200000, 'void receipt reverses in-transit', glBalanceRial(db, '1118'));
  const void2 = await api('POST', '/api/pos/receipts/' + recV.data.id + '/void', {});
  ok(void2.status === 409, 'second void receipt 409', String(void2.status));

  const inBatchVoid = await api('POST', '/api/pos/receipts/' + rec.data.id + '/void', {});
  ok(inBatchVoid.status === 409 && inBatchVoid.data && inBatchVoid.data.code === 'E_POS_IN_BATCH',
    'void receipt in live batch 409', inBatchVoid.data && inBatchVoid.data.code);

  const bankBeforeVoid = glBalanceRial(db, bankCoa);
  const voidBatch = await api('POST', '/api/pos/batches/' + batch.data.id + '/void', { reason: 'تست دسته' });
  ok(voidBatch.status === 200 && voidBatch.data && voidBatch.data.status === 'reversed', 'void batch 200', voidBatch.data);
  const batchRow = db.prepare('SELECT * FROM pos_settlement_batches WHERE id=?').get(batch.data.id);
  ok(batchRow && batchRow.status === 'reversed', 'batch row remains reversed');
  ok(glBalanceRial(db, bankCoa) === bankBeforeVoid - 1480000, 'void batch reverses bank', glBalanceRial(db, bankCoa));
  const recAfter = db.prepare('SELECT * FROM pos_receipts WHERE id=?').get(rec.data.id);
  ok(recAfter && recAfter.status === 'open' && Number(recAfter.settled_rial) === 0, 'receipt reopened after batch void', recAfter);

  const delTerm = await api('DELETE', '/api/pos/terminals/' + created.data.id);
  ok(delTerm.status === 200 && delTerm.data && Number(delTerm.data.active) === 0, 'DELETE deactivates (no physical delete)');
  ok(db.prepare('SELECT id FROM pos_terminals WHERE id=?').get(created.data.id), 'terminal row remains');

  server.close();
  try { closeSessionStore(); } catch (_) {}
  console.log('\nPOS-STITCH-P8: ' + (fail ? '❌ ' : '✅ ') + pass + ' پاس، ' + fail + ' رد');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
