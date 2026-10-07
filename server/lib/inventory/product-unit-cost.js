'use strict';
/**
 * Canonical product unit cost in Rial (money.js / currency_base=rial).
 *
 * products.cost and products.average_cost_rial are both INTEGER Rial after
 * currency_rial_migration_v1. Legacy paths still treated cost as Toman
 * (×10 on read, ÷10 on write) and inflated warehouse valuation 10× when
 * average_cost_rial was unset (e.g. catalog-only بها).
 */
const FLAG = 'product_cost_rial_unify_v333';

/** Moving average if set; else catalog cost — both already Rial. */
function productUnitCostRial(prod) {
  const avg = Math.round(Number(prod && prod.average_cost_rial) || 0);
  if (avg > 0) return avg;
  return Math.round(Number(prod && prod.cost) || 0);
}

/** Keep catalog cost in the same Rial unit as the moving average. */
function catalogCostFromAvgRial(avgRial) {
  return Math.round(Number(avgRial) || 0);
}

/**
 * One-shot heal:
 * - avg==0 & cost>0 → seed average from catalog cost (Rial)
 * - avg == cost*10 → legacy dual-write or mistaken ×10:
 *   if avg ≫ sell price, trust catalog cost and shrink avg;
 *   else promote cost up to avg (toman shadow → rial).
 */
function healProductCostRialUnits(db) {
  if (process.env.SYNC_ROLE === 'device') {
    return { skipped: true, reason: 'device' };
  }
  const done = db.prepare('SELECT value FROM settings WHERE key=?').get(FLAG);
  if (done && String(done.value) === '1') {
    return { skipped: true, reason: 'already' };
  }
  const cols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
  if (!cols.includes('average_cost_rial') || !cols.includes('cost')) {
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(FLAG, '1');
    return { skipped: true, reason: 'no-columns' };
  }
  const hasPrice = cols.includes('price');
  const rows = db.prepare(`
    SELECT id, cost, average_cost_rial${hasPrice ? ', price' : ''}
    FROM products
    WHERE COALESCE(cost,0) > 0 OR COALESCE(average_cost_rial,0) > 0
  `).all();
  let seededAvg = 0;
  let promotedCost = 0;
  let shrunkAvg = 0;
  const updAvg = db.prepare('UPDATE products SET average_cost_rial=? WHERE id=?');
  const updCost = db.prepare('UPDATE products SET cost=? WHERE id=?');
  db.transaction(() => {
    for (const p of rows) {
      const cost = Math.round(Number(p.cost) || 0);
      const avg = Math.round(Number(p.average_cost_rial) || 0);
      const price = hasPrice ? Math.round(Number(p.price) || 0) : 0;
      if (avg <= 0 && cost > 0) {
        updAvg.run(cost, p.id);
        seededAvg += 1;
        continue;
      }
      if (avg > 0 && cost > 0 && avg === cost * 10) {
        if (price > 0 && avg > price * 3) {
          updAvg.run(cost, p.id);
          shrunkAvg += 1;
        } else {
          updCost.run(avg, p.id);
          promotedCost += 1;
        }
      }
    }
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(FLAG, '1');
  })();
  return { ok: true, seededAvg, promotedCost, shrunkAvg };
}

module.exports = {
  productUnitCostRial,
  catalogCostFromAvgRial,
  healProductCostRialUnits,
  PRODUCT_COST_RIAL_UNIFY_FLAG: FLAG,
};
