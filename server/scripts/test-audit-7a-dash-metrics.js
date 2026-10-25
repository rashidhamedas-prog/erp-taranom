'use strict';
/**
 * Audit 7A — dashboard gross AP/AR per leaf, trial balance liveness, net sales.
 *
 * Run:
 *   $env:DB_PATH="server/.tmp-test-artifacts/wave-test-7a.db"
 *   npm --prefix server run test:audit-7a
 *
 * Uses a throw-away DB at DB_PATH (deleted + recreated). Refuses crm*.db.
 */
const path = require('path');
const fs = require('fs');
const { swAtLeast } = require('./lib/sw-at-least');

(function guardDbPath() {
  const raw = process.env.DB_PATH || '';
  if (!raw) {
    console.error('FATAL: DB_PATH is required under server/.tmp-test-artifacts, e.g.');
    console.error('  $env:DB_PATH="server/.tmp-test-artifacts/wave-test-7a.db"');
    process.exit(1);
  }
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

console.log('\n══ Audit 7A — dashboard metrics ══\n');

// better-sqlite3 needs a compiled binding for the running Node; fall back to node:sqlite
// (same prepare/get/all/run surface used by lib/gl-metrics) when it is missing.
let Database;
try {
  const Better = require('better-sqlite3');
  new Better(':memory:').close();
  Database = Better;
} catch (_) {
  Database = require('node:sqlite').DatabaseSync;
  console.log('  ℹ️  better-sqlite3 binding missing — using node:sqlite fallback');
}
const { glControlGrossByLeaf, unbalancedEntryCount, JE_ALIVE, JE_APPROVED } = require('../lib/gl-metrics');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');

const dbPath = path.resolve(process.env.DB_PATH);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch (_) { /* none */ } }
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE journal_entries (
    id INTEGER PRIMARY KEY, entry_date TEXT, description TEXT, ref_type TEXT, ref_id INTEGER,
    deleted_at INTEGER, status TEXT
  );
  CREATE TABLE journal_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id INTEGER, account_code TEXT,
    debit REAL, credit REAL, debit_rial INTEGER, credit_rial INTEGER
  );
`);
function je(id, date, status, desc) {
  db.prepare('INSERT INTO journal_entries (id, entry_date, description, ref_type, status) VALUES (?,?,?,?,?)')
    .run(id, date, desc || 'test', 'manual', status);
}
function jl(id, code, d, c) {
  db.prepare('INSERT INTO journal_lines (entry_id, account_code, debit, credit, debit_rial, credit_rial) VALUES (?,?,?,?,?,?)')
    .run(id, code, d, c, d, c);
}

// ── AP: supplier A owes 1000, supplier B has advance 300 (debit leaf) ──
je(1, '1405/01/10', 'approved');
jl(1, '2101-001', 0, 1000); jl(1, '1104', 1000, 0);
je(2, '1405/01/11', 'approved');
jl(2, '2101-002', 300, 0); jl(2, '1101', 0, 300);
// supplier C 500 payable, entered later
je(3, '1405/03/01', 'approved');
jl(3, '2101-003', 0, 500); jl(3, '1104', 500, 0);

const ap = glControlGrossByLeaf(db, '2101', { debitNormal: false });
ok('AP gross = 1500 (A+C, B advance not netted)', ap.gross === 1500, JSON.stringify(ap));
ok('AP contra = 300 (supplier advance)', ap.contra === 300, JSON.stringify(ap));
ok('AP net = 1200 signed (not clamped)', ap.net === 1200, JSON.stringify(ap));

const apAsOf = glControlGrossByLeaf(db, '2101', { asOf: '1405/02/01', debitNormal: false });
ok('AP asOf excludes later supplier C', apAsOf.gross === 1000 && apAsOf.contra === 300, JSON.stringify(apAsOf));

// Net negative must stay negative (never Math.max(0))
je(4, '1405/01/12', 'approved');
jl(4, '2105-001', 800, 0); jl(4, '1101', 0, 800);
const neg = glControlGrossByLeaf(db, '2105', { debitNormal: false });
ok('net may be negative (no clamp)', neg.gross === 0 && neg.contra === 800 && neg.net === -800, JSON.stringify(neg));

// ── AR: customer X debtor 700, customer Y advance (credit) 200 ──
je(5, '1405/01/13', 'approved');
jl(5, '1103-001', 700, 0); jl(5, '4101', 0, 700);
je(6, '1405/01/14', 'approved');
jl(6, '1103-002', 0, 200); jl(6, '1101', 200, 0);
const ar = glControlGrossByLeaf(db, '1103', { debitNormal: true });
ok('AR gross = 700', ar.gross === 700, JSON.stringify(ar));
ok('AR contra (customer advances) = 200', ar.contra === 200, JSON.stringify(ar));

// Reversed / void entries must be ignored
je(7, '1405/01/15', 'reversed');
jl(7, '2101-004', 0, 9999); jl(7, '1104', 9999, 0);
const ap2 = glControlGrossByLeaf(db, '2101', { debitNormal: false });
ok('reversed entry ignored', ap2.gross === 1500, JSON.stringify(ap2));

// ── Trial balance liveness + unbalanced_count ──
const tbRows = db.prepare(`
  SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) d, COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) c
  FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id
  WHERE ${JE_ALIVE} AND ${JE_APPROVED}
