'use strict';
/**
 * داشبورد کنترل حساب اشخاص — SW v533 (worklist + aging filter + concentration)
 * Run: node server/scripts/test-party-control-dashboard-v533.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-dash-v533-'));
const dbPath = path.join(tmpDir, 't.db');
process.env.DB_PATH = dbPath;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-party-control-dashboard-v533-secret-32b';
process.env.NODE_ENV = 'test';

const { getDB, initDB } = require('../db');
const { buildPartyControlDashboard, primaryRole, nextActionFor } = require('../lib/party-control-dashboard');

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

ok(primaryRole(['employee', 'customer']) === 'customer', 'primaryRole prefers customer');
ok(nextActionFor({ over_credit: true, balance_rial: 1 }).code === 'credit_limit', 'nextAction over_credit');

db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, credit_limit, opening_balance, is_active, coa_code)
  VALUES (?,?,?,?,?,?,?,?,?)
`).run('P-C1', 'customer', JSON.stringify(['customer']), 'مشتری بدهکار', '09120000001', 1000000, 0, 1, '110301000099');
const partyCust = db.prepare('SELECT id FROM parties WHERE person_code=?').get('P-C1').id;

db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, credit_limit, opening_balance, is_active)
  VALUES (?,?,?,?,?,?,?,?)
`).run('P-S1', 'supplier', JSON.stringify(['supplier']), 'تأمین‌کننده بستانکار', '09120000002', 0, -500000, 1);

db.prepare(`
  INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, credit_limit, opening_balance, is_active)
  VALUES (?,?,?,?,?,?,?,?)
`).run('P-D1', 'customer', JSON.stringify(['customer', 'employee']), 'دو نقشی', '09120000004', 0, 0, 1);
const partyDual = db.prepare('SELECT id FROM parties WHERE person_code=?').get('P-D1').id;

db.prepare(`
  INSERT INTO customers (user_id, biz, owner, city, phone, type, status, party_id)
  VALUES (?,?,?,?,?,?,?,?)
`).run(1, 'فروشگاه کنترل', 'مالک', 'مشهد', '09120000001', 'بوتیک', 'active', partyCust);
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
ok(dash && dash.version === 533, 'payload version 533');
ok(dash.kpis.parties_total >= 3, 'counts seeded parties');
ok(dash.kpis.total_debit_rial >= 2500000, 'customer debit from ledger');
ok(dash.kpis.total_credit_rial >= 500000, 'supplier opening credit');
ok(typeof dash.kpis.top5_debtor_share_pct === 'number', 'concentration kpi');
ok(dash.concentration && Array.isArray(dash.concentration.top_debtors), 'concentration block');
ok(Array.isArray(dash.worklist) && dash.worklist.length >= 1, 'worklist non-empty');
ok(dash.worklist[0].next_action_code, 'worklist has next_action_code');
ok(dash.worklist[0].linked_customer_id === custId || dash.parties.some((p) => p.linked_customer_id === custId), 'customer link present');

const custRow = dash.parties.find((p) => p.id === partyCust);
ok(custRow && custRow.over_credit === true, 'over credit flagged');
ok(custRow.primary_role === 'customer', 'primary_role on party');

const dual = dash.parties.find((p) => p.id === partyDual) || buildPartyControlDashboard(db, { balance: 'all', search: 'دو نقشی' }).parties[0];
ok(dual && dual.primary_role === 'customer', 'dual-role primary is customer');

const byRoleDebitSum = (dash.by_role || []).reduce((s, r) => s + (Number(r.debit_rial) || 0), 0);
ok(byRoleDebitSum === dash.kpis.total_debit_rial, 'by_role debit sum equals total (no double-count)');

const over = buildPartyControlDashboard(db, { risk: 'over_credit', balance: 'all' });
ok(over.parties.every((p) => p.over_credit), 'risk=over_credit filter');
ok((over.alerts || []).some((a) => a.action_filter && a.action_filter.risk === 'over_credit'), 'alert carries action_filter');

const aged = buildPartyControlDashboard(db, { aging_bucket: 'b90plus', balance: 'nonzero', side: 'debit' });
ok(Array.isArray(aged.parties), 'aging_bucket filter returns array');

const libSrc = fs.readFileSync(path.join(__dirname, '../lib/party-control-dashboard.js'), 'utf8');
ok(libSrc.includes('partySignedBalanceDetailMap'), 'uses partySignedBalanceDetailMap');
ok(libSrc.includes('aging_bucket'), 'aging_bucket filter in lib');

const uiSrc = fs.readFileSync(path.join(__dirname, '../public/portal-ui.js'), 'utf8');
ok(uiSrc.includes('pcOpenCard'), 'UI opens party card modal');
ok(uiSrc.includes('pcFmtCompact'), 'compact money formatter');
ok(uiSrc.includes('صف اقدام امروز'), 'worklist-first heading');
ok(uiSrc.includes('pcAging'), 'aging select in filters');

const cssSrc = fs.readFileSync(path.join(__dirname, '../public/app.css'), 'utf8');
ok(cssSrc.includes('pc-kpi-grid'), 'pc-kpi-grid styles');
ok(cssSrc.includes('--pc-age-0'), 'aging CSS vars');

console.log(`\nPASS ${passed} assertions — party-control-dashboard v533`);
