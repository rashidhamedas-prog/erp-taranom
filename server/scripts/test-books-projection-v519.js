'use strict';
/**
 * v519 — party books are projections of the journal.
 *
 * Production shape (۱۴۰۵/۰۷/۲۹): customer 85 + supplier 44 share leaf 210101000007.
 * Purchase #3 was amended 217,804,530 → 198,004,118; the supplier row was updated in
 * place and the new amount copied onto the customer book, but the old copy stayed —
 * the dashboard then showed «مطالبات دفتر مشتری ≠ تفصیلی». These assertions pin:
 *   1. amend leaves exactly one projection (old copy retired, audited)
 *   2. legacy stale copies are healed by the continuous reconcile, idempotently
 *   3. invoice amend reaches the sibling supplier book
 *   4. void retires the projection (hook on reverseJournalEntry) and the read side
 *      hides a projection whose journal entry is dead even before the heal runs
 *   5. native rows are never deleted by the reconcile; a purchase line never
 *      swallows a same-day same-amount customer settlement
 *   6. manual_voucher rows live and die with their journal entry
 */
const Database = require('better-sqlite3');
const {
  syncJournalEntryToPartyBooks, afterPartyBookInsert, reconcileAllPartyLeafBooks,
  reconcileLeaf, sharedLeafCodes, isProjectionRow,
} = require('../lib/party-leaf-sync');
const { reverseJournalEntry } = require('../lib/void-journal');
const { retireSupplierLedgerByRef } = require('../lib/party-ledger-retire');
const {
  hideVoidedBookRows, sqlCustomerLedgerLive, updateInvoiceCustomerLedger,
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

const LEAF = '210101000007';
const LEAF_SOLO = '110301000099';
db.prepare('INSERT INTO parties (id, opening_balance, coa_code, full_name) VALUES (145, 0, ?, ?)').run(LEAF, 'ظریف - کشباف عاقلی');
db.prepare('INSERT INTO customers (id, party_id, coa_code, biz) VALUES (85, 145, ?, ?)').run(LEAF, 'ظریف - کشباف عاقلی');
db.prepare('INSERT INTO suppliers (id, party_id, coa_code, name, balance) VALUES (44, 145, ?, ?, 0)').run(LEAF, 'ظریف - کشباف عاقلی');
db.prepare('INSERT INTO parties (id, opening_balance, coa_code, full_name) VALUES (999, 0, ?, ?)').run(LEAF_SOLO, 'تک‌نقش');
db.prepare('INSERT INTO customers (id, party_id, coa_code, biz) VALUES (99, 999, ?, ?)').run(LEAF_SOLO, 'تک‌نقش');

const je = (id, date, refType, refId, desc) => db.prepare(
  "INSERT INTO journal_entries (id, entry_date, description, ref_type, ref_id, status) VALUES (?,?,?,?,?,'posted')"
).run(id, date, desc, refType, refId);
const jl = (entryId, code, debitRial, creditRial) => db.prepare(
  'INSERT INTO journal_lines (entry_id, account_code, debit, credit, debit_rial, credit_rial) VALUES (?,?,?,?,?,?)'
).run(entryId, code, Math.round(debitRial / 10), Math.round(creditRial / 10), debitRial, creditRial);

const OLD = 217804530;
const NEW = 198004118;

// ---- 1. purchase #3 posted at OLD, native supplier row + projection on customer book
je(361, '1405/07/10', 'purchase', 3, 'فاکتور خرید P-3');
jl(361, LEAF, 0, OLD);
jl(361, '1104', OLD, 0);
db.prepare("INSERT INTO supplier_ledger (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit) VALUES (44,'1405/07/10','purchase','purchase',3,'فاکتور خرید P-3',0,?)").run(OLD);
let r = afterPartyBookInsert(db, {
  kind: 'supplier', entityId: 44, date: '1405/07/10', entry_type: 'purchase', ref_type: 'purchase', ref_id: 3,
  description: 'فاکتور خرید P-3', debit: 0, credit: OLD,
});
eq('1a post copies purchase onto customer book', r.copied, 1);
eq('1b nothing retired on first post', r.retired, 0);

const custRows = (refType, refId) => db.prepare(
  'SELECT id, debit, credit FROM customer_ledger WHERE customer_id=85 AND ref_type=? AND ref_id=? ORDER BY id'
).all(refType, refId);
const supRows = (refType, refId) => db.prepare(
  'SELECT id, debit, credit FROM supplier_ledger WHERE supplier_id=44 AND ref_type=? AND ref_id=? ORDER BY id'
).all(refType, refId);
const signed = (table, col, id) => {
  const s = db.prepare(`SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM ${table} WHERE ${col}=?`).get(id);
  return Number(s.d) - Number(s.c);
};
const glSigned = (code) => {
  const s = db.prepare(`
    SELECT COALESCE(SUM(jl.debit_rial),0) d, COALESCE(SUM(jl.credit_rial),0) c
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
  `).get(code);
  return Number(s.d) - Number(s.c);
};

// amend: journal rewritten in place first (ledger.rewriteJournalEntry → sync hook), then the book
db.prepare('UPDATE journal_lines SET credit=?, credit_rial=? WHERE entry_id=361 AND account_code=?').run(Math.round(NEW / 10), NEW, LEAF);
db.prepare('UPDATE journal_lines SET debit=?, debit_rial=? WHERE entry_id=361 AND account_code=?').run(Math.round(NEW / 10), NEW, '1104');
r = syncJournalEntryToPartyBooks(db, 361);
eq('1c rewrite hook does not invent the new amount before the native book has it', r.inserted, 0);
eq('1d rewrite hook keeps the old projection while the amend is in flight', custRows('purchase', 3).length, 1);
db.prepare('UPDATE supplier_ledger SET credit=? WHERE supplier_id=44 AND ref_type=? AND ref_id=3').run(NEW, 'purchase');
r = afterPartyBookInsert(db, {
  kind: 'supplier', entityId: 44, date: '1405/07/10', entry_type: 'purchase', ref_type: 'purchase', ref_id: 3,
  description: 'فاکتور خرید P-3', debit: 0, credit: NEW,
});
eq('1e book update copies the new amount', r.copied, 1);
eq('1f book update retires the stale projection', r.retired, 1);
let rows = custRows('purchase', 3);
eq('1g customer book carries purchase #3 once', rows.length, 1);
eq('1h with the amended amount', rows[0].credit, NEW);
eq('1i supplier book untouched (one native row)', supRows('purchase', 3).length, 1);
eq('1j customer book = GL leaf', signed('customer_ledger', 'customer_id', 85), glSigned(LEAF));
eq('1k supplier book = GL leaf', signed('supplier_ledger', 'supplier_id', 44), glSigned(LEAF));
const audits = db.prepare("SELECT entity, entity_id, detail FROM audit_log WHERE action='party_books_retire'").all();
eq('1l retire is audited', audits.length, 1);
eq('1m audit names the customer book', audits[0].entity, 'customer_ledger');
eq('1n audit reason', JSON.parse(audits[0].detail).reason, 'superseded_amount');
eq('1o audit amount', JSON.parse(audits[0].detail).credit, OLD);

// ---- 2. legacy stale copy (exact production rows 179 + 240) healed by the continuous reconcile
db.prepare("INSERT INTO customer_ledger (id,customer_id,date,entry_type,ref_type,ref_id,description,debit,credit) VALUES (179,85,'1405/07/10','purchase','purchase',3,'فاکتور خرید P-3 (قدیمی)',0,?)").run(OLD);
eq('2a shared leaf detected', sharedLeafCodes(db).includes(LEAF), true);
eq('2b solo leaf is not shared', sharedLeafCodes(db).includes(LEAF_SOLO), false);
let plan = reconcileAllPartyLeafBooks(db, { dryRun: true });
eq('2c dry run plans one retire', plan.retired, 0);
eq('2d dry run lists the stale row', plan.actions.length === 1 && plan.actions[0].actions.retired.length, 1);
eq('2e dry run did not delete', custRows('purchase', 3).length, 2);
let heal = reconcileAllPartyLeafBooks(db, { reason: 'test' });
eq('2f heal retires the stale copy', heal.retired, 1);
eq('2g heal inserts nothing', heal.inserted, 0);
rows = custRows('purchase', 3);
eq('2h one projection remains', rows.length, 1);
eq('2i the live amount remains', rows[0].credit, NEW);
heal = reconcileAllPartyLeafBooks(db, { reason: 'test' });
eq('2j heal is idempotent', heal.retired + heal.inserted, 0);

// ---- 3. invoice amend on the same dual-role party reaches the supplier book
db.prepare("INSERT INTO invoices (id, cust_id, num, type, final, status, date) VALUES (31, 85, 'T-0031', 'final', 5000000, 'posted', '1405/07/12')").run();
je(700, '1405/07/12', 'invoice', 31, 'فاکتور رسمی T-0031');
jl(700, LEAF, 5000000, 0);
jl(700, '4101', 0, 5000000);
db.prepare("INSERT INTO customer_ledger (customer_id,date,entry_type,ref_type,ref_id,description,debit,credit) VALUES (85,'1405/07/12','invoice','invoice',31,'فاکتور رسمی T-0031',5000000,0)").run();
r = afterPartyBookInsert(db, {
  kind: 'customer', entityId: 85, date: '1405/07/12', entry_type: 'invoice', ref_type: 'invoice', ref_id: 31,
  description: 'فاکتور رسمی T-0031', debit: 5000000, credit: 0,
});
eq('3a invoice projected onto supplier book', supRows('invoice', 31).length, 1);
// amend to 4,000,000: journal first, then updateInvoiceCustomerLedger (in-place) → sibling sync
db.prepare('UPDATE journal_lines SET debit=400000, debit_rial=4000000 WHERE entry_id=700 AND account_code=?').run(LEAF);
db.prepare("UPDATE journal_lines SET credit=400000, credit_rial=4000000 WHERE entry_id=700 AND account_code='4101'").run();
syncJournalEntryToPartyBooks(db, 700);
updateInvoiceCustomerLedger(db, {
  customerId: 85, date: '1405/07/12', invId: 31, num: 'T-0031', invType: 'final', final: 4000000, userId: 7,
  payType: 'credit', skipImmediatePayment: true,
});
rows = supRows('invoice', 31);
eq('3b supplier book carries the invoice once after amend', rows.length, 1);
eq('3c with the amended amount', rows[0].debit, 4000000);
eq('3d customer native row amended in place', custRows('invoice', 31)[0].debit, 4000000);
eq('3e both books = GL leaf', signed('customer_ledger', 'customer_id', 85) === glSigned(LEAF)
  && signed('supplier_ledger', 'supplier_id', 44) === glSigned(LEAF), true);

// ---- 4. void: journal hook retires the projection; read side hides a dead projection
je(362, '1405/07/15', 'purchase', 4, 'فاکتور خرید P-4');
jl(362, LEAF, 0, 22000000);
jl(362, '1104', 22000000, 0);
db.prepare("INSERT INTO supplier_ledger (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit) VALUES (44,'1405/07/15','purchase','purchase',4,'فاکتور خرید P-4',0,22000000)").run();
afterPartyBookInsert(db, {
  kind: 'supplier', entityId: 44, date: '1405/07/15', entry_type: 'purchase', ref_type: 'purchase', ref_id: 4,
  description: 'فاکتور خرید P-4', debit: 0, credit: 22000000,
});
eq('4a projection present before void', custRows('purchase', 4).length, 1);
// read side first: a projection whose journal entry is dead is not live, even while the row exists
db.prepare("UPDATE journal_entries SET status='reversed', deleted_at=1 WHERE id=362").run();
const liveRows = db.prepare(`SELECT cl.ref_type, cl.ref_id FROM customer_ledger cl WHERE cl.customer_id=85 AND (${sqlCustomerLedgerLive('cl')})`).all();
eq('4b SQL liveness hides the dead projection', liveRows.some((x) => x.ref_type === 'purchase' && Number(x.ref_id) === 4), false);
eq('4c SQL liveness keeps the live projection', liveRows.some((x) => x.ref_type === 'purchase' && Number(x.ref_id) === 3), true);
const jsRows = hideVoidedBookRows(db, db.prepare('SELECT * FROM customer_ledger WHERE customer_id=85').all());
eq('4d JS liveness hides the dead projection', jsRows.some((x) => x.ref_type === 'purchase' && Number(x.ref_id) === 4), false);
eq('4e JS liveness keeps native invoice', jsRows.some((x) => x.ref_type === 'invoice' && Number(x.ref_id) === 31), true);
db.prepare("UPDATE journal_entries SET status='posted', deleted_at=NULL WHERE id=362").run();
// now the real void through void-journal
const voided = reverseJournalEntry(db, 362, { reason: 'ابطال خرید' });
eq('4f reverseJournalEntry soft-voids', voided, 362);
eq('4g void hook retires the projection on the customer book', custRows('purchase', 4).length, 0);
eq('4h native supplier row is left to the business void', supRows('purchase', 4).length, 1);
retireSupplierLedgerByRef(db, { refTypes: ['purchase', 'purchase_invoice'], refId: 4, supplierId: 44 });
eq('4i business void drops the native row', supRows('purchase', 4).length, 0);
eq('4j books = GL after void', signed('customer_ledger', 'customer_id', 85), glSigned(LEAF));
eq('4k void is audited', db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='party_books_retire' AND detail LIKE '%document_dead%'").get().n, 1);

// ---- 5. native rows are never deleted; a purchase line never swallows a same-day settlement
db.prepare("INSERT INTO customer_ledger (customer_id,date,entry_type,ref_type,ref_id,description,debit,credit) VALUES (85,'1405/07/20','settlement','settlement',7,'دریافت وجه',0,1000000)").run();
je(800, '1405/07/20', 'purchase', 9, 'فاکتور خرید P-9');
jl(800, LEAF, 0, 1000000);
jl(800, '1104', 1000000, 0);
db.prepare("INSERT INTO supplier_ledger (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit) VALUES (44,'1405/07/20','purchase','purchase',9,'فاکتور خرید P-9',0,1000000)").run();
heal = reconcileAllPartyLeafBooks(db, { reason: 'test' });
eq('5a settlement without GL line is native → kept', custRows('settlement', 7).length, 1);
eq('5b purchase #9 projected onto customer book (not matched to the settlement)', custRows('purchase', 9).length, 1);
eq('5c exactly one insert for that', heal.inserted, 1);
db.prepare("INSERT INTO supplier_ledger (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit) VALUES (44,'1405/07/21','purchase','purchase',10,'بدون سند',0,333333)").run();
heal = reconcileAllPartyLeafBooks(db, { reason: 'test' });
eq('5d native supplier row without journal is kept', supRows('purchase', 10).length, 1);
eq('5e …and not projected onto the customer book (siblings mode never invents from the journal)', custRows('purchase', 10).length, 0);
eq('5f classification: purchase is foreign to a customer book', isProjectionRow('customer', { ref_type: 'purchase' }), true);
eq('5g classification: settlement is native to a customer book', isProjectionRow('customer', { ref_type: 'settlement' }), false);
eq('5h classification: cheque refs are native everywhere', isProjectionRow('supplier', { ref_type: 'cheque_endorse' }), false);
eq('5i classification: invoice is foreign to a supplier book', isProjectionRow('supplier', { ref_type: 'invoice' }), true);

// scoped reconcile on a solo leaf touches nothing
const solo = reconcileLeaf(db, LEAF_SOLO, { reason: 'test' });
eq('5j solo leaf: nothing to do', solo.inserted + solo.retired, 0);

// ---- 6. manual_voucher rows live and die with their journal entry (person + supplier leaf)
const LEAF_P = '110601000082';
db.prepare('INSERT INTO parties (id, opening_balance, coa_code, full_name) VALUES (82, 0, ?, ?)').run(LEAF_P, 'صادقی');
db.prepare('INSERT INTO persons (id, party_id, coa_code, name) VALUES (137, 82, ?, ?)').run(LEAF_P, 'صادقی');
db.prepare('INSERT INTO suppliers (id, party_id, coa_code, name, balance) VALUES (32, 82, ?, ?, 0)').run(LEAF_P, 'صادقی');
je(901, '1405/07/22', 'manual_voucher', 901, 'پرداخت به شخص');
jl(901, LEAF_P, 2500000, 0);
jl(901, '1101', 0, 2500000);
db.prepare("INSERT INTO person_ledger (person_id,date,entry_type,ref_type,ref_id,description,debit,credit) VALUES (137,'1405/07/22','manual_voucher','manual_voucher',901,'پرداخت به شخص',2500000,0)").run();
afterPartyBookInsert(db, {
  kind: 'person', entityId: 137, date: '1405/07/22', entry_type: 'manual_voucher', ref_type: 'manual_voucher', ref_id: 901,
  description: 'پرداخت به شخص', debit: 2500000, credit: 0,
});
eq('6a voucher projected onto supplier book', db.prepare("SELECT COUNT(*) n FROM supplier_ledger WHERE supplier_id=32 AND ref_type='manual_voucher' AND ref_id=901").get().n, 1);
heal = reconcileAllPartyLeafBooks(db, { reason: 'test' });
eq('6b live voucher rows are kept', heal.retired, 0);
reverseJournalEntry(db, 901, { reason: 'ابطال سند دستی' });
eq('6c dead voucher: person row retired', db.prepare("SELECT COUNT(*) n FROM person_ledger WHERE person_id=137 AND ref_id=901").get().n, 0);
eq('6d dead voucher: supplier projection retired', db.prepare("SELECT COUNT(*) n FROM supplier_ledger WHERE supplier_id=32 AND ref_id=901").get().n, 0);

// ---- 7. production shape «مهدیه ابراهیمی»: person + customer on one leaf, supplier role on
// another leaf. A payment posted on the supplier leaf but mirrored into the person book is a
// GL reclass question — the reconcile must not delete it (document alive elsewhere).
const LEAF_A = '110301000015';
const LEAF_B = '210101000006';
db.prepare('INSERT INTO parties (id, opening_balance, coa_code, full_name) VALUES (136, 0, ?, ?)').run(LEAF_A, 'مهدیه ابراهیمی');
db.prepare('INSERT INTO persons (id, party_id, coa_code, name) VALUES (132, 136, ?, ?)').run(LEAF_A, 'مهدیه ابراهیمی');
db.prepare('INSERT INTO customers (id, party_id, coa_code, biz) VALUES (88, 136, ?, ?)').run(LEAF_A, 'مهدیه ابراهیمی');
db.prepare('INSERT INTO suppliers (id, party_id, coa_code, name, balance) VALUES (43, 136, ?, ?, 0)').run(LEAF_B, 'مهدیه ابراهیمی');
je(423, '1405/07/05', 'supplier_payment', 3, 'پرداخت به تأمین‌کننده');
jl(423, LEAF_B, 270000000, 0);
jl(423, '1102-27', 0, 270000000);
db.prepare("INSERT INTO supplier_ledger (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit) VALUES (43,'1405/07/05','payment','supplier_payment',3,'پرداخت',270000000,0)").run();
db.prepare("INSERT INTO person_ledger (id,person_id,date,entry_type,ref_type,ref_id,description,debit,credit) VALUES (125,132,'1405/07/05','payment','supplier_payment',3,'پرداخت به تأمین‌کننده',270000000,0)").run();
je(747, '1405/07/05', 'production_labor', 14, 'دستمزد دوخت');
jl(747, LEAF_A, 0, 192000000);
jl(747, '5110', 192000000, 0);
db.prepare("INSERT INTO person_ledger (person_id,date,entry_type,ref_type,ref_id,description,debit,credit) VALUES (132,'1405/07/05','production_labor','production_labor',14,'دستمزد دوخت',0,192000000)").run();
heal = reconcileAllPartyLeafBooks(db, { reason: 'test' });
eq('7a payment alive on the supplier leaf is kept in the person book', db.prepare('SELECT COUNT(*) n FROM person_ledger WHERE id=125').get().n, 1);
eq('7b labor projected onto the customer book', db.prepare("SELECT COUNT(*) n FROM customer_ledger WHERE customer_id=88 AND ref_type='production_labor' AND ref_id=14").get().n, 1);
eq('7c …and the payment is not projected (journal has it on another leaf)', db.prepare("SELECT COUNT(*) n FROM customer_ledger WHERE customer_id=88 AND ref_type='supplier_payment'").get().n, 0);
reverseJournalEntry(db, 423, { reason: 'ابطال پرداخت' });
retireSupplierLedgerByRef(db, { refTypes: ['supplier_payment'], refId: 3, supplierId: 43 });
heal = reconcileAllPartyLeafBooks(db, { reason: 'test' });
eq('7d once the payment is voided everywhere, the person projection goes too', db.prepare('SELECT COUNT(*) n FROM person_ledger WHERE id=125').get().n, 0);

if (failed) {
  console.error('V519_FAIL', failed);
  process.exit(1);
}
console.log(`V519_OK passes=${passes}`);
