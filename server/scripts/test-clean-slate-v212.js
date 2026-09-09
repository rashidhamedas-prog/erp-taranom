/**
 * Clean-slate + new-company workspace: documents must actually disappear.
 */
'use strict';

const path = require('path');
const { freshDb, ok, eq, summary } = require('./lib/test-harness');
const { purgeTransactionalData, snapshotTxnCounts, isWorkspaceClean } = require('../lib/clean-slate');

function seedDocs(db) {
  const userId = db.prepare("SELECT id FROM users WHERE username='admin'").get()?.id || 1;
  const cust = db.prepare(
    "INSERT INTO customers (user_id, biz, phone) VALUES (?,?,?)"
  ).run(userId, 'مشتری تست پاک‌سازی', '09120000000');
  const inv = db.prepare(`
    INSERT INTO invoices (user_id, cust_id, num, type, date, rows, final, stock_deducted)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(userId, cust.lastInsertRowid, 'T-TEST-1', 'normal', '1405/01/15', '[]', 100000, 0);

  db.prepare(`
    INSERT INTO settlements (user_id, cust_id, invoice_id, amount, pay_type, date)
    VALUES (?,?,?,?,?,?)
  `).run(userId, cust.lastInsertRowid, inv.lastInsertRowid, 50000, 'cash', '1405/01/16');

  const je = db.prepare(`
    INSERT INTO journal_entries (entry_date, description, ref_type, ref_id, created_by)
    VALUES (?,?,?,?,?)
  `).run('1405/01/15', 'سند تست', 'invoice', inv.lastInsertRowid, userId);
  db.prepare(`
    INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit)
    VALUES (?,?,?,?,?)
  `).run(je.lastInsertRowid, '1103', 'دریافتنی', 10000, 0);
  db.prepare(`
    INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit)
    VALUES (?,?,?,?,?)
  `).run(je.lastInsertRowid, '4101', 'فروش', 0, 10000);

  db.prepare(`
    INSERT INTO customer_ledger (customer_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(cust.lastInsertRowid, '1405/01/15', 'invoice', 'invoice', inv.lastInsertRowid, 'فاکتور تست', 100000, 0, userId);

  try {
    db.prepare(`
      INSERT INTO cheque_records (direction, amount, issue_date, status, party_name)
      VALUES ('in', 250000, '1405/02/01', 'registered', 'تست')
    `).run();
  } catch { /* schema variant */ }

  try {
    db.prepare("INSERT INTO orders (user_id, cust_id, date, total, status) VALUES (?,?,?,?,?)")
      .run(userId, cust.lastInsertRowid, '1405/01/10', 1, 'pending');
  } catch { /* optional */ }

  return { userId, customerId: cust.lastInsertRowid, invoiceId: inv.lastInsertRowid };
}

function main() {
  console.log('test-clean-slate-v212.js');
  const { db, dbMod, cleanup } = freshDb();
  try {
    const seeded = seedDocs(db);
    const before = snapshotTxnCounts(db);
    ok('seed invoices', (before.invoices || 0) >= 1);
    ok('seed journals', (before.journal_entries || 0) >= 1);
    ok('seed journal lines', (before.journal_lines || 0) >= 2);
    ok('seed settlements despite FK', (before.settlements || 0) >= 1);

    const wiped = purgeTransactionalData(db, { mode: 'transactions' });
    ok('wipe reports invoices=0', (wiped.counts.invoices || 0) === 0);
    ok('wipe reports journals=0', (wiped.counts.journal_entries || 0) === 0);
    ok('wipe reports lines=0', (wiped.counts.journal_lines || 0) === 0);
    ok('wipe reports settlements=0', (wiped.counts.settlements || 0) === 0);
    ok('wipe reports cheques=0', (wiped.counts.cheque_records || 0) === 0);
    ok('workspace clean flag', isWorkspaceClean(db).clean);
    ok('customer master kept', !!db.prepare('SELECT id FROM customers WHERE id=?').get(seeded.customerId));
    ok('users kept', !!db.prepare("SELECT id FROM users WHERE username='admin'").get());
    ok('coa kept', (db.prepare('SELECT COUNT(*) c FROM chart_of_accounts').get().c || 0) > 0);
    eq('customer balance reset', db.prepare('SELECT balance FROM customers WHERE id=?').get(seeded.customerId)?.balance || 0, 0);

    const fyBefore = db.prepare('SELECT COUNT(*) c FROM fiscal_years').get().c;
    ok('fiscal years kept on txn wipe', fyBefore >= 1);

    try {
      db.prepare("INSERT INTO products (name, sku, stock) VALUES (?,?,?)").run('کالای تست پاک‌سازی', 'SLATE-1', 7);
    } catch { /* schema variant */ }
    const catalogWipe = purgeTransactionalData(db, { mode: 'open-clean' });
    eq('open-clean invoices', catalogWipe.counts.invoices || 0, 0);
    eq('open-clean customers', catalogWipe.counts.customers || 0, 0);
    eq('open-clean products', catalogWipe.counts.products || 0, 0);
    ok('users kept after open-clean', !!db.prepare("SELECT id FROM users WHERE username='admin'").get());
    ok('coa kept after open-clean', (db.prepare('SELECT COUNT(*) c FROM chart_of_accounts').get().c || 0) > 0);

    const ws = require('../lib/company-workspace');
    const entry = ws.createCompanyWorkspace({
      name: 'شرکت تست خام ۲۱۲',
      code: 'C212',
      startDate: '1405/01/01',
      fiscalLabel: 'سال مالی تست ۲۱۲',
      sourceDb: db,
      createdByUserId: seeded.userId,
    });
    ok('new company file exists', require('fs').existsSync(entry.dbPath));
    const Database = require('better-sqlite3');
    const fresh = new Database(entry.dbPath, { readonly: true });
    try {
      const nInv = fresh.prepare('SELECT COUNT(*) c FROM invoices').get().c;
      const nJe = fresh.prepare('SELECT COUNT(*) c FROM journal_entries').get().c;
      const nSet = fresh.prepare('SELECT COUNT(*) c FROM settlements').get().c;
      eq('new company invoices', nInv, 0);
      eq('new company journals', nJe, 0);
      eq('new company settlements', nSet, 0);
      ok('new company has users', (fresh.prepare('SELECT COUNT(*) c FROM users').get().c || 0) >= 1);
      ok('new company has FY', (fresh.prepare("SELECT COUNT(*) c FROM fiscal_years WHERE status='open'").get().c || 0) >= 1);
      ok('API cleanliness all zero', Object.values(entry.cleanliness || {}).every((n) => Number(n) === 0));
    } finally {
      fresh.close();
    }

    ok('source company invoices still gone after creating sibling', 
      (db.prepare('SELECT COUNT(*) c FROM invoices').get().c || 0) === 0);
    ok('live handle still source db', path.resolve(dbMod.getDBPath()) !== path.resolve(entry.dbPath));
  } finally {
    cleanup();
  }
  summary();
}

main();
