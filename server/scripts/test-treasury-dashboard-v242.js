'use strict';
/**
 * Treasury dashboard (داشبورد بانک و صندوق) — SW v242
 * Proves: live GL KPIs, period movement, cash-flow sections, compliance, share_pct.
 * Run: node server/scripts/test-treasury-dashboard-v242.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'treasury-dash-v242-'));
const dbPath = path.join(tmpDir, 't.db');
process.env.DB_PATH = dbPath;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-treasury-dashboard-v242-secret-32b';
process.env.NODE_ENV = 'test';

const { getDB, initDB, syncBankAccount, syncCashBoxAccount } = require('../db');
const { acct } = require('../lib/coa-map');
const { postToLedger } = require('../lib/ledger');
const { rialToLedger } = require('../lib/money');
const { buildTreasuryDashboard } = require('../lib/treasury-dashboard');

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

db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`).run('coa_bank_default', '1102');
db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`).run('coa_cash_default', '1101');
db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`).run('coa_opening_balance', '3102');

const bankIns = db.prepare(`
  INSERT INTO banks (name, account_number, branch, active, opening_balance_rial)
  VALUES (?,?,?,?,?)
`).run('بانک تست خزانه', '1001', 'مرکزی', 1, 0);
const bankId = bankIns.lastInsertRowid;
let bank = db.prepare('SELECT * FROM banks WHERE id=?').get(bankId);
syncBankAccount(db, bank);
bank = db.prepare('SELECT * FROM banks WHERE id=?').get(bankId);
const bankCode = String(bank.coa_code || ('1102-' + bankId));

const boxIns = db.prepare(`
  INSERT INTO cash_boxes (name, custodian, is_petty_cash, active, opening_balance_rial)
  VALUES (?,?,?,?,?)
`).run('صندوق تست', 'علی', 0, 1, 0);
const boxId = boxIns.lastInsertRowid;
let box = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(boxId);
if (typeof syncCashBoxAccount === 'function') syncCashBoxAccount(db, box);
box = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(boxId);
const boxCode = String(box.coa_code || ('1101-' + boxId));

const opening = acct(db, 'coa_opening_balance');
postToLedger(db, {
  sourceType: 'treasury_test_open',
  sourceId: bankId,
  date: '1405/01/01',
  description: 'افتتاحیه بانک تست',
  createdBy: 1,
  voucherType: 'opening',
  lines: [
    { code: bankCode, name: 'بانک تست', debit: rialToLedger(80_000_000), credit: 0 },
    { code: opening.code, name: opening.name, debit: 0, credit: rialToLedger(80_000_000) },
  ],
});
postToLedger(db, {
  sourceType: 'treasury_test_open',
  sourceId: boxId,
  date: '1405/01/01',
  description: 'افتتاحیه صندوق تست',
  createdBy: 1,
  voucherType: 'opening',
  lines: [
    { code: boxCode, name: 'صندوق تست', debit: rialToLedger(20_000_000), credit: 0 },
    { code: opening.code, name: opening.name, debit: 0, credit: rialToLedger(20_000_000) },
  ],
});
// Period inflow to bank
postToLedger(db, {
  sourceType: 'treasury_test_in',
  sourceId: bankId,
  date: '1405/02/10',
  description: 'واریز تست',
  createdBy: 1,
  lines: [
    { code: bankCode, name: 'بانک تست', debit: rialToLedger(5_000_000), credit: 0 },
    { code: opening.code, name: opening.name, debit: 0, credit: rialToLedger(5_000_000) },
  ],
});

const d = buildTreasuryDashboard(db, '1405/01/01', '1405/12/29');

ok(d && d.kpis, 'payload has kpis');
ok(d.kpis.total_liquidity_rial === 105_000_000, 'total liquidity = 105M (80+20+5)', String(d.kpis.total_liquidity_rial));
ok(d.kpis.banks_total_rial === 85_000_000, 'banks total = 85M', String(d.kpis.banks_total_rial));
ok(d.kpis.cash_total_rial === 20_000_000, 'cash total = 20M', String(d.kpis.cash_total_rial));
ok(d.kpis.period_inflow_rial >= 105_000_000, 'period inflow includes openings+deposit', String(d.kpis.period_inflow_rial));
ok(Array.isArray(d.banks) && d.banks.length >= 1, 'banks array');
ok(Array.isArray(d.cash_boxes) && d.cash_boxes.length >= 1, 'cash_boxes array');
ok(d.banks[0].share_pct > 0, 'bank share_pct computed');
ok(d.cash_flow && d.cash_flow.sections && d.cash_flow.sections.operating, 'IAS7 operating section');
ok(Array.isArray(d.compliance) && d.compliance.length >= 3, 'compliance checklist');
ok(typeof d.health_score === 'number' && d.health_score >= 0, 'health_score');
ok(d.concentration && d.concentration.top_name, 'concentration top account');
ok(Array.isArray(d.monthly_net), 'monthly_net array');
ok(d.reconciliation && typeof d.reconciliation.open_count === 'number', 'reconciliation block');
ok(d.cheques && typeof d.cheques.pending_in_rial === 'number', 'cheques block');

// Negative balance alert
postToLedger(db, {
  sourceType: 'treasury_test_out',
  sourceId: boxId,
  date: '1405/03/01',
  description: 'برداشت بیش از مانده',
  createdBy: 1,
  lines: [
    { code: opening.code, name: opening.name, debit: rialToLedger(25_000_000), credit: 0 },
    { code: boxCode, name: 'صندوق تست', debit: 0, credit: rialToLedger(25_000_000) },
  ],
});
const d2 = buildTreasuryDashboard(db, '1405/01/01', '1405/12/29');
ok((d2.alerts || []).some((a) => a.severity === 'fail' && /منفی/.test(a.title || '')), 'negative cash alert');
ok((d2.compliance || []).some((c) => c.id === 'live_balances' && c.status === 'fail'), 'compliance fails on negative');

// Never-throw on empty DB path: build with bogus still returns object
const empty = buildTreasuryDashboard(db, null, null);
ok(empty && empty.kpis && typeof empty.kpis.total_liquidity_rial === 'number', 'null dates still returns kpis');

console.log('\nPassed', passed, 'assertions');
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* */ }
process.exit(0);
