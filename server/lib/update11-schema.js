/**
 * Update 11 — idempotent schema extensions (D1–D4, P2, PR1, W1–W3, T4 bits).
 * Called from db.js initDB after inventory/production schemas.
 */
const { ensureFxTables } = require('./fx-rate');

function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function initUpdate11Schema(db) {
  // ---- B1: product groups are global report labels ----
  ensureColumn(db, 'product_categories', 'is_shared', 'INTEGER NOT NULL DEFAULT 1');
  const sharedFlag = db.prepare("SELECT value FROM settings WHERE key='product_categories_shared_backfill_v1'").get();
  if (!sharedFlag || sharedFlag.value !== '1') {
    try {
      db.prepare('UPDATE product_categories SET is_shared=1 WHERE is_shared IS NULL OR is_shared=0').run();
    } catch (_) { /* ignore */ }
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('product_categories_shared_backfill_v1','1')").run();
  }

  // ---- D2: FX ----
  ensureFxTables(db);
  ensureColumn(db, 'cash_boxes', 'currency', "TEXT DEFAULT 'IRR'");
  ensureColumn(db, 'cash_boxes', 'is_foreign', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'banks', 'currency', "TEXT DEFAULT 'IRR'");
  ensureColumn(db, 'banks', 'is_foreign', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'settlements', 'foreign_amount', 'REAL');
  ensureColumn(db, 'settlements', 'fx_rate_rial', 'INTEGER');
  ensureColumn(db, 'settlements', 'currency', "TEXT DEFAULT 'IRR'");
  ensureColumn(db, 'expense_payments', 'foreign_amount', 'REAL');
  ensureColumn(db, 'expense_payments', 'fx_rate_rial', 'INTEGER');
  ensureColumn(db, 'expense_payments', 'currency', "TEXT DEFAULT 'IRR'");
  ensureColumn(db, 'account_transfers', 'foreign_amount', 'REAL');
  ensureColumn(db, 'account_transfers', 'fx_rate_rial', 'INTEGER');
  ensureColumn(db, 'account_transfers', 'currency', "TEXT DEFAULT 'IRR'");

  // ---- D3: tafsili level 2 ----
  ensureColumn(db, 'journal_lines', 'tafsili2_code', 'TEXT');

  // ---- P2: person positions (report tag) ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);
  ensureColumn(db, 'persons', 'position_id', 'INTEGER');
  ensureColumn(db, 'person_categories', 'is_shared', 'INTEGER NOT NULL DEFAULT 1');

  // ---- PR1: pricing ----
  ensureColumn(db, 'products', 'retail_price', 'REAL DEFAULT 0');
  ensureColumn(db, 'products', 'retail_price_rial', 'INTEGER DEFAULT 0');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pricing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL DEFAULT 'global',
      scope_id INTEGER,
      wholesale_markup_pct REAL NOT NULL DEFAULT 20,
      retail_markup_pct REAL NOT NULL DEFAULT 35,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);
  const prCnt = db.prepare('SELECT COUNT(*) c FROM pricing_rules').get().c;
  if (!prCnt) {
    db.prepare(
      "INSERT INTO pricing_rules (scope,scope_id,wholesale_markup_pct,retail_markup_pct) VALUES ('global',NULL,20,35)"
    ).run();
  }

  // ---- W1 / W2: warehouse costing + negative ----
  ensureColumn(db, 'warehouses', 'allow_negative', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'warehouses', 'costing_method', 'TEXT');
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('costing_scope','global')").run();

  // ---- W3: triple count stocktaking ----
  ensureColumn(db, 'stocktaking_items', 'count1_qty', 'REAL DEFAULT 0');
  ensureColumn(db, 'stocktaking_items', 'count2_qty', 'REAL');
  ensureColumn(db, 'stocktaking_items', 'count3_qty', 'REAL');
  ensureColumn(db, 'stocktaking_items', 'count_tag', 'TEXT');
  ensureColumn(db, 'stocktaking_items', 'confirmed_count', 'INTEGER DEFAULT 1');
  // system_qty / counted_qty already exist — treat as REAL via logic (SQLite affinity)

  // ---- I3: freight allocation method on invoices ----
  ensureColumn(db, 'invoices', 'freight_alloc_method', "TEXT DEFAULT 'amount'");
  ensureColumn(db, 'purchase_invoices', 'freight_alloc_method', "TEXT DEFAULT 'amount'");

  // ---- T4: expense category coa ----
  ensureColumn(db, 'expense_categories', 'coa_code', 'TEXT');
  ensureColumn(db, 'expense_categories', 'parent_id', 'INTEGER');
  ensureColumn(db, 'expense_categories', 'level', 'INTEGER DEFAULT 1');

  // ---- COA FX gain/loss seed (if chart empty of these codes) ----
  try {
    const ins = db.prepare(
      "INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code) VALUES (?,?,?,?)"
    );
    ins.run('4206', 'سود تسعیر ارز', 'income', '42');
    ins.run('6109', 'زیان تسعیر ارز', 'expense', '61');
  } catch (_) { /* chart may differ */ }

  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('update11_schema_v1','1')").run();
}

module.exports = { initUpdate11Schema };
