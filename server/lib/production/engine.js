'use strict';
/**
 * Production Module 2 — Fixed analysis engine
 */
const { allocateNumber, audit } = require('../../db');
const { todayJalali } = require('../../jalali');
const { assertFiscalYearWritable } = require('../fiscal-period');
const { acct } = require('../coa-map');
const { explodeBom, resolveBom } = require('./bom');
const { dr, cr, plug, postEvent, reverseEvent, err } = require('./posting');
const {
  issueFromStock, updateMovingAverage, receiveScrap, restoreStock, recalcAvgOnReturn, setting,
} = require('./costing');
const { applyOverhead } = require('./overhead');
const { sumLabor, autoPostLabor } = require('./labor');
const { classifyWaste, normalWastePct } = require('./waste');
const variance = require('./variance');
const {
  computeVariance, insertVarianceMemo, varianceReasonThreshold, varianceAnalysis,
  checkBomRevisionSuggestion, standardMapFromBom, round6,
} = variance;

function num(v) { return Number(v) || 0; }

function jalaliPeriod(date) {
  if (!date || typeof date !== 'string') return '';
  const parts = date.split('/');
  if (parts.length >= 2) return `${parts[0]}/${parts[1].padStart(2, '0')}`;
  return date.slice(0, 7);
}

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

function assertPeriodOpen(db, period) {
  if (!period) return;
  const closed = db.prepare(`
    SELECT 1 FROM production_period_close WHERE period_label=? AND status='closed'
  `).get(period);
  if (closed) throw err('E_PERIOD_CLOSED', 409, { period });
}

function getOrder(db, orderId) {
  const po = db.prepare('SELECT * FROM production_orders WHERE id=?').get(orderId);
  if (!po) throw err('E_NOT_FOUND', 404);
  return po;
}

function whSetting(db, key) {
  const v = setting(db, key, '');
  return v ? Number(v) : null;
}

function createOrder(db, body, userId) {
  const productId = Number(body.product_id);
  const qtyPlanned = num(body.qty_planned);
  if (!productId || qtyPlanned <= 0) throw err('E_QTY_INVALID', 422);
  const date = body.date || todayJalali();
  const period = body.period_label || jalaliPeriod(date);
  const analysisType = body.analysis_type || 'fixed';

  const fy = assertFiscalYearWritable(db, date);
  if (!fy.ok) throw err('E_PERIOD_CLOSED', 409, { detail: fy.error });
  assertPeriodOpen(db, period);

  const bom = resolveBom(db, {
    productId,
    date,
    preferredBomId: body.bom_id ? Number(body.bom_id) : null,
  });

  const whRaw = body.warehouse_raw_id || whSetting(db, 'production_wh_raw_id');
  const whFg = body.warehouse_fg_id || whSetting(db, 'production_wh_fg_id');
  let ccId = body.cost_center_id || null;
  if (!ccId) {
    const cc = db.prepare("SELECT id FROM cost_centers WHERE code='CC-30'").get();
    ccId = cc?.id || null;
  }

  // Standard snapshot
  let stdMat = 0, stdLab = 0, stdOh = 0;
  try {
    const ex = explodeBom(db, { bomId: bom.id, qty: qtyPlanned, priceBasis: 'std' });
    stdMat = ex.totals.total_rial;
  } catch { /* ignore */ }

  let orderNo;
  try {
    orderNo = allocateNumber(db, 'production_order', 'PO');
  } catch {
    orderNo = `PO-${Date.now()}`;
  }

  const sizeBd = body.size_breakdown
    ? (typeof body.size_breakdown === 'string' ? body.size_breakdown : JSON.stringify(body.size_breakdown))
    : '';

  const id = db.prepare(`
    INSERT INTO production_orders (
      order_no, product_id, bom_id, bom_version, analysis_type, production_mode,
      sales_order_id, customer_id, qty_planned, size_breakdown, color,
      warehouse_raw_id, warehouse_fg_id, cost_center_id,
      status, date, period_label, fiscal_year_id,
      std_material_rial, std_labor_rial, std_overhead_rial, std_total_rial, std_unit_rial,
      note, created_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?)
  `).run(
    orderNo, productId, bom.id, bom.version, analysisType,
    body.production_mode || 'MTS',
    body.sales_order_id || null, body.customer_id || null,
    qtyPlanned, sizeBd, body.color || '',
    whRaw, whFg, ccId,
    date, period, fy.fiscalYearId || null,
    stdMat, stdLab, stdOh, stdMat + stdLab + stdOh,
    qtyPlanned > 0 ? Math.round((stdMat + stdLab + stdOh) / qtyPlanned) : 0,
    body.note || '', userId
  ).lastInsertRowid;

  audit(userId, 'create', 'production_order', id, `ایجاد سفارش ${orderNo}`);
  emit(db, 'production.order.created', { orderId: id, orderNo });
  return getOrder(db, id);
}

function releaseOrder(db, orderId, userId) {
  const po = getOrder(db, orderId);
  if (['fixed_adv', 'variable_adv'].includes(po.analysis_type)) {
    const { releaseAdvancedOrder } = require('./engine-advanced');
    return releaseAdvancedOrder(db, orderId, userId);
  }
  return db.transaction(() => {
    if (po.status !== 'draft') throw err('E_INVALID_STATUS', 409, { status: po.status });
    if (!po.bom_id) throw err('E_NO_ACTIVE_BOM', 422);

    const ex = explodeBom(db, {
      bomId: po.bom_id,
      qty: po.qty_planned,
      sizeBreakdown: safeJson(po.size_breakdown),
      priceBasis: 'average',
    });

    for (const L of ex.lines) {
      db.prepare(`
        INSERT INTO production_reservations
          (order_id, product_id, warehouse_id, qty, status, date)
        VALUES (?,?,?,?,'active',?)
      `).run(po.id, L.product_id, po.warehouse_raw_id, L.qty_final, po.date);
    }

    db.prepare(`
      UPDATE production_orders SET status='released', updated_at=strftime('%s','now') WHERE id=?
    `).run(orderId);

    audit(userId, 'update', 'production_order', orderId, `آزادسازی ${po.order_no}`);
    emit(db, 'production.order.released', { orderId });
    return getOrder(db, orderId);
  })();
}

function cancelOrder(db, orderId, userId, reason = '') {
  return db.transaction(() => {
    const po = getOrder(db, orderId);
    if (!['draft', 'released'].includes(po.status)) {
      throw err('E_INVALID_STATUS', 409, { status: po.status });
    }
    const hasTx = db.prepare(`
      SELECT 1 FROM production_material_issues WHERE order_id=? AND status='posted' LIMIT 1
    `).get(orderId);
    if (hasTx) throw err('E_HAS_TRANSACTIONS', 409);

    db.prepare(`
      UPDATE production_reservations SET status='released' WHERE order_id=? AND status='active'
    `).run(orderId);
    db.prepare(`
      UPDATE production_orders SET status='cancelled', cancelled_reason=?, updated_at=strftime('%s','now')
      WHERE id=?
    `).run(reason || '', orderId);

    audit(userId, 'update', 'production_order', orderId, `لغو ${po.order_no}`);
    return getOrder(db, orderId);
  })();
}

function wipResidual(db, orderId) {
  const po = getOrder(db, orderId);
  const receipts = db.prepare(`
    SELECT COALESCE(SUM(amount_rial),0) s FROM production_receipts
    WHERE order_id=? AND status='posted'
  `).get(orderId);
  const inWip =
    num(po.material_cost_rial) + num(po.packaging_cost_rial) +
    num(po.labor_cost_rial) + num(po.overhead_cost_rial) +
    num(po.subcontract_cost_rial) + num(po.rework_cost_rial);
  const outWip =
    num(po.abnormal_waste_rial) + num(po.scrap_credit_rial) +
    num(po.byproduct_credit_rial) + num(receipts?.s);
  return inWip - outWip;
}

