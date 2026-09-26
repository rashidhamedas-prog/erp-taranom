'use strict';
/**
 * Cheque dashboards (داشبورد چک + گزارش دسته) — SW v244
 * Run: node server/scripts/test-cheque-dashboards-v244.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheque-dash-v244-'));
const dbPath = path.join(tmpDir, 't.db');
process.env.DB_PATH = dbPath;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-cheque-dashboards-v244-secret-32b';
process.env.NODE_ENV = 'test';

const { getDB, initDB } = require('../db');
const { postToLedger } = require('../lib/ledger');
const { acct } = require('../lib/coa-map');
const { rialToLedger } = require('../lib/money');
const { buildChequeDashboard } = require('../lib/cheque-dashboard');
const { buildChequebookDashboard } = require('../lib/chequebook-dashboard');

initDB();
const db = getDB();

let passed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  passed++;
  console.log('OK:', msg);
}

const opening = acct(db, 'coa_opening_balance');
const recv = acct(db, 'coa_cheques_receivable');
const col = acct(db, 'coa_cheques_in_collection');
const pay = acct(db, 'coa_cheques_payable');

postToLedger(db, {
  sourceType: 'chq_test_recv',
  sourceId: 1,
  date: '1405/01/01',
  description: 'چک دریافتنی تست',
  createdBy: 1,
  lines: [
    { code: recv.code, name: recv.name, debit: rialToLedger(50_000_000), credit: 0 },
    { code: opening.code, name: opening.name, debit: 0, credit: rialToLedger(50_000_000) },
  ],
});
postToLedger(db, {
  sourceType: 'chq_test_col',
  sourceId: 2,
  date: '1405/01/01',
  description: 'در جریان وصول تست',
  createdBy: 1,
  lines: [
    { code: col.code, name: col.name, debit: rialToLedger(20_000_000), credit: 0 },
    { code: opening.code, name: opening.name, debit: 0, credit: rialToLedger(20_000_000) },
  ],
});

const partyId = db.prepare(`
  INSERT INTO parties (person_code, party_type, full_name, phone, is_active)
  VALUES ('P-CHQ244','customer','طرف تست v244','09120000001',1)
`).run().lastInsertRowid;

db.prepare(`
  INSERT INTO cheque_records (
    direction, cheque_number, due_date, party_name, party_id, amount, sayadi, lifecycle_status, status
  ) VALUES ('in', '1001', '1404/12/01', 'طرف تست', ?, 30000000, '1234567890123456', '', 'ثبت')
`).run(partyId);

db.prepare(`
  INSERT INTO cheque_records (
    direction, cheque_number, due_date, party_name, party_id, amount, sayadi, lifecycle_status, status
  ) VALUES ('in', '1002', '1405/08/01', 'طرف تست', ?, 25000000, '', 'in_collection', 'واگذار')
`).run(partyId);

db.prepare(`
  INSERT INTO cheque_records (
    direction, cheque_number, due_date, party_name, party_id, amount, lifecycle_status, status
  ) VALUES ('out', '2001', '1405/09/01', 'تأمین', ?, 15000000, '', 'registered')
`).run(partyId);

const bankId = db.prepare(`
  INSERT INTO banks (name, account_number, branch, active) VALUES ('بانک تست چک','1','مرکزی',1)
`).run().lastInsertRowid;

db.prepare(`
  INSERT INTO check_categories (bank_id, name, serial_from, serial_to, leaf_count, current_leaf, active)
  VALUES (?, 'دسته تست', '1000', '1100', 50, '1005', 1)
`).run(bankId);

const dash = buildChequeDashboard(db, '1405/01/01', '1405/12/29');
ok(dash && dash.kpis, 'cheque dashboard kpis');
ok(dash.kpis.recv_open_rial === 30_000_000, 'recv open 30M', String(dash.kpis.recv_open_rial));
ok(dash.kpis.recv_collection_rial === 25_000_000, 'in collection 25M', String(dash.kpis.recv_collection_rial));
ok(dash.kpis.pay_open_rial === 15_000_000, 'pay open 15M', String(dash.kpis.pay_open_rial));
ok(dash.gl_bridge && dash.gl_bridge.gl_recv_1109_rial === 50_000_000, 'GL 1109 = 50M', String(dash.gl_bridge.gl_recv_1109_rial));
ok(dash.gl_bridge.gl_collection_1116_rial === 20_000_000, 'GL 1116 = 20M', String(dash.gl_bridge.gl_collection_1116_rial));
ok(dash.sayadi && dash.sayadi.missing_count >= 1, 'sayadi missing detected');
ok(Array.isArray(dash.compliance) && dash.compliance.length >= 4, 'compliance checklist');
ok(typeof dash.health_score === 'number', 'health_score');
ok(Array.isArray(dash.aging), 'aging array');

const book = buildChequebookDashboard(db);
ok(book && book.kpis, 'chequebook kpis');
ok(book.kpis.book_count >= 1, 'one checkbook');
ok(book.kpis.total_leaves === 50, '50 leaves', String(book.kpis.total_leaves));
ok(Array.isArray(book.books) && book.books[0].remaining_leaves === 50, 'no usage yet');
ok(book.kpis.undelivered_pay_count === 1, 'one undelivered payable');

const empty = buildChequeDashboard(db, null, null);
ok(empty && empty.kpis && typeof empty.kpis.recv_open_rial === 'number', 'never throw empty dates');

const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
ok(sw.includes('erp-taranom-v244'), 'SW v244');

console.log('\nPassed', passed, 'assertions');
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* */ }
process.exit(0);
