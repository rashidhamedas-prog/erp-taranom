const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'crm.db');
let db;

function getDB() {
  if (!db) db = new Database(DB_PATH);
  return db;
}

// Add a column only if it does not already exist (safe migration helper)
function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function initDB() {
  const db = getDB();
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'salesperson',
      phone TEXT,
      active INTEGER DEFAULT 1,
      last_login INTEGER,
      commission_cash REAL DEFAULT 0,
      commission_cheque REAL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      biz TEXT NOT NULL,
      owner TEXT,
      city TEXT,
      phone TEXT,
      insta TEXT,
      type TEXT DEFAULT 'بوتیک',
      status TEXT DEFAULT 'new',
      note TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cust_id INTEGER NOT NULL,
      product_id INTEGER,
      date TEXT,
      type TEXT,
      qty INTEGER DEFAULT 0,
      total REAL DEFAULT 0,
      paid REAL DEFAULT 0,
      pay TEXT,
      deliver TEXT,
      status TEXT DEFAULT 'pending',
      note TEXT,
      stock_deducted INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(cust_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS followups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cust_id INTEGER NOT NULL,
      date TEXT,
      time TEXT,
      type TEXT,
      subject TEXT,
      note TEXT,
      action TEXT,
      next_date TEXT,
      status TEXT DEFAULT 'open',
      priority TEXT DEFAULT 'mid',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(cust_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cust_id INTEGER NOT NULL,
      num TEXT,
      type TEXT DEFAULT 'proforma',
      date TEXT,
      note TEXT,
      rows TEXT,
      subtotal REAL DEFAULT 0,
      disc REAL DEFAULT 0,
      disc_amt REAL DEFAULT 0,
      final REAL DEFAULT 0,
      seller_name TEXT,
      seller_phone TEXT,
      converted INTEGER DEFAULT 0,
      pay_type TEXT DEFAULT 'cash',
      cheque_duration TEXT DEFAULT '',
      cheque_due_date TEXT DEFAULT '',
      cheque_info TEXT DEFAULT '',
      stock_deducted INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(cust_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      category TEXT,
      code TEXT,
      name TEXT NOT NULL,
      price REAL DEFAULT 0,
      stock INTEGER DEFAULT 0,
      stock_alert INTEGER DEFAULT 5,
      image TEXT,
      unit TEXT DEFAULT 'عدد',
      note TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS warehouses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS warehouse_moves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      product_id INTEGER NOT NULL,
      from_warehouse_id INTEGER,
      to_warehouse_id INTEGER,
      qty INTEGER NOT NULL,
      date TEXT DEFAULT '',
      note TEXT DEFAULT '',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS consignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,
      party_name TEXT NOT NULL,
      party_phone TEXT DEFAULT '',
      product_id INTEGER NOT NULL,
      qty INTEGER NOT NULL,
      unit_price REAL DEFAULT 0,
      date TEXT DEFAULT '',
      status TEXT DEFAULT 'open',
      note TEXT DEFAULT '',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS payroll_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL,
      period_label TEXT DEFAULT '',
      regular_hours REAL DEFAULT 0,
      overtime_hours REAL DEFAULT 0,
      hourly_rate REAL DEFAULT 0,
      overtime_rate REAL DEFAULT 0,
      bonuses REAL DEFAULT 0,
      deductions REAL DEFAULT 0,
      insurance_deduction REAL DEFAULT 0,
      tax_deduction REAL DEFAULT 0,
      gross_pay REAL DEFAULT 0,
      net_pay REAL DEFAULT 0,
      date TEXT DEFAULT '',
      note TEXT DEFAULT '',
      paid INTEGER DEFAULT 0,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS production_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      qty_produced INTEGER NOT NULL,
      material_cost REAL DEFAULT 0,
      labor_cost REAL DEFAULT 0,
      overhead_cost REAL DEFAULT 0,
      packaging_cost REAL DEFAULT 0,
      waste_qty INTEGER DEFAULT 0,
      waste_cost REAL DEFAULT 0,
      date TEXT DEFAULT '',
      note TEXT DEFAULT '',
      stock_added INTEGER DEFAULT 0,
      cost_updated INTEGER DEFAULT 0,
      previous_cost REAL,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS stock_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      change INTEGER NOT NULL,
      note TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id INTEGER NOT NULL,
      to_id INTEGER,
      body TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(from_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cust_id INTEGER,
      title TEXT NOT NULL,
      body TEXT,
      remind_at TEXT NOT NULL,
      done INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS sms_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cust_id INTEGER,
      phone TEXT,
      body TEXT,
      status TEXT DEFAULT 'pending',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT,
      entity TEXT,
      entity_id INTEGER,
      detail TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cust_id INTEGER NOT NULL,
      invoice_id INTEGER,
      amount REAL DEFAULT 0,
      pay_type TEXT DEFAULT 'cash',
      date TEXT,
      note TEXT,
      cheque_bank TEXT DEFAULT '',
      cheque_sayadi TEXT DEFAULT '',
      cheque_number TEXT DEFAULT '',
      cheque_account TEXT DEFAULT '',
      cheque_amount REAL DEFAULT 0,
      cheque_owner TEXT DEFAULT '',
      cheque_due TEXT DEFAULT '',
      cheque_status TEXT DEFAULT 'pending',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(cust_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      scopes TEXT DEFAULT 'read',
      active INTEGER DEFAULT 1,
      last_used INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS api_usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id INTEGER,
      endpoint TEXT,
      method TEXT,
      status INTEGER,
      ip TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      events TEXT DEFAULT 'customer.created',
      secret TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS customer_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      ref_type TEXT,
      ref_id INTEGER,
      description TEXT,
      debit REAL DEFAULT 0,
      credit REAL DEFAULT 0,
      user_id INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(customer_id) REFERENCES customers(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS chart_of_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      parent_code TEXT,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_date TEXT NOT NULL,
      description TEXT,
      ref_type TEXT,
      ref_id INTEGER,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS journal_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL,
      account_code TEXT NOT NULL,
      account_name TEXT NOT NULL,
      debit REAL DEFAULT 0,
      credit REAL DEFAULT 0,
      description TEXT,
      FOREIGN KEY(entry_id) REFERENCES journal_entries(id)
    );

    CREATE TABLE IF NOT EXISTS incentive_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rep_id INTEGER NOT NULL,
      amount REAL DEFAULT 0,
      pay_type TEXT DEFAULT 'cash',
      date TEXT,
      note TEXT,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(rep_id) REFERENCES users(id)
    );
  `);

  // ---- Safe migrations for databases created by v2 ----
  ensureColumn(db, 'users', 'phone', 'TEXT');
  ensureColumn(db, 'users', 'last_login', 'INTEGER');
  ensureColumn(db, 'users', 'commission_cash', 'REAL DEFAULT 0');
  ensureColumn(db, 'users', 'commission_cheque', 'REAL DEFAULT 0');
  ensureColumn(db, 'products', 'image', 'TEXT');
  ensureColumn(db, 'products', 'unit', "TEXT DEFAULT 'عدد'");
  ensureColumn(db, 'products', 'note', 'TEXT');
  ensureColumn(db, 'products', 'stock_alert', 'INTEGER DEFAULT 5');
  ensureColumn(db, 'followups', 'time', 'TEXT');
  ensureColumn(db, 'invoices', 'seller_name', 'TEXT');
  ensureColumn(db, 'invoices', 'seller_phone', 'TEXT');
  ensureColumn(db, 'invoices', 'converted', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'invoices', 'pay_type', "TEXT DEFAULT 'cash'");
  ensureColumn(db, 'invoices', 'cheque_duration', "TEXT DEFAULT ''");
  ensureColumn(db, 'invoices', 'cheque_due_date', "TEXT DEFAULT ''");
  ensureColumn(db, 'invoices', 'cheque_info', "TEXT DEFAULT ''");
  ensureColumn(db, 'invoices', 'stock_deducted', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'invoices', 'approved', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'invoices', 'approved_at', 'INTEGER');
  ensureColumn(db, 'invoices', 'approved_by', 'INTEGER');
  ensureColumn(db, 'orders', 'product_id', 'INTEGER');
  ensureColumn(db, 'orders', 'stock_deducted', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'settlements', 'cheque_bank', "TEXT DEFAULT ''");
  ensureColumn(db, 'settlements', 'cheque_sayadi', "TEXT DEFAULT ''");
  ensureColumn(db, 'settlements', 'cheque_number', "TEXT DEFAULT ''");
  ensureColumn(db, 'settlements', 'cheque_account', "TEXT DEFAULT ''");
  ensureColumn(db, 'settlements', 'cheque_amount', 'REAL DEFAULT 0');
  ensureColumn(db, 'settlements', 'cheque_owner', "TEXT DEFAULT ''");
  ensureColumn(db, 'settlements', 'cheque_due', "TEXT DEFAULT ''");
  ensureColumn(db, 'settlements', 'cheque_status', "TEXT DEFAULT 'pending'");
  // Followup CRM pipeline fields
  ensureColumn(db, 'followups', 'interest_level', "TEXT DEFAULT 'mid'");
  ensureColumn(db, 'followups', 'purchase_prob', 'INTEGER DEFAULT 50');
  ensureColumn(db, 'followups', 'pipeline_stage', "TEXT DEFAULT 'lead'");
  ensureColumn(db, 'followups', 'tags', "TEXT DEFAULT ''");
  ensureColumn(db, 'followups', 'lost_reason', "TEXT DEFAULT ''");
  ensureColumn(db, 'followups', 'assigned_to', 'INTEGER');
  // Follow-up scheduled time for timed SMS reminders
  ensureColumn(db, 'followups', 'next_time', "TEXT DEFAULT ''");
  ensureColumn(db, 'followups', 'sms_sent', 'INTEGER DEFAULT 0');
  // Customer CRM fields
  ensureColumn(db, 'customers', 'source', "TEXT DEFAULT ''");
  // Customer account balance (admin-only, applied as initial credit/debit)
  ensureColumn(db, 'customers', 'balance', 'REAL DEFAULT 0');
  // Salesperson role migration: generic 'salesperson' → 'field_sales'
  db.exec("UPDATE users SET role='field_sales' WHERE role='salesperson'");
  // update_crm.md Phase 3 migrations
  ensureColumn(db, 'customers', 'province', "TEXT DEFAULT ''");
  ensureColumn(db, 'customers', 'address', "TEXT DEFAULT ''");
  ensureColumn(db, 'customers', 'assigned_to', 'INTEGER');
  ensureColumn(db, 'products', 'colors', 'INTEGER DEFAULT 1');
  ensureColumn(db, 'products', 'pack_size', 'INTEGER DEFAULT 1');
  // Unit cost (production/purchase) — basis for Cost of Goods Sold in the P&L
  ensureColumn(db, 'products', 'cost', 'REAL DEFAULT 0');
  // Internal message image attachment (filename under uploads/messages)
  ensureColumn(db, 'messages', 'image', 'TEXT');
  // Accounting module: sales incentive lock
  ensureColumn(db, 'users', 'incentive_locked', 'INTEGER DEFAULT 0');
  // Per-customer automatic follow-up on invoice (default on)
  ensureColumn(db, 'customers', 'auto_followup', 'INTEGER DEFAULT 1');

  // ---- ERP expansion: customer groups (account nature), suppliers, purchasing, returns, cost centers ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      nature TEXT NOT NULL DEFAULT 'debit',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      note TEXT DEFAULT '',
      balance REAL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS purchase_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      supplier_id INTEGER NOT NULL,
      num TEXT,
      date TEXT,
      note TEXT,
      rows TEXT,
      subtotal REAL DEFAULT 0,
      disc REAL DEFAULT 0,
      disc_amt REAL DEFAULT 0,
      final REAL DEFAULT 0,
      pay_type TEXT DEFAULT 'credit',
      cheque_duration TEXT DEFAULT '',
      cheque_due_date TEXT DEFAULT '',
      cheque_info TEXT DEFAULT '',
      stock_added INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(supplier_id) REFERENCES suppliers(id)
    );

    CREATE TABLE IF NOT EXISTS purchase_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      supplier_id INTEGER NOT NULL,
      purchase_invoice_id INTEGER,
      date TEXT,
      note TEXT,
      rows TEXT,
      amount REAL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(supplier_id) REFERENCES suppliers(id)
    );

    CREATE TABLE IF NOT EXISTS sales_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cust_id INTEGER NOT NULL,
      invoice_id INTEGER,
      date TEXT,
      note TEXT,
      rows TEXT,
      amount REAL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(cust_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS supplier_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      ref_type TEXT,
      ref_id INTEGER,
      description TEXT,
      debit REAL DEFAULT 0,
      credit REAL DEFAULT 0,
      user_id INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(supplier_id) REFERENCES suppliers(id)
    );

    CREATE TABLE IF NOT EXISTS supplier_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL,
      purchase_invoice_id INTEGER,
      amount REAL DEFAULT 0,
      pay_type TEXT DEFAULT 'cash',
      date TEXT,
      note TEXT,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(supplier_id) REFERENCES suppliers(id)
    );

    CREATE TABLE IF NOT EXISTS cost_centers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT,
      name TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS banks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      account_number TEXT DEFAULT '',
      branch TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS check_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      serial_from TEXT DEFAULT '',
      serial_to TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(bank_id) REFERENCES banks(id)
    );

    CREATE TABLE IF NOT EXISTS cash_boxes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      custodian TEXT DEFAULT '',
      is_petty_cash INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS trust_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,
      party_name TEXT NOT NULL,
      party_phone TEXT DEFAULT '',
      bank_name TEXT DEFAULT '',
      sayadi TEXT DEFAULT '',
      cheque_number TEXT DEFAULT '',
      account_number TEXT DEFAULT '',
      amount REAL NOT NULL,
      owner_name TEXT DEFAULT '',
      due_date TEXT DEFAULT '',
      status TEXT DEFAULT 'held',
      note TEXT DEFAULT '',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS account_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      from_type TEXT NOT NULL,
      from_id INTEGER,
      to_type TEXT NOT NULL,
      to_id INTEGER,
      amount REAL NOT NULL,
      note TEXT DEFAULT '',
      user_id INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS person_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      nature TEXT NOT NULL DEFAULT 'debit',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS persons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      note TEXT DEFAULT '',
      credit_limit REAL DEFAULT 0,
      debit_limit REAL DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(category_id) REFERENCES person_categories(id)
    );

    CREATE TABLE IF NOT EXISTS person_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      ref_type TEXT,
      ref_id INTEGER,
      description TEXT,
      debit REAL DEFAULT 0,
      credit REAL DEFAULT 0,
      user_id INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(person_id) REFERENCES persons(id)
    );

    CREATE TABLE IF NOT EXISTS journal_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      lines_json TEXT NOT NULL,
      cost_center_id INTEGER,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS voucher_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT DEFAULT '',
      description TEXT DEFAULT '',
      lines_json TEXT NOT NULL,
      cost_center_id INTEGER,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS expense_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL DEFAULT 'admin',
      title TEXT DEFAULT '',
      amount REAL NOT NULL,
      pay_type TEXT DEFAULT 'cash',
      bank_id INTEGER,
      cash_box_id INTEGER,
      check_category_id INTEGER,
      cost_center_id INTEGER,
      date TEXT NOT NULL,
      note TEXT DEFAULT '',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);
  ensureColumn(db, 'customers', 'group_id', 'INTEGER');
  ensureColumn(db, 'journal_entries', 'cost_center_id', 'INTEGER');
  ensureColumn(db, 'settlements', 'cost_center_id', 'INTEGER');
  // Unrestricted bank management — every settlement/payment can be tied to a specific
  // bank ledger account, and (for cheques we ourselves issue) a specific checkbook.
  ensureColumn(db, 'settlements', 'bank_id', 'INTEGER');
  ensureColumn(db, 'purchase_invoices', 'bank_id', 'INTEGER');
  ensureColumn(db, 'purchase_invoices', 'check_category_id', 'INTEGER');
  ensureColumn(db, 'supplier_payments', 'bank_id', 'INTEGER');
  ensureColumn(db, 'supplier_payments', 'check_category_id', 'INTEGER');
  ensureColumn(db, 'incentive_payments', 'bank_id', 'INTEGER');
  ensureColumn(db, 'incentive_payments', 'check_category_id', 'INTEGER');
  // Unrestricted cash-box management — mirrors banks: every payment/receipt can
  // optionally be tied to a specific cash box's own ledger sub-account.
  ensureColumn(db, 'settlements', 'cash_box_id', 'INTEGER');
  ensureColumn(db, 'purchase_invoices', 'cash_box_id', 'INTEGER');
  ensureColumn(db, 'supplier_payments', 'cash_box_id', 'INTEGER');
  ensureColumn(db, 'incentive_payments', 'cash_box_id', 'INTEGER');
  // Manual journal voucher expansion: optional single attachment per entry.
  ensureColumn(db, 'journal_entries', 'attachment', 'TEXT');
  // Petty cash: any existing cash box can be flagged as a custodian-managed
  // petty cash fund (تنخواه‌گردان) — reuses the cash box's own ledger account.
  ensureColumn(db, 'cash_boxes', 'is_petty_cash', 'INTEGER');
  // Warehouses: each product belongs to one primary warehouse. products.stock
  // stays the single source of truth for total quantity (untouched by every
  // existing invoice/purchase/return code path); warehouse_id is purely a
  // location tag, and warehouse_moves records receipt/issue/transfer history.
  ensureColumn(db, 'products', 'warehouse_id', 'INTEGER');
  const whCount = db.prepare('SELECT COUNT(*) c FROM warehouses').get().c;
  if (whCount === 0) {
    const mainWhId = db.prepare("INSERT INTO warehouses (name,address) VALUES ('انبار مرکزی','')").run().lastInsertRowid;
    db.prepare('UPDATE products SET warehouse_id=? WHERE warehouse_id IS NULL').run(mainWhId);
  }

  // Seed a default customer group (Debit nature — the standard for receivables)
  const grpCount = db.prepare('SELECT COUNT(*) c FROM customer_groups').get().c;
  if (grpCount === 0) {
    db.prepare("INSERT INTO customer_groups (name,nature) VALUES ('مشتریان عمومی','debit')").run();
  }

  // Seed default person categories for the general Persons module (employees,
  // partners, investors, ... — anyone who isn't already a customer/supplier)
  const personCatCount = db.prepare('SELECT COUNT(*) c FROM person_categories').get().c;
  if (personCatCount === 0) {
    const insPC = db.prepare('INSERT INTO person_categories (name,nature) VALUES (?,?)');
    insPC.run('کارمند', 'credit');
    insPC.run('شریک', 'credit');
    insPC.run('سرمایه‌گذار', 'credit');
    insPC.run('پیمانکار', 'credit');
    insPC.run('ارائه‌دهنده خدمات', 'credit');
    insPC.run('سایر', 'debit');
  }

  // ---- Seed chart of accounts (only if empty) ----
  const coaCount = db.prepare('SELECT COUNT(*) c FROM chart_of_accounts').get().c;
  if (coaCount === 0) {
    const insCoA = db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code) VALUES (?,?,?,?)');
    const seedCoA = db.transaction(() => {
      const accounts = [
        ['1000','دارایی‌ها','asset',null],
        ['1100','دارایی‌های جاری','asset','1000'],
        ['1101','موجودی صندوق','asset','1100'],
        ['1102','موجودی بانک','asset','1100'],
        ['1103','حساب‌های دریافتنی از مشتریان','asset','1100'],
        ['1104','موجودی کالا','asset','1100'],
        ['1105','پیش‌پرداخت‌ها','asset','1100'],
        ['1106','حساب اشخاص متفرقه','asset','1100'],
        ['2000','بدهی‌ها','liability',null],
        ['2100','بدهی‌های جاری','liability','2000'],
        ['2101','حساب‌های پرداختنی','liability','2100'],
        ['2102','پیش‌دریافت از مشتریان','liability','2100'],
        ['2104','بدهی بیمه و مالیات کارکنان','liability','2100'],
        ['3000','حقوق صاحبان سرمایه','equity',null],
        ['3101','سرمایه','equity','3000'],
        ['4000','درآمدها','revenue',null],
        ['4101','درآمد فروش کالا','revenue','4000'],
        ['4102','برگشت از فروش','revenue','4000'],
        ['4103','تخفیفات فروش','revenue','4000'],
        ['5000','بهای تمام‌شده کالای فروش رفته','cogs',null],
        ['6000','هزینه‌ها','expense',null],
        ['6101','هزینه انگیزه فروش','expense','6000'],
        ['6102','هزینه‌های عمومی و اداری','expense','6000'],
        ['6103','هزینه‌های توزیع و فروش','expense','6000'],
      ];
      for (const [code,name,type,parent] of accounts) insCoA.run(code,name,type,parent);
    });
    seedCoA();
  }
  // Added after the initial seed (Persons module) — insert unconditionally so
  // existing databases that already had a non-empty chart of accounts still
  // get this control account.
  db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code) VALUES ('1106','حساب اشخاص متفرقه','asset','1100')").run();
  // Added for the Payroll module (Phase 9) — same unconditional-insert pattern.
  db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code) VALUES ('6104','هزینه حقوق و دستمزد','expense','6000')").run();
  db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code) VALUES ('2104','بدهی بیمه و مالیات کارکنان','liability','2100')").run();

  // ---- Indexes ----
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_customers_user ON customers(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_cust ON orders(cust_id);
    CREATE INDEX IF NOT EXISTS idx_followups_user ON followups(user_id);
    CREATE INDEX IF NOT EXISTS idx_followups_cust ON followups(cust_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_cust ON invoices(cust_id);
    CREATE INDEX IF NOT EXISTS idx_products_cat ON products(category);
    CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity);
    CREATE INDEX IF NOT EXISTS idx_api_usage ON api_usage_log(api_key_id);
    CREATE INDEX IF NOT EXISTS idx_followups_next ON followups(next_date);
    CREATE INDEX IF NOT EXISTS idx_ledger_customer ON customer_ledger(customer_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_ref ON customer_ledger(ref_type,ref_id);
    CREATE INDEX IF NOT EXISTS idx_journal_ref ON journal_entries(ref_type,ref_id);
    CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(entry_id);
    CREATE INDEX IF NOT EXISTS idx_settlements_cust ON settlements(cust_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_type ON invoices(type);
    CREATE INDEX IF NOT EXISTS idx_incentive_rep ON incentive_payments(rep_id);
    CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_code);
    CREATE INDEX IF NOT EXISTS idx_supplier_ledger_supplier ON supplier_ledger(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_invoices_supplier ON purchase_invoices(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_returns_supplier ON purchase_returns(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_sales_returns_cust ON sales_returns(cust_id);
    CREATE INDEX IF NOT EXISTS idx_customers_group ON customers(group_id);
    CREATE INDEX IF NOT EXISTS idx_check_categories_bank ON check_categories(bank_id);
    CREATE INDEX IF NOT EXISTS idx_settlements_bank ON settlements(bank_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_invoices_bank ON purchase_invoices(bank_id);
    CREATE INDEX IF NOT EXISTS idx_supplier_payments_bank ON supplier_payments(bank_id);
    CREATE INDEX IF NOT EXISTS idx_incentive_payments_bank ON incentive_payments(bank_id);
  `);

  // ---- Default admin ----
  const admin = db.prepare('SELECT id FROM users WHERE username=?').get('admin');
  if (!admin) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (name,username,password,role) VALUES (?,?,?,?)')
      .run('حامد رشید', 'admin', hash, 'admin');
    console.log('✅ ادمین پیش‌فرض ساخته شد (admin / admin123)');
  }

  // ---- Default settings ----
  const defaults = {
    company_name: 'پوشاک ترنم',
    company_address: 'مشهد',
    company_phone: '',
    telegram_bot_token: '',
    telegram_chat_id: '',
    sms_provider: 'kavenegar',
    sms_api_key: '',
    sms_from: '',
    api_v1_enabled: '1',
    api_rate_limit: '100',
    webhook_secret: '',
    backup_smtp_user: '',
    backup_smtp_pass: '',
    backup_email: ''
  };
  const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
  for (const [k, v] of Object.entries(defaults)) insSetting.run(k, v);

  // ---- Backfill accounting entries for operations recorded before the engine existed ----
  backfillAccounting(db);

  console.log('✅ دیتابیس آماده شد');
}

// Retroactively generate customer-ledger + journal entries for every invoice, settlement,
// and opening balance that predates the accounting engine. Idempotent: each entry is only
// created if a matching (ref_type, ref_id) record does not already exist, so it never
// duplicates entries the live engine already produced. Runs once, then sets a flag.
function backfillAccounting(db) {
  try {
    const flag = db.prepare("SELECT value FROM settings WHERE key='accounting_backfill_v1'").get();
    if (flag && flag.value === '1') return;

    const invHasLedger  = db.prepare("SELECT 1 FROM customer_ledger  WHERE ref_type='invoice'    AND ref_id=? LIMIT 1");
    const invHasJournal = db.prepare("SELECT 1 FROM journal_entries  WHERE ref_type='invoice'    AND ref_id=? LIMIT 1");
    const settHasLedger = db.prepare("SELECT 1 FROM customer_ledger  WHERE ref_type='settlement' AND ref_id=? LIMIT 1");
    const settHasJournal= db.prepare("SELECT 1 FROM journal_entries  WHERE ref_type='settlement' AND ref_id=? LIMIT 1");
    const custHasOpening= db.prepare("SELECT 1 FROM customer_ledger  WHERE ref_type='opening'    AND ref_id=? LIMIT 1");
    let created = 0;

    const tx = db.transaction(() => {
      // 1) Opening balances — the admin-set customers.balance becomes the ledger's opening line
      const custs = db.prepare('SELECT id,balance,created_at FROM customers WHERE balance IS NOT NULL AND balance<>0').all();
      const insOpening = db.prepare(
        'INSERT INTO customer_ledger (customer_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
      );
      for (const c of custs) {
        if (custHasOpening.get(c.id)) continue;
        const debit = c.balance > 0 ? c.balance : 0;
        const credit = c.balance < 0 ? -c.balance : 0;
        // use the customer's own created_at so the opening line always sorts first in the statement
        insOpening.run(c.id, '', 'opening', 'opening', c.id, 'مانده اولیه حساب', debit, credit, null, (c.created_at || 1));
        created++;
      }

      // 2) Final invoices + settlements, inserted in chronological (date) order for a readable statement
      const events = [];
      for (const inv of db.prepare("SELECT * FROM invoices WHERE type='final'").all()) events.push({ date: inv.date || '', kind: 'invoice', row: inv });
      for (const s of db.prepare('SELECT * FROM settlements').all()) events.push({ date: s.date || '', kind: 'settlement', row: s });
      events.sort((a, b) => String(a.date).localeCompare(String(b.date)));

      for (const ev of events) {
        if (ev.kind === 'invoice') {
          const inv = ev.row;
          if (!invHasLedger.get(inv.id)) {
            createLedgerEntry(db, {
              customer_id: inv.cust_id, date: inv.date || '', entry_type: 'invoice',
              ref_type: 'invoice', ref_id: inv.id, description: `فاکتور رسمی ${inv.num}`,
              debit: inv.final, credit: 0, user_id: inv.user_id
            });
            created++;
          }
          if (!invHasJournal.get(inv.id)) {
            const lines = [{ code: '1103', name: 'حساب‌های دریافتنی از مشتریان', debit: inv.final, credit: 0 }];
            if ((inv.disc_amt || 0) > 0) lines.push({ code: '4103', name: 'تخفیفات فروش', debit: inv.disc_amt, credit: 0, description: 'تخفیف فاکتور' });
            lines.push({ code: '4101', name: 'درآمد فروش کالا', debit: 0, credit: inv.subtotal });
            createJournalEntry(db, { date: inv.date || '', description: `فاکتور رسمی ${inv.num}`, ref_type: 'invoice', ref_id: inv.id, created_by: inv.user_id, lines });
          }
        } else {
          const s = ev.row;
          const payLabel = s.pay_type === 'cheque' ? 'چک' : 'نقد';
          if (!settHasLedger.get(s.id)) {
            createLedgerEntry(db, {
              customer_id: s.cust_id, date: s.date || '', entry_type: 'settlement',
              ref_type: 'settlement', ref_id: s.id,
              description: `تسویه ${payLabel} - ${Number(s.amount || 0).toLocaleString('fa-IR')} تومان`,
              debit: 0, credit: s.amount, user_id: s.user_id
            });
            created++;
          }
          if (!settHasJournal.get(s.id)) {
            const cashCode = s.pay_type === 'cheque' ? '1102' : '1101';
            const cashName = s.pay_type === 'cheque' ? 'موجودی بانک' : 'موجودی صندوق';
            createJournalEntry(db, {
              date: s.date || '', description: `تسویه ${payLabel} مشتری`,
              ref_type: 'settlement', ref_id: s.id, created_by: s.user_id,
              lines: [
                { code: cashCode, name: cashName, debit: s.amount, credit: 0 },
                { code: '1103', name: 'حساب‌های دریافتنی از مشتریان', debit: 0, credit: s.amount }
              ]
            });
          }
        }
      }
    });
    tx();

    db.prepare("INSERT INTO settings (key,value) VALUES ('accounting_backfill_v1','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    console.log(`✅ حسابداری عملیات گذشته بازسازی شد (${created} ردیف جدید)`);
  } catch (e) {
    console.error('backfill accounting error:', e.message);
  }
}

// Helper used across routes to record audit entries
function audit(userId, action, entity, entityId, detail) {
  try {
    getDB().prepare('INSERT INTO audit_log (user_id,action,entity,entity_id,detail) VALUES (?,?,?,?,?)')
      .run(userId || null, action, entity, entityId || null, detail || '');
  } catch (e) { /* never let audit failures break a request */ }
}

// Create a customer ledger entry (debit = customer owes us, credit = customer paid)
// created_at may be passed explicitly (e.g. the customer's own created_at) so an
// opening-balance line always sorts first in the statement instead of using "now".
function createLedgerEntry(db, { customer_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id, created_at }) {
  try {
    if (created_at) {
      db.prepare('INSERT INTO customer_ledger (customer_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(customer_id, date || '', entry_type, ref_type || '', ref_id || null, description || '', debit || 0, credit || 0, user_id || null, created_at);
    } else {
      db.prepare('INSERT INTO customer_ledger (customer_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(customer_id, date || '', entry_type, ref_type || '', ref_id || null, description || '', debit || 0, credit || 0, user_id || null);
    }
  } catch (e) { console.error('ledger entry error:', e.message); }
}

// Create a person ledger entry (debit = person owes us, credit = we owe person)
// — used by the Persons module and by manual journal vouchers that post
// against a specific person instead of a raw chart-of-accounts code.
function createPersonLedgerEntry(db, { person_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id }) {
  try {
    db.prepare('INSERT INTO person_ledger (person_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(person_id, date || '', entry_type, ref_type || '', ref_id || null, description || '', debit || 0, credit || 0, user_id || null);
  } catch (e) { console.error('person ledger entry error:', e.message); }
}

// Create a double-entry journal entry with lines [{code, name, debit, credit, description}]
function createJournalEntry(db, { date, description, ref_type, ref_id, created_by, lines }) {
  try {
    const entry = db.prepare('INSERT INTO journal_entries (entry_date,description,ref_type,ref_id,created_by) VALUES (?,?,?,?,?)')
      .run(date || '', description || '', ref_type || '', ref_id || null, created_by || null);
    const entryId = entry.lastInsertRowid;
    const lineStmt = db.prepare('INSERT INTO journal_lines (entry_id,account_code,account_name,debit,credit,description) VALUES (?,?,?,?,?,?)');
    for (const line of (lines || [])) {
      lineStmt.run(entryId, line.code, line.name, line.debit || 0, line.credit || 0, line.description || '');
    }
    return entryId;
  } catch (e) { console.error('journal entry error:', e.message); }
}

// Resolve which ledger account a cash/cheque payment posts against.
// If a specific bank is chosen, use that bank's own sub-account (created by
// syncBankAccount below) so each bank reconciles independently; if a specific
// cash box is chosen, use its own sub-account (syncCashBoxAccount) the same
// way; otherwise fall back to the generic صندوق/بانک buckets — fully
// backward-compatible with records created before banks/cash boxes existed.
function resolveCashAccount(db, payType, bankId, cashBoxId) {
  if (bankId) {
    const bank = db.prepare('SELECT * FROM banks WHERE id=?').get(bankId);
    if (bank) return { code: '1102-' + bank.id, name: bank.name };
  }
  if (cashBoxId) {
    const box = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(cashBoxId);
    if (box) return { code: '1101-' + box.id, name: box.name };
  }
  // 'cheque' and 'bank' (e.g. card-to-card / wire transfer) both fall back to the
  // generic bank bucket when no specific bank was chosen; only true cash uses صندوق
  if (payType === 'cheque' || payType === 'bank') return { code: '1102', name: 'موجودی بانک' };
  return { code: '1101', name: 'موجودی صندوق' };
}

// Create/update the chart-of-accounts sub-ledger row that represents a bank,
// so every bank is a first-class, fully unrestricted ledger account nested
// under 1102 (موجودی بانک) — reportable in General Ledger / Trial Balance /
// Balance Sheet exactly like any other account.
function syncBankAccount(db, bank) {
  try {
    db.prepare(`
      INSERT INTO chart_of_accounts (code,name,type,parent_code) VALUES (?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET name=excluded.name
    `).run('1102-' + bank.id, bank.name, 'asset', '1102');
  } catch (e) { console.error('bank ledger sync error:', e.message); }
}

// Same as syncBankAccount but for cash boxes, nested under 1101 (موجودی صندوق).
function syncCashBoxAccount(db, box) {
  try {
    db.prepare(`
      INSERT INTO chart_of_accounts (code,name,type,parent_code) VALUES (?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET name=excluded.name
    `).run('1101-' + box.id, box.name, 'asset', '1101');
  } catch (e) { console.error('cash box ledger sync error:', e.message); }
}

module.exports = {
  getDB, initDB, audit, createLedgerEntry, createPersonLedgerEntry, createJournalEntry, backfillAccounting,
  resolveCashAccount, syncBankAccount, syncCashBoxAccount
};
