/**
 * POS batch settle — fee/shortage expense lines need cost center when
 * require_cc_on_expense=1 (6114 / 6102). SW v535.
 * Run: node server/scripts/test-pos-batch-fee-cc-v535.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-fee-cc-v535-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-pos-fee-cc-v535-secret-32bytes!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra != null ? extra : ''); }
}

function expenseLinesOf(batchId) {
  const je = db.prepare(
    "SELECT id FROM journal_entries WHERE ref_type='pos_batch' AND ref_id=? AND COALESCE(deleted_at,0)=0 ORDER BY id DESC LIMIT 1"
  ).get(batchId);
  if (!je) return [];
  return db.prepare(
    `SELECT account_code, debit, credit, cost_center_id FROM journal_lines
     WHERE entry_id=? AND account_code IN ('6114','6102') ORDER BY id`
  ).all(je.id);
}

(async () => {
  const cols = db.prepare('PRAGMA table_info(pos_settlement_batches)').all().map((c) => c.name);
  ok(cols.includes('fee_cost_center_id'), 'pos_settlement_batches.fee_cost_center_id exists');

  const { FK_COLUMNS } = require('../sync/tables');
  ok(
    FK_COLUMNS.some((p) => p[0] === 'pos_settlement_batches' && p[1] === 'fee_cost_center_id'),
    'FK_COLUMNS includes pos_settlement_batches.fee_cost_center_id'
  );

  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('require_cc_on_expense','1')").run();

  const ccId = db.prepare(
    "INSERT INTO cost_centers (code,name,active) VALUES ('CC-POS-FEE','مرکز کارمزد POS',1)"
  ).run().lastInsertRowid;

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test',
    device_name: 'pos-fee-cc-v535',
    device_fingerprint: 'pos-fee-cc-v535-fp',
  }).token;

  const bankCoa = '1102-posfee';
  db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level) VALUES (?,?,?,?,?)')
    .run(bankCoa, 'بانک تست کارمزد POS', 'asset', '1102', 4);
  const bankId = db.prepare(`
    INSERT INTO banks (name, account_number, active, coa_code) VALUES ('بانک POS fee','010535',1,?)
  `).run(bankCoa).lastInsertRowid;

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/pos', require('../routes/pos'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const BASE = `http://127.0.0.1:${port}`;

  async function post(p, body) {
    const res = await fetch(BASE + p, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }

  const term = await post('/api/pos/terminals', {
    name: 'پایانه تست کارمزد',
    terminal_id: 'TERM-FEE-535',
    bank_id: bankId,
  });
  ok(term.status === 200 || term.status === 201, 'create terminal', term);
  const terminalId = term.data && (term.data.id || term.data.terminal_id);
  ok(!!terminalId, 'terminal id', term.data);

  const rec = await post('/api/pos/receipts', {
    terminal_id: terminalId,
    date: '1405/08/02',
    amount_rial: 10_000_000,
    idempotency_key: 'pos-r-fee-cc-1',
  });
  ok(rec.status === 200 || rec.status === 201, 'create open receipt', rec);
  const receiptId = rec.data && rec.data.id;
  ok(!!receiptId, 'receipt id', rec.data);

  const noCc = await post('/api/pos/batches', {
    date: '1405/08/02',
    gross_rial: 10_000_000,
    fee_rial: 50_000,
    shortage_rial: 0,
    receipt_ids: [receiptId],
    idempotency_key: 'pos-b-fee-no-cc',
  });
  ok(noCc.status === 422, 'fee without CC → 422', noCc);
  ok(
    noCc.data && (noCc.data.code === 'E_POS_FEE_CC_REQUIRED' || /مرکز هزینه/.test(String(noCc.data.error || noCc.data.message || ''))),
    'error code E_POS_FEE_CC_REQUIRED',
    noCc.data
  );

  const withCc = await post('/api/pos/batches', {
    date: '1405/08/02',
    gross_rial: 10_000_000,
    fee_rial: 50_000,
    shortage_rial: 10_000,
    fee_cost_center_id: ccId,
    receipt_ids: [receiptId],
    idempotency_key: 'pos-b-fee-with-cc',
  });
  ok(withCc.status === 200 || withCc.status === 201, 'fee+shortage with CC → OK', withCc);
  const batchId = withCc.data && withCc.data.id;
  ok(!!batchId, 'batch id', withCc.data);
  ok(Number(withCc.data.fee_cost_center_id) === Number(ccId), 'batch stores fee_cost_center_id', withCc.data);

  const elines = expenseLinesOf(batchId);
  ok(elines.length === 2, 'two expense lines (6114+6102)', elines);
  ok(elines.every((l) => Number(l.cost_center_id) === Number(ccId)), 'both expense lines stamped with CC', elines);

  // Zero fee/shortage: no CC required even with policy ON
  const rec2 = await post('/api/pos/receipts', {
    terminal_id: terminalId,
    date: '1405/08/02',
    amount_rial: 2_000_000,
    idempotency_key: 'pos-r-fee-cc-2',
  });
  const rid2 = rec2.data && rec2.data.id;
  const zeroFee = await post('/api/pos/batches', {
    date: '1405/08/02',
    gross_rial: 2_000_000,
    fee_rial: 0,
    shortage_rial: 0,
    receipt_ids: [rid2],
    idempotency_key: 'pos-b-zero-fee',
  });
  ok(zeroFee.status === 200 || zeroFee.status === 201, 'zero fee/shortage without CC → OK', zeroFee);

  server.close();
  try { closeSessionStore(); } catch (_) {}
  try { closeDB(); } catch (_) {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
