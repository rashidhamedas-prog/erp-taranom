'use strict';
/**
 * Audit 7B — subledger recon: cheques / payroll / VAT / WIP + E_NO_PAYABLE_LEAF.
 *
 * Run:
 *   $env:DB_PATH="server/.tmp-test-artifacts/wave-test-7b.db"
 *   npm --prefix server run test:audit-7b
 *
 * Uses a throw-away DB at DB_PATH (deleted + recreated). Refuses crm*.db.
 */
const path = require('path');
const fs = require('fs');
const { swAtLeast } = require('./lib/sw-at-least');

(function guardDbPath() {
  const raw = process.env.DB_PATH || path.join(__dirname, '../.tmp-test-artifacts/wave-test-7b.db');
  process.env.DB_PATH = raw;
  if (/^crm.*\.db$/i.test(path.basename(raw))) {
    console.error('FATAL: DB_PATH looks like production crm*.db:', path.basename(raw));
    process.exit(1);
  }
  if (!/\.tmp-test-artifacts/i.test(raw.replace(/\\/g, '/'))) {
    console.error('FATAL: DB_PATH must live under .tmp-test-artifacts');
    process.exit(1);
  }
})();

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✅', name); }
  else { fail += 1; console.log('  ❌', name, extra == null ? '' : extra); }
}

console.log('\n══ Audit 7B — recon cheques/payroll/vat/wip + payable leaf ══\n');

let Database;
try {
  const Better = require('better-sqlite3');
  new Better(':memory:').close();
  Database = Better;
} catch (_) {
  Database = require('node:sqlite').DatabaseSync;
  console.log('  ℹ️  better-sqlite3 binding missing — using node:sqlite fallback');
}

const dbPath = path.resolve(process.env.DB_PATH);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch (_) { /* none */ } }
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE chart_of_accounts (
    code TEXT PRIMARY KEY, name TEXT, type TEXT, parent_code TEXT, is_leaf INTEGER DEFAULT 1, active INTEGER DEFAULT 1
  );
  CREATE TABLE journal_entries (
    id INTEGER PRIMARY KEY, entry_date TEXT, description TEXT, ref_type TEXT, ref_id INTEGER,
    deleted_at INTEGER DEFAULT 0, status TEXT DEFAULT 'posted'
  );
  CREATE TABLE journal_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id INTEGER, account_code TEXT, account_name TEXT,
    debit REAL DEFAULT 0, credit REAL DEFAULT 0, debit_rial INTEGER DEFAULT 0, credit_rial INTEGER DEFAULT 0, line_no INTEGER
  );
  CREATE TABLE cheque_records (
    id INTEGER PRIMARY KEY, direction TEXT, amount REAL, lifecycle_status TEXT, record_status TEXT,
    journal_entry_id INTEGER
  );
  CREATE TABLE payroll_records (
    id INTEGER PRIMARY KEY, person_id INTEGER, period_label TEXT, date TEXT, status TEXT,
    net_pay REAL, net_pay_rial INTEGER, arrears_rial INTEGER DEFAULT 0, paid INTEGER DEFAULT 0,
    payment_journal_id INTEGER, settlement_mode TEXT DEFAULT 'labor',
    sso_employee_rial INTEGER DEFAULT 0, sso_employer_rial INTEGER DEFAULT 0,
    sso_employer_base_rial INTEGER DEFAULT 0, sso_unemployment_rial INTEGER DEFAULT 0,
    income_tax_rial INTEGER DEFAULT 0
  );
  CREATE TABLE payroll_payments (
    id INTEGER PRIMARY KEY, payroll_record_id INTEGER, amount_rial INTEGER, status TEXT
  );
  CREATE TABLE payroll_remittances (
    id INTEGER PRIMARY KEY, kind TEXT, amount_rial INTEGER, status TEXT
  );
  CREATE TABLE person_ledger (
    id INTEGER PRIMARY KEY, person_id INTEGER, ref_type TEXT, ref_id INTEGER,
    debit REAL DEFAULT 0, credit REAL DEFAULT 0, deleted_at INTEGER DEFAULT 0
  );
  CREATE TABLE persons (
    id INTEGER PRIMARY KEY, name TEXT, coa_code TEXT, party_id INTEGER
  );
  CREATE TABLE invoices (
    id INTEGER PRIMARY KEY, type TEXT, date TEXT, status TEXT, vat_amount REAL, vat_amount_rial INTEGER, deleted_at INTEGER DEFAULT 0
  );
  CREATE TABLE sales_returns (
    id INTEGER PRIMARY KEY, date TEXT, status TEXT, vat_amount REAL, vat_amount_rial INTEGER, deleted_at INTEGER DEFAULT 0
  );
  CREATE TABLE purchase_invoices (
    id INTEGER PRIMARY KEY, date TEXT, status TEXT, vat_amount REAL, vat_amount_rial INTEGER, deleted_at INTEGER DEFAULT 0
  );
  CREATE TABLE purchase_returns (
    id INTEGER PRIMARY KEY, date TEXT, status TEXT, vat_amount REAL, vat_amount_rial INTEGER, deleted_at INTEGER DEFAULT 0
  );
  CREATE TABLE production_orders (
    id INTEGER PRIMARY KEY, order_no TEXT, status TEXT
  );
  CREATE TABLE parties (
    id INTEGER PRIMARY KEY, name TEXT, coa_code TEXT, party_roles TEXT, party_type TEXT,
    legacy_table TEXT, legacy_id INTEGER
  );
  CREATE TABLE suppliers (
    id INTEGER PRIMARY KEY, party_id INTEGER, coa_code TEXT, name TEXT
  );
  CREATE TABLE customers (
    id INTEGER PRIMARY KEY, coa_code TEXT, name TEXT
  );
