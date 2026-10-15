'use strict';
/**
 * Production Module 7/8 — Advanced fixed & variable stage execution
 */
const { allocateNumber, audit } = require('../../db');
const { todayJalali } = require('../../jalali');
const { assertFiscalYearWritable } = require('../fiscal-period');
const { explodeBom } = require('./bom');
const { backwardQty, stageLabor, stageDriverQty } = require('./bom-advanced');
const { dr, cr, plug, postEvent, reverseEvent, err } = require('./posting');
const {
  issueFromStock, updateMovingAverage, receiveScrap, restoreStock, setting,
} = require('./costing');
const {
  getOverheadRate, coerceDriver, appliedOverheadRial,
  bumpRateApplied, reverseAppliedOverheadCounters,
} = require('./overhead');
const { postLabor } = require('./labor');
const { jalaliPeriod, wipResidual, assertPeriodOpen } = require('./engine');
const {
  assertFabricIssueAllowed,
  assertFabricCuttingPathForFgReceipt,
  relieveStagedPackQty,
} = require('./cutting');

function num(v) { return Number(v) || 0; }
function round6(n) { return Math.round(Number(n) * 1e6) / 1e6; }

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
  const out = [];
  for (const row of rows) {
    let vid = row.variant_id != null ? Number(row.variant_id) : null;
    if (!vid && row.color_id && row.size_id) {
      vid = byCell.get(productId, row.color_id, row.size_id)?.id || null;
    }
    const qty = num(row.qty_planned != null ? row.qty_planned : row.qty);
    if (vid && qty > 0) out.push({ variant_id: vid, qty });
  }
  return out;
}

/**
 * Resolve FG apparel lines for advanced finalize.
 * Body wins; else order-plan lines if sum === qtyGood; else legacy breakdown.
 */