function closeOrder(db, orderId, userId) {
  return db.transaction(() => {
    const po = getOrder(db, orderId);
    if (po.status !== 'completed') throw err('E_INVALID_STATUS', 409, { status: po.status });
    const residual = wipResidual(db, orderId);
    if (Math.abs(residual) > 5) throw err('E_WIP_NOT_ZERO', 409, { residual });
    db.prepare(`
      UPDATE production_orders SET status='closed', closed_by=?, closed_at=strftime('%s','now')
      WHERE id=?
    `).run(userId, orderId);
    emit(db, 'production.order.closed', { orderId });
    return getOrder(db, orderId);
  })();
}

function reopenOrder(db, orderId, userId) {
  const po = getOrder(db, orderId);
  if (po.status !== 'closed') throw err('E_INVALID_STATUS', 409);
  db.prepare(`
    UPDATE production_orders SET status='completed', closed_by=NULL, closed_at=NULL WHERE id=?
  `).run(orderId);
  audit(userId, 'update', 'production_order', orderId, `بازگشایی ${po.order_no}`);
  return getOrder(db, orderId);
}

function checkCostDeviation(db, po, unitCost) {
  const std = num(po.std_unit_rial);
  if (!std || !unitCost) return;
  const pct = Math.abs(unitCost - std) / std;
  const thresh = Number(setting(db, 'production_cost_deviation_pct', '15')) / 100 || 0.15;
  if (pct > thresh) {
    try {
      db.prepare(`
        INSERT INTO app_notifications (user_id, title, body, type, created_at)
        VALUES (?,?,?,?,strftime('%s','now'))
      `).run(
        po.created_by || 1,
        'انحراف بهای تولید',
        `سفارش ${po.order_no}: بهای واقعی ${unitCost} در برابر استاندارد ${std}`,
        'warning'
      );
    } catch { /* table optional */ }
  }
}

function sumSubcontract(db, orderId) {
  try {
    const r = db.prepare(`
      SELECT COALESCE(SUM(fee_amount_rial),0) s FROM production_subcontract
      WHERE order_id=? AND status='posted' AND direction='in'
    `).get(orderId);
    return Math.round(Number(r?.s) || 0);
  } catch {
    return 0;
  }
}

function linkJeIssues(db, orderId, jeId) {
  db.prepare(`
    UPDATE production_material_issues SET je_id=?
    WHERE order_id=? AND je_id IS NULL AND status='posted'
  `).run(jeId, orderId);
}

function ledgerBalance(db, accountCode) {
  const r = db.prepare(`
    SELECT
      COALESCE(SUM(COALESCE(NULLIF(jl.debit_rial,0), ROUND(jl.debit), 0)),0) -
      COALESCE(SUM(COALESCE(NULLIF(jl.credit_rial,0), ROUND(jl.credit), 0)),0) bal
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0
  `).get(accountCode);
  return Math.round(Number(r?.bal) || 0);
}