`);

function je(id, date, refType, refId) {
  db.prepare(`
    INSERT INTO journal_entries (id, entry_date, description, ref_type, ref_id, status)
    VALUES (?,?,?,?,?,'posted')
  `).run(id, date, '7b-test', refType || 'manual', refId || null);
}
function jl(entryId, code, debitRial, creditRial) {
  db.prepare(`
    INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial)
    VALUES (?,?,?,?,?,?,?)
  `).run(entryId, code, code, (debitRial || 0) / 10, (creditRial || 0) / 10, debitRial || 0, creditRial || 0);
}

// ── seed: cheques mismatch (sub 100_000 in-hand, GL empty → warn) ──
db.prepare(`
  INSERT INTO cheque_records (id, direction, amount, lifecycle_status, record_status)
  VALUES (1, 'in', 100000, 'registered', 'posted')
`).run();
db.prepare(`
  INSERT INTO cheque_records (id, direction, amount, lifecycle_status, record_status)
  VALUES (2, 'out', 50000, 'issued', 'posted')
`).run();
// GL only for issued payable 2109 (credit normal → debit-credit negative): credit 40_000 ≠ sub 50_000
je(1, '1405/01/10', 'cheque', 2);
jl(1, '2109', 0, 40000);
jl(1, '1101', 40000, 0);

// ── seed: payroll unpaid + GL gap ──
db.prepare(`INSERT INTO persons (id, name, coa_code) VALUES (1, 'کارگر تست', NULL)`).run();
db.prepare(`
  INSERT INTO payroll_records (
    id, person_id, period_label, date, status, net_pay_rial, settlement_mode,
    sso_employee_rial, sso_employer_base_rial, sso_unemployment_rial, income_tax_rial
  ) VALUES (1, 1, '1405/01', '1405/01/30', 'posted', 200000, 'labor', 10000, 20000, 3000, 5000)
`).run();
je(2, '1405/01/30', 'payroll', 1);
jl(2, '2104', 0, 150000); // unpaid expected 200k → warn
jl(2, '6101', 150000, 0);

// ── seed: VAT sales + matching-ish GL document flow ──
db.prepare(`
  INSERT INTO invoices (id, type, date, status, vat_amount_rial) VALUES (1, 'final', '1405/01/15', 'posted', 90000)
