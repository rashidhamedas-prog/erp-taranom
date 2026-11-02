'use strict';
/**
 * Single uniqueness guard for opening stock (موجودی اول دوره).
 * One live opening per (fiscal year, product, variant, warehouse) across ALL writers:
 * product_opening_stock, P2 opening_stock_lines, warehouse opening receipts, and
 * live inventory_ledger rows with event_type='opening'.
 */
const { LEDGER_LIVE_SQL } = require('./layer-reconcile');

function hasTable(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (_) { return false; }
}

function hasColumn(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch (_) { return false; }
}

function fiscalScope(db, fiscalYearId) {
  try {
    const FP = require('../fiscal-period');
    const id = fiscalYearId || FP.getActiveFiscalYearId(db);
    if (!id) return { fiscalYearId: null, start: null, end: null };
    const fy = db.prepare('SELECT id, start_date, end_date FROM fiscal_years WHERE id=?').get(id);
    if (!fy) return { fiscalYearId: id, start: null, end: null };
    return { fiscalYearId: fy.id, start: fy.start_date || null, end: fy.end_date || null };
  } catch (_) {
    return { fiscalYearId: fiscalYearId || null, start: null, end: null };
  }
}

/**
 * Every live opening source for the combo. Returns
 * { fiscalYearId, ledger:[rows], pos:row|null, p2:[lines], receipts:[moves] }.
 * `excludeLedgerIds` lets a correction ignore rows it is voiding in the same transaction.
 */
function findLiveOpenings(db, { productId, warehouseId, variantId, fiscalYearId, excludeLedgerIds } = {}) {
  const vid = variantId || null;
  const scope = fiscalScope(db, fiscalYearId);
  const exclude = new Set((excludeLedgerIds || []).map(Number));
  const out = { fiscalYearId: scope.fiscalYearId, ledger: [], pos: null, p2: [], receipts: [] };

  const hasVar = hasColumn(db, 'inventory_ledger', 'variant_id');
  if (hasVar || !vid) {
    const params = [productId, warehouseId];
    let sql = `SELECT id, product_id, warehouse_id, ${hasVar ? 'variant_id' : 'NULL AS variant_id'},
        qty_in, unit_cost_rial, amount_rial, je_id, source_type, source_id, date, created_at
      FROM inventory_ledger
      WHERE event_type='opening' AND ${LEDGER_LIVE_SQL}
        AND product_id=? AND warehouse_id=?`;
    if (hasVar) { sql += ' AND COALESCE(variant_id,0)=COALESCE(?,0)'; params.push(vid); }
    if (scope.start) { sql += " AND COALESCE(date,'') >= ?"; params.push(scope.start); }
    if (scope.end) { sql += " AND COALESCE(date,'') <= ?"; params.push(scope.end); }
    sql += ' ORDER BY id';
    out.ledger = db.prepare(sql).all(...params).filter((r) => !exclude.has(Number(r.id)));
  }

  if (hasTable(db, 'product_opening_stock')) {
    out.pos = db.prepare(`
      SELECT * FROM product_opening_stock
      WHERE COALESCE(fiscal_year_id,0)=COALESCE(?,0) AND product_id=? AND warehouse_id=?
        AND COALESCE(variant_id,0)=COALESCE(?,0)
        AND COALESCE(status,'') NOT IN ('void')
      LIMIT 1
    `).get(scope.fiscalYearId, productId, warehouseId, vid) || null;
  }

  if (hasTable(db, 'opening_stock_lines')) {
    out.p2 = db.prepare(`
      SELECT l.id, l.doc_id, l.ledger_id FROM opening_stock_lines l
      WHERE l.active=1 AND COALESCE(l.fiscal_year_id,0)=COALESCE(?,0)
        AND l.product_id=? AND l.warehouse_id=? AND COALESCE(l.variant_id,0)=COALESCE(?,0)
    `).all(scope.fiscalYearId, productId, warehouseId, vid)
      .filter((r) => !exclude.has(Number(r.ledger_id)));
  }

  if (hasTable(db, 'warehouse_moves') && hasTable(db, 'warehouse_docs')) {
    try {
      out.receipts = db.prepare(`
        SELECT m.id, d.num FROM warehouse_moves m
        JOIN warehouse_docs d ON d.id=m.doc_id
        WHERE m.type='receipt' AND d.receipt_class='opening'
          AND COALESCE(d.status,'posted')<>'reversed'
          AND COALESCE(m.status,'posted')<>'reversed'
          AND m.product_id=? AND m.to_warehouse_id=?
          AND COALESCE(m.variant_id,0)=COALESCE(?,0)
      `).all(productId, warehouseId, vid);
    } catch (_) { out.receipts = []; }
  }
  return out;
}

function openingExistsError(found, { productId, warehouseId, variantId }) {
  let ref = '';
  if (found.receipts.length) ref = `سند ${found.receipts[0].num || found.receipts[0].id}`;
  else if (found.ledger.length) ref = `ردیف کاردکس #${found.ledger[0].id}`;
  else if (found.p2.length) ref = `سند افتتاحیه #${found.p2[0].doc_id}`;
  else if (found.pos) ref = `موجودی اول دوره #${found.pos.id}`;
  return Object.assign(new Error(
    `برای این کالا/انبار/واریانت قبلاً موجودی اول دوره ثبت شده است (${ref}) — برای تغییر از «اصلاحیهٔ موجودی اول دوره» استفاده کنید`
  ), {
    status: 409,
    code: 'E_OPENING_EXISTS',
    product_id: productId,
    warehouse_id: warehouseId,
    variant_id: variantId || null,
  });
}

/** Throws 409 E_OPENING_EXISTS if any live opening exists for the combo. */
function assertNoLiveOpening(db, opts = {}) {
  const found = findLiveOpenings(db, opts);
  const pos = opts.ignoreProductOpeningRow ? null : found.pos;
  if (found.ledger.length || found.p2.length || found.receipts.length || pos) {
    throw openingExistsError({ ...found, pos }, opts);
  }
  return found;
}

module.exports = {
  findLiveOpenings,
  assertNoLiveOpening,
  openingExistsError,
  fiscalScope,
};
