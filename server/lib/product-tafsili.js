'use strict';
/**
 * Phase 2 — product tafsili mode (v586).
 *
 * coa_product_tafsili_mode:
 *   legacy_leaf   → current behaviour: 12-digit level-4 under coa_inventory (110401…)
 *   detail_account → no chart_of_accounts row; idempotent detail_accounts
 *                    (category=product, linked_table=products). products.coa_code stays NULL.
 *
 * Never deactivates legacy leaves or rewrites existing products.coa_code.
 */
const { allocTafsili } = require('./coa-map');

const MODE_KEY = 'coa_product_tafsili_mode';
const MODE_LEGACY = 'legacy_leaf';
const MODE_DETAIL = 'detail_account';

function productTafsiliMode(db) {
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key=?').get(MODE_KEY);
    const v = String(r && r.value || '').trim().toLowerCase();
    return v === MODE_DETAIL ? MODE_DETAIL : MODE_LEGACY;
  } catch (_) {
    return MODE_LEGACY;
  }
}

/** Ensure detail_categories.code='product' exists (idempotent). */
function ensureProductDetailCategory(db) {
  try {
    db.prepare("INSERT OR IGNORE INTO detail_categories (code,name) VALUES ('product','کالا')").run();
  } catch (_) { /* table may be mid-boot */ }
  return db.prepare("SELECT id FROM detail_categories WHERE code='product'").get() || null;
}

/**
 * Idempotent detail_accounts row for a product (linked_table=products).
 * @returns {object|null} detail_accounts row
 */
function ensureProductDetailAccount(db, productId, name) {
  const pid = parseInt(productId, 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const existing = db.prepare(
    "SELECT * FROM detail_accounts WHERE linked_table='products' AND linked_id=?"
  ).get(pid);
  if (existing) return existing;

  const cat = ensureProductDetailCategory(db);
  const nm = String(name || '').trim() || ('کالا ' + pid);
  let code = 'PRD-' + String(pid).padStart(5, '0');
  // UNIQUE(code) — bump suffix on rare collision
  for (let i = 0; i < 20; i += 1) {
    const clash = db.prepare('SELECT id FROM detail_accounts WHERE code=?').get(code);
    if (!clash) break;
    code = 'PRD-' + String(pid).padStart(5, '0') + '-' + (i + 1);
  }
  try {
    const r = db.prepare(`
      INSERT INTO detail_accounts (code,name,detail_category_id,linked_table,linked_id,is_active)
      VALUES (?,?,?,?,?,1)
    `).run(code, nm, cat ? cat.id : null, 'products', pid);
    return db.prepare('SELECT * FROM detail_accounts WHERE id=?').get(r.lastInsertRowid);
  } catch (e) {
    // Race / UNIQUE on linked pair — re-read
    const again = db.prepare(
      "SELECT * FROM detail_accounts WHERE linked_table='products' AND linked_id=?"
    ).get(pid);
    if (again) return again;
    try { console.warn('[product-tafsili] ensureProductDetailAccount', e.message); } catch (_) {}
    return null;
  }
}

/**
 * After INSERT products: assign tafsili per mode.
 * legacy_leaf → allocTafsili + products.coa_code (null if warehouse-map guard blocks).
 * detail_account → detail_accounts only; coa_code untouched (NULL for new products).
 * Never throws — product create must succeed.
 */
function assignProductTafsili(db, productId, name) {
  const mode = productTafsiliMode(db);
  if (mode === MODE_DETAIL) {
    ensureProductDetailAccount(db, productId, name);
    return { mode, coa_code: null, detail: true };
  }
  try {
    const cc = allocTafsili(db, 'product', name);
    if (cc) {
      db.prepare('UPDATE products SET coa_code=? WHERE id=?').run(cc, productId);
      return { mode: MODE_LEGACY, coa_code: cc, detail: false };
    }
  } catch (_) { /* guarded / optional */ }
  return { mode: MODE_LEGACY, coa_code: null, detail: false };
}

module.exports = {
  MODE_KEY,
  MODE_LEGACY,
  MODE_DETAIL,
  productTafsiliMode,
  ensureProductDetailCategory,
  ensureProductDetailAccount,
  assignProductTafsili,
};
