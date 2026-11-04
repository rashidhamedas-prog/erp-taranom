'use strict';
/**
 * Production Module 7/8 — Advanced fixed & variable stage execution
 */
const { allocateNumber, audit } = require('../../db');
const { todayJalali } = require('../../jalali');
const { assertFiscalYearWritable } = require('../fiscal-period');
const { explodeBom, explodeProductScopeForOrder, explodeQtyForOrder, isMultiproductBom, orderFgQtyMap, orderBomPeerLines, orderQtyAsMainBase } = require('./bom');
const { backwardQty, planScopedStageQtys, stageLabor, stageDriverQty } = require('./bom-advanced');
const { dr, cr, plug, postEvent, reverseEvent, err } = require('./posting');
const {
  issueFromStock, updateMovingAverage, receiveScrap, reverseIssueStock, setting, getWhQty,
} = require('./costing');
const {
  getOverheadRate, coerceDriver, appliedOverheadRial, findPostedApplication,
  bumpRateApplied, reverseAppliedOverheadCounters,
} = require('./overhead');
const {
  postLabor,
  absorbLaborJournal,
  formatLaborJeDescription,
  loadPersonForLabor,
  productLabelForOrder,
  retirePersonLaborForEntries,
} = require('./labor');
const { jalaliPeriod, wipResidual, assertPeriodOpen } = require('./engine');
const { applyDocumentCosts } = require('./order-cost-reconcile');
const {
  assertFabricIssueAllowed,
  relieveStagedPackQty,
  orderRequiresFabricCutting,
  cuttingQtyForOrder,
  cuttingQtyForOrderProduct,
  cuttingFabricCoverage,
  isRollFabricProduct,
  rollFabricUnitLabel,
} = require('./cutting');

function num(v) { return Number(v) || 0; }
function round6(n) { return Math.round(Number(n) * 1e6) / 1e6; }

/** پارچهٔ طاقه‌ای (واحد طولی یا طاقهٔ متری/یاردی). null اگر این کالا از مسیر طاقه مصرف نمی‌شود. */
function lengthFabricProduct(db, productId) {
  const prod = db.prepare('SELECT id, name, unit, unit_id FROM products WHERE id=?').get(Number(productId));
  if (!prod || !isRollFabricProduct(db, prod)) return null;
  return { ...prod, unit_label: rollFabricUnitLabel(db, prod) };
}

/**
 * W3 — اگر سفارش پارچهٔ متری است، تکمیل/خروجی هر مرحلهٔ بعد از برش
 * فقط وقتی لایه‌چینی (qty_pieces) حداقل به اندازهٔ برنامهٔ سفارش باشد.
 */
function assertLayCompleteBeforePostCutStage(db, po, stage) {
  if (!orderRequiresFabricCutting(db, po)) return;
  const cut = resolveCuttingStage(db, po.id);
  if (!cut) return;
  if (Number(stage.id) === Number(cut.id)) return;
  if (Number(stage.seq) <= Number(cut.seq)) return;
  const { orderFgPlanRows } = require('./bom');
  let need = Number(po.qty_planned) || 0;
  try {
    const rows = orderFgPlanRows(db, po);
    if (rows && rows.length > 1) {
      need = rows.reduce((s, r) => s + (Number(r.qty_planned) || 0), 0);
    }
  } catch { /* keep header qty */ }
  const { lay_qty } = cuttingQtyForOrder(db, po.id);
  if (lay_qty + 1e-9 < need) {
    throw err('E_LAY_BEFORE_NEXT_STAGE', 409, {
      need, lay_qty, order_id: po.id, stage_seq: stage.seq, cut_seq: cut.seq,
      message: `قبل از مرحلهٔ بعد از برش، لایه‌چینی برای حداقل ${need} قطعه لازم است (فعلی: ${lay_qty})`,
    });
  }
}

/**
 * خروجی خودِ مرحلهٔ برش: پارچهٔ طولی از حواله/backflush نمی‌آید.
 * تا وقتی لایه‌چینی به اندازهٔ خروجی سالم نباشد، مرحله تکمیل نمی‌شود.
 */
function assertCuttingOutputHasLay(db, po, stage, qtyOut) {
  const cut = resolveCuttingStage(db, po.id);
  if (!cut || Number(stage.id) !== Number(cut.id)) return;
  const lines = stageMaterialLines(db, po, stage);
  if (!lines.some((L) => lengthFabricProduct(db, L.product_id))) return;
  const cov = cuttingStageCoverage(db, po, stage);
  if (cov.covered) return;
  throw err('E_LAY_REQUIRED_ON_CUT', 409, {
    need: cov.need,
    lay_qty: cov.lay_qty,
    order_id: po.id,
    stage_id: stage.id,
    qty_out: num(qtyOut),
    fabrics: cov.fabrics,
    missing_fabrics: cov.missing_fabrics,
    message: cov.message,
  });
}

/**
 * پوشش برش در برابر برنامهٔ سفارش.
 * چندمحصول: هر محصول جدا. تک‌محصول: جمع قطعه‌های لایه با ورودی برنامه‌ای مرحله.
 * برابر بودن لازم است؛ کمتر مرحله را نمی‌بندد و بیشتر هم به‌جای سفارش قبول نمی‌شود.
 */
function cuttingStageCoverage(db, po, stage) {
  const { orderBomPeerLines } = require('./bom');
  const peers = orderBomPeerLines(po);
  const products = [];
  if (peers && peers.length) {
    for (const line of peers) {
      const q = cuttingQtyForOrderProduct(db, po.id, line.product_id);
      const name = db.prepare('SELECT name FROM products WHERE id=?').get(line.product_id)?.name || ('#' + line.product_id);
      products.push({
        product_id: line.product_id,
        name,
        need: Number(line.qty_planned) || 0,
        lay_qty: Number(q.lay_qty) || 0,
      });
    }
  } else {
    const need = num(stage && stage.qty_planned_in) > 0
      ? num(stage.qty_planned_in)
      : (num(po.qty_planned) || num(stage && stage.qty_in));
    const name = db.prepare('SELECT name FROM products WHERE id=?').get(po.product_id)?.name || '';
    products.push({
      product_id: po.product_id,
      name,
      need,
      lay_qty: cuttingQtyForOrder(db, po.id).lay_qty,
    });
  }
  const need = products.reduce((s, p) => s + p.need, 0);
  const lay_qty = products.reduce((s, p) => s + p.lay_qty, 0);
  const short = products.filter((p) => p.lay_qty + 0.001 < p.need);
  const over = products.filter((p) => p.lay_qty > p.need + 0.001);
  const fab = cuttingFabricCoverage(db, po, products.map((p) => ({ product_id: p.product_id, need: p.need })));
  const fabricsCovered = fab.missing.length === 0;
  const covered = fabricsCovered && products.length > 0
    && products.every((p) => p.need > 0 && Math.abs(p.lay_qty - p.need) <= 0.001);
  let message;
  if (covered) {
    message = `برش با سفارش برابر است (${lay_qty}).`;
  } else if (!fabricsCovered) {
    const gaps = fab.missing.map((f) => `«${f.name}»: ${f.lay_qty} از ${f.need}`).join('؛ ');
    message = `این فرمول ${fab.fabrics.length} پارچهٔ طاقه‌ای دارد و لایه‌چینی پارچهٔ ${gaps} هنوز با سفارش برابر نیست. `
      + 'برای هر پارچه یک لایه‌چینی جدا با همان پارچه ثبت کنید؛ تا آن موقع مرحلهٔ برش بسته نمی‌شود.';
  } else {
    const gapText = products.map((p) => `${p.name || 'محصول'}: ${p.lay_qty} از ${p.need}`).join('؛ ');
    message = `برش هنوز با سفارش برابر نیست (${gapText}). تا برابر شدن، مرحلهٔ بعد باز نمی‌شود.`;
  }
  return {
    required: 1, covered, lay_qty, need, products, short, over,
    fabrics: fab.fabrics, missing_fabrics: fab.missing, message,
  };
}

function cuttingDownstreamUntouched(db, orderId, seq) {
  const rows = db.prepare(`
    SELECT * FROM production_order_stages WHERE order_id=? AND seq>? ORDER BY seq
  `).all(orderId, seq);
  for (const st of rows) {
    if (st.status === 'done' || st.status === 'skipped') return false;
    if (num(st.qty_out) > 0) return false;
    const labor = db.prepare(`
      SELECT 1 FROM production_labor_entries WHERE stage_id=? AND status='posted' LIMIT 1
    `).get(st.id);
    const issued = db.prepare(`
      SELECT 1 FROM production_material_issues
      WHERE stage_id=? AND status='posted' AND COALESCE(issue_type,'')!='cutting_lay' LIMIT 1
    `).get(st.id);
    if (labor || issued) return false;
  }
  return true;
}

/** اگر یک لایه مرحله را زودتر بسته، و مرحلهٔ بعد هنوز کاری نکرده، برش را باز کن. پارچهٔ طاقه دست نمی‌خورد. */
function reopenUndercutCuttingStage(db, po, stage, userId, date) {
  const when = date || todayJalali();
  const labs = db.prepare(`
    SELECT * FROM production_labor_entries WHERE stage_id=? AND status='posted'
  `).all(stage.id);
  let laborRial = 0;
  for (const l of labs) {
    laborRial += Math.round(num(l.amount_rial));
    if (l.je_id) {
      reverseEvent(db, {
        jeId: l.je_id, reason: 'برش ناقص — مرحلهٔ بعد زود باز شده بود', userId, date: when,
      });
    }
    db.prepare(`UPDATE production_labor_entries SET status='reversed' WHERE id=?`).run(l.id);
  }
  const ohs = db.prepare(`
    SELECT * FROM production_overhead_applications WHERE stage_id=? AND status='posted'
  `).all(stage.id);
  let ohRial = 0;
  for (const o of ohs) {
    ohRial += Math.round(num(o.amount_rial));
    if (o.je_id) {
      reverseEvent(db, {
        jeId: o.je_id, reason: 'برش ناقص — مرحلهٔ بعد زود باز شده بود', userId, date: when,
      });
    }
    db.prepare(`UPDATE production_overhead_applications SET status='reversed' WHERE id=?`).run(o.id);
  }
  const planned = num(stage.qty_planned_in) > 0 ? num(stage.qty_planned_in) : num(stage.qty_in);
  db.prepare(`
    UPDATE production_order_stages SET
      status='in_progress', qty_in=?, qty_out=0,
      qty_waste_normal=0, qty_waste_abnormal=0, qty_rework=0,
      labor_rial=0, overhead_rial=0, subcontract_rial=0,
      cost_out_rial=0, unit_cost_out_rial=0, driver_qty=0,
      ended_at=NULL
    WHERE id=?
  `).run(planned, stage.id);
  if (laborRial || ohRial) {
    db.prepare(`
      UPDATE production_orders SET
        labor_cost_rial = MAX(0, COALESCE(labor_cost_rial,0) - ?),
        overhead_cost_rial = MAX(0, COALESCE(overhead_cost_rial,0) - ?)
      WHERE id=?
    `).run(laborRial, ohRial, po.id);
  }
  resetDownstreamStages(db, po.id, stage.seq);
}

