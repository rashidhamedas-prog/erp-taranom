'use strict';

/**
 * P2 — تسهیم بهای سفارش چندمحصولی بین محصولات اصلی (رسید نهایی + برگهٔ بها):
 *  ۱) پارچهٔ برش مشترک: Σ cutting_batch_allocations هر محصول (لایه/برش ابطال‌نشدهٔ همین سفارش).
 *     لایهٔ کلاسیک سفارش چندفرمولی: اگر پارچه فقط در فرمول یک محصول باشد، کل بها به همان محصول.
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

/**
 * فقط سفارش چندفرمولی (peer): فرمول تک‌محصولیِ چندمحصولی اقلام اختصاصی را
 * از explodeExclusiveByProduct می‌گیرد؛ اینجا [] تا دوبار شمرده نشود.
 */
function layFabricOwnerProducts(db, po, fabricProductId, productIds) {
  const fid = Number(fabricProductId);
  if (!fid) return [];
  const peers = require('./bom').orderBomPeerLines(po);
  if (!peers) return [];
  const want = new Set((productIds || []).map(Number));
  const owners = [];
  try {
    const st = db.prepare('SELECT 1 FROM bom_lines WHERE bom_id=? AND component_product_id=? LIMIT 1');
    for (const p of peers) {
      const pid = Number(p.product_id);
      if (!want.has(pid) || owners.includes(pid)) continue;
      if (st.get(p.bom_id, fid)) owners.push(pid);
    }
  } catch { return []; }
  return owners;
}

/**
 * بهای خالص لایه‌های کلاسیک (بدون batch) که پارچه‌شان فقط در فرمول یک محصول است.
 * ضایعات غیرعادی لایهٔ کلاسیک با PRD-09 از WIP خارج شده، پس از مبلغ کم می‌شود.
 */
function layFabricByProduct(db, po, productIds) {
  const map = new Map();
  if (!po || !require('./bom').orderBomPeerLines(po)) return map;
  let lays = [];
  try {
    lays = db.prepare(`
      SELECT fabric_product_id,
             SUM(MAX(0, COALESCE(amount_rial,0) - COALESCE(waste_amount_rial,0))) AS amt
      FROM cutting_lays
      WHERE production_order_id = ?
        AND COALESCE(status,'posted') = 'posted'
        AND COALESCE(batch_id,0) = 0
        AND fabric_product_id IS NOT NULL
      GROUP BY fabric_product_id
    `).all(po.id);
  } catch { return map; /* cutting tables may be missing */ }
  for (const L of lays) {
    const owners = layFabricOwnerProducts(db, po, L.fabric_product_id, productIds);
    if (owners.length !== 1) continue;
    const amt = rial(L.amt);
    if (!amt) continue;
    map.set(owners[0], (map.get(owners[0]) || 0) + amt);
  }
  return map;
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

  const layMap = products.length > 1 ? layFabricByProduct(db, po, [...pids]) : new Map();
  let laySum = 0;
  for (const [pid, amt] of layMap) if (pids.has(pid)) laySum += amt;
  const useLay = laySum > 0;

  const stageEx = exclusiveStageCostByProduct(db, po.id);
  const explodeEx = opts.explodeExclusive || explodeExclusiveByProduct(db, po);

  const rows = products.map((p) => {
    const pid = p.product_id;
    const cut = useAlloc ? (fabricMap.get(pid) || 0) : 0;
    const lay = useLay ? (layMap.get(pid) || 0) : 0;
    const exclMat = Math.max(stageEx.material.get(pid) || 0, rial(explodeEx[pid] || explodeEx[String(pid)]));
    const exclusive = products.length > 1 ? (stageEx.other.get(pid) || 0) + exclMat : 0;
    return {
      product_id: pid, pct: p.pct, fabric_rial: cut + lay, lay_fabric_rial: lay, exclusive_rial: exclusive,
    };
  });

  const direct = rows.reduce((s, r) => s + r.fabric_rial + r.exclusive_rial, 0);
  if (direct > total && direct > 0) {
    const f = Math.max(0, total) / direct;
    for (const r of rows) {
      r.fabric_rial = Math.round(r.fabric_rial * f);
      r.lay_fabric_rial = Math.min(r.fabric_rial, Math.round(r.lay_fabric_rial * f));
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
  let fabricSource = 'qty';
  if (useAlloc && useLay) fabricSource = 'shared_cut_alloc+lay_bom';
  else if (useAlloc) fabricSource = 'shared_cut_alloc';
  else if (useLay) fabricSource = 'lay_bom';
  return {
    rows,
    pool_rial: pool,
    fabric_source: fabricSource,
    fabric_alloc_rial: useAlloc ? fabricSum : 0,
    lay_fabric_rial: rows.reduce((s, r) => s + r.lay_fabric_rial, 0),
  };
}

/** همان تعریف محصولات اصلی و سهم رسید نهایی (engine-advanced). */
function orderMainShareOuts(db, po) {
  const bom = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(po.bom_id);
  const outs = db.prepare('SELECT * FROM bom_outputs WHERE bom_id=?').all(po.bom_id);
  // v423: تسهیم WIP بین محصولات اصلی مستقل (peer mains)
  const peerLines = require('./bom').orderBomPeerLines(po);
  let shareOuts = outs.filter(x => ['main', 'co'].includes(x.output_type));
  if (peerLines) {
    const sumQ = peerLines.reduce((s, p) => s + (Number(p.qty_planned) || 0), 0) || 1;
    shareOuts = peerLines.map((p) => ({
      output_type: 'main',
      product_id: p.product_id,
      qty_per_base: p.qty_planned,
      cost_share_percent: ((Number(p.qty_planned) || 0) / sumQ) * 100,
      _peer_qty: Number(p.qty_planned) || 0,
    }));
  }
  if (!shareOuts.length) {
    shareOuts = [{
      output_type: 'main', product_id: po.product_id,
      qty_per_base: 1, cost_share_percent: 100,
    }];
  }
  const residueProductId = shareOuts.some(o => Number(o.product_id) === Number(po.product_id))
    ? Number(po.product_id)
    : (shareOuts.some(o => Number(o.product_id) === Number(bom?.product_id))
      ? Number(bom.product_id) : Number(shareOuts[0].product_id));
  return { shareOuts, residueProductId };
}

/** هدف رسید هر محصول اصلی؛ تک‌محصولی → null. */
function receiptTargetsByProduct(db, po, total) {
  const { shareOuts, residueProductId } = orderMainShareOuts(db, po);
  if (shareOuts.length < 2) return null;
  const split = splitOrderCost(db, po, {
    total,
    products: shareOuts.map(o => ({ product_id: o.product_id, pct: o.cost_share_percent })),
    residueProductId,
  });
  return {
    rows: split.rows,
    pool_rial: split.pool_rial,
    fabric_source: split.fabric_source,
    lay_fabric_rial: split.lay_fabric_rial,
    residueProductId,
  };
}

module.exports = {
  splitOrderCost,
  layFabricOwnerProducts,
  layFabricByProduct,
  orderMainShareOuts,
  receiptTargetsByProduct,
  sharedCutFabricByProduct,
  exclusiveStageCostByProduct,
  explodeExclusiveByProduct,
};
