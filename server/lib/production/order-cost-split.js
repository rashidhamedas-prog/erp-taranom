'use strict';

/**
 * P2 — تسهیم بهای سفارش چندمحصولی بین محصولات اصلی (رسید نهایی + برگهٔ بها):
 *  ۱) پارچهٔ برش مشترک: Σ cutting_batch_allocations هر محصول (لایه/برش ابطال‌نشدهٔ همین سفارش).
 *  ۲) هزینهٔ مراحل اختصاصی (product_scope='exclusive') مستقیم به همان محصول.
 *  ۳) باقی‌ماندهٔ مجموع به نسبت سهم هر محصول (درصد تعداد / فرمول).
 * بدون ردیف تخصیص، پارچه داخل باقی‌مانده می‌ماند (رفتار قبلی).
 * جمع سطرها دقیقاً برابر total است؛ اختلاف گرد کردن روی residueProductId.
 */

function rial(v) {
  return Math.round(Number(v) || 0);
}

function sharedCutFabricByProduct(db, orderId) {
  const map = new Map();
  try {
    const rows = db.prepare(`
      SELECT a.product_id AS product_id, SUM(COALESCE(a.amount_rial,0)) AS amt
      FROM cutting_batch_allocations a
      JOIN cutting_batches b ON b.id = a.batch_id
      JOIN cutting_lays l ON l.id = b.lay_id
      WHERE l.production_order_id = ?
        AND COALESCE(l.status,'posted') <> 'reversed'
        AND COALESCE(b.status,'posted') <> 'reversed'
      GROUP BY a.product_id
    `).all(orderId);
    for (const r of rows) map.set(Number(r.product_id), rial(r.amt));
  } catch { /* cutting tables may be missing */ }
  return map;
}

function exclusiveStageCostByProduct(db, orderId) {
  const material = new Map();
  const other = new Map();
  try {
    const rows = db.prepare(`
      SELECT scoped_product_id AS product_id,
             SUM(COALESCE(material_added_rial,0)) AS mat,
             SUM(COALESCE(labor_rial,0) + COALESCE(overhead_rial,0) + COALESCE(subcontract_rial,0)) AS oth
      FROM production_order_stages
      WHERE order_id = ? AND status <> 'skipped'
        AND LOWER(COALESCE(product_scope,'shared')) = 'exclusive'
        AND scoped_product_id IS NOT NULL
      GROUP BY scoped_product_id
    `).all(orderId);
    for (const r of rows) {
      material.set(Number(r.product_id), rial(r.mat));
      other.set(Number(r.product_id), rial(r.oth));
    }
  } catch { /* stage scope columns may be missing */ }
  return { material, other };
}

/** اقلام exclusive فرمول (explode)، همان مبنای rollUp. */
function explodeExclusiveByProduct(db, po) {
  const out = {};
  if (!po || !po.bom_id) return out;
  try {
    const { explodeBom, explodeProductScopeForOrder, explodeQtyForOrder } = require('./bom');
    const { backwardQty } = require('./bom-advanced');
    const bom = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(po.bom_id);
    const qtyStart = backwardQty(db, po.bom_id, explodeQtyForOrder(db, po)).qty_start;
    let sizeBreakdown = null;
    try { sizeBreakdown = po.size_breakdown ? JSON.parse(po.size_breakdown) : null; } catch { sizeBreakdown = null; }
    const ex = explodeBom(db, {
      bomId: po.bom_id, qty: qtyStart, priceBasis: 'average',
      yieldOverride: bom && bom.has_routing ? 100 : null,
      sizeBreakdown, color: po.color,
      forProductId: explodeProductScopeForOrder(db, po),
    });
    for (const L of ex.lines || []) {
      if (String(L.product_scope || 'shared') !== 'exclusive' || !L.scoped_product_id) continue;
      const pid = Number(L.scoped_product_id);
      out[pid] = (out[pid] || 0) + rial(L.amount_rial);
    }
  } catch { return {}; }
  return out;
}

/**
 * @param {object} opts
 * @param {number} opts.total           مبلغ قابل تسهیم (خالص WIP پس از فرعی)
 * @param {Array<{product_id:number, pct:number}>} opts.products  pct = سهم باقی‌مانده (جمع ۱۰۰)
 * @param {number} [opts.residueProductId]
 * @param {object} [opts.explodeExclusive]  { [pid]: rial } — اگر نیامد از فرمول محاسبه می‌شود
 */
function splitOrderCost(db, po, opts) {
  const total = rial(opts.total);
  const products = (opts.products || []).map(p => ({
    product_id: Number(p.product_id),
    pct: (opts.products.length === 1) ? 100 : (Number(p.pct) || 0),
  }));
  const pids = new Set(products.map(p => p.product_id));

  const fabricMap = sharedCutFabricByProduct(db, po.id);
  let fabricSum = 0;
  for (const [pid, amt] of fabricMap) if (pids.has(pid)) fabricSum += amt;
  const useAlloc = products.length > 1 && fabricSum > 0;

  const stageEx = exclusiveStageCostByProduct(db, po.id);
  const explodeEx = opts.explodeExclusive || explodeExclusiveByProduct(db, po);

  const rows = products.map((p) => {
    const pid = p.product_id;
    const fabric = useAlloc ? (fabricMap.get(pid) || 0) : 0;
    const exclMat = Math.max(stageEx.material.get(pid) || 0, rial(explodeEx[pid] || explodeEx[String(pid)]));
    const exclusive = products.length > 1 ? (stageEx.other.get(pid) || 0) + exclMat : 0;
    return { product_id: pid, pct: p.pct, fabric_rial: fabric, exclusive_rial: exclusive };
  });

  const direct = rows.reduce((s, r) => s + r.fabric_rial + r.exclusive_rial, 0);
  if (direct > total && direct > 0) {
    const f = Math.max(0, total) / direct;
    for (const r of rows) {
      r.fabric_rial = Math.round(r.fabric_rial * f);
      r.exclusive_rial = Math.round(r.exclusive_rial * f);
    }
  }
  const directAfter = rows.reduce((s, r) => s + r.fabric_rial + r.exclusive_rial, 0);
  const pool = Math.max(0, total - directAfter);
  for (const r of rows) {
    r.shared_rial = Math.round(pool * r.pct / 100);
    r.amount_rial = r.fabric_rial + r.exclusive_rial + r.shared_rial;
  }
  const assigned = rows.reduce((s, r) => s + r.amount_rial, 0);
  const rem = rows.find(r => r.product_id === Number(opts.residueProductId)) || rows[0];
  if (rem && assigned !== total) {
    rem.shared_rial += total - assigned;
    rem.amount_rial += total - assigned;
  }
  return {
    rows,
    pool_rial: pool,
    fabric_source: useAlloc ? 'shared_cut_alloc' : 'qty',
    fabric_alloc_rial: useAlloc ? fabricSum : 0,
  };
}

module.exports = {
  splitOrderCost,
  sharedCutFabricByProduct,
  exclusiveStageCostByProduct,
  explodeExclusiveByProduct,
};
