'use strict';
/**
 * v536 — dual-role person payment must not inflate customer AR books.
 *
 * Production shape (معین مهدیزاده حکاک / party 128):
 *   person leaf 110601000123 ← پرداخت به شخص (manual_voucher)
 *   customer leaf 110301000017 ← فاکتور فروش
 * Wrong: customer_ledger carries the person vouchers → books_mismatch +85M.
 *
 * Run: node server/scripts/test-books-cross-leaf-v536.js
 */
const Database = require('better-sqlite3');
const {
  afterPartyBookInsert, reconcileAllPartyLeafBooks, reconcileLeaf,
  sharedLeafCodes, roleBookLeafCodes, journalEntryAliveOnLeaf,
} = require('../lib/party-leaf-sync');
const {
  hideVoidedBookRows, sqlCustomerLedgerLive, customerBooksMismatchList,
} = require('../lib/customer-books');

let failed = 0;
let passes = 0;
function eq(name, got, exp) {
  if (got !== exp) {
    failed += 1;
    console.error('FAIL', name, 'got', JSON.stringify(got), 'expected', JSON.stringify(exp));
  } else {
    passes += 1;
  }
}

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE parties (id INTEGER PRIMARY KEY, opening_balance INTEGER, coa_code TEXT, full_name TEXT);
  CREATE TABLE persons (id INTEGER PRIMARY KEY, party_id INTEGER, coa_code TEXT, name TEXT);
  CREATE TABLE suppliers (id INTEGER PRIMARY KEY, party_id INTEGER, coa_code TEXT, name TEXT, balance INTEGER);
  CREATE TABLE customers (id INTEGER PRIMARY KEY, party_id INTEGER, coa_code TEXT, biz TEXT, user_id INTEGER, assigned_to INTEGER);
  CREATE TABLE person_ledger (
    id INTEGER PRIMARY KEY, person_id INTEGER, date TEXT, entry_type TEXT, ref_type TEXT, ref_id INTEGER,
    description TEXT, debit INTEGER, credit INTEGER, user_id INTEGER, created_at INTEGER
  );
  CREATE TABLE supplier_ledger (
    id INTEGER PRIMARY KEY, supplier_id INTEGER, date TEXT, entry_type TEXT, ref_type TEXT, ref_id INTEGER,
    description TEXT, debit INTEGER, credit INTEGER, user_id INTEGER, created_at INTEGER
  );
  CREATE TABLE customer_ledger (
    id INTEGER PRIMARY KEY, customer_id INTEGER, date TEXT, entry_type TEXT, ref_type TEXT, ref_id INTEGER,
    description TEXT, debit INTEGER, credit INTEGER, user_id INTEGER, created_at INTEGER
  );
  CREATE TABLE journal_entries (
    id INTEGER PRIMARY KEY, entry_date TEXT, description TEXT, ref_type TEXT, ref_id INTEGER,
    deleted_at INTEGER, status TEXT, created_by INTEGER
  );
  CREATE TABLE journal_lines (
    id INTEGER PRIMARY KEY, entry_id INTEGER, account_code TEXT,
    debit INTEGER, credit INTEGER, debit_rial INTEGER, credit_rial INTEGER, description TEXT
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT, entity TEXT, entity_id INTEGER,
    detail TEXT, ip_address TEXT, user_agent TEXT, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE invoices (id INTEGER PRIMARY KEY, cust_id INTEGER, num TEXT, type TEXT, final INTEGER, status TEXT, deleted_at INTEGER, date TEXT);
  CREATE TABLE settlements (id INTEGER PRIMARY KEY, invoice_id INTEGER, amount INTEGER, status TEXT);
  CREATE TABLE sales_returns (id INTEGER PRIMARY KEY, status TEXT);
  CREATE TABLE pos_receipts (id INTEGER PRIMARY KEY, status TEXT);
  CREATE TABLE cheque_records (id INTEGER PRIMARY KEY, note TEXT, status TEXT, record_status TEXT);
`);

const LEAF_AR = '110301000017';
const LEAF_P = '110601000123';
db.prepare('INSERT INTO parties (id, opening_balance, coa_code, full_name) VALUES (128, 0, ?, ?)').run(LEAF_AR, 'معین مهدیزاده حکاک');
db.prepare('INSERT INTO persons (id, party_id, coa_code, name) VALUES (51, 128, ?, ?)').run(LEAF_P, 'معین مهدیزاده حکاک');
db.prepare('INSERT INTO customers (id, party_id, coa_code, biz) VALUES (89, 128, ?, ?)').run(LEAF_AR, 'معین مهدیزاده حکاک');

function je(id, date, refType, refId, desc) {
  db.prepare(`
    INSERT INTO journal_entries (id, entry_date, description, ref_type, ref_id, deleted_at, status)
    VALUES (?,?,?,?,?,NULL,'posted')
  `).run(id, date, desc, refType, refId);
}
function jl(entryId, code, debitRial, creditRial) {
  db.prepare(`
    INSERT INTO journal_lines (entry_id, account_code, debit, credit, debit_rial, credit_rial)
    VALUES (?,?,?,?,?,?)
  `).run(entryId, code, debitRial / 10, creditRial / 10, debitRial, creditRial);
}

// Person payments on person leaf only
je(447, '1405/07/07', 'manual_voucher', 447, 'پرداخت به شخص');
jl(447, LEAF_P, 50000000, 0);
jl(447, '1102-27', 0, 50000000);
je(471, '1405/07/11', 'manual_voucher', 471, 'پرداخت به شخص');
jl(471, LEAF_P, 20000000, 0);
jl(471, '1102-27', 0, 20000000);
db.prepare(`
  INSERT INTO person_ledger (person_id,date,entry_type,ref_type,ref_id,description,debit,credit)
  VALUES (51,'1405/07/07','manual_voucher','manual_voucher',447,'پرداخت به شخص',50000000,0),
         (51,'1405/07/11','manual_voucher','manual_voucher',471,'پرداخت به شخص',20000000,0)
`).run();

// Pollution: same vouchers wrongly copied onto customer AR book (prod shape)
db.prepare(`
  INSERT INTO customer_ledger (customer_id,date,entry_type,ref_type,ref_id,description,debit,credit)
  VALUES (89,'1405/07/07','manual_voucher','manual_voucher',447,'پرداخت به شخص',50000000,0),
         (89,'1405/07/11','manual_voucher','manual_voucher',471,'پرداخت به شخص',20000000,0)
`).run();

// Invoice on AR leaf
je(979, '1405/07/25', 'invoice', 41, 'فاکتور معمولی T-0041');
jl(979, LEAF_AR, 15120000, 0);
jl(979, '4101', 0, 15120000);
db.prepare(`
  INSERT INTO customer_ledger (customer_id,date,entry_type,ref_type,ref_id,description,debit,credit)
  VALUES (89,'1405/07/25','invoice','invoice',41,'فاکتور معمولی T-0041',15120000,0)
`).run();

eq('0a journal alive on person leaf', journalEntryAliveOnLeaf(db, 447, LEAF_P), true);
eq('0b journal NOT on AR leaf', journalEntryAliveOnLeaf(db, 447, LEAF_AR), false);
eq('0c separate AR/person leaves are not a shared sibling leaf', sharedLeafCodes(db).length, 0);
eq('0d roleBookLeafCodes lists both leaves', roleBookLeafCodes(db).sort().join(','), [LEAF_AR, LEAF_P].sort().join(','));

// Read-side: live SQL must hide wrong-leaf vouchers even before heal
const liveSql = db.prepare(`
  SELECT COALESCE(SUM(debit-credit),0) AS s FROM customer_ledger cl
  WHERE customer_id=89 AND (${sqlCustomerLedgerLive('cl')})
`).get().s;
eq('1a live customer book = invoice only (85M vouchers hidden)', liveSql, 15120000);

const jsLive = hideVoidedBookRows(db, db.prepare('SELECT * FROM customer_ledger WHERE customer_id=89').all());
eq('1b JS hide keeps invoice', jsLive.some((r) => r.ref_type === 'invoice' && Number(r.ref_id) === 41), true);
eq('1c JS hide drops person vouchers', jsLive.some((r) => r.ref_type === 'manual_voucher'), false);

const beforeMismatch = customerBooksMismatchList(db, { limit: 8 });
eq('1d mismatch still visible via raw ledger vs GL before heal (list uses live SQL)', beforeMismatch.count, 0);

// Heal must physically retire wrong-leaf rows
const heal = reconcileAllPartyLeafBooks(db, { reason: 'test_v536', via: 'test' });
eq('2a heal retired the two wrong-leaf vouchers', heal.retired >= 2, true);
eq('2b customer book no longer has manual_voucher rows',
  db.prepare("SELECT COUNT(*) n FROM customer_ledger WHERE customer_id=89 AND ref_type='manual_voucher'").get().n, 0);
eq('2c person book kept its vouchers',
  db.prepare("SELECT COUNT(*) n FROM person_ledger WHERE person_id=51 AND ref_type='manual_voucher'").get().n, 2);
eq('2d invoice row remains',
  db.prepare("SELECT COUNT(*) n FROM customer_ledger WHERE customer_id=89 AND ref_type='invoice'").get().n, 1);

// afterPartyBookInsert on person must NOT invent customer rows on a different leaf
afterPartyBookInsert(db, {
  kind: 'person', entityId: 51, date: '1405/07/29', entry_type: 'manual_voucher',
  ref_type: 'manual_voucher', ref_id: 975, description: 'پرداخت به شخص', debit: 10000000, credit: 0,
});
eq('3a person insert does not create customer projection across leaves',
  db.prepare("SELECT COUNT(*) n FROM customer_ledger WHERE customer_id=89 AND ref_id=975").get().n, 0);

// Empty-coa customer must not be pulled into person leaf sibling set
db.prepare('UPDATE customers SET coa_code=NULL WHERE id=89').run();
const solo = reconcileLeaf(db, LEAF_P, { reason: 'test_empty_coa' });
eq('4a empty-coa customer is not a book on person leaf', solo.books, 1);
db.prepare('UPDATE customers SET coa_code=? WHERE id=89').run(LEAF_AR);

// Shared-leaf person+supplier still projects voucher (regression of v519 §6)
const LEAF_SHARE = '110601000082';
db.prepare('INSERT INTO parties (id, opening_balance, coa_code, full_name) VALUES (82, 0, ?, ?)').run(LEAF_SHARE, 'صادقی');
db.prepare('INSERT INTO persons (id, party_id, coa_code, name) VALUES (137, 82, ?, ?)').run(LEAF_SHARE, 'صادقی');
db.prepare('INSERT INTO suppliers (id, party_id, coa_code, name, balance) VALUES (32, 82, ?, ?, 0)').run(LEAF_SHARE, 'صادقی');
je(901, '1405/07/22', 'manual_voucher', 901, 'پرداخت به شخص');
jl(901, LEAF_SHARE, 2500000, 0);
jl(901, '1101', 0, 2500000);
db.prepare(`
  INSERT INTO person_ledger (person_id,date,entry_type,ref_type,ref_id,description,debit,credit)
  VALUES (137,'1405/07/22','manual_voucher','manual_voucher',901,'پرداخت به شخص',2500000,0)
`).run();
afterPartyBookInsert(db, {
  kind: 'person', entityId: 137, date: '1405/07/22', entry_type: 'manual_voucher',
  ref_type: 'manual_voucher', ref_id: 901, description: 'پرداخت به شخص', debit: 2500000, credit: 0,
});
eq('5a shared leaf still projects voucher onto supplier',
  db.prepare("SELECT COUNT(*) n FROM supplier_ledger WHERE supplier_id=32 AND ref_id=901").get().n, 1);
const healShare = reconcileAllPartyLeafBooks(db, { reason: 'test_share' });
eq('5b shared-leaf live voucher not retired as wrong_leaf',
  db.prepare("SELECT COUNT(*) n FROM supplier_ledger WHERE supplier_id=32 AND ref_id=901").get().n, 1);
eq('5c healShare did not wipe shared projection', healShare.retired >= 0, true);

if (failed) {
  console.error('V536_FAIL', failed);
  process.exit(1);
}
console.log(`V536_OK passes=${passes}`);
