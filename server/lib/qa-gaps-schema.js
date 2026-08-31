'use strict';
/**
 * QA-ERP remaining product gaps — RFQ, PO, GR, GRNI, three-way match, branches.
 * Called from initDB(); safe to overlay this file on Iran without replacing db.js
 * once the one-line require hook exists.
 */

function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function ensureQaGapsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS rfqs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      num TEXT NOT NULL,
      kind TEXT NOT NULL,
      party_id INTEGER,
      supplier_id INTEGER,
      cust_id INTEGER,
      date TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      branch_id INTEGER,
      rows TEXT NOT NULL DEFAULT '[]',
      note TEXT DEFAULT '',
      created_by INTEGER,
      approved_by INTEGER,
      awarded_at INTEGER,
      journal_id INTEGER,
      status_reason TEXT DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      num TEXT NOT NULL,
      supplier_id INTEGER NOT NULL,
      rfq_id INTEGER,
      date TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      branch_id INTEGER,
      warehouse_id INTEGER,
      rows TEXT NOT NULL DEFAULT '[]',
      note TEXT DEFAULT '',
      created_by INTEGER,
      approved_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS goods_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      num TEXT NOT NULL,
      purchase_order_id INTEGER NOT NULL,
      supplier_id INTEGER,
      date TEXT,
      status TEXT NOT NULL DEFAULT 'posted',
      branch_id INTEGER,
      warehouse_id INTEGER,
      rows TEXT NOT NULL DEFAULT '[]',
      note TEXT DEFAULT '',
      journal_id INTEGER,
      reversal_journal_id INTEGER,
      created_by INTEGER,
      reversed_at INTEGER,
      reversed_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS three_way_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_order_id INTEGER NOT NULL,
      goods_receipt_id INTEGER NOT NULL,
      purchase_invoice_id INTEGER,
      matched INTEGER NOT NULL DEFAULT 0,
      diffs TEXT NOT NULL DEFAULT '[]',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);

  ensureColumn(db, 'users', 'branch_id', 'INTEGER');
  ensureColumn(db, 'orders', 'reservation_id', 'INTEGER');
  ensureColumn(db, 'orders', 'warehouse_id', 'INTEGER');
  ensureColumn(db, 'purchase_invoices', 'goods_receipt_id', 'INTEGER');
  ensureColumn(db, 'purchase_invoices', 'purchase_order_id', 'INTEGER');

  db.prepare("INSERT OR IGNORE INTO branches (id, code, name) VALUES (1, 'HQ', 'دفتر مرکزی')").run();
  db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code) VALUES ('2112','کالای دریافت‌شده فاکتورنشده (GRNI)','liability','2100')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('coa_grni','2112')").run();

  const seqs = ['rfq_sales', 'rfq_purchase', 'purchase_order', 'goods_receipt', 'three_way_match'];
  const ins = db.prepare('INSERT OR IGNORE INTO number_sequences (key, current_value) VALUES (?,0)');
  for (const key of seqs) ins.run(key);
}

module.exports = { ensureQaGapsSchema };