function safeJson(s) {
  if (!s) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Color×size lines from production_order_lines (plan), resolving variant_id
 * from color×size when the row only stored those ids.
 */
function variantLinesFromOrderPlan(db, orderId, productId) {
  let rows = [];
  try {
    const { listOrderLines } = require('./engine');
    rows = listOrderLines(db, orderId) || [];
  } catch (_) {
    return [];
  }
  const byCell = db.prepare(`
    SELECT id FROM product_variants
    WHERE product_id=? AND color_id=? AND size_id=?
      AND COALESCE(active,1)=1 AND COALESCE(is_default,0)=0
    ORDER BY id LIMIT 1
  `);
  const ownerOf = db.prepare('SELECT product_id FROM product_variants WHERE id=?');
  const out = [];
  for (const row of rows) {
    if (row.product_id != null && Number(row.product_id) !== Number(productId)) continue;
    let vid = row.variant_id != null ? Number(row.variant_id) : null;
    if (vid) {
      const owner = ownerOf.get(vid);
      if (!owner || Number(owner.product_id) !== Number(productId)) vid = null;
    }
    if (!vid && row.color_id && row.size_id) {
      vid = byCell.get(productId, row.color_id, row.size_id)?.id || null;
    }
    const qty = num(row.qty_planned != null ? row.qty_planned : row.qty);
    if (vid && qty > 0) out.push({ variant_id: vid, qty });
  }
  return out;
}

/**
 * Untagged variant_lines belong to the order header (single-product modal).
 * Tagged lines ({product_id}) belong only to that finished product.
 */
function linesForFinalizeProduct(body, productId, isOrderProduct) {
  const raw = Array.isArray(body && body.variant_lines) ? body.variant_lines : [];
  const normalized = raw.map(l => ({
    product_id: l && l.product_id != null && l.product_id !== '' ? Number(l.product_id) : null,
    variant_id: l && (l.variant_id || l.variantId),
    qty: num(l && (l.qty != null ? l.qty : l.qty_planned)),
  })).filter(l => l.variant_id && l.qty > 0);
  const tagged = normalized.some(l => l.product_id);
  if (!tagged) return isOrderProduct ? normalized : [];
  return normalized.filter(l => l.product_id === Number(productId));
}

function variantQtyMismatch(productId, sum, qty) {
  const fail = err('E_VARIANT_QTY', 400, { sum, qty, product_id: Number(productId) });
  fail.message = `جمع برنامه رنگ×سایز (${sum}) با رسید این محصول (${qty}) یکی نیست — تعداد واقعی هر ترکیب را وارد کنید`;
  return fail;
}

/**
 * Color×size for one finished product.
 * Its own receipt qty is the target — never the shared last-stage total.
 * Body lines for this product win; else the order plan when the sums match;
 * else the legacy color/size fields, and only on the order header.
 */
function resolveProductApparelLines(db, po, body, productId, qty, { isOrderProduct } = {}) {
  const apparel = require('../inventory/apparel-lines');
  const { hasActiveMatrixVariants } = require('../inventory/qty-policy');
  if (!hasActiveMatrixVariants(db, productId)) return [];

  const mine = linesForFinalizeProduct(body, productId, !!isOrderProduct);
  const tagged = Array.isArray(body && body.variant_lines)
    && body.variant_lines.some(l => l && l.product_id != null && l.product_id !== '');
  const useBody = mine.length > 0 || (!tagged && isOrderProduct && body && body.variant_id && !Array.isArray(body.variant_lines));
  if (useBody) {
    return apparel.resolveApparelLines(db, {
      productId,
      qty,
      variantId: (!tagged && isOrderProduct) ? body.variant_id : null,
      variantLines: mine,
    });
  }

  const fromPlan = variantLinesFromOrderPlan(db, po.id, productId);
  if (fromPlan.length) {
    const sum = round6(fromPlan.reduce((a, l) => a + l.qty, 0));
    if (Math.abs(sum - Number(qty)) <= 0.001) {
      return apparel.resolveApparelLines(db, { productId, qty, variantLines: fromPlan });
    }
    if (isOrderProduct && !tagged) {
      try {
        return apparel.resolveApparelLines(db, {
          productId,
          qty,
          sizeBreakdown: (body && body.size_breakdown) || po.size_breakdown,
          color: (body && body.color) || po.color,
        });
      } catch (e) {
        if (e && (e.code === 'E_VARIANT_REQUIRED' || e.code === 'E_VARIANT_QTY')) {
          throw variantQtyMismatch(productId, sum, qty);
        }
        throw e;
      }
    }
    throw variantQtyMismatch(productId, sum, qty);
  }

  return apparel.resolveApparelLines(db, {
    productId,
    qty,
    variantId: isOrderProduct && !tagged ? body.variant_id : null,
    variantLines: isOrderProduct && !tagged ? body.variant_lines : null,
    sizeBreakdown: isOrderProduct && !tagged ? ((body && body.size_breakdown) || po.size_breakdown) : null,
    color: isOrderProduct && !tagged ? ((body && body.color) || po.color) : null,
  });
}

/**
 * Resolve FG apparel lines for the order header.
 * Multiproduct finalize calls resolveProductApparelLines once per main product.
 */
function resolveFinalizeApparelLines(db, po, body, qtyGood) {
  return resolveProductApparelLines(db, po, body, po.product_id, qtyGood, { isOrderProduct: true });
}

function emit(db, eventType, payload) {
  try {
    db.prepare(`
      INSERT INTO production_events (event_type, entity_type, entity_id, payload_json)
      VALUES (?,?,?,?)
    `).run(eventType, 'production_order', payload.orderId || null, JSON.stringify(payload));
  } catch { /* optional */ }
}

function getOrder(db, orderId) {
  const po = db.prepare('SELECT * FROM production_orders WHERE id=?').get(orderId);
  if (!po) throw err('E_NOT_FOUND', 404);
  return po;
}

function getStage(db, orderId, stageId) {
  const st = db.prepare('SELECT * FROM production_order_stages WHERE id=? AND order_id=?')
    .get(stageId, orderId);
  if (!st) throw err('E_NOT_FOUND', 404);
  return st;
}

function getOperation(db, stage, bomId) {
  if (stage.operation_id) {
    return db.prepare('SELECT * FROM bom_operations WHERE id=?').get(stage.operation_id);
  }
  return db.prepare(`
    SELECT * FROM bom_operations WHERE bom_id=? AND cost_center_id=? ORDER BY seq LIMIT 1
  `).get(bomId, stage.cost_center_id);
}

function whSetting(db, key) {
  const v = setting(db, key, '');
  return v ? Number(v) : null;
}

function stageList(db, orderId) {
  return db.prepare(`
    SELECT s.*, cc.code AS cc_code, cc.name AS cc_name,
           sp.name AS scoped_product_name
    FROM production_order_stages s
    LEFT JOIN cost_centers cc ON cc.id = s.cost_center_id
    LEFT JOIN products sp ON sp.id = s.scoped_product_id
    WHERE s.order_id=? ORDER BY s.seq
  `).all(orderId);
}

function stageScopeKey(stage) {
  if (!stage) return 'shared';
  const scope = String(stage.product_scope || 'shared').toLowerCase();
  if (scope === 'exclusive' && stage.scoped_product_id) return 'ex:' + Number(stage.scoped_product_id);
  return 'shared';
}

/**
 * Same-scope stages keep one pipe: actual qty_out becomes the next qty_in.
 * A different scope (shared ↔ exclusive, or two products) keeps the qty planned
 * at release so one product's output cannot overwrite the other.
 * WIP cost still moves forward on material_in_rial.
 */
function handoffNextStage(db, stage, { qtyOut, costOut, date }) {
  const nxt = nextStage(db, stage.order_id, stage.seq);
  if (!nxt) return null;
  const same = stageScopeKey(stage) === stageScopeKey(nxt);
  let qty = qtyOut;
  if (!same) {
    const kept = num(nxt.qty_in) > 0 ? num(nxt.qty_in) : num(nxt.qty_planned_in);
    qty = kept > 0 ? kept : qtyOut;
  }
  db.prepare(`
    UPDATE production_order_stages SET
      qty_in=?, material_in_rial=?, status='in_progress', started_at=?
    WHERE id=?
  `).run(qty, costOut, date, nxt.id);
  return Object.assign({}, nxt, { qty_in: qty, material_in_rial: costOut, status: 'in_progress' });
}

function prevStage(db, orderId, seq) {
  return db.prepare(`
    SELECT * FROM production_order_stages WHERE order_id=? AND seq < ? ORDER BY seq DESC LIMIT 1
  `).get(orderId, seq);
}

function nextStage(db, orderId, seq) {
  return db.prepare(`
    SELECT * FROM production_order_stages WHERE order_id=? AND seq > ? ORDER BY seq LIMIT 1
  `).get(orderId, seq);
}

function reserveMaterials(db, po, qtyStart) {
  const bom = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(po.bom_id);
  const ex = explodeBom(db, {
    bomId: po.bom_id,
    qty: qtyStart,
    sizeBreakdown: safeJson(po.size_breakdown),
    color: po.color,
    priceBasis: 'average',
    yieldOverride: bom?.has_routing ? 100 : null,
    forProductId: explodeProductScopeForOrder(db, po),
    qtyByProduct: orderFgQtyMap(db, po),
  });
  for (const L of ex.lines) {
    db.prepare(`
      INSERT INTO production_reservations
        (order_id, product_id, warehouse_id, qty, status, date)
      VALUES (?,?,?,?,'active',?)
    `).run(po.id, L.product_id, po.warehouse_raw_id, L.qty_final, po.date);
  }
}

function applyStageOverhead(db, {
  po, stage, op, cc, qtyIn, laborRial, matRial, date, period, userId,
}) {
  const rate = getOverheadRate(db, stage.cost_center_id, period);
  if (!rate) {
    return { amount_rial: 0, id: null, driver: null, driver_qty: 0, rate_rial: 0 };
  }
  const driver = coerceDriver(stage.driver || op?.overhead_driver || cc?.driver || rate.driver || 'output_qty');
  const driverQty = stageDriverQty(db, op || {}, cc || {}, {
    qty: qtyIn,
    labor: laborRial,
    material: matRial,
    manualDriver: num(po?.manual_driver_qty),
    driver,
  });
  const rateRial = Math.round(num(rate.total_rate_rial));
  const amount = appliedOverheadRial(rate, driverQty, driver);

  const dup = findPostedApplication(db, {
    orderId: po.id, stageId: stage.id, driver, costCenterId: stage.cost_center_id,
  });
  if (dup) {
    return {
      id: dup.id, amount_rial: 0, existing: true,
      existing_amount_rial: Math.round(num(dup.amount_rial)),
      driver, driver_qty: num(dup.driver_qty), rate_rial: Math.round(num(dup.rate_rial)), rate_id: dup.rate_id,
    };
  }

  let docNo = '';
  try { docNo = allocateNumber(db, 'overhead_apply', 'OH'); }
  catch { docNo = `OH-${Date.now()}`; }

  const id = db.prepare(`
    INSERT INTO production_overhead_applications
      (doc_no, order_id, stage_id, cost_center_id, rate_id, driver, driver_qty,
       fixed_rate_rial, var_rate_rial, rate_rial, amount_rial,
       date, period_label, status, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'posted',?)
  `).run(
    docNo, po.id, stage.id, stage.cost_center_id, rate.id, driver, driverQty,
    Math.round(num(rate.fixed_rate_rial)), Math.round(num(rate.var_rate_rial)),
    rateRial, amount, date, period, userId
  ).lastInsertRowid;

  bumpRateApplied(db, rate.id, amount, driverQty);

  return { id, amount_rial: amount, driver, driver_qty: driverQty, rate_rial: rateRial, rate_id: rate.id };
}

function orderQtyStart(db, po) {
  const qtyMain = explodeQtyForOrder(db, po);
  return backwardQty(db, po.bom_id, qtyMain).qty_start;
}

/**
 * BOM lines only carry stage_cost_center_id (no operation_id).
 * When multiple routing ops / order stages share a CC, materials must issue
 * exactly once — on the earliest stage (by seq) that owns that CC.
 */
function stageOwnsBomMaterials(db, po, stage) {
  if (!stage?.cost_center_id) return false;
  // Prefer routing: earliest bom_operation with this CC
  if (po.bom_id) {
    const ownerOp = db.prepare(`
      SELECT id, seq FROM bom_operations
      WHERE bom_id=? AND cost_center_id=?
      ORDER BY seq ASC, id ASC
      LIMIT 1
    `).get(po.bom_id, stage.cost_center_id);
    if (ownerOp) {
      if (stage.operation_id != null) return Number(stage.operation_id) === Number(ownerOp.id);
      return Number(stage.seq) === Number(ownerOp.seq);
    }
  }
  // Fallback: earliest production_order_stage with this CC
  const ownerStage = db.prepare(`
    SELECT id FROM production_order_stages
    WHERE order_id=? AND cost_center_id=?
    ORDER BY seq ASC, id ASC
    LIMIT 1
  `).get(po.id, stage.cost_center_id);
  return !!(ownerStage && Number(ownerStage.id) === Number(stage.id));
}

function explodedOrderLines(db, po) {
  if (!po?.bom_id) return [];
  const bom = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(po.bom_id);
  const qtyStart = orderQtyStart(db, po);
  const ex = explodeBom(db, {
    bomId: po.bom_id,
    qty: qtyStart,
    sizeBreakdown: safeJson(po.size_breakdown),
    color: po.color,
    priceBasis: 'average',
    yieldOverride: bom?.has_routing ? 100 : null,
    forProductId: explodeProductScopeForOrder(db, po),
    qtyByProduct: orderFgQtyMap(db, po),
  });
  return (ex.lines || []).map(L => ({ ...L, bom_id: Number(po.bom_id), piece_product_id: null }));
}

/**
 * v527 — «تکه‌های مواد» سفارش: هر فرمولی که روی سفارش است با تعداد خودش باز می‌شود.
 *  - سفارش چندفرمولی (v475): یک تکه برای هر ردیف fg_plan (فرمول + محصول + تعداد همان محصول).
 *    قبلاً فقط bom_id سرفصل با جمع تعداد همهٔ محصولات باز می‌شد (بند کلاه ×168 به‌جای ×84 + ×84
 *    و اقلام فرمول دوم اصلاً دیده نمی‌شد).
 *  - سایر سفارش‌ها: همان explode قبلی (یک تکه).
 * هر قلم bom_id و piece_product_id خودش را دارد تا به مرحلهٔ درست برسد.
 */
function orderMaterialPieces(db, po) {
  const peers = orderBomPeerLines(po);
  if (!peers) {
    return po?.bom_id
      ? [{ bom_id: Number(po.bom_id), product_id: null, qty_by_product: orderFgQtyMap(db, po), lines: explodedOrderLines(db, po) }]
      : [];
  }
  const out = [];
  for (const line of peers) {
    const bom = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(line.bom_id);
    if (!bom) continue;
    const qtyMain = orderQtyAsMainBase(db, line.bom_id, line.qty_planned, line.product_id);
    const hasOps = !!db.prepare('SELECT 1 FROM bom_operations WHERE bom_id=? LIMIT 1').get(line.bom_id);
    const qtyStart = hasOps ? (Number(backwardQty(db, line.bom_id, qtyMain).qty_start) || qtyMain) : qtyMain;
    const ex = explodeBom(db, {
      bomId: line.bom_id,
      qty: qtyStart,
      sizeBreakdown: safeJson(po.size_breakdown),
      color: po.color,
      priceBasis: 'average',
      yieldOverride: bom.has_routing ? 100 : null,
      forProductId: line.product_id,
    });
    out.push({
      bom_id: Number(line.bom_id),
      product_id: Number(line.product_id),
      qty_by_product: null,
      lines: (ex.lines || []).map(L => ({ ...L, bom_id: Number(line.bom_id), piece_product_id: Number(line.product_id) })),
    });
  }
  return out;
}

/** همهٔ اقلام همهٔ تکه‌ها (برای راهنما/گزارش). */
function orderMaterialLinesAll(db, po) {
  const out = [];
  for (const piece of orderMaterialPieces(db, po)) out.push(...piece.lines);
  return out;
}

/**
 * v527 — اقلام فرمول(های) سفارش که به هیچ عملیاتی وصل نیستند؛ روی هیچ مرحله‌ای حواله نمی‌شوند.
 * برای سفارش‌های قدیمیِ در جریان فقط هشدار (گیت در فعال‌سازی/آزادسازی/حواله است).
 */
function orderMaterialGaps(db, po) {
  if (!po?.bom_id) return [];
  const { unassignedBomLines } = require('./bom-assignments');
  const bomIds = [Number(po.bom_id)];
  for (const p of orderBomPeerLines(po) || []) {
    if (!bomIds.includes(Number(p.bom_id))) bomIds.push(Number(p.bom_id));
  }
  const out = [];
  for (const bomId of bomIds) {
    const bom = db.prepare('SELECT id, code, name FROM bom_headers WHERE id=?').get(bomId);
    for (const L of unassignedBomLines(db, bomId)) {
      out.push({ ...L, bom_id: bomId, bom_code: bom?.code || '', bom_name: bom?.name || '' });
    }
  }
  return out;
}

/** عملیات‌های مسیر یک فرمول که این مرحله آن‌ها را اجرا می‌کند. */
function stageOperationsForPiece(db, po, stage, piece, peers) {
  const ops = db.prepare('SELECT * FROM bom_operations WHERE bom_id=? ORDER BY seq, id').all(piece.bom_id);
  if (!ops.length) return [];
  const own = stage.operation_id != null ? ops.find(op => Number(op.id) === Number(stage.operation_id)) : null;
  if (!peers) {
    if (own) return [own];
    // drift: عملیات مرحله از فرمول حذف شده → عملیات هم‌مرکز، فقط اگر مرحلهٔ دیگری آن را اجرا نمی‌کند
    if (stage.cost_center_id) {
      const sameCc = ops.find(op => Number(op.cost_center_id) === Number(stage.cost_center_id));
      if (sameCc) {
        const taken = db.prepare(`
          SELECT 1 FROM production_order_stages WHERE order_id=? AND operation_id=? AND id<>? LIMIT 1
        `).get(po.id, sameCc.id, stage.id);
        if (!taken) return [sameCc];
      }
    }
    return [];
  }
  // چندفرمولی: مرحلهٔ اختصاصی فقط مال فرمول/محصول خودش است
  if (String(stage.product_scope || 'shared') === 'exclusive') {
    if (stage.scoped_product_id != null && Number(stage.scoped_product_id) !== Number(piece.product_id)) return [];
    return own ? [own] : [];
  }
  // مرحلهٔ مشترک (برش مشترک): در هر فرمول، عملیات برش همان فرمول
  if (own) return [own];
  const stageOp = stage.operation_id != null
    ? db.prepare('SELECT * FROM bom_operations WHERE id=?').get(stage.operation_id)
    : null;
  const isCut = stageOp ? stageIsCutting(db, stageOp) : !!stage.cost_center_id;
  if (isCut) {
    const cut = ops.find(op => stageIsCutting(db, op));
    if (cut) return [cut];
  }
  if (stage.cost_center_id) {
    const sameCc = ops.find(op => Number(op.cost_center_id) === Number(stage.cost_center_id));
    if (sameCc) return [sameCc];
  }
  return [];
}

/** v527 — اقلام یک تکه که به یک عملیات وصل‌اند (صریح، یا legacy از مرکز هزینهٔ قلم). بدون یتیم. */
function pieceLinesForOperation(db, piece, op) {
  const { materialsByOperation } = require('./bom-assignments');
  const byOp = materialsByOperation(db, piece.bom_id);
  const byLine = new Map(piece.lines.map(L => [Number(L.bom_line_id), L]));
  const out = [];
  const explicitLineIds = new Set();
  for (const rows of byOp.values()) for (const a of rows) explicitLineIds.add(Number(a.bom_line_id));
  for (const a of byOp.get(Number(op.id)) || []) {
    const L = byLine.get(Number(a.bom_line_id));
    if (!L) continue;
    out.push({ ...L, qty_final: assignmentSliceQty(L, a), allocation_mode: a.allocation_mode || 'sole' });
  }
  // legacy: قلم با stage_cost_center_id و بدون تخصیص صریح → اولین عملیاتِ همان مرکز (یک‌بار حواله)
  const firstOpOfCc = db.prepare(`
    SELECT id FROM bom_operations WHERE bom_id=? AND cost_center_id=? ORDER BY seq ASC, id ASC LIMIT 1
  `).get(piece.bom_id, op.cost_center_id);
  if (firstOpOfCc && Number(firstOpOfCc.id) === Number(op.id)) {
    for (const L of piece.lines) {
      if (explicitLineIds.has(Number(L.bom_line_id))) continue;
      if (L.stage_cost_center_id == null || L.stage_cost_center_id === '') continue;
      if (Number(L.stage_cost_center_id) !== Number(op.cost_center_id)) continue;
      if (out.some(x => Number(x.bom_line_id) === Number(L.bom_line_id))) continue;
      out.push({ ...L, allocation_mode: 'sole' });
    }
  }
  return out;
}

/**
 * v527 — سهم یک قلم روی یک مرحله در سفارش چندمحصولیِ تک‌فرمولی (v418/v427):
 *  - مرحلهٔ مشترک: همهٔ اقلام با مقدار کامل.
 *  - مرحلهٔ اختصاصی محصول P: قلم اختصاصی P کامل؛ قلم اختصاصی محصول دیگر صفر؛
 *    قلم مشترک به نسبت تعداد P از جمع تعدادها (۸۴ از ۱۶۸ → نصف).
 */
function scopeLineForStage(L, stage, piece) {
  if (String(stage.product_scope || 'shared') !== 'exclusive' || stage.scoped_product_id == null) return L;
  const P = Number(stage.scoped_product_id);
  const scope = String(L.product_scope || 'shared').toLowerCase();
  if (scope === 'exclusive') {
    return Number(L.scoped_product_id) === P ? L : null;
  }
  const map = piece.qty_by_product;
  if (!map) return L;
  let sum = 0;
  for (const v of Object.values(map)) sum += Number(v) || 0;
  const mine = Number(map[P] ?? map[String(P)]) || 0;
  if (!(sum > 0)) return L;
  const f = mine / sum;
  return {
    ...L,
    qty_net: round6(num(L.qty_net) * f),
    qty_gross: round6(num(L.qty_gross) * f),
    qty_final: round6(num(L.qty_final) * f),
    amount_rial: Math.round(num(L.amount_rial) * f),
    split_share: f,
  };
}

/** ادغام قلم‌های هم‌کالا روی یک مرحله (مثلاً پارچهٔ مشترک دو فرمول در برش مشترک). */
function mergeStageLines(lines) {
  const out = [];
  const idx = new Map();
  for (const L of lines) {
    if (!L) continue;
    const k = Number(L.product_id);
    if (idx.has(k)) {
      const m = out[idx.get(k)];
      m.qty_net = round6(num(m.qty_net) + num(L.qty_net));
      m.qty_gross = round6(num(m.qty_gross) + num(L.qty_gross));
      m.qty_final = round6(num(m.qty_final) + num(L.qty_final));
      m.amount_rial = Math.round(num(m.amount_rial) + num(L.amount_rial));
      m.merged_bom_line_ids = [...(m.merged_bom_line_ids || [m.bom_line_id]), L.bom_line_id];
      continue;
    }
    idx.set(k, out.length);
    out.push({ ...L });
  }
  return out;
}

function assignmentSliceQty(line, assignment) {
  const base = Number(assignment.qty_per_base) || 0;
  let qty = line.qty_final;
  if (assignment.qty_override != null && assignment.qty_override !== '' && base > 0) {
    qty = round6(line.qty_final * (Number(assignment.qty_override) / base));
  }
  if ((assignment.allocation_mode || 'sole') === 'shared') {
    qty = round6(qty * (Number(assignment.share_percent) || 0) / 100);
  }
  return qty;
}

/**
 * Materials for a shop-floor issue — v527 strict routing.
 * یک قلم فقط روی مرحله‌ای می‌آید که عملیاتش در فرمول به آن وصل باشد:
 *  1) تخصیص صریح (sole/shared) به عملیات مرحله — در هر فرمولِ سفارش (چندفرمولی: هر تکه جدا).
 *  2) legacy: قلم با stage_cost_center_id → اولین عملیاتِ همان مرکز هزینه (یک‌بار حواله).
 *  3) قلم بدون هیچ‌کدام = «بدون عملیات»؛ به هیچ مرحله‌ای (حتی مرحلهٔ اول) نمی‌رود.
 *     قبل از v527 این قلم‌ها خودکار به مرحلهٔ اول (برش) می‌افتادند و گیت حوالهٔ v523 برش را می‌بست.
 *  - مرحلهٔ اختصاصی محصول P (چندمحصولی تک‌فرمولی): قلم مشترک به نسبت تعداد P تقسیم می‌شود.
 *  - مرحلهٔ بدون operation_id (سفارش‌های قدیمی): فقط legacy مرکز هزینه، بدون یتیم.
 */
function stageMaterialLines(db, po, stage) {
  const pieces = orderMaterialPieces(db, po);
  if (!pieces.length) return [];
  const peers = orderBomPeerLines(po);
  const collected = [];

  if (stage.operation_id == null && !peers) {
    // سفارش قدیمی بدون operation_id روی مرحله: مالکیت مرکز هزینه (اولین مرحلهٔ آن مرکز)
    if (!stageOwnsBomMaterials(db, po, stage)) return [];
    for (const piece of pieces) {
      for (const L of piece.lines) {
        if (L.stage_cost_center_id == null || L.stage_cost_center_id === '') continue;
        if (Number(L.stage_cost_center_id) !== Number(stage.cost_center_id)) continue;
        collected.push(scopeLineForStage(L, stage, piece));
      }
    }
    return mergeStageLines(collected);
  }

  for (const piece of pieces) {
    const ops = stageOperationsForPiece(db, po, stage, piece, peers);
    for (const op of ops) {
      for (const L of pieceLinesForOperation(db, piece, op)) {
        collected.push(scopeLineForStage(L, stage, piece));
      }
    }
  }
  return mergeStageLines(collected);
}

function stageMaterialEmptyHint(db, po, stage) {
  const lines = orderMaterialLinesAll(db, po);
  if (!lines.length) {
    return 'این فرمول قلم مواد ندارد. در فرمول ساخت، تب «اقلام» را پر و ذخیره کنید.';
  }
  const gaps = orderMaterialGaps(db, po);
  const parts = [];
  const { materialsByOperation } = require('./bom-assignments');
  const bomIds = [...new Set(lines.map(L => Number(L.bom_id)).filter(Boolean))];
  const names = [];
  for (const bomId of bomIds) {
    for (const opId of materialsByOperation(db, bomId).keys()) {
      const op = db.prepare('SELECT seq, operation_name FROM bom_operations WHERE id=?').get(opId);
      names.push((op?.operation_name || ('عملیات ' + opId)) + (op?.seq != null ? ` (${op.seq})` : ''));
    }
  }
  if (names.length) {
    parts.push('مواد به این مرحله وصل نیست. وصل شده به: ' + [...new Set(names)].join('، ')
      + '. حواله را روی همان مرحله بزنید، یا در فرمول → مسیر عملیات، ماده را به این عملیات وصل کنید.');
  } else if (lines.some(L => L.stage_cost_center_id)) {
    parts.push('مواد به مرکز هزینهٔ مرحلهٔ دیگری وصل است. حواله را روی همان مرحله باز کنید.');
  }
  if (gaps.length) {
    parts.push('اقلام بدون عملیات (روی هیچ مرحله‌ای حواله نمی‌شوند): '
      + gaps.map(g => `«${g.name}»`).join('، ')
      + '. در فرمول → مسیر عملیات → «مواد را به عملیات وصل کنید» (روی فرمول فعال هم مجاز است).');
  }
  return parts.join(' ') || 'ماده‌ای برای این مرحله پیدا نشد.';
}

function backflushStageMaterials(db, {
  po, stage, date, period, userId, issueType = 'backflush', substitutes,
}) {
  const lines = stageMaterialLines(db, po, stage);
  let matRial = 0, pkgRial = 0;
  const out = [];
  const whId = po.warehouse_raw_id;
  const { expandShortageAlternates, resolveIssueStd } = require('./engine');
  const altByPid = new Map();
  for (const a of substitutes || []) {
    const pid = Number(a?.product_id);
    if (pid) altByPid.set(pid, a);
  }
  const std = {};
  for (const L of lines) {
    std[L.product_id] = {
      qty: L.qty_final,
      price: L.unit_cost_rial,
      bom_line_id: L.bom_line_id,
      kind: L.line_kind,
    };
  }
  const raw = lines.map(L => {
    const alt = altByPid.get(Number(L.product_id));
    const row = {
      product_id: L.product_id,
      qty_actual: L.qty_final,
      bom_line_id: L.bom_line_id,
      line_kind: L.line_kind,
    };
    if (alt && Number(alt.alternate_product_id) > 0 && num(alt.alternate_qty) > 0) {
      row.alternate_product_id = Number(alt.alternate_product_id);
      row.alternate_qty = num(alt.alternate_qty);
      row.reason = alt.reason || '';
    }
    return row;
  });
  const materials = expandShortageAlternates(db, raw, whId);

  for (const L of materials) {
    const prod = db.prepare('SELECT * FROM products WHERE id=?').get(L.product_id);
    if (!prod) throw err('E_NOT_FOUND', 404, { productId: L.product_id });
    if (lengthFabricProduct(db, L.product_id)) {
      const cut = resolveCuttingStage(db, po.id);
      const onCut = cut && Number(stage.id) === Number(cut.id);
      if (!onCut || Number(L.substitute_of_product_id)) {
        throw err('E_FABRIC_VIA_CUT', 409, {
          product_id: prod.id,
          name: prod.name,
          unit: prod.unit,
          message: `«${prod.name}» پارچهٔ طاقه‌ای است (${rollFabricUnitLabel(db, prod)}). مصرفش فقط با لایه‌چینی و طاقه است، نه حوالهٔ مرحله.`,
        });
      }
      continue;
    }
    const AQ = num(L.qty_actual != null ? L.qty_actual : L.qty);
    const resolved = resolveIssueStd(std, L, materials);
    const s = resolved.s;
    const SQ = resolved.SQ;
    const unitCost = Math.round(num(prod.average_cost_rial));
    if (!unitCost && AQ > 0) {
      throw err('E_ZERO_AVG_COST', 422, { name: prod.name, product_id: prod.id });
    }
    const amount = Math.round(AQ * unitCost);
    const isSub = !!Number(L.substitute_of_product_id);
    const kind = isSub
      ? (prod.item_type === 'packaging' ? 'packaging' : 'material')
      : (L.line_kind || s?.kind || (prod.item_type === 'packaging' ? 'packaging' : 'material'));

    let issued = null;
    if (AQ > 0) {
      assertFabricIssueAllowed(db, {
        productId: L.product_id,
        qty: AQ,
        orderId: po.id,
      });
      issued = issueFromStock(db, {
        productId: L.product_id,
        warehouseId: whId,
        qty: AQ,
        userId,
        note: `مرحله ${stage.seq} — ${po.order_no}`,
        variantId: L.variant_id,
        variantLines: L.variant_lines,
        sourceType: 'production_issue',
        sourceId: po.id,
        date,
      });
    }

    let docNo = '';
    try { docNo = allocateNumber(db, 'material_issue', 'MI'); }
    catch { docNo = `MI-${Date.now()}`; }

    const stdUnit = Math.round(num(s?.price) || unitCost);
    const varQty = round6(AQ - SQ);
    const stageIssue = db.prepare(`
      INSERT INTO production_material_issues
        (doc_no, order_id, stage_id, cost_center_id, product_id, bom_line_id, issue_type,
         qty_standard, qty_actual, qty_variance, unit_cost_rial, std_cost_rial,
         amount_rial, std_amount_rial, var_price_rial, var_qty_rial,
         warehouse_id, substitute_of_product_id, date, period_label, status, variance_status, note, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,'posted','memo',?,?)
    `).run(
      docNo, po.id, stage.id, stage.cost_center_id, L.product_id, (s?.bom_line_id || L.bom_line_id) || null,
      isSub ? 'substitute' : issueType, SQ, AQ, varQty, unitCost, stdUnit,
      amount, Math.round(SQ * stdUnit),
      0, whId, L.substitute_of_product_id || null, date, period, L.reason || '', userId
    );
    if (issued && issued.variantLines && issued.variantLines.length) {
      require('../inventory/apparel-lines').postApparelLines(db, {
        productId: L.product_id, warehouseId: whId, lines: issued.variantLines,
        docType: 'production_issue', docId: stageIssue.lastInsertRowid, userId,
        note: `مرحله ${stage.seq} — ${po.order_no}`, sign: -1, allowNegative: false,
      });
    }

    if (kind === 'packaging') pkgRial += amount;
    else matRial += amount;
    out.push({
      product_id: L.product_id,
      name: prod.name,
      qty: AQ,
      unit_cost_rial: unitCost,
      amount_rial: amount,
      substitute_of_product_id: L.substitute_of_product_id || null,
    });
  }
  return { matRial, pkgRial, total: matRial + pkgRial, lines: out };
}

function sumStageIssued(db, stageId) {
  const rows = db.prepare(`
    SELECT COALESCE(SUM(amount_rial),0) s,
           COALESCE(SUM(CASE WHEN bl.line_type='packaging' OR p.item_type='packaging'
             THEN amount_rial ELSE 0 END),0) pkg
    FROM production_material_issues mi
    LEFT JOIN bom_lines bl ON bl.id = mi.bom_line_id
    LEFT JOIN products p ON p.id = mi.product_id
    WHERE mi.stage_id=? AND mi.status='posted'
      AND COALESCE(mi.extra_class,'')<>'abnormal'
  `).get(stageId);
  const total = Math.round(num(rows?.s));
  const pkg = Math.round(num(rows?.pkg));
  return { matRial: total - pkg, pkgRial: pkg, total };
}

/**
 * آنالیز متغیر: اقلام فرمول این مرحله (به‌جز پارچهٔ طاقه‌ای که با لایه‌چینی می‌آید) که هنوز
 * حوالهٔ مثبت ندارند. حوالهٔ کالای جایگزین (substitute_of_product_id) هم پوشش حساب می‌شود.
 */
function stageUnissuedMaterialLines(db, po, stage) {
  const lines = stageMaterialLines(db, po, stage)
    .filter(L => num(L.qty_final) > 0 && !lengthFabricProduct(db, L.product_id));
  if (!lines.length) return [];
  const rows = db.prepare(`
    SELECT product_id, substitute_of_product_id FROM production_material_issues
    WHERE order_id=? AND stage_id=? AND status='posted' AND qty_actual > 0
      AND COALESCE(issue_type,'') NOT IN ('extra','cutting_lay')
  `).all(po.id, stage.id);
  const covered = new Set();
  for (const r of rows) {
    covered.add(Number(r.product_id));
    if (r.substitute_of_product_id) covered.add(Number(r.substitute_of_product_id));
  }
  const out = [];
  for (const L of lines) {
    const pid = Number(L.product_id);
    if (covered.has(pid) || out.some(x => x.product_id === pid)) continue;
    const name = db.prepare('SELECT name FROM products WHERE id=?').get(pid)?.name || ('#' + pid);
    out.push({ product_id: pid, name, qty_standard: num(L.qty_final) });
  }
  return out;
}

function assertStageMaterialsIssued(db, po, stage) {
  const missing = stageUnissuedMaterialLines(db, po, stage);
  if (!missing.length) return;
  throw err('E_STAGE_MATERIAL_NOT_ISSUED', 422, {
    missing,
    detail: 'این اقلام فرمول مرحله هنوز حواله نشده: '
      + missing.map(m => `«${m.name}» (${m.qty_standard})`).join('، ')
      + '. اول «حواله مواد» را بزنید؛ اگر موجودی کم است، در همان حواله کالای جایگزین انتخاب کنید.',
  });
}

/** مصرف اضافهٔ عادی همین مرحله (در WIP)؛ در آنالیز ثابت به بهای خروجی مرحله اضافه می‌شود. */
function sumStageExtraNormal(db, stageId) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(amount_rial),0) s FROM production_material_issues
    WHERE stage_id=? AND status='posted' AND issue_type='extra' AND COALESCE(extra_class,'')='normal'
  `).get(stageId);
  return Math.round(num(r?.s));
}

function insertAutoSubcontractFee(db, {
  po, stage, op, qtyIn, date, period, userId, supplierId,
}) {
  const feeUnit = Math.round(num(op?.subcontract_fee_rial));
  const feeRial = Math.round(feeUnit * qtyIn);
  if (!feeRial) return 0;

  let docNo = '';
  try { docNo = allocateNumber(db, 'subcontract', 'SC'); }
  catch { docNo = `SC-${Date.now()}`; }

  const sid = Number(supplierId || stage.supplier_id) || 0;
  if (!sid) throw err('E_SUBCONTRACT_SUPPLIER', 422);
  db.prepare(`
    INSERT INTO production_subcontract
      (doc_no, order_id, stage_id, supplier_id, direction, product_id,
       qty, fee_unit_rial, fee_amount_rial, date, period_label, status, created_by)
    VALUES (?,?,?,?,'in',?,?,?,?,?,?,'posted',?)
  `).run(
    docNo, po.id, stage.id, sid, po.product_id,
    qtyIn, feeUnit, feeRial, date, period, userId
  );
  return feeRial;
}

function hasSubcontractIn(db, stageId) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(fee_amount_rial),0) s FROM production_subcontract
    WHERE stage_id=? AND direction='in' AND status='posted'
  `).get(stageId);
  return Math.round(num(r?.s)) > 0;
}