`).run();
db.prepare(`
  INSERT INTO purchase_invoices (id, date, status, vat_amount_rial) VALUES (1, '1405/01/20', 'posted', 30000)
`).run();
je(3, '1405/01/15', 'invoice', 1);
jl(3, '2103', 0, 90000);
jl(3, '1103', 90000, 0);
je(4, '1405/01/20', 'purchase', 1);
jl(4, '1108', 30000, 0);
jl(4, '2101', 0, 30000);

// ── seed: WIP GL balance with no open orders → warn (sub=0) ──
je(5, '1405/01/25', 'production', null);
jl(5, '1111', 75000, 0);
jl(5, '5101', 0, 75000);

const recon = require('../lib/subledger-recon');
const {
  checkCheques, checkPayroll, checkVat, checkWip, runRecon, failingCheckNames, CHECKS, ctxFor,
} = recon;

const ctx = ctxFor(db, {});

const cheques = checkCheques(ctx);
ok('cheques returns structured result', cheques && cheques.code === 'cheques' && Array.isArray(cheques.rows));
ok('cheques has total rows (in_hand/in_collection/issued)', cheques.rows.filter((r) => r.total).length >= 3, cheques.rows.map((r) => r.id).join(','));
ok('cheques status is warn or ok (not error)', ['ok', 'warn', 'rounding', 'info'].includes(cheques.status), cheques.status + ' ' + cheques.note);
ok('cheques in_hand sub = 100000', (() => {
  const r = cheques.rows.find((x) => x.id === 'in_hand');
  return r && Number(r.sub_rial) === 100000;
})(), JSON.stringify(cheques.rows.find((x) => x.id === 'in_hand')));

const payroll = checkPayroll(ctx);
ok('payroll returns structured result', payroll && payroll.code === 'payroll' && Array.isArray(payroll.rows));
ok('payroll has net_payable total row', !!payroll.rows.find((r) => r.id === 'net_payable' && r.total));
ok('payroll unpaid detail present', !!payroll.rows.find((r) => r.kind === 'unpaid_record'));
ok('payroll status not error', payroll.status !== 'error', payroll.note);

const vat = checkVat(ctx);
ok('vat returns structured result', vat && vat.code === 'vat' && Array.isArray(vat.rows));
ok('vat has vat_output + vat_input totals',
  !!vat.rows.find((r) => r.id === 'vat_output' && r.total)
  && !!vat.rows.find((r) => r.id === 'vat_input' && r.total));
ok('vat output sub = 90000', (() => {
  const r = vat.rows.find((x) => x.id === 'vat_output');
  return r && Number(r.sub_rial) === 90000;
})(), JSON.stringify(vat.rows.find((x) => x.id === 'vat_output')));
ok('vat status not error', vat.status !== 'error', vat.note);

const wip = checkWip(ctx);
ok('wip returns structured result', wip && wip.code === 'wip' && Array.isArray(wip.rows));
ok('wip total row present', !!wip.rows.find((r) => r.id === 'wip_total' && r.total));
ok('wip warns when GL has balance and no open residual', wip.status === 'warn', wip.status + ' diff=' + wip.diff_rial);

const run = runRecon(db, { checks: ['cheques', 'payroll', 'vat', 'wip'], persist: false });
ok('runRecon returns 4 checks', run.checks && run.checks.length === 4, run.checks && run.checks.length);
ok('runRecon summary has status buckets', run.summary && typeof run.summary.warn === 'number');
const failing = failingCheckNames(run);
ok('failingCheckNames is array', Array.isArray(failing));
ok('failingCheckNames includes WIP when warn', failing.some((n) => /WIP|در جریان/i.test(n)), failing.join(' | '));
ok('CHECKS registers 7B codes',
  CHECKS.some((c) => c[0] === 'cheques')
  && CHECKS.some((c) => c[0] === 'payroll')
  && CHECKS.some((c) => c[0] === 'vat')
  && CHECKS.some((c) => c[0] === 'wip'));

// ── E_NO_PAYABLE_LEAF (customer-books opening dest) ──
const { resolveOpeningDestAccount } = require('../lib/customer-books');
db.prepare(`
  INSERT INTO parties (id, name, party_roles, party_type, coa_code)
  VALUES (10, 'تأمین‌کننده بی‌برگ', '["supplier"]', 'supplier', NULL)
