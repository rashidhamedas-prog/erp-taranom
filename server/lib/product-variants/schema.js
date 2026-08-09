'use strict';
/**
 * P0-APP1 — Product Style / Color / Size / Variant (SKU) schema.
 * ORCH must call initProductVariantsSchema(db) from server/db.js before the
 * second ensureSyncColumnsForAllTables pass (see ORCH-DB.md).
 */

function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function tableExists(db, table) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(table);
}

const VARIANT_TABLES = [
  'product_colors',
  'product_sizes',
  'product_style_colors',
  'product_style_sizes',
  'product_variants',
];

function createTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_colors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT,
      name TEXT NOT NULL,
      hex TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS product_sizes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS product_style_colors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      color_id INTEGER NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(product_id, color_id),
      FOREIGN KEY(product_id) REFERENCES products(id),
      FOREIGN KEY(color_id) REFERENCES product_colors(id)
    );

    CREATE TABLE IF NOT EXISTS product_style_sizes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      size_id INTEGER NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(product_id, size_id),
      FOREIGN KEY(product_id) REFERENCES products(id),
      FOREIGN KEY(size_id) REFERENCES product_sizes(id)
    );

    CREATE TABLE IF NOT EXISTS product_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      color_id INTEGER,
      size_id INTEGER,
      sku TEXT,
      barcode TEXT,
      price REAL DEFAULT 0,
      price_rial INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      stock REAL DEFAULT 0,
      weight REAL DEFAULT 0,
      status TEXT DEFAULT 'active',
      is_default INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      note TEXT DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(product_id) REFERENCES products(id),
      FOREIGN KEY(color_id) REFERENCES product_colors(id),
      FOREIGN KEY(size_id) REFERENCES product_sizes(id)
    );

    CREATE INDEX IF NOT EXISTS idx_pv_product ON product_variants(product_id);
    CREATE INDEX IF NOT EXISTS idx_pv_sku ON product_variants(sku);
    CREATE INDEX IF NOT EXISTS idx_pv_barcode ON product_variants(barcode);
    CREATE INDEX IF NOT EXISTS idx_pv_color ON product_variants(color_id);
    CREATE INDEX IF NOT EXISTS idx_pv_size ON product_variants(size_id);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_pv_default
      ON product_variants(product_id) WHERE is_default = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_pv_matrix
      ON product_variants(product_id, color_id, size_id)
      WHERE color_id IS NOT NULL AND size_id IS NOT NULL AND active = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_product_colors_code
      ON product_colors(code) WHERE code IS NOT NULL AND code <> '';
    CREATE UNIQUE INDEX IF NOT EXISTS ux_product_sizes_code
      ON product_sizes(code) WHERE code IS NOT NULL AND code <> '';
  `);
}

function ensureProductStyleColumns(db) {
  if (!tableExists(db, 'products')) return;
  ensureColumn(db, 'products', 'is_style', 'INTEGER DEFAULT 1');
  ensureColumn(db, 'products', 'has_variants', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'products', 'default_variant_id', 'INTEGER');
}

/** Add sync_seq/version so tables work even before ORCH re-runs ensureSyncColumns. */
function ensureVariantSyncColumns(db) {
  for (const name of VARIANT_TABLES) {
    if (!tableExists(db, name)) continue;
    ensureColumn(db, name, 'sync_seq', 'INTEGER');
    ensureColumn(db, name, 'version', 'INTEGER DEFAULT 0');
    try {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${name}_sync_seq ON ${name}(sync_seq)`);
    } catch (_) { /* ignore */ }
  }
}

/**
 * Existing products row = style. Create a default variant carrying legacy
 * price/stock/barcode so ledger product_id identity is preserved.
 */
function migrateExistingProductsToDefaultVariants(db) {
  if (!tableExists(db, 'products') || !tableExists(db, 'product_variants')) return { created: 0 };

  const flag = db.prepare(
    "SELECT value FROM settings WHERE key='product_variants_default_migrate_v1'"
  ).get();
  if (flag && flag.value === '1') return { created: 0, skipped: true };

  const products = db.prepare('SELECT id, code, barcode, price, price_rial, cost, stock FROM products').all();
  const hasDefault = db.prepare(
    'SELECT id FROM product_variants WHERE product_id=? AND is_default=1 LIMIT 1'
  );
  const insert = db.prepare(`
    INSERT INTO product_variants (
      product_id, color_id, size_id, sku, barcode, price, price_rial, cost, stock,
      status, is_default, active
    ) VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, 'active', 1, 1)
  `);
  const setDefault = db.prepare(
    'UPDATE products SET is_style=1, default_variant_id=?, has_variants=COALESCE(has_variants,0) WHERE id=?'
  );

  let created = 0;
  const tx = db.transaction(() => {
    for (const p of products) {
      const existing = hasDefault.get(p.id);
      if (existing) {
        setDefault.run(existing.id, p.id);
        continue;
      }
      const sku = (p.code && String(p.code).trim()) || `STY-${p.id}`;
      const priceRial = p.price_rial != null
        ? Math.round(Number(p.price_rial) || 0)
        : Math.round(Number(p.price) || 0);
      const r = insert.run(
        p.id,
        sku,
        p.barcode || null,
        Number(p.price) || 0,
        priceRial,
        Number(p.cost) || 0,
        Number(p.stock) || 0
      );
      setDefault.run(r.lastInsertRowid, p.id);
      created += 1;
    }
    db.prepare(
      "INSERT OR REPLACE INTO settings (key,value) VALUES ('product_variants_default_migrate_v1','1')"
    ).run();
  });
  tx();
  return { created };
}

function initProductVariantsSchema(db) {
  createTables(db);
  ensureProductStyleColumns(db);
  ensureVariantSyncColumns(db);
  return migrateExistingProductsToDefaultVariants(db);
}

module.exports = {
  VARIANT_TABLES,
  initProductVariantsSchema,
  migrateExistingProductsToDefaultVariants,
  ensureProductStyleColumns,
  ensureVariantSyncColumns,
  tableExists,
  ensureColumn,
};