function postStageCore(db, {
  orderId, stageId, body, userId, mode,
}) {
  const po = getOrder(db, orderId);
  if (!['fixed_adv', 'variable_adv'].includes(po.analysis_type)) {
    throw err('E_WRONG_ANALYSIS', 409);
  }
  if (['closed', 'cancelled'].includes(po.status)) throw err('E_ORDER_CLOSED', 409);

  const stage = getStage(db, orderId, stageId);
  if (stage.status !== 'in_progress') {
    throw err('E_INVALID_STATUS', 409, { status: stage.status });
  }

  const op = getOperation(db, stage, po.bom_id);
  const cc = db.prepare('SELECT * FROM cost_centers WHERE id=?').get(stage.cost_center_id);
  const date = body.date || todayJalali();
  const period = jalaliPeriod(date);
  const fy = assertFiscalYearWritable(db, date);
  if (!fy.ok) throw err('E_PERIOD_CLOSED', 409, { detail: fy.error });
  assertPeriodOpen(db, period);

  const qtyIn = num(stage.qty_in);
  const qtyOut = num(body.qty_out);
  let wNormal = num(body.waste_normal);
  let wAbnorm = num(body.waste_abnormal);
  const rework = num(body.rework);
  const sumOut = round6(qtyOut + wNormal + wAbnorm + rework);
  if (Math.abs(sumOut - qtyIn) > 0.01) {
    throw err('E_QTY_BALANCE', 422, { in: qtyIn, out: sumOut });
  }

  // W3 / ADR-006 — بعد از مرحلهٔ برش، بدون پوشش لایه‌چینی جلو نرو
  assertLayCompleteBeforePostCutStage(db, po, stage);
  assertCuttingOutputHasLay(db, po, stage, qtyOut);

  const allowedPct = op ? num(op.normal_waste_percent) : 0;
  const allowed = Math.ceil(qtyIn * allowedPct / 100 - 1e-9);
  let wN = wNormal;
  let wA = wAbnorm;
  let autoReclass = 0;
  if (wN > allowed) {
    autoReclass = round6(wN - allowed);
    wN = allowed;
    wA = round6(wA + autoReclass);
  }

  if (op?.is_qc_gate && body.qc_passed !== 1 && body.qc_passed !== true) {
    throw err('E_QC_REQUIRED', 422);
  }

  const jes = [];
  let matRial = 0, pkgRial = 0, matLines = [];

  if (mode === 'fixed') {
    const bf = backflushStageMaterials(db, {
      po, stage, date, period, userId,
      substitutes: body.materials || body.substitutes || [],
    });
    matRial = bf.matRial;
    pkgRial = bf.pkgRial;
    matLines = bf.lines;
    if (bf.total) {
      const je1 = postEvent(db, {
        event: 'PRD-01',
        sourceId: orderId,
        date,
        description: `مصرف مواد مرحله ${stage.seq} — ${po.order_no}`,
        createdBy: userId,
        costCenterId: stage.cost_center_id || po.cost_center_id || null,
        lines: plug([
          dr(db, 'coa_wip', bf.total, po.coa_wip_tafsili),
          cr(db, 'coa_raw_materials', matRial),
          cr(db, 'coa_packaging_materials', pkgRial),
        ]),
      });
      if (je1) {
        jes.push(je1);
        db.prepare(`
          UPDATE production_material_issues SET je_id=?
          WHERE order_id=? AND stage_id=? AND je_id IS NULL AND status='posted'
            AND COALESCE(issue_type,'')<>'cutting_lay'
        `).run(je1.je_id, orderId, stageId);
      }
    }
  } else {
    const hasBomLines = stageOwnsBomMaterials(db, po, stage) && db.prepare(`
      SELECT 1 FROM bom_lines WHERE bom_id=? AND stage_cost_center_id=? LIMIT 1
    `).get(po.bom_id, stage.cost_center_id);
    const issued = sumStageIssued(db, stageId);
    const regular = db.prepare(`
      SELECT COUNT(*) n FROM production_material_issues
      WHERE stage_id=? AND status='posted' AND COALESCE(issue_type,'')<>'extra'
    `).get(stageId);
    if (hasBomLines && (issued.total < 1 || !num(regular?.n))) throw err('E_NO_MATERIAL_ISSUED', 422);
    if (po.analysis_type === 'variable_adv') assertStageMaterialsIssued(db, po, stage);
    matRial = issued.matRial;
    pkgRial = issued.pkgRial;
  }
  // ثابت: backflush فقط استاندارد است؛ مصرف اضافهٔ عادیِ ثبت‌شده در طول مرحله هم با قطعه جلو می‌رود.
  const extraNormalRial = mode === 'fixed' ? sumStageExtraNormal(db, stageId) : 0;
  // ثابت: پارچهٔ لایهٔ زنده (memo بدون JE) در backflush نیست ولی در WIP سفارش هست.
  const layMemoRial = mode === 'fixed' ? Math.round(num(db.prepare(`
    SELECT COALESCE(SUM(amount_rial),0) s FROM production_material_issues
    WHERE stage_id=? AND status='posted' AND issue_type='cutting_lay'
  `).get(stageId)?.s)) : 0;

  const laborRial = stageLabor(db, op || {}, qtyIn, period);
  let laborMethod = op?.labor_method || 'piece';
  if (laborRial) {
    const person = loadPersonForLabor(db, op?.person_id);
    const { productCode, productName } = productLabelForOrder(db, po);
    const opName = op?.operation_name || op?.name || `مرحله ${stage.seq}`;
    const laborNote = formatLaborJeDescription({
      orderNo: po.order_no,
      productCode,
      productName,
      opName,
      stageSeq: stage.seq,
      qty: qtyIn,
      method: laborMethod,
      personName: person?.name,
      amountRial: laborRial,
    });
    const laborRow = postLabor(db, {
      orderId: po.id,
      stageId: stage.id,
      costCenterId: stage.cost_center_id,
      personId: op?.person_id || null,
      method: laborMethod,
      qty: qtyIn,
      hours: op ? ((num(op.setup_minutes) + num(op.run_minutes_per_unit) * qtyIn) / 60)
        * (num(op.crew_size) || 1) : 0,
      rateRial: laborMethod === 'monthly'
        ? Math.round(num(db.prepare(`
            SELECT monthly_labor_rate_rial FROM cost_center_rates
            WHERE cost_center_id=? AND period_label=?
          `).get(stage.cost_center_id, period)?.monthly_labor_rate_rial))
        : Math.round(num(op?.labor_rate_rial)),
      date, period, userId,
      note: laborNote,
    });
    const laborEntry = db.prepare('SELECT * FROM production_labor_entries WHERE id=?').get(laborRow.id);
    const laborJes = absorbLaborJournal(db, {
      orderId,
      date,
      userId,
      costCenterId: stage.cost_center_id || po.cost_center_id || null,
      wipTafsili: po.coa_wip_tafsili,
      entries: [laborEntry],
      descriptionFallback: laborNote,
      postEvent,
      dr,
      cr,
    });
    for (const j of laborJes) jes.push(j);
  }

  const ohDriverMat = matRial + pkgRial + extraNormalRial;
  const oh = applyStageOverhead(db, {
    po, stage, op, cc, qtyIn, laborRial, matRial: ohDriverMat, date, period, userId,
  });
  const laterStage = db.prepare(`
    SELECT id FROM production_order_stages
    WHERE order_id=? AND seq>? AND COALESCE(status,'')!='skipped'
    LIMIT 1
  `).get(orderId, stage.seq);
  let plant = { amount_rial: 0, lines: [] };
  if (!laterStage) {
    const { postPlantOverhead } = require('./overhead');
    const used = db.prepare('SELECT cost_center_id FROM production_order_stages WHERE order_id=?').all(orderId)
      .map((r) => Number(r.cost_center_id));
    const orderLabor = Math.round(num(po.labor_cost_rial) + laborRial);
    const orderMat = Math.round(num(po.material_cost_rial) + num(po.packaging_cost_rial) + ohDriverMat);
    plant = postPlantOverhead(db, {
      po, stageId: stage.id, qty: qtyOut, laborRial: orderLabor, matRial: orderMat,
      date, period, userId, skipCcIds: used, manual: num(po.manual_driver_qty),
    });
  }
  const ohTotal = (oh.amount_rial || 0) + (plant.amount_rial || 0);
  if (oh.amount_rial) {
    const je3 = postEvent(db, {
      event: 'PRD-05',
      sourceId: orderId,
      date,
      description: `جذب سربار مرحله ${stage.seq} — ${po.order_no}`,
      createdBy: userId,
      costCenterId: stage.cost_center_id || po.cost_center_id || null,
      lines: [
        dr(db, 'coa_wip', oh.amount_rial, po.coa_wip_tafsili),
        cr(db, 'coa_overhead_applied', oh.amount_rial),
      ],
    });
    if (je3) {
      jes.push(je3);
      db.prepare('UPDATE production_overhead_applications SET je_id=? WHERE id=?')
        .run(je3.je_id, oh.id);
    }
  }
  for (const line of plant.lines || []) {
    const jeP = postEvent(db, {
      event: 'PRD-05',
      sourceId: orderId,
      date,
      description: `جذب سربار سراسری ${line.name} — ${po.order_no}`,
      createdBy: userId,
      costCenterId: line.cost_center_id,
      lines: [
        dr(db, 'coa_wip', line.amount_rial, po.coa_wip_tafsili),
        cr(db, 'coa_overhead_applied', line.amount_rial),
      ],
    });
    if (jeP) {
      jes.push(jeP);
      db.prepare('UPDATE production_overhead_applications SET je_id=? WHERE id=?')
        .run(jeP.je_id, line.id);
    }
  }

  let subcontractRial = 0;
  if (stage.is_subcontract) {
    if (hasSubcontractIn(db, stageId)) {
      const r = db.prepare(`
        SELECT COALESCE(SUM(fee_amount_rial),0) s FROM production_subcontract
        WHERE stage_id=? AND direction='in' AND status='posted'
      `).get(stageId);
      subcontractRial = Math.round(num(r?.s));
    } else if (body.auto_subcontract_fee) {
      subcontractRial = insertAutoSubcontractFee(db, {
        po, stage, op, qtyIn, date, period, userId,
        supplierId: body.supplier_id,
      });
    } else {
      throw err('E_SUBCONTRACT_FEE_REQUIRED', 422);
    }
  }

  const costIn = Math.round(num(stage.material_in_rial));
  const materialAdded = matRial + pkgRial + extraNormalRial + layMemoRial;
  const costGross = costIn + materialAdded + laborRial + ohTotal + subcontractRial;
  const costPerIn = qtyIn > 0 ? costGross / qtyIn : 0;

  let abnormalRial = 0;
  if (wA > 0) {
    abnormalRial = Math.round(costPerIn * wA);
    let docNo = '';
    try { docNo = allocateNumber(db, 'production_waste', 'WS'); }
    catch { docNo = `WS-${Date.now()}`; }
    const wasteId = db.prepare(`
      INSERT INTO production_waste
        (doc_no, order_id, stage_id, cost_center_id, product_id, waste_type, qty, allowed_qty,
         unit_cost_rial, amount_rial, reason_code, reason_note, date, period_label, status, created_by)
      VALUES (?,?,?,?,?,'abnormal',?,?,?,?,?,?,?,?,'posted',?)
    `).run(
      docNo, orderId, stageId, stage.cost_center_id, po.product_id,
      wA, allowed, Math.round(costPerIn), abnormalRial,
      body.waste_abnormal_reason || 'other',
      autoReclass ? `شامل ${autoReclass} مازاد سقف` : (body.waste_abnormal_note || ''),
      date, period, userId
    ).lastInsertRowid;
    const je4 = postEvent(db, {
      event: 'PRD-09',
      sourceId: wasteId,
      date,
      description: `ضایعات غیرعادی مرحله ${stage.seq} — ${po.order_no}`,
      createdBy: userId,
      costCenterId: stage.cost_center_id || po.cost_center_id || null,
      lines: [
        dr(db, 'coa_abnormal_waste', abnormalRial),
        cr(db, 'coa_wip', abnormalRial, po.coa_wip_tafsili),
      ],
    });
    if (je4) {
      jes.push(je4);
      db.prepare('UPDATE production_waste SET je_id=? WHERE id=?').run(je4.je_id, wasteId);
    }
  }

  if (wN > 0) {
    let docNo = '';
    try { docNo = allocateNumber(db, 'production_waste', 'WS'); }
    catch { docNo = `WS-${Date.now()}`; }
    db.prepare(`
      INSERT INTO production_waste
        (doc_no, order_id, stage_id, cost_center_id, product_id, waste_type, qty, allowed_qty,
         date, period_label, status, created_by)
      VALUES (?,?,?,?,?,'normal',?,?,?,?,'posted',?)
    `).run(
      docNo, orderId, stageId, stage.cost_center_id, po.product_id,
      wN, allowed, date, period, userId
    );
  }

  let scrapCredit = 0;
  const scrapWh = whSetting(db, 'production_wh_scrap_id');
  for (const s of (body.scrap || [])) {
    const amt = Math.round(num(s.qty) * num(s.nrv_unit_rial));
    scrapCredit += amt;
    receiveScrap(db, {
      productId: s.product_id,
      qty: s.qty,
      unitRial: s.nrv_unit_rial,
      warehouseId: scrapWh,
      userId,
      orderId,
      date,
      period,
    });
  }
  if (scrapCredit) {
    const je5 = postEvent(db, {
      event: 'PRD-10',
      sourceId: orderId,
      date,
      description: `ضایعات قابل فروش مرحله ${stage.seq} — ${po.order_no}`,
      createdBy: userId,
      costCenterId: stage.cost_center_id || po.cost_center_id || null,
      lines: [
        dr(db, 'coa_scrap_inventory', scrapCredit),
        cr(db, 'coa_wip', scrapCredit, po.coa_wip_tafsili),
      ],
    });
    if (je5) jes.push(je5);
  }

  // اتلاف لایه که قبلاً با PRD-09 از WIP خارج شده؛ در costOut کم شود تا رسید = خالص WIP.
  // برش مشترک قدیمی (بستانکار مواد) وارد WIP نشده و اینجا کم نمی‌شود.
  const classicLayWaste = (() => {
    try {
      const { layWasteInWipSql, wipAccountCode } = require('./order-cost-reconcile');
      const row = db.prepare(`
        SELECT COALESCE(SUM(waste_amount_rial),0) AS s
        FROM cutting_lays
        WHERE stage_id=? AND COALESCE(status,'posted')='posted'
          AND ${layWasteInWipSql('')}
      `).get(stageId, wipAccountCode(db));
      return Math.round(Number(row && row.s) || 0);
    } catch (_) { return 0; }
  })();
  const costOut = Math.round(costGross - abnormalRial - scrapCredit - classicLayWaste);
  const unitCostOut = qtyOut > 0 ? Math.round(costOut / qtyOut) : 0;

  db.prepare(`
    UPDATE production_order_stages SET
      qty_out=?, qty_waste_normal=?, qty_waste_abnormal=?, qty_rework=?,
      material_added_rial=?, labor_rial=?, overhead_rial=?, subcontract_rial=?,
      waste_abnormal_rial=?, scrap_credit_rial=?, cost_out_rial=?, unit_cost_out_rial=?,
      driver_qty=?, status='done', ended_at=?, qc_passed=?, qc_note=?
    WHERE id=?
  `).run(
    qtyOut, wN, wA, rework,
    materialAdded, laborRial, ohTotal, subcontractRial,
    abnormalRial, scrapCredit, costOut, unitCostOut,
    oh.driver_qty || 0, date,
    body.qc_passed != null ? (body.qc_passed ? 1 : 0) : stage.qc_passed,
    body.qc_note || stage.qc_note || '',
    stageId
  );

  const nxt = handoffNextStage(db, stage, { qtyOut, costOut, date });

  // variable_adv: materials already added on the order in issueStageMaterials (PRD-01).
  // Re-adding here doubled material_cost_rial and blocked close (E_WIP_NOT_ZERO / PO-0006).
  const orderMat = mode === 'variable' ? 0 : matRial;
  const orderPkg = mode === 'variable' ? 0 : pkgRial;
  db.prepare(`
    UPDATE production_orders SET
      material_cost_rial = material_cost_rial + ?,
      packaging_cost_rial = packaging_cost_rial + ?,
      labor_cost_rial = labor_cost_rial + ?,
      overhead_cost_rial = overhead_cost_rial + ?,
      subcontract_cost_rial = subcontract_cost_rial + ?,
      abnormal_waste_rial = abnormal_waste_rial + ?,
      scrap_credit_rial = scrap_credit_rial + ?,
      qty_waste_normal = qty_waste_normal + ?,
      qty_waste_abnormal = qty_waste_abnormal + ?,
      status = 'in_progress',
      actual_start = CASE WHEN actual_start='' OR actual_start IS NULL THEN ? ELSE actual_start END,
      updated_at = strftime('%s','now')
    WHERE id=?
  `).run(
    orderMat, orderPkg, laborRial, ohTotal, subcontractRial,
    abnormalRial, scrapCredit, wN, wA, date, orderId
  );

  const stages = stageList(db, orderId);
  const doneCount = stages.filter(s => s.status === 'done').length;

  emit(db, 'production.stage.completed', {
    orderId, stageId, ccId: stage.cost_center_id, qtyOut, costOutRial: costOut,
  });

  applyDocumentCosts(db, orderId);

  return {
    ok: true,
    stage: { id: stageId, seq: stage.seq, status: 'done' },
    qty: {
      in: qtyIn, out: qtyOut, waste_normal: wN, waste_abnormal: wA,
      allowed_normal: allowed, auto_reclassified: autoReclass,
    },
    costs: {
      cost_in_rial: costIn,
      material_added_rial: materialAdded,
      labor_rial: laborRial,
      labor_method: laborMethod,
      subcontract_rial: subcontractRial,
      overhead_rial: ohTotal,
      overhead_driver: oh.driver,
      overhead_driver_qty: oh.driver_qty,
      overhead_rate_rial: oh.rate_rial,
      abnormal_waste_rial: abnormalRial,
      scrap_credit_rial: scrapCredit,
      cost_out_rial: costOut,
      unit_cost_out_rial: unitCostOut,
    },
    materials: matLines,
    journal_entries: jes,
    next_stage: nxt ? {
      id: nxt.id, seq: nxt.seq, qty_in: qtyOut,
      cost_in_rial: costOut, status: 'in_progress',
    } : null,
    order_progress: {
      stages_done: doneCount,
      stages_total: stages.length,
      percent: stages.length ? Math.round((doneCount / stages.length) * 1000) / 10 : 0,
    },
  };
}

