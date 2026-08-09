'use strict';
/**
 * W1-HR1 — payroll params snapshot immutability.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

function loadBetterSqlite3() {
  const candidates = [
    path.join(__dirname, '..', 'node_modules', 'better-sqlite3'),
    'D:/soft/Claud/porje/crm-taranom/erp-taranom1/server/node_modules/better-sqlite3',
  ];
  for (const c of candidates) {
    try { return require(c); } catch (_) {}
  }
  return require('better-sqlite3');
}
const Database = loadBetterSqlite3();
const {
  initPayrollSchema,
  buildPayrollParamsSnapshot,
  savePeriodParamsSnapshot,
  loadPeriodParamsSnapshot,
  resolveLaborSettingsForPeriod,
} = require('../lib/payroll/schema');

let passed = 0;
let failed = 0;
function ok(name, cond) {
  if (cond) { passed += 1; console.log(`  PASS ${name}`); }
  else { failed += 1; console.error(`  FAIL ${name}`); }
}

const dbPath = path.join(os.tmpdir(), `w1-hr1-${Date.now()}.db`);
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE persons (id INTEGER PRIMARY KEY, name TEXT, active INTEGER DEFAULT 1);
  CREATE TABLE payroll_records (id INTEGER PRIMARY KEY AUTOINCREMENT);
  CREATE TABLE chart_of_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT);
  CREATE TABLE journal_entries (id INTEGER PRIMARY KEY AUTOINCREMENT);
  CREATE TABLE journal_lines (id INTEGER PRIMARY KEY AUTOINCREMENT);
`);
initPayrollSchema(db);

// Ensure labor settings table exists (normally from gap-accounting-schema)
db.exec(`
  CREATE TABLE IF NOT EXISTS payroll_labor_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year INTEGER NOT NULL UNIQUE,
    min_wage_daily_rial INTEGER NOT NULL DEFAULT 0,
    housing_allowance_rial INTEGER NOT NULL DEFAULT 0,
    food_allowance_rial INTEGER NOT NULL DEFAULT 0,
    child_allowance_rial INTEGER NOT NULL DEFAULT 0,
    seniority_base_rial INTEGER NOT NULL DEFAULT 0,
    insurance_cap_monthly_rial INTEGER NOT NULL DEFAULT 0,
    overtime_factor REAL NOT NULL DEFAULT 1.4,
    night_factor REAL NOT NULL DEFAULT 1.35,
    friday_factor REAL NOT NULL DEFAULT 1.4,
    shift_factor REAL NOT NULL DEFAULT 1.225,
    tax_exemption_rial INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

const year = 1405;
db.prepare(`
  INSERT INTO payroll_labor_settings (year, min_wage_daily_rial, housing_allowance_rial, food_allowance_rial)
  VALUES (?, 1000000, 500000, 400000)
`).run(year);
db.prepare(`
  INSERT INTO payroll_tax_brackets (fiscal_year, bracket_order, bracket_min_rial, bracket_max_rial, tax_rate_bp, active)
  VALUES (?, 1, 0, 100000000, 1000, 1)
`).run(year);

const periodIns = db.prepare(`
  INSERT INTO payroll_periods (fiscal_year, month_no, label, start_date, end_date, status)
  VALUES (?, 1, '1405-01', '1405/01/01', '1405/01/31', 'open')
`).run(year);
const periodId = periodIns.lastInsertRowid;

console.log('W1-HR1 test-payroll-snapshot');

const snapA = buildPayrollParamsSnapshot(db, year);
ok('snapshot has labor A', snapA.labor && snapA.labor.min_wage_daily_rial === 1000000);
ok('snapshot has brackets', Array.isArray(snapA.brackets) && snapA.brackets.length === 1);

savePeriodParamsSnapshot(db, periodId, snapA);
db.prepare("UPDATE payroll_periods SET status='processed', processed_at=strftime('%s','now') WHERE id=?").run(periodId);

// Mutate live settings to B
db.prepare(`
  UPDATE payroll_labor_settings SET min_wage_daily_rial=9999999, housing_allowance_rial=1 WHERE year=?
`).run(year);

const loaded = loadPeriodParamsSnapshot(db, periodId);
ok('loaded snapshot still A wage', loaded.labor.min_wage_daily_rial === 1000000);
ok('loaded snapshot still A housing', loaded.labor.housing_allowance_rial === 500000);

const period = db.prepare('SELECT * FROM payroll_periods WHERE id=?').get(periodId);
const resolved = resolveLaborSettingsForPeriod(db, period);
ok('resolve prefers snapshot', resolved.min_wage_daily_rial === 1000000);

const live = db.prepare('SELECT * FROM payroll_labor_settings WHERE year=?').get(year);
ok('live settings changed to B', live.min_wage_daily_rial === 9999999);

db.close();
try { fs.unlinkSync(dbPath); } catch (_) {}
console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
