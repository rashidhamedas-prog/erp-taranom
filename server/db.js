const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

// DB_PATH is env-overridable so device builds (desktop/mobile) can keep their
// local database in a per-user writable directory instead of the app folder.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'crm.db');
let db;

// SYNC_ROLE: 'central' (the one authoritative server — default) or 'device'
// (an embedded offline-first instance inside the desktop/mobile app).
// Device instances write locally-first and sync via the sync engine; several
// central-only behaviors (cron, SMS, backups, settings/user management,
// invoice-number allocation) are gated on this.
const SYNC_ROLE = process.env.SYNC_ROLE === 'device' ? 'device' : 'central';
function isDevice() { return SYNC_ROLE === 'device'; }

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

function tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function tableColumns(db, table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); }
  catch { return []; }
}

// Legacy DBs may have partial warehouse/category tables without an id column —
// CREATE TABLE IF NOT EXISTS won't fix them, and later migrations crash on boot.
function repairWarehousesSchema(db) {
  if (!tableExists(db, 'warehouses')) return;
  const cols = tableColumns(db, 'warehouses');
  if (cols.includes('id')) return;
  console.warn('⚠️ repairing warehouses table (missing id column)');
  try {
    db.pragma('foreign_keys = OFF');
    const hasName = cols.includes('name');
    const addrExpr = cols.includes('address') ? 'address' : "''";
    db.exec(`
      CREATE TABLE warehouses__fix (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        address TEXT DEFAULT '',
        active INTEGER DEFAULT 1,
        created_at INTEGER DEFAULT (strftime('%s','now'))
      )`);
    if (hasName) {
      db.exec(`INSERT INTO warehouses__fix (name, address) SELECT name, ${addrExpr} FROM warehouses`);
    }
    db.exec('DROP TABLE warehouses');
    db.exec('ALTER TABLE warehouses__fix RENAME TO warehouses');
    db.pragma('foreign_keys = ON');
  } catch (e) {
    db.pragma('foreign_keys = ON');
    console.error('⚠️ warehouse schema repair failed:', e.message);
  }
}

