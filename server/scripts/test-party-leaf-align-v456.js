'use strict';
/**
 * v456 — sibling books on one leaf must not hide a real payment.
 * Sadeghi shape: person opening-only, supplier opening+payment, GL = supplier.
 */
const Database = require('better-sqlite3');
const { partySignedBalanceDetailMap } = require('../lib/party-books');
const { buildPartyTurnover } = require('../lib/party-turnover');
const { backfillPartyLeafBooks, syncJournalEntryToPartyBooks } = require('../lib/party-leaf-sync');
const { retireSupplierLedgerByRef } = require('../lib/party-ledger-retire');

let failed = 0;
function eq(name, got, exp) {
  if (got !== exp) {
    failed += 1;
    console.error('FAIL', name, 'got', got, 'expected', exp);
  }
}

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE parties (
    id INTEGER PRIMARY KEY, opening_balance INTEGER, coa_code TEXT,
    legacy_table TEXT, legacy_id INTEGER, full_name TEXT
  );
  CREATE TABLE persons (
    id INTEGER PRIMARY KEY, party_id INTEGER, coa_code TEXT, name TEXT
  );
  CREATE TABLE suppliers (
    id INTEGER PRIMARY KEY, party_id INTEGER, coa_code TEXT, name TEXT, balance INTEGER
  );
  CREATE TABLE customers (
    id INTEGER PRIMARY KEY, party_id INTEGER, coa_code TEXT, name TEXT
  );
  CREATE TABLE person_ledger (
    id INTEGER PRIMARY KEY, person_id INTEGER, date TEXT, entry_type TEXT,
    ref_type TEXT, ref_id INTEGER, description TEXT, debit INTEGER, credit INTEGER,
    user_id INTEGER, created_at INTEGER
  );
  CREATE TABLE supplier_ledger (
    id INTEGER PRIMARY KEY, supplier_id INTEGER, date TEXT, entry_type TEXT,
    ref_type TEXT, ref_id INTEGER, description TEXT, debit INTEGER, credit INTEGER,
    user_id INTEGER, created_at INTEGER
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
`);

const CODE = '110601000082';
db.prepare('INSERT INTO parties (id, opening_balance, coa_code, legacy_table, legacy_id, full_name) VALUES (82, -1000000, ?, ?, 1, ?)').run(CODE, 'suppliers', 'صادقی');
db.prepare('INSERT INTO persons (id, party_id, coa_code, name) VALUES (137, 82, ?, ?)').run(CODE, 'صادقی');
db.prepare('INSERT INTO suppliers (id, party_id, coa_code, name, balance) VALUES (32, 82, ?, ?, 1000000)').run(CODE, 'صادقی');

db.prepare(`INSERT INTO journal_entries (id, entry_date, description, ref_type, ref_id, status) VALUES (46, '1405/01/01', 'افتتاحیه', 'opening_balance', 82, 'posted')`).run();
db.prepare(`INSERT INTO journal_lines (entry_id, account_code, debit, credit, debit_rial, credit_rial, description) VALUES (46, ?, 0, 100000, 0, 1000000, 'افتتاحیه')`).run(CODE);
db.prepare(`INSERT INTO journal_entries (id, entry_date, description, ref_type, ref_id, status) VALUES (515, '1405/07/19', 'پرداخت به تأمین‌کننده', 'supplier_payment', 4, 'posted')`).run();
db.prepare(`INSERT INTO journal_lines (entry_id, account_code, debit, credit, debit_rial, credit_rial, description) VALUES (515, ?, 30000, 0, 300000, 0, 'پرداخت')`).run(CODE);
db.prepare(`INSERT INTO journal_lines (entry_id, account_code, debit, credit, debit_rial, credit_rial, description) VALUES (515, '1102-27', 0, 30000, 0, 300000, 'بانک')`).run();

db.prepare(`INSERT INTO person_ledger (person_id, date, entry_type, ref_type, ref_id, description, debit, credit) VALUES (137, '1405/01/01', 'opening', 'opening_balance', 46, 'افتتاحیه', 0, 1000000)`).run();
db.prepare(`INSERT INTO supplier_ledger (supplier_id, date, entry_type, ref_type, ref_id, description, debit, credit) VALUES (32, '1405/01/01', 'opening', 'opening_balance', 46, 'افتتاحیه', 0, 1000000)`).run();
db.prepare(`INSERT INTO supplier_ledger (supplier_id, date, entry_type, ref_type, ref_id, description, debit, credit) VALUES (32, '1405/07/19', 'payment', 'supplier_payment', 4, 'پرداخت', 300000, 0)`).run();

// Payroll stored in toman must not be duplicated when GL is ×10.
const CODE2 = '110601000104';
db.prepare('INSERT INTO parties (id, opening_balance, coa_code, full_name) VALUES (104, 0, ?, ?)').run(CODE2, 'لکزیان');
db.prepare('INSERT INTO persons (id, party_id, coa_code, name) VALUES (200, 104, ?, ?)').run(CODE2, 'لکزیان');
db.prepare(`INSERT INTO journal_entries (id, entry_date, description, ref_type, ref_id, status) VALUES (900, '1405/06/31', 'حقوق', 'payroll', 13, 'posted')`).run();
db.prepare(`INSERT INTO journal_lines (entry_id, account_code, debit, credit, debit_rial, credit_rial) VALUES (900, ?, 0, 30000, 0, 300000)`).run(CODE2);
db.prepare(`INSERT INTO person_ledger (person_id, date, entry_type, ref_type, ref_id, description, debit, credit) VALUES (200, '1405/06/31', 'payroll', 'payroll', 13, 'حقوق', 0, 30000)`).run();

const before = partySignedBalanceDetailMap(db).get(82);
eq('balance includes payment', before.balance, -700000);
eq('source is the book that matches GL', before.source, 'supplier');

const turn = buildPartyTurnover(db, 82);
eq('turnover closing', turn.closing, -700000);
eq('no synthetic reconcile', turn.entries.some((e) => e.source === 'opening_fold' || String(e.description || '').includes('تطبیق')), false);
eq('payment row kept', turn.entries.some((e) => e.debit === 300000), true);

const first = backfillPartyLeafBooks(db);
eq('heal inserts the missing person payment', first.inserted, 1);
const personPays = db.prepare(`SELECT COUNT(*) n FROM person_ledger WHERE person_id=137 AND ref_type='supplier_payment'`).get().n;
eq('person has the payment once', personPays, 1);
const second = backfillPartyLeafBooks(db);
eq('heal is idempotent', second.inserted, 0);
const payrollN = db.prepare(`SELECT COUNT(*) n FROM person_ledger WHERE person_id=200 AND ref_type='payroll'`).get().n;
eq('payroll toman row not duplicated', payrollN, 1);

db.prepare(`DELETE FROM person_ledger WHERE person_id=137 AND ref_type='supplier_payment'`).run();
const mirrored = syncJournalEntryToPartyBooks(db, 515);
eq('live journal copies onto the empty sibling', mirrored.inserted, 1);
eq('person payment restored', db.prepare(`SELECT COUNT(*) n FROM person_ledger WHERE person_id=137 AND ref_type='supplier_payment'`).get().n, 1);
const again = syncJournalEntryToPartyBooks(db, 515);
eq('live copy does not double', again.inserted, 0);

const bank = db.prepare(`SELECT COALESCE(credit_rial,0) n FROM journal_lines WHERE account_code='1102-27'`).get().n;
eq('bank line untouched', bank, 300000);

retireSupplierLedgerByRef(db, { refTypes: ['supplier_payment'], refId: 4, supplierId: 32 });
eq('void drops supplier payment', db.prepare(`SELECT COUNT(*) n FROM supplier_ledger WHERE ref_type='supplier_payment'`).get().n, 0);
eq('void drops mirrored person payment', db.prepare(`SELECT COUNT(*) n FROM person_ledger WHERE ref_type='supplier_payment'`).get().n, 0);
eq('opening stays', db.prepare(`SELECT COUNT(*) n FROM person_ledger WHERE person_id=137 AND ref_type='opening_balance'`).get().n, 1);

const after = partySignedBalanceDetailMap(db).get(82);
eq('after books agree, balance is the shared opening', after.balance, -1000000);

if (failed) {
  console.error('V456_FAIL', failed);
  process.exit(1);
}
console.log('V456_OK passes=14');