`).get();
ok('TB excludes reversed entry (balanced)', tbRows.d === tbRows.c, JSON.stringify(tbRows));
ok('unbalanced_count = 0 on clean books', unbalancedEntryCount(db) === 0);

je(8, '1405/02/01', 'draft');
jl(8, '1101', 50, 0);
ok('draft entry excluded from TB / unbalanced_count', unbalancedEntryCount(db) === 0);

je(9, '1405/02/02', 'approved');
jl(9, '1101', 100, 0); jl(9, '4101', 0, 40);
ok('one-sided approved entry counted (HAVING ABS>=1)', unbalancedEntryCount(db) === 1);
ok('range filter on unbalanced_count', unbalancedEntryCount(db, { to: '1405/01/31' }) === 0
  && unbalancedEntryCount(db, { from: '1405/02/01' }) === 1);

je(10, '1405/02/03', 'approved');
jl(10, '1101', 100.4, 0); jl(10, '4101', 0, 100);
// debit_rial=100.4 stored in INTEGER column coerces → sub-rial drift must not count
ok('sub-rial rounding not flagged', unbalancedEntryCount(db) === 1);

db.close();
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch (_) { /* ignore */ } }

// ── Source / wiring gates ──
const root = path.join(__dirname, '..');
const accSrc = fs.readFileSync(path.join(root, 'routes/accounting.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const pkg = fs.readFileSync(path.join(root, 'package.json'), 'utf8');

ok('overview uses glControlGrossByLeaf', /glControlGrossByLeaf\(db, payableCode/.test(accSrc));
ok('glPrefixBalanceRial removed', !/glPrefixBalanceRial/.test(accSrc));
ok('overview returns supplierAdvances/customerAdvances/books_mismatch_ap',
  /supplierAdvances,/.test(accSrc) && /customerAdvances,/.test(accSrc) && /books_mismatch_ap:/.test(accSrc));
ok('overview returns unbalanced_count', /unbalanced_count,/.test(accSrc));
ok('trial-balance route uses JE_ALIVE + JE_APPROVED',
  /const tbWhere = \[JE_ALIVE, JE_APPROVED\]/.test(accSrc));
ok('trial-balance no string-interpolated dates', !/entry_date >= '\$\{sf/.test(accSrc));
ok('salesNetTotals honors asOf + sales_returns', /function salesNetTotals/.test(accSrc) && /FROM sales_returns r/.test(accSrc));
ok('no Math.max(0) in gl-metrics', !/Math\.max\(0/.test(fs.readFileSync(path.join(root, 'lib/gl-metrics.js'), 'utf8')));
ok('dash label «فروش خالص»', /فروش خالص/.test(appSrc));
ok('dash prepaid card', /پیش‌پرداخت به تأمین‌کنندگان/.test(appSrc));
ok('dash AP mismatch banner', /booksMismatchAp\?/.test(appSrc));
ok('Help mentions 7A', /ممیزی ۷A/.test(appSrc));
ok('SW at least 548', swAtLeast(swSrc, 548));
ok('package.json test:audit-7a', /"test:audit-7a"/.test(pkg));

console.log(`\n── result: ${pass} pass / ${fail} fail ──\n`);
process.exit(fail ? 1 : 0);
