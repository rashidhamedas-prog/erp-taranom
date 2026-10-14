/**
 * v373 — Void/amend must not leave hollow «ابطال/اصلاح» rows on party books.
 * Operational statement shows only the final live document (ERPNext-style hide cancelled).
 * Run: node server/scripts/test-hollow-void-books-v373.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hollow-void-v373-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-hollow-void-v373-secret-32chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB, createLedgerEntry } = require('../db');
initDB();
const db = getDB();

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra != null ? extra : ''); }
}

const { allocTafsili } = require('../lib/coa-map');
const { hideVoidedBookRows } = require('../lib/customer-books');
const {
  retireCustomerLedgerByRef, purgeHollowPartyLedgerReversals,
} = require('../lib/party-ledger-retire');
const { reverseSettlementInTx } = require('../lib/void-settlement');

const code = allocTafsili(db, 'customer', 'مشتری تست سند پوچ');
const custId = db.prepare(`
  INSERT INTO customers (user_id, biz, phone, status, coa_code)
  VALUES (1, 'مشتری تست سند پوچ', '09120000000', 'active', ?)
`).run(code).lastInsertRowid;

// ── 1) Sales return live uses entry_type=sales_return (not reversal) ──
console.log('\n— 1 sales_return entry_type —');
const srSrc = fs.readFileSync(path.join(__dirname, '../lib/sales-return-doc.js'), 'utf8');
ok(/entry_type:\s*'sales_return'/.test(srSrc), 'post uses sales_return entry_type');
ok(!/entry_type:\s*'reversal',\s*\n\s*ref_type:\s*'sales_return_reversal'/.test(srSrc),
  'void no longer inserts sales_return_reversal ledger row');

// ── 2) Void settlement retires books (net 0, no reverse row) ──
console.log('\n— 2 settlement void retires —');
const sett = db.prepare(`
  INSERT INTO settlements (user_id, cust_id, amount, amount_rial, pay_type, date, status)
  VALUES (1, ?, 5000, 5000, 'cash', '1405/07/21', 'posted')
`).run(custId).lastInsertRowid;
createLedgerEntry(db, {
  customer_id: custId, date: '1405/07/21', entry_type: 'settlement',
  ref_type: 'settlement', ref_id: sett, description: 'تسویه تست',
  debit: 0, credit: 5000, user_id: 1,
});
const settRow = db.prepare('SELECT * FROM settlements WHERE id=?').get(sett);
db.transaction(() => reverseSettlementInTx(db, settRow, 1))();
const settLed = db.prepare(`
  SELECT COUNT(*) c FROM customer_ledger
  WHERE customer_id=? AND ref_type='settlement' AND ref_id=?
`).get(custId, sett);
ok(Number(settLed.c) === 0, 'settlement ledger retired (no hollow reverse)', settLed);
ok(db.prepare('SELECT status FROM settlements WHERE id=?').get(sett).status === 'reversed',
  'settlement marked reversed');

// ── 3) hideVoidedBookRows drops reversed sales_return + hollow reverse ──
console.log('\n— 3 hideVoidedBookRows —');
db.prepare(`
  INSERT INTO sales_returns (user_id, cust_id, date, note, rows, amount, status)
  VALUES (1, ?, '1405/07/21', '', '[]', 25400000, 'reversed')
`).run(custId);
const srId = db.prepare('SELECT last_insert_rowid() id').get().id;
createLedgerEntry(db, {
  customer_id: custId, date: '1405/07/21', entry_type: 'sales_return',
  ref_type: 'sales_return', ref_id: srId, description: `برگشت از فروش #${srId}`,
  debit: 0, credit: 25400000, user_id: 1,
});
createLedgerEntry(db, {
  customer_id: custId, date: '1405/07/21', entry_type: 'reversal',
  ref_type: 'sales_return_reversal', ref_id: srId, description: `ابطال برگشت از فروش #${srId}`,
  debit: 25400000, credit: 0, user_id: 1,
});
const liveSr = db.prepare(`
  INSERT INTO sales_returns (user_id, cust_id, date, note, rows, amount, status)
  VALUES (1, ?, '1405/07/21', '', '[]', 25400000, 'posted')
`).run(custId).lastInsertRowid;
createLedgerEntry(db, {
  customer_id: custId, date: '1405/07/21', entry_type: 'sales_return',
  ref_type: 'sales_return', ref_id: liveSr, description: `برگشت از فروش #${liveSr}`,
  debit: 0, credit: 25400000, user_id: 1,
});
const raw = db.prepare('SELECT * FROM customer_ledger WHERE customer_id=?').all(custId);
const hidden = hideVoidedBookRows(db, raw);
const voidedVisible = hidden.filter((e) => Number(e.ref_id) === srId);
const liveVisible = hidden.filter((e) => Number(e.ref_id) === liveSr && e.ref_type === 'sales_return');
ok(voidedVisible.length === 0, 'reversed sales_return pair hidden', voidedVisible.length);
ok(liveVisible.length === 1, 'live sales_return still visible', liveVisible.length);

// ── 4) purgeHollowPartyLedgerReversals cleans DB ──
console.log('\n— 4 purge hollow —');
db.prepare("DELETE FROM settings WHERE key='purge_hollow_party_ledger_v373'").run();
const purged = purgeHollowPartyLedgerReversals(db);
ok(purged.customerDeleted >= 2, 'purge deletes voided return rows', purged);
const after = db.prepare(`
  SELECT COUNT(*) c FROM customer_ledger
  WHERE customer_id=? AND ref_id=? AND ref_type IN ('sales_return','sales_return_reversal')
`).get(custId, srId);
ok(Number(after.c) === 0, 'voided return rows gone from DB', after);

// ── 5) retire helper ──
console.log('\n— 5 retire helper —');
createLedgerEntry(db, {
  customer_id: custId, date: '1405/07/21', entry_type: 'settlement',
  ref_type: 'pos_receipt', ref_id: 99, description: 'کارتخوان',
  debit: 0, credit: 100, user_id: 1,
});
const n = retireCustomerLedgerByRef(db, { refTypes: ['pos_receipt'], refId: 99, customerId: custId });
ok(n === 1, 'retireCustomerLedgerByRef deletes one', n);

// ── 6) labels / SW ──
console.log('\n— 6 labels / version —');
const acc = fs.readFileSync(path.join(__dirname, '../routes/accounting.js'), 'utf8');
ok(acc.includes("sales_return: 'برگشت از فروش'"), 'ENTRY_LABEL sales_return');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
ok(/erp-taranom-v373/.test(sw), 'SW v373');

try { closeDB(); } catch (_) {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