`).run();
let threwOpening = null;
try {
  resolveOpeningDestAccount(db, 10);
} catch (e) {
  threwOpening = e;
}
ok('resolveOpeningDestAccount throws E_NO_PAYABLE_LEAF',
  threwOpening && threwOpening.code === 'E_NO_PAYABLE_LEAF' && threwOpening.status === 422,
  threwOpening && (threwOpening.code || threwOpening.message));

// party with no roles and no supplier → also throw
db.prepare(`INSERT INTO parties (id, name, party_roles, party_type) VALUES (11, 'ناشناس', '[]', 'other')`).run();
let threwOpening2 = null;
try {
  resolveOpeningDestAccount(db, 11);
} catch (e) {
  threwOpening2 = e;
}
ok('opening dest throws when no supplier leaf',
  threwOpening2 && threwOpening2.code === 'E_NO_PAYABLE_LEAF',
  threwOpening2 && threwOpening2.message);

// ── E_NO_PAYABLE_LEAF (consignments payableAcct) ──
const { payableAcct } = require('../lib/consignments');
let threwPay = null;
try {
  payableAcct(db, { id: 99, name: 'امانی‌بی‌برگ', coa_code: null, party_id: null });
} catch (e) {
  threwPay = e;
}
ok('payableAcct throws E_NO_PAYABLE_LEAF (no party)',
  threwPay && threwPay.code === 'E_NO_PAYABLE_LEAF' && threwPay.status === 422,
  threwPay && (threwPay.code || threwPay.message));

db.prepare(`INSERT INTO parties (id, name, party_roles, party_type) VALUES (12, 'مشتری فقط', '["customer"]', 'customer')`).run();
let threwPay2 = null;
try {
  payableAcct(db, { id: 100, name: 'مشتری امانی', coa_code: null, party_id: 12 });
} catch (e) {
  threwPay2 = e;
}
ok('payableAcct throws for customer-only party (no silent misc)',
  threwPay2 && threwPay2.code === 'E_NO_PAYABLE_LEAF',
  threwPay2 && threwPay2.message);

// Source / wiring gates
const root = path.join(__dirname, '..');
const reconSrc = fs.readFileSync(path.join(root, 'lib/subledger-recon.js'), 'utf8');
const booksSrc = fs.readFileSync(path.join(root, 'lib/customer-books.js'), 'utf8');
const consSrc = fs.readFileSync(path.join(root, 'lib/consignments.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const pkg = fs.readFileSync(path.join(root, 'package.json'), 'utf8');

ok('CHECKS includes cheques/payroll/vat/wip',
  /\[\s*'cheques'/.test(reconSrc) && /'payroll'/.test(reconSrc) && /'vat'/.test(reconSrc) && /'wip'/.test(reconSrc));
ok('no silent coa_misc_persons in resolveOpeningDestAccount path',
  /E_NO_PAYABLE_LEAF/.test(booksSrc) && !/return misc/.test(booksSrc));
ok('consignments payableAcct uses E_NO_PAYABLE_LEAF', /E_NO_PAYABLE_LEAF/.test(consSrc));
ok('Help mentions 7B', /ممیزی ۷B|ممیزی 7B|تطبیق چک/.test(appSrc));
ok('SW at least 549', swAtLeast(swSrc, 549));
ok('package.json test:audit-7b', /"test:audit-7b"/.test(pkg));

try { db.close(); } catch (_) { /* ignore */ }
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch (_) { /* ignore */ } }

console.log(`\n── result: ${pass} pass / ${fail} fail ──\n`);
process.exit(fail ? 1 : 0);
