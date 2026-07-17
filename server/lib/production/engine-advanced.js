'use strict';
/**
 * Production Module 7/8 — Advanced fixed & variable stage execution
 */
const { allocateNumber, audit } = require('../../db');
const { todayJalali } = require('../../jalali');
const { assertFiscalYearWritable } = require('../fiscal-period');
const { explodeBom } = require('./bom');
const { backwardQty, stageLabor, stageDriverQty } = require('./bom-advanced');
const { dr, cr, plug, postEvent, err } = require('./posting');
const {
  issueFromStock, updateMovingAverage, receiveScrap, setting,
} = require('./costing');
const { getOverheadRate } = require('./overhead');
const { postLabor } = require('./labor');
const { jalaliPeriod, wipResidual } = require('./engine');

function num(v) { return Number(v) || 0; }
function round6(n) { return Math.round(Number(n) * 1e6) / 1e6; }

function safeJson(s) {
  if (!s) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
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
  const driver = stage.driver || op?.overhead_driver || cc?.driver || rate.driver || 'output_qty';
  const driverQty = stageDriverQty(db, op || {}, cc || {}, {
    qty: qtyIn, labor: laborRial, material: matRial,
  });
  const rateRial = Math.round(num(rate.total_rate_rial));
  const amount = Math.round(rateRial * driverQty);

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

  return { id, amount_rial: amount, driver, driver_qty: driverQty, rate_rial: rateRial };
}

function orderQtyStart(db, po) {
  return backwardQty(db, po.bom_id, po.qty_planned).qty_start;
}

function stageMaterialLines(db, po, stage) {
  const bom = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(po.bom_id);
  const qtyStart = orderQtyStart(db, po);
  const ex = explodeBom(db, {
    bomId: po.bom_id,
    qty: qtyStart,
    sizeBreakdown: safeJson(po.size_breakdown),
    priceBasis: 'average',
    yieldOverride: bom?.has_routing ? 100 : null,
  });
  return ex.lines.filter(L => L.stage_cost_center_id === stage.cost_center_id);
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

    if (L.qty_final > 0) {
      issueFromStock(db, {
        productId: L.product_id,
        warehouseId: whId,
        qty: L.qty_final,
        userId,
        note: `مرحله ${stage.seq} — ${po.order_no}`,
      });
    }

    let docNo = '';
    try { docNo = allocateNumber(db, 'material_issue', 'MI'); }
    catch { docNo = `MI-${Date.now()}`; }

    db.prepare(`
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

  const sid = supplierId || stage.supplier_id || 1;
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
    const hasBomLines = db.prepare(`
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
    matRial, pkgRial, laborRial, oh.amount_rial || 0, subcontractRial,
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
    if (['closed', 'cancelled'].includes(po.status)) throw err('E_ORDER_CLOSED', 409);

    const stages = stageList(db, orderId);
    const last = stages[stages.length - 1];
    if (!last || last.status !== 'done') throw err('E_LAST_STAGE_NOT_DONE', 409);

    const open = stages.filter(s => !['done', 'skipped'].includes(s.status));
    if (open.length) throw err('E_STAGES_OPEN', 409, { open: open.map(s => s.seq) });

    const date = body.date || todayJalali();
    const period = jalaliPeriod(date);
    const jes = [];
    const wipFinal = Math.round(num(last.cost_out_rial));

    const bom = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(po.bom_id);
    const qtyStart = backwardQty(db, po.bom_id, po.qty_planned).qty_start;
    const outs = db.prepare('SELECT * FROM bom_outputs WHERE bom_id=?').all(po.bom_id);

    let byCredit = 0;
    const scrapWh = whSetting(db, 'production_wh_scrap_id');

    for (const o of outs.filter(x => ['by', 'scrap'].includes(x.output_type))) {
      if (o.cost_method === 'zero') continue;
      const q = round6(num(o.qty_per_base) * qtyStart / (bom.base_qty || 1));
      const nrv = Math.round(num(o.nrv_rial));
      const amt = Math.round(q * nrv);
      if (!amt) continue;
      byCredit += amt;

      receiveScrap(db, {
        productId: o.product_id,
        qty: q,
        unitRial: nrv,
        warehouseId: scrapWh,
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
          dr(db, 'coa_scrap_inventory', amt),
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

    const unitCost = Math.round(wipNet / qtyGood);
    const avg = updateMovingAverage(db, {
      productId: po.product_id,
      warehouseId: po.warehouse_fg_id,
      qtyIn: qtyGood,
      amountRial: wipNet,
      userId,
      note: `تولید ${po.order_no}`,
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
    const hasCost = num(stage.material_added_rial) || num(stage.labor_rial);
    if (hasCost) throw err('E_STAGE_HAS_COST', 409);
    db.prepare(`
      UPDATE production_order_stages SET status='skipped', note=? WHERE id=?
    `).run(reason || 'رد شده', stageId);
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

function issueStageMaterials(db, { orderId, stageId, body, userId }) {
  return db.transaction(() => {
    const po = getOrder(db, orderId);
    if (po.analysis_type !== 'variable_adv') throw err('E_WRONG_ANALYSIS', 409);
    if (po.status === 'draft') throw err('E_NOT_RELEASED', 409);

    const stage = getStage(db, orderId, stageId);
    const date = body.date || todayJalali();
    const period = jalaliPeriod(date);
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
      const SQ = s?.qty ?? 0;
      const SP = s?.price ?? Math.round(num(prod.average_cost_rial));
      const AP = Math.round(num(prod.average_cost_rial));
      if (AQ > 0 && !AP) throw err('E_ZERO_AVG_COST', 422, { name: prod.name });

      const varQty = round6(AQ - SQ);
      const varPRial = Math.round((AP - SP) * AQ);
      const varQRial = Math.round(varQty * SP);
      const amount = Math.round(AQ * AP);

      if (AQ > 0) {
        issueFromStock(db, {
          productId: L.product_id, warehouseId: po.warehouse_raw_id, qty: AQ, userId,
          note: `حواله مرحله ${stage.seq}`,
        });
      }

      db.prepare(`
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

module.exports = {
  releaseAdvancedOrder,
  startStage,
  postStageOutputFixed,
  postStageOutputVariable,
  finalizeAdvancedOrder,
  skipStage,
  blockStage,
  unblockStage,
  issueStageMaterials,
  stageList,
};