function stageIsCutting(db, op) {
  const cc = db.prepare('SELECT code, name FROM cost_centers WHERE id=?').get(op.cost_center_id);
  const blob = `${cc?.code || ''} ${cc?.name || ''} ${op.operation_name || ''}`;
  return /برش|CC-10|\bCUT\b/i.test(blob);
}

/** چند فرمول روی یک سفارش: یک مرحلهٔ برش مشترک، بعد مراحل هر محصول جدا. */
function releasePeerBomOrder(db, po, userId) {
  const lines = orderBomPeerLines(po);
  const pieces = lines.map((line) => {
    const ops = db.prepare('SELECT * FROM bom_operations WHERE bom_id=? ORDER BY seq, id').all(line.bom_id);
    const qty = orderQtyAsMainBase(db, line.bom_id, line.qty_planned, line.product_id);
    const back = ops.length ? backwardQty(db, line.bom_id, qty) : { qty_start: qty };
    return { line, ops, qtyStart: Number(back.qty_start) || qty };
  });
  const cuts = [];
  const rest = [];
  for (const piece of pieces) {
    let seenCut = false;
    for (const op of piece.ops) {
      if (!seenCut && stageIsCutting(db, op)) {
        cuts.push({ piece, op });
        seenCut = true;
      } else {
        rest.push({ piece, op });
      }
    }
  }
  if (!cuts.length && !rest.length) throw err('E_ROUTING_EMPTY', 422);

  const ins = db.prepare(`
    INSERT INTO production_order_stages
      (order_id, seq, cost_center_id, operation_id, operation_name, status,
       qty_in, qty_planned_in, driver, is_subcontract, supplier_id, created_by,
       product_scope, scoped_product_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  let seq = 10;
  let opened = false;
  const openStatus = () => {
    const status = opened ? 'pending' : 'in_progress';
    opened = true;
    return status;
  };
  if (cuts.length) {
    const op = cuts[0].op;
    const qty = cuts.reduce((s, c) => s + (Number(c.piece.qtyStart) || 0), 0);
    const cc = db.prepare('SELECT driver FROM cost_centers WHERE id=?').get(op.cost_center_id);
    ins.run(
      po.id, seq, op.cost_center_id, op.id, op.operation_name || 'برش مشترک',
      openStatus(), qty, qty, op.overhead_driver || cc?.driver || '',
      op.is_subcontract ? 1 : 0, op.subcontract_supplier_id || null, userId,
      'shared', null
    );
    seq += 10;
  }
  for (const item of rest) {
    const op = item.op;
    const qty = Number(item.piece.line.qty_planned) || 0;
    const cc = db.prepare('SELECT driver FROM cost_centers WHERE id=?').get(op.cost_center_id);
    ins.run(
      po.id, seq, op.cost_center_id, op.id, op.operation_name || '',
      openStatus(), qty, qty, op.overhead_driver || cc?.driver || '',
      op.is_subcontract ? 1 : 0, op.subcontract_supplier_id || null, userId,
      'exclusive', item.piece.line.product_id
    );
    seq += 10;
  }

  for (const piece of pieces) {
    const bom = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(piece.line.bom_id);
    const ex = explodeBom(db, {
      bomId: piece.line.bom_id,
      qty: orderQtyAsMainBase(db, piece.line.bom_id, piece.line.qty_planned, piece.line.product_id),
      priceBasis: 'average',
      yieldOverride: bom?.has_routing ? 100 : null,
      forProductId: piece.line.product_id,
    });
    for (const L of ex.lines) {
      db.prepare(`
        INSERT INTO production_reservations
          (order_id, product_id, warehouse_id, qty, status, date)
        VALUES (?,?,?,?,'active',?)
      `).run(po.id, L.product_id, po.warehouse_raw_id, L.qty_final, po.date);
    }
  }

  db.prepare(`
    UPDATE production_orders SET status='released', updated_at=strftime('%s','now') WHERE id=?
  `).run(po.id);
  audit(userId, 'update', 'production_order', po.id, `آزادسازی چندفرمولی ${po.order_no}`);
  emit(db, 'production.order.released', { orderId: po.id });
  return { ok: true, order: getOrder(db, po.id), stages: stageList(db, po.id) };
}

function releaseAdvancedOrder(db, orderId, userId) {
  return db.transaction(() => {
    const po = getOrder(db, orderId);
    if (!['fixed_adv', 'variable_adv'].includes(po.analysis_type)) {
      throw err('E_WRONG_ANALYSIS', 409);
    }
    if (po.status !== 'draft') throw err('E_INVALID_STATUS', 409, { status: po.status });
    if (!po.bom_id) throw err('E_NO_ACTIVE_BOM', 422);
    require('./product-completeness').assertOrderReady(db, orderId, 'release');
    if (orderBomPeerLines(po)) return releasePeerBomOrder(db, po, userId);

    const bom = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(po.bom_id);
    if (!bom?.has_routing) throw err('E_NO_ROUTING', 422);

    const ops = db.prepare(`
      SELECT * FROM bom_operations WHERE bom_id=? ORDER BY seq
    `).all(po.bom_id);
    if (!ops.length) throw err('E_ROUTING_EMPTY', 422);

    const { qty_start: qtyStart } = backwardQty(db, po.bom_id, explodeQtyForOrder(db, po));

    const multi = isMultiproductBom(db, po.bom_id);
    let plannedByOp = new Map();
    if (multi) {
      const map = orderFgQtyMap(db, po) || {};
      for (const row of planScopedStageQtys(ops, map)) {
        plannedByOp.set(Number(row.operation_id), row);
      }
    }
    const opRows = multi
      ? ops.filter(op => {
        const row = plannedByOp.get(Number(op.id));
        return row && Number(row.qty_in) > 0;
      })
      : ops;
    if (!opRows.length) throw err('E_ROUTING_EMPTY', 422);

    let qtyIn = qtyStart;
    const ins = db.prepare(`
      INSERT INTO production_order_stages
        (order_id, seq, cost_center_id, operation_id, operation_name, status,
         qty_in, qty_planned_in, driver, is_subcontract, supplier_id, created_by,
         product_scope, scoped_product_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    for (let i = 0; i < opRows.length; i++) {
      const op = opRows[i];
      const planned = plannedByOp.get(Number(op.id));
      const cc = db.prepare('SELECT driver FROM cost_centers WHERE id=?').get(op.cost_center_id);
      const isFirst = i === 0;
      const scope = planned
        ? planned.product_scope
        : (String(op.product_scope || 'shared').toLowerCase() === 'exclusive' && op.scoped_product_id ? 'exclusive' : 'shared');
      const scopedId = scope === 'exclusive'
        ? (planned?.scoped_product_id || op.scoped_product_id || null)
        : null;
      const thisQty = planned ? planned.qty_in : (isFirst ? qtyIn : 0);
      ins.run(
        orderId, op.seq, op.cost_center_id, op.id, op.operation_name || '',
        isFirst ? 'in_progress' : 'pending',
        thisQty,
        thisQty,
        op.overhead_driver || cc?.driver || '',
        op.is_subcontract ? 1 : 0,
        op.subcontract_supplier_id || null,
        userId,
        scope,
        scopedId
      );
      if (!planned) {
        qtyIn = round6(
          qtyIn * ((num(op.yield_percent) || 100) / 100)
            * (1 - (num(op.normal_waste_percent) || 0) / 100)
        );
      }
    }

    reserveMaterials(db, po, qtyStart);

    db.prepare(`
      UPDATE production_orders SET status='released', updated_at=strftime('%s','now') WHERE id=?
    `).run(orderId);

    audit(userId, 'update', 'production_order', orderId, `آزادسازی پیشرفته ${po.order_no}`);
    emit(db, 'production.order.released', { orderId, qtyStart });
    return { ok: true, order: getOrder(db, orderId), qty_start: qtyStart, stages: stageList(db, orderId) };
  })();
}

