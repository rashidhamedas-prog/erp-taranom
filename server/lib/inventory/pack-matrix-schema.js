'use strict';
/**
 * Reversible pack-matrix schema helpers (up/down).
 * Prefer triggers over CHECK rebuild — honors warehouses.allow_negative +
 * settings.inventory_allow_negative (same as trg_ws_no_negative).
 *
 * Precondition for VWS trigger install: no qty < 0 rows (report, do not auto-heal).
 */
const { KEY, VERSION_KEY } = require('./full-pack-settings');

function tableExists(db, name) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name);
}

function columnExists(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch (_) {
    return false;
  }
}

function countNegativeQty(db) {
  const out = { warehouse_stock: 0, variant_warehouse_stock: 0 };
  if (tableExists(db, 'warehouse_stock')) {
    out.warehouse_stock = Number(
      db.prepare('SELECT COUNT(*) AS c FROM warehouse_stock WHERE qty < 0').get()?.c || 0
    );
  }
  if (tableExists(db, 'variant_warehouse_stock')) {
    out.variant_warehouse_stock = Number(
      db.prepare('SELECT COUNT(*) AS c FROM variant_warehouse_stock WHERE qty < 0').get()?.c || 0
    );
  }
  out.total = out.warehouse_stock + out.variant_warehouse_stock;
  return out;
}

function ensureSettingsKey(db) {
  const cur = db.prepare('SELECT value FROM settings WHERE key=?').get(KEY);
  if (!cur) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(KEY, 'required');
  }
}

function ensureProductOverrideColumn(db) {
  if (!tableExists(db, 'products')) return false;
  if (columnExists(db, 'products', 'full_pack_mode')) return false;
  db.exec('ALTER TABLE products ADD COLUMN full_pack_mode TEXT');
  return true;
}

function installVwsTriggers(db) {
  if (!tableExists(db, 'variant_warehouse_stock')) return;
  db.exec(`
    DROP TRIGGER IF EXISTS trg_vws_no_negative;
    DROP TRIGGER IF EXISTS trg_vws_no_negative_ins;
    CREATE TRIGGER trg_vws_no_negative
    BEFORE UPDATE ON variant_warehouse_stock
    WHEN NEW.qty < 0
    BEGIN
      SELECT RAISE(ABORT, 'E_NEGATIVE_STOCK: موجودی واریانت×انبار منفی می‌شود')
      WHERE NOT EXISTS (
        SELECT 1 FROM warehouses w
        WHERE w.id = NEW.warehouse_id AND COALESCE(w.allow_negative, 0) = 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM settings s
        WHERE s.key = 'inventory_allow_negative' AND s.value = '1'
      );
    END;
    CREATE TRIGGER trg_vws_no_negative_ins
    BEFORE INSERT ON variant_warehouse_stock
    WHEN NEW.qty < 0
    BEGIN
      SELECT RAISE(ABORT, 'E_NEGATIVE_STOCK: موجودی واریانت×انبار منفی می‌شود')
      WHERE NOT EXISTS (
        SELECT 1 FROM warehouses w
        WHERE w.id = NEW.warehouse_id AND COALESCE(w.allow_negative, 0) = 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM settings s
        WHERE s.key = 'inventory_allow_negative' AND s.value = '1'
      );
    END;
  `);
}

function dropVwsTriggers(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_vws_no_negative;
    DROP TRIGGER IF EXISTS trg_vws_no_negative_ins;
  `);
}

/**
 * Idempotent up. Returns { ok, skipped?, reason?, negative?, applied }.
 */
function up(db) {
  const negative = countNegativeQty(db);
  if (negative.variant_warehouse_stock > 0) {
    return {
      ok: false,
      skipped: true,
      reason: 'negative_vws_rows',
      negative,
      applied: [],
    };
  }
  const applied = [];
  const run = db.transaction(() => {
    ensureSettingsKey(db);
    applied.push('settings:' + KEY);
    if (ensureProductOverrideColumn(db)) applied.push('products.full_pack_mode');
    installVwsTriggers(db);
    applied.push('trg_vws_no_negative');
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(VERSION_KEY, '1');
    applied.push(VERSION_KEY);
  });
  run();
  return { ok: true, skipped: false, negative, applied };
}

/**
 * Boot-safe: seeds settings + column always; VWS triggers only if no negative VWS.
 */
function ensurePackMatrixSchema(db) {
  try {
    ensureSettingsKey(db);
  } catch (_) { /* settings table missing in bare fixtures */ }
  try {
    ensureProductOverrideColumn(db);
  } catch (_) { /* */ }
  try {
    const neg = countNegativeQty(db);
    if (neg.variant_warehouse_stock === 0) installVwsTriggers(db);
  } catch (_) { /* */ }
  try {
    const ver = db.prepare('SELECT value FROM settings WHERE key=?').get(VERSION_KEY);
    if (!ver) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(VERSION_KEY, '1');
    }
  } catch (_) { /* */ }
}

function down(db) {
  const applied = [];
  const run = db.transaction(() => {
    dropVwsTriggers(db);
    applied.push('drop_trg_vws');
    if (columnExists(db, 'products', 'full_pack_mode')) {
      try {
        db.exec('ALTER TABLE products DROP COLUMN full_pack_mode');
        applied.push('drop products.full_pack_mode');
      } catch (e) {
        applied.push('drop_column_failed:' + (e && e.message));
      }
    }
    db.prepare('DELETE FROM settings WHERE key=?').run(KEY);
    db.prepare('DELETE FROM settings WHERE key=?').run(VERSION_KEY);
    applied.push('delete_settings');
  });
  run();
  return { ok: true, applied };
}

function status(db) {
  const neg = countNegativeQty(db);
  const ver = tableExists(db, 'settings')
    ? db.prepare('SELECT value FROM settings WHERE key=?').get(VERSION_KEY)
    : null;
  const mode = tableExists(db, 'settings')
    ? db.prepare('SELECT value FROM settings WHERE key=?').get(KEY)
    : null;
  const trig = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_vws_no_negative%'"
  ).all().map((r) => r.name);
  return {
    version: ver ? ver.value : null,
    full_pack_mode: mode ? mode.value : null,
    product_override_column: columnExists(db, 'products', 'full_pack_mode'),
    vws_triggers: trig,
    negative: neg,
  };
}

module.exports = {
  up,
  down,
  status,
  ensurePackMatrixSchema,
  countNegativeQty,
  KEY,
  VERSION_KEY,
};
