/**
 * Reversed settlements must reverse customer_ledger (R13) even without live JE.
 * Run: node server/scripts/test-reversed-settlement-books-v297.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sett-rev-v297-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-reversed-settlement-v297-secret-32ch';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB, createLedgerEntry } = require('../db');
initDB();
const db = getDB();

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra != null ? extra : ''); }
}

const { allocTafsili } = require('../lib/coa-map');
const { repairReversedSettlementBooks, canonicalCustomerFold, glCustomersTafsiliBalance } = require('../lib/customer-books');
const { reverseSettlementInTx } = require('../lib/void-settlement');

const code = allocTafsili(db, 'customer', 'گل نرگس تست');
const custId = db.prepare(`
  INSERT INTO customers (user_id, biz, phone, status, coa_code)
  VALUES (1, 'گل نرگس تست', '09152149435', 'active', ?)
`).run(code).lastInsertRowid;

db.prepare(`
  INSERT INTO customer_ledger (customer_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id)
  VALUES (?, '1405/07/02', 'invoice', 'invoice', 1, 'فاکتور', 76800000, 0, 1)
`).run(custId);

const sett1 = db.prepare(`
  INSERT INTO settlements (user_id, cust_id, invoice_id, amount, amount_rial, pay_type, date, note, status)
  VALUES (1, ?, 1, 76800000, 76800000, 'bank_transfer', '1405/07/02', 'ابطال‌شده', 'reversed')
`).run(custId).lastInsertRowid;
createLedgerEntry(db, {
  customer_id: custId, date: '1405/07/02', entry_type: 'settlement',
  ref_type: 'settlement', ref_id: sett1, description: 'تسویه ابطال‌شده بدون reverse دفتر',
  debit: 0, credit: 76800000, user_id: 1,
});

const sett3 = db.prepare(`
  INSERT INTO settlements (user_id, cust_id, invoice_id, amount, amount_rial, pay_type, date, note, status)
  VALUES (1, ?, 1, 76800000, 76800000, 'bank_transfer', '1405/07/02', 'ثبت مجدد', 'posted')
`).run(custId).lastInsertRowid;
createLedgerEntry(db, {
  customer_id: custId, date: '1405/07/02', entry_type: 'settlement',
  ref_type: 'settlement', ref_id: sett3, description: 'تسویه زنده',
  debit: 0, credit: 76800000, user_id: 1,
});

const before = db.prepare(
  'SELECT COALESCE(SUM(debit),0)-COALESCE(SUM(credit),0) b FROM customer_ledger WHERE customer_id=?'
).get(custId);
ok(Number(before.b) === -76800000, 'phantom creditor before repair', before);

const repaired = repairReversedSettlementBooks(db);
ok(repaired.reversed >= 1, 'repair reverses leftover reversed settlement', repaired);

const after = db.prepare(
  'SELECT COALESCE(SUM(debit),0)-COALESCE(SUM(credit),0) b FROM customer_ledger WHERE customer_id=?'
).get(custId);
ok(Number(after.b) === 0, 'books net to paid invoice after repair', after);

const fold = canonicalCustomerFold(db);
const gl = glCustomersTafsiliBalance(db);
ok(Math.abs(Number(fold.display) - Number(gl.display)) <= 1 || gl.display === 0,
  'no AR-only false mismatch after repair', { fold, gl });
ok(Number(fold.creditor) === 0, 'creditor fold cleared', fold);

// skipJournal-style void: posted settlement, no live JE
const settShadow = db.prepare(`
  INSERT INTO settlements (user_id, cust_id, amount, amount_rial, pay_type, date, status)
  VALUES (1, ?, 1000, 1000, 'cash', '1405/07/11', 'posted')
`).run(custId).lastInsertRowid;
createLedgerEntry(db, {
  customer_id: custId, date: '1405/07/11', entry_type: 'settlement',
  ref_type: 'settlement', ref_id: settShadow, description: 'سایه',
  debit: 0, credit: 1000, user_id: 1,
});
const row = db.prepare('SELECT * FROM settlements WHERE id=?').get(settShadow);
db.transaction(() => reverseSettlementInTx(db, row, 1))();
const st = db.prepare('SELECT status FROM settlements WHERE id=?').get(settShadow);
ok(st.status === 'reversed', 'shadow settlement marked reversed');
const netShadow = db.prepare(`
  SELECT COALESCE(SUM(debit),0)-COALESCE(SUM(credit),0) b FROM customer_ledger
  WHERE customer_id=? AND ref_type='settlement' AND ref_id=?
`).get(custId, settShadow);
ok(Number(netShadow.b) === 0, 'shadow void reverses books', netShadow);

const acc = fs.readFileSync(path.join(__dirname, '../routes/accounting.js'), 'utf8');
ok(acc.includes('books_mismatch_detail'), 'overview exposes mismatch detail');
ok(acc.includes('mismatchCr'), 'creditor compared separately');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(app.includes('بستانکار دفتر مشتری'), 'banner names creditor side');

const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
ok(/erp-taranom-v(297|2[9-9]\d|[3-9]\d{2,})/.test(sw) || /erp-taranom-v3\d+/.test(sw), 'SW v297+');

try { closeDB(); } catch (_) {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