function postReceiptFixed(db, { orderId, body, userId }) {
  return db.transaction(() => {
    const po = getOrder(db, orderId);
    if (po.status === 'closed') throw err('E_ORDER_CLOSED', 409);
    if (po.status === 'cancelled') throw err('E_ORDER_CANCELLED', 409);
    if (po.analysis_type !== 'fixed') throw err('E_WRONG_ANALYSIS', 409);
    if (body.materials || body.qty_actual != null) throw err('E_FIXED_NO_MANUAL_QTY', 422);
    if (!['released', 'in_progress', 'draft'].includes(po.status) && po.status !== 'completed') {
      // allow released / in_progress primarily; draft needs release first
      if (po.status === 'draft') throw err('E_NOT_RELEASED', 409);
    }

    const date = body.date || todayJalali();
    const period = jalaliPeriod(date);
    const fy = assertFiscalYearWritable(db, date);
    if (!fy.ok) throw err('E_PERIOD_CLOSED', 409, { detail: fy.error });
    assertPeriodOpen(db, period);

    const qtyGood = num(body.qty_produced);
    let wNormal = num(body.waste_normal);
    let wAbnorm = num(body.waste_abnormal);
    const qtyStarted = qtyGood + wNormal + wAbnorm;
    if (qtyStarted <= 0) throw err('E_QTY_INVALID', 422);
    // Waste cannot exceed planned qty (or explicit qty_started cap)
    const wasteCap = body.qty_started != null ? num(body.qty_started) : num(po.qty_planned);
    if (wNormal + wAbnorm > wasteCap + 1e-9) {
      throw err('E_WASTE_EXCEEDS_STARTED', 422, { waste: wNormal + wAbnorm, cap: wasteCap });
    }

    const pct = normalWastePct(db, po);
    const { wN, wA, allowed, autoReclass } = classifyWaste(db, {
      qtyStarted, wNormal, wAbnormal: wAbnorm, allowedPct: pct,
    });

    const jes = [];

    // ═══ ۱. Backflush (PRD-01) ═══
    const ex = explodeBom(db, {
      bomId: po.bom_id,
      qty: qtyStarted,
      sizeBreakdown: safeJson(po.size_breakdown),
      priceBasis: 'average',
    });

    let matRial = 0, pkgRial = 0;

    for (const L of ex.lines) {
      const prod = db.prepare('SELECT * FROM products WHERE id=?').get(L.product_id);
      if (!prod) throw err('E_NOT_FOUND', 404, { productId: L.product_id });
      const unitCost = Math.round(Number(prod.average_cost_rial) || 0);
      if (!unitCost) throw err('E_ZERO_AVG_COST', 422, { name: prod.name, product_id: prod.id });

      const amount = Math.round(L.qty_final * unitCost);
      issueFromStock(db, {
        productId: L.product_id,
        warehouseId: po.warehouse_raw_id,
        qty: L.qty_final,
        userId,
        note: `تولید ${po.order_no}`,
      });

      let stdCost = 0;
      if (L.bom_line_id) {
        const bl = db.prepare('SELECT std_cost_rial FROM bom_lines WHERE id=?').get(L.bom_line_id);
        stdCost = Math.round(Number(bl?.std_cost_rial) || Number(prod.std_cost_rial) || 0);
      }

      let docNo = '';
      try { docNo = allocateNumber(db, 'material_issue', 'MI'); }
      catch { docNo = `MI-${Date.now()}`; }

      db.prepare(`
        INSERT INTO production_material_issues
          (doc_no, order_id, cost_center_id, product_id, bom_line_id, issue_type,
           qty_standard, qty_actual, qty_variance, unit_cost_rial, std_cost_rial,
           amount_rial, std_amount_rial, var_price_rial, var_qty_rial,
           warehouse_id, date, period_label, status, created_by)
        VALUES (?,?,?,?,?,'backflush',?,?,0,?,?,?,?,?,0,?,?,?,'posted',?)
      `).run(
        docNo, orderId, po.cost_center_id, L.product_id, L.bom_line_id || null,
        L.qty_final, L.qty_final, unitCost, stdCost,
        amount, Math.round(L.qty_final * stdCost),
        Math.round(L.qty_final * (unitCost - stdCost)),
        po.warehouse_raw_id, date, period, userId
      );

      if (L.line_kind === 'packaging') pkgRial += amount;
      else matRial += amount;
    }

    const je1 = postEvent(db, {
      event: 'PRD-01',
      sourceId: orderId,
      date,
      description: `مصرف مواد — ${po.order_no}`,
      createdBy: userId,
      lines: plug([
        dr(db, 'coa_wip', matRial + pkgRial, po.coa_wip_tafsili),
        cr(db, 'coa_raw_materials', matRial),
        cr(db, 'coa_packaging_materials', pkgRial),
      ]),
    });
    if (je1) {
      jes.push(je1);
      linkJeIssues(db, orderId, je1.je_id);
    }

    // ═══ ۲. Labor (PRD-03) ═══
    let laborRial = sumLabor(db, orderId);
    let laborPostedNow = 0;
    if (!laborRial && body.auto_labor !== false) {
      laborPostedNow = autoPostLabor(db, {
        po, qtyStarted, date, period, userId,
        laborSpecs: body.labor || null,
      });
      laborRial = laborPostedNow;
    }
    if (laborRial && laborPostedNow) {
      const je2 = postEvent(db, {
        event: 'PRD-03',
        sourceId: orderId,
        date,
        description: `جذب دستمزد — ${po.order_no}`,
        createdBy: userId,
        lines: [
          dr(db, 'coa_wip', laborRial, po.coa_wip_tafsili),
          cr(db, 'coa_labor_control', laborRial),
        ],
      });
      if (je2) {
        jes.push(je2);
        db.prepare(`
          UPDATE production_labor_entries SET je_id=? WHERE order_id=? AND je_id IS NULL
        `).run(je2.je_id, orderId);
      }
    } else if (laborRial && !laborPostedNow) {
      // Already recorded earlier — include in WIP totals but don't re-post JE
      // Detect if any labor without je → post once
      const unposted = db.prepare(`
        SELECT COALESCE(SUM(amount_rial),0) s FROM production_labor_entries
        WHERE order_id=? AND status='posted' AND je_id IS NULL
      `).get(orderId);
      const unpaid = Math.round(Number(unposted?.s) || 0);
      if (unpaid > 0) {
        const je2 = postEvent(db, {
          event: 'PRD-03',
          sourceId: orderId,
          date,
          description: `جذب دستمزد — ${po.order_no}`,
          createdBy: userId,
          lines: [
            dr(db, 'coa_wip', unpaid, po.coa_wip_tafsili),
            cr(db, 'coa_labor_control', unpaid),
          ],
        });
        if (je2) {
          jes.push(je2);
          db.prepare(`
            UPDATE production_labor_entries SET je_id=? WHERE order_id=? AND je_id IS NULL
          `).run(je2.je_id, orderId);
        }
        laborRial = unpaid; // only new portion for this receipt's WIP increment
      } else {
        laborRial = 0; // already in order totals from prior receipt
      }
    }

    // ═══ ۳. Overhead (PRD-05) ═══
    const oh = applyOverhead(db, { po, qtyStarted, laborRial, matRial, date, period, userId });
    if (oh.amount_rial) {
      const je3 = postEvent(db, {
        event: 'PRD-05',
        sourceId: orderId,
        date,
        description: `جذب سربار — ${po.order_no} (${oh.driver} × ${oh.driver_qty})`,
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

    // ═══ ۴. WIP total ═══
    const wipTotal = matRial + pkgRial + laborRial + (oh.amount_rial || 0) + sumSubcontract(db, orderId);
    const costPerStarted = qtyStarted > 0 ? wipTotal / qtyStarted : 0;

    // ═══ ۵. Abnormal waste (PRD-09) ═══
    let abnormalRial = 0;
    if (wA > 0) {
      abnormalRial = Math.round(costPerStarted * wA);
      let docNo = '';
      try { docNo = allocateNumber(db, 'production_waste', 'WS'); }
      catch { docNo = `WS-${Date.now()}`; }

      const wasteId = db.prepare(`
        INSERT INTO production_waste
          (doc_no, order_id, cost_center_id, product_id, waste_type, qty, allowed_qty,
           unit_cost_rial, amount_rial, reason_code, reason_note, date, period_label, status, created_by)
        VALUES (?,?,?,?,'abnormal',?,?,?,?,?,?,?,?,'posted',?)
      `).run(
        docNo, orderId, po.cost_center_id, po.product_id,
        wA, allowed, Math.round(costPerStarted), abnormalRial,
        body.waste_abnormal_reason || 'other',
        autoReclass ? `شامل ${autoReclass} عدد مازاد بر سقف عادی` : (body.waste_abnormal_note || ''),
        date, period, userId
      ).lastInsertRowid;

      const je4 = postEvent(db, {
        event: 'PRD-09',
        sourceId: wasteId,
        date,
        description: `ضایعات غیرعادی ${wA} عدد — ${po.order_no}`,
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
          (doc_no, order_id, cost_center_id, product_id, waste_type, qty, allowed_qty,
           date, period_label, status, created_by)
        VALUES (?,?,?,?,'normal',?,?,?,?,'posted',?)
      `).run(docNo, orderId, po.cost_center_id, po.product_id, wN, allowed, date, period, userId);
      // no JE for normal waste
    }

    // ═══ ۶. Salable scrap (PRD-10) ═══
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

      let docNo = '';
      try { docNo = allocateNumber(db, 'production_waste', 'WS'); }
      catch { docNo = `WS-${Date.now()}`; }
      db.prepare(`
        INSERT INTO production_waste
          (doc_no, order_id, cost_center_id, product_id, scrap_product_id, waste_type, qty,
           nrv_unit_rial, nrv_amount_rial, amount_rial, warehouse_id,
           date, period_label, status, created_by)
        VALUES (?,?,?,?,?,'salable',?,?,?,?,?,?,?,'posted',?)
      `).run(
        docNo, orderId, po.cost_center_id, po.product_id, s.product_id,
        num(s.qty), Math.round(num(s.nrv_unit_rial)), amt, amt, scrapWh,
        date, period, userId
      );
    }
    if (scrapCredit) {
      const je5 = postEvent(db, {
        event: 'PRD-10',
        sourceId: orderId,
        date,
        description: `ضایعات قابل فروش — ${po.order_no}`,
        createdBy: userId,
        lines: [
          dr(db, 'coa_scrap_inventory', scrapCredit),
          cr(db, 'coa_wip', scrapCredit, po.coa_wip_tafsili),
        ],
      });
      if (je5) jes.push(je5);
    }

    // ═══ ۷. FG receipt (PRD-07) ═══
    const wipNet = wipTotal - abnormalRial - scrapCredit;
    if (wipNet < 0) throw err('E_NEGATIVE_WIP', 500);

    let unitCost = 0, receiptId = null;
    if (qtyGood > 0) {
      unitCost = Math.round(wipNet / qtyGood);
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

      receiptId = db.prepare(`
        INSERT INTO production_receipts
          (doc_no, order_id, product_id, output_type, qty, unit_cost_rial, amount_rial,
           warehouse_id, size_breakdown, is_partial, prev_avg_rial, prev_stock_qty, new_avg_rial,
           date, period_label, status, created_by)
        VALUES (?,?,?,'main',?,?,?,?,?,?,?,?,?,?,?,'posted',?)
      `).run(
        docNo, orderId, po.product_id,
        qtyGood, unitCost, wipNet, po.warehouse_fg_id,
        body.size_breakdown
          ? (typeof body.size_breakdown === 'string' ? body.size_breakdown : JSON.stringify(body.size_breakdown))
          : '',
        body.is_partial ? 1 : 0,
        avg.prev_avg, avg.prev_qty, avg.new_avg, date, period, userId
      ).lastInsertRowid;

      const je6 = postEvent(db, {
        event: 'PRD-07',
        sourceId: receiptId,
        date,
        description: `رسید تولید ${qtyGood} عدد — ${po.order_no}`,
        createdBy: userId,
        lines: [
          dr(db, 'coa_finished_goods', wipNet),
          cr(db, 'coa_wip', wipNet, po.coa_wip_tafsili),
        ],
      });
      if (je6) {
        jes.push(je6);
        db.prepare('UPDATE production_receipts SET je_id=? WHERE id=?').run(je6.je_id, receiptId);
      }
    } else if (wipNet > 0) {
      // All wasted — dump remaining WIP to abnormal (T2-22)
      const jeDump = postEvent(db, {
        event: 'PRD-09',
        sourceId: orderId,
        date,
        description: `ضایعات کامل — ${po.order_no}`,
        createdBy: userId,
        lines: [
          dr(db, 'coa_abnormal_waste', wipNet),
          cr(db, 'coa_wip', wipNet, po.coa_wip_tafsili),
        ],
      });
      if (jeDump) jes.push(jeDump);
      abnormalRial += wipNet;
    }

    // ═══ ۸. Update order ═══
    const newStatus = body.is_partial ? 'in_progress' : (qtyGood > 0 ? 'completed' : 'completed');
    db.prepare(`
      UPDATE production_orders SET
        qty_produced = qty_produced + ?,
        qty_waste_normal = qty_waste_normal + ?,
        qty_waste_abnormal = qty_waste_abnormal + ?,
        material_cost_rial = material_cost_rial + ?,
        packaging_cost_rial = packaging_cost_rial + ?,
        labor_cost_rial = labor_cost_rial + ?,
        overhead_cost_rial = overhead_cost_rial + ?,
        abnormal_waste_rial = abnormal_waste_rial + ?,
        scrap_credit_rial = scrap_credit_rial + ?,
        total_cost_rial = total_cost_rial + ?,
        unit_cost_rial = ?,
        status = ?,
        actual_end = ?,
        period_label = ?,
        updated_at = strftime('%s','now')
      WHERE id=?
    `).run(
      qtyGood, wN, wA,
      matRial, pkgRial, laborRial, oh.amount_rial || 0,
      abnormalRial, scrapCredit,
      Math.max(0, wipTotal - abnormalRial - scrapCredit),
      unitCost,
      newStatus, date, period, orderId
    );

    // consume reservations
    db.prepare(`
      UPDATE production_reservations SET status='consumed', qty_consumed=qty
      WHERE order_id=? AND status='active'
    `).run(orderId);

    const residual = wipResidual(db, orderId);
    checkCostDeviation(db, po, unitCost);
    audit(userId, 'create', 'production_receipt', receiptId,
      `رسید ${qtyGood} عدد ${po.order_no} — بهای واحد ${unitCost} ریال`);
    emit(db, 'production.receipt.posted', {
      orderId, qty: qtyGood, unitCostRial: unitCost, netRial: wipNet,
    });

    if (qtyGood > 0 && unitCost > 0) {
      try {
        const { applyPricingFromCost } = require('../../routes/pricing-rules');
        applyPricingFromCost(db, po.product_id, unitCost);
      } catch (e) { console.warn('pricing_rules:', e.message); }
    }

    return {
      ok: true,
      receipt_id: receiptId,
      qty_started: qtyStarted,
      qty_produced: qtyGood,
      costs: {
        material_rial: matRial,
        packaging_rial: pkgRial,
        labor_rial: laborRial,
        overhead_rial: oh.amount_rial || 0,
        wip_total_rial: wipTotal,
        abnormal_waste_rial: abnormalRial,
        scrap_credit_rial: scrapCredit,
        net_rial: Math.max(0, wipNet),
        unit_cost_rial: unitCost,
      },
      journal_entries: jes,
      wip_residual_rial: residual,
      auto_reclass_waste: autoReclass,
    };
  })();
}

function previewReceiptFixed(db, { orderId, body }) {
  const po = getOrder(db, orderId);
  if (po.analysis_type !== 'fixed') throw err('E_WRONG_ANALYSIS', 409);
  if (body.materials || body.qty_actual != null) throw err('E_FIXED_NO_MANUAL_QTY', 422);

  const qtyGood = num(body.qty_produced);
  const wNormal = num(body.waste_normal);
  const wAbnorm = num(body.waste_abnormal);
  const qtyStarted = qtyGood + wNormal + wAbnorm;
  if (qtyStarted <= 0) throw err('E_QTY_INVALID', 422);

  const { wN, wA, allowed } = classifyWaste(db, {
    qtyStarted, wNormal, wAbnormal: wAbnorm, allowedPct: normalWastePct(db, po),
  });

  const ex = explodeBom(db, {
    bomId: po.bom_id,
    qty: qtyStarted,
    sizeBreakdown: safeJson(po.size_breakdown),
    priceBasis: 'average',
  });

  let matRial = 0, pkgRial = 0;
  const lines = [];
  for (const L of ex.lines) {
    const prod = db.prepare('SELECT name, average_cost_rial, stock FROM products WHERE id=?').get(L.product_id);
    const unitCost = Math.round(Number(prod?.average_cost_rial) || 0);
    const amount = Math.round(L.qty_final * unitCost);
    if (L.line_kind === 'packaging') pkgRial += amount;
    else matRial += amount;
    lines.push({
      product_id: L.product_id,
      name: prod?.name,
      qty_final: L.qty_final,
      unit_cost_rial: unitCost,
      amount_rial: amount,
      stock: Number(prod?.stock) || 0,
      shortage: Math.max(0, L.qty_final - (Number(prod?.stock) || 0)),
      line_kind: L.line_kind,
    });
  }

  let laborRial = 0;
  for (const s of (body.labor || [])) {
    laborRial += Math.round(qtyStarted * num(s.rate_rial || s.rateRial));
  }
  if (!laborRial) laborRial = sumLabor(db, orderId);

  // OH estimate
  let ohRial = 0;
  try {
    const { getOverheadRate, computeDriverQty } = require('./overhead');
    const period = jalaliPeriod(body.date || po.date);
    const rate = getOverheadRate(db, po.cost_center_id, period);
    if (rate) {
      const dq = computeDriverQty(db, {
        driver: rate.driver, po, qtyStarted, laborRial, matRial,
      });
      ohRial = Math.round(num(rate.total_rate_rial) * dq);
    }
  } catch { /* ignore */ }

  const wipTotal = matRial + pkgRial + laborRial + ohRial;
  const costPerStarted = qtyStarted > 0 ? wipTotal / qtyStarted : 0;
  const abnormalRial = Math.round(costPerStarted * wA);
  let scrapCredit = 0;
  for (const s of (body.scrap || [])) {
    scrapCredit += Math.round(num(s.qty) * num(s.nrv_unit_rial));
  }
  const wipNet = wipTotal - abnormalRial - scrapCredit;
  const unitCost = qtyGood > 0 ? Math.round(wipNet / qtyGood) : 0;

  return {
    qty_started: qtyStarted,
    qty_produced: qtyGood,
    waste_normal: wN,
    waste_abnormal: wA,
    allowed_normal: allowed,
    materials: lines,
    costs: {
      material_rial: matRial,
      packaging_rial: pkgRial,
      labor_rial: laborRial,
      overhead_rial: ohRial,
      wip_total_rial: wipTotal,
      abnormal_waste_rial: abnormalRial,
      scrap_credit_rial: scrapCredit,
      net_rial: wipNet,
      unit_cost_rial: unitCost,
    },
  };
}

/**
 * Full reverse of a completed fixed order — restore stock + reverse journals.
 */
function reverseOrder(db, orderId, userId, reason = '') {
  return db.transaction(() => {
    const po = getOrder(db, orderId);
    if (po.status === 'closed') throw err('E_ORDER_CLOSED', 409);

    // Check FG sold after receipt (stock decreased below prev)
    const receipts = db.prepare(`
      SELECT * FROM production_receipts WHERE order_id=? AND status='posted' ORDER BY id DESC
    `).all(orderId);

    for (const r of receipts) {
      const prod = db.prepare('SELECT stock FROM products WHERE id=?').get(r.product_id);
      const sold = (Number(r.prev_stock_qty) + Number(r.qty)) - (Number(prod?.stock) || 0);
      if (sold > 0.0001) throw err('E_FG_SOLD', 409, { sold });
    }

    const date = todayJalali();
    const jeIds = new Set();

    // Collect JEs in reverse order of posting
    for (const r of receipts) if (r.je_id) jeIds.add(r.je_id);
    const wastes = db.prepare(`SELECT * FROM production_waste WHERE order_id=? AND status='posted'`).all(orderId);
    for (const w of wastes) if (w.je_id) jeIds.add(w.je_id);
    const ohs = db.prepare(`SELECT * FROM production_overhead_applications WHERE order_id=? AND status='posted'`).all(orderId);
    for (const o of ohs) if (o.je_id) jeIds.add(o.je_id);
    const labs = db.prepare(`SELECT * FROM production_labor_entries WHERE order_id=? AND status='posted'`).all(orderId);
    for (const l of labs) if (l.je_id) jeIds.add(l.je_id);
    const issues = db.prepare(`SELECT * FROM production_material_issues WHERE order_id=? AND status='posted'`).all(orderId);
    for (const i of issues) if (i.je_id) jeIds.add(i.je_id);

    // Also scrap JE may be on order id without waste.je_id for salable — find by ref
    const scrapJes = db.prepare(`
      SELECT id FROM journal_entries WHERE ref_type='production_scrap' AND ref_id=?
    `).all(orderId);
    for (const j of scrapJes) jeIds.add(j.id);

    // Reverse journals (newest first)
    const sorted = [...jeIds].sort((a, b) => b - a);
    for (const jeId of sorted) {
      const revId = reverseEvent(db, { jeId, reason, userId, date });
      db.prepare(`UPDATE production_receipts SET reversed_je_id=?, status='reversed' WHERE je_id=?`).run(revId, jeId);
      db.prepare(`UPDATE production_waste SET reversed_je_id=?, status='reversed' WHERE je_id=?`).run(revId, jeId);
      db.prepare(`UPDATE production_overhead_applications SET reversed_je_id=?, status='reversed' WHERE je_id=?`).run(revId, jeId);
      db.prepare(`UPDATE production_labor_entries SET reversed_je_id=?, status='reversed' WHERE je_id=?`).run(revId, jeId);
      db.prepare(`UPDATE production_material_issues SET reversed_je_id=?, status='reversed' WHERE je_id=?`).run(revId, jeId);
    }

    // Restore FG stock (undo receipt avg) — use snapshot rows from before JE reverse
    for (const r of receipts) {
      const prod = db.prepare('SELECT stock FROM products WHERE id=?').get(r.product_id);
      const newStock = Math.max(0, (Number(prod?.stock) || 0) - Number(r.qty));
      db.prepare(`
        UPDATE products SET stock=?, average_cost_rial=?, cost=? WHERE id=?
      `).run(newStock, r.prev_avg_rial, (r.prev_avg_rial || 0) / 10, r.product_id);
      if (r.warehouse_id) {
        db.prepare(`
          UPDATE warehouse_stock SET qty = qty - ? WHERE product_id=? AND warehouse_id=?
        `).run(r.qty, r.product_id, r.warehouse_id);
      }
      db.prepare(
        'INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)'
      ).run(r.product_id, userId, -r.qty, `ابطال رسید ${po.order_no}`);
      db.prepare(`UPDATE production_receipts SET status='reversed' WHERE id=?`).run(r.id);
    }

    // Restore materials (issue does not change average_cost)
    for (const i of issues) {
      restoreStock(db, {
        productId: i.product_id,
        warehouseId: i.warehouse_id,
        qty: i.qty_actual,
        userId,
        note: `ابطال مصرف ${po.order_no}`,
      });
      db.prepare(`UPDATE production_material_issues SET status='reversed' WHERE id=?`).run(i.id);
    }

    // Reverse scrap inventory
    for (const w of wastes) {
      if (w.waste_type === 'salable' && w.scrap_product_id && w.qty) {
        db.prepare('UPDATE products SET stock = stock - ? WHERE id=?')
          .run(w.qty, w.scrap_product_id);
        if (w.warehouse_id) {
          db.prepare(`
            UPDATE warehouse_stock SET qty = qty - ? WHERE product_id=? AND warehouse_id=?
          `).run(w.qty, w.scrap_product_id, w.warehouse_id);
        }
      }
      db.prepare(`UPDATE production_waste SET status='reversed' WHERE id=?`).run(w.id);
    }

    for (const o of ohs) {
      db.prepare(`UPDATE production_overhead_applications SET status='reversed' WHERE id=?`).run(o.id);
    }
    for (const l of labs) {
      db.prepare(`UPDATE production_labor_entries SET status='reversed' WHERE id=?`).run(l.id);
    }

    db.prepare(`
      UPDATE production_orders SET
        status='cancelled', cancelled_reason=?,
        qty_produced=0, qty_waste_normal=0, qty_waste_abnormal=0,
        material_cost_rial=0, packaging_cost_rial=0, labor_cost_rial=0,
        overhead_cost_rial=0, abnormal_waste_rial=0, scrap_credit_rial=0,
        total_cost_rial=0, unit_cost_rial=0
      WHERE id=?
    `).run(reason || 'ابطال', orderId);

    emit(db, 'production.order.reversed', { orderId, reason });
    return { ok: true, order_id: orderId };
  })();
}

function issueTemplate(db, { orderId, qtyStarted }) {
  const po = getOrder(db, orderId);
  const qty = num(qtyStarted) || num(po.qty_planned);
  const ex = explodeBom(db, {
    bomId: po.bom_id,
    qty,
    sizeBreakdown: safeJson(po.size_breakdown),
    priceBasis: 'std',
  });
  return {
    order_id: orderId,
    qty_started: qty,
    lines: ex.lines.map(L => {
      const p = db.prepare('SELECT name, average_cost_rial, item_type FROM products WHERE id=?').get(L.product_id);
      return {
        product_id: L.product_id,
        name: p?.name,
        qty_standard: L.qty_final,
        qty_actual: L.qty_final,
        std_cost_rial: L.unit_cost_rial,
        average_cost_rial: Math.round(Number(p?.average_cost_rial) || 0),
        line_kind: L.line_kind,
        bom_line_id: L.bom_line_id,
      };
    }),
  };
}

/**
 * Variable analysis — issue actual materials (ADR-011: variances memo only).
 */
function issueMaterialsVariable(db, { orderId, body, userId }) {
  return db.transaction(() => {
    const po = getOrder(db, orderId);
    if (po.analysis_type !== 'variable') throw err('E_WRONG_ANALYSIS', 409);
    if (['closed', 'cancelled'].includes(po.status)) throw err('E_ORDER_CLOSED', 409);
    if (po.status === 'draft') throw err('E_NOT_RELEASED', 409);

    const hasReceipt = db.prepare(`
      SELECT 1 FROM production_receipts WHERE order_id=? AND status='posted' LIMIT 1
    `).get(orderId);
    if (hasReceipt) throw err('E_RECEIPT_EXISTS', 409);

    const date = body.date || todayJalali();
    const period = jalaliPeriod(date);
    assertPeriodOpen(db, period);
    const fy = assertFiscalYearWritable(db, date);
    if (!fy.ok) throw err('E_PERIOD_CLOSED', 409, { detail: fy.error });

    const qtyStarted = num(body.qty_started) || num(po.qty_planned);
    const threshold = varianceReasonThreshold(db);
    const materials = body.materials || body.lines || [];
    if (!materials.length) throw err('E_QTY_INVALID', 422);

    // Standard map from BOM explode
    const { std } = standardMapFromBom(db, po, qtyStarted);

    let issueNo;
    try { issueNo = allocateNumber(db, 'material_issue', 'MI'); }
    catch { issueNo = `MI-${Date.now()}`; }

    let matRial = 0, pkgRial = 0, varP = 0, varQ = 0;
    const warnings = [];
    const out = [];
    const whId = po.warehouse_raw_id;

    for (const L of materials) {
      const AQ = num(L.qty_actual != null ? L.qty_actual : L.qty);
      const prod = db.prepare('SELECT * FROM products WHERE id=?').get(L.product_id);
      if (!prod) throw err('E_NOT_FOUND', 404, { productId: L.product_id });

      const s = std[L.product_id] || (L.substitute_of_product_id ? std[L.substitute_of_product_id] : null);
      const SQ = s?.qty ?? 0;
      let SP = s?.price ?? 0;
      const AP = Math.round(Number(prod.average_cost_rial) || 0);

      if (AQ > 0 && !AP) throw err('E_ZERO_AVG_COST', 422, { name: prod.name });
      if (!SP) {
        SP = AP;
        warnings.push(`نرخ استاندارد «${prod.name}» تعریف نشده — از نرخ واقعی استفاده شد`);
      }
      if (!s) {
        warnings.push({
          code: 'W_ITEM_NOT_IN_BOM',
          product_id: L.product_id,
          message: `«${prod.name}» در فرمول نیست — کل مصرف انحراف محسوب می‌شود`,
        });
      }

      let unitCost = AP;
      if (AQ < 0) {
        const totRow = db.prepare(`
          SELECT COALESCE(SUM(qty_actual),0) tot
          FROM production_material_issues
          WHERE order_id=? AND product_id=? AND status='posted'
        `).get(orderId, L.product_id);
        const origRate = db.prepare(`
          SELECT unit_cost_rial FROM production_material_issues
          WHERE order_id=? AND product_id=? AND status='posted' AND qty_actual > 0
          ORDER BY id ASC LIMIT 1
        `).get(orderId, L.product_id);
        if (!totRow || totRow.tot <= 0 || !origRate) {
          throw err('E_RETURN_WITHOUT_ISSUE', 422, { name: prod.name });
        }
        if (Math.abs(AQ) > totRow.tot + 1e-9) {
          throw err('E_RETURN_EXCEEDS_ISSUE', 422, { r: Math.abs(AQ), i: totRow.tot });
        }
        unitCost = Math.round(Number(origRate.unit_cost_rial) || AP);
      }

      const v = computeVariance({ AQ, SQ, AP: unitCost, SP });
      const varQty = v.qty_variance;
      const varPRial = v.varPrice;
      const varQRial = v.varQty;
      const pct = v.pct;

      if (Math.abs(pct) > threshold && !L.reason && AQ > 0) {
        throw err('E_VARIANCE_NEEDS_REASON', 422, { name: prod.name, pct: pct.toFixed(1) });
      }

      const amount = Math.round(AQ * unitCost);
      if (AQ > 0) {
        issueFromStock(db, {
          productId: L.product_id, warehouseId: whId, qty: AQ, userId,
          note: `حواله ${issueNo}`,
        });
      } else if (AQ < 0) {
        recalcAvgOnReturn(db, {
          productId: L.product_id, warehouseId: whId, qty: -AQ,
          unitCostRial: unitCost, userId,
          note: `برگشت ${issueNo}`,
        });
      }

      db.prepare(`
        INSERT INTO production_material_issues
          (doc_no, order_id, cost_center_id, product_id, bom_line_id, issue_type,
           qty_standard, qty_actual, qty_variance, unit_cost_rial, std_cost_rial,
           amount_rial, std_amount_rial, var_price_rial, var_qty_rial,
           warehouse_id, substitute_of_product_id, date, period_label,
           status, variance_status, note, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'posted','memo',?,?)
      `).run(
        issueNo, orderId, po.cost_center_id, L.product_id, s?.bom_line_id || null,
        AQ < 0 ? 'return' : (L.substitute_of_product_id ? 'substitute' : 'issue'),
        SQ, AQ, varQty, unitCost, SP, amount, Math.round(SQ * SP),
        varPRial, varQRial, whId, L.substitute_of_product_id || null,
        date, period, L.reason || '', userId
      );

      const kind = s?.kind || (prod.item_type === 'packaging' ? 'packaging' : 'material');
      if (kind === 'packaging') pkgRial += amount;
      else matRial += amount;
      varP += varPRial;
      varQ += varQRial;

      if (varPRial || varQRial) {
        insertVarianceMemo(db, { period, orderId, productId: L.product_id, type: 'material_price', rial: varPRial });
        insertVarianceMemo(db, { period, orderId, productId: L.product_id, type: 'material_qty', rial: varQRial });
      }

      out.push({
        product_id: L.product_id, name: prod.name,
        qty_standard: SQ, qty_actual: AQ, qty_variance: varQty,
        std_cost_rial: SP, unit_cost_rial: unitCost,
        std_amount_rial: Math.round(SQ * SP), amount_rial: amount,
        var_price_rial: varPRial, var_qty_rial: varQRial,
        var_total_rial: varPRial + varQRial,
      });
    }

    const totalRial = matRial + pkgRial;
    const event = totalRial >= 0 ? 'PRD-01' : 'PRD-02';
    const lines = totalRial >= 0
      ? plug([
        dr(db, 'coa_wip', totalRial, po.coa_wip_tafsili),
        cr(db, 'coa_raw_materials', matRial),
        cr(db, 'coa_packaging_materials', pkgRial),
      ])
      : plug([
        dr(db, 'coa_raw_materials', -matRial),
        dr(db, 'coa_packaging_materials', -pkgRial),
        cr(db, 'coa_wip', -totalRial, po.coa_wip_tafsili),
      ]);

    const je = postEvent(db, {
      event,
      sourceId: orderId,
      date,
      description: `${totalRial >= 0 ? 'مصرف' : 'برگشت'} مواد ${issueNo} — ${po.order_no}`,
      createdBy: userId,
      lines,
    });
    if (je) {
      db.prepare('UPDATE production_material_issues SET je_id=? WHERE doc_no=? AND order_id=?')
        .run(je.je_id, issueNo, orderId);
    }

    db.prepare(`
      UPDATE production_orders SET
        material_cost_rial = material_cost_rial + ?,
        packaging_cost_rial = packaging_cost_rial + ?,
        status = CASE WHEN status='released' THEN 'in_progress' ELSE status END,
        actual_start = CASE WHEN actual_start='' OR actual_start IS NULL THEN ? ELSE actual_start END,
        updated_at = strftime('%s','now')
      WHERE id=?
    `).run(matRial, pkgRial, date, orderId);

    // ADR-011 assertion aid: never post to 5210/5211 here
    return {
      ok: true,
      issue_no: issueNo,
      lines: out,
      totals: {
        material_rial: matRial,
        packaging_rial: pkgRial,
        total_rial: totalRial,
        std_total_rial: out.reduce((s, l) => s + l.std_amount_rial, 0),
        var_price_rial: varP,
        var_qty_rial: varQ,
        var_total_rial: varP + varQ,
      },
      journal_entry: je,
      note: 'انحرافات اطلاعاتی هستند و سند حسابداری ندارند (ADR-011)',
      warnings,
    };
  })();
}

/**
 * Variable receipt — no backflush; materials already issued.
 */
function postReceiptVariable(db, { orderId, body, userId }) {
  return db.transaction(() => {
    const po = getOrder(db, orderId);
    if (po.analysis_type !== 'variable') throw err('E_WRONG_ANALYSIS', 409);
    if (po.status === 'closed') throw err('E_ORDER_CLOSED', 409);

    const issued = db.prepare(`
      SELECT COALESCE(SUM(amount_rial),0) s FROM production_material_issues
      WHERE order_id=? AND status='posted'
    `).get(orderId);
    if (!issued || Math.abs(Number(issued.s)) < 1) throw err('E_NO_MATERIAL_ISSUED', 422);

    const date = body.date || todayJalali();
    const period = jalaliPeriod(date);
    assertPeriodOpen(db, period);

    const qtyGood = num(body.qty_produced);
    const wNormal = num(body.waste_normal);
    const wAbnorm = num(body.waste_abnormal);
    const qtyStarted = qtyGood + wNormal + wAbnorm;
    if (qtyStarted <= 0) throw err('E_QTY_INVALID', 422);
    const wasteCap = body.qty_started != null ? num(body.qty_started) : num(po.qty_planned);
    if (wNormal + wAbnorm > wasteCap + 1e-9) throw err('E_WASTE_EXCEEDS_STARTED', 422);

    const { wN, wA, allowed, autoReclass } = classifyWaste(db, {
      qtyStarted, wNormal, wAbnormal: wAbnorm, allowedPct: normalWastePct(db, po),
    });

    const jes = [];
    // Materials already in WIP — use order balances (actual)
    const matRial = 0;
    const pkgRial = 0;
    const matActual = num(po.material_cost_rial);
    const pkgActual = num(po.packaging_cost_rial);

    let laborRial = 0;
    if (body.auto_labor !== false) {
      laborRial = autoPostLabor(db, {
        po, qtyStarted, date, period, userId,
        laborSpecs: body.labor || null,
      });
    }
    if (laborRial) {
      const je2 = postEvent(db, {
        event: 'PRD-03', sourceId: orderId, date,
        description: `جذب دستمزد — ${po.order_no}`, createdBy: userId,
        lines: [
          dr(db, 'coa_wip', laborRial, po.coa_wip_tafsili),
          cr(db, 'coa_labor_control', laborRial),
        ],
      });
      if (je2) {
        jes.push(je2);
        db.prepare(`UPDATE production_labor_entries SET je_id=? WHERE order_id=? AND je_id IS NULL`)
          .run(je2.je_id, orderId);
      }
    }

    // R7: variable OH uses actual material (material + packaging)
    const oh = applyOverhead(db, {
      po, qtyStarted, laborRial,
      matRial: matActual + pkgActual,
      date, period, userId,
    });
    if (oh.amount_rial) {
      const je3 = postEvent(db, {
        event: 'PRD-05', sourceId: orderId, date,
        description: `جذب سربار — ${po.order_no}`, createdBy: userId,
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

    const wipTotal = matActual + pkgActual + laborRial + (oh.amount_rial || 0) + sumSubcontract(db, orderId);
    const costPerStarted = qtyStarted > 0 ? wipTotal / qtyStarted : 0;

    let abnormalRial = 0;
    if (wA > 0) {
      abnormalRial = Math.round(costPerStarted * wA);
      let docNo = '';
      try { docNo = allocateNumber(db, 'production_waste', 'WS'); }
      catch { docNo = `WS-${Date.now()}`; }
      const wasteId = db.prepare(`
        INSERT INTO production_waste
          (doc_no, order_id, cost_center_id, product_id, waste_type, qty, allowed_qty,
           unit_cost_rial, amount_rial, reason_code, reason_note, date, period_label, status, created_by)
        VALUES (?,?,?,?,'abnormal',?,?,?,?,?,?,?,?,'posted',?)
      `).run(
        docNo, orderId, po.cost_center_id, po.product_id,
        wA, allowed, Math.round(costPerStarted), abnormalRial,
        body.waste_abnormal_reason || 'other',
        autoReclass ? `شامل ${autoReclass} مازاد سقف` : '',
        date, period, userId
      ).lastInsertRowid;
      const je4 = postEvent(db, {
        event: 'PRD-09', sourceId: wasteId, date,
        description: `ضایعات غیرعادی ${wA} — ${po.order_no}`, createdBy: userId,
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
          (doc_no, order_id, cost_center_id, product_id, waste_type, qty, allowed_qty,
           date, period_label, status, created_by)
        VALUES (?,?,?,?,'normal',?,?,?,?,'posted',?)
      `).run(docNo, orderId, po.cost_center_id, po.product_id, wN, allowed, date, period, userId);
    }

    let scrapCredit = 0;
    const scrapWh = whSetting(db, 'production_wh_scrap_id');
    for (const s of (body.scrap || [])) {
      const amt = Math.round(num(s.qty) * num(s.nrv_unit_rial));
      scrapCredit += amt;
      receiveScrap(db, {
        productId: s.product_id, qty: s.qty, unitRial: s.nrv_unit_rial,
        warehouseId: scrapWh, userId, orderId, date, period,
      });
    }
    if (scrapCredit) {
      const je5 = postEvent(db, {
        event: 'PRD-10', sourceId: orderId, date,
        description: `ضایعات قابل فروش — ${po.order_no}`, createdBy: userId,
        lines: [
          dr(db, 'coa_scrap_inventory', scrapCredit),
          cr(db, 'coa_wip', scrapCredit, po.coa_wip_tafsili),
        ],
      });
      if (je5) jes.push(je5);
    }

    const wipNet = wipTotal - abnormalRial - scrapCredit;
    if (wipNet < 0) throw err('E_NEGATIVE_WIP', 500);

    let unitCost = 0, receiptId = null;
    if (qtyGood > 0) {
      unitCost = Math.round(wipNet / qtyGood);
      const avg = updateMovingAverage(db, {
        productId: po.product_id, warehouseId: po.warehouse_fg_id,
        qtyIn: qtyGood, amountRial: wipNet, userId, note: `تولید ${po.order_no}`,
      });
      let docNo = '';
      try { docNo = allocateNumber(db, 'production_receipt', 'PR'); }
      catch { docNo = `PR-${Date.now()}`; }
      receiptId = db.prepare(`
        INSERT INTO production_receipts
          (doc_no, order_id, product_id, output_type, qty, unit_cost_rial, amount_rial,
           warehouse_id, is_partial, prev_avg_rial, prev_stock_qty, new_avg_rial,
           date, period_label, status, created_by)
        VALUES (?,?,?,'main',?,?,?,?,?,?,?,?,?,?,'posted',?)
      `).run(
        docNo, orderId, po.product_id, qtyGood, unitCost, wipNet, po.warehouse_fg_id,
        body.is_partial ? 1 : 0, avg.prev_avg, avg.prev_qty, avg.new_avg, date, period, userId
      ).lastInsertRowid;

      const je6 = postEvent(db, {
        event: 'PRD-07', sourceId: receiptId, date,
        description: `رسید تولید ${qtyGood} — ${po.order_no}`, createdBy: userId,
        lines: [
          dr(db, 'coa_finished_goods', wipNet),
          cr(db, 'coa_wip', wipNet, po.coa_wip_tafsili),
        ],
      });
      if (je6) {
        jes.push(je6);
        db.prepare('UPDATE production_receipts SET je_id=? WHERE id=?').run(je6.je_id, receiptId);
      }
    }

    db.prepare(`
      UPDATE production_orders SET
        qty_produced = qty_produced + ?,
        qty_waste_normal = qty_waste_normal + ?,
        qty_waste_abnormal = qty_waste_abnormal + ?,
        labor_cost_rial = labor_cost_rial + ?,
        overhead_cost_rial = overhead_cost_rial + ?,
        abnormal_waste_rial = abnormal_waste_rial + ?,
        scrap_credit_rial = scrap_credit_rial + ?,
        total_cost_rial = ?,
        unit_cost_rial = ?,
        status = ?,
        actual_end = ?,
        period_label = ?,
        updated_at = strftime('%s','now')
      WHERE id=?
    `).run(
      qtyGood, wN, wA, laborRial, oh.amount_rial || 0,
      abnormalRial, scrapCredit, wipNet, unitCost,
      body.is_partial ? 'in_progress' : 'completed', date, period, orderId
    );

    if (qtyGood > 0 && unitCost > 0) {
      try {
        const { applyPricingFromCost } = require('../../routes/pricing-rules');
        applyPricingFromCost(db, po.product_id, unitCost);
      } catch (e) { console.warn('pricing_rules:', e.message); }
    }

    return {
      ok: true,
      receipt_id: receiptId,
      qty_started: qtyStarted,
      qty_produced: qtyGood,
      costs: {
        material_rial: matActual,
        packaging_rial: pkgActual,
        labor_rial: laborRial,
        overhead_rial: oh.amount_rial || 0,
        wip_total_rial: wipTotal,
        abnormal_waste_rial: abnormalRial,
        scrap_credit_rial: scrapCredit,
        net_rial: wipNet,
        unit_cost_rial: unitCost,
      },
      journal_entries: jes,
      wip_residual_rial: wipResidual(db, orderId),
    };
  })();
}

function listOrders(db, { status, productId, period, page = 1, limit = 50 } = {}) {
  const where = ['1=1'];
  const params = [];
  if (status) { where.push('status=?'); params.push(status); }
  if (productId) { where.push('product_id=?'); params.push(productId); }
  if (period) { where.push('period_label=?'); params.push(period); }
  const lim = Math.min(Number(limit) || 50, 200);
  const off = (Math.max(Number(page) || 1, 1) - 1) * lim;
  const rows = db.prepare(`
    SELECT po.*, p.name AS product_name
    FROM production_orders po
    LEFT JOIN products p ON p.id = po.product_id
    WHERE ${where.join(' AND ')}
    ORDER BY po.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, lim, off);
  const total = db.prepare(`
    SELECT COUNT(*) c FROM production_orders WHERE ${where.join(' AND ')}
  `).get(...params).c;
  return { rows, total, page: Number(page) || 1, limit: lim };
}

function getOrderDetail(db, orderId) {
  const po = getOrder(db, orderId);
  return {
    ...po,
    issues: db.prepare('SELECT * FROM production_material_issues WHERE order_id=?').all(orderId),
    labor: db.prepare('SELECT * FROM production_labor_entries WHERE order_id=?').all(orderId),
    overhead: db.prepare('SELECT * FROM production_overhead_applications WHERE order_id=?').all(orderId),
    waste: db.prepare('SELECT * FROM production_waste WHERE order_id=?').all(orderId),
    receipts: db.prepare('SELECT * FROM production_receipts WHERE order_id=?').all(orderId),
    reservations: db.prepare('SELECT * FROM production_reservations WHERE order_id=?').all(orderId),
    wip_residual_rial: wipResidual(db, orderId),
  };
}

function listIssues(db, orderId) {
  getOrder(db, orderId);
  return db.prepare(`
    SELECT mi.*, p.name AS product_name
    FROM production_material_issues mi
    LEFT JOIN products p ON p.id = mi.product_id
    WHERE mi.order_id=?
    ORDER BY mi.id
  `).all(orderId);
}

/** Dry-run material issue — same math, no stock/JE writes. */
function previewMaterialIssue(db, { orderId, body }) {
  const po = getOrder(db, orderId);
  if (po.analysis_type !== 'variable') throw err('E_WRONG_ANALYSIS', 409);
  const qtyStarted = num(body?.qty_started) || num(po.qty_planned);
  const threshold = varianceReasonThreshold(db);
  const materials = body?.materials || body?.lines || [];
  if (!materials.length) throw err('E_QTY_INVALID', 422);
  const { std } = standardMapFromBom(db, po, qtyStarted);
  const warnings = [];
  const out = [];
  let matRial = 0; let pkgRial = 0; let varP = 0; let varQ = 0;

  for (const L of materials) {
    const AQ = num(L.qty_actual != null ? L.qty_actual : L.qty);
    const prod = db.prepare('SELECT * FROM products WHERE id=?').get(L.product_id);
    if (!prod) throw err('E_NOT_FOUND', 404, { productId: L.product_id });
    const s = std[L.product_id] || (L.substitute_of_product_id ? std[L.substitute_of_product_id] : null);
    const SQ = s?.qty ?? 0;
    let SP = s?.price ?? 0;
    const AP = Math.round(Number(prod.average_cost_rial) || 0);
    if (!SP) {
      SP = AP;
      warnings.push(`نرخ استاندارد «${prod.name}» تعریف نشده — از نرخ واقعی استفاده شد`);
    }
    if (!s) {
      warnings.push({
        code: 'W_ITEM_NOT_IN_BOM',
        product_id: L.product_id,
        message: `«${prod.name}» در فرمول نیست — کل مصرف انحراف محسوب می‌شود`,
      });
    }
    let unitCost = AP;
    if (AQ < 0) {
      const orig = db.prepare(`
        SELECT unit_cost_rial, COALESCE(SUM(qty_actual),0) tot
        FROM production_material_issues
        WHERE order_id=? AND product_id=? AND status='posted'
      `).get(orderId, L.product_id);
      if (!orig || orig.tot <= 0) throw err('E_RETURN_WITHOUT_ISSUE', 422, { name: prod.name });
      if (Math.abs(AQ) > orig.tot + 1e-9) {
        throw err('E_RETURN_EXCEEDS_ISSUE', 422, { r: Math.abs(AQ), i: orig.tot });
      }
      unitCost = Math.round(Number(orig.unit_cost_rial) || AP);
    }
    const v = computeVariance({ AQ, SQ, AP: unitCost, SP });
    const amount = Math.round(AQ * unitCost);
    const kind = s?.kind || (prod.item_type === 'packaging' ? 'packaging' : 'material');
    if (kind === 'packaging') pkgRial += amount; else matRial += amount;
    varP += v.varPrice;
    varQ += v.varQty;
    out.push({
      product_id: L.product_id, name: prod.name,
      qty_standard: SQ, qty_actual: AQ, qty_variance: v.qty_variance,
      std_cost_rial: SP, unit_cost_rial: unitCost,
      std_amount_rial: Math.round(SQ * SP), amount_rial: amount,
      var_price_rial: v.varPrice, var_qty_rial: v.varQty,
      var_total_rial: v.varTotal, pct: v.pct,
      needs_reason: Math.abs(v.pct) > threshold && AQ > 0,
    });
  }

  return {
    ok: true,
    preview: true,
    order_id: orderId,
    qty_started: qtyStarted,
    threshold_pct: threshold,
    lines: out,
    totals: {
      material_rial: matRial,
      packaging_rial: pkgRial,
      total_rial: matRial + pkgRial,
      std_total_rial: out.reduce((s, l) => s + l.std_amount_rial, 0),
      var_price_rial: varP,
      var_qty_rial: varQ,
      var_total_rial: varP + varQ,
    },
    warnings,
    note: 'پیش‌نمایش — بدون ثبت انبار/سند (ADR-011)',
  };
}

function postMaterialReturn(db, { orderId, body, userId }) {
  const materials = (body?.materials || body?.lines || []).map((L) => {
    const q = num(L.qty_actual != null ? L.qty_actual : L.qty);
    return { ...L, qty_actual: q > 0 ? -q : q };
  });
  if (!materials.length) throw err('E_QTY_INVALID', 422);
  return issueMaterialsVariable(db, {
    orderId,
    body: { ...body, materials, lines: materials },
    userId,
  });
}

/**
 * Update order fields. Changing analysis_type after posted issues → E_ANALYSIS_LOCKED.
 */
function updateOrder(db, orderId, body = {}) {
  const po = getOrder(db, orderId);
  if (body.analysis_type != null && String(body.analysis_type) !== String(po.analysis_type)) {
    const hasIssue = db.prepare(`
      SELECT 1 FROM production_material_issues
      WHERE order_id=? AND status='posted' LIMIT 1
    `).get(orderId);
    if (hasIssue) throw err('E_ANALYSIS_LOCKED', 409);
  }
  const fields = [];
  const params = [];
  const allow = {
    analysis_type: 'analysis_type',
    note: 'note',
    priority: 'priority',
    warehouse_raw_id: 'warehouse_raw_id',
    warehouse_fg_id: 'warehouse_fg_id',
    cost_center_id: 'cost_center_id',
  };
  for (const [k, col] of Object.entries(allow)) {
    if (body[k] !== undefined) {
      fields.push(`${col}=?`);
      params.push(body[k]);
    }
  }
  if (!fields.length) return getOrderDetail(db, orderId);
  params.push(orderId);
  db.prepare(`
    UPDATE production_orders SET ${fields.join(', ')}, updated_at=strftime('%s','now') WHERE id=?
  `).run(...params);
  return getOrderDetail(db, orderId);
}

module.exports = {
  createOrder,
  releaseOrder,
  cancelOrder,
  closeOrder,
  reopenOrder,
  postReceiptFixed,
  previewReceiptFixed,
  postReceiptVariable,
  issueMaterialsVariable,
  issueTemplate,
  previewMaterialIssue,
  postMaterialReturn,
  updateOrder,
  listIssues,
  reverseOrder,
  wipResidual,
  listOrders,
  getOrderDetail,
  jalaliPeriod,
  ledgerBalance,
  checkCostDeviation,
  varianceAnalysis,
  checkBomRevisionSuggestion,
  recomputeOrderTotals: (db, orderId) => wipResidual(db, orderId),
};
