/**
 * Historical AR on receivable CONTROL must move to the customer leaf tafsili
 * so books_mismatch clears — without books_align plugs and without rewriting
 * customer_ledger. Reproduces صدوقی-style late tafsili + invoice on 1103.
 * Run: node server/scripts/test-ar-control-reclass-v243.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-reclass-v243-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-ar-reclass-v243-secret-at-least-32b';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra != null ? extra : ''); }
}

const {
  ensureCustomerBooksRepaired,
  reclassifyControlArToCustomerLeaf,
  repairLedgerOpeningsToGl,
} = require('../lib/customer-books');
const { postToLedger } = require('../lib/ledger');
const { rialToLedger, SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');
const { buildStatement } = require('../routes/accounting');
const { acct } = require('../lib/coa-map');

ensureCustomerBooksRepaired(db);

const TAF = '110301000243';
const receivable = acct(db, 'coa_receivable');
const cash = acct(db, 'coa_cash_default');
const sales = acct(db, 'coa_sales');
db.prepare(`
  INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
  VALUES (?,?, 'asset', ?, 4, 1)
`).run(TAF, 'تفصیلی تست انتقال', receivable.code);

const INVOICE = 152_380_000;
const SETTLED = 152_000_000;
const POS = 380_000;
const EXPECT = INVOICE - SETTLED - POS; // 0

const partyId = db.prepare(`
  INSERT INTO parties (person_code, party_type, full_name, phone, coa_code, opening_balance)
  VALUES ('P-V243','customer','خانم صدوقی تست','09120002430', ?, 0)
`).run(TAF).lastInsertRowid;

const custId = db.prepare(`
  INSERT INTO customers (user_id, biz, owner, phone, status, coa_code, party_id)
  VALUES (1, 'صدوقی تست', 'خانم صدوقی', '09120002430', 'active', ?, ?)
`).run(TAF, partyId).lastInsertRowid;

const invId = db.prepare(`
  INSERT INTO invoices (user_id, cust_id, type, date, num, final, approved, deleted_at)
  VALUES (1, ?, 'final', '1405/07/02', 'T-V243', ?, 1, 0)
`).run(custId, INVOICE).lastInsertRowid;

db.prepare(`
  INSERT INTO customer_ledger (customer_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id)
  VALUES (?, '1405/07/02', 'invoice', 'invoice', ?, 'فاکتور', ?, 0, 1)
`).run(custId, invId, INVOICE);

// Historical invoice JE still on CONTROL (pre-tafsili allocation)
postToLedger(db, {
  sourceType: 'invoice',
  sourceId: invId,
  date: '1405/07/02',
  description: 'فاکتور تاریخی روی کنترل',
  createdBy: 1,
  lines: [
    { code: receivable.code, name: receivable.name, debit: rialToLedger(INVOICE), credit: 0 },
    { code: sales.code, name: sales.name, debit: 0, credit: rialToLedger(INVOICE) },
  ],
});

const settId = db.prepare(`
  INSERT INTO settlements (user_id, cust_id, invoice_id, amount, amount_rial, pay_type, date, status)
  VALUES (1, ?, ?, ?, ?, 'cash', '1405/07/03', 'posted')
`).run(custId, invId, SETTLED, SETTLED).lastInsertRowid;

db.prepare(`
  INSERT INTO customer_ledger (customer_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id)
  VALUES (?, '1405/07/03', 'settlement', 'settlement', ?, 'تسویه', 0, ?, 1)
`).run(custId, settId, SETTLED);

postToLedger(db, {
  sourceType: 'settlement',
  sourceId: settId,
  date: '1405/07/03',
  description: 'تسویه تاریخی روی کنترل',
  createdBy: 1,
  lines: [
    { code: cash.code, name: cash.name, debit: rialToLedger(SETTLED), credit: 0 },
    { code: receivable.code, name: receivable.name, debit: 0, credit: rialToLedger(SETTLED) },
  ],
});

db.prepare(`
  INSERT INTO customer_ledger (customer_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id)
  VALUES (?, '1405/07/04', 'settlement', 'pos_receipt', 243, 'POS', 0, ?, 1)
`).run(custId, POS);

postToLedger(db, {
  sourceType: 'pos_receipt',
  sourceId: 243,
  date: '1405/07/04',
  description: 'دریافت کارتخوان روی تفصیلی',
  createdBy: 1,
  lines: [
    { code: cash.code, name: cash.name, debit: rialToLedger(POS), credit: 0 },
    { code: TAF, name: 'تفصیلی تست انتقال', debit: 0, credit: rialToLedger(POS) },
  ],
});

const ledSigned = db.prepare(`
  SELECT COALESCE(SUM(debit)-SUM(credit),0) AS n FROM customer_ledger WHERE customer_id=?
`).get(custId).n;
const leafBefore = db.prepare(`
  SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL})-SUM(${SQL_JL_CREDIT_RIAL}),0) AS n
  FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
  WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0
`).get(TAF).n;
ok(Math.abs(Number(ledSigned) - Number(leafBefore)) > 1,
  'before repair: leaf GL ≠ customer ledger',
  { led: ledSigned, leaf: leafBefore });

const first = reclassifyControlArToCustomerLeaf(db);
ok(first.moved >= 2, 'reclass moves invoice+settlement control lines', first);
const second = reclassifyControlArToCustomerLeaf(db);
ok(second.moved === 0, 'reclass is idempotent', second);

const ledCountBefore = db.prepare(
  'SELECT COUNT(*) AS c FROM customer_ledger WHERE customer_id=?'
).get(custId).c;
ensureCustomerBooksRepaired(db);
const ledCountAfter = db.prepare(
  'SELECT COUNT(*) AS c FROM customer_ledger WHERE customer_id=?'
).get(custId).c;
ok(ledCountAfter === ledCountBefore, 'reclass does not insert customer_ledger rows', {
  before: ledCountBefore, after: ledCountAfter,
});

const ourCtrl = db.prepare(`
  SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL})-SUM(${SQL_JL_CREDIT_RIAL}),0) AS n
  FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
  WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0
    AND (
      (je.ref_type='invoice' AND je.ref_id=?)
      OR (je.ref_type='settlement' AND je.ref_id=?)
      OR (je.ref_type='ar_control_reclass' AND je.ref_id IN (
        SELECT jl2.id FROM journal_lines jl2
        JOIN journal_entries je2 ON je2.id=jl2.entry_id
        WHERE jl2.account_code=? AND je2.ref_type IN ('invoice','settlement')
          AND je2.ref_id IN (?,?)
      ))
    )
`).get(receivable.code, invId, settId, receivable.code, invId, settId);
ok(Math.abs(Number(ourCtrl.n) || 0) < 1, 'our invoice/settlement net zero on control after reclass', ourCtrl.n);

const leafNet = db.prepare(`
  SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL})-SUM(${SQL_JL_CREDIT_RIAL}),0) AS n
  FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
  WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0
`).get(TAF);
ok(Math.abs(Number(leafNet.n) - EXPECT) < 1, 'leaf GL matches economic remainder', leafNet.n);

const stmt = buildStatement(db, custId);
ok(stmt.books_mismatch !== true, 'statement books_mismatch cleared', stmt.books_mismatch);
ok(Math.abs(Number(stmt.gl_closing_rial) - Number(stmt.ledger_closing)) <= 1,
  'gl_closing === ledger_closing',
  { gl: stmt.gl_closing_rial, led: stmt.ledger_closing });
ok(stmt.source === 'aligned', 'statement source=aligned', stmt.source);

const openOnly = 777_000;
const c2 = db.prepare(`
  INSERT INTO customers (user_id, biz, phone, status, coa_code)
  VALUES (1, 'فقط افتتاحیه', '09120002431', 'active', ?)
`).run(TAF + '1').lastInsertRowid;
db.prepare(`
  INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
  VALUES (?, 'تفصیلی افتتاحیه', 'asset', ?, 4, 1)
`).run(TAF + '1', receivable.code);
db.prepare(`
  INSERT INTO customer_ledger (customer_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id)
  VALUES (?, '1405/01/01', 'opening', 'opening', ?, 'مانده', ?, 0, 1)
`).run(c2, c2, openOnly);
ok(repairLedgerOpeningsToGl(db) >= 1, 'opening-only ledger gets opening_ledger JE');
const stmt2 = buildStatement(db, c2);
ok(stmt2.books_mismatch !== true, 'opening-only mismatch cleared', stmt2.books_mismatch);
ok(Number(stmt2.gl_closing_rial) === openOnly, 'opening JE lands on leaf', stmt2.gl_closing_rial);

try { closeDB(); } catch (_) {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
console.log('\n' + (fail ? `FAILED ${fail}` : 'ALL CHECKS PASSED') + ` (${pass} pass, ${fail} fail)`);
process.exit(fail ? 1 : 0);
