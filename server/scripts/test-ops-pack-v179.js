/**
 * OPS pack v179 — cash-flow never 500 · cheque واگذاری/خرج · fabric بها + PATCH.
 * Run: node server/scripts/test-ops-pack-v179.js
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-pack-v179-'));
const dbFile = path.join(dir, 't.db');
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-ops-pack-v179-secret-at-least-32b';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';

delete require.cache[require.resolve('../db')];
try { delete require.cache[require.resolve('../lib/coa-map')]; } catch (_) {}

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const { acct } = require('../lib/coa-map');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');
const { buildCashFlowReport, isCashBankCode } = require('../lib/cash-flow');

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
      AND COALESCE(je.status,'posted')<>'reversed'
  `).get(accountCode, sourceType, sourceId);
  return { debit: Number(row.debit), credit: Number(row.credit) };
}

(async () => {
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'ops-v179', device_fingerprint: 'ops-v179-fp',
  }).token;

  const app = express();
  app.use(express.json());
  app.use('/api/adv-reports', require('../routes/adv-reports'));
  app.use('/api/cheque-records', require('../routes/cheque-records'));
  app.use('/api/inventory', require('../routes/inventory'));
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

  console.log('\n— cash-flow never 500 —');
  ok(isCashBankCode(null, new Set(['1101'])) === false, 'isCashBankCode(null) safe');
  ok(isCashBankCode(undefined, new Set(['1101'])) === false, 'isCashBankCode(undefined) safe');
  ok(isCashBankCode('', new Set(['1101'])) === false, 'isCashBankCode("") safe');
  ok(isCashBankCode('1101', new Set(['1101'])) === true, 'isCashBankCode(1101)');

  const jeId = db.prepare(`
    INSERT INTO journal_entries (entry_date, description, ref_type, ref_id, created_by)
    VALUES ('1405/06/01','ردیف ناقص جریان نقد','cashflow_probe',1,?)
  `).run(admin.id).lastInsertRowid;
  db.prepare(`
    INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit)
    VALUES (?,?,?,?,?)
  `).run(jeId, '', 'بدون کد', 0, 0);
  db.prepare(`
    INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit)
    VALUES (?,?,?,?,?)
  `).run(jeId, '1101', 'صندوق', 250000, 0);
  db.prepare(`
    INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit)
    VALUES (?,?,?,?,?)
  `).run(jeId, '1103', 'دریافتنی', 0, 250000);

  let threw = false;
  let report;
  try { report = buildCashFlowReport(db, '1405/01/01', '1405/12/29'); }
  catch (e) { threw = true; report = { error: e.message }; }
  ok(!threw && report && typeof report.total_net_rial === 'number', 'buildCashFlowReport no throw', report && report.error);
  ok(report && report.sections && report.sections.operating, 'sections present');

  const cf = await api('GET', '/api/adv-reports/cash-flow?from=1405/01/01&to=1405/12/29');
  ok(cf.status === 200 && cf.data && cf.data.sections, 'GET cash-flow 200 not 500', cf.status + ' ' + (cf.data && cf.data.error));
  ok(typeof (cf.data && cf.data.total_net_rial) === 'number', 'cash-flow total_net_rial');

  console.log('\n— menu D: sales invoices only —');
  const navSrc = fs.readFileSync(path.join(__dirname, '../public/acc-nav.js'), 'utf8');
  const opsBlock = navSrc.split("title: 'فروش و خرید'")[1] || '';
  ok(opsBlock.includes("label: 'فاکتورهای فروش'"), 'nav has فاکتورهای فروش');
  ok(!/label: 'فاکتور معمولی'/.test(opsBlock), 'nav ops has no فاکتور معمولی');
  ok(!/label: 'فاکتور رسمی'/.test(opsBlock), 'nav ops has no فاکتور رسمی');
  ok(!/label: 'پیش‌فاکتور'/.test(opsBlock), 'nav ops has no پیش‌فاکتور');

  console.log('\n— cheque واگذاری + خرج —');
  const AMT = 1_800_000;
  const partyId = db.prepare(`
    INSERT INTO parties (person_code, party_type, full_name, phone, is_active)
    VALUES ('P-V179','other','طرف چک v179','09150000001',1)
  `).run().lastInsertRowid;
  const bankCoa = acct(db, 'coa_bank_default');
  const bankId = db.prepare(`
    INSERT INTO banks (name, account_number, active, coa_code) VALUES ('بانک واگذاری','1010',1,?)
  `).run(bankCoa.code).lastInsertRowid;
  const supId = db.prepare(`INSERT INTO suppliers (name) VALUES ('ذینفع خرج v179')`).run().lastInsertRowid;

  let r = await api('POST', '/api/cheque-records', {
    direction: 'in', cheque_number: 'VGZ-001', amount: AMT,
    party_id: partyId, party_name: 'مشتری واگذاری', due_date: '1405/06/20',
  });
  ok(r.status === 200 && r.data && r.data.id, 'create in cheque', r.data && r.data.error);
  const vgzId = r.data.id;

  r = await api('POST', `/api/cheque-records/${vgzId}/send-to-bank`, { date: '1405/06/02' });
  ok(r.status === 400 && r.data && r.data.code === 'E_CHEQUE_BANK', 'واگذاری without bank rejected', r.data && r.data.code);

  r = await api('POST', `/api/cheque-records/${vgzId}/send-to-bank`, {
    date: '1405/06/02', collection_bank_id: bankId,
  });
  ok(r.status === 200 && r.data && r.data.lifecycle_status === 'in_collection', 'send-to-bank → in_collection', r.data && r.data.error);
  const row = db.prepare('SELECT status, lifecycle_status, collection_bank_id FROM cheque_records WHERE id=?').get(vgzId);
  ok(row && row.status === 'واگذارشده', 'status واگذارشده', row && row.status);
  ok(Number(row && row.collection_bank_id) === bankId, 'collection_bank_id stored');
  const coll = acct(db, 'coa_cheques_in_collection');
  const recv = acct(db, 'coa_cheques_receivable');
  const collNet = jeNetRial(coll.code, 'cheque_send_to_bank', vgzId);
  const recvNet = jeNetRial(recv.code, 'cheque_send_to_bank', vgzId);
  ok(collNet.debit === AMT && collNet.credit === 0, 'واگذاری Dr در جریان وصول', JSON.stringify(collNet));
  ok(recvNet.credit === AMT && recvNet.debit === 0, 'واگذاری Cr اسناد دریافتنی', JSON.stringify(recvNet));

  r = await api('POST', '/api/cheque-records', {
    direction: 'in', cheque_number: 'END-SUP', amount: AMT,
    party_id: partyId, party_name: 'مشتری خرج', due_date: '1405/06/21',
  });
  const endId = r.data && r.data.id;
  r = await api('POST', `/api/cheque-records/${endId}/endorse`, {
    date: '1405/06/03', supplier_id: supId,
  });
  ok(r.status === 200 && r.data && r.data.lifecycle_status === 'endorsed', 'endorse with supplier', r.data && r.data.error);
  const sl = db.prepare(`
    SELECT debit, credit, entry_type, ref_type FROM supplier_ledger
    WHERE supplier_id=? AND ref_type='cheque_endorse' AND ref_id=?
  `).get(supId, endId);
  ok(sl && Number(sl.debit) === AMT && Number(sl.credit) === 0, 'supplier_ledger payment debit', sl);
  ok(sl && sl.entry_type === 'payment', 'endorse entry_type=payment');
  const endRecv = jeNetRial(recv.code, 'cheque_endorse', endId);
  ok(endRecv.credit === AMT, 'endorse Cr notes receivable', JSON.stringify(endRecv));
  const stored = db.prepare('SELECT endorse_supplier_id FROM cheque_records WHERE id=?').get(endId);
  ok(Number(stored && stored.endorse_supplier_id) === supId, 'endorse_supplier_id stored');

  console.log('\n— fabric بها + edit —');
  const raw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get();
  ok(!!(raw && raw.id), 'WH-RAW exists');
  const prodId = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, average_cost_rial, cost)
    VALUES (?, 'پارچه تست v179', 'FAB-V179', 0, 0, 'متر', 12000, 12000)
  `).run(admin.id).lastInsertRowid;

  const rec0 = await api('POST', '/api/inventory/fabric-rolls', {
    product_id: prodId, warehouse_id: raw.id, color: 'طوسی', pattern: 'ساده',
    width_cm: 150, meters: 100, unit: 'متر', supplier_id: supId,
    roll_no: 'LOT-V179', date: '1405/06/01', idempotency_key: 'fab-v179-0',
  });
  ok(rec0.status === 200 && rec0.data && rec0.data.id, 'receive with implicit cost 200', rec0.data && rec0.data.error);
  ok(Number(rec0.data && rec0.data.unit_cost_rial) === 12000, 'unit_cost from product', rec0.data && rec0.data.unit_cost_rial);

  const listed = await api('GET', '/api/inventory/fabric-rolls');
  const found = (listed.data && listed.data.rows || []).find((x) => x.id === rec0.data.id);
  ok(found && Number(found.amount_rial) === 12000 * 100, 'list amount_rial = متر × فی', found && found.amount_rial);

  const patched = await api('PATCH', `/api/inventory/fabric-rolls/${rec0.data.id}`, {
    meters: 80, unit_cost_rial: 15000, color: 'طوسی', supplier_id: supId, date: '1405/06/04',
  });
  ok(patched.status === 200 && Number(patched.data && patched.data.unit_cost_rial) === 15000, 'PATCH unit cost', patched.data && patched.data.error);
  ok(Number(patched.data && patched.data.qty_received) === 80, 'PATCH meters', patched.data && patched.data.qty_received);
  const listed2 = await api('GET', '/api/inventory/fabric-rolls');
  const found2 = (listed2.data && listed2.data.rows || []).find((x) => x.id === rec0.data.id);
  ok(found2 && Number(found2.amount_rial) === 15000 * 80, 'list amount after edit', found2 && found2.amount_rial);

  const slFab = db.prepare(`
    SELECT COALESCE(SUM(credit),0) c, COALESCE(SUM(debit),0) d
    FROM supplier_ledger WHERE supplier_id=? AND ref_type='fabric_roll' AND ref_id=?
  `).get(supId, rec0.data.id);
  ok(Number(slFab.c) - Number(slFab.d) === 15000 * 80, 'supplier net after edit = new amount', slFab);

  server.close();
  try { closeSessionStore(); } catch (_) {}
  console.log('\nOPS v179: ' + (fail ? '❌ ' : '✅ ') + pass + ' پاس، ' + fail + ' رد');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
