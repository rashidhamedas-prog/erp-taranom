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
  const flag = db.prepare("SELECT value FROM settings WHERE key='warehouse_stock_seeded_v1'").get();
  if (flag && flag.value === '1') return;
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
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('warehouse_stock_seeded_v1','1')").run();
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
  // امنیت: الزام تغییر رمز در اولین ورود (ادمین پیش‌فرض / رمز تعیین‌شده توسط مدیر)
  ensureColumn(db, 'users', 'must_change_password', 'INTEGER DEFAULT 0');
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
  ensureColumn(db, 'settlements', 'cheque_branch', "TEXT DEFAULT ''");
  ensureColumn(db, 'settlements', 'cheque_sheba', "TEXT DEFAULT ''");
  ensureColumn(db, 'settlements', 'cheque_row', 'INTEGER DEFAULT 0');
  db.exec(`
    CREATE TABLE IF NOT EXISTS expense_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT,
      name TEXT NOT NULL,
      account_code TEXT,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )
  `);
  const expCatCount = db.prepare('SELECT COUNT(*) c FROM expense_categories').get().c;
  if (!expCatCount) {
    db.prepare('INSERT INTO expense_categories (code,name,account_code) VALUES (?,?,?)').run('admin', 'عمومی و اداری', '6102');
    db.prepare('INSERT INTO expense_categories (code,name,account_code) VALUES (?,?,?)').run('sales', 'توزیع و فروش', '6103');
  }
  // Broaden the default expense category list (idempotent: only adds names that
  // are not already present, so existing databases pick these up on next boot).
  {
    const commonExpenseCats = [
      ['اجاره محل', '6102'], ['حقوق و دستمزد', '6102'], ['آب، برق، گاز و تلفن', '6102'],
      ['حمل و نقل و باربری', '6103'], ['تبلیغات و بازاریابی', '6103'], ['ملزومات و لوازم اداری', '6102'],
      ['تعمیر و نگهداری', '6102'], ['پذیرایی و پیک', '6102'], ['بیمه', '6102'],
      ['مالیات و عوارض', '6102'], ['هزینه‌های بانکی', '6102'], ['ایاب و ذهاب', '6102'],
    ];
    const hasCat = db.prepare('SELECT 1 FROM expense_categories WHERE name=?');
    const addCat = db.prepare('INSERT INTO expense_categories (code,name,account_code) VALUES (NULL,?,?)');
    for (const [nm, acc] of commonExpenseCats) { if (!hasCat.get(nm)) addCat.run(nm, acc); }
  }
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
  ensureColumn(db, 'followups', 'account_balance', 'REAL DEFAULT 0');
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
  db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code) VALUES ('1107','مساعده نمایندگان فروش','asset','1100')").run();
  db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code) VALUES ('2107','بستانکاران انگیزه نمایندگان','liability','2100')").run();

  // ---- Marketing representatives module ----
  ensureColumn(db, 'users', 'rep_code', 'TEXT');
  ensureColumn(db, 'users', 'rep_subtype', "TEXT DEFAULT ''");
  ensureColumn(db, 'users', 'territory', "TEXT DEFAULT ''");
  ensureColumn(db, 'users', 'supervisor_id', 'INTEGER');
  ensureColumn(db, 'users', 'employment_status', "TEXT DEFAULT 'active'");
  ensureColumn(db, 'users', 'bank_name', "TEXT DEFAULT ''");
  ensureColumn(db, 'users', 'bank_account', "TEXT DEFAULT ''");
  ensureColumn(db, 'users', 'bank_iban', "TEXT DEFAULT ''");
  ensureColumn(db, 'users', 'contract_file', "TEXT DEFAULT ''");
  ensureColumn(db, 'users', 'rep_opening_balance', 'REAL DEFAULT 0');
  ensureColumn(db, 'invoices', 'sales_channel', "TEXT DEFAULT ''");
  ensureColumn(db, 'invoices', 'lead_source', "TEXT DEFAULT ''");
  ensureColumn(db, 'invoices', 'campaign', "TEXT DEFAULT ''");
  db.exec(`
    CREATE TABLE IF NOT EXISTS rep_assignment_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      from_rep_id INTEGER,
      to_rep_id INTEGER NOT NULL,
      date TEXT,
      note TEXT,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(customer_id) REFERENCES customers(id),
      FOREIGN KEY(from_rep_id) REFERENCES users(id),
      FOREIGN KEY(to_rep_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS rep_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rep_id INTEGER NOT NULL,
      date TEXT,
      entry_type TEXT NOT NULL,
      ref_type TEXT,
      ref_id INTEGER,
      description TEXT,
      debit REAL DEFAULT 0,
      credit REAL DEFAULT 0,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(rep_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS rep_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rep_id INTEGER NOT NULL,
      category TEXT DEFAULT 'other',
      amount REAL DEFAULT 0,
      date TEXT,
      description TEXT,
      receipt_file TEXT,
      cost_center_id INTEGER,
      status TEXT DEFAULT 'pending',
      approved_by INTEGER,
      approved_at INTEGER,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(rep_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS rep_advances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rep_id INTEGER NOT NULL,
      amount REAL DEFAULT 0,
      pay_type TEXT DEFAULT 'cash',
      date TEXT,
      note TEXT,
      settled_amount REAL DEFAULT 0,
      bank_id INTEGER,
      cash_box_id INTEGER,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(rep_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS rep_commission_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rep_id INTEGER NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id INTEGER,
      rate_cash REAL DEFAULT 0,
      rate_cheque REAL DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(rep_id) REFERENCES users(id)
    );
  `);
  ensureColumn(db, 'users', 'commission_basis', "TEXT DEFAULT 'invoice'");
  ensureColumn(db, 'users', 'monthly_target', 'REAL DEFAULT 0');
  ensureColumn(db, 'users', 'quarterly_target', 'REAL DEFAULT 0');
  ensureColumn(db, 'users', 'annual_target', 'REAL DEFAULT 0');
  ensureColumn(db, 'users', 'bonus_pct', 'REAL DEFAULT 0');
  ensureColumn(db, 'users', 'commission_fixed', 'REAL DEFAULT 0');
  ensureColumn(db, 'users', 'supervisor_commission_pct', 'REAL DEFAULT 0');
  ensureColumn(db, 'users', 'penalty_pct', 'REAL DEFAULT 0');
  ensureColumn(db, 'audit_log', 'ip_address', "TEXT DEFAULT ''");
  ensureColumn(db, 'audit_log', 'user_agent', "TEXT DEFAULT ''");
  ensureColumn(db, 'products', 'brand', "TEXT DEFAULT ''");
  ensureColumn(db, 'customers', 'rep_territory', "TEXT DEFAULT ''");
  ensureColumn(db, 'rep_commission_rules', 'scope_label', "TEXT DEFAULT ''");
  db.exec(`
    CREATE TABLE IF NOT EXISTS rep_commission_tiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rep_id INTEGER NOT NULL,
      from_amount REAL DEFAULT 0,
      to_amount REAL,
      rate_cash REAL DEFAULT 0,
      rate_cheque REAL DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(rep_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS rep_settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rep_id INTEGER NOT NULL,
      date TEXT,
      settlement_type TEXT DEFAULT 'combined',
      commission_paid REAL DEFAULT 0,
      expense_settled REAL DEFAULT 0,
      advance_settled REAL DEFAULT 0,
      total_amount REAL DEFAULT 0,
      balance_before REAL DEFAULT 0,
      balance_after REAL DEFAULT 0,
      note TEXT,
      ref_payment_id INTEGER,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(rep_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS rep_territories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      rep_id INTEGER,
      cities TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(rep_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS rep_visit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rep_id INTEGER NOT NULL,
      customer_id INTEGER,
      date TEXT,
      check_in_at INTEGER,
      check_out_at INTEGER,
      lat REAL,
      lng REAL,
      note TEXT,
      signature_file TEXT,
      photo_file TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(rep_id) REFERENCES users(id),
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    );
    CREATE TABLE IF NOT EXISTS rep_call_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rep_id INTEGER NOT NULL,
      customer_id INTEGER,
      date TEXT,
      duration_min INTEGER DEFAULT 0,
      outcome TEXT DEFAULT '',
      note TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(rep_id) REFERENCES users(id),
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    );
    CREATE TABLE IF NOT EXISTS rep_payment_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rep_id INTEGER NOT NULL,
      cust_id INTEGER NOT NULL,
      pay_type TEXT DEFAULT 'cash',
      amount REAL DEFAULT 0,
      date TEXT,
      note TEXT,
      receipt_file TEXT,
      cheque_bank TEXT DEFAULT '',
      cheque_sayadi TEXT DEFAULT '',
      cheque_number TEXT DEFAULT '',
      cheque_account TEXT DEFAULT '',
      cheque_amount REAL DEFAULT 0,
      cheque_owner TEXT DEFAULT '',
      cheque_due TEXT DEFAULT '',
      bank_ref TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      settlement_id INTEGER,
      approved_by INTEGER,
      approved_at INTEGER,
      rejection_note TEXT DEFAULT '',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(rep_id) REFERENCES users(id),
      FOREIGN KEY(cust_id) REFERENCES customers(id)
    );
    CREATE TABLE IF NOT EXISTS stocktaking_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      warehouse_id INTEGER NOT NULL,
      date TEXT,
      responsible_user_id INTEGER,
      status TEXT DEFAULT 'draft',
      note TEXT DEFAULT '',
      created_by INTEGER,
      approved_by INTEGER,
      approved_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(warehouse_id) REFERENCES warehouses(id)
    );
    CREATE TABLE IF NOT EXISTS stocktaking_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      system_qty INTEGER DEFAULT 0,
      counted_qty INTEGER DEFAULT 0,
      FOREIGN KEY(session_id) REFERENCES stocktaking_sessions(id),
      FOREIGN KEY(product_id) REFERENCES products(id)
    );
  `);
  // این دو ستون باید بعد از CREATE TABLE rep_territories اضافه شوند (روی DB تازه، قبل از ساخت جدول crash می‌کرد)
  ensureColumn(db, 'rep_territories', 'rep_id', 'INTEGER');
  ensureColumn(db, 'rep_territories', 'cities', "TEXT DEFAULT ''");
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
    CREATE INDEX IF NOT EXISTS idx_stocktaking_wh ON stocktaking_sessions(warehouse_id);
    CREATE INDEX IF NOT EXISTS idx_stocktaking_status ON stocktaking_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_stocktaking_items_sess ON stocktaking_items(session_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_created ON invoices(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_invoices_commission ON invoices(user_id, type, approved, pay_type);
    CREATE INDEX IF NOT EXISTS idx_invoices_type_date ON invoices(type, date);
    CREATE INDEX IF NOT EXISTS idx_invoices_type_cust_date ON invoices(type, cust_id, date);
    CREATE INDEX IF NOT EXISTS idx_settlements_cust ON settlements(cust_id);
    CREATE INDEX IF NOT EXISTS idx_settlements_date ON settlements(date);
    CREATE INDEX IF NOT EXISTS idx_ledger_cust_created ON customer_ledger(customer_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_followups_status_next ON followups(status, next_date);
    CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
    CREATE INDEX IF NOT EXISTS idx_rep_ledger_rep ON rep_ledger(rep_id);
    CREATE INDEX IF NOT EXISTS idx_rep_expenses_rep ON rep_expenses(rep_id);
    CREATE INDEX IF NOT EXISTS idx_rep_advances_rep ON rep_advances(rep_id);
    CREATE INDEX IF NOT EXISTS idx_rep_assign_cust ON rep_assignment_history(customer_id);
    CREATE INDEX IF NOT EXISTS idx_rep_comm_rules_rep ON rep_commission_rules(rep_id);
    CREATE INDEX IF NOT EXISTS idx_rep_comm_tiers_rep ON rep_commission_tiers(rep_id);
    CREATE INDEX IF NOT EXISTS idx_rep_settlements_rep ON rep_settlements(rep_id);
    CREATE INDEX IF NOT EXISTS idx_rep_visits_rep ON rep_visit_logs(rep_id);
    CREATE INDEX IF NOT EXISTS idx_rep_calls_rep ON rep_call_logs(rep_id);
    CREATE INDEX IF NOT EXISTS idx_rep_pay_sub_rep ON rep_payment_submissions(rep_id);
    CREATE INDEX IF NOT EXISTS idx_rep_pay_sub_status ON rep_payment_submissions(status);
  `);

  // ---- Default admin ----
  const admin = db.prepare('SELECT id FROM users WHERE username=?').get('admin');
  if (!admin) {
    const hash = bcrypt.hashSync('admin123', 10);
    // must_change_password=1 → رمز پیش‌فرض باید در اولین ورود عوض شود (روی سرور مرکزی)
    db.prepare('INSERT INTO users (name,username,password,role,must_change_password) VALUES (?,?,?,?,1)')
      .run('حامد رشید', 'admin', hash, 'admin');
    console.log('✅ ادمین پیش‌فرض ساخته شد (admin / admin123) — تغییر رمز در اولین ورود الزامی است');
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
    overhead_period_production_qty: '0',
    rep_sms_notify: '1'
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
  if (!db.prepare('SELECT 1 FROM number_sequences WHERE key=?').get('journal_voucher')) {
    db.prepare('INSERT INTO number_sequences (key,current_value) VALUES (?,0)').run('journal_voucher');
  }
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
function ensureSyncColumnsForAllTables(db) {
  const { SYNCABLE_TABLES } = require('./sync/tables');
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
}

function initSyncSchema(db) {
  const { SYNCABLE_TABLES } = require('./sync/tables');

  // First pass — tables that already exist from earlier initDB DDL.
  ensureSyncColumnsForAllTables(db);

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

    CREATE TABLE IF NOT EXISTS password_reset_otps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_reset_otp_user ON password_reset_otps(user_id);

    -- 2FA (TOTP): central-only — NOT in SYNCABLE_TABLES, device builds keep it empty
    CREATE TABLE IF NOT EXISTS two_factor_auth (
      user_id INTEGER PRIMARY KEY,
      secret TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      recovery_codes TEXT DEFAULT '[]',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    -- AI sales assistant insights (heuristic churn/opportunity + optional LLM narratives)
    CREATE TABLE IF NOT EXISTS ai_insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      user_id INTEGER,
      kind TEXT NOT NULL,
      score INTEGER,
      title TEXT DEFAULT '',
      body TEXT DEFAULT '',
      period TEXT DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ai_insights_kind ON ai_insights(kind, period);
    CREATE INDEX IF NOT EXISTS idx_ai_insights_cust ON ai_insights(customer_id);

    -- B2B customer portal (ported from CRM v4): central-only — NOT in
    -- SYNCABLE_TABLES. Portal login + orders live only on the central web
    -- server; approved orders become normal proforma invoices which sync.
    CREATE TABLE IF NOT EXISTS b2b_portal_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER UNIQUE NOT NULL,
      phone TEXT NOT NULL,
      password TEXT,
      otp_hash TEXT,
      otp_expires INTEGER,
      active INTEGER DEFAULT 1,
      last_login INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    );
    CREATE INDEX IF NOT EXISTS idx_b2b_acc_phone ON b2b_portal_accounts(phone);

    CREATE TABLE IF NOT EXISTS b2b_portal_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      rows TEXT,
      note TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      invoice_id INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    );
    CREATE INDEX IF NOT EXISTS idx_b2b_orders_cust ON b2b_portal_orders(customer_id);
  `);
  ensureColumn(db, 'customers', 'churn_score', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'customers', 'b2b_enabled', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'products', 'barcode', 'TEXT');

  // v1.0.11 — soft-delete, RBAC, fiscal years, notifications
  ensureColumn(db, 'invoices', 'deleted_at', 'INTEGER');
  ensureColumn(db, 'invoices', 'deleted_by', 'INTEGER');
  ensureColumn(db, 'journal_entries', 'deleted_at', 'INTEGER');
  ensureColumn(db, 'journal_entries', 'deleted_by', 'INTEGER');

  // Mahak migration (docs/MAHAK-MIGRATION.md) — operational entities can be
  // bound to a chart-of-accounts code; imported vouchers keep their Mahak ids.
  ensureColumn(db, 'customers',  'coa_code', 'TEXT');
  ensureColumn(db, 'suppliers',  'coa_code', 'TEXT');
  ensureColumn(db, 'products',   'coa_code', 'TEXT');
  ensureColumn(db, 'banks',      'coa_code', 'TEXT');
  ensureColumn(db, 'cash_boxes', 'coa_code', 'TEXT');
  ensureColumn(db, 'persons',    'coa_code', 'TEXT');
  ensureColumn(db, 'products',   'needs_qty', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'journal_entries', 'src_system', 'TEXT');
  ensureColumn(db, 'journal_entries', 'src_doc_no', 'TEXT');
  ensureColumn(db, 'journal_entries', 'src_atf', 'TEXT');
  for (const tbl of ['invoices', 'purchase_invoices', 'settlements', 'supplier_payments', 'expense_payments', 'warehouse_moves', 'account_transfers', 'payroll_records', 'sales_returns', 'purchase_returns']) {
    ensureColumn(db, tbl, 'mahak_doc_no', 'TEXT');
    ensureColumn(db, tbl, 'mahak_doc_type', 'TEXT');
  }
  ensureColumn(db, 'product_categories', 'code', 'INTEGER');
  ensureColumn(db, 'product_categories', 'parent_id', 'INTEGER');
  ensureColumn(db, 'product_categories', 'description', 'TEXT');
  ensureColumn(db, 'customers', 'party_group_id', 'INTEGER');
  ensureColumn(db, 'suppliers', 'party_group_id', 'INTEGER');
  ensureColumn(db, 'persons', 'party_group_id', 'INTEGER');
  // Mahak operational codes + extra fields from full data.xlsx
  for (const tbl of ['customers', 'suppliers', 'persons', 'products', 'banks']) {
    ensureColumn(db, tbl, 'mahak_op_code', 'TEXT');
  }
  for (const [tbl, cols] of [
    ['customers', [
      ['prefix', 'TEXT'], ['phone2', 'TEXT'], ['fax', 'TEXT'], ['mobile', 'TEXT'],
      ['email', 'TEXT'], ['economic_code', 'TEXT'], ['postal_code', 'TEXT'],
      ['national_id', 'TEXT'], ['referrer', 'TEXT'], ['birth_date', 'TEXT'],
      ['company_name', 'TEXT'], ['account_nature', 'TEXT'],
    ]],
    ['suppliers', [
      ['prefix', 'TEXT'], ['phone2', 'TEXT'], ['fax', 'TEXT'], ['mobile', 'TEXT'],
      ['email', 'TEXT'], ['economic_code', 'TEXT'], ['postal_code', 'TEXT'],
      ['national_id', 'TEXT'], ['referrer', 'TEXT'], ['company_name', 'TEXT'],
      ['account_nature', 'TEXT'],
    ]],
    ['persons', [
      ['prefix', 'TEXT'], ['phone2', 'TEXT'], ['fax', 'TEXT'], ['mobile', 'TEXT'],
      ['email', 'TEXT'], ['economic_code', 'TEXT'], ['postal_code', 'TEXT'],
      ['national_id', 'TEXT'], ['referrer', 'TEXT'], ['birth_date', 'TEXT'],
      ['company_name', 'TEXT'], ['account_nature', 'TEXT'],
    ]],
    ['products', [
      ['full_name', 'TEXT'], ['product_type', 'TEXT'], ['product_index', 'TEXT'],
      ['tax_id', 'TEXT'], ['consumer_price', 'REAL DEFAULT 0'], ['location', 'TEXT'],
      ['opening_price', 'REAL DEFAULT 0'], ['sms_code', 'TEXT'],
    ]],
    ['banks', [
      ['account_type', 'TEXT'], ['phone', 'TEXT'], ['card_number', 'TEXT'],
      ['card_expiry', 'TEXT'], ['sheba', 'TEXT'], ['note', 'TEXT'],
    ]],
    ['invoices', [
      ['mahak_invoice_code', 'TEXT'], ['atf_no', 'TEXT'], ['settlement_date', 'TEXT'],
      ['freight_amount', 'REAL DEFAULT 0'], ['freight_type', 'TEXT'],
      ['settled_amount', 'REAL DEFAULT 0'], ['balance_due', 'REAL DEFAULT 0'],
      ['driver', 'TEXT'], ['entry_method', 'TEXT'], ['delivery_date', 'TEXT'],
      ['delivered', 'INTEGER DEFAULT 0'], ['settlement_status', 'TEXT'],
      ['settlement_type', 'TEXT'], ['invoice_address', 'TEXT'], ['visitor', 'TEXT'],
    ]],
    ['settlements', [
      ['mahak_receipt_code', 'TEXT'], ['atf_no', 'TEXT'], ['invoice_ref', 'TEXT'],
      ['visitor', 'TEXT'], ['purpose', 'TEXT'], ['cash_amount', 'REAL DEFAULT 0'],
      ['cheque_total', 'REAL DEFAULT 0'], ['transfer_total', 'REAL DEFAULT 0'],
    ]],
    ['purchase_invoices', [
      ['atf_no', 'TEXT'], ['settled_amount', 'REAL DEFAULT 0'],
      ['balance_due', 'REAL DEFAULT 0'], ['settlement_status', 'TEXT'],
    ]],
    ['supplier_payments', [
      ['atf_no', 'TEXT'], ['purpose', 'TEXT'], ['cash_amount', 'REAL DEFAULT 0'],
      ['cheque_total', 'REAL DEFAULT 0'], ['transfer_total', 'REAL DEFAULT 0'],
    ]],
  ]) {
    for (const [col, def] of cols) ensureColumn(db, tbl, col, def);
  }
  ensureColumn(db, 'chart_of_accounts', 'level', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'chart_of_accounts', 'nature', 'TEXT');
  ensureColumn(db, 'chart_of_accounts', 'tafsili_type', 'TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      resource TEXT NOT NULL,
      action TEXT NOT NULL,
      allowed INTEGER DEFAULT 1,
      UNIQUE(user_id, resource, action),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS fiscal_years (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT DEFAULT '',
      status TEXT DEFAULT 'open',
      opening_retained REAL DEFAULT 0,
      opening_receivables REAL DEFAULT 0,
      opening_inventory REAL DEFAULT 0,
      created_by INTEGER,
      closed_by INTEGER,
      closed_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS app_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      title TEXT DEFAULT '',
      body TEXT DEFAULT '',
      target_roles TEXT DEFAULT '[]',
      resolved_at INTEGER,
      resolved_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_notif_unresolved ON app_notifications(resolved_at);
    CREATE TABLE IF NOT EXISTS cheque_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,
      cheque_number TEXT DEFAULT '',
      issue_date TEXT DEFAULT '',
      receive_date TEXT DEFAULT '',
      due_date TEXT DEFAULT '',
      bank_name TEXT DEFAULT '',
      branch TEXT DEFAULT '',
      sayadi TEXT DEFAULT '',
      sheba TEXT DEFAULT '',
      account_number TEXT DEFAULT '',
      party_name TEXT DEFAULT '',
      status TEXT DEFAULT '',
      status_note TEXT DEFAULT '',
      amount REAL NOT NULL DEFAULT 0,
      mahak_row_id TEXT DEFAULT '',
      mahak_reg_id TEXT DEFAULT '',
      note TEXT DEFAULT '',
      created_by_name TEXT DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cheque_records_dir ON cheque_records(direction);
    CREATE INDEX IF NOT EXISTS idx_cheque_records_due ON cheque_records(due_date);
  `);

  // ---- Accounting module foundation (spec phase 1) ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS detail_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS detail_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      detail_category_id INTEGER REFERENCES detail_categories(id),
      linked_table TEXT,
      linked_id INTEGER,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS parties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_code TEXT UNIQUE NOT NULL,
      party_type TEXT NOT NULL DEFAULT 'customer',
      legal_type TEXT DEFAULT 'real',
      full_name TEXT NOT NULL,
      company_name TEXT,
      national_id TEXT,
      economic_code TEXT,
      phone TEXT NOT NULL,
      secondary_phone TEXT,
      email TEXT,
      city TEXT,
      province TEXT,
      address TEXT,
      postal_code TEXT,
      store_type TEXT,
      segment TEXT DEFAULT 'C',
      source TEXT,
      detail_account_id INTEGER REFERENCES detail_accounts(id),
      credit_limit INTEGER DEFAULT 0,
      opening_balance INTEGER DEFAULT 0,
      opening_balance_date TEXT,
      notes TEXT,
      is_active INTEGER DEFAULT 1,
      legacy_table TEXT,
      legacy_id INTEGER,
      user_id INTEGER,
      biz TEXT,
      owner TEXT,
      insta TEXT,
      status TEXT DEFAULT 'new',
      type TEXT DEFAULT 'بوتیک',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_parties_type ON parties(party_type);
    CREATE INDEX IF NOT EXISTS idx_parties_phone ON parties(phone);
  `);

  ensureColumn(db, 'journal_entries', 'fiscal_year_id', 'INTEGER');
  ensureColumn(db, 'journal_entries', 'voucher_number', 'TEXT');
  ensureColumn(db, 'journal_entries', 'voucher_type', "TEXT DEFAULT 'auto'");
  ensureColumn(db, 'journal_entries', 'status', "TEXT DEFAULT 'approved'");
  ensureColumn(db, 'journal_entries', 'total_debit_rial', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'journal_entries', 'total_credit_rial', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'journal_lines', 'line_no', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'journal_lines', 'detail_account_id', 'INTEGER');
  ensureColumn(db, 'journal_lines', 'debit_rial', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'journal_lines', 'credit_rial', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'invoices', 'party_id', 'INTEGER');
  ensureColumn(db, 'settlements', 'party_id', 'INTEGER');
  ensureColumn(db, 'customers', 'party_id', 'INTEGER');
  ensureColumn(db, 'suppliers', 'party_id', 'INTEGER');
  ensureColumn(db, 'warehouses', 'entity', "TEXT DEFAULT 'distribution_office'");
  ensureColumn(db, 'warehouses', 'cost_center_id', 'INTEGER');
  ensureColumn(db, 'cost_centers', 'entity', 'TEXT');
  for (const [col, def] of [
    ['party_group_id', 'INTEGER'], ['prefix', 'TEXT'], ['fax', 'TEXT'], ['mobile', 'TEXT'],
    ['birth_date', 'TEXT'], ['referrer', 'TEXT'], ['account_nature', 'TEXT'],
    ['coa_code', 'TEXT'], ['party_roles', 'TEXT'],
  ]) ensureColumn(db, 'parties', col, def);
  for (const [col, def] of [
    ['holder_name', 'TEXT'], ['leaf_count', 'INTEGER DEFAULT 0'],
    ['current_leaf', 'TEXT'], ['note', 'TEXT'],
  ]) ensureColumn(db, 'check_categories', col, def);
  ensureColumn(db, 'banks', 'extra_accounts', "TEXT DEFAULT '[]'");
  ensureColumn(db, 'purchase_invoices', 'freight_amount', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'purchase_invoices', 'freight_type', 'TEXT');
  ensureColumn(db, 'purchase_invoices', 'vat_exempt', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'purchase_invoices', 'cost_center_id', 'INTEGER');
  ensureColumn(db, 'invoices', 'warehouse_id', 'INTEGER');
  ensureColumn(db, 'invoices', 'freight_amount', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'invoices', 'freight_type', 'TEXT');
  ensureColumn(db, 'invoices', 'vat_exempt', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'invoices', 'bank_id', 'INTEGER');
  ensureColumn(db, 'invoices', 'cash_box_id', 'INTEGER');
  ensureColumn(db, 'invoices', 'cost_center_id', 'INTEGER');
  ensureColumn(db, 'invoices', 'check_category_id', 'INTEGER');

  // Seed detail categories
  const dcCount = db.prepare('SELECT COUNT(*) c FROM detail_categories').get().c;
  if (!dcCount) {
    const insDC = db.prepare('INSERT OR IGNORE INTO detail_categories (code,name) VALUES (?,?)');
    [['person', 'اشخاص'], ['cost_center', 'مراکز هزینه'], ['employee', 'کارکنان'], ['asset', 'دارایی'], ['product', 'کالا'], ['other', 'سایر']].forEach(([c, n]) => insDC.run(c, n));
  }

  // Seed cost centers for two operational units
  const ccWorkshop = db.prepare("SELECT id FROM cost_centers WHERE code='CC-WORKSHOP'").get();
  if (!ccWorkshop) {
    db.prepare("INSERT OR IGNORE INTO cost_centers (name,code,entity) VALUES ('کارگاه تولید — نوبرت','CC-WORKSHOP','workshop')").run();
    db.prepare("INSERT OR IGNORE INTO cost_centers (name,code,entity) VALUES ('دفتر توزیع — کیمیا','CC-DISTRIBUTION','distribution_office')").run();
  }

  // ---- Phase 2: units of measure + warehouse/product master extensions ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS units_of_measure (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);
  const uomCount = db.prepare('SELECT COUNT(*) c FROM units_of_measure').get().c;
  if (!uomCount) {
    const insUom = db.prepare('INSERT OR IGNORE INTO units_of_measure (code,name) VALUES (?,?)');
    [['PCS', 'عدد'], ['M', 'متر'], ['KG', 'کیلوگرم'], ['SET', 'ست'], ['PAIR', 'جفت']].forEach(([c, n]) => insUom.run(c, n));
  }

  ensureColumn(db, 'warehouses', 'code', 'TEXT');
  ensureColumn(db, 'warehouses', 'warehouse_type', "TEXT DEFAULT 'finished_goods'");
  ensureColumn(db, 'warehouses', 'is_default', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'products', 'unit_id', 'INTEGER');
  ensureColumn(db, 'products', 'vat_class', "TEXT DEFAULT 'standard'");
  ensureColumn(db, 'products', 'barcode', 'TEXT');
  ensureColumn(db, 'products', 'reorder_point', 'INTEGER DEFAULT 12');
  ensureColumn(db, 'products', 'costing_method', "TEXT DEFAULT 'moving_average'");
  ensureColumn(db, 'products', 'average_cost_rial', 'INTEGER DEFAULT 0');

  // Default warehouses for workshop + distribution office
  const whCount = db.prepare('SELECT COUNT(*) c FROM warehouses').get().c;
  if (!whCount) {
    const ccW = db.prepare("SELECT id FROM cost_centers WHERE code='CC-WORKSHOP'").get()?.id;
    const ccD = db.prepare("SELECT id FROM cost_centers WHERE code='CC-DISTRIBUTION'").get()?.id;
    db.prepare(`INSERT INTO warehouses (code,name,address,entity,warehouse_type,cost_center_id,is_default,active) VALUES (?,?,?,?,?,?,?,1)`)
      .run('WH-WORKSHOP', 'انبار کارگاه — نوبرت', 'بلوار نوبرت', 'workshop', 'raw_material', ccW, 0);
    db.prepare(`INSERT INTO warehouses (code,name,address,entity,warehouse_type,cost_center_id,is_default,active) VALUES (?,?,?,?,?,?,?,1)`)
      .run('WH-DIST', 'انبار دفتر توزیع — کیمیا', 'پاساژ کیمیا، ۱۷ شهریور', 'distribution_office', 'finished_goods', ccD, 1);
  }

  // Company profile defaults (§2.31)
  const profileKeys = {
    company_name: 'پوشاک ترنم',
    company_legal_name: 'پوشاک ترنم',
    fiscal_year_start: '01/01',
    coa_mode: 'standard',
    currency_base: 'IRR',
    currency_display: 'toman',
    workshop_address: 'بلوار نوبرت',
    distribution_address: 'پاساژ کیمیا، میدان ۱۷ شهریور',
  };
  for (const [k, v] of Object.entries(profileKeys)) {
    db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)').run(k, v);
  }
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_mode','standard')").run();

  // CoA fixes: 5101 COGS child, 3201 retained earnings + Phase 3-7 accounts
  db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code) VALUES ('5101','بهای تمام‌شده فروش','cogs','5000')").run();
  db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code) VALUES ('3201','سود انباشته','equity','3000')").run();
  db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code) VALUES ('2103','مالیات بر ارزش افزوده پرداختنی','liability','2100')").run();
  db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code) VALUES ('1108','مالیات بر ارزش افزوده دریافتنی','asset','1100')").run();
  db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code) VALUES ('1201','دارایی‌های ثابت','asset','1100')").run();
  db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code) VALUES ('1202','استهلاک انباشته دارایی','asset','1100')").run();
  db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code) VALUES ('6105','هزینه استهلاک دارایی','expense','6000')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('vat_rate','10')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('moadian_enabled','0')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('module_moadian','1')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('module_fixed_assets','1')").run();

  // Phase 3-8 schema
  ensureColumn(db, 'invoices', 'vat_amount', 'REAL DEFAULT 0');
  ensureColumn(db, 'invoices', 'vat_rate', 'REAL DEFAULT 10');
  ensureColumn(db, 'invoices', 'vat_amount_rial', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'invoices', 'moadian_tax_id', 'TEXT');
  ensureColumn(db, 'invoices', 'moadian_status', "TEXT DEFAULT 'not_sent'");
  ensureColumn(db, 'invoices', 'doc_status', "TEXT DEFAULT 'confirmed'");
  ensureColumn(db, 'purchase_invoices', 'vat_amount', 'REAL DEFAULT 0');
  ensureColumn(db, 'purchase_invoices', 'vat_rate', 'REAL DEFAULT 10');
  ensureColumn(db, 'purchase_invoices', 'warehouse_id', 'INTEGER');
  ensureColumn(db, 'persons', 'hire_date', 'TEXT');
  ensureColumn(db, 'persons', 'salary_type', "TEXT DEFAULT 'hourly'");
  ensureColumn(db, 'persons', 'monthly_salary_rial', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'persons', 'department', 'TEXT');
  ensureColumn(db, 'persons', 'bank_iban', 'TEXT');
  ensureColumn(db, 'cost_centers', 'entity', 'TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS moadian_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_type TEXT NOT NULL,
      doc_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      tax_id TEXT,
      response_json TEXT,
      error_message TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      sent_at INTEGER,
      UNIQUE(doc_type, doc_id)
    );
    CREATE TABLE IF NOT EXISTS fixed_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT DEFAULT '',
      purchase_date TEXT DEFAULT '',
      cost_rial INTEGER NOT NULL DEFAULT 0,
      salvage_rial INTEGER DEFAULT 0,
      useful_life_months INTEGER DEFAULT 60,
      accumulated_depreciation_rial INTEGER DEFAULT 0,
      coa_asset_code TEXT DEFAULT '1201',
      location TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS fixed_asset_depreciation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL,
      period_label TEXT NOT NULL,
      amount_rial INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(asset_id) REFERENCES fixed_assets(id)
    );
    CREATE TABLE IF NOT EXISTS user_activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id INTEGER,
      ip_address TEXT,
      details TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_activity_created ON user_activity_log(created_at);
  `);

  // Migrate legacy customers/suppliers/persons → parties (idempotent)
  try {
    const partyCount = db.prepare('SELECT COUNT(*) c FROM parties').get().c;
    if (!partyCount) {
      const custs = db.prepare('SELECT * FROM customers').all();
      const insParty = db.prepare(`
        INSERT INTO parties (person_code,party_type,full_name,phone,city,notes,user_id,biz,owner,insta,status,type,legacy_table,legacy_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const c of custs) {
        const code = 'CUST-' + String(c.id).padStart(5, '0');
        const r = insParty.run(code, 'customer', c.owner || c.biz, c.phone || '-', c.city, c.note, c.user_id, c.biz, c.owner, c.insta, c.status, c.type, 'customers', c.id);
        db.prepare('UPDATE customers SET party_id=? WHERE id=?').run(r.lastInsertRowid, c.id);
      }
      const sups = db.prepare('SELECT * FROM suppliers').all();
      for (const s of sups) {
        const code = 'SUPP-' + String(s.id).padStart(5, '0');
        const r = insParty.run(code, 'supplier', s.name, s.phone || '-', null, s.note, null, s.name, null, null, 'active', null, 'suppliers', s.id);
        db.prepare('UPDATE suppliers SET party_id=? WHERE id=?').run(r.lastInsertRowid, s.id);
      }
      const misc = db.prepare('SELECT * FROM persons').all();
      for (const p of misc) {
        const code = 'PART-' + String(p.id).padStart(5, '0');
        insParty.run(code, 'other', p.name, p.phone || '-', null, p.note, null, p.name, null, null, p.active ? 'active' : 'inactive', null, 'persons', p.id);
      }
    }
  } catch (e) { console.warn('parties migration:', e.message); }

  // Rial INTEGER migration for key monetary columns (×10 from toman REAL)
  try {
    const { migrateRealToRial } = require('./lib/money');
    ensureColumn(db, 'invoices', 'final_rial', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'invoices', 'subtotal_rial', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'products', 'price_rial', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'settlements', 'amount_rial', 'INTEGER DEFAULT 0');
    migrateRealToRial(db, 'invoices', 'final', 'final_rial');
    migrateRealToRial(db, 'invoices', 'subtotal', 'subtotal_rial');
    migrateRealToRial(db, 'products', 'price', 'price_rial');
    migrateRealToRial(db, 'settlements', 'amount', 'amount_rial');
  } catch (e) { console.warn('rial migration:', e.message); }

  // Seed first fiscal year if none exists
  const fyCount = db.prepare('SELECT COUNT(*) c FROM fiscal_years').get().c;
  if (!fyCount) {
    const { todayJalali } = require('./jalali');
    const yr = todayJalali().slice(0, 4);
    const fyId = db.prepare(`
      INSERT INTO fiscal_years (label, start_date, status) VALUES (?, ?, 'open')
    `).run('سال مالی ' + yr, yr + '/01/01').lastInsertRowid;
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('active_fiscal_year_id',?)").run(String(fyId));
  }

  // Central-only: triggers stamp every insert/update with the next global
  // sequence value (and bump version on update) and write a tombstone on
  // delete, so the pull endpoint can serve incremental changes with zero
  // cooperation from route handlers. Non-recursive triggers (SQLite default)
  // mean the trigger's own UPDATE doesn't re-fire itself.
  // Production module P0 — schema/triggers/views/seed (before sync column pass)
  try {
    require('./lib/production/schema').initProductionSchema(db);
  } catch (e) {
    console.error('❌ production schema init failed:', e.message);
    throw e;
  }

  // Second pass — tables created above in this function (parties, fiscal_years, production, …).
  ensureSyncColumnsForAllTables(db);
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

  // Currency: مبنای ذخیره‌سازی ریال + مهاجرت یک‌باره از تومان
  const { migrateTomanToRial, seedStandardSubgroups } = require('./lib/currency');
  migrateTomanToRial(db);
  // party_groups + product_categories seeds are required in standard mode too (CRM customers API joins party_groups).
  seedStandardSubgroups(db);
  const cmLegacy = db.prepare("SELECT value FROM settings WHERE key='coa_mode'").get();
  if (cmLegacy?.value === 'mahak') {
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_mode','extended')").run();
  }
  const curBase = db.prepare("SELECT value FROM settings WHERE key='currency_base'").get();
  if (!curBase) db.prepare("INSERT INTO settings (key,value) VALUES ('currency_base','rial')").run();
  const curDisp = db.prepare("SELECT value FROM settings WHERE key='currency_display'").get();
  if (!curDisp) db.prepare("INSERT INTO settings (key,value) VALUES ('currency_display','rial')").run();
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
function audit(userId, action, entity, entityId, detail, reqOrMeta) {
  try {
    let ip = '', ua = '';
    if (reqOrMeta && reqOrMeta.headers) {
      ip = (reqOrMeta.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        reqOrMeta.socket?.remoteAddress || reqOrMeta.ip || '';
      ua = String(reqOrMeta.headers['user-agent'] || '').slice(0, 500);
    } else if (reqOrMeta && typeof reqOrMeta === 'object') {
      ip = reqOrMeta.ip || '';
      ua = String(reqOrMeta.user_agent || '').slice(0, 500);
    }
    getDB().prepare('INSERT INTO audit_log (user_id,action,entity,entity_id,detail,ip_address,user_agent) VALUES (?,?,?,?,?,?,?)')
      .run(userId || null, action, entity, entityId || null, detail || '', ip, ua);
    try {
      const u = userId ? getDB().prepare('SELECT username,name FROM users WHERE id=?').get(userId) : null;
      getDB().prepare(`
        INSERT INTO user_activity_log (user_id, username, action, entity_type, entity_id, ip_address, details)
        VALUES (?,?,?,?,?,?,?)
      `).run(userId || null, u?.username || u?.name || '', action, entity || null, entityId || null, ip, detail || '');
    } catch (_) { /* table may not exist during boot */ }
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
function createJournalEntry(db, opts) {
  const {
    date, description, ref_type, ref_id, created_by, lines,
    fiscal_year_id, voucher_number, voucher_type, status,
    total_debit_rial, total_credit_rial,
  } = opts;
  try {
    const entry = db.prepare(`
      INSERT INTO journal_entries (
        entry_date, description, ref_type, ref_id, created_by,
        fiscal_year_id, voucher_number, voucher_type, status,
        total_debit_rial, total_credit_rial
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      date || '', description || '', ref_type || '', ref_id || null, created_by || null,
      fiscal_year_id || null, voucher_number || null, voucher_type || 'auto', status || 'approved',
      total_debit_rial || 0, total_credit_rial || 0
    );
    const entryId = entry.lastInsertRowid;
    const lineStmt = db.prepare(`
      INSERT INTO journal_lines (entry_id,account_code,account_name,debit,credit,description,line_no,detail_account_id,debit_rial,credit_rial)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `);
    let lineNo = 0;
    for (const line of (lines || [])) {
      lineNo++;
      const dr = line.debit || 0;
      const cr = line.credit || 0;
      lineStmt.run(
        entryId, line.code, line.name, dr, cr, line.description || '', lineNo,
        line.detail_account_id || null,
        line.debit_rial != null ? line.debit_rial : Math.round(dr * 10),
        line.credit_rial != null ? line.credit_rial : Math.round(cr * 10)
      );
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
    // بانک مستقیماً به تفصیلی خودش می‌خورد
    if (bank && bank.coa_code) return { code: bank.coa_code, name: bank.name };
    if (bank) return { code: '1102-' + bank.id, name: bank.name };
  }
  if (cashBoxId) {
    const box = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(cashBoxId);
    if (box && box.coa_code) return { code: box.coa_code, name: box.name };
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