function startStage(db, orderId, stageId, userId) {
  return db.transaction(() => {
    const stage = getStage(db, orderId, stageId);
    if (stage.status !== 'pending') throw err('E_INVALID_STATUS', 409, { status: stage.status });
    const prev = prevStage(db, orderId, stage.seq);
    if (prev && !['done', 'skipped'].includes(prev.status)) {
      throw err('E_PREV_STAGE_OPEN', 409, { prev_seq: prev.seq, prev_status: prev.status });
    }
    const poGate = getOrder(db, orderId);
    assertLayCompleteBeforePostCutStage(db, poGate, stage);
    if (num(stage.qty_in) <= 0) throw err('E_QTY_INVALID', 422);
    const date = todayJalali();
    db.prepare(`
      UPDATE production_order_stages SET status='in_progress', started_at=? WHERE id=?
    `).run(date, stageId);
    emit(db, 'production.stage.started', {
      orderId, stageId, ccId: stage.cost_center_id, qtyIn: stage.qty_in,
    });
    return { ok: true, stage_id: stageId, status: 'in_progress' };
  })();
}

function postStageOutputFixed(db, opts) {
  return db.transaction(() => postStageCore(db, { ...opts, mode: 'fixed' }))();
}

function postStageOutputVariable(db, opts) {
  return db.transaction(() => postStageCore(db, { ...opts, mode: 'variable' }))();
}

function finalizeAdvancedOrder(db, { orderId, body, userId }) {
  return db.transaction(() => {
    const po = getOrder(db, orderId);
    if (!['fixed_adv', 'variable_adv'].includes(po.analysis_type)) {
      throw err('E_WRONG_ANALYSIS', 409);
    }
    if (po.status === 'completed') throw err('E_ORDER_FINALIZED', 409);
    if (['closed', 'cancelled'].includes(po.status)) throw err('E_ORDER_CLOSED', 409);
    require('./product-completeness').assertOrderReady(db, orderId, 'finalize');

    const stages = stageList(db, orderId);
    const last = stages[stages.length - 1];
    if (!last || last.status !== 'done') throw err('E_LAST_STAGE_NOT_DONE', 409);

    const open = stages.filter(s => !['done', 'skipped'].includes(s.status));
    if (open.length) throw err('E_STAGES_OPEN', 409, { open: open.map(s => s.seq) });

    const RDG = require('./receipt-date-guard');
    const date = String(body.date || RDG.defaultReceiptDate(db, orderId, po.date || todayJalali())).trim();
    RDG.assertReceiptNotBeforeLastActivity(db, orderId, date);
    const period = jalaliPeriod(date);
    assertPeriodOpen(db, period);
    const jes = [];
    const wipFinal = Math.round(num(last.cost_out_rial));

    const bom = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(po.bom_id);
    const qtyStart = backwardQty(db, po.bom_id, explodeQtyForOrder(db, po)).qty_start;
    const outs = db.prepare('SELECT * FROM bom_outputs WHERE bom_id=?').all(po.bom_id);

    let byCredit = 0;
    const scrapWh = whSetting(db, 'production_wh_scrap_id');

    const fgWh = po.warehouse_fg_id || whSetting(db, 'production_wh_fg_id');
    for (const o of outs.filter(x => ['by', 'scrap'].includes(x.output_type))) {
      if (o.cost_method === 'zero') continue;
      const q = round6(num(o.qty_per_base) * qtyStart / (bom.base_qty || 1));
      const nrv = Math.round(num(o.nrv_rial));
      const amt = Math.round(q * nrv);
      if (!amt) continue;
      byCredit += amt;

      // ADR-003: scrap→1113+WH scrap؛ by (همزاد)→1104+WH FG
      const isScrapOut = o.output_type === 'scrap';
      const invKey = isScrapOut ? 'coa_scrap_inventory' : 'coa_finished_goods';
      receiveScrap(db, {
        productId: o.product_id,
        qty: q,
        unitRial: nrv,
        warehouseId: isScrapOut ? scrapWh : fgWh,
        userId,
        orderId,
        date,
        period,
      });

      const jeBy = postEvent(db, {
        event: 'PRD-16',
        sourceId: orderId,
        date,
        description: `محصول فرعی — ${po.order_no}`,
        createdBy: userId,
        lines: [
          dr(db, invKey, amt),
          cr(db, 'coa_wip', amt, po.coa_wip_tafsili),
        ],
      });
      if (jeBy) jes.push(jeBy);
    }

    if (byCredit > wipFinal) throw err('E_NRV_EXCEEDS_WIP', 422);

    const wipNet = wipFinal - byCredit;
    const qtyGood = num(body.qty_produced != null ? body.qty_produced : last.qty_out);
    if (qtyGood <= 0) throw err('E_QTY_INVALID', 422);

    // v420/v423: override تعداد هر محصول اصلی از body.outputs[{product_id,qty}]
    const qtyByProduct = {};
    if (Array.isArray(body.outputs)) {
      for (const row of body.outputs) {
        const pid = Number(row?.product_id);
        if (!pid) continue;
        if (row.qty == null && row.qty_produced == null) continue;
        qtyByProduct[pid] = num(row.qty != null ? row.qty : row.qty_produced);
      }
    }
    const orderOverride = qtyByProduct[Number(po.product_id)];
    const qtyGoodFinal = orderOverride != null ? orderOverride : qtyGood;
    if (qtyGoodFinal <= 0) throw err('E_QTY_INVALID', 422);

    // F06: refuse finalize if a standalone cut-to-stock PACK already credited FG
    // for this product — that would double products.stock / WH-FG.
    require('./cutting').assertNoOrphanSellablePack(db, po.product_id, orderId);
    // طاقه‌دار: برش و PACK هر محصول باید با تعداد سفارش یکی باشد؛ وگرنه رسید FG ممنوع.
    require('./cutting').assertOrderCutQtyMatches(db, po);

    const costSplit = require('./order-cost-split');
    const { shareOuts, residueProductId: residuePid } = costSplit.orderMainShareOuts(db, po);
    const sumShare = shareOuts.reduce((s, o) => s + (Number(o.cost_share_percent) || 0), 0);
    if (shareOuts.length > 1 && Math.abs(sumShare - 100) > 0.01) {
      throw err('E_SHARE_NOT_100', 422, { sum: sumShare });
    }

    const split = costSplit.splitOrderCost(db, po, {
      total: wipNet,
      products: shareOuts.map(o => ({ product_id: o.product_id, pct: o.cost_share_percent })),
      residueProductId: residuePid,
    });
    const splitByPid = new Map(split.rows.map(r => [r.product_id, r]));
    const baseQty = Number(bom?.base_qty) || 1;

    const allocations = shareOuts.map(o => {
      const pid = Number(o.product_id);
      const isOrderProduct = pid === Number(po.product_id);
      let q;
      if (qtyByProduct[pid] != null) {
        q = qtyByProduct[pid];
      } else if (o._peer_qty != null) {
        q = o._peer_qty;
      } else if (isOrderProduct || shareOuts.length === 1) {
        q = qtyGoodFinal;
      } else {
        q = round6(num(o.qty_per_base) * qtyStart / baseQty);
      }
      if (!(q > 0) && shareOuts.length > 1) {
        throw err('E_QTY_INVALID', 422, {
          product_id: pid,
          detail: 'تعداد رسید هر محصول اصلی باید مثبت باشد',
        });
      }
      const s = splitByPid.get(pid) || { fabric_rial: 0, exclusive_rial: 0, shared_rial: 0, amount_rial: 0 };
      return {
        product_id: pid,
        output_type: 'main',
        qty: q,
        fabric_rial: s.fabric_rial,
        exclusive_rial: s.exclusive_rial,
        shared_rial: s.shared_rial,
        amount_rial: s.amount_rial,
        is_order_product: isOrderProduct,
        is_main: true,
      };
    });
    const mainAlloc = allocations.find(a => Number(a.product_id) === residuePid) || allocations[0];

    // Each main product keeps its own color×size. A shared last stage outputs
    // the sum; that sum is not the target of any one product's matrix.
    const fgLinesByProduct = new Map();
    for (const a of allocations) {
      if (!(a.qty > 0)) continue;
      fgLinesByProduct.set(Number(a.product_id), resolveProductApparelLines(
        db, po, body, a.product_id, a.qty, { isOrderProduct: !!a.is_order_product }
      ));
    }

    const receipts = [];
    let primaryReceiptId = null;
    let unitCost = 0;

    for (const a of allocations) {
      if (!(a.qty > 0) || !(a.amount_rial > 0)) continue;
      const uc = Math.round(a.amount_rial / a.qty);
      if (a.is_order_product) unitCost = uc;

      const avg = updateMovingAverage(db, {
        productId: a.product_id,
        warehouseId: po.warehouse_fg_id || fgWh,
        qtyIn: a.qty,
        amountRial: a.amount_rial,
        userId,
        note: `تولید ${po.order_no}`,
        sourceType: 'production_receipt',
        sourceId: po.id,
        date,
        variantLines: fgLinesByProduct.get(Number(a.product_id)) || [],
      });

      let docNo = '';
      try { docNo = allocateNumber(db, 'production_receipt', 'PR'); }
      catch { docNo = `PR-${Date.now()}`; }

      const receiptId = db.prepare(`
        INSERT INTO production_receipts
          (doc_no, order_id, product_id, output_type, qty, unit_cost_rial, amount_rial,
           warehouse_id, is_partial, prev_avg_rial, prev_stock_qty, new_avg_rial,
           date, period_label, status, created_by)
        VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?,'posted',?)
      `).run(
        docNo, orderId, a.product_id, a.output_type, a.qty, uc, a.amount_rial,
        po.warehouse_fg_id || fgWh,
        avg.prev_avg, avg.prev_qty, avg.new_avg, date, period, userId
      ).lastInsertRowid;

      if (a.is_order_product) primaryReceiptId = receiptId;
      const fgLines = fgLinesByProduct.get(Number(a.product_id)) || [];
      if (fgLines.length) {
        require('../inventory/apparel-lines').postApparelLines(db, {
          productId: a.product_id, warehouseId: po.warehouse_fg_id || fgWh,
          lines: fgLines, docType: 'production_fg', docId: receiptId, userId,
          note: `رسید تولید ${po.order_no}`, sign: 1, allowNegative: true,
        });
        require('../inventory/apparel-lines').saveDocVariantLines(
          db, 'production_receipts', receiptId, fgLines
        );
      }

      const je7 = postEvent(db, {
        event: 'PRD-07',
        sourceId: receiptId,
        date,
        description: `رسید تولید ${a.qty} — ${po.order_no}`,
        createdBy: userId,
        lines: [
          dr(db, 'coa_finished_goods', a.amount_rial),
          cr(db, 'coa_wip', a.amount_rial, po.coa_wip_tafsili),
        ],
      });
      if (je7) {
        jes.push(je7);
        db.prepare('UPDATE production_receipts SET je_id=? WHERE id=?').run(je7.je_id, receiptId);
      }
      receipts.push({
        receipt_id: receiptId, product_id: a.product_id, output_type: a.output_type,
        qty: a.qty, amount_rial: a.amount_rial, unit_cost_rial: uc,
      });
    }

    if (!primaryReceiptId && receipts.length) primaryReceiptId = receipts[0].receipt_id;
    if (!unitCost && mainAlloc && mainAlloc.qty > 0) {
      unitCost = Math.round(mainAlloc.amount_rial / mainAlloc.qty);
    }

    const orderAlloc = allocations.find(a => Number(a.product_id) === Number(po.product_id))
      || mainAlloc;
    const qtyProducedOrder = orderAlloc && orderAlloc.qty > 0 ? orderAlloc.qty : qtyGoodFinal;
    const unitCostOrder = orderAlloc && orderAlloc.qty > 0
      ? Math.round(orderAlloc.amount_rial / orderAlloc.qty)
      : unitCost;

    for (const rec of receipts) {
      relieveStagedPackQty(db, {
        orderId, productId: rec.product_id, qtyGood: rec.qty, userId, date, receiptId: rec.receipt_id,
      });
    }

    db.prepare(`
      UPDATE production_orders SET
        qty_produced = ?,
        byproduct_credit_rial = ?,
        total_cost_rial = ?,
        unit_cost_rial = ?,
        status = 'completed',
        actual_end = ?,
        period_label = ?,
        updated_at = strftime('%s','now')
      WHERE id=?
    `).run(qtyProducedOrder, byCredit, wipNet, unitCostOrder, date, period, orderId);

    db.prepare(`
      UPDATE production_reservations SET status='consumed', qty_consumed=qty
      WHERE order_id=? AND status='active'
    `).run(orderId);

    const residual = wipResidual(db, orderId);
    emit(db, 'production.order.finalized', { orderId, unitCostRial: unitCostOrder, wipNet, receipts });

    try {
      const { applyPricingFromCost } = require('../../routes/pricing-rules');
      applyPricingFromCost(db, po.product_id, unitCostOrder);
      for (const r of receipts) {
        if (Number(r.product_id) === Number(po.product_id)) continue;
        if (r.unit_cost_rial > 0) applyPricingFromCost(db, r.product_id, r.unit_cost_rial);
      }
    } catch (e) { console.warn('pricing_rules:', e.message); }

    return {
      ok: true,
      receipt_id: primaryReceiptId,
      receipts,
      qty_produced: qtyProducedOrder,
      byproduct_credit_rial: byCredit,
      wip_final_rial: wipFinal,
      amount_rial: wipNet,
      unit_cost_rial: unitCostOrder,
      journal_entries: jes,
      wip_residual_rial: residual,
    };
  })();
}

