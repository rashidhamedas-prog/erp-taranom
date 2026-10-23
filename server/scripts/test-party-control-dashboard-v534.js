'use strict';
/**
 * کنترل حساب اشخاص v534 — FIFO aging amounts + party-credit exposure
 * Run: node server/scripts/test-party-control-dashboard-v534.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-dash-v534-'));
process.env.DB_PATH = path.join(tmpDir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-party-control-dashboard-v534-secret-32b';
process.env.NODE_ENV = 'test';

const { getDB, initDB } = require('../db');
const { buildPartyControlDashboard, customerAgingFifoMap } = require('../lib/party-control-dashboard');
const { customerArExposureRial, resolvePartyCreditLimitRial } = require('../lib/party-credit');

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

db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, credit_limit, opening_balance, is_active, coa_code)
  VALUES (?,?,?,?,?,?,?,?,?)
`).run('P-C1', 'customer', JSON.stringify(['customer']), 'مشتری پیری', '09120000001', 1000000, 0, 1, '110301000099');
const partyCust = db.prepare('SELECT id FROM parties WHERE person_code=?').get('P-C1').id;

db.prepare(`
  INSERT INTO customers (user_id, biz, owner, city, phone, type, status, party_id, credit_limit)
  VALUES (?,?,?,?,?,?,?,?,?)
`).run(1, 'فروشگاه پیری', 'مالک', 'مشهد', '09120000001', 'بوتیک', 'active', partyCust, 0);
const custId = db.prepare('SELECT id FROM customers WHERE party_id=?').get(partyCust).id;

// دو فاکتور زنده: قدیم ۲M + جدید ۱M؛ تسویه ۱٫۵M → باقی ۰٫۵ روی قدیم + ۱ روی جدید
db.prepare(`
  INSERT INTO invoices (user_id, cust_id, type, date, rows, subtotal, disc_amt, final, final_rial, approved, deleted_at, status)
  VALUES (?,?,?,?,?,?,?,?,?,?,0,'posted')
`).run(1, custId, 'normal', '1404/01/01', '[]', 200000, 0, 200000, 2000000, 1);
db.prepare(`
  INSERT INTO invoices (user_id, cust_id, type, date, rows, subtotal, disc_amt, final, final_rial, approved, deleted_at, status)
  VALUES (?,?,?,?,?,?,?,?,?,?,0,'posted')
`).run(1, custId, 'normal', '1405/07/01', '[]', 100000, 0, 100000, 1000000, 1);
db.prepare(`
  INSERT INTO settlements (user_id, cust_id, date, amount, amount_rial, pay_type, status)
  VALUES (?,?,?,?,?,'cash','posted')
`).run(1, custId, '1405/07/15', 150000, 1500000);

db.prepare(`
  INSERT INTO customer_ledger (customer_id, date, entry_type, ref_type, ref_id, description, debit, credit, created_at)
  VALUES (?,?,?,?,?,?,?,?,strftime('%s','now'))
`).run(custId, '1404/01/01', 'invoice', 'invoice', 1, 'قدیم', 2000000, 0);
db.prepare(`
  INSERT INTO customer_ledger (customer_id, date, entry_type, ref_type, ref_id, description, debit, credit, created_at)
  VALUES (?,?,?,?,?,?,?,?,strftime('%s','now'))
`).run(custId, '1405/07/01', 'invoice', 'invoice', 2, 'جدید', 1000000, 0);
db.prepare(`
  INSERT INTO customer_ledger (customer_id, date, entry_type, ref_type, ref_id, description, debit, credit, created_at)
  VALUES (?,?,?,?,?,?,?,?,strftime('%s','now'))
`).run(custId, '1405/07/15', 'settlement', 'settlement', 1, 'تسویه', 0, 1500000);

const fifo = customerAgingFifoMap(db).get(custId);
ok(fifo && Math.abs(fifo.total - 1500000) < 1, 'FIFO total remaining 1.5M');
ok(fifo.b90plus >= 500000 - 1, 'oldest remainder in 90+ (or aged bucket)');
ok(Math.abs((fifo.b0_30 + fifo.b31_60 + fifo.b61_90 + fifo.b90plus) - fifo.total) < 1, 'bucket sum = total');

const used = customerArExposureRial(db, custId);
const limit = resolvePartyCreditLimitRial(db, custId);
ok(used === 1500000, 'AR exposure from customer_ledger 1.5M');
ok(limit === 1000000, 'limit from party.credit_limit');

const dash = buildPartyControlDashboard(db, { balance: 'all', limit: 50 });
ok(dash.version === 534, 'version 534');
ok(Array.isArray(dash.by_role), 'by_role is array');
const row = dash.parties.find((p) => p.id === partyCust);
ok(row, 'customer in parties');
ok(row.credit_used_rial === 1500000, 'credit_used from party-credit');
ok(row.credit_limit_rial === 1000000, 'credit_limit from party-credit');
ok(row.over_credit === true, 'over_credit vs AR exposure');
ok(Math.abs((row.aging_total_rial || 0) - 1500000) < 1, 'party aging_total_rial = FIFO');
ok(Math.abs((dash.aging.total || 0) - 1500000) < 1, 'dashboard aging.total = FIFO not full debit');

const lib = fs.readFileSync(path.join(__dirname, '../lib/party-control-dashboard.js'), 'utf8');
ok(lib.includes('firmSaleAliveSql'), 'uses firmSaleAliveSql');
ok(lib.includes('customerArExposureRial'), 'uses customerArExposureRial');
ok(lib.includes('customerAgingFifoMap'), 'exports fifo map');

console.log(`\nPASS ${passed} assertions — party-control-dashboard v534`);
