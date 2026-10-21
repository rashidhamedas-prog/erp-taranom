/**
 * v519 — field-rep payment approval must post the settlement JE on the customer's own
 * tafsili leaf (the same account the customer book is kept against), never on the 1103
 * control account. Posting to control while crediting the customer book left
 * «دفتر مشتری ≠ تفصیلی» until the ar_control_reclass heal ran.
 * Run: node server/scripts/test-rep-payment-leaf-v519.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-pay-leaf-v519-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-rep-payment-leaf-v519-secret-32chars';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra != null ? JSON.stringify(extra) : ''); }
}

const { allocTafsili, acct } = require('../lib/coa-map');
const {
  customerBooksMismatchList, canonicalCustomerFold, glCustomersTafsiliBalance, sqlCustomerLedgerLive,
} = require('../lib/customer-books');
const { applyRepPaymentAsSettlement } = require('../routes/rep-management');

ok(typeof applyRepPaymentAsSettlement === 'function', 'approval helper exposed for tests');

const control = acct(db, 'coa_receivable');
const leaf = allocTafsili(db, 'customer', 'بوتیک آفاق تست');
ok(leaf && leaf !== control.code, 'customer gets a tafsili leaf distinct from control', { leaf, control: control.code });

const custId = db.prepare(`
  INSERT INTO customers (user_id, biz, phone, status, coa_code)
  VALUES (1, 'بوتیک آفاق تست', '09150000001', 'active', ?)
`).run(leaf).lastInsertRowid;

// An open invoice so the receipt has something to settle against (books + GL both on the leaf).
db.prepare(`
  INSERT INTO customer_ledger (customer_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id)
  VALUES (?, '1405/07/20', 'invoice', 'invoice', 9001, 'فاکتور', 50000000, 0, 1)
`).run(custId);
const { postToLedger } = require('../lib/ledger');
const { rialToLedger } = require('../lib/money');
const sales = acct(db, 'coa_sales');
postToLedger(db, {
  sourceType: 'invoice', sourceId: 9001, date: '1405/07/20', description: 'فاکتور تست', createdBy: 1,
  lines: [
    { code: leaf, name: 'بوتیک آفاق تست', debit: rialToLedger(50000000), credit: 0 },
    { code: sales.code, name: sales.name, debit: 0, credit: rialToLedger(50000000) },
  ],
});

const subId = db.prepare(`
  INSERT INTO rep_payment_submissions (rep_id, cust_id, pay_type, amount, date, note, status)
  VALUES (1, ?, 'bank_transfer', 20000000, '1405/07/25', 'واریز میدانی', 'pending')
`).run(custId).lastInsertRowid;
const sub = db.prepare('SELECT * FROM rep_payment_submissions WHERE id=?').get(subId);
sub.bank_ref = 'TRX-1';

const sid = db.transaction(() => applyRepPaymentAsSettlement(db, sub, 1))();
ok(Number.isInteger(Number(sid)) && Number(sid) > 0, 'approval creates a settlement', sid);

const je = db.prepare(`
  SELECT id FROM journal_entries WHERE ref_type='settlement' AND ref_id=? AND deleted_at IS NULL
`).get(sid);
ok(!!je, 'approval posts a settlement journal entry', { sid });
const lines = je ? db.prepare('SELECT account_code, debit, credit FROM journal_lines WHERE entry_id=?').all(je.id) : [];
const leafCredit = lines.find(l => l.account_code === leaf && Number(l.credit) > 0);
const controlLine = lines.find(l => l.account_code === control.code);
ok(!!leafCredit, 'JE credits the customer tafsili leaf', lines);
ok(!controlLine, 'JE does not touch the 1103 control account', lines);
ok(lines.length === 2 && Math.round(lines.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0)) === 0,
  'JE is a balanced two-line document', lines);

const book = db.prepare(`
  SELECT debit, credit FROM customer_ledger WHERE customer_id=? AND ref_type='settlement' AND ref_id=?
`).get(custId, sid);
ok(book && Number(book.credit) === 20000000 && Number(book.debit) === 0, 'customer book credited once', book);

// Book == leaf, with no heal pass in between.
const bookBal = db.prepare(`
  SELECT COALESCE(SUM(cl.debit),0)-COALESCE(SUM(cl.credit),0) b
  FROM customer_ledger cl WHERE cl.customer_id=? AND ${sqlCustomerLedgerLive('cl')}
`).get(custId);
const glBal = db.prepare(`
  SELECT COALESCE(SUM(COALESCE(NULLIF(jl.debit_rial,0), ROUND(jl.debit), 0)),0)
       - COALESCE(SUM(COALESCE(NULLIF(jl.credit_rial,0), ROUND(jl.credit), 0)),0) b
  FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
  WHERE jl.account_code=? AND je.deleted_at IS NULL
`).get(leaf);
ok(Number(bookBal.b) === 30000000 && Number(glBal.b) === 30000000, 'customer book equals leaf immediately', { bookBal, glBal });

const mm = customerBooksMismatchList(db, {});
ok(mm.count === 0, 'dashboard integrity list is empty', mm);
const fold = canonicalCustomerFold(db);
const gl = glCustomersTafsiliBalance(db);
ok(Number(fold.display) === Number(gl.display) && Number(fold.creditor) === Number(gl.creditor),
  'fold equals GL tafsili totals', { fold, gl });

// Customer without a leaf still falls back to the mapped control (legacy behaviour, never a mismatch
// because such a customer has no leaf to compare against).
const bareId = db.prepare(`
  INSERT INTO customers (user_id, biz, phone, status) VALUES (1, 'مشتری بدون برگ', '09150000002', 'active')
`).run().lastInsertRowid;
const bareSubId = db.prepare(`
  INSERT INTO rep_payment_submissions (rep_id, cust_id, pay_type, amount, date, note, status)
  VALUES (1, ?, 'cash', 1000000, '1405/07/25', '', 'pending')
`).run(bareId).lastInsertRowid;
const bareSub = db.prepare('SELECT * FROM rep_payment_submissions WHERE id=?').get(bareSubId);
const bareSid = db.transaction(() => applyRepPaymentAsSettlement(db, bareSub, 1))();
const bareJe = db.prepare(`SELECT id FROM journal_entries WHERE ref_type='settlement' AND ref_id=? AND deleted_at IS NULL`).get(bareSid);
const bareLines = bareJe ? db.prepare('SELECT account_code, credit FROM journal_lines WHERE entry_id=?').all(bareJe.id) : [];
const bareCust = db.prepare('SELECT coa_code FROM customers WHERE id=?').get(bareId);
const expectedCode = bareCust && bareCust.coa_code ? bareCust.coa_code : control.code;
ok(bareLines.some(l => l.account_code === expectedCode && Number(l.credit) > 0),
  'customer without a leaf is credited on its resolved receivable account', { bareLines, expectedCode });

closeDB();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

console.log(`\nv519 rep-payment leaf: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