function skipStage(db, orderId, stageId, userId, reason = '') {
  return db.transaction(() => {
    const stage = getStage(db, orderId, stageId);
    if (stage.status !== 'pending') throw err('E_INVALID_STATUS', 409);
    const prev = prevStage(db, orderId, stage.seq);
    if (prev && !['done', 'skipped'].includes(prev.status)) {
      throw err('E_PREV_STAGE_OPEN', 409, { prev_seq: prev.seq, prev_status: prev.status });
    }
    const hasCost = num(stage.material_added_rial) || num(stage.labor_rial);
    if (hasCost) throw err('E_STAGE_HAS_COST', 409);
    // اگر این مرحله مواد BOM دارد، skip بدون حواله/JE ممنوع است
    const po = getOrder(db, orderId);
    const ownedMats = stageMaterialLines(db, po, stage);
    if (ownedMats.some((L) => num(L.qty_final) > 0)) {
      throw err('E_STAGE_HAS_MATERIALS', 409, {
        detail: 'مرحله دارای مواد تعریف‌شده است — ابتدا حواله/خروجی بزنید یا مواد را از مسیر BOM جدا کنید',
      });
    }
    db.prepare(`
      UPDATE production_order_stages SET status='skipped', note=? WHERE id=?
    `).run(reason || 'رد شده', stageId);

    // انتقال qty/cost از آخرین مرحلهٔ done به مرحلهٔ بعد (جلوگیری از qty_in=0)
    const lastDone = db.prepare(`
      SELECT * FROM production_order_stages
      WHERE order_id=? AND status='done' AND seq < ?
      ORDER BY seq DESC LIMIT 1
    `).get(orderId, stage.seq);
    const nxt = nextStage(db, orderId, stage.seq);
    if (nxt && lastDone && num(lastDone.qty_out) > 0) {
      if (stageScopeKey(stage) === stageScopeKey(nxt)) {
        db.prepare(`
          UPDATE production_order_stages SET qty_in=?, material_in_rial=? WHERE id=?
        `).run(lastDone.qty_out, lastDone.cost_out_rial || 0, nxt.id);
      } else if (!(num(nxt.material_in_rial) > 0)) {
        db.prepare(`
          UPDATE production_order_stages SET material_in_rial=? WHERE id=?
        `).run(lastDone.cost_out_rial || 0, nxt.id);
      }
    }

    emit(db, 'production.stage.skipped', { orderId, stageId, reason });
    return { ok: true, stage_id: stageId, status: 'skipped' };
  })();
}

function blockStage(db, orderId, stageId, userId, reason = '') {
  const stage = getStage(db, orderId, stageId);
  if (!['pending', 'in_progress'].includes(stage.status)) {
    throw err('E_INVALID_STATUS', 409);
  }
  db.prepare(`
    UPDATE production_order_stages SET status='blocked', note=? WHERE id=?
  `).run(reason || 'متوقف', stageId);
  emit(db, 'production.stage.blocked', { orderId, stageId, reason });
  return { ok: true, stage_id: stageId, status: 'blocked' };
}

function unblockStage(db, orderId, stageId, userId) {
  const stage = getStage(db, orderId, stageId);
  if (stage.status !== 'blocked') throw err('E_INVALID_STATUS', 409);
  const target = num(stage.qty_out) > 0 ? 'done' : (num(stage.qty_in) > 0 ? 'in_progress' : 'pending');
  db.prepare('UPDATE production_order_stages SET status=? WHERE id=?').run(target, stageId);
  return { ok: true, stage_id: stageId, status: target };
}

function lastDoneStage(db, orderId) {
  return db.prepare(`
    SELECT * FROM production_order_stages
    WHERE order_id=? AND status='done'
    ORDER BY seq DESC LIMIT 1
  `).get(orderId);
}

function resetDownstreamStages(db, orderId, afterSeq) {
  const origin = db.prepare(`
    SELECT * FROM production_order_stages WHERE order_id=? AND seq=?
  `).get(orderId, afterSeq);
  const rows = db.prepare(`
    SELECT * FROM production_order_stages
    WHERE order_id=? AND seq > ? ORDER BY seq
  `).all(orderId, afterSeq);
  for (const st of rows) {
    if (st.status === 'done') continue;
    const cross = origin && stageScopeKey(st) !== stageScopeKey(origin);
    const qty = cross && num(st.qty_planned_in) > 0 ? num(st.qty_planned_in) : 0;
    // حواله‌های posted این مرحله باطل نمی‌شوند؛ بهایشان روی مرحله بماند.
    const keptMat = sumStageIssued(db, st.id).total;
    db.prepare(`
      UPDATE production_order_stages SET
        qty_in=?, material_in_rial=0,
        qty_out=0, qty_waste_normal=0, qty_waste_abnormal=0, qty_rework=0,
        material_added_rial=?, labor_rial=0, overhead_rial=0, subcontract_rial=0,
        waste_abnormal_rial=0, scrap_credit_rial=0, cost_out_rial=0, unit_cost_out_rial=0,
        driver_qty=0, status='pending', started_at=NULL, ended_at=NULL
      WHERE id=?
    `).run(qty, keptMat, st.id);
  }
}

/**
 * PRD-99 stage reversal — only the last completed stage (R12: reverse, not delete).
 */
/**
 * releaseLayIssueIds: فقط از مسیر ابطال/ویرایش لایه‌چینی؛ ردیف‌های cutting_lay همان لایه.
 * در ابطال دستی مرحله، لایهٔ زنده (موجودی پارچه + JE) دست نمی‌خورد، پس ردیفش هم posted می‌ماند
 * تا بهای پارچه در WIP سفارش بماند و ثبت دوبارهٔ خروجی همان لایه را مصرف کند.
 */
