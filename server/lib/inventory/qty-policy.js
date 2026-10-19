'use strict';
/**
 * Inventory quantity policy — apparel/piece vs continuous (fabric meters).
 *
 * Invariant:
 * - Matrix SKUs (color×size) and piece units (عدد, …) → INTEGER qty only.
 * - Continuous units (متر, کیلو, …) → REAL with round3 (≤3 decimals).
 *
 * Prevents Update-11 D1 float policy + VWS scale-heal from leaving
 * fractional "pairs of pants" in the ledger.
 */
const { round3, parseQty } = require('../round3');
const { matchText, policyForProduct } = require('../uom');

const CONTINUOUS_UNIT_RE = /متر|یارد|کیلو|kg|گرم|g\b|لیتر|liter|yard|yards|\byd\b|\bm\b|ثانیه|ساعت|roll|طاقه|نوار|پارچه/i;
const PIECE_UNIT_RE = /^(عدد|pcs?|piece|ea|each|جفت|دست|بسته|پک)?$/i;

function tableExists(db, name) {
  try {
    return !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
    ).get(name);
  } catch (_) {
    return false;
  }
}

function hasActiveMatrixVariants(db, productId) {
  if (!productId || !tableExists(db, 'product_variants')) return false;
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM product_variants
    WHERE product_id=? AND active=1 AND COALESCE(is_default,0)=0
  `).get(productId);
  return (Number(row && row.c) || 0) > 0;
}

function productUnit(db, productId) {
  if (!productId || !tableExists(db, 'products')) return '';
  const row = db.prepare('SELECT unit FROM products WHERE id=?').get(productId);
  return row ? String(row.unit || '').trim() : '';
}

/**
 * True when qty must be a whole number (no fractions).
 * Matrix apparel always integer. Continuous unit keywords stay decimal.
 * Default for this clothing ERP: integer when unit empty/عدد.
 */
function requiresIntegerQty(db, productId, unitHint) {
  if (productId && hasActiveMatrixVariants(db, productId)) return true;
  if (db && unitHint != null && String(unitHint).trim()) {
    try {
      const matched = matchText(db, unitHint);
      if (matched) return (matched.dimension || 'count') === 'count';
    } catch (_) { /* catalog not ready */ }
  }
  if (db && productId) {
    try {
      const pol = policyForProduct(db, productId);
      if (pol.known) return pol.dimension === 'count';
    } catch (_) { /* catalog not ready */ }
  }
  const unit = String(unitHint != null ? unitHint : productUnit(db, productId) || '').trim();
  if (CONTINUOUS_UNIT_RE.test(unit)) return false;
  if (!unit || PIECE_UNIT_RE.test(unit)) return true;
  return false;
}

function isIntegerQty(n) {
  const x = Number(n);
  return Number.isFinite(x) && Math.abs(x - Math.round(x)) < 1e-9;
}

/** Normalize for write: integer clamp or round3. */
function normalizeStockQty(qty, opts = {}) {
  const integer = !!opts.integer;
  if (integer) {
    const n = Math.round(Number(qty));
    if (!Number.isFinite(n)) return Math.round(Number(opts.fallback) || 0);
    return n;
  }
  return parseQty(qty, opts.fallback != null ? opts.fallback : 0);
}

/**
 * Parse API/UI qty with product policy.
 * @throws if opts.strict and integer required but value has fraction
 */
function parseStockQty(qty, opts = {}) {
  const integer = opts.integer != null
    ? !!opts.integer
    : (opts.db && opts.productId
      ? requiresIntegerQty(opts.db, opts.productId, opts.unit)
      : false);
  if (integer && opts.strict) {
    const raw = parseQty(qty, opts.fallback != null ? opts.fallback : 0);
    if (!isIntegerQty(raw)) {
      const e = new Error('موجودی کالای قطعه‌ای باید عدد صحیح باشد');
      e.status = 400;
      e.code = 'E_QTY_NOT_INTEGER';
      e.qty = raw;
      throw e;
    }
  }
  return normalizeStockQty(qty, { integer, fallback: opts.fallback });
}

/**
 * Largest-remainder integer allocation.
 * weights[i] ≥ 0; returns integers summing exactly to `total`.
 */
function allocateIntegers(weights, total) {
  const n = weights.length;
  const t = Math.round(Number(total) || 0);
  if (n === 0) return [];
  if (t <= 0) return weights.map(() => 0);
  const w = weights.map((x) => Math.max(0, Number(x) || 0));
  const sumW = w.reduce((a, b) => a + b, 0);
  if (sumW <= 0) {
    const out = weights.map(() => 0);
    out[0] = t;
    return out;
  }
  const raw = w.map((x) => (x / sumW) * t);
  const floors = raw.map((x) => Math.floor(x));
  let rem = t - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = floors.slice();
  for (let k = 0; k < rem; k++) out[order[k].i] += 1;
  return out;
}

/**
 * One-shot heal: piece/matrix projections must match the integer movement ledger.
 *
 * The v238 float reconcile (`qty * global/sum` via round3) rewrote apparel
 * counts into fractions (14 → 6.462) while inventory_movements kept the
 * integers the user saved (opening_seed + transfers). Projection is restored
 * from that ledger. A warehouse row with no movements is a phantom split and
 * returns to 0. Continuous units (متر/کیلو) are left alone.
 *
 * Idempotent via settings key apparel_qty_ledger_heal_v1.
 */
function healApparelIntegerStock(db) {
  if (!tableExists(db, 'settings')) {
    return { skipped: true, reason: 'no_settings' };
  }
  const flag = db.prepare("SELECT value FROM settings WHERE key='apparel_qty_ledger_heal_v1'").get();
  if (flag && String(flag.value) === '1') return { already: true };

  const hasVws = tableExists(db, 'variant_warehouse_stock');
  const hasPv = tableExists(db, 'product_variants');
  const hasWs = tableExists(db, 'warehouse_stock');
  const hasP = tableExists(db, 'products');
  if (!hasP) return { skipped: true, reason: 'no_products' };

  let variantsFixed = 0;
  let productsFixed = 0;
  let vwsFixed = 0;
  let wsFixed = 0;

  const tx = db.transaction(() => {
    if (hasPv && hasVws) {
      const variants = db.prepare(`
        SELECT id, product_id, stock FROM product_variants
        WHERE active=1 AND COALESCE(is_default,0)=0
      `).all();
      const vwsRows = db.prepare(
        'SELECT warehouse_id, qty FROM variant_warehouse_stock WHERE variant_id=?'
      );
      const vwsUpd = db.prepare(
        'UPDATE variant_warehouse_stock SET qty=? WHERE variant_id=? AND warehouse_id=?'
      );
      const varUpd = db.prepare('UPDATE product_variants SET stock=? WHERE id=?');
      const hasMov = tableExists(db, 'inventory_movements');
      const ledWh = hasMov ? db.prepare(`
        SELECT COUNT(*) AS c, COALESCE(SUM(qty_delta),0) AS s
        FROM inventory_movements
        WHERE variant_id=? AND warehouse_id=?
      `) : null;
      const ledVar = hasMov ? db.prepare(
        'SELECT COUNT(*) AS c FROM inventory_movements WHERE variant_id=?'
      ) : null;
      const sumVar = db.prepare(
        'SELECT COALESCE(SUM(qty),0) AS s FROM variant_warehouse_stock WHERE variant_id=?'
      );

      const dirtyProducts = new Set();
      for (const v of variants) {
        if (!requiresIntegerQty(db, v.product_id)) continue;
        const rows = vwsRows.all(v.id);
        const needs = rows.some((r) => !isIntegerQty(r.qty)) || !isIntegerQty(v.stock);
        if (!needs) continue;
        dirtyProducts.add(v.product_id);
        if (!rows.length) {
          const rounded = Math.round(Number(v.stock) || 0);
          if (Number(v.stock) !== rounded) {
            varUpd.run(rounded, v.id);
            variantsFixed += 1;
          }
          continue;
        }
        const variantHasLedger = ledVar ? (Number(ledVar.get(v.id).c) || 0) > 0 : false;
        let changed = false;
        for (const r of rows) {
          let target;
          if (ledWh) {
            const st = ledWh.get(v.id, r.warehouse_id);
            const c = Number(st && st.c) || 0;
            if (c > 0) target = Math.round(Number(st.s) || 0);
            else if (variantHasLedger) target = 0;
            else target = Math.round(Number(r.qty) || 0);
          } else {
            target = Math.round(Number(r.qty) || 0);
          }
          if (Number(r.qty) !== target) {
            vwsUpd.run(target, v.id, r.warehouse_id);
            vwsFixed += 1;
            changed = true;
          }
        }
        const total = Math.round(Number(sumVar.get(v.id).s) || 0);
        if (Number(v.stock) !== total) {
          varUpd.run(total, v.id);
          changed = true;
        }
        if (changed) variantsFixed += 1;
      }

      // Rebuild warehouse_stock + products.stock only for matrix products
      // whose piece projection was fractional. Healthy integer rows are not
      // rewritten, so sync triggers do not fire for unchanged stock.
      if (hasWs) {
        const fracWs = db.prepare(`
          SELECT DISTINCT product_id AS id FROM warehouse_stock
          WHERE ABS(qty - ROUND(qty)) > 0.0001
        `).all();
        for (const row of fracWs) dirtyProducts.add(row.id);
      }
      const fracHead = db.prepare(`
        SELECT id FROM products WHERE ABS(stock - ROUND(stock)) > 0.0001
      `).all();
      for (const row of fracHead) {
        if (hasActiveMatrixVariants(db, row.id)) dirtyProducts.add(row.id);
      }

      const sumByWh = db.prepare(`
        SELECT vws.warehouse_id AS warehouse_id, COALESCE(SUM(vws.qty),0) AS qty
        FROM variant_warehouse_stock vws
        JOIN product_variants pv ON pv.id=vws.variant_id
        WHERE pv.product_id=? AND COALESCE(pv.is_default,0)=0 AND pv.active=1
        GROUP BY vws.warehouse_id
      `);
      const wsCur = hasWs ? db.prepare(
        'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
      ) : null;
      const wsUpsert = hasWs ? db.prepare(`
        INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)
        ON CONFLICT(product_id, warehouse_id) DO UPDATE SET qty=excluded.qty
      `) : null;
      const prodCur = db.prepare('SELECT stock FROM products WHERE id=?');
      const prodUpd = db.prepare('UPDATE products SET stock=? WHERE id=?');

      for (const productId of dirtyProducts) {
        if (!requiresIntegerQty(db, productId)) continue;
        const whs = sumByWh.all(productId);
        let total = 0;
        for (const w of whs) {
          const q = Math.round(Number(w.qty) || 0);
          total += q;
          if (!wsUpsert) continue;
          const cur = wsCur.get(productId, w.warehouse_id);
          if (!cur || Number(cur.qty) !== q) {
            wsUpsert.run(productId, w.warehouse_id, q);
            wsFixed += 1;
          }
        }
        const head = prodCur.get(productId);
        if (head && Number(head.stock) !== total) {
          prodUpd.run(total, productId);
          productsFixed += 1;
        }
      }
    }

    // Non-matrix piece products: ledger when movements exist, else nearest integer
    if (hasWs) {
      const piece = db.prepare(`
        SELECT id, stock, unit FROM products
        WHERE ABS(stock - ROUND(stock)) > 0.0001
      `).all();
      const wsAll = db.prepare(
        'SELECT warehouse_id, qty FROM warehouse_stock WHERE product_id=?'
      );
      const wsUpd = db.prepare(
        'UPDATE warehouse_stock SET qty=? WHERE product_id=? AND warehouse_id=?'
      );
      const prodUpd = db.prepare('UPDATE products SET stock=? WHERE id=?');
      const ledWh = tableExists(db, 'inventory_movements') ? db.prepare(`
        SELECT COUNT(*) AS c, COALESCE(SUM(qty_delta),0) AS s
        FROM inventory_movements
        WHERE product_id=? AND warehouse_id=? AND variant_id IS NULL
      `) : null;
      const ledProd = tableExists(db, 'inventory_movements') ? db.prepare(`
        SELECT COUNT(*) AS c FROM inventory_movements
        WHERE product_id=? AND variant_id IS NULL
      `) : null;
      for (const p of piece) {
        if (hasActiveMatrixVariants(db, p.id)) continue;
        if (!requiresIntegerQty(db, p.id, p.unit)) continue;
        const rows = wsAll.all(p.id);
        const productHasLedger = ledProd ? (Number(ledProd.get(p.id).c) || 0) > 0 : false;
        if (rows.length) {
          let total = 0;
          rows.forEach((r) => {
            let target;
            if (ledWh) {
              const st = ledWh.get(p.id, r.warehouse_id);
              const c = Number(st && st.c) || 0;
              if (c > 0) target = Math.round(Number(st.s) || 0);
              else if (productHasLedger) target = 0;
              else target = Math.round(Number(r.qty) || 0);
            } else {
              target = Math.round(Number(r.qty) || 0);
            }
            total += target;
            if (Number(r.qty) !== target) {
              wsUpd.run(target, p.id, r.warehouse_id);
              wsFixed += 1;
            }
          });
          if (Number(p.stock) !== total) {
            prodUpd.run(total, p.id);
            productsFixed += 1;
          }
        } else {
          const rounded = Math.round(Number(p.stock) || 0);
          if (Number(p.stock) !== rounded) {
            prodUpd.run(rounded, p.id);
            productsFixed += 1;
          }
        }
      }
    } else {
      const piece = db.prepare(`
        SELECT id, stock, unit FROM products
        WHERE ABS(stock - ROUND(stock)) > 0.0001
      `).all();
      const prodUpd = db.prepare('UPDATE products SET stock=? WHERE id=?');
      for (const p of piece) {
        if (!requiresIntegerQty(db, p.id, p.unit)) continue;
        prodUpd.run(Math.round(Number(p.stock) || 0), p.id);
        productsFixed += 1;
      }
    }

    db.prepare(
      "INSERT OR REPLACE INTO settings (key,value) VALUES ('apparel_qty_ledger_heal_v1','1')"
    ).run();
  });
  tx();

  return { variantsFixed, productsFixed, vwsFixed, wsFixed };
}

module.exports = {
  CONTINUOUS_UNIT_RE,
  PIECE_UNIT_RE,
  requiresIntegerQty,
  hasActiveMatrixVariants,
  isIntegerQty,
  normalizeStockQty,
  parseStockQty,
  allocateIntegers,
  healApparelIntegerStock,
  round3,
  parseQty,
};
