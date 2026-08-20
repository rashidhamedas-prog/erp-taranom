'use strict';
/**
 * Inventory module schema — immutable ledger + cost layers + batch/serial +
 * reservations + landed cost. Called from db.js after production schema.
 * R1: money INTEGER _rial. R10: sync tables appended separately.
 */

function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

const INV_SEQUENCES = [
  { key: 'inventory_tx', prefix: 'INV' },
  { key: 'inventory_batch', prefix: 'LOT' },
  { key: 'inventory_serial', prefix: 'SN' },
  { key: 'inventory_reservation', prefix: 'RSV' },
  { key: 'landed_cost', prefix: 'LC' },
];

const INV_SETTINGS = {
  inventory_costing_method: 'moving_average', // moving_average | fifo | specific
  inventory_allow_negative: '0',
  inventory_auto_post_je: '1',
  inventory_batch_required: '0',
  inventory_serial_required: '0',
  inventory_fefo_enabled: '1',
  inventory_reservation_ttl_hours: '72',
};

function createTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_ledger (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_no             TEXT NOT NULL,
      event_type        TEXT NOT NULL,
      product_id        INTEGER NOT NULL,
      warehouse_id      INTEGER,
      qty_in            REAL NOT NULL DEFAULT 0,
      qty_out           REAL NOT NULL DEFAULT 0,
      qty_balance       REAL NOT NULL DEFAULT 0,
      unit_cost_rial    INTEGER NOT NULL DEFAULT 0,
      amount_rial       INTEGER NOT NULL DEFAULT 0,
      avg_cost_after_rial INTEGER NOT NULL DEFAULT 0,
      batch_id          INTEGER,
      serial_id         INTEGER,
      source_type       TEXT DEFAULT '',
      source_id         INTEGER,
      je_id             INTEGER,
      reversed_of       INTEGER,
      status            TEXT NOT NULL DEFAULT 'posted',
      date              TEXT NOT NULL DEFAULT '',
      note              TEXT DEFAULT '',
      created_by        INTEGER,
      created_at        INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(tx_no)
    );
    CREATE INDEX IF NOT EXISTS ix_inv_led_prod ON inventory_ledger(product_id, id);
    CREATE INDEX IF NOT EXISTS ix_inv_led_wh ON inventory_ledger(warehouse_id, id);
    CREATE INDEX IF NOT EXISTS ix_inv_led_src ON inventory_ledger(source_type, source_id);
    CREATE INDEX IF NOT EXISTS ix_inv_led_date ON inventory_ledger(date, id);

    CREATE TABLE IF NOT EXISTS inventory_cost_layers (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id        INTEGER NOT NULL,
      warehouse_id      INTEGER,
      batch_id          INTEGER,
      qty_remaining     REAL NOT NULL DEFAULT 0,
      unit_cost_rial    INTEGER NOT NULL DEFAULT 0,
      amount_rial       INTEGER NOT NULL DEFAULT 0,
      source_type       TEXT DEFAULT '',
      source_id         INTEGER,
      ledger_id         INTEGER,
      received_at       INTEGER DEFAULT (strftime('%s','now')),
      status            TEXT NOT NULL DEFAULT 'open',
      created_at        INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS ix_inv_layer_prod ON inventory_cost_layers(product_id, warehouse_id, status, id);

    CREATE TABLE IF NOT EXISTS inventory_batches (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_no          TEXT NOT NULL,
      product_id        INTEGER NOT NULL,
      warehouse_id      INTEGER,
      supplier_batch    TEXT DEFAULT '',
      mfg_date          TEXT DEFAULT '',
      expiry_date       TEXT DEFAULT '',
      best_before       TEXT DEFAULT '',
      quality_grade     TEXT DEFAULT '',
      qty_on_hand       REAL NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'active',
      note              TEXT DEFAULT '',
      created_by        INTEGER,
      created_at        INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(product_id, batch_no)
    );
    CREATE INDEX IF NOT EXISTS ix_inv_batch_exp ON inventory_batches(product_id, expiry_date, status);

    CREATE TABLE IF NOT EXISTS inventory_serials (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      serial_no         TEXT NOT NULL,
      product_id        INTEGER NOT NULL,
      warehouse_id      INTEGER,
      batch_id          INTEGER,
      status            TEXT NOT NULL DEFAULT 'available',
      warranty_until    TEXT DEFAULT '',
      owner_party_id    INTEGER,
      source_type       TEXT DEFAULT '',
      source_id         INTEGER,
      note              TEXT DEFAULT '',
      created_by        INTEGER,
      created_at        INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(product_id, serial_no)
    );
    CREATE INDEX IF NOT EXISTS ix_inv_serial_st ON inventory_serials(product_id, status);

    CREATE TABLE IF NOT EXISTS inventory_reservations (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_no    TEXT NOT NULL UNIQUE,
      kind              TEXT NOT NULL DEFAULT 'sales',
      product_id        INTEGER NOT NULL,
      warehouse_id      INTEGER,
      qty               REAL NOT NULL,
      qty_released      REAL NOT NULL DEFAULT 0,
      qty_consumed      REAL NOT NULL DEFAULT 0,
      priority          INTEGER NOT NULL DEFAULT 100,
      status            TEXT NOT NULL DEFAULT 'active',
      expires_at        INTEGER,
      source_type       TEXT DEFAULT '',
      source_id         INTEGER,
      batch_id          INTEGER,
      note              TEXT DEFAULT '',
      created_by        INTEGER,
      created_at        INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS ix_inv_rsv_prod ON inventory_reservations(product_id, warehouse_id, status);

    CREATE TABLE IF NOT EXISTS landed_cost_docs (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_no            TEXT NOT NULL UNIQUE,
      purchase_id       INTEGER,
      date              TEXT NOT NULL DEFAULT '',
      currency          TEXT DEFAULT 'IRR',
      status            TEXT NOT NULL DEFAULT 'draft',
      alloc_method      TEXT NOT NULL DEFAULT 'value',
      total_cost_rial   INTEGER NOT NULL DEFAULT 0,
      je_id             INTEGER,
      note              TEXT DEFAULT '',
      created_by        INTEGER,
      created_at        INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS landed_cost_lines (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id            INTEGER NOT NULL,
      cost_type         TEXT NOT NULL,
      amount_rial       INTEGER NOT NULL DEFAULT 0,
      note              TEXT DEFAULT '',
      FOREIGN KEY(doc_id) REFERENCES landed_cost_docs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS landed_cost_allocations (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id            INTEGER NOT NULL,
      product_id        INTEGER NOT NULL,
      warehouse_id      INTEGER,
      qty               REAL NOT NULL DEFAULT 0,
      base_value_rial   INTEGER NOT NULL DEFAULT 0,
      allocated_rial    INTEGER NOT NULL DEFAULT 0,
      ledger_id         INTEGER,
      FOREIGN KEY(doc_id) REFERENCES landed_cost_docs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS ix_lc_doc ON landed_cost_lines(doc_id);
    CREATE INDEX IF NOT EXISTS ix_lc_alloc ON landed_cost_allocations(doc_id);
  `);
}

function seedSequences(db) {
  if (!tableExists(db, 'number_sequences')) return;
  for (const s of INV_SEQUENCES) {
    if (!db.prepare('SELECT 1 FROM number_sequences WHERE key=?').get(s.key)) {
      db.prepare('INSERT INTO number_sequences (key,current_value) VALUES (?,0)').run(s.key);
    }
  }
}

function seedSettings(db) {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)
  `);
  for (const [k, v] of Object.entries(INV_SETTINGS)) ins.run(k, v);
}

function seedAccounts(db) {
  if (!tableExists(db, 'chart_of_accounts')) return;
  const accounts = [
    { code: '6108', name: 'کسری و ضایعات انبار', type: 'expense', parent_code: '6100' },
    { code: '4205', name: 'اضافی انبارگردانی', type: 'income', parent_code: '4200' },
    { code: '1115', name: 'موجودی در راه (حمل)', type: 'asset', parent_code: '1100' },
  ];
  const exists = db.prepare('SELECT 1 FROM chart_of_accounts WHERE code=?');
  const ins = db.prepare(`
    INSERT INTO chart_of_accounts (code, name, type, parent_code) VALUES (?,?,?,?)
  `);
  for (const a of accounts) {
    if (!exists.get(a.code)) {
      try { ins.run(a.code, a.name, a.type, a.parent_code); } catch (_) { /* ignore */ }
    }
  }
}

function ensureExistingColumns(db) {
  if (tableExists(db, 'inventory_batches')) {
    ensureColumn(db, 'inventory_batches', 'kind', "TEXT DEFAULT 'generic'");
    ensureColumn(db, 'inventory_batches', 'color', "TEXT DEFAULT ''");
    ensureColumn(db, 'inventory_batches', 'pattern', "TEXT DEFAULT ''");
    ensureColumn(db, 'inventory_batches', 'width_cm', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'inventory_batches', 'unit', "TEXT DEFAULT ''");
    ensureColumn(db, 'inventory_batches', 'unit_cost_rial', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'inventory_batches', 'supplier_id', 'INTEGER');
    ensureColumn(db, 'inventory_batches', 'qty_received', 'REAL DEFAULT 0');
    ensureColumn(db, 'inventory_batches', 'ledger_id', 'INTEGER');
    ensureColumn(db, 'inventory_batches', 'journal_id', 'INTEGER');
    ensureColumn(db, 'inventory_batches', 'idempotency_key', 'TEXT');
    ensureColumn(db, 'inventory_batches', 'reversed_at', 'INTEGER');
    ensureColumn(db, 'inventory_batches', 'reversed_by', 'INTEGER');
    ensureColumn(db, 'inventory_batches', 'reversal_journal_id', 'INTEGER');
    try {
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_batches_idem ON inventory_batches(idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key <> ''");
    } catch (_) { /* ignore */ }
  }
  if (tableExists(db, 'warehouse_moves')) {
    ensureColumn(db, 'warehouse_moves', 'ledger_id', 'INTEGER');
    ensureColumn(db, 'warehouse_moves', 'unit_cost_rial', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'warehouse_moves', 'amount_rial', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'warehouse_moves', 'je_id', 'INTEGER');
    ensureColumn(db, 'warehouse_moves', 'batch_id', 'INTEGER');
    ensureColumn(db, 'warehouse_moves', 'status', "TEXT DEFAULT 'posted'");
    ensureColumn(db, 'warehouse_moves', 'reversed_at', 'INTEGER');
    ensureColumn(db, 'warehouse_moves', 'reversed_by', 'INTEGER');
  }
  if (tableExists(db, 'stocktaking_sessions')) {
    ensureColumn(db, 'stocktaking_sessions', 'je_id', 'INTEGER');
    ensureColumn(db, 'stocktaking_sessions', 'total_gain_rial', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'stocktaking_sessions', 'total_loss_rial', 'INTEGER DEFAULT 0');
  }
  if (tableExists(db, 'stocktaking_items')) {
    ensureColumn(db, 'stocktaking_items', 'unit_cost_rial', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'stocktaking_items', 'amount_rial', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'stocktaking_items', 'ledger_id', 'INTEGER');
  }
  if (tableExists(db, 'products')) {
    ensureColumn(db, 'products', 'track_batch', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'products', 'track_serial', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'products', 'reorder_point', 'REAL DEFAULT 0');
    ensureColumn(db, 'products', 'safety_stock', 'REAL DEFAULT 0');
    ensureColumn(db, 'products', 'max_stock', 'REAL DEFAULT 0');
  }
}

function initInventorySchema(db) {
  createTables(db);
  ensureExistingColumns(db);
  seedSequences(db);
  seedSettings(db);
  seedAccounts(db);
}

module.exports = {
  initInventorySchema,
  INV_SEQUENCES,
  INV_SETTINGS,
};