function repairProductCategoriesSchema(db) {
  if (!tableExists(db, 'product_categories')) return;
  const cols = tableColumns(db, 'product_categories');
  if (cols.includes('id')) return;
  console.warn('⚠️ repairing product_categories table (missing id column)');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE product_categories__fix (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`);
  if (cols.includes('name')) {
    db.exec('INSERT OR IGNORE INTO product_categories__fix (name) SELECT name FROM product_categories');
  }
  db.exec('DROP TABLE product_categories');
  db.exec('ALTER TABLE product_categories__fix RENAME TO product_categories');
  db.pragma('foreign_keys = ON');
}

// Sync triggers must match each table's real primary/business key — not every
// syncable table has an `id` column (e.g. warehouse_stock, legacy settings).
function syncTriggerMatch(t, db) {
  if (t.name === 'warehouse_stock') {
    return {
      updateWhere: 'product_id = NEW.product_id AND warehouse_id = NEW.warehouse_id',
      tombstone: "CAST(OLD.product_id AS TEXT) || ':' || CAST(OLD.warehouse_id AS TEXT)"
    };
  }
  const cols = tableColumns(db, t.name);
  const key = (t.upsertKey && cols.includes(t.upsertKey)) ? t.upsertKey
    : cols.includes('id') ? 'id' : null;
  if (!key) return null;
  return { updateWhere: `${key} = NEW.${key}`, tombstone: `OLD.${key}` };
}

function seedWarehouseStock(db) {
  if (!tableExists(db, 'warehouse_stock') || !tableExists(db, 'products')) return;
  const pCols = tableColumns(db, 'products');
  if (!pCols.includes('id')) return;
  const wCols = tableColumns(db, 'warehouses');
  let defaultWh = null;
  if (tableExists(db, 'warehouses') && wCols.includes('id')) {
    defaultWh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get()?.id ?? null;
  }
  const ins = db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?, ?, ?)');
  const products = db.prepare('SELECT id, warehouse_id, stock FROM products').all();
  let n = 0;
  for (const p of products) {
    const whId = p.warehouse_id || defaultWh;
    if (!whId) continue;
    ins.run(p.id, whId, p.stock || 0);
    n++;
  }
  if (n) console.log(`✅ warehouse_stock: ${n} ردیف`);
}

function initDB() {
  const db = getDB();
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000');
  db.pragma('temp_store = MEMORY');
  try { db.pragma('mmap_size = 268435456'); } catch { /* optional */ }
  db.exec(`
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

    CREATE TABLE IF NOT EXISTS product_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS warehouse_stock (
      product_id INTEGER NOT NULL,
      warehouse_id INTEGER NOT NULL,
      qty INTEGER DEFAULT 0,
      PRIMARY KEY (product_id, warehouse_id),
      FOREIGN KEY(product_id) REFERENCES products(id),
      FOREIGN KEY(warehouse_id) REFERENCES warehouses(id)
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
  // Farankenou payroll + employee payroll defaults on persons
  ensureColumn(db, 'persons', 'employee_no', 'TEXT');
  ensureColumn(db, 'persons', 'card_no', 'TEXT');
  ensureColumn(db, 'persons', 'hourly_rate', 'REAL DEFAULT 0');
  ensureColumn(db, 'persons', 'overtime_rate', 'REAL DEFAULT 0');
  ensureColumn(db, 'persons', 'insurance_percent', 'REAL DEFAULT 0');
  ensureColumn(db, 'persons', 'tax_percent', 'REAL DEFAULT 0');
  ensureColumn(db, 'expense_payments', 'account_code', 'TEXT');
  ensureColumn(db, 'expense_payments', 'purchase_invoice_id', 'INTEGER');
  ensureColumn(db, 'expense_payments', 'is_overhead', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'settlements', 'installment_group', 'TEXT');
  ensureColumn(db, 'production_runs', 'warehouse_id', 'INTEGER');
  ensureColumn(db, 'products', 'category_id', 'INTEGER');
  repairWarehousesSchema(db);
  repairProductCategoriesSchema(db);
  const whCount = db.prepare('SELECT COUNT(*) c FROM warehouses').get().c;
  if (whCount === 0) {
    const mainWhId = db.prepare("INSERT INTO warehouses (name,address) VALUES ('انبار مرکزی','')").run().lastInsertRowid;
    db.prepare('UPDATE products SET warehouse_id=? WHERE warehouse_id IS NULL').run(mainWhId);
  }

  // Migrate free-text product.category → product_categories + category_id
  try {
    const distinctCats = db.prepare("SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category<>''").all();
    const insCat = db.prepare('INSERT OR IGNORE INTO product_categories (name) VALUES (?)');
    for (const { category } of distinctCats) insCat.run(category);
    db.prepare(`
      UPDATE products SET category_id=(
        SELECT id FROM product_categories WHERE name=products.category LIMIT 1
      ) WHERE category_id IS NULL AND category IS NOT NULL AND category<>''
    `).run();
  } catch (e) {
    console.warn('⚠️ product category migration skipped:', e.message);
  }

  // Seed warehouse_stock from products (safe JS loop — legacy warehouses may lack id)
  seedWarehouseStock(db);

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
    CREATE INDEX IF NOT EXISTS idx_settlements_invoice ON settlements(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_journal_entries_date ON journal_entries(entry_date);
    CREATE INDEX IF NOT EXISTS idx_products_warehouse ON products(warehouse_id);
    CREATE INDEX IF NOT EXISTS idx_warehouse_stock_wh ON warehouse_stock(warehouse_id);
    CREATE INDEX IF NOT EXISTS idx_stock_logs_product ON stock_logs(product_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_created ON invoices(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_invoices_commission ON invoices(user_id, type, approved, pay_type);
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
    backup_email: '',
    overhead_method: 'tag',
    overhead_fixed_rate: '0',
    overhead_period_production_qty: '0'
  };
  const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
  for (const [k, v] of Object.entries(defaults)) insSetting.run(k, v);

  // ---- Atomic business-number sequences (invoice/purchase) ----
  // Replaces the old COUNT(*)+1 numbering, which reused numbers after
  // deletions and collides across offline sync devices. Seeded once from the
  // highest numeric suffix already present so existing numbering continues.
  db.exec(`CREATE TABLE IF NOT EXISTS number_sequences (
    key TEXT PRIMARY KEY,
    current_value INTEGER NOT NULL DEFAULT 0
  )`);
  const seedSeq = (key, table) => {
    if (db.prepare('SELECT 1 FROM number_sequences WHERE key=?').get(key)) return;
    let max = 0;
    for (const r of db.prepare(`SELECT num FROM ${table} WHERE num IS NOT NULL`).all()) {
      const m = String(r.num).match(/(\d+)\s*$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    db.prepare('INSERT INTO number_sequences (key,current_value) VALUES (?,?)').run(key, max);
  };
  seedSeq('invoice', 'invoices');
  seedSeq('purchase', 'purchase_invoices');
  // Backstop: business numbers must be unique. A legacy database can contain
  // historical duplicates from the COUNT(*)-based numbering; in that case the
  // index is skipped (logged) and only the atomic sequence protects new rows.
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_num_unique ON invoices(num)'); }
  catch (e) { console.warn('⚠️ ایندکس یکتای شماره فاکتور ایجاد نشد (شماره تکراری قدیمی در داده‌ها):', e.message); }
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_num_unique ON purchase_invoices(num)'); }
  catch (e) { console.warn('⚠️ ایندکس یکتای شماره فاکتور خرید ایجاد نشد:', e.message); }

  // ---- Sync engine schema (offline-first desktop/mobile devices) ----
  initSyncSchema(db);

  // ---- Backfill accounting entries for operations recorded before the engine existed ----
  backfillAccounting(db);

  console.log('✅ دیتابیس آماده شد');
}

// Sync engine schema. Central keeps a monotonic global sequence stamped onto
// every row change via triggers (plus tombstones for deletes) so devices can
// pull incrementally; devices keep an outbox of locally-performed operations
// to replay against central. See sync/tables.js for the table registry and
// the provisional id-space partitioning that makes offline creation safe.
function initSyncSchema(db) {
  const { SYNCABLE_TABLES } = require('./sync/tables');

  // Columns every syncable table needs (both roles — devices receive central
  // values via pull; version powers optimistic concurrency for offline edits).
  for (const t of SYNCABLE_TABLES) {
    if (!tableExists(db, t.name)) continue;
    ensureColumn(db, t.name, 'sync_seq', 'INTEGER');
    ensureColumn(db, t.name, 'version', 'INTEGER DEFAULT 0');
    try {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${t.name}_sync_seq ON ${t.name}(sync_seq)`);
    } catch (e) {
      console.warn(`⚠️ sync_seq index skipped for ${t.name}:`, e.message);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS global_seq (
      id INTEGER PRIMARY KEY CHECK (id=1),
      value INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO global_seq (id, value) VALUES (1, 0);

    CREATE TABLE IF NOT EXISTS sync_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      paired_by INTEGER,
      active INTEGER DEFAULT 1,
      last_push_at INTEGER,
      last_pull_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS sync_applied_ops (
      idempotency_key TEXT PRIMARY KEY,
      device_id INTEGER NOT NULL,
      device_seq INTEGER NOT NULL,
      method TEXT, path TEXT,
      status TEXT NOT NULL,             -- applied | conflict
      result_json TEXT,
      applied_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS sync_id_map (
      device_id INTEGER NOT NULL,
      local_id INTEGER NOT NULL,
      tbl TEXT NOT NULL,
      central_id INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (device_id, local_id)
    );

    CREATE TABLE IF NOT EXISTS sync_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL,
      device_seq INTEGER NOT NULL,
      idempotency_key TEXT,
      method TEXT, path TEXT,
      payload TEXT,
      reason TEXT,
      central_snapshot TEXT,
      status TEXT DEFAULT 'open',       -- open | resolved
      resolved_by INTEGER, resolved_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS sync_tombstones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tbl TEXT NOT NULL,
      row_key TEXT NOT NULL,
      sync_seq INTEGER NOT NULL,
      deleted_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tombstones_seq ON sync_tombstones(sync_seq);

    -- Device-side outbox: one row per locally-performed operation awaiting
    -- replay on central. Local-only — never part of push/pull payloads.
    CREATE TABLE IF NOT EXISTS sync_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, -- doubles as device_seq (ordering)
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      body_json TEXT,
      user_id INTEGER,
      base_version INTEGER,
      entity_table TEXT,
      entity_local_id INTEGER,
      captured_rows_json TEXT,          -- rows this op created locally (for cleanup on confirm)
      has_file INTEGER DEFAULT 0,
      file_path TEXT,
      status TEXT DEFAULT 'pending',    -- pending | confirmed | conflict | discarded
      central_result TEXT,
      reason TEXT,
      attempts INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_status ON sync_outbox(status);

    -- Device-side key/value config (central_url, device_id, device_token, last_pull_seq)
    CREATE TABLE IF NOT EXISTS sync_local_kv (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Central-only: triggers stamp every insert/update with the next global
  // sequence value (and bump version on update) and write a tombstone on
  // delete, so the pull endpoint can serve incremental changes with zero
  // cooperation from route handlers. Non-recursive triggers (SQLite default)
  // mean the trigger's own UPDATE doesn't re-fire itself.
  if (!isDevice()) {
    for (const t of SYNCABLE_TABLES) {
      if (!tableExists(db, t.name)) continue;
      const match = syncTriggerMatch(t, db);
      if (!match) {
        console.warn(`⚠️ skipping sync triggers for ${t.name} (no row key)`);
        continue;
      }
      const { updateWhere, tombstone } = match;
      db.exec(`DROP TRIGGER IF EXISTS trg_sync_ins_${t.name}`);
      db.exec(`DROP TRIGGER IF EXISTS trg_sync_upd_${t.name}`);
      db.exec(`DROP TRIGGER IF EXISTS trg_sync_del_${t.name}`);
      db.exec(`
        CREATE TRIGGER trg_sync_ins_${t.name} AFTER INSERT ON ${t.name} BEGIN
          UPDATE global_seq SET value = value + 1 WHERE id = 1;
          UPDATE ${t.name} SET sync_seq = (SELECT value FROM global_seq WHERE id = 1) WHERE ${updateWhere};
        END;
        CREATE TRIGGER trg_sync_upd_${t.name} AFTER UPDATE ON ${t.name} BEGIN
          UPDATE global_seq SET value = value + 1 WHERE id = 1;
          UPDATE ${t.name} SET sync_seq = (SELECT value FROM global_seq WHERE id = 1),
                              version = COALESCE(OLD.version, 0) + 1
          WHERE ${updateWhere};
        END;
        CREATE TRIGGER trg_sync_del_${t.name} AFTER DELETE ON ${t.name} BEGIN
          UPDATE global_seq SET value = value + 1 WHERE id = 1;
          INSERT INTO sync_tombstones (tbl, row_key, sync_seq)
          VALUES ('${t.name}', ${tombstone}, (SELECT value FROM global_seq WHERE id = 1));
        END;
      `);
    }
    // Stamp pre-existing rows once (first boot only — avoids re-scanning all tables every restart).
    const backfillFlag = db.prepare("SELECT value FROM settings WHERE key='sync_seq_backfill_v1'").get();
    if (!backfillFlag || backfillFlag.value !== '1') {
      for (const t of SYNCABLE_TABLES) {
        if (!tableExists(db, t.name)) continue;
        if (!tableColumns(db, t.name).includes('sync_seq')) continue;
        try {
          db.prepare(`UPDATE ${t.name} SET sync_seq = 0 WHERE sync_seq IS NULL`).run();
        } catch (e) {
          console.warn(`⚠️ sync_seq backfill skipped for ${t.name}:`, e.message);
        }
      }
      db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('sync_seq_backfill_v1','1')").run();
    }
  }
}

// Device-side: reserve this device's provisional id ranges by pre-seeding
// sqlite_sequence for every syncable table, so ordinary AUTOINCREMENT inserts
// naturally allocate ids in the device's own disjoint high range with no
// changes to any route handler. Idempotent; called at pairing and every boot.
function seedProvisionalSequences(db, deviceId) {
  const { SYNCABLE_TABLES, tableBase } = require('./sync/tables');
  SYNCABLE_TABLES.forEach((t, i) => {
    const base = tableBase(deviceId, i);
    const row = db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(t.name);
    if (!row) {
      db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(t.name, base);
    } else if (row.seq < base) {
      db.prepare('UPDATE sqlite_sequence SET seq=? WHERE name=?').run(base, t.name);
    }
  });
}

// Atomically allocate the next business number (e.g. invoice 'T-0042').
// Safe inside an enclosing db.transaction() — better-sqlite3 nests via savepoints.
// Central-only in the sync architecture: device builds issue provisional
// numbers instead and receive the real number from central at sync time.
function allocateNumber(db, key, prefix) {
  const next = db.transaction(() => {
    db.prepare('UPDATE number_sequences SET current_value=current_value+1 WHERE key=?').run(key);
    return db.prepare('SELECT current_value v FROM number_sequences WHERE key=?').get(key).v;
  })();
  return prefix + '-' + String(next).padStart(4, '0');
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
  } catch (e) {
    // Inside a transaction the error must propagate so the whole operation
    // rolls back atomically; standalone (legacy) calls stay tolerant.
    if (db.inTransaction) throw e;
    console.error('ledger entry error:', e.message);
  }
}

// Create a person ledger entry (debit = person owes us, credit = we owe person)
// — used by the Persons module and by manual journal vouchers that post
// against a specific person instead of a raw chart-of-accounts code.
function createPersonLedgerEntry(db, { person_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id }) {
  try {
    db.prepare('INSERT INTO person_ledger (person_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(person_id, date || '', entry_type, ref_type || '', ref_id || null, description || '', debit || 0, credit || 0, user_id || null);
  } catch (e) {
    if (db.inTransaction) throw e;
    console.error('person ledger entry error:', e.message);
  }
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
  } catch (e) {
    if (db.inTransaction) throw e;
    console.error('journal entry error:', e.message);
  }
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
  resolveCashAccount, syncBankAccount, syncCashBoxAccount,
  SYNC_ROLE, isDevice, allocateNumber, seedProvisionalSequences
};
