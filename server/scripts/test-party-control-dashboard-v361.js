'use strict';
/**
 * داشبورد کنترل حساب اشخاص — SW v361
 * Run: node server/scripts/test-party-control-dashboard-v361.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-dash-v361-'));
const dbPath = path.join(tmpDir, 't.db');
process.env.DB_PATH = dbPath;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-party-control-dashboard-v361-secret-32b';
process.env.NODE_ENV = 'test';

const { getDB, initDB } = require('../db');
const { buildPartyControlDashboard } = require('../lib/party-control-dashboard');

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
`).run('P-C1', 'customer', JSON.stringify(['customer']), 'مشتری بدهکار', '09120000001', 1000000, 0, 1, '110301000099');
const partyCust = db.prepare('SELECT id FROM parties WHERE person_code=?').get('P-C1').id;

db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, credit_limit, opening_balance, is_active)
  VALUES (?,?,?,?,?,?,?,?)
`).run('P-S1', 'supplier', JSON.stringify(['supplier']), 'تأمین‌کننده بستانکار', '09120000002', 0, -500000, 1);
const partySup = db.prepare('SELECT id FROM parties WHERE person_code=?').get('P-S1').id;

db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, credit_limit, opening_balance, is_active)
  VALUES (?,?,?,?,?,?,?,?)
`).run('P-E1', 'other', JSON.stringify(['employee']), 'کارمند بدون مانده', '09120000003', 0, 0, 1);

db.prepare(`
  INSERT INTO customers (user_id, biz, owner, city, phone, type, status, party_id, credit_limit)
  VALUES (?,?,?,?,?,?,?,?,?)
`).run(1, 'فروشگاه کنترل', 'مالک', 'مشهد', '09120000001', 'بوتیک', 'active', partyCust, 1000000);
const custId = db.prepare('SELECT id FROM customers WHERE party_id=?').get(partyCust).id;

db.prepare(`
  INSERT INTO customer_ledger (customer_id, date, entry_type, ref_type, ref_id, description, debit, credit, created_at)
  VALUES (?,?,?,?,?,?,?,?,strftime('%s','now'))
`).run(custId, '1405/07/01', 'invoice', 'invoice', 1, 'فاکتور تست', 2500000, 0);

db.prepare(`
  INSERT INTO invoices (user_id, cust_id, type, date, rows, subtotal, disc_amt, final, final_rial, approved, deleted_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,0)
`).run(1, custId, 'normal', '1405/07/01', '[]', 250000, 0, 250000, 2500000, 1);

const dash = buildPartyControlDashboard(db, { balance: 'all', limit: 100 });
ok(dash && dash.kpis, 'payload has kpis');
ok(dash.kpis.parties_total >= 3, 'counts seeded parties');
ok(dash.kpis.total_debit_rial >= 2500000, 'customer debit from ledger reflected');
ok(dash.kpis.total_credit_rial >= 500000, 'supplier opening credit reflected');
ok(Array.isArray(dash.by_role) && dash.by_role.some((r) => r.role === 'customer'), 'by_role includes customer');
ok(Array.isArray(dash.parties) && dash.parties.length >= 1, 'parties list non-empty');

const custRow = dash.parties.find((p) => p.id === partyCust);
ok(custRow, 'customer party in list');
ok(custRow.balance_rial === 2500000, 'customer live balance 2.5M rial');
ok(custRow.over_credit === true, 'over credit when used > limit');
ok(custRow.linked_customer_id === custId, 'linked_customer_id set');

const filtered = buildPartyControlDashboard(db, { role: 'employee', balance: 'all' });
ok(filtered.parties.every((p) => (p.party_roles || []).includes('employee')), 'role filter employee');

const debitOnly = buildPartyControlDashboard(db, { side: 'debit', balance: 'nonzero' });
ok(debitOnly.parties.every((p) => p.balance_rial > 0), 'side=debit only positive');

const risk = buildPartyControlDashboard(db, { risk: 'over_credit', balance: 'all' });
ok(risk.parties.every((p) => p.over_credit), 'risk=over_credit filter');
ok((dash.worklist || []).length >= 1, 'worklist has items');
ok(dash.aging && typeof dash.aging.total === 'number', 'aging block present');
ok(typeof dash.health_score === 'number', 'health_score numeric');

const src = fs.readFileSync(path.join(__dirname, '../lib/party-control-dashboard.js'), 'utf8');
ok(src.includes('partySignedBalanceMap'), 'uses party-books');
ok(src.includes('buildPartyControlDashboard'), 'exports builder');

const routeSrc = fs.readFileSync(path.join(__dirname, '../routes/adv-reports.js'), 'utf8');
ok(routeSrc.includes('/party-control-dashboard'), 'route registered');

const navSrc = fs.readFileSync(path.join(__dirname, '../public/acc-nav.js'), 'utf8');
ok(navSrc.includes('acc-party-control-dashboard'), 'nav item present');

const uiSrc = fs.readFileSync(path.join(__dirname, '../public/portal-ui.js'), 'utf8');
ok(uiSrc.includes('renderPartyControlDashboardTab'), 'UI render present');

console.log(`\nPASS ${passed} assertions — party-control-dashboard v361`);