function reverseStage(db, { orderId, stageId, reason, userId, date, releaseLayIssueIds = [] }) {
  return db.transaction(() => {
    const po = getOrder(db, orderId);
    if (!['fixed_adv', 'variable_adv'].includes(po.analysis_type)) {
      throw err('E_WRONG_ANALYSIS', 409);
    }
    if (['closed', 'cancelled'].includes(po.status)) throw err('E_ORDER_CLOSED', 409);
    if (po.status === 'completed') throw err('E_ORDER_FINALIZED', 409);

    const stage = getStage(db, orderId, stageId);
    if (stage.status !== 'done') throw err('E_INVALID_STATUS', 409, { status: stage.status });

    const lastDone = lastDoneStage(db, orderId);
    if (!lastDone || lastDone.id !== stage.id) {
      throw err('E_CANNOT_REVERSE', 409, { last_done_seq: lastDone?.seq });
    }

    if (stage.is_subcontract) {
      const pending = db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN direction='out' THEN qty ELSE 0 END),0) -
               COALESCE(SUM(CASE WHEN direction='in' THEN COALESCE(qty_returned, qty) ELSE 0 END),0) AS p
        FROM production_subcontract WHERE stage_id=? AND status='posted'
      `).get(stageId);
      if (num(pending?.p) > 0.0001) throw err('E_SUBCON_IN_TRANSIT', 409);
    }

    const revDate = date || todayJalali();
    const fy = assertFiscalYearWritable(db, revDate);
    if (!fy.ok) throw err('E_PERIOD_CLOSED', 409, { detail: fy.error });

    const jeIds = [];

    const scrapJes = db.prepare(`
      SELECT id FROM journal_entries
      WHERE ref_type='production_scrap' AND ref_id=?
        AND description LIKE ? AND COALESCE(deleted_at,0)=0
    `).all(orderId, `%مرحله ${stage.seq}%`);
    for (const j of scrapJes) jeIds.push(j.id);

    const wastes = db.prepare(`
      SELECT * FROM production_waste WHERE stage_id=? AND status='posted' ORDER BY id DESC
    `).all(stageId);
    for (const w of wastes) {
      if (w.je_id) jeIds.push(w.je_id);
    }

    const subs = db.prepare(`
      SELECT * FROM production_subcontract WHERE stage_id=? AND status='posted' ORDER BY id DESC
    `).all(stageId);
    for (const s of subs.filter(x => x.direction === 'in' && x.je_id)) jeIds.push(s.je_id);
    for (const s of subs.filter(x => x.direction === 'in')) {
      const lostJes = db.prepare(`
        SELECT id FROM journal_entries
        WHERE ref_type='production_waste' AND ref_id=? AND COALESCE(deleted_at,0)=0
      `).all(s.id);
      for (const j of lostJes) jeIds.push(j.id);
    }
    for (const s of subs.filter(x => x.direction === 'out' && x.je_id)) jeIds.push(s.je_id);

    const ohs = db.prepare(`
      SELECT * FROM production_overhead_applications WHERE stage_id=? AND status='posted'
    `).all(stageId);
    for (const o of ohs) if (o.je_id) jeIds.push(o.je_id);

    const labs = db.prepare(`
      SELECT * FROM production_labor_entries WHERE stage_id=? AND status='posted'
    `).all(stageId);
    for (const l of labs) if (l.je_id) jeIds.push(l.je_id);

    const issuedBefore = sumStageIssued(db, stageId);
    const releaseLay = new Set((releaseLayIssueIds || []).map(Number));
    const issues = db.prepare(`
      SELECT * FROM production_material_issues WHERE stage_id=? AND status='posted'
    `).all(stageId).filter(i => String(i.issue_type || '') !== 'cutting_lay' || releaseLay.has(Number(i.id)));
    for (const i of issues) {
      if (i.je_id && String(i.issue_type || '') !== 'cutting_lay') jeIds.push(i.je_id);
    }

    const reversedJeIds = [];
    const seen = new Set();
    for (const jeId of jeIds) {
      if (!jeId || seen.has(jeId)) continue;
      seen.add(jeId);
      const revId = reverseEvent(db, { jeId, reason, userId, date: revDate });
      reversedJeIds.push(revId);
      db.prepare(`
        UPDATE production_waste SET reversed_je_id=?, status='reversed' WHERE je_id=?
      `).run(revId, jeId);
      db.prepare(`
        UPDATE production_overhead_applications SET reversed_je_id=?, status='reversed' WHERE je_id=?
      `).run(revId, jeId);
      db.prepare(`
        UPDATE production_labor_entries SET reversed_je_id=?, status='reversed' WHERE je_id=?
      `).run(revId, jeId);
      db.prepare(`
        UPDATE production_material_issues SET reversed_je_id=?, status='reversed'
        WHERE je_id=? AND COALESCE(issue_type,'')<>'cutting_lay'
      `).run(revId, jeId);
      db.prepare(`
        UPDATE production_subcontract SET status='reversed' WHERE je_id=?
      `).run(jeId);
    }

    for (const i of issues) {
      // cutting_lay در حال ابطال: موجودی و JE مال لایه‌چینی است — فقط برچسب؛ voidCuttingLay موجودی را برمی‌گرداند
      if (String(i.issue_type || '') === 'cutting_lay') {
        db.prepare(`UPDATE production_material_issues SET status='reversed' WHERE id=?`).run(i.id);
        continue;
      }
      reverseIssueStock(db, {
        productId: i.product_id,
        warehouseId: i.warehouse_id || po.warehouse_raw_id,
        qty: i.qty_actual,
        unitCostRial: i.unit_cost_rial,
        userId,
        note: `ابطال مرحله ${stage.seq} — ${po.order_no}`,
        orderId,
        orderNo: po.order_no,
        stageSeq: stage.seq,
        sourceId: i.id,
        date: revDate,
      });
      require('../inventory/apparel-lines').reverseApparelDoc(db, {
        docType: 'production_issue', docId: i.id, userId,
        note: `ابطال مرحله ${stage.seq} — ${po.order_no}`,
      });
      db.prepare(`UPDATE production_material_issues SET status='reversed' WHERE id=?`).run(i.id);
    }

    for (const w of wastes) {
      db.prepare(`UPDATE production_waste SET status='reversed' WHERE id=?`).run(w.id);
    }
    if (wastes.some(w => w.waste_type === 'salable')) {
      require('../inventory/apparel-lines').reverseApparelDoc(db, {
        docType: 'production_scrap', docId: orderId, userId,
        note: `ابطال مرحله ${stage.seq} — ضایعات ${po.order_no}`,
      });
    }
    for (const s of subs) {
      db.prepare(`UPDATE production_subcontract SET status='reversed' WHERE id=?`).run(s.id);
    }
    reverseAppliedOverheadCounters(db, ohs.filter(o => o.status === 'posted'));
    for (const o of ohs) {
      if (o.status === 'posted') {
        db.prepare(`UPDATE production_overhead_applications SET status='reversed' WHERE id=?`).run(o.id);
      }
    }
    for (const l of labs) {
      if (l.status === 'posted') {
        db.prepare(`UPDATE production_labor_entries SET status='reversed' WHERE id=?`).run(l.id);
      }
    }
    retirePersonLaborForEntries(db, labs);

    const issuedAfter = sumStageIssued(db, stageId);
    const matAdded = Math.round(num(stage.material_added_rial));
    const matRial = issuedBefore.total ? issuedBefore.matRial - issuedAfter.matRial : matAdded;
    const pkgRial = issuedBefore.total ? issuedBefore.pkgRial - issuedAfter.pkgRial : 0;

    resetDownstreamStages(db, orderId, stage.seq);

    db.prepare(`
      UPDATE production_order_stages SET
        qty_out=0, qty_waste_normal=0, qty_waste_abnormal=0, qty_rework=0,
        material_added_rial=?, labor_rial=0, overhead_rial=0, subcontract_rial=0,
        waste_abnormal_rial=0, scrap_credit_rial=0, cost_out_rial=0, unit_cost_out_rial=0,
        driver_qty=0, status='in_progress', ended_at=NULL
      WHERE id=?
    `).run(issuedAfter.total, stageId);

    db.prepare(`
      UPDATE production_orders SET
        material_cost_rial = material_cost_rial - ?,
        packaging_cost_rial = packaging_cost_rial - ?,
        labor_cost_rial = labor_cost_rial - ?,
        overhead_cost_rial = overhead_cost_rial - ?,
        subcontract_cost_rial = subcontract_cost_rial - ?,
        abnormal_waste_rial = abnormal_waste_rial - ?,
        scrap_credit_rial = scrap_credit_rial - ?,
        qty_waste_normal = qty_waste_normal - ?,
        qty_waste_abnormal = qty_waste_abnormal - ?,
        status = CASE WHEN status='completed' THEN 'in_progress' ELSE status END,
        updated_at = strftime('%s','now')
      WHERE id=?
    `).run(
      matRial,
      pkgRial,
      Math.round(num(stage.labor_rial)),
      Math.round(num(stage.overhead_rial)),
      Math.round(num(stage.subcontract_rial)),
      Math.round(num(stage.waste_abnormal_rial)),
      Math.round(num(stage.scrap_credit_rial)),
      num(stage.qty_waste_normal),
      num(stage.qty_waste_abnormal),
      orderId
    );

    audit(userId, 'update', 'production_order_stage', stageId,
      `ابطال مرحله ${stage.seq} — ${po.order_no}: ${reason || ''}`);
    emit(db, 'production.stage.reversed', { orderId, stageId, reason });
    applyDocumentCosts(db, orderId);

    const refreshed = getStage(db, orderId, stageId);
    return {
      ok: true,
      stage_id: stageId,
      seq: stage.seq,
      status: refreshed.status,
      reversed_je_ids: reversedJeIds,
      wip_residual_rial: wipResidual(db, orderId),
    };
  })();
}

function issueStageMaterials(db, { orderId, stageId, body, userId }) {
  return db.transaction(() => {
    const po = getOrder(db, orderId);
    if (po.analysis_type !== 'variable_adv') throw err('E_WRONG_ANALYSIS', 409);
    if (po.status === 'draft') throw err('E_NOT_RELEASED', 409);
    require('./product-completeness').assertOrderReady(db, orderId, 'issue');

    const stage = getStage(db, orderId, stageId);
    if (stage.status !== 'in_progress') {
      throw err('E_INVALID_STATUS', 409, {
        status: stage.status,
        detail: 'حواله مواد فقط برای مرحلهٔ در جریان مجاز است',
      });
    }
    const prev = prevStage(db, orderId, stage.seq);
    if (prev && !['done', 'skipped'].includes(prev.status)) {
      throw err('E_PREV_STAGE_OPEN', 409, { prev_seq: prev.seq, prev_status: prev.status });
    }

    const date = String(body.date || po.date || todayJalali()).trim();
    const period = jalaliPeriod(date);
    assertPeriodOpen(db, period);
    const materialsRaw = body.materials || body.lines || [];
    if (!materialsRaw.length) throw err('E_QTY_INVALID', 422);
    const { expandShortageAlternates, resolveIssueStd } = require('./engine');
    const materials = expandShortageAlternates(db, materialsRaw, po.warehouse_raw_id);
    if (!materials.length) throw err('E_QTY_INVALID', 422);

    const stdLines = stageMaterialLines(db, po, stage);
    const std = {};
    for (const L of stdLines) {
      std[L.product_id] = { qty: L.qty_final, price: L.unit_cost_rial, bom_line_id: L.bom_line_id };
    }

    let matRial = 0, pkgRial = 0, varP = 0, varQ = 0;
    const out = [];
    let issueNo = '';
    try { issueNo = allocateNumber(db, 'material_issue', 'MI'); }
    catch { issueNo = `MI-${Date.now()}`; }

    for (const L of materials) {
      const AQ = num(L.qty_actual != null ? L.qty_actual : L.qty);
      const prod = db.prepare('SELECT * FROM products WHERE id=?').get(L.product_id);
      if (!prod) throw err('E_NOT_FOUND', 404);
      if (lengthFabricProduct(db, L.product_id) && AQ > 0) {
        throw err('E_FABRIC_VIA_CUT', 409, {
          product_id: prod.id,
          name: prod.name,
          unit: prod.unit,
          message: `«${prod.name}» پارچهٔ طاقه‌ای است (${rollFabricUnitLabel(db, prod)}). حوالهٔ مرحله آن را مصرف نمی‌کند. از ثبت خروجی مرحلهٔ برش، لایه‌چینی همین سفارش را ثبت کنید.`,
        });
      }
      const resolved = resolveIssueStd(std, L, materials);
      const s = resolved.s;
      if (!s && AQ > 0) {
        throw err('E_STAGE_MATERIAL_OWNER', 409, {
          product_id: L.product_id,
          name: prod.name,
          detail: 'این قلم به این مرحله از مسیر BOM تعلق ندارد',
        });
      }
      const SQ = resolved.SQ;
      const SP = resolved.SP || Math.round(num(prod.average_cost_rial));
      const AP = Math.round(num(prod.average_cost_rial));
      if (AQ > 0 && !AP) throw err('E_ZERO_AVG_COST', 422, { name: prod.name, product_id: prod.id });

      const varQty = round6(AQ - SQ);
      const varPRial = Math.round((AP - SP) * AQ);
      const varQRial = Math.round(varQty * SP);
      const amount = Math.round(AQ * AP);

      let issued = null;
      if (AQ > 0) {
        assertFabricIssueAllowed(db, {
          productId: L.product_id,
          qty: AQ,
          batchId: L.batch_id || null,
          orderId: po.id,
        });
        issued = issueFromStock(db, {
          productId: L.product_id, warehouseId: po.warehouse_raw_id, qty: AQ, userId,
          note: `حواله مرحله ${stage.seq}`,
          variantId: L.variant_id, variantLines: L.variant_lines,
          sourceType: 'production_issue', sourceId: po.id, date,
        });
      }

      const stageIssue = db.prepare(`
        INSERT INTO production_material_issues
          (doc_no, order_id, stage_id, cost_center_id, product_id, bom_line_id, issue_type,
           qty_standard, qty_actual, qty_variance, unit_cost_rial, std_cost_rial,
           amount_rial, std_amount_rial, var_price_rial, var_qty_rial,
           warehouse_id, substitute_of_product_id, date, period_label, status, variance_status, note, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'posted','memo',?,?)
      `).run(
        issueNo, orderId, stageId, stage.cost_center_id, L.product_id, s?.bom_line_id || null,
        L.substitute_of_product_id ? 'substitute' : 'issue', SQ, AQ, varQty, AP, SP, amount, Math.round(SQ * SP),
        varPRial, varQRial, po.warehouse_raw_id, L.substitute_of_product_id || null,
        date, period, L.reason || '', userId
      );
      if (issued && issued.variantLines && issued.variantLines.length) {
        require('../inventory/apparel-lines').postApparelLines(db, {
          productId: L.product_id, warehouseId: po.warehouse_raw_id,
          lines: issued.variantLines, docType: 'production_issue',
          docId: stageIssue.lastInsertRowid, userId,
          note: `حواله مرحله ${stage.seq}`, sign: -1, allowNegative: false,
        });
      }

      const kind = prod.item_type === 'packaging' ? 'packaging' : 'material';
      if (kind === 'packaging') pkgRial += amount;
      else matRial += amount;
      varP += varPRial;
      varQ += varQRial;

      if (varPRial || varQRial) {
        try {
          db.prepare(`
            INSERT INTO production_variances
              (period_label, order_id, stage_id, product_id, variance_type, amount_rial, status)
            VALUES (?,?,?,?,?,?, 'memo')
          `).run(period, orderId, stageId, L.product_id, 'material_price', varPRial);
          db.prepare(`
            INSERT INTO production_variances
              (period_label, order_id, stage_id, product_id, variance_type, amount_rial, status)
            VALUES (?,?,?,?,?,?, 'memo')
          `).run(period, orderId, stageId, L.product_id, 'material_qty', varQRial);
        } catch { /* optional */ }
      }

      out.push({
        product_id: L.product_id, qty_actual: AQ, amount_rial: amount,
        var_price_rial: varPRial, var_qty_rial: varQRial,
      });
    }

    const totalRial = matRial + pkgRial;
    const je = postEvent(db, {
      event: 'PRD-01',
      sourceId: orderId,
      date,
      description: `مصرف مواد مرحله ${stage.seq} — ${po.order_no}`,
      createdBy: userId,
      lines: plug([
        dr(db, 'coa_wip', totalRial, po.coa_wip_tafsili),
        cr(db, 'coa_raw_materials', matRial),
        cr(db, 'coa_packaging_materials', pkgRial),
      ]),
    });
    if (je) {
      db.prepare(`
        UPDATE production_material_issues SET je_id=?
        WHERE doc_no=? AND order_id=? AND stage_id=?
      `).run(je.je_id, issueNo, orderId, stageId);
    }

    db.prepare(`
      UPDATE production_orders SET
        material_cost_rial = material_cost_rial + ?,
        packaging_cost_rial = packaging_cost_rial + ?,
        status = CASE WHEN status='released' THEN 'in_progress' ELSE status END
      WHERE id=?
    `).run(matRial, pkgRial, orderId);

    db.prepare(`
      UPDATE production_order_stages SET
        material_added_rial = COALESCE(material_added_rial,0) + ?
      WHERE id=?
    `).run(totalRial, stageId);

    if (totalRial > 0 && !je) {
      throw err('E_JE_REQUIRED', 500, {
        detail: 'حواله مواد بدون سند حسابداری ثبت نشد — تراکنش برگشت خورد',
      });
    }

    applyDocumentCosts(db, orderId);

    return {
      ok: true,
      issue_no: issueNo,
      lines: out,
      totals: { material_rial: matRial, packaging_rial: pkgRial, total_rial: totalRial,
        var_price_rial: varP, var_qty_rial: varQ },
      journal_entry: je,
    };
  })();
}

/**
 * v513 — مصرف اضافهٔ مرحله (هر دو آنالیز مرحله‌ای): وقتی در عمل بیش از استاندارد فرمول مصرف شد
 * (زیپ خراب، دوخت مجدد، خرابی دستگاه، …).
 * normal تا سقف درصد ضایعات عادی عملیات روی استاندارد همان قلم → WIP (بهای محصول).
 * مازاد سقف یا دلیل غیرعادی → PRD-24 بدهکار ۵۲۲۱ / بستانکار مواد، بیرون از WIP.
 */
const EXTRA_REASONS = {
  material_defect: { label: 'قلم معیوب (مثلاً زیپ خراب)', cls: 'abnormal' },
  operator_error: { label: 'خطای اپراتور / دوخت اشتباه', cls: 'abnormal' },
  machine: { label: 'خرابی دستگاه', cls: 'abnormal' },
  rework: { label: 'دوباره‌کاری قطعه', cls: 'abnormal' },
  lost: { label: 'گم‌شدن / کسری در سالن', cls: 'abnormal' },
  bom_understated: { label: 'مصرف واقعی بیش از فرمول (فرمول باید اصلاح شود)', cls: 'normal' },
  qc_sample: { label: 'نمونه / تست کنترل کیفیت', cls: 'normal' },
  spec_change: { label: 'تغییر مشخصات سفارش', cls: 'normal' },
  other: { label: 'سایر', cls: 'abnormal' },
};

function stageExtraNormalPct(db, op) {
  const opPct = num(op && op.normal_waste_percent);
  if (opPct > 0) return opPct;
  return num(setting(db, 'production_material_extra_normal_pct', '')) || 0;
}

function issueStageExtraMaterials(db, { orderId, stageId, body, userId }) {
  return db.transaction(() => {
    const po = getOrder(db, orderId);
    if (!['fixed_adv', 'variable_adv'].includes(po.analysis_type)) throw err('E_WRONG_ANALYSIS', 409);
    if (po.status === 'draft') throw err('E_NOT_RELEASED', 409);
    if (['closed', 'cancelled', 'completed'].includes(po.status)) throw err('E_ORDER_CLOSED', 409);
    const stage = getStage(db, orderId, stageId);
    if (stage.status !== 'in_progress') {
      throw err('E_INVALID_STATUS', 409, {
        status: stage.status,
        detail: 'مصرف اضافه فقط برای مرحلهٔ در جریان ثبت می‌شود. اگر مرحله تمام شده، اول ابطالش کنید.',
      });
    }
    const date = String(body.date || todayJalali()).trim();
    const period = jalaliPeriod(date);
    const fy = assertFiscalYearWritable(db, date);
    if (!fy.ok) throw err('E_PERIOD_CLOSED', 409, { detail: fy.error });
    assertPeriodOpen(db, period);

    const raw = Array.isArray(body.lines) ? body.lines : (Array.isArray(body.materials) ? body.materials : []);
    const lines = raw.filter((L) => num(L && (L.qty != null ? L.qty : L.qty_actual)) > 0);
    if (!lines.length) throw err('E_QTY_INVALID', 422, { detail: 'حداقل یک قلم با مقدار اضافه لازم است' });

    const std = new Map();
    for (const L of stageMaterialLines(db, po, stage)) {
      const cur = std.get(Number(L.product_id)) || { qty: 0, price: 0, bom_line_id: null };
      cur.qty = round6(cur.qty + num(L.qty_final));
      cur.price = Math.round(num(L.unit_cost_rial)) || cur.price;
      cur.bom_line_id = cur.bom_line_id || L.bom_line_id || null;
      std.set(Number(L.product_id), cur);
    }
    const op = getOperation(db, stage, po.bom_id);
    const pct = stageExtraNormalPct(db, op);
    const whId = po.warehouse_raw_id;
    let docNo = '';
    try { docNo = allocateNumber(db, 'material_issue', 'MI'); }
    catch { docNo = `MI-${Date.now()}`; }

    const out = [];
    const totals = { normal_rial: 0, abnormal_rial: 0 };
    const insert = db.prepare(`
      INSERT INTO production_material_issues
        (doc_no, order_id, stage_id, cost_center_id, product_id, bom_line_id, issue_type,
         qty_standard, qty_actual, qty_variance, unit_cost_rial, std_cost_rial,
         amount_rial, std_amount_rial, var_price_rial, var_qty_rial,
         warehouse_id, date, period_label, status, variance_status, note, created_by,
         extra_class, reason_code)
      VALUES (?,?,?,?,?,?,'extra',0,?,?,?,?,?,0,?,?,?,?,?,'posted','memo',?,?,?,?)
    `);

    for (const L of lines) {
      const pid = Number(L.product_id);
      const qty = round6(num(L.qty != null ? L.qty : L.qty_actual));
      const prod = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
      if (!prod) throw err('E_NOT_FOUND', 404, { product_id: pid });
      if (lengthFabricProduct(db, pid)) {
        throw err('E_FABRIC_VIA_CUT', 409, {
          product_id: pid,
          name: prod.name,
          message: `«${prod.name}» پارچهٔ طاقه‌ای است؛ مصرف اضافهٔ پارچه با لایه‌چینی (متر واقعی) ثبت می‌شود.`,
        });
      }
      const s = std.get(pid);
      if (!s) {
        throw err('E_STAGE_MATERIAL_OWNER', 409, {
          product_id: pid, name: prod.name, detail: 'این قلم در فرمول این مرحله نیست',
        });
      }
      const reasonCode = String(L.reason_code || L.reason || '').trim();
      const reason = EXTRA_REASONS[reasonCode];
      if (!reason) throw err('E_EXTRA_REASON', 422, { detail: 'دلیل مصرف اضافه را انتخاب کنید', product_id: pid });
      const note = String(L.note || '').trim();
      if (reasonCode === 'other' && !note) {
        throw err('E_EXTRA_REASON', 422, { detail: 'برای دلیل «سایر» توضیح لازم است', product_id: pid });
      }
      const wantCls = ['normal', 'abnormal'].includes(String(L.extra_class || ''))
        ? String(L.extra_class) : reason.cls;
      const AP = Math.round(num(prod.average_cost_rial));
      if (!AP) throw err('E_ZERO_AVG_COST', 422, { name: prod.name, product_id: pid });
      const SP = Math.round(num(s.price)) || AP;

      let normalQty = 0;
      if (wantCls === 'normal') {
        const used = db.prepare(`
          SELECT COALESCE(SUM(qty_actual),0) q FROM production_material_issues
          WHERE stage_id=? AND product_id=? AND status='posted'
            AND issue_type='extra' AND COALESCE(extra_class,'')='normal'
        `).get(stageId, pid);
        const cap = round6(Math.max(0, s.qty * pct / 100 - num(used?.q)));
        normalQty = round6(Math.min(qty, cap));
      }
      const parts = [
        { cls: 'normal', qty: normalQty },
        { cls: 'abnormal', qty: round6(qty - normalQty) },
      ].filter((p) => p.qty > 0);

      for (const part of parts) {
        assertFabricIssueAllowed(db, { productId: pid, qty: part.qty, orderId: po.id });
        const issued = issueFromStock(db, {
          productId: pid, warehouseId: whId, qty: part.qty, userId,
          note: `مصرف اضافه مرحله ${stage.seq} — ${po.order_no}`,
          variantId: L.variant_id, sourceType: 'production_issue', sourceId: po.id, date,
        });
        const amount = Math.round(part.qty * AP);
        const autoNote = wantCls === 'normal' && part.cls === 'abnormal'
          ? ` (مازاد سقف ${pct}٪ استاندارد)` : '';
        const row = insert.run(
          docNo, orderId, stageId, stage.cost_center_id, pid, s.bom_line_id,
          part.qty, part.qty, AP, SP, amount,
          Math.round((AP - SP) * part.qty), Math.round(part.qty * SP),
          whId, date, period, `${reason.label}${note ? ' — ' + note : ''}${autoNote}`, userId,
          part.cls, reasonCode
        );
        const issueId = row.lastInsertRowid;
        if (issued && issued.variantLines && issued.variantLines.length) {
          require('../inventory/apparel-lines').postApparelLines(db, {
            productId: pid, warehouseId: whId, lines: issued.variantLines,
            docType: 'production_issue', docId: issueId, userId,
            note: `مصرف اضافه مرحله ${stage.seq}`, sign: -1, allowNegative: false,
          });
        }
        const creditKey = prod.item_type === 'packaging' ? 'coa_packaging_materials' : 'coa_raw_materials';
        const desc = `مصرف اضافهٔ ${part.cls === 'normal' ? 'عادی' : 'غیرعادی'} مرحله ${stage.seq} — ${prod.name} — ${po.order_no}`;
        const je = part.cls === 'normal'
          ? postEvent(db, {
            event: 'PRD-01', sourceId: orderId, date, description: desc, createdBy: userId,
            costCenterId: stage.cost_center_id || po.cost_center_id || null,
            lines: [dr(db, 'coa_wip', amount, po.coa_wip_tafsili), cr(db, creditKey, amount)],
          })
          : postEvent(db, {
            event: 'PRD-24', sourceId: issueId, date, description: desc, createdBy: userId,
            costCenterId: stage.cost_center_id || po.cost_center_id || null,
            lines: [dr(db, 'coa_abnormal_waste', amount), cr(db, creditKey, amount)],
          });
        if (amount > 0 && !je) throw err('E_JE_REQUIRED', 500, { detail: 'سند مصرف اضافه ثبت نشد' });
        if (je) db.prepare('UPDATE production_material_issues SET je_id=? WHERE id=?').run(je.je_id, issueId);
        try {
          db.prepare(`
            INSERT INTO production_variances
              (period_label, order_id, stage_id, product_id, variance_type, amount_rial, status)
            VALUES (?,?,?,?,'material_qty',?, 'memo')
          `).run(period, orderId, stageId, pid, Math.round(part.qty * SP));
        } catch { /* optional */ }
        if (part.cls === 'normal') {
          totals.normal_rial += amount;
          db.prepare(`
            UPDATE production_order_stages SET material_added_rial = COALESCE(material_added_rial,0) + ?
            WHERE id=?
          `).run(amount, stageId);
        } else {
          totals.abnormal_rial += amount;
        }
        out.push({
          id: issueId, product_id: pid, name: prod.name, qty: part.qty, extra_class: part.cls,
          reason_code: reasonCode, amount_rial: amount, je_id: je ? je.je_id : null,
        });
      }
    }

    audit(userId, 'create', 'production_material_extra', orderId,
      `مصرف اضافه ${docNo} مرحله ${stage.seq} — ${po.order_no}`);
    applyDocumentCosts(db, orderId);
    return { ok: true, doc_no: docNo, normal_pct: pct, lines: out, totals };
  })();
}

function voidStageExtraIssue(db, { orderId, stageId, issueId, reason, userId, date }) {
  return db.transaction(() => {
    const po = getOrder(db, orderId);
    if (['closed', 'cancelled', 'completed'].includes(po.status)) throw err('E_ORDER_CLOSED', 409);
    const stage = getStage(db, orderId, stageId);
    if (stage.status !== 'in_progress') {
      throw err('E_INVALID_STATUS', 409, {
        status: stage.status,
        detail: 'مرحله تمام شده؛ «ابطال مرحله» همهٔ مصرف‌های اضافهٔ آن را هم برمی‌گرداند.',
      });
    }
    const row = db.prepare(`
      SELECT * FROM production_material_issues
      WHERE id=? AND order_id=? AND stage_id=? AND issue_type='extra'
    `).get(Number(issueId), orderId, stageId);
    if (!row) throw err('E_NOT_FOUND', 404);
    if (row.status !== 'posted') throw err('E_ALREADY_REVERSED', 409);
    const revDate = date || todayJalali();
    const fy = assertFiscalYearWritable(db, revDate);
    if (!fy.ok) throw err('E_PERIOD_CLOSED', 409, { detail: fy.error });
    let revId = null;
    if (row.je_id) {
      revId = reverseEvent(db, {
        jeId: row.je_id, reason: reason || 'ابطال مصرف اضافه', userId, date: revDate,
      });
    }
    reverseIssueStock(db, {
      productId: row.product_id,
      warehouseId: row.warehouse_id || po.warehouse_raw_id,
      qty: row.qty_actual,
      unitCostRial: row.unit_cost_rial,
      userId,
      note: `ابطال مصرف اضافه مرحله ${stage.seq} — ${po.order_no}`,
      orderId,
      orderNo: po.order_no,
      stageSeq: stage.seq,
      sourceId: row.id,
      date: revDate,
    });
    require('../inventory/apparel-lines').reverseApparelDoc(db, {
      docType: 'production_issue', docId: row.id, userId,
      note: `ابطال مصرف اضافه مرحله ${stage.seq} — ${po.order_no}`,
    });
    db.prepare(`UPDATE production_material_issues SET status='reversed', reversed_je_id=? WHERE id=?`)
      .run(revId, row.id);
    if (String(row.extra_class) === 'normal') {
      db.prepare(`
        UPDATE production_order_stages SET material_added_rial = MAX(0, COALESCE(material_added_rial,0) - ?)
        WHERE id=?
      `).run(Math.round(num(row.amount_rial)), stageId);
    }
    audit(userId, 'update', 'production_material_extra', row.id,
      `ابطال مصرف اضافه ${row.doc_no} — ${po.order_no}: ${reason || ''}`);
    applyDocumentCosts(db, orderId);
    return { ok: true, id: row.id, status: 'reversed', reversed_je_id: revId };
  })();
}

function listStageExtraIssues(db, orderId, stageId) {
  const rows = db.prepare(`
    SELECT mi.id, mi.doc_no, mi.product_id, p.name AS product_name, p.unit, mi.qty_actual AS qty,
           mi.extra_class, mi.reason_code, mi.note, mi.amount_rial, mi.status, mi.date
    FROM production_material_issues mi
    LEFT JOIN products p ON p.id = mi.product_id
    WHERE mi.order_id=? AND mi.stage_id=? AND mi.issue_type='extra'
    ORDER BY mi.id DESC
  `).all(orderId, stageId);
  return {
    rows,
    reasons: Object.entries(EXTRA_REASONS).map(([code, r]) => ({ code, label: r.label, default_class: r.cls })),
  };
}

function getStageIssueTemplate(db, orderId, stageId) {
  const po = getOrder(db, orderId);
  const stage = getStage(db, orderId, stageId);
  const issuedQtyOf = (pid) => num(db.prepare(`
    SELECT COALESCE(SUM(qty_actual),0) q FROM production_material_issues
    WHERE order_id=? AND stage_id=? AND status='posted'
      AND COALESCE(issue_type,'') NOT IN ('extra','cutting_lay')
      AND (product_id=? OR substitute_of_product_id=?)
  `).get(orderId, stageId, pid, pid)?.q);
  const lines = stageMaterialLines(db, po, stage).map(L => {
    const prod = db.prepare('SELECT id, name, average_cost_rial, std_cost_rial FROM products WHERE id=?').get(L.product_id);
    const avg = Math.round(Number(prod?.average_cost_rial) || 0);
    const whId = po.warehouse_raw_id;
    let stockAvail = 0;
    try {
      stockAvail = whId
        ? Number(getWhQty(db, L.product_id, whId)) || 0
        : Number(db.prepare('SELECT stock FROM products WHERE id=?').get(L.product_id)?.stock) || 0;
    } catch (_) { stockAvail = 0; }
    const needQty = Number(L.qty_final) || 0;
    const viaLay = lengthFabricProduct(db, L.product_id) ? 1 : 0;
    return {
      product_id: L.product_id,
      name: prod?.name || ('#' + L.product_id),
      unit: prod?.unit || '',
      qty_standard: L.qty_final,
      qty_actual: L.qty_final,
      stock_available: stockAvail,
      stock_short: viaLay ? 0 : (needQty > 0 && stockAvail + 1e-9 < needQty ? 1 : 0),
      via_cutting_lay: viaLay,
      issued_qty: viaLay ? 0 : issuedQtyOf(L.product_id),
      std_cost_rial: Math.round(Number(L.unit_cost_rial) || Number(prod?.std_cost_rial) || 0),
      average_cost_rial: avg,
      // R11-safe gate (not stripped): operators without cost view still see zero-avg block
      avg_cost_ok: avg > 0 ? 1 : 0,
      bom_line_id: L.bom_line_id || null,
      product_scope: L.product_scope || 'shared',
      scoped_product_id: L.scoped_product_id || null,
      scoped_product_name: (String(L.product_scope || '') === 'exclusive' && L.scoped_product_id)
        ? (db.prepare('SELECT name FROM products WHERE id=?').get(L.scoped_product_id)?.name || '')
        : '',
    };
  });
  const cut = resolveCuttingStage(db, orderId);
  const isCut = !!(cut && Number(cut.id) === Number(stage.id));
  let cut_lay = null;
  if (isCut && lines.some((L) => L.via_cutting_lay)) {
    const cov = cuttingStageCoverage(db, po, stage);
    cut_lay = {
      required: 1,
      lay_qty: cov.lay_qty,
      need: cov.need,
      covered: cov.covered ? 1 : 0,
      message: cov.message,
      fabrics: cov.fabrics,
      missing_fabrics: cov.missing_fabrics,
      order_id: po.id,
    };
  }
  return {
    order_id: orderId,
    stage_id: stageId,
    analysis_type: po.analysis_type,
    unissued: po.analysis_type === 'variable_adv' ? stageUnissuedMaterialLines(db, po, stage) : [],
    warehouse_raw_id: po.warehouse_raw_id || null,
    qty_in: stage.qty_in,
    cut_lay,
    operation_name: stage.operation_name || '',
    lines,
    empty_hint: lines.length ? '' : stageMaterialEmptyHint(db, po, stage),
    // v527: اقلام فرمول(ها) که به هیچ عملیاتی وصل نیستند — روی هیچ مرحله‌ای حواله نمی‌شوند
    bom_gaps: orderMaterialGaps(db, po),
  };
}

/**
 * مرحلهٔ برش در مسیر سفارش پیشرفته: CC-10 / نام «برش» / اولین مرحلهٔ مالک پارچه / اولین seq.
 */
function resolveCuttingStage(db, orderId) {
  const stages = stageList(db, orderId);
  if (!stages.length) return null;
  for (const s of stages) {
    const cc = db.prepare('SELECT code, name FROM cost_centers WHERE id=?').get(s.cost_center_id);
    const opName = String(s.operation_name || '');
    if (
      (cc && (String(cc.code) === 'CC-10' || /برش/.test(String(cc.name || ''))))
      || /برش/.test(opName)
    ) {
      return s;
    }
  }
  const po = getOrder(db, orderId);
  for (const s of stages) {
    const lines = stageMaterialLines(db, po, s);
    for (const L of lines) {
      const fab = db.prepare(`
        SELECT 1 FROM inventory_batches
        WHERE product_id=? AND COALESCE(kind,'generic')='fabric' AND COALESCE(status,'active') <> 'reversed'
        LIMIT 1
      `).get(L.product_id);
      const prod = db.prepare('SELECT item_type FROM products WHERE id=?').get(L.product_id);
      if (fab || ['fabric', 'raw_material', 'raw'].includes(String(prod?.item_type || ''))) {
        return s;
      }
    }
  }
  return stages[0];
}

/** هم‌ارز layIssueNoteMatchers در cutting.js — LAY-10 نباید LAY-100 را بگیرد. */
function layNoteGlobs(layNo, layId) {
  const tag = layNo || ('#' + layId);
  return [`*${tag}[^0-9]*`, `*${tag}`];
}

/**
 * اتصال لایه‌چینی به مرحلهٔ برش: حوالهٔ منطقی (بدون JE دوباره) + تکمیل مرحله + دست‌به‌دست بعدی.
 * Caller باید داخل تراکنش باشد. JE پارچه فقط از cutting_lay است.
 */
function applyCuttingLayToStage(db, {
  orderId, layId, layNo, fabricProductId, amountRial, wasteAmountRial, qtyPieces, meters, date, userId,
}) {
  const po = getOrder(db, orderId);
  if (!['fixed_adv', 'variable_adv'].includes(po.analysis_type)) {
    return { ok: false, skipped: true, reason: 'not_advanced' };
  }
  let stage = resolveCuttingStage(db, orderId);
  if (!stage) return { ok: false, skipped: true, reason: 'no_stages' };

  const prev = prevStage(db, orderId, stage.seq);
  if (prev && !['done', 'skipped'].includes(prev.status)) {
    throw err('E_PREV_STAGE_OPEN', 409, { prev_seq: prev.seq, prev_status: prev.status });
  }

  const amount = Math.round(num(amountRial));
  const wasteAmt = Math.max(0, Math.round(num(wasteAmountRial)));
  const qty = round6(num(qtyPieces));
  const m = round6(num(meters));
  const when = date || todayJalali();
  const period = jalaliPeriod(when);

  const healOrderCost = () => applyDocumentCosts(db, orderId);

  const [layGlobMid, layGlobEnd] = layNoteGlobs(layNo, layId);
  const already = db.prepare(`
    SELECT id FROM production_material_issues
    WHERE stage_id=? AND order_id=? AND issue_type='cutting_lay'
      AND (note GLOB ? OR note GLOB ?) AND status='posted'
    LIMIT 1
  `).get(stage.id, orderId, layGlobMid, layGlobEnd);
  if (already) {
    db.prepare('UPDATE cutting_lays SET stage_id=? WHERE id=?').run(stage.id, layId);
    healOrderCost();
    return { ok: true, stage_id: stage.id, idempotent: true };
  }

  let docNo = String(layNo || '');
  if (!docNo) {
    try { docNo = allocateNumber(db, 'material_issue', 'MI'); }
    catch { docNo = `MI-LAY-${layId}`; }
  }

  db.prepare(`
    INSERT INTO production_material_issues
      (doc_no, order_id, stage_id, cost_center_id, product_id, bom_line_id, issue_type,
       qty_standard, qty_actual, qty_variance, unit_cost_rial, std_cost_rial,
       amount_rial, std_amount_rial, var_price_rial, var_qty_rial,
       warehouse_id, date, period_label, status, variance_status, note, created_by, je_id)
    VALUES (?,?,?,?,?,?, 'cutting_lay', ?,?,?,?,?,?,?,0,0,?,?,?,'posted','memo',?, ?, NULL)
  `).run(
    docNo, orderId, stage.id, stage.cost_center_id, fabricProductId || po.product_id, null,
    m, m, 0,
    m > 0 ? Math.round(amount / m) : 0,
    m > 0 ? Math.round(amount / m) : 0,
    amount, amount,
    po.warehouse_raw_id, when, period,
    `لایه‌چینی ${layNo || ('#' + layId)} — مصرف پارچه مرحله برش`,
    userId
  );

  if (amount > 0 || wasteAmt > 0) {
    db.prepare(`
      UPDATE production_orders SET
        material_cost_rial = material_cost_rial + ?,
        abnormal_waste_rial = COALESCE(abnormal_waste_rial,0) + ?,
        status = CASE WHEN status='released' THEN 'in_progress' ELSE status END,
        updated_at = strftime('%s','now')
      WHERE id=?
    `).run(amount, wasteAmt, orderId);
  }

  db.prepare('UPDATE cutting_lays SET stage_id=? WHERE id=?').run(stage.id, layId);

  const cov = cuttingStageCoverage(db, po, stage);
  if (stage.status === 'done' && !cov.covered && cuttingDownstreamUntouched(db, orderId, stage.seq)) {
    reopenUndercutCuttingStage(db, po, stage, userId, when);
    stage = getStage(db, orderId, stage.id);
  }

  // amount = کل پارچهٔ واردشده به WIP؛ waste با PRD-09 از WIP خارج شده (کلاسیک و برش مشترک).
  const netToWip = Math.max(0, amount - wasteAmt);
  if (stage.status === 'done') {
    db.prepare(`
      UPDATE production_order_stages SET
        material_added_rial = COALESCE(material_added_rial,0) + ?,
        waste_abnormal_rial = COALESCE(waste_abnormal_rial,0) + ?,
        cost_out_rial = COALESCE(cost_out_rial,0) + ?
      WHERE id=?
    `).run(amount, wasteAmt, netToWip, stage.id);
    const nxt = nextStage(db, orderId, stage.seq);
    if (nxt && netToWip) {
      db.prepare(`
        UPDATE production_order_stages SET
          material_in_rial = COALESCE(material_in_rial,0) + ?
        WHERE id=?
      `).run(netToWip, nxt.id);
    }
    healOrderCost();
    return {
      ok: true, stage_id: stage.id, status: 'done', accumulated: true, completed: true,
      lay_qty: cov.lay_qty, need: cov.need, message: cov.message,
    };
  }

  if (stage.status === 'pending') {
    db.prepare(`
      UPDATE production_order_stages SET status='in_progress', started_at=? WHERE id=?
    `).run(when, stage.id);
    stage = getStage(db, orderId, stage.id);
  }

  if (!cov.covered || qty <= 0) {
    db.prepare(`
      UPDATE production_order_stages SET
        material_added_rial = COALESCE(material_added_rial,0) + ?
      WHERE id=?
    `).run(amount, stage.id);
    healOrderCost();
    return {
      ok: true,
      stage_id: stage.id,
      status: 'in_progress',
      completed: false,
      lay_qty: cov.lay_qty,
      need: cov.need,
      message: cov.message,
    };
  }

  const unissued = po.analysis_type === 'variable_adv' ? stageUnissuedMaterialLines(db, po, stage) : [];
  if (unissued.length) {
    db.prepare(`
      UPDATE production_order_stages SET
        material_added_rial = COALESCE(material_added_rial,0) + ?
      WHERE id=?
    `).run(amount, stage.id);
    healOrderCost();
    return {
      ok: true,
      stage_id: stage.id,
      status: 'in_progress',
      completed: false,
      lay_qty: cov.lay_qty,
      need: cov.need,
      unissued,
      message: 'برش کامل است ولی اقلام دیگر این مرحله حواله نشده: '
        + unissued.map(m => `«${m.name}»`).join('، ')
        + ' — بعد از «حواله مواد»، «ثبت خروجی» مرحله را بزنید.',
    };
  }

  const planned = num(stage.qty_planned_in) > 0 ? num(stage.qty_planned_in) : cov.need;
  if (planned > 0 && Math.abs(num(stage.qty_in) - planned) > 0.01) {
    db.prepare('UPDATE production_order_stages SET qty_in=? WHERE id=?').run(planned, stage.id);
  }

  // تکمیل با مسیر variable تا مواد دوباره backflush نشود (حتی روی fixed_adv)
  const result = postStageCore(db, {
    orderId,
    stageId: stage.id,
    userId,
    mode: 'variable',
    body: {
      qty_out: planned,
      waste_normal: 0,
      waste_abnormal: 0,
      rework: 0,
      date: when,
      qc_passed: 1,
      note: `تکمیل خودکار از لایه‌چینی ${layNo || layId}`,
    },
  });

  return {
    ok: true,
    stage_id: stage.id,
    status: 'done',
    completed: true,
    lay_qty: cov.lay_qty,
    need: cov.need,
    message: cov.message,
    next_stage: result.next_stage || null,
  };
}

/**
 * برگشت اتصال لایه از مرحله — قبل از reverse موجودی/JE لایه صدا زده شود.
 */
function unlinkCuttingLayFromStage(db, {
  orderId, layId, layNo, amountRial, wasteAmountRial, userId, date,
}) {
  if (!orderId) return { ok: false, skipped: true };
  const po = getOrder(db, orderId);
  if (!['fixed_adv', 'variable_adv'].includes(po.analysis_type)) {
    return { ok: false, skipped: true };
  }

  const lay = db.prepare('SELECT stage_id FROM cutting_lays WHERE id=?').get(layId);
  const stageId = lay?.stage_id;
  if (!stageId) return { ok: false, skipped: true, reason: 'no_stage_link' };

  const stage = getStage(db, orderId, stageId);
  const [layGlobMid, layGlobEnd] = layNoteGlobs(layNo, layId);
  const mi = db.prepare(`
    SELECT * FROM production_material_issues
    WHERE stage_id=? AND order_id=? AND issue_type='cutting_lay'
      AND status='posted' AND (note GLOB ? OR note GLOB ?)
  `).all(stageId, orderId, layGlobMid, layGlobEnd);

  if (stage.status === 'done') {
    // ابطال مرحله (دستمزد/سربار + mi برچسبی همین لایه؛ موجودی پارچه را دست نمی‌زند)
    reverseStage(db, {
      orderId,
      stageId,
      reason: `ابطال لایه‌چینی ${layNo || layId}`,
      userId,
      date: date || todayJalali(),
      releaseLayIssueIds: mi.map(i => i.id),
    });
  } else {
    for (const i of mi) {
      db.prepare(`UPDATE production_material_issues SET status='reversed' WHERE id=?`).run(i.id);
    }
    const amt = Math.round(num(amountRial));
    const wasteAmt = Math.max(0, Math.round(num(wasteAmountRial)));
    if (mi.length && (amt > 0 || wasteAmt > 0)) {
      db.prepare(`
        UPDATE production_order_stages SET
          material_added_rial = MAX(0, COALESCE(material_added_rial,0) - ?),
          waste_abnormal_rial = MAX(0, COALESCE(waste_abnormal_rial,0) - ?)
        WHERE id=?
      `).run(amt, wasteAmt, stageId);
      db.prepare(`
        UPDATE production_orders SET
          material_cost_rial = MAX(0, material_cost_rial - ?),
          abnormal_waste_rial = MAX(0, COALESCE(abnormal_waste_rial,0) - ?),
          updated_at = strftime('%s','now')
        WHERE id=?
      `).run(amt, wasteAmt, orderId);
    }
  }

  db.prepare('UPDATE cutting_lays SET stage_id=NULL WHERE id=?').run(layId);
  applyDocumentCosts(db, orderId);
  return { ok: true, stage_id: stageId };
}

module.exports = {
  releaseAdvancedOrder,
  startStage,
  postStageOutputFixed,
  postStageOutputVariable,
  finalizeAdvancedOrder,
  skipStage,
  blockStage,
  unblockStage,
  reverseStage,
  stageUnissuedMaterialLines,
  stageMaterialLines,
  orderMaterialPieces,
  orderMaterialLinesAll,
  orderMaterialGaps,
  issueStageMaterials,
  issueStageExtraMaterials,
  voidStageExtraIssue,
  listStageExtraIssues,
  EXTRA_REASONS,
  stageList,
  getStageIssueTemplate,
  resolveFinalizeApparelLines,
  resolveProductApparelLines,
  variantLinesFromOrderPlan,
  relieveStagedPackQty,
  resolveCuttingStage,
  applyCuttingLayToStage,
  unlinkCuttingLayFromStage,
  cuttingStageCoverage,
};
