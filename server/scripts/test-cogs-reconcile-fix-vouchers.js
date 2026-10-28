'use strict';
/**
 * فاز ۰ — تطبیق COGS باید سندهای invoice_cogs_fix و invoice_cogs_reversal را بشمارد.
 * اجرا: node server/scripts/test-cogs-reconcile-fix-vouchers.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const {
  cogsPostedForInvoice,
  cogsVsKardexDiff,
  COGS_JE_REF_TYPES,
} = require('../lib/inventory/cogs-per-invoice');
const { invoiceCogsDiffs } = require('../lib/inventory/wh-data-correction');

let fails = 0;
function ok(cond, msg, detail) {
  if (cond) console.log('  ✓', msg);
  else {
    fails += 1;
    console.log('  ✗', msg, detail != null ? detail : '');
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogs-recon-'));
const dbPath = path.join(dir, 't.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO settings(key,value) VALUES ('coa_cogs','5101');
  CREATE TABLE chart_of_accounts (
    code TEXT PRIMARY KEY, name TEXT, parent_code TEXT, is_active INTEGER DEFAULT 1
  );
  INSERT INTO chart_of_accounts(code,name,parent_code,is_active) VALUES
    ('5101','بهای تمام‌شده',NULL,1),
    ('1104','موجودی',NULL,1);
  CREATE TABLE journal_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_date TEXT, description TEXT, ref_type TEXT, ref_id INTEGER,
    created_by INTEGER, status TEXT, deleted_at INTEGER DEFAULT 0
  );
  CREATE TABLE journal_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER, account_code TEXT, account_name TEXT,
    debit REAL, credit REAL, debit_rial INTEGER, credit_rial INTEGER
  );
  CREATE TABLE inventory_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER, warehouse_id INTEGER,
    qty_in REAL DEFAULT 0, qty_out REAL DEFAULT 0,
    amount_rial INTEGER DEFAULT 0, unit_cost_rial INTEGER DEFAULT 0,
    source_type TEXT, source_id INTEGER, event_type TEXT,
    status TEXT DEFAULT 'posted', date TEXT, note TEXT,
    tx_no TEXT, qty_balance REAL DEFAULT 0, avg_cost_after_rial INTEGER DEFAULT 0,
    reversed_of INTEGER
  );
  CREATE TABLE invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    num TEXT, date TEXT, type TEXT, final REAL, warehouse_id INTEGER,
    user_id INTEGER, cust_id INTEGER, rows TEXT, stock_deducted INTEGER
  );
  CREATE TABLE warehouses (
    id INTEGER PRIMARY KEY, name TEXT, code TEXT, warehouse_type TEXT,
    inventory_method TEXT, allow_negative INTEGER DEFAULT 0
  );
  INSERT INTO warehouses(id,name,code,warehouse_type,inventory_method)
    VALUES (1,'تست','W1','finished_goods','perpetual');
`);

function addJe(refType, refId, cogsDebit, cogsCredit, status) {
  const r = db.prepare(`
    INSERT INTO journal_entries(entry_date, description, ref_type, ref_id, created_by, status, deleted_at)
    VALUES ('1405/07/01','t',?,?,1,?,0)
  `).run(refType, refId, status || 'approved');
  const id = r.lastInsertRowid;
  db.prepare(`
    INSERT INTO journal_lines(entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial)
    VALUES (?,?,?,?,?,?,?)
  `).run(id, '5101', 'بهای تمام‌شده', cogsDebit / 10, cogsCredit / 10, cogsDebit, cogsCredit);
  const invSide = cogsDebit > 0
    ? { d: 0, c: cogsDebit }
    : { d: cogsCredit, c: 0 };
  db.prepare(`
    INSERT INTO journal_lines(entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial)
    VALUES (?,?,?,?,?,?,?)
  `).run(id, '1104', 'موجودی', invSide.d / 10, invSide.c / 10, invSide.d, invSide.c);
  return id;
}

function addSale(invId, amountRial) {
  db.prepare(`
    INSERT INTO inventory_ledger(
      product_id, warehouse_id, qty_in, qty_out, amount_rial, unit_cost_rial,
      source_type, source_id, event_type, status, date, tx_no
    ) VALUES (1,1,0,1,?,?, 'invoice', ?, 'sale', 'posted', '1405/07/01', 'T')
  `).run(amountRial, amountRial, invId);
}

console.log('\n══ cogs reconcile include fix vouchers ══\n');

ok(COGS_JE_REF_TYPES.includes('invoice_cogs_fix'), 'ref types include invoice_cogs_fix');
ok(COGS_JE_REF_TYPES.includes('invoice_cogs_reversal'), 'ref types include invoice_cogs_reversal');

// 1) cogs + fix = kardex → diff 0
const inv1 = db.prepare(`
  INSERT INTO invoices(num,date,type,final,warehouse_id,user_id,cust_id,rows,stock_deducted)
  VALUES ('T-FIX1','1405/07/01','final',1000,1,1,1,'[]',1)
`).run().lastInsertRowid;
addJe('invoice_cogs', inv1, 60000, 0);
addJe('invoice_cogs_fix', inv1, 40000, 0);
addSale(inv1, 100000);
ok(cogsPostedForInvoice(db, inv1) === 100000, 'cogs+fix sum = 100000', cogsPostedForInvoice(db, inv1));
ok(cogsVsKardexDiff(db, inv1).diff_rial === 0, 'cogs+fix vs kardex diff 0');
ok(!invoiceCogsDiffs(db).some((r) => r.invoice_id === inv1), 'invoiceCogsDiffs omits matched cogs+fix');

// 2) fix-only (الگوی T-0001) → diff 0
const inv2 = db.prepare(`
  INSERT INTO invoices(num,date,type,final,warehouse_id,user_id,cust_id,rows,stock_deducted)
  VALUES ('T-FIXONLY','1405/07/01','final',1000,1,1,1,'[]',1)
`).run().lastInsertRowid;
addJe('invoice_cogs_fix', inv2, 28000, 0);
addSale(inv2, 28000);
ok(cogsPostedForInvoice(db, inv2) === 28000, 'fix-only posted = 28000');
ok(cogsVsKardexDiff(db, inv2).diff_rial === 0, 'fix-only vs kardex diff 0');
ok(!invoiceCogsDiffs(db).some((r) => r.invoice_id === inv2), 'invoiceCogsDiffs omits fix-only match');

// 3) cogs + reversal + cogs جدید → diff 0
const inv3 = db.prepare(`
  INSERT INTO invoices(num,date,type,final,warehouse_id,user_id,cust_id,rows,stock_deducted)
  VALUES ('T-REV','1405/07/01','final',1000,1,1,1,'[]',1)
`).run().lastInsertRowid;
addJe('invoice_cogs', inv3, 50000, 0);
addJe('invoice_cogs_reversal', inv3, 0, 50000);
addJe('invoice_cogs', inv3, 70000, 0);
addSale(inv3, 70000);
ok(cogsPostedForInvoice(db, inv3) === 70000, 'cogs+reversal+cogs = 70000', cogsPostedForInvoice(db, inv3));
ok(cogsVsKardexDiff(db, inv3).diff_rial === 0, 'reversal path diff 0');

// 4) اختلاف واقعی هنوز گزارش شود
const inv4 = db.prepare(`
  INSERT INTO invoices(num,date,type,final,warehouse_id,user_id,cust_id,rows,stock_deducted)
  VALUES ('T-GAP','1405/07/01','final',1000,1,1,1,'[]',1)
`).run().lastInsertRowid;
addJe('invoice_cogs', inv4, 10000, 0);
addSale(inv4, 90000);
const gap = cogsVsKardexDiff(db, inv4);
ok(gap.diff_rial === 80000, 'real mismatch still reported', gap.diff_rial);
ok(invoiceCogsDiffs(db).some((r) => r.invoice_id === inv4 && r.diff_rial === 80000), 'invoiceCogsDiffs keeps real gap');

// 5) سند void شمرده نشود
const inv5 = db.prepare(`
  INSERT INTO invoices(num,date,type,final,warehouse_id,user_id,cust_id,rows,stock_deducted)
  VALUES ('T-VOID','1405/07/01','final',1000,1,1,1,'[]',1)
`).run().lastInsertRowid;
addJe('invoice_cogs', inv5, 10000, 0, 'void');
addJe('invoice_cogs_fix', inv5, 55000, 0);
addSale(inv5, 55000);
ok(cogsPostedForInvoice(db, inv5) === 55000, 'void cogs ignored; fix counted', cogsPostedForInvoice(db, inv5));
ok(cogsVsKardexDiff(db, inv5).diff_rial === 0, 'void ignored → match');

// 6) الگوی کاذب T-0015: بدون fix اختلاف بزرگ، با fix صفر
const inv15 = db.prepare(`
  INSERT INTO invoices(num,date,type,final,warehouse_id,user_id,cust_id,rows,stock_deducted)
  VALUES ('T-0015','1405/07/01','final',1000,1,1,1,'[]',1)
`).run().lastInsertRowid;
addJe('invoice_cogs', inv15, 137475579, 0);
addJe('invoice_cogs_fix', inv15, 722703927, 0);
addJe('invoice_cogs_fix', inv15, 39732000, 0);
addSale(inv15, 899911506);
ok(cogsPostedForInvoice(db, inv15) === 899911506, 'T-0015-like total with fixes', cogsPostedForInvoice(db, inv15));
ok(cogsVsKardexDiff(db, inv15).diff_rial === 0, 'T-0015-like false gap gone');

db.close();
console.log(fails ? `\nFAIL ${fails}` : '\nPASS');
process.exit(fails ? 1 : 0);
