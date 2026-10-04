'use strict';
/**
 * Route-local schema for the available-to-promise (ATP) gate — NONTAX-P0-atp.
 *
 * Adds ONE non-tax column to `invoices`:
 *   fulfillment_state TEXT DEFAULT ''   ''            → stock handled normally (deducted or proforma)
 *                                       'backorder'   → firm sale accepted by admin/accounting without stock
 *                                       'provisional' → device / offline firm sale, stock not moved locally
 *
 * Migration / rollback note:
 *   - `ALTER TABLE ... ADD COLUMN` is idempotent (PRAGMA table_info guard) and nullable-safe; every
 *     existing invoice keeps '' and behaves exactly as before (stock_deducted is the source of truth
 *     for "was stock moved", fulfillment_state only explains WHY it was not).
 *   - Rollback = ignore the column; nothing else references it. No UPDATE is ever run against old rows.
 *
 * `ensureColumn` is intentionally a local copy of the db.js helper (db.js does not export it and is a
 * claimed file for this task); the pattern is the same one used by lib/inventory/schema.js,
 * lib/payroll/schema.js, lib/crm-pro-schema.js, …
 */

const FULFILLMENT_STATES = Object.freeze({
  DEDUCTED: '',
  BACKORDER: 'backorder',
  PROVISIONAL: 'provisional',
});

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function hasColumn(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  } catch (_) {
    return false;
  }
}

function ensureColumn(db, table, column, definition) {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// One DDL probe per connection; later calls are a WeakSet lookup.
const ensuredHandles = new WeakSet();

/**
 * Idempotent. Safe to call on every request; must be called OUTSIDE an open transaction
 * the first time on a connection (ALTER TABLE inside db.transaction is allowed by SQLite but
 * we keep DDL out of the money path).
 */
function ensureAtpSchema(db) {
  if (!db || ensuredHandles.has(db)) return false;
  if (!tableExists(db, 'invoices')) return false;
  ensureColumn(db, 'invoices', 'fulfillment_state', "TEXT DEFAULT ''");
  ensuredHandles.add(db);
  return true;
}

module.exports = {
  FULFILLMENT_STATES,
  ensureAtpSchema,
  hasColumn,
  tableExists,
};
