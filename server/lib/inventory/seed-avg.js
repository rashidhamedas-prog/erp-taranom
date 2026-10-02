'use strict';
/**
 * Give a stocked product a first moving-average when it was stored with qty and no cost.
 * Posts opening inventory (Dr inventory / Cr opening balance) only if that JE is missing.
 * Does not change quantity. Refuses when average_cost_rial is already set (ADR-011).
 */
const { todayJalali } = require('../../jalali');
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
    if (!jeId && qty > 0) {
      jeId = postProductOpeningInventory(db, {
        productId,
        qty,
        unitCostRial: unit,
        userId,
        date: date || todayJalali(),
        description: `بهای اولیه موجودی — ${p.name}`,
      });
    }
    db.prepare('UPDATE products SET average_cost_rial=?, cost=? WHERE id=?')
      .run(unit, Math.round(unit / 10), productId);
    const after = db.prepare('SELECT average_cost_rial, stock FROM products WHERE id=?').get(productId);
    return {
      ok: true,
      product_id: productId,
      name: p.name,
      average_cost_rial: Math.round(Number(after?.average_cost_rial) || 0),
      qty: Number(after?.stock) || 0,
      je_id: jeId,
      journal_posted: !existing && !!jeId,
    };
  })();
}

module.exports = { seedMissingAverageCost };