function resolveFinalizeApparelLines(db, po, body, qtyGood) {
  const apparel = require('../inventory/apparel-lines');
  const { hasActiveMatrixVariants } = require('../inventory/qty-policy');
  if (!hasActiveMatrixVariants(db, po.product_id)) return [];

  const bodyLines = Array.isArray(body.variant_lines)
    ? body.variant_lines.map(l => ({
      variant_id: l.variant_id || l.variantId,
      qty: num(l.qty != null ? l.qty : l.qty_planned),
    })).filter(l => l.variant_id && l.qty > 0)
    : [];

  if (bodyLines.length || body.variant_id) {
    return apparel.resolveApparelLines(db, {
      productId: po.product_id,
      qty: qtyGood,
      variantId: body.variant_id,
      variantLines: bodyLines.length ? bodyLines : body.variant_lines,
    });
  }

  const fromPlan = variantLinesFromOrderPlan(db, po.id, po.product_id);
  if (fromPlan.length) {
    const sum = round6(fromPlan.reduce((a, l) => a + l.qty, 0));
    if (Math.abs(sum - qtyGood) <= 0.001) {
      return apparel.resolveApparelLines(db, {
        productId: po.product_id,
        qty: qtyGood,
        variantLines: fromPlan,
      });
    }
    // Plan exists but output ≠ plan — try legacy fields, else ask for explicit matrix
    try {
      return apparel.resolveApparelLines(db, {
        productId: po.product_id,
        qty: qtyGood,
        sizeBreakdown: body.size_breakdown || po.size_breakdown,
        color: body.color || po.color,
      });
    } catch (e) {
      if (e && (e.code === 'E_VARIANT_REQUIRED' || e.code === 'E_VARIANT_QTY')) {
        const fail = err('E_VARIANT_QTY', 400, { sum, qty: qtyGood });
        fail.message = `جمع برنامه رنگ×سایز (${sum}) با خروجی نهایی (${qtyGood}) یکی نیست — تعداد واقعی هر ترکیب را وارد کنید`;
        throw fail;
      }
      throw e;
    }
  }

  return apparel.resolveApparelLines(db, {
    productId: po.product_id,
    qty: qtyGood,
    variantId: body.variant_id,
    variantLines: body.variant_lines,
    sizeBreakdown: body.size_breakdown || po.size_breakdown,
    color: body.color || po.color,
  });
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
    SELECT s.*, cc.code AS cc_code, cc.name AS cc_name
    FROM production_order_stages s
    LEFT JOIN cost_centers cc ON cc.id = s.cost_center_id
    WHERE s.order_id=? ORDER BY s.seq
  `).all(orderId);
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
  const amount = appliedOverheadRial(rate, driverQty);

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
  return backwardQty(db, po.bom_id, po.qty_planned).qty_start;
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
  });
  return ex.lines || [];
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
 * Materials for a shop-floor issue.
 * 1) Explicit operation assignment (sole/shared) when the stage has operation_id.
 * 2) Legacy: earliest stage of the line's cost center.
 * 3) If the formula has lines but nothing is linked, the first stage receives them
 *    so the voucher is not an empty dead-end.
 */
function stageMaterialLines(db, po, stage) {
  const lines = explodedOrderLines(db, po);
  const { materialsByOperation } = require('./bom-assignments');
  const byOp = po.bom_id ? materialsByOperation(db, po.bom_id) : new Map();

  if (byOp.size && stage.operation_id != null) {
    const rows = byOp.get(Number(stage.operation_id)) || [];
    const byLine = new Map(lines.map(L => [Number(L.bom_line_id), L]));
    return rows.map(a => {
      const L = byLine.get(Number(a.bom_line_id));
      if (!L) return null;
      return { ...L, qty_final: assignmentSliceQty(L, a) };
    }).filter(Boolean);
  }

  if (stageOwnsBomMaterials(db, po, stage)) {
    const ccLines = lines.filter(L => Number(L.stage_cost_center_id) === Number(stage.cost_center_id));
    const first = db.prepare(`
      SELECT id FROM production_order_stages
      WHERE order_id=? ORDER BY seq ASC, id ASC LIMIT 1
    `).get(po.id);
    const orphans = (!byOp.size && first && Number(first.id) === Number(stage.id))
      ? lines.filter(L => L.stage_cost_center_id == null || L.stage_cost_center_id === '')
      : [];
    const merged = [...ccLines];
    for (const L of orphans) {
      if (!merged.some(m => Number(m.bom_line_id) === Number(L.bom_line_id))) merged.push(L);
    }
    if (merged.length) return merged;
  }

  const first = db.prepare(`
    SELECT id FROM production_order_stages
    WHERE order_id=? ORDER BY seq ASC, id ASC LIMIT 1
  `).get(po.id);
  const isFirst = !!(first && Number(first.id) === Number(stage.id));
  if (!byOp.size && isFirst) {
    const orphans = lines.filter(L => L.stage_cost_center_id == null || L.stage_cost_center_id === '');
    if (orphans.length) return orphans;
    if (lines.length && !lines.some(L => L.stage_cost_center_id != null && L.stage_cost_center_id !== '')) {
      return lines;
    }
  }
  return [];
}

function stageMaterialEmptyHint(db, po, stage) {
  const lines = explodedOrderLines(db, po);
  if (!lines.length) {
    return 'این فرمول قلم مواد ندارد. در فرمول ساخت، تب «اقلام» را پر و ذخیره کنید.';
  }
  const { materialsByOperation } = require('./bom-assignments');
  const byOp = po.bom_id ? materialsByOperation(db, po.bom_id) : new Map();
  if (byOp.size) {
    const names = [];
    for (const opId of byOp.keys()) {
      const op = db.prepare('SELECT seq, operation_name FROM bom_operations WHERE id=?').get(opId);
      names.push((op?.operation_name || ('عملیات ' + opId)) + (op?.seq != null ? ` (${op.seq})` : ''));
    }
    return 'مواد به این مرحله وصل نیست. وصل شده به: ' + names.join('، ')
      + '. حواله را روی همان مرحله بزنید، یا در فرمول → مسیر عملیات، ماده را به این عملیات وصل کنید.';
  }
  if (lines.some(L => L.stage_cost_center_id)) {
    return 'مواد به مرکز هزینهٔ مرحلهٔ دیگری وصل است. حواله را روی همان مرحله باز کنید.';
  }
  return 'ماده‌ای برای این مرحله پیدا نشد.';
}

function backflushStageMaterials(db, {
  po, stage, date, period, userId, issueType = 'backflush',
}) {
  const lines = stageMaterialLines(db, po, stage);
  let matRial = 0, pkgRial = 0;
  const out = [];
  const whId = po.warehouse_raw_id;

  for (const L of lines) {
    const prod = db.prepare('SELECT * FROM products WHERE id=?').get(L.product_id);
    if (!prod) throw err('E_NOT_FOUND', 404, { productId: L.product_id });
    const unitCost = Math.round(num(prod.average_cost_rial));
    if (!unitCost && L.qty_final > 0) {
      throw err('E_ZERO_AVG_COST', 422, { name: prod.name, product_id: prod.id });
    }
    const amount = Math.round(L.qty_final * unitCost);

    let issued = null;
    if (L.qty_final > 0) {
      assertFabricIssueAllowed(db, {
        productId: L.product_id,
        qty: L.qty_final,
        orderId: po.id,
      });
      issued = issueFromStock(db, {
        productId: L.product_id,
        warehouseId: whId,
        qty: L.qty_final,
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

    const stageIssue = db.prepare(`
      INSERT INTO production_material_issues
        (doc_no, order_id, stage_id, cost_center_id, product_id, bom_line_id, issue_type,
         qty_standard, qty_actual, qty_variance, unit_cost_rial, std_cost_rial,
         amount_rial, std_amount_rial, var_price_rial, var_qty_rial,
         warehouse_id, date, period_label, status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?,'posted',?)
    `).run(
      docNo, po.id, stage.id, stage.cost_center_id, L.product_id, L.bom_line_id || null,
      issueType, L.qty_final, L.qty_final, 0, unitCost, L.unit_cost_rial || unitCost,
      amount, Math.round(L.qty_final * (L.unit_cost_rial || unitCost)),
      whId, date, period, userId
    );
    if (issued && issued.variantLines && issued.variantLines.length) {
      require('../inventory/apparel-lines').postApparelLines(db, {
        productId: L.product_id, warehouseId: whId, lines: issued.variantLines,
        docType: 'production_issue', docId: stageIssue.lastInsertRowid, userId,
        note: `مرحله ${stage.seq} — ${po.order_no}`, sign: -1, allowNegative: false,
      });
    }

    if (L.line_kind === 'packaging') pkgRial += amount;
    else matRial += amount;
    out.push({
      product_id: L.product_id,
      name: prod.name,
      qty: L.qty_final,
      unit_cost_rial: unitCost,
      amount_rial: amount,
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
  `).get(stageId);
  const total = Math.round(num(rows?.s));
  const pkg = Math.round(num(rows?.pkg));
  return { matRial: total - pkg, pkgRial: pkg, total };
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
    VALUES (?,?,?,?,?,'in',?,?,?,?,?,'posted',?)
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
        `).run(je1.je_id, orderId, stageId);
      }
    }
  } else {
    const hasBomLines = stageOwnsBomMaterials(db, po, stage) && db.prepare(`
      SELECT 1 FROM bom_lines WHERE bom_id=? AND stage_cost_center_id=? LIMIT 1
    `).get(po.bom_id, stage.cost_center_id);
    const issued = sumStageIssued(db, stageId);
    if (hasBomLines && issued.total < 1) throw err('E_NO_MATERIAL_ISSUED', 422);
    matRial = issued.matRial;
    pkgRial = issued.pkgRial;
  }

  const laborRial = stageLabor(db, op || {}, qtyIn, period);
  let laborMethod = op?.labor_method || 'piece';
  if (laborRial) {
    postLabor(db, {
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
      note: `دستمزد مرحله ${stage.seq}`,
    });
    const je2 = postEvent(db, {
      event: 'PRD-03',
      sourceId: orderId,
      date,
      description: `جذب دستمزد مرحله ${stage.seq} — ${po.order_no}`,
      createdBy: userId,
      costCenterId: stage.cost_center_id || po.cost_center_id || null,
      lines: [
        dr(db, 'coa_wip', laborRial, po.coa_wip_tafsili),
        cr(db, 'coa_labor_control', laborRial),
      ],
    });
    if (je2) {
      jes.push(je2);
      db.prepare(`
        UPDATE production_labor_entries SET je_id=?
        WHERE order_id=? AND stage_id=? AND je_id IS NULL
      `).run(je2.je_id, orderId, stageId);
    }
  }

  const ohDriverMat = mode === 'variable' ? matRial + pkgRial : matRial + pkgRial;
  const oh = applyStageOverhead(db, {
    po, stage, op, cc, qtyIn, laborRial, matRial: ohDriverMat, date, period, userId,
  });
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
  const materialAdded = matRial + pkgRial;
  const costGross = costIn + materialAdded + laborRial + oh.amount_rial + subcontractRial;
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

  const costOut = Math.round(costGross - abnormalRial - scrapCredit);
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
    materialAdded, laborRial, oh.amount_rial || 0, subcontractRial,
    abnormalRial, scrapCredit, costOut, unitCostOut,
    oh.driver_qty || 0, date,
    body.qc_passed != null ? (body.qc_passed ? 1 : 0) : stage.qc_passed,
    body.qc_note || stage.qc_note || '',
    stageId
  );

  const nxt = nextStage(db, orderId, stage.seq);
  if (nxt) {
    db.prepare(`
      UPDATE production_order_stages SET
        qty_in=?, material_in_rial=?, status='in_progress', started_at=?
      WHERE id=?
    `).run(qtyOut, costOut, date, nxt.id);
  }

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
    orderMat, orderPkg, laborRial, oh.amount_rial || 0, subcontractRial,
    abnormalRial, scrapCredit, wN, wA, date, orderId
  );

  const stages = stageList(db, orderId);
  const doneCount = stages.filter(s => s.status === 'done').length;

  emit(db, 'production.stage.completed', {
    orderId, stageId, ccId: stage.cost_center_id, qtyOut, costOutRial: costOut,
  });

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
      overhead_rial: oh.amount_rial || 0,
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

function releaseAdvancedOrder(db, orderId, userId) {
  return db.transaction(() => {
    const po = getOrder(db, orderId);
    if (!['fixed_adv', 'variable_adv'].includes(po.analysis_type)) {
      throw err('E_WRONG_ANALYSIS', 409);
    }
    if (po.status !== 'draft') throw err('E_INVALID_STATUS', 409, { status: po.status });
    if (!po.bom_id) throw err('E_NO_ACTIVE_BOM', 422);

    const bom = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(po.bom_id);
    if (!bom?.has_routing) throw err('E_NO_ROUTING', 422);

    const ops = db.prepare(`
      SELECT * FROM bom_operations WHERE bom_id=? ORDER BY seq
    `).all(po.bom_id);
    if (!ops.length) throw err('E_ROUTING_EMPTY', 422);

    const { qty_start: qtyStart } = backwardQty(db, po.bom_id, po.qty_planned);

    let qtyIn = qtyStart;
    const ins = db.prepare(`
      INSERT INTO production_order_stages
        (order_id, seq, cost_center_id, operation_id, operation_name, status,
         qty_in, driver, is_subcontract, supplier_id, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const cc = db.prepare('SELECT driver FROM cost_centers WHERE id=?').get(op.cost_center_id);
      const isFirst = i === 0;
      ins.run(
        orderId, op.seq, op.cost_center_id, op.id, op.operation_name || '',
        isFirst ? 'in_progress' : 'pending',
        isFirst ? qtyIn : 0,
        op.overhead_driver || cc?.driver || '',
        op.is_subcontract ? 1 : 0,
        op.subcontract_supplier_id || null,
        userId
      );
      qtyIn = round6(
        qtyIn * ((num(op.yield_percent) || 100) / 100)
          * (1 - (num(op.normal_waste_percent) || 0) / 100)
      );
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

    const stages = stageList(db, orderId);
    const last = stages[stages.length - 1];
    if (!last || last.status !== 'done') throw err('E_LAST_STAGE_NOT_DONE', 409);

    const open = stages.filter(s => !['done', 'skipped'].includes(s.status));
    if (open.length) throw err('E_STAGES_OPEN', 409, { open: open.map(s => s.seq) });

    const date = body.date || todayJalali();
    const period = jalaliPeriod(date);
    assertPeriodOpen(db, period);
    const jes = [];
    const wipFinal = Math.round(num(last.cost_out_rial));

    const bom = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(po.bom_id);
    const qtyStart = backwardQty(db, po.bom_id, po.qty_planned).qty_start;
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
    const mains = outs.filter(x => x.output_type === 'main');
    const qtyGood = num(body.qty_produced != null ? body.qty_produced : last.qty_out);
    if (qtyGood <= 0) throw err('E_QTY_INVALID', 422);

    // Matrix FG must name color×size. Prefer body; else production_order_lines
    // when plan qty matches output; else legacy color+size_breakdown.
    const fgLines = resolveFinalizeApparelLines(db, po, body, qtyGood);
    const unitCost = Math.round(wipNet / qtyGood);
    // F06: refuse finalize if a standalone cut-to-stock PACK already credited FG
    // for this product — that would double products.stock / WH-FG.
    require('./cutting').assertNoOrphanSellablePack(db, po.product_id, orderId);
    // Roll-fabric apparel: lay + PACK must cover FG qty before sellable receipt.
    assertFabricCuttingPathForFgReceipt(db, po, qtyGood);
    // F06: packs linked to this order staged qty in WH-WIP without touching
    // sellable stock. Relieve that warehouse qty here (warehouse-only out) so
    // finalize is the single products.stock / FG-warehouse increase.
    const avg = updateMovingAverage(db, {
      productId: po.product_id,
      warehouseId: po.warehouse_fg_id,
      qtyIn: qtyGood,
      amountRial: wipNet,
      userId,
      note: `تولید ${po.order_no}`,
      sourceType: 'production_receipt',
      sourceId: po.id,
      date,
    });

    let docNo = '';
    try { docNo = allocateNumber(db, 'production_receipt', 'PR'); }
    catch { docNo = `PR-${Date.now()}`; }

    const receiptId = db.prepare(`
      INSERT INTO production_receipts
        (doc_no, order_id, product_id, output_type, qty, unit_cost_rial, amount_rial,
         warehouse_id, is_partial, prev_avg_rial, prev_stock_qty, new_avg_rial,
         date, period_label, status, created_by)
      VALUES (?,?,?,'main',?,?,?,?,0,?,?,?,?,?,'posted',?)
    `).run(
      docNo, orderId, po.product_id, qtyGood, unitCost, wipNet, po.warehouse_fg_id,
      avg.prev_avg, avg.prev_qty, avg.new_avg, date, period, userId
    ).lastInsertRowid;
    require('../inventory/apparel-lines').postApparelLines(db, {
      productId: po.product_id, warehouseId: po.warehouse_fg_id,
      lines: fgLines, docType: 'production_fg', docId: receiptId, userId,
      note: `رسید تولید ${po.order_no}`, sign: 1, allowNegative: true,
    });
    require('../inventory/apparel-lines').saveDocVariantLines(
      db, 'production_receipts', receiptId, fgLines
    );

    const je7 = postEvent(db, {
      event: 'PRD-07',
      sourceId: receiptId,
      date,
      description: `رسید تولید ${qtyGood} — ${po.order_no}`,
      createdBy: userId,
      lines: [
        dr(db, 'coa_finished_goods', wipNet),
        cr(db, 'coa_wip', wipNet, po.coa_wip_tafsili),
      ],
    });
    if (je7) {
      jes.push(je7);
      db.prepare('UPDATE production_receipts SET je_id=? WHERE id=?').run(je7.je_id, receiptId);
    }

    relieveStagedPackQty(db, {
      orderId, productId: po.product_id, qtyGood, userId, date, receiptId,
    });

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
    `).run(qtyGood, byCredit, wipNet, unitCost, date, period, orderId);

    db.prepare(`
      UPDATE production_reservations SET status='consumed', qty_consumed=qty
      WHERE order_id=? AND status='active'
    `).run(orderId);

    const residual = wipResidual(db, orderId);
    emit(db, 'production.order.finalized', { orderId, unitCostRial: unitCost, wipNet });

    try {
      const { applyPricingFromCost } = require('../../routes/pricing-rules');
      applyPricingFromCost(db, po.product_id, unitCost);
    } catch (e) { console.warn('pricing_rules:', e.message); }

    return {
      ok: true,
      receipt_id: receiptId,
      qty_produced: qtyGood,
      byproduct_credit_rial: byCredit,
      wip_final_rial: wipFinal,
      amount_rial: wipNet,
      unit_cost_rial: unitCost,
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
    if (nxt && num(nxt.qty_in) <= 0 && lastDone && num(lastDone.qty_out) > 0) {
      db.prepare(`
        UPDATE production_order_stages SET qty_in=?, material_in_rial=? WHERE id=?
      `).run(lastDone.qty_out, lastDone.cost_out_rial || 0, nxt.id);
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
  const rows = db.prepare(`
    SELECT * FROM production_order_stages
    WHERE order_id=? AND seq > ? ORDER BY seq
  `).all(orderId, afterSeq);
  for (const st of rows) {
    if (st.status === 'done') continue;
    db.prepare(`
      UPDATE production_order_stages SET
        qty_in=0, material_in_rial=0,
        qty_out=0, qty_waste_normal=0, qty_waste_abnormal=0, qty_rework=0,
        material_added_rial=0, labor_rial=0, overhead_rial=0, subcontract_rial=0,
        waste_abnormal_rial=0, scrap_credit_rial=0, cost_out_rial=0, unit_cost_out_rial=0,
        driver_qty=0, status='pending', started_at=NULL, ended_at=NULL
      WHERE id=?
    `).run(st.id);
  }
}

/**
 * PRD-99 stage reversal — only the last completed stage (R12: reverse, not delete).
 */
function reverseStage(db, { orderId, stageId, reason, userId, date }) {
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

    const issues = db.prepare(`
      SELECT * FROM production_material_issues WHERE stage_id=? AND status='posted'
    `).all(stageId);
    for (const i of issues) if (i.je_id) jeIds.push(i.je_id);

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
        UPDATE production_material_issues SET reversed_je_id=?, status='reversed' WHERE je_id=?
      `).run(revId, jeId);
      db.prepare(`
        UPDATE production_subcontract SET status='reversed' WHERE je_id=?
      `).run(jeId);
    }

    for (const i of issues) {
      restoreStock(db, {
        productId: i.product_id,
        warehouseId: i.warehouse_id || po.warehouse_raw_id,
        qty: i.qty_actual,
        unitCostRial: i.unit_cost_rial,
        userId,
        note: `ابطال مرحله ${stage.seq} — ${po.order_no}`,
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

    const issued = sumStageIssued(db, stageId);
    const matAdded = Math.round(num(stage.material_added_rial));
    const matRial = issued.total ? issued.matRial : matAdded;
    const pkgRial = issued.total ? issued.pkgRial : 0;

    resetDownstreamStages(db, orderId, stage.seq);

    db.prepare(`
      UPDATE production_order_stages SET
        qty_out=0, qty_waste_normal=0, qty_waste_abnormal=0, qty_rework=0,
        material_added_rial=0, labor_rial=0, overhead_rial=0, subcontract_rial=0,
        waste_abnormal_rial=0, scrap_credit_rial=0, cost_out_rial=0, unit_cost_out_rial=0,
        driver_qty=0, status='in_progress', ended_at=NULL
      WHERE id=?
    `).run(stageId);

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

    const date = body.date || todayJalali();
    const period = jalaliPeriod(date);
    assertPeriodOpen(db, period);
    const materials = body.materials || body.lines || [];
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
      const s = std[L.product_id];
      if (!s && AQ > 0) {
        throw err('E_STAGE_MATERIAL_OWNER', 409, {
          product_id: L.product_id,
          name: prod.name,
          detail: 'این قلم به این مرحله از مسیر BOM تعلق ندارد',
        });
      }
      const SQ = s?.qty ?? 0;
      const SP = s?.price ?? Math.round(num(prod.average_cost_rial));
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
           warehouse_id, date, period_label, status, variance_status, note, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'posted','memo',?,?)
      `).run(
        issueNo, orderId, stageId, stage.cost_center_id, L.product_id, s?.bom_line_id || null,
        'issue', SQ, AQ, varQty, AP, SP, amount, Math.round(SQ * SP),
        varPRial, varQRial, po.warehouse_raw_id, date, period, L.reason || '', userId
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

function getStageIssueTemplate(db, orderId, stageId) {
  const po = getOrder(db, orderId);
  const stage = getStage(db, orderId, stageId);
  const lines = stageMaterialLines(db, po, stage).map(L => {
    const prod = db.prepare('SELECT id, name, average_cost_rial, std_cost_rial FROM products WHERE id=?').get(L.product_id);
    const avg = Math.round(Number(prod?.average_cost_rial) || 0);
    return {
      product_id: L.product_id,
      name: prod?.name || ('#' + L.product_id),
      qty_standard: L.qty_final,
      qty_actual: L.qty_final,
      std_cost_rial: Math.round(Number(L.unit_cost_rial) || Number(prod?.std_cost_rial) || 0),
      average_cost_rial: avg,
      // R11-safe gate (not stripped): operators without cost view still see zero-avg block
      avg_cost_ok: avg > 0 ? 1 : 0,
      bom_line_id: L.bom_line_id || null,
    };
  });
  return {
    order_id: orderId,
    stage_id: stageId,
    qty_in: stage.qty_in,
    operation_name: stage.operation_name || '',
    lines,
    empty_hint: lines.length ? '' : stageMaterialEmptyHint(db, po, stage),
  };
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
  issueStageMaterials,
  stageList,
  getStageIssueTemplate,
  resolveFinalizeApparelLines,
  variantLinesFromOrderPlan,
  relieveStagedPackQty,
};
