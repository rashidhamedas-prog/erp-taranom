'use strict';
/**
 * Give a stocked product a first moving-average when it was stored with qty and no cost.
 * Posts the opening value JE (Dr inventory / Cr opening balance) only if that JE is missing,
 * kardex already carries the qty, and no live opening exists (opening-guard).
 * Never writes kardex rows; qty without kardex is reported (needs_opening_doc) for an opening document.
 * Does not change quantity. Refuses when average_cost_rial is already set (ADR-011).
 */
const { postProductOpeningInventory } = require('../opening-post');

function fail(code, status, message, extra) {
  const e = new Error(message || code);
  e.code = code;
  e.status = status;
  if (extra) e.extra = extra;
  return e;
}

function seedMissingAverageCost(db, { productId, unitCostRial, userId, date }) {
  return db.transaction(() => {
    const p = db.prepare('SELECT id, name, stock, average_cost_rial FROM products WHERE id=?').get(productId);
    if (!p) throw fail('E_NOT_FOUND', 404, 'کالا یافت نشد');
    const unit = Math.round(Number(unitCostRial) || 0);
    if (unit <= 0) throw fail('E_UNIT_COST', 422, 'بهای واحد باید بزرگ‌تر از صفر باشد', { name: p.name });
    const avg = Math.round(Number(p.average_cost_rial) || 0);
    if (avg > 0) {
      throw fail('E_AVG_ALREADY_SET', 409, 'بهای میانگین این کالا از قبل ثبت شده', { name: p.name });
    }
    const qty = Math.max(0, Number(p.stock) || 0);
    const existing = db.prepare(`
      SELECT id FROM journal_entries
      WHERE ref_type='opening_inventory' AND ref_id=?
        AND COALESCE(deleted_at,0)=0
        AND COALESCE(status,'posted') NOT IN ('reversed','void')
      LIMIT 1
    `).get(productId);
    let jeId = existing?.id || null;
    // Kardex qty already present (opening/reconcile) → never invent a second qty_in
    // row; that doubled cardex (INV-1187) until stock_reconcile removed it.
    let ledgerNet = 0;
    try {
      ledgerNet = Number(db.prepare(`
        SELECT COALESCE(SUM(qty_in - qty_out), 0) AS s
        FROM inventory_ledger
        WHERE product_id=? AND COALESCE(status,'posted')='posted'
      `).get(productId)?.s) || 0;
    } catch (_) { ledgerNet = 0; }
    const kardexCoversStock = qty > 0 && ledgerNet + 1e-9 >= qty;
    // A receipt already debited the warehouse inventory account (raw 1110 / typed
    // COA). A second «بهای اولیه» into the goods account doubles that asset.
    let alreadyCapitalized = false;
    try {
      alreadyCapitalized = !!db.prepare(`
        SELECT 1 AS ok FROM inventory_ledger
        WHERE product_id=? AND je_id IS NOT NULL
          AND COALESCE(status,'posted')='posted'
          AND COALESCE(source_type,'') != 'opening_inventory'
          AND COALESCE(amount_rial,0) != 0
        LIMIT 1
      `).get(productId);
    } catch (_) { alreadyCapitalized = false; }
    // A live opening (any writer) owns this SKU's first-period qty/value — only set avg.
    let liveOpening = false;
    const whId = db.prepare('SELECT warehouse_id FROM products WHERE id=?').get(productId)?.warehouse_id || null;
    if (whId) {
      try {
        require('./opening-guard').assertNoLiveOpening(db, { productId, warehouseId: whId, variantId: null });
      } catch (e) {
        if (e && e.code === 'E_OPENING_EXISTS') liveOpening = true;
        else throw e;
      }
    }
    // P7: seed never writes an opening kardex row. Kardex already covers the qty ⇒ value JE only;
    // otherwise the qty has no kardex at all ⇒ report it (needs_opening_doc) for «سند موجودی اول دوره».
    let needsOpeningDoc = false;
    if (!jeId && qty > 0 && !alreadyCapitalized && !liveOpening) {
      if (kardexCoversStock) {
        const { fiscalOpeningDate } = require('../opening-post');
        jeId = postProductOpeningInventory(db, {
          productId,
          qty,
          unitCostRial: unit,
          userId,
          date: date || fiscalOpeningDate(db),
          description: `بهای اولیه موجودی — ${p.name}`,
          skipLedger: true,
        });
      } else {
        needsOpeningDoc = true;
      }
    }
    const { catalogCostFromAvgRial } = require('./product-unit-cost');
    db.prepare('UPDATE products SET average_cost_rial=?, cost=? WHERE id=?')
      .run(unit, catalogCostFromAvgRial(unit), productId);
    const after = db.prepare('SELECT average_cost_rial, stock FROM products WHERE id=?').get(productId);
    return {
      ok: true,
      product_id: productId,
      name: p.name,
      average_cost_rial: Math.round(Number(after?.average_cost_rial) || 0),
      qty: Number(after?.stock) || 0,
      je_id: jeId,
      journal_posted: !existing && !!jeId,
      live_opening: liveOpening,
      needs_opening_doc: needsOpeningDoc,
    };
  })();
}

module.exports = { seedMissingAverageCost };
