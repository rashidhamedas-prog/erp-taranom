'use strict';
/**
 * sales.full_pack_mode: required | optional
 * products.full_pack_mode NULL → inherit global.
 * Default: required (+ matrix fallback when no complete pack).
 */
const KEY = 'sales.full_pack_mode';
const VERSION_KEY = 'pack_matrix_schema_v1';

function normalizeMode(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'optional') return 'optional';
  return 'required';
}

function globalFullPackMode(db) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(KEY);
    return normalizeMode(row && row.value);
  } catch (_) {
    return 'required';
  }
}

/**
 * @returns {'required'|'optional'}
 */
function resolveFullPackMode(db, productId) {
  const pid = parseInt(productId, 10);
  if (pid) {
    try {
      const cols = db.prepare('PRAGMA table_info(products)').all();
      if (cols.some((c) => c.name === 'full_pack_mode')) {
        const row = db.prepare('SELECT full_pack_mode FROM products WHERE id=?').get(pid);
        if (row && row.full_pack_mode != null && String(row.full_pack_mode).trim() !== '') {
          return normalizeMode(row.full_pack_mode);
        }
      }
    } catch (_) { /* inherit */ }
  }
  return globalFullPackMode(db);
}

/** Client may sell partial matrix when mode is optional, or when required+privileged. */
function canSellPartialPack(mode, user) {
  if (normalizeMode(mode) === 'optional') return true;
  const role = user && user.role;
  return role === 'admin' || role === 'accounting' || role === 'sales_manager';
}

module.exports = {
  KEY,
  VERSION_KEY,
  normalizeMode,
  globalFullPackMode,
  resolveFullPackMode,
  canSellPartialPack,
};
