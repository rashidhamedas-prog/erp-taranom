'use strict';
/**
 * Production Module 2 — Fixed analysis engine
 */
const { allocateNumber, audit } = require('../../db');
const { jeNotDraftFor } = require('../je-live');
const { todayJalali } = require('../../jalali');
const { assertFiscalYearWritable } = require('../fiscal-period');
const { acct } = require('../coa-map');
const {
  explodeBom, resolveBom, isMultiproductBom, assertProductInBomFg,
  explodeProductScopeForOrder, planBomFgOutputs, orderQtyAsMainBase,
  explodeQtyForOrder, orderFgPlanRows, parseFgPlanJson, orderBomPeerLines,
} = require('./bom');
const { dr, cr, plug, postEvent, reverseEvent, err } = require('./posting');
const {
  issueFromStock, updateMovingAverage, receiveScrap, reverseIssueStock, reverseReceiptStock,
  recalcAvgOnReturn, setting, getWhQty,
} = require('./costing');
const { applyOverhead, reverseAppliedOverheadCounters, postPlantOverhead } = require('./overhead');
const {
  sumLabor,
  autoPostLabor,
  absorbLaborJournal,
  retirePersonLaborForEntries,
  formatLaborJeDescription,
  productLabelForOrder,
} = require('./labor');
const { classifyWaste, normalWastePct } = require('./waste');
const {
  previewOrderCostReconcile,
  applyDocumentCosts,
} = require('./order-cost-reconcile');
const {
  assertFabricIssueAllowed,
  fabricIssueAllowance,
  assertNoOrphanSellablePack,
  assertFabricCuttingPathForFgReceipt,
  fabricCuttingGateInfo,
  relieveStagedPackQty,
} = require('./cutting');
const variance = require('./variance');
const {
  computeVariance, insertVarianceMemo, varianceReasonThreshold, varianceAnalysis,
  checkBomRevisionSuggestion, standardMapFromBom, round6,
} = variance;

function num(v) { return Number(v) || 0; }

/** When cumulative produced reaches plan, complete even if UI left is_partial on. */
function resolveReceiptOrderStatus(po, body, qtyGood) {
  const nextProduced = num(po.qty_produced) + num(qtyGood);
  const planned = num(po.qty_planned);
  if (planned > 0 && nextProduced + 1e-9 >= planned) return 'completed';
  if (body && body.is_partial) return 'in_progress';
  return 'completed';
}

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

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

/**
 * PA-11 — a BOM allowlist row constrains only the columns it fills in, so a
 * color-only row allows every size of that color. Empty list = legacy, no
 * structured restriction at all.
 */
function assertMatrixInBomScope(db, bomId, lines) {
  if (!bomId || !tableExists(db, 'bom_allowed_variants')) return;
  const allowed = db.prepare(`
    SELECT color_id, size_id, variant_id FROM bom_allowed_variants
    WHERE bom_id=? AND COALESCE(is_allowed,1)=1
  `).all(bomId);
  if (!allowed.length) return;
  const same = (a, b) => a == null || Number(a) === Number(b);
  for (const ln of lines) {
    const hit = allowed.some(a => (
      (a.variant_id == null || (ln.variant_id != null && Number(a.variant_id) === Number(ln.variant_id)))
      && same(a.color_id, ln.color_id)
      && same(a.size_id, ln.size_id)
    ));
    if (!hit) {
      throw err('E_VARIANT_NOT_ALLOWED', 422, {
        color_id: ln.color_id, size_id: ln.size_id, variant_id: ln.variant_id, bom_id: bomId,
      });
    }
  }
}

/**
 * PA-11 — fill in variant/color/size ids from each other and refuse cells the
 * UI must never offer (foreign product, inactive SKU, outside the BOM domain).
 * A hand-made payload goes through exactly the same gate as the grid.
 */
function resolveMatrixLines(db, { productId, bomId, lines }) {
  const out = [];
  const hasVariants = tableExists(db, 'product_variants');
  const byId = hasVariants ? db.prepare(`
    SELECT id, product_id, color_id, size_id, COALESCE(active,1) AS active
    FROM product_variants WHERE id=?
  `) : null;
  const byCell = hasVariants ? db.prepare(`
    SELECT id, COALESCE(active,1) AS active FROM product_variants
    WHERE product_id=? AND color_id=? AND size_id=?
    ORDER BY COALESCE(active,1) DESC, id LIMIT 1
  `) : null;
  for (const ln of lines) {
    let variantId = ln.variant_id || null;
    let colorId = ln.color_id || null;
    let sizeId = ln.size_id || null;
    if (variantId && byId) {
      const v = byId.get(variantId);
      if (!v || Number(v.product_id) !== Number(productId)) {
        throw err('E_VARIANT_PRODUCT_MISMATCH', 422, { variant_id: variantId, product_id: productId });
      }
      if (!Number(v.active)) throw err('E_VARIANT_INACTIVE', 422, { variant_id: variantId });
      colorId = colorId || v.color_id || null;
      sizeId = sizeId || v.size_id || null;
    } else if (!variantId && colorId && sizeId && byCell) {
      const v = byCell.get(productId, colorId, sizeId);
      if (v && !Number(v.active)) {
        throw err('E_VARIANT_INACTIVE', 422, { color_id: colorId, size_id: sizeId });
      }
      variantId = v?.id || null;
    }
    out.push({ variant_id: variantId, color_id: colorId, size_id: sizeId, qty: ln.qty });
  }
  assertMatrixInBomScope(db, bomId, out);
  return out;
}

/** ux_pol_variant is a unique index — collapse the clash into a readable 422. */
function assertMatrixCellsUnique(lines) {
  const seen = new Set();
  for (const ln of lines) {
    const k = `${ln.product_id ?? ''}|${ln.variant_id ?? ''}|${ln.color_id ?? ''}|${ln.size_id ?? ''}`;
    if (seen.has(k)) throw err('E_MATRIX_DUPLICATE', 422, { cell: k });
    seen.add(k);
  }
}

function normalizeMatrixPayload(body) {
  const raw = Array.isArray(body.matrix_lines) ? body.matrix_lines
    : (Array.isArray(body.lines) ? body.lines : null);
  if (!raw) return null;
  return raw.map(ln => ({
    product_id: ln.product_id != null ? Number(ln.product_id) : null,
    variant_id: ln.variant_id != null ? Number(ln.variant_id) : null,
    color_id: ln.color_id != null ? Number(ln.color_id) : null,
    size_id: ln.size_id != null ? Number(ln.size_id) : null,
    qty: num(ln.qty_planned != null ? ln.qty_planned : ln.qty),
  })).filter(ln => ln.qty > 0);
}

/** Each product's color×size grid is resolved against that product, not the order header. */
function resolveMatrixGroups(db, { fallbackProductId, bomId, lines, bomByProduct }) {
  const groups = new Map();
  for (const ln of lines) {
    const pid = Number(ln.product_id) || Number(fallbackProductId);
    if (!groups.has(pid)) groups.set(pid, []);
    groups.get(pid).push(ln);
  }
  const out = [];
  for (const [pid, part] of groups) {
    const scopedBom = bomByProduct && bomByProduct[pid] ? bomByProduct[pid] : bomId;
    for (const ln of resolveMatrixLines(db, { productId: pid, bomId: scopedBom, lines: part })) {
      out.push({ ...ln, product_id: pid });
    }
  }
  return out;
}

function fgPlanJson(map) {
  return JSON.stringify(Object.keys(map || {}).map(pid => ({
    product_id: Number(pid),
    qty: map[pid],
  })));
}

/** Order color×size rows with display names, for the order matrix grid. */
function listOrderLines(db, orderId) {
  if (!tableExists(db, 'production_order_lines')) return [];
  try {
    return db.prepare(`
      SELECT l.*, c.name AS color_name, s.name AS size_name, v.sku AS variant_sku
      FROM production_order_lines l
      LEFT JOIN product_colors c ON c.id = l.color_id
      LEFT JOIN product_sizes s ON s.id = l.size_id
      LEFT JOIN product_variants v ON v.id = l.variant_id
      WHERE l.order_id=?
      ORDER BY COALESCE(c.sort_order,0), COALESCE(s.sort_order,0), l.id
    `).all(orderId);
  } catch (_) {
    return db.prepare('SELECT * FROM production_order_lines WHERE order_id=? ORDER BY id').all(orderId);
  }
}

function bomHasRouting(db, bomId) {
  if (!bomId) return false;
  const bom = db.prepare('SELECT has_routing FROM bom_headers WHERE id=?').get(bomId);
  const opCount = db.prepare('SELECT COUNT(*) AS c FROM bom_operations WHERE bom_id=?').get(bomId)?.c || 0;
  return !!(bom?.has_routing || opCount > 0);
}

/** محصولات اضافهٔ سفارش، هر کدام با فرمول تک‌محصولی خودش. */
function collectOrderPeerLines(db, { productId, bom, qtyPlanned, date, body }) {
  const extra = Array.isArray(body.order_products) ? body.order_products : [];
  const lines = [];
  const seen = new Set([Number(productId)]);
  for (const raw of extra) {
    const pid = Number(raw?.product_id);
    const qty = Number(raw?.qty);
    if (!pid || pid === Number(productId)) continue;
    if (seen.has(pid)) throw err('E_ORDER_PRODUCT_DUP', 422, { product_id: pid });
    seen.add(pid);
    if (!(qty > 0)) throw err('E_QTY_INVALID', 422, { product_id: pid });
    const product = db.prepare('SELECT id, name, is_manufactured FROM products WHERE id=?').get(pid);
    if (!product) throw err('E_NOT_FOUND', 404, { product_id: pid });
    if (!product.is_manufactured) throw err('E_NOT_MANUFACTURED', 422, { name: product.name });
    const { assertProductReady } = require('./product-completeness');
    assertProductReady(db, pid, 'order');
    const peerBom = resolveBom(db, {
      productId: pid,
      date,
      preferredBomId: raw.bom_id ? Number(raw.bom_id) : null,
    });
    if (isMultiproductBom(db, peerBom)) {
      throw err('E_BOM_SINGLE_PRODUCT', 422, { bom_id: peerBom.id });
    }
    assertProductInBomFg(db, peerBom, pid);
    lines.push({ product_id: pid, qty, bom_id: peerBom.id });
  }
  if (!lines.length) return null;
  if (isMultiproductBom(db, bom)) {
    throw err('E_ORDER_MIXED_BOM', 422, {
      detail: 'فرمول چندمحصولی قدیمی با محصولِ فرمول‌جدا در یک سفارش جمع نمی‌شود',
    });
  }
  return [{ product_id: Number(productId), qty: qtyPlanned, bom_id: bom.id }, ...lines];
}

function createOrder(db, body, userId) {
  const productId = Number(body.product_id);
  let qtyPlanned = num(body.qty_planned);
  if (!productId) throw err('E_QTY_INVALID', 422);
  const date = body.date || todayJalali();
  const period = body.period_label || jalaliPeriod(date);
  let analysisType = body.analysis_type
    || setting(db, 'production_default_analysis', 'fixed')
    || 'fixed';

  const product = db.prepare('SELECT id, name, is_manufactured FROM products WHERE id=?').get(productId);
  if (!product) throw err('E_NOT_FOUND', 404);
  if (!product.is_manufactured) {
    throw err('E_NOT_MANUFACTURED', 422, { name: product.name });
  }

  // v421/v422 — essential product specs before production order
  const { assertProductReady } = require('./product-completeness');
  assertProductReady(db, productId, 'order');

  const fy = assertFiscalYearWritable(db, date);
  if (!fy.ok) throw err('E_PERIOD_CLOSED', 409, { detail: fy.error });
  assertPeriodOpen(db, period);

  const bom = resolveBom(db, {
    productId,
    date,
    preferredBomId: body.bom_id ? Number(body.bom_id) : null,
  });

  // BOM با مسیر عملیات ⇒ سفارش باید پیشرفته باشد تا مراحل/حواله/JE مرحله‌ای اعمال شود
  const opCount = db.prepare(
    'SELECT COUNT(*) AS c FROM bom_operations WHERE bom_id=?'
  ).get(bom.id)?.c || 0;
  const hasRouting = !!(bom.has_routing || opCount > 0);
  const multiBom = isMultiproductBom(db, bom);
  // چندمحصولی: فقط مسیر پیشرفته (تسهیم رسید main/co در finalize)
  if (multiBom && !['fixed_adv', 'variable_adv'].includes(analysisType)) {
    analysisType = analysisType === 'variable' ? 'variable_adv' : 'fixed_adv';
  } else if (hasRouting && !['fixed_adv', 'variable_adv'].includes(analysisType)) {
    analysisType = analysisType === 'variable' ? 'variable_adv' : 'fixed_adv';
  }
  assertProductInBomFg(db, bom, productId);

  const whRaw = body.warehouse_raw_id || whSetting(db, 'production_wh_raw_id');
  const whFg = body.warehouse_fg_id || whSetting(db, 'production_wh_fg_id');
  let ccId = body.cost_center_id || null;
  if (!ccId) {
    const cc = db.prepare("SELECT id FROM cost_centers WHERE code='CC-30'").get();
    ccId = cc?.id || null;
  }

  const sizeBdObj = body.size_breakdown
    ? (typeof body.size_breakdown === 'string' ? safeJson(body.size_breakdown) : body.size_breakdown)
    : null;
  const sizeBd = sizeBdObj ? JSON.stringify(sizeBdObj) : '';
  const color = String(body.color || '').trim();

  // PA-04 — explicit color×size order matrix. On a joint run each product has its own grid.
  const peerBomByProduct = {};
  if (Array.isArray(body.order_products)) {
    for (const raw of body.order_products) {
      const pid = Number(raw?.product_id);
      if (!pid || pid === Number(productId)) continue;
      const peerBom = resolveBom(db, {
        productId: pid,
        date,
        preferredBomId: raw.bom_id ? Number(raw.bom_id) : null,
      });
      peerBomByProduct[pid] = peerBom.id;
      raw.bom_id = peerBom.id;
    }
  }
  let matrixLines = normalizeMatrixPayload(body);
  if (matrixLines && matrixLines.length) {
    matrixLines = resolveMatrixGroups(db, {
      fallbackProductId: productId, bomId: bom.id, lines: matrixLines, bomByProduct: peerBomByProduct,
    });
    assertMatrixCellsUnique(matrixLines);
  }
  const linesFor = (pid) => (matrixLines || []).filter(ln => Number(ln.product_id || productId) === Number(pid));
  const sumOf = (rows) => rows.reduce((s, ln) => s + ln.qty, 0);

  const { hasActiveMatrixVariants } = require('../inventory/qty-policy');
  if (hasActiveMatrixVariants(db, productId)) {
    const mine = linesFor(productId);
    const matrixCovers = mine.length
      && mine.every(ln => ln.variant_id || (ln.color_id && ln.size_id));
    if (!matrixCovers && (!color || !sizeBdObj || typeof sizeBdObj !== 'object')) {
      throw err('E_VARIANT_REQUIRED', 400, {
        detail: 'برای کالای ماتریسی رنگ و تفکیک تعداد per سایز (یا سطرهای ماتریس) الزامی است',
      });
    }
    if (!matrixCovers) {
      const sum = Object.values(sizeBdObj).reduce((acc, v) => acc + (Number(v) || 0), 0);
      if (sum <= 0) throw err('E_QTY_INVALID', 422);
      if (qtyPlanned > 0 && Math.abs(sum - qtyPlanned) > 0.001) {
        throw err('E_VARIANT_QTY', 400, { sum, qty_planned: qtyPlanned });
      }
      qtyPlanned = sum;
    }
  }
  // The header quantity is the selected product only. Other products do not add into it.
  const orderMatrixQty = sumOf(linesFor(productId));
  if (linesFor(productId).length) {
    if (qtyPlanned > 0 && Math.abs(orderMatrixQty - qtyPlanned) > 0.001) {
      throw err('E_VARIANT_QTY', 400, { sum: orderMatrixQty, qty_planned: qtyPlanned });
    }
    qtyPlanned = orderMatrixQty;
  }
  if (qtyPlanned <= 0) throw err('E_QTY_INVALID', 422);

  const peerStored = collectOrderPeerLines(db, {
    productId, bom, qtyPlanned, date, body,
  });
  if (peerStored) {
    for (const line of peerStored) {
      if (Number(line.product_id) === Number(productId)) continue;
      const mine = linesFor(line.product_id);
      if (mine.length) line.qty = sumOf(mine);
      else if (hasActiveMatrixVariants(db, line.product_id)) {
        throw err('E_VARIANT_REQUIRED', 400, {
          product_id: line.product_id,
          detail: 'برای محصول اضافه‌شده هم رنگ و سایز لازم است',
        });
      }
    }
    const routed = peerStored.some((line) => bomHasRouting(db, line.bom_id));
    if (routed && !['fixed_adv', 'variable_adv'].includes(analysisType)) {
      analysisType = analysisType === 'variable' ? 'variable_adv' : 'fixed_adv';
    }
  }

  let fgMap = null;
  if (multiBom) {
    const formula = planBomFgOutputs(db, bom.id, qtyPlanned, productId);
    fgMap = {};
    for (const p of formula) fgMap[p.product_id] = Number(p.qty_planned) || 0;
    const sent = parseFgPlanJson(body.fg_plan);
    if (sent) {
      for (const p of formula) {
        if (sent[p.product_id] != null && Number(p.product_id) !== productId) {
          fgMap[p.product_id] = sent[p.product_id];
        }
      }
    }
    fgMap[productId] = qtyPlanned;
    for (const p of formula) {
      const mine = linesFor(p.product_id);
      if (mine.length) fgMap[p.product_id] = sumOf(mine);
    }
    fgMap[productId] = linesFor(productId).length ? orderMatrixQty : qtyPlanned;
    for (const p of formula) {
      if (!(Number(fgMap[p.product_id]) > 0)) {
        throw err('E_QTY_INVALID', 422, {
          product_id: p.product_id,
          detail: 'تعداد هر محصول اصلی باید بزرگ‌تر از صفر باشد',
        });
      }
      if (hasActiveMatrixVariants(db, p.product_id) && !linesFor(p.product_id).length) {
        throw err('E_VARIANT_REQUIRED', 400, {
          product_id: p.product_id,
          detail: 'برای هر محصول ماتریسی این اجرای مشترک، رنگ و سایز جدا لازم است',
        });
      }
    }
  }

  const qtyExplode = multiBom
    ? orderQtyAsMainBase(db, bom.id, qtyPlanned, productId)
    : qtyPlanned;

  let stdMat = 0, stdLab = 0, stdOh = 0;
  try {
    const ex = explodeBom(db, {
      bomId: bom.id, qty: qtyExplode, priceBasis: 'std',
      sizeBreakdown: sizeBdObj, color,
      forProductId: multiBom ? null : productId,
      qtyByProduct: fgMap,
    });
    stdMat = ex.totals.total_rial;
  } catch { /* ignore */ }

  let orderNo;
  try {
    orderNo = allocateNumber(db, 'production_order', 'PO');
  } catch {
    orderNo = `PO-${Date.now()}`;
  }

  // Old DBs that have not run the PA-04 migration yet simply skip the matrix lines.
  const hasLineTable = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='production_order_lines'"
  ).get();

  const id = db.transaction(() => {
    const orderId = db.prepare(`
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
      qtyPlanned, sizeBd, color,
      whRaw, whFg, ccId,
      date, period, fy.fiscalYearId || null,
      stdMat, stdLab, stdOh, stdMat + stdLab + stdOh,
      qtyPlanned > 0 ? Math.round((stdMat + stdLab + stdOh) / qtyPlanned) : 0,
      body.note || '', userId
    ).lastInsertRowid;
    if (peerStored) {
      try {
        db.prepare('UPDATE production_orders SET fg_plan_json=? WHERE id=?')
          .run(JSON.stringify(peerStored), orderId);
      } catch { /* column missing before v460 ensureColumn */ }
    } else if (fgMap) {
      try {
        db.prepare('UPDATE production_orders SET fg_plan_json=? WHERE id=?')
          .run(fgPlanJson(fgMap), orderId);
      } catch { /* column missing before v460 ensureColumn */ }
    }
    if (body.manual_driver_qty != null && body.manual_driver_qty !== '') {
      try {
        db.prepare('UPDATE production_orders SET manual_driver_qty=? WHERE id=?')
          .run(Number(body.manual_driver_qty) || 0, orderId);
      } catch { /* column missing on very old DBs before ensureColumn */ }
    }
    const waiveReason = String(body.completeness_waive_reason || '').trim();
    if (waiveReason) {
      try {
        db.prepare('UPDATE production_orders SET completeness_waive_reason=? WHERE id=?')
          .run(waiveReason.slice(0, 500), orderId);
        audit(userId, 'update', 'production_order', orderId,
          `waive مشخصات ضروری: ${waiveReason.slice(0, 120)}`);
      } catch { /* column missing before v422 ensureColumn */ }
    }
    if (!hasLineTable) return orderId;

    // PA-04: persist color×size order lines when provided (or derive from size_breakdown + color)
    const insLine = db.prepare(`
      INSERT INTO production_order_lines
        (order_id, product_id, variant_id, color_id, size_id, qty_planned, bom_snapshot_ref)
      VALUES (?,?,?,?,?,?,?)
    `);
    let lineCount = 0;
    if (matrixLines && matrixLines.length) {
      for (const ln of matrixLines) {
        const lineBom = (peerStored || []).find((p) => Number(p.product_id) === Number(ln.product_id || productId));
        insLine.run(orderId, ln.product_id || productId, ln.variant_id, ln.color_id, ln.size_id, ln.qty, String(lineBom?.bom_id || bom.id));
        lineCount++;
      }
    } else if (sizeBdObj && color) {
      // Derive lines from single color + size_breakdown labels when possible
      const colorRow = db.prepare(`
        SELECT id FROM product_colors WHERE name=? OR id=? LIMIT 1
      `).get(color, Number(color) || -1);
      const colorId = colorRow?.id || null;
      const seenCell = new Set();
      for (const [szName, qRaw] of Object.entries(sizeBdObj)) {
        const q = num(qRaw);
        if (q <= 0) continue;
        const sizeRow = db.prepare(`
          SELECT ps.id FROM product_sizes ps
          LEFT JOIN product_style_sizes pss ON pss.size_id = ps.id AND pss.product_id=?
          WHERE ps.name=? OR ps.id=?
          LIMIT 1
        `).get(productId, szName, Number(szName) || -1);
        let variantId = null;
        if (colorId && sizeRow) {
          variantId = db.prepare(`
            SELECT id FROM product_variants
            WHERE product_id=? AND color_id=? AND size_id=? AND COALESCE(active,1)=1 LIMIT 1
          `).get(productId, colorId, sizeRow.id)?.id || null;
        }
        const cell = `${variantId ?? ''}|${colorId ?? ''}|${sizeRow?.id ?? ''}`;
        if (seenCell.has(cell)) continue;
        seenCell.add(cell);
        insLine.run(orderId, productId, variantId, colorId, sizeRow?.id || null, q, String(bom.id));
        lineCount++;
      }
    }
    if (lineCount) {
      db.prepare('UPDATE production_orders SET has_matrix_lines=1 WHERE id=?').run(orderId);
    }
    return orderId;
  })();

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
  // سفارش ساده روی BOM مسیر‌دار: ارتقا به پیشرفته قبل از آزادسازی
  if (po.bom_id) {
    const peerIds = (orderBomPeerLines(po) || []).map((p) => p.bom_id);
    const routed = bomHasRouting(db, po.bom_id) || peerIds.some((id) => bomHasRouting(db, id));
    if (routed) {
      const upgraded = po.analysis_type === 'variable' ? 'variable_adv' : 'fixed_adv';
      db.prepare(
        'UPDATE production_orders SET analysis_type=?, updated_at=strftime(\'%s\',\'now\') WHERE id=?'
      ).run(upgraded, orderId);
      const { releaseAdvancedOrder } = require('./engine-advanced');
      return releaseAdvancedOrder(db, orderId, userId);
    }
  }
  return db.transaction(() => {
    if (po.status !== 'draft') throw err('E_INVALID_STATUS', 409, { status: po.status });
    if (!po.bom_id) throw err('E_NO_ACTIVE_BOM', 422);
    require('./product-completeness').assertOrderReady(db, orderId, 'release');

    const peers = orderBomPeerLines(po);
    const explosions = peers
      ? peers.map((line) => explodeBom(db, {
        bomId: line.bom_id,
        qty: orderQtyAsMainBase(db, line.bom_id, line.qty_planned, line.product_id),
        priceBasis: 'average',
        forProductId: line.product_id,
      }))
      : [explodeBom(db, {
        bomId: po.bom_id,
        qty: explodeQtyForOrder(db, po),
        sizeBreakdown: safeJson(po.size_breakdown),
        color: po.color,
        priceBasis: 'average',
        forProductId: explodeProductScopeForOrder(db, po),
      })];

    for (const ex of explosions) {
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
  // اتلاف برش مشترک (بستانکار مواد) در ماندهٔ WIP نیست — order-cost-reconcile.
  try {
    return require('./order-cost-reconcile').wipResidualFromDocs(db, orderId);
  } catch (_) {
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
}

function closeOrder(db, orderId, userId) {
  return db.transaction(() => {
    const po = getOrder(db, orderId);
    if (po.status !== 'completed') {
      const fail = err('E_INVALID_STATUS', 409, { status: po.status });
      fail.message = `فقط سفارش تکمیل‌شده قابل بستن است (وضعیت فعلی: ${po.status || '—'})`;
      throw fail;
    }
    const residual = wipResidual(db, orderId);
    if (Math.abs(residual) > 5) {
      const fail = err('E_WIP_NOT_ZERO', 409, { residual: Math.round(residual) });
      fail.message = `مانده WIP صفر نیست (${Math.round(residual).toLocaleString('en-US')} ریال) — بهای سفارش با رسید هم‌خوان نیست. «اصلاح بها» ستون‌ها را با اسناد یکی می‌کند و در صورت نیاز رسید را با خالص WIP تطبیق می‌دهد (الگوی اختلاف‌بها).`;
      throw fail;
    }
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
    WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0 AND ${jeNotDraftFor(db)}
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
    // Status gate: only released / in_progress. Partial receipts keep status=in_progress
    // (is_partial→in_progress), so completed has no remaining qty path — reject it.
    if (po.status === 'draft') throw err('E_NOT_RELEASED', 409);
    if (po.status === 'completed') throw err('E_ALREADY_COMPLETED', 409);
    if (!['released', 'in_progress'].includes(po.status)) {
      throw err('E_INVALID_STATUS', 409, { status: po.status });
    }
    require('./product-completeness').assertOrderReady(db, orderId, 'finalize');

    const RDG = require('./receipt-date-guard');
    const date = String(body.date || RDG.defaultReceiptDate(db, orderId, po.date || todayJalali())).trim();
    RDG.assertReceiptNotBeforeLastActivity(db, orderId, date);
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
    if (String(setting(db, 'production_backflush_on_receipt', '1')) === '0') {
      throw err('E_BACKFLUSH_DISABLED', 422, {
        hint: 'برای رسید ثابت، Backflush را در تنظیمات حرفه‌ای تولید روشن کنید یا حوالهٔ قبلی ثبت کنید',
      });
    }
    const ex = explodeBom(db, {
      bomId: po.bom_id,
      qty: qtyStarted,
      sizeBreakdown: safeJson(po.size_breakdown),
      color: po.color,
      priceBasis: 'average',
      forProductId: explodeProductScopeForOrder(db, po),
    });

    let matRial = 0, pkgRial = 0;

    for (const L of ex.lines) {
      const prod = db.prepare('SELECT * FROM products WHERE id=?').get(L.product_id);
      if (!prod) throw err('E_NOT_FOUND', 404, { productId: L.product_id });
      const unitCost = Math.round(Number(prod.average_cost_rial) || 0);
      if (!unitCost) throw err('E_ZERO_AVG_COST', 422, { name: prod.name, product_id: prod.id });

      const amount = Math.round(L.qty_final * unitCost);
      assertFabricIssueAllowed(db, {
        productId: L.product_id,
        qty: L.qty_final,
        orderId,
      });
      const issued = issueFromStock(db, {
        productId: L.product_id,
        warehouseId: po.warehouse_raw_id,
        qty: L.qty_final,
        userId,
        note: `تولید ${po.order_no}`,
        variantId: L.variant_id,
        variantLines: L.variant_lines,
        sourceType: 'production_issue',
        sourceId: orderId,
        date,
      });

      let stdCost = 0;
      if (L.bom_line_id) {
        const bl = db.prepare('SELECT std_cost_rial FROM bom_lines WHERE id=?').get(L.bom_line_id);
        stdCost = Math.round(Number(bl?.std_cost_rial) || Number(prod.std_cost_rial) || 0);
      }

      let docNo = '';
      try { docNo = allocateNumber(db, 'material_issue', 'MI'); }
      catch { docNo = `MI-${Date.now()}`; }

      const issueInfo = db.prepare(`
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
      if (issued.variantLines && issued.variantLines.length) {
        require('../inventory/apparel-lines').postApparelLines(db, {
          productId: L.product_id, warehouseId: po.warehouse_raw_id,
          lines: issued.variantLines, docType: 'production_issue',
          docId: issueInfo.lastInsertRowid, userId,
          note: `تولید ${po.order_no}`, sign: -1, allowNegative: false,
        });
        require('../inventory/apparel-lines').saveDocVariantLines(
          db, 'production_material_issues', issueInfo.lastInsertRowid, issued.variantLines
        );
      }

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
      const freshLabs = db.prepare(`
        SELECT * FROM production_labor_entries
        WHERE order_id=? AND status='posted' AND je_id IS NULL
      `).all(orderId);
      const { productCode, productName } = productLabelForOrder(db, po);
      const laborJes = absorbLaborJournal(db, {
        orderId,
        date,
        userId,
        costCenterId: po.cost_center_id || null,
        wipTafsili: po.coa_wip_tafsili,
        entries: freshLabs,
        descriptionFallback: formatLaborJeDescription({
          orderNo: po.order_no, productCode, productName, qty: qtyStarted, amountRial: laborRial,
        }),
        postEvent, dr, cr,
      });
      for (const j of laborJes) jes.push(j);
    } else if (laborRial && !laborPostedNow) {
      // Already recorded earlier — include in WIP totals but don't re-post JE
      // Detect if any labor without je → post once
      const freshLabs = db.prepare(`
        SELECT * FROM production_labor_entries
        WHERE order_id=? AND status='posted' AND je_id IS NULL
      `).all(orderId);
      const unpaid = freshLabs.reduce((s, e) => s + Math.round(Number(e.amount_rial) || 0), 0);
      if (unpaid > 0) {
        const { productCode, productName } = productLabelForOrder(db, po);
        const laborJes = absorbLaborJournal(db, {
          orderId,
          date,
          userId,
          costCenterId: po.cost_center_id || null,
          wipTafsili: po.coa_wip_tafsili,
          entries: freshLabs,
          descriptionFallback: formatLaborJeDescription({
            orderNo: po.order_no, productCode, productName, qty: qtyStarted, amountRial: unpaid,
          }),
          postEvent, dr, cr,
        });
        for (const j of laborJes) jes.push(j);
        laborRial = unpaid; // only new portion for this receipt's WIP increment
      } else {
        laborRial = 0; // already in order totals from prior receipt
      }
    }

    // ═══ ۳. Overhead (PRD-05) ═══
    const oh = applyOverhead(db, {
      po, qtyStarted, laborRial, matRial, date, period, userId,
      machineMinutes: body.machine_minutes,
      laborHours: body.labor_hours,
      manualDriverQty: body.manual_driver_qty != null ? body.manual_driver_qty : po.manual_driver_qty,
    });
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
    const plant = postPlantOverhead(db, {
      po, qty: qtyGood, laborRial, matRial: matRial + pkgRial, date, period, userId,
    });
    for (const line of plant.lines) {
      const jeP = postEvent(db, {
        event: 'PRD-05', sourceId: orderId, date, createdBy: userId,
        description: `جذب سربار سراسری ${line.name} — ${po.order_no}`,
        costCenterId: line.cost_center_id,
        lines: [
          dr(db, 'coa_wip', line.amount_rial, po.coa_wip_tafsili),
          cr(db, 'coa_overhead_applied', line.amount_rial),
        ],
      });
      if (jeP) {
        jes.push(jeP);
        db.prepare('UPDATE production_overhead_applications SET je_id=? WHERE id=?').run(jeP.je_id, line.id);
      }
    }
    const ohRial = (oh.amount_rial || 0) + plant.amount_rial;

    // ═══ ۴. WIP total ═══
    const wipTotal = matRial + pkgRial + laborRial + ohRial + sumSubcontract(db, orderId);
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
        variantId: s.variant_id,
        variantLines: s.variant_lines,
        sizeBreakdown: s.size_breakdown,
        color: s.color || po.color,
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
      const fgLines = require('../inventory/apparel-lines').resolveApparelLines(db, {
        productId: po.product_id, qty: qtyGood,
        variantId: body.variant_id, variantLines: body.variant_lines,
        sizeBreakdown: body.size_breakdown || po.size_breakdown,
        color: body.color || po.color,
      });
      unitCost = Math.round(wipNet / qtyGood);
      assertFabricCuttingPathForFgReceipt(db, po, qtyGood);
      assertNoOrphanSellablePack(db, po.product_id, orderId);
      const avg = updateMovingAverage(db, {
        productId: po.product_id,
        warehouseId: po.warehouse_fg_id,
        qtyIn: qtyGood,
        amountRial: wipNet,
        userId,
        note: `تولید ${po.order_no}`,
        sourceType: 'production_receipt',
        sourceId: orderId,
        date,
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
      require('../inventory/apparel-lines').postApparelLines(db, {
        productId: po.product_id, warehouseId: po.warehouse_fg_id,
        lines: fgLines, docType: 'production_fg', docId: receiptId, userId,
        note: `رسید تولید ${po.order_no}`, sign: 1, allowNegative: true,
      });
      require('../inventory/apparel-lines').saveDocVariantLines(
        db, 'production_receipts', receiptId, fgLines
      );

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
      relieveStagedPackQty(db, {
        orderId, productId: po.product_id, qtyGood, userId, date, receiptId,
      });
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
    const newStatus = resolveReceiptOrderStatus(po, body, qtyGood);
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
      matRial, pkgRial, laborRial, ohRial,
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
        overhead_rial: ohRial,
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
    color: po.color,
    priceBasis: 'average',
    forProductId: explodeProductScopeForOrder(db, po),
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
      const { appliedOverheadRial } = require('./overhead');
      const dq = computeDriverQty(db, {
        driver: rate.driver, po, qtyStarted, laborRial, matRial,
      });
      ohRial = appliedOverheadRial(rate, dq);
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

    // R13: covered-lay value deltas absorbed by these receipts (JE + FG value rows) go first.
    require('./cutting').reverseOrderFgDeltas(db, { orderId, userId, reason, date });

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

    // Restore FG stock (undo receipt avg) — reverse the original ledger row (R12/R13)
    // so operational kardex can hide both sides; do not leave a posted orphan receipt.
    for (const r of receipts) {
      reverseReceiptStock(db, {
        productId: r.product_id,
        warehouseId: r.warehouse_id,
        qty: r.qty,
        unitCostRial: r.unit_cost_rial,
        amountRial: r.amount_rial,
        prevAvgRial: r.prev_avg_rial,
        userId,
        note: `ابطال رسید ${po.order_no}`,
        sourceType: 'production_receipt_reversal',
        sourceId: r.id,
        orderId: po.id,
        orderNo: po.order_no,
        date,
      });
      db.prepare(`UPDATE production_receipts SET status='reversed' WHERE id=?`).run(r.id);
      require('../inventory/apparel-lines').reverseApparelDoc(db, {
        docType: 'production_fg', docId: r.id, userId,
        note: `ابطال رسید ${po.order_no}`,
      });
    }

    // Restore materials (issue does not change average_cost)
    // W4 / ADR-006: cutting_lay memos — موجودی پارچه مال لایه‌چینی است؛ restore دوباره = طاقهٔ شبح
    for (const i of issues) {
      if (String(i.issue_type || '') === 'cutting_lay') {
        db.prepare(`UPDATE production_material_issues SET status='reversed' WHERE id=?`).run(i.id);
        continue;
      }
      reverseIssueStock(db, {
        productId: i.product_id,
        warehouseId: i.warehouse_id,
        qty: i.qty_actual,
        unitCostRial: i.unit_cost_rial,
        userId,
        note: `ابطال مصرف ${po.order_no}`,
        orderId: po.id,
        orderNo: po.order_no,
        sourceId: i.id,
        date,
      });
      require('../inventory/apparel-lines').reverseApparelDoc(db, {
        docType: 'production_issue', docId: i.id, userId,
        note: `ابطال مصرف ${po.order_no}`,
      });
      db.prepare(`UPDATE production_material_issues SET status='reversed' WHERE id=?`).run(i.id);
    }

    // Reverse scrap inventory
    for (const w of wastes) {
      if (w.waste_type === 'salable' && w.scrap_product_id && w.qty) {
        reverseReceiptStock(db, {
          productId: w.scrap_product_id,
          warehouseId: w.warehouse_id,
          qty: w.qty,
          unitCostRial: w.nrv_unit_rial,
          amountRial: w.nrv_amount_rial,
          userId,
          note: `ابطال ضایعات ${po.order_no}`,
          sourceType: 'production_scrap_reversal',
          sourceId: w.id,
          date,
          eventType: 'scrap_reversal',
        });
      }
      db.prepare(`UPDATE production_waste SET status='reversed' WHERE id=?`).run(w.id);
    }
    require('../inventory/apparel-lines').reverseApparelDoc(db, {
      docType: 'production_scrap', docId: orderId, userId,
      note: `ابطال ضایعات ${po.order_no}`,
    });

    reverseAppliedOverheadCounters(db, ohs);
    for (const o of ohs) {
      db.prepare(`UPDATE production_overhead_applications SET status='reversed' WHERE id=?`).run(o.id);
    }
    for (const l of labs) {
      db.prepare(`UPDATE production_labor_entries SET status='reversed' WHERE id=?`).run(l.id);
    }
    retirePersonLaborForEntries(db, labs);

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
  const qty = explodeQtyForOrder(db, po, qtyStarted != null ? num(qtyStarted) : null);
  const ex = explodeBom(db, {
    bomId: po.bom_id,
    qty,
    sizeBreakdown: safeJson(po.size_breakdown),
    color: po.color,
    priceBasis: 'std',
    forProductId: explodeProductScopeForOrder(db, po),
  });
  const whId = po.warehouse_raw_id || null;
  return {
    order_id: orderId,
    qty_started: qty,
    warehouse_raw_id: whId,
    lines: ex.lines.map(L => {
      const p = db.prepare('SELECT name, average_cost_rial, item_type, stock FROM products WHERE id=?').get(L.product_id);
      const avg = Math.round(Number(p?.average_cost_rial) || 0);
      const stdQty = Number(L.qty_final) || 0;
      const allow = fabricIssueAllowance(db, { productId: L.product_id, orderId });
      let qtyActual = stdQty;
      let fabricCutLocked = 0;
      let fabricCutMeters = 0;
      let fabricQtyAllowed = null;
      // After cutting for THIS order/FG, do not prefill re-issue of consumed fabric meters.
      if (allow.allowed != null) {
        fabricCutMeters = allow.cut_meters;
        fabricQtyAllowed = allow.remaining;
        qtyActual = Math.min(stdQty, Math.max(0, Number(allow.remaining) || 0));
        fabricCutLocked = qtyActual <= 0 ? 1 : 0;
      }
      let stockAvail = null;
      try {
        stockAvail = whId
          ? Number(getWhQty(db, L.product_id, whId)) || 0
          : Number(p?.stock) || 0;
      } catch (_) {
        stockAvail = Number(p?.stock) || 0;
      }
      const stockShort = !fabricCutLocked && qtyActual > 0 && stockAvail + 1e-9 < qtyActual ? 1 : 0;
      return {
        product_id: L.product_id,
        name: p?.name,
        qty_standard: stdQty,
        qty_actual: qtyActual,
        std_cost_rial: L.unit_cost_rial,
        average_cost_rial: avg,
        avg_cost_ok: avg > 0 ? 1 : 0,
        line_kind: L.line_kind,
        bom_line_id: L.bom_line_id,
        fabric_cut_meters: fabricCutMeters,
        fabric_qty_allowed: fabricQtyAllowed,
        fabric_cut_locked: fabricCutLocked,
        fabric_cut_scope: allow.cut_scope || null,
        stock_available: stockAvail,
        stock_short: stockShort,
      };
    }),
  };
}

/**
 * Cover stock shortage with an alternate SKU on the same issue document.
 * Input line may carry alternate_product_id + alternate_qty (UI helper fields).
 * Expands into primary (up to on-hand) + substitute leg (issue_type=substitute).
 */
function expandShortageAlternates(db, materials, whId) {
  const out = [];
  for (const L of materials || []) {
    const AQ = num(L.qty_actual != null ? L.qty_actual : L.qty);
    const altId = Number(L.alternate_product_id) || 0;
    const altQtyReq = num(L.alternate_qty);
    if (!(altId > 0 && altQtyReq > 0 && AQ > 0) || L.substitute_of_product_id) {
      out.push(L);
      continue;
    }
    if (altId === Number(L.product_id)) {
      throw err('E_SUBSTITUTE_INVALID', 422, {
        detail: 'کالای جایگزین نمی‌تواند همان قلم اصلی باشد',
      });
    }
    const prim = db.prepare('SELECT id, name, stock FROM products WHERE id=?').get(L.product_id);
    if (!prim) throw err('E_NOT_FOUND', 404, { productId: L.product_id });
    const alt = db.prepare('SELECT id, name FROM products WHERE id=?').get(altId);
    if (!alt) throw err('E_NOT_FOUND', 404, { productId: altId });

    let avail = 0;
    try {
      avail = whId
        ? Number(getWhQty(db, L.product_id, whId)) || 0
        : Number(prim.stock) || 0;
    } catch (_) {
      avail = Number(prim.stock) || 0;
    }
    const primaryIssue = Math.min(AQ, Math.max(0, avail));
    const shortfall = round6(AQ - primaryIssue);
    if (shortfall <= 1e-9) {
      const { alternate_product_id: _a, alternate_qty: _q, ...rest } = L;
      out.push(rest);
      continue;
    }
    const cover = Math.min(altQtyReq, shortfall);
    if (primaryIssue + cover + 1e-9 < AQ) {
      const extra = {
        product_id: L.product_id,
        warehouse_id: whId || null,
        name: prim.name,
        available: avail,
        needed: AQ,
        shortfall,
        alternate_cover: cover,
        detail: 'کسری با کالای جایگزین کامل پوشش داده نشد',
      };
      throw require('../inventory/shortage-error').attach(err('E_NEGATIVE_STOCK', 409, extra), db, [
        { product_id: L.product_id, warehouse_id: whId || null, available: avail, needed: AQ, shortfall: round6(AQ - primaryIssue - cover) },
      ]);
    }
    const reason = String(L.reason || '').trim() ||
      `تأمین کسری از کالای جایگزین «${alt.name}» به‌مقدار ${cover}` +
      ` (موجودی «${prim.name}»: ${avail}، نیاز: ${AQ})`;

    if (primaryIssue > 1e-9) {
      out.push({
        ...L,
        qty_actual: primaryIssue,
        reason,
        alternate_product_id: undefined,
        alternate_qty: undefined,
      });
    }
    out.push({
      product_id: altId,
      qty_actual: cover,
      variant_id: L.alternate_variant_id || undefined,
      variant_lines: L.alternate_variant_lines || undefined,
      substitute_of_product_id: L.product_id,
      reason,
    });
  }
  return out;
}

/**
 * Resolve BOM standard for an issue line.
 * Full substitute (no primary leg): SQ/SP from substitute_of (A-24 / T3-21).
 * Partial cover (primary also issued): SQ=0 on substitute so standards are not double-counted.
 */
function resolveIssueStd(std, L, materialsExpanded) {
  const subOf = Number(L.substitute_of_product_id) || 0;
  if (subOf) {
    const s = std[subOf];
    if (!s) {
      throw err('E_SUBSTITUTE_INVALID', 422, {
        product_id: subOf,
        detail: 'کالای جایگزین‌شده در فرمول نیست',
      });
    }
    const primaryAlso = (materialsExpanded || []).some((m) => {
      const q = num(m.qty_actual != null ? m.qty_actual : m.qty);
      return Number(m.product_id) === subOf && q > 0;
    });
    if (primaryAlso) {
      return { s: { ...s, qty: 0 }, SQ: 0, SP: s.price || 0, partialSubstitute: true };
    }
    return { s, SQ: s.qty ?? 0, SP: s.price || 0, partialSubstitute: false };
  }
  const s = std[L.product_id] || null;
  return { s, SQ: s?.qty ?? 0, SP: s?.price ?? 0, partialSubstitute: false };
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
    require('./product-completeness').assertOrderReady(db, orderId, 'issue');

    const hasReceipt = db.prepare(`
      SELECT 1 FROM production_receipts WHERE order_id=? AND status='posted' LIMIT 1
    `).get(orderId);
    if (hasReceipt) throw err('E_RECEIPT_EXISTS', 409);

    const date = String(body.date || po.date || todayJalali()).trim();
    const period = jalaliPeriod(date);
    assertPeriodOpen(db, period);
    const fy = assertFiscalYearWritable(db, date);
    if (!fy.ok) throw err('E_PERIOD_CLOSED', 409, { detail: fy.error });

    const qtyStarted = num(body.qty_started) || num(po.qty_planned);
    const threshold = varianceReasonThreshold(db);
    const whId = po.warehouse_raw_id;
    const materialsRaw = body.materials || body.lines || [];
    if (!materialsRaw.length) throw err('E_QTY_INVALID', 422);
    const materials = expandShortageAlternates(db, materialsRaw, whId);
    if (!materials.length) throw err('E_QTY_INVALID', 422);

    // Standard map from BOM explode
    const { std } = standardMapFromBom(db, po, qtyStarted);

    let issueNo;
    try { issueNo = allocateNumber(db, 'material_issue', 'MI'); }
    catch { issueNo = `MI-${Date.now()}`; }

    let matRial = 0, pkgRial = 0, varP = 0, varQ = 0;
    const warnings = [];
    const out = [];

    for (const L of materials) {
      const AQ = num(L.qty_actual != null ? L.qty_actual : L.qty);
      const prod = db.prepare('SELECT * FROM products WHERE id=?').get(L.product_id);
      if (!prod) throw err('E_NOT_FOUND', 404, { productId: L.product_id });
      if (AQ > 0) {
        assertFabricIssueAllowed(db, {
          productId: L.product_id,
          qty: AQ,
          batchId: L.batch_id,
          orderId,
        });
      }

      const resolved = resolveIssueStd(std, L, materials);
      const s = resolved.s;
      const SQ = resolved.SQ;
      let SP = resolved.SP;
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
      let apparelLines = [];
      if (AQ > 0) {
        const issued = issueFromStock(db, {
          productId: L.product_id, warehouseId: whId, qty: AQ, userId,
          note: `حواله ${issueNo}`,
          variantId: L.variant_id, variantLines: L.variant_lines,
          sourceType: 'production_issue', sourceId: orderId, date,
        });
        apparelLines = issued.variantLines || [];
      } else if (AQ < 0) {
        apparelLines = require('../inventory/apparel-lines').resolveApparelLines(db, {
          productId: L.product_id, qty: -AQ,
          variantId: L.variant_id, variantLines: L.variant_lines,
        });
        recalcAvgOnReturn(db, {
          productId: L.product_id, warehouseId: whId, qty: -AQ,
          unitCostRial: unitCost, userId,
          note: `برگشت ${issueNo}`,
        });
      }

      const issueInfo = db.prepare(`
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
      if (apparelLines.length) {
        require('../inventory/apparel-lines').postApparelLines(db, {
          productId: L.product_id, warehouseId: whId, lines: apparelLines,
          docType: 'production_issue', docId: issueInfo.lastInsertRowid, userId,
          note: `حواله ${issueNo}`, sign: AQ < 0 ? 1 : -1, allowNegative: false,
        });
        require('../inventory/apparel-lines').saveDocVariantLines(
          db, 'production_material_issues', issueInfo.lastInsertRowid, apparelLines
        );
      }

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
    if (po.status === 'cancelled') throw err('E_ORDER_CANCELLED', 409);
    if (po.status === 'draft') throw err('E_NOT_RELEASED', 409);
    if (po.status === 'completed') throw err('E_ALREADY_COMPLETED', 409);
    if (!['released', 'in_progress'].includes(po.status)) {
      throw err('E_INVALID_STATUS', 409, { status: po.status });
    }
    require('./product-completeness').assertOrderReady(db, orderId, 'finalize');

    const issued = db.prepare(`
      SELECT COALESCE(SUM(amount_rial),0) s FROM production_material_issues
      WHERE order_id=? AND status='posted'
    `).get(orderId);
    if (!issued || Math.abs(Number(issued.s)) < 1) throw err('E_NO_MATERIAL_ISSUED', 422);

    const RDG = require('./receipt-date-guard');
    const date = String(body.date || RDG.defaultReceiptDate(db, orderId, po.date || todayJalali())).trim();
    RDG.assertReceiptNotBeforeLastActivity(db, orderId, date);
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
      const freshLabs = db.prepare(`
        SELECT * FROM production_labor_entries
        WHERE order_id=? AND status='posted' AND je_id IS NULL
      `).all(orderId);
      const { productCode, productName } = productLabelForOrder(db, po);
      const laborJes = absorbLaborJournal(db, {
        orderId,
        date,
        userId,
        costCenterId: po.cost_center_id || null,
        wipTafsili: po.coa_wip_tafsili,
        entries: freshLabs,
        descriptionFallback: formatLaborJeDescription({
          orderNo: po.order_no, productCode, productName, qty: qtyStarted, amountRial: laborRial,
        }),
        postEvent, dr, cr,
      });
      for (const j of laborJes) jes.push(j);
    }

    // R7: variable OH uses actual material (material + packaging)
    const oh = applyOverhead(db, {
      po, qtyStarted, laborRial,
      matRial: matActual + pkgActual,
      date, period, userId,
      machineMinutes: body.machine_minutes,
      laborHours: body.labor_hours,
      manualDriverQty: body.manual_driver_qty != null ? body.manual_driver_qty : po.manual_driver_qty,
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
    const plant = postPlantOverhead(db, {
      po, qty: qtyGood, laborRial,
      matRial: matActual + pkgActual,
      date, period, userId,
    });
    for (const line of plant.lines) {
      const jeP = postEvent(db, {
        event: 'PRD-05', sourceId: orderId, date, createdBy: userId,
        description: `جذب سربار سراسری ${line.name} — ${po.order_no}`,
        costCenterId: line.cost_center_id,
        lines: [
          dr(db, 'coa_wip', line.amount_rial, po.coa_wip_tafsili),
          cr(db, 'coa_overhead_applied', line.amount_rial),
        ],
      });
      if (jeP) {
        jes.push(jeP);
        db.prepare('UPDATE production_overhead_applications SET je_id=? WHERE id=?').run(jeP.je_id, line.id);
      }
    }
    const ohRial = (oh.amount_rial || 0) + plant.amount_rial;

    const wipTotal = matActual + pkgActual + laborRial + ohRial + sumSubcontract(db, orderId);
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
        productId: s.product_id,
        qty: s.qty,
        unitRial: s.nrv_unit_rial,
        warehouseId: scrapWh,
        userId,
        orderId,
        date,
        period,
        variantId: s.variant_id,
        variantLines: s.variant_lines,
        sizeBreakdown: s.size_breakdown,
        color: s.color || po.color,
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
      const fgLines = require('../inventory/apparel-lines').resolveApparelLines(db, {
        productId: po.product_id, qty: qtyGood,
        variantId: body.variant_id, variantLines: body.variant_lines,
        sizeBreakdown: body.size_breakdown || po.size_breakdown,
        color: body.color || po.color,
      });
      unitCost = Math.round(wipNet / qtyGood);
      assertFabricCuttingPathForFgReceipt(db, po, qtyGood);
      assertNoOrphanSellablePack(db, po.product_id, orderId);
      const avg = updateMovingAverage(db, {
        productId: po.product_id, warehouseId: po.warehouse_fg_id,
        qtyIn: qtyGood, amountRial: wipNet, userId, note: `تولید ${po.order_no}`,
        sourceType: 'production_receipt', sourceId: orderId, date,
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
      require('../inventory/apparel-lines').postApparelLines(db, {
        productId: po.product_id, warehouseId: po.warehouse_fg_id,
        lines: fgLines, docType: 'production_fg', docId: receiptId, userId,
        note: `رسید تولید ${po.order_no}`, sign: 1, allowNegative: true,
      });
      require('../inventory/apparel-lines').saveDocVariantLines(
        db, 'production_receipts', receiptId, fgLines
      );

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
      relieveStagedPackQty(db, {
        orderId, productId: po.product_id, qtyGood, userId, date, receiptId,
      });
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
      qtyGood, wN, wA, laborRial, ohRial,
      abnormalRial, scrapCredit, wipNet, unitCost,
      resolveReceiptOrderStatus(po, body, qtyGood), date, period, orderId
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
        overhead_rial: ohRial,
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

/**
 * Hide an order from the shop list after reversing posted effects (R13).
 * The row stays in the database with status voided.
 */
function purgeOrder(db, orderId, userId, reason = '') {
  const why = String(reason || '').trim();
  if (!why) throw err('E_REASON_REQUIRED', 422);
  return db.transaction(() => {
    let po = getOrder(db, orderId);
    if (po.status === 'voided') return getOrder(db, orderId);
    if (po.status === 'closed') throw err('E_ORDER_CLOSED', 409);

    if (['fixed_adv', 'variable_adv'].includes(po.analysis_type)
      && !['draft', 'cancelled'].includes(po.status)) {
      const adv = require('./engine-advanced');
      for (let guard = 0; guard < 40; guard++) {
        const last = db.prepare(`
          SELECT id FROM production_order_stages
          WHERE order_id=? AND status='done'
          ORDER BY seq DESC, id DESC LIMIT 1
        `).get(orderId);
        if (!last) break;
        const layIssueIds = db.prepare(`
          SELECT id FROM production_material_issues
          WHERE stage_id=? AND status='posted' AND issue_type='cutting_lay'
        `).all(last.id).map(r => r.id);
        adv.reverseStage(db, {
          orderId, stageId: last.id, reason: why, userId, releaseLayIssueIds: layIssueIds,
        });
      }
    }

    po = getOrder(db, orderId);
    const postedIssues = db.prepare(`
      SELECT COUNT(*) c FROM production_material_issues WHERE order_id=? AND status='posted'
    `).get(orderId).c;
    const postedReceipts = db.prepare(`
      SELECT COUNT(*) c FROM production_receipts WHERE order_id=? AND status='posted'
    `).get(orderId).c;
    if ((postedIssues || postedReceipts) && po.status !== 'cancelled') {
      reverseOrder(db, orderId, userId, why);
    } else {
      // Order reversed before fg_delta was part of the reverse: void what is still live.
      require('./cutting').reverseOrderFgDeltas(db, { orderId, userId, reason: why });
    }

    db.prepare(`
      UPDATE production_reservations SET status='released'
      WHERE order_id=? AND status='active'
    `).run(orderId);
    db.prepare(`
      UPDATE production_orders
      SET status='voided', cancelled_reason=?, updated_at=strftime('%s','now')
      WHERE id=?
    `).run(why, orderId);
    audit(userId, 'update', 'production_order', orderId, `حذف کامل ${po.order_no}: ${why}`);
    return getOrder(db, orderId);
  })();
}

function attachListFgPlan(db, row) {
  row.fg_plan = [];
  row.is_multiproduct = false;
  if (!row?.bom_id) return;
  let plan = [];
  try {
    if (!parseFgPlanJson(row.fg_plan_json) && !isMultiproductBom(db, row.bom_id)) return;
    plan = orderFgPlanRows(db, row);
  } catch { return; }
  if (!plan || plan.length < 2) return;
  const produced = {};
  try {
    for (const rec of db.prepare(`
      SELECT product_id, COALESCE(SUM(qty),0) AS q
      FROM production_receipts
      WHERE order_id=? AND IFNULL(status,'posted')='posted' AND output_type IN ('main','co')
      GROUP BY product_id
    `).all(row.id)) {
      produced[rec.product_id] = rec.q;
    }
  } catch { /* receipts table missing on very old DBs */ }
  row.fg_plan = plan.map(p => ({
    product_id: p.product_id,
    product_name: p.product_name,
    qty_planned: p.qty_planned,
    qty_produced: produced[p.product_id] || 0,
    cost_share_percent: p.cost_share_percent,
  }));
  row.is_multiproduct = true;
}

function listOrders(db, { status, productId, period, page = 1, limit = 50, includeVoided = false } = {}) {
  const where = ['1=1'];
  const params = [];
  // Qualify po.* — products.status (v546+) makes bare status ambiguous on the JOIN.
  if (status) { where.push('po.status=?'); params.push(status); }
  if (!includeVoided && status !== 'voided') where.push("IFNULL(po.status,'')!='voided'");
  if (productId) { where.push('po.product_id=?'); params.push(productId); }
  if (period) { where.push('po.period_label=?'); params.push(period); }
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
  for (const row of rows) {
    Object.assign(row, fabricCuttingGateInfo(db, row));
    attachListFgPlan(db, row);
  }
  const total = db.prepare(`
    SELECT COUNT(*) c FROM production_orders po WHERE ${where.join(' AND ')}
  `).get(...params).c;
  return { rows, total, page: Number(page) || 1, limit: lim };
}

function getOrderDetail(db, orderId) {
  const po = getOrder(db, orderId);
  const multi = !!(po.bom_id && isMultiproductBom(db, po.bom_id)) || !!orderBomPeerLines(po);
  const fg_plan = po.bom_id
    ? orderFgPlanRows(db, po)
    : [];
  return {
    ...po,
    ...fabricCuttingGateInfo(db, po),
    is_multiproduct: multi,
    fg_plan,
    issues: db.prepare('SELECT * FROM production_material_issues WHERE order_id=?').all(orderId),
    labor: db.prepare('SELECT * FROM production_labor_entries WHERE order_id=?').all(orderId),
    overhead: db.prepare('SELECT * FROM production_overhead_applications WHERE order_id=?').all(orderId),
    waste: db.prepare('SELECT * FROM production_waste WHERE order_id=?').all(orderId),
    receipts: db.prepare('SELECT * FROM production_receipts WHERE order_id=?').all(orderId),
    reservations: db.prepare('SELECT * FROM production_reservations WHERE order_id=?').all(orderId),
    matrix_lines: listOrderLines(db, orderId),
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
  const materialsRaw = body?.materials || body?.lines || [];
  if (!materialsRaw.length) throw err('E_QTY_INVALID', 422);
  const materials = expandShortageAlternates(db, materialsRaw, po.warehouse_raw_id);
  const { std } = standardMapFromBom(db, po, qtyStarted);
  const warnings = [];
  const out = [];
  let matRial = 0; let pkgRial = 0; let varP = 0; let varQ = 0;

  for (const L of materials) {
    const AQ = num(L.qty_actual != null ? L.qty_actual : L.qty);
    const prod = db.prepare('SELECT * FROM products WHERE id=?').get(L.product_id);
    if (!prod) throw err('E_NOT_FOUND', 404, { productId: L.product_id });
    const resolved = resolveIssueStd(std, L, materials);
    const s = resolved.s;
    const SQ = resolved.SQ;
    let SP = resolved.SP;
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

  // PA-11 — re-planning the color×size grid. Only a draft may be re-planned:
  // once released the reservations and WIP already follow the old quantities.
  let matrixLines = normalizeMatrixPayload(body);
  let qtyPlanned = null;
  let fgMap = null;
  if (matrixLines) {
    if (po.status !== 'draft') throw err('E_INVALID_STATUS', 409, { status: po.status });
    if (!matrixLines.length) throw err('E_QTY_INVALID', 422);
    if (!tableExists(db, 'production_order_lines')) throw err('E_NO_MATRIX_TABLE', 409);
    matrixLines = resolveMatrixGroups(db, {
      fallbackProductId: po.product_id, bomId: po.bom_id, lines: matrixLines,
    });
    assertMatrixCellsUnique(matrixLines);
    const orderSum = matrixLines
      .filter(ln => Number(ln.product_id) === Number(po.product_id))
      .reduce((s, ln) => s + ln.qty, 0);
    qtyPlanned = orderSum > 0 ? orderSum : matrixLines.reduce((s, ln) => s + ln.qty, 0);
    if (qtyPlanned <= 0) throw err('E_QTY_INVALID', 422);
  } else if (body.qty_planned !== undefined) {
    if (po.status !== 'draft') throw err('E_INVALID_STATUS', 409, { status: po.status });
    qtyPlanned = num(body.qty_planned);
    if (qtyPlanned <= 0) throw err('E_QTY_INVALID', 422);
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
    manual_driver_qty: 'manual_driver_qty',
  };
  for (const [k, col] of Object.entries(allow)) {
    if (body[k] !== undefined) {
      fields.push(`${col}=?`);
      params.push(body[k]);
    }
  }

  if (po.bom_id && isMultiproductBom(db, po.bom_id) && (matrixLines || body.fg_plan || qtyPlanned != null)) {
    if (po.status !== 'draft') throw err('E_INVALID_STATUS', 409, { status: po.status });
    const qOrder = qtyPlanned != null ? qtyPlanned : num(po.qty_planned);
    const formula = planBomFgOutputs(db, po.bom_id, qOrder, po.product_id);
    fgMap = {};
    for (const p of formula) fgMap[p.product_id] = Number(p.qty_planned) || 0;
    const prev = parseFgPlanJson(po.fg_plan_json);
    if (prev) {
      for (const p of formula) {
        if (prev[p.product_id] != null && Number(p.product_id) !== Number(po.product_id)) {
          fgMap[p.product_id] = prev[p.product_id];
        }
      }
    }
    const sent = parseFgPlanJson(body.fg_plan);
    if (sent) {
      for (const p of formula) {
        if (sent[p.product_id] != null && Number(p.product_id) !== Number(po.product_id)) {
          fgMap[p.product_id] = sent[p.product_id];
        }
      }
    }
    fgMap[po.product_id] = qOrder;
    if (matrixLines) {
      const sums = {};
      for (const ln of matrixLines) sums[ln.product_id] = (sums[ln.product_id] || 0) + ln.qty;
      for (const pid of Object.keys(sums)) {
        if (Number(pid) !== Number(po.product_id)) fgMap[pid] = sums[pid];
      }
    }
  }

  if (qtyPlanned != null) {
    // The standard cost is quantity-driven, so a re-plan that left std_* alone
    // would publish a unit cost belonging to the previous quantity.
    let stdMat = 0;
    try {
      stdMat = explodeBom(db, {
        bomId: po.bom_id, qty: qtyPlanned, priceBasis: 'std',
        sizeBreakdown: safeJson(po.size_breakdown), color: po.color,
        forProductId: explodeProductScopeForOrder(db, po),
        qtyByProduct: fgMap,
      }).totals.total_rial;
    } catch { /* keep 0 — same best-effort contract as createOrder */ }
    fields.push('qty_planned=?', 'std_material_rial=?', 'std_total_rial=?', 'std_unit_rial=?');
    params.push(
      qtyPlanned, stdMat,
      stdMat + num(po.std_labor_rial) + num(po.std_overhead_rial),
      Math.round((stdMat + num(po.std_labor_rial) + num(po.std_overhead_rial)) / qtyPlanned)
    );
  }
  const existingPeers = orderBomPeerLines(po);
  if (existingPeers && (body.fg_plan || qtyPlanned != null)) {
    if (po.status !== 'draft') throw err('E_INVALID_STATUS', 409, { status: po.status });
    const sent = parseFgPlanJson(body.fg_plan);
    const next = existingPeers.map((p) => ({
      product_id: p.product_id,
      bom_id: p.bom_id,
      qty: Number(p.product_id) === Number(po.product_id)
        ? (qtyPlanned != null ? qtyPlanned : p.qty_planned)
        : (sent && sent[p.product_id] != null ? sent[p.product_id] : p.qty_planned),
    }));
    if (next.some((p) => !(Number(p.qty) > 0))) throw err('E_QTY_INVALID', 422);
    fields.push('fg_plan_json=?');
    params.push(JSON.stringify(next));
  } else if (fgMap) {
    fields.push('fg_plan_json=?');
    params.push(fgPlanJson(fgMap));
  }

  if (!fields.length && !matrixLines) return getOrderDetail(db, orderId);

  db.transaction(() => {
    if (fields.length) {
      db.prepare(`
        UPDATE production_orders SET ${fields.join(', ')}, updated_at=strftime('%s','now') WHERE id=?
      `).run(...params, orderId);
    }
    if (matrixLines) {
      db.prepare('DELETE FROM production_order_lines WHERE order_id=?').run(orderId);
      const insLine = db.prepare(`
        INSERT INTO production_order_lines
          (order_id, product_id, variant_id, color_id, size_id, qty_planned, bom_snapshot_ref)
        VALUES (?,?,?,?,?,?,?)
      `);
      for (const ln of matrixLines) {
        insLine.run(
          orderId, ln.product_id || po.product_id, ln.variant_id, ln.color_id, ln.size_id,
          ln.qty, String(po.bom_id || '')
        );
      }
      try {
        db.prepare('UPDATE production_orders SET has_matrix_lines=1 WHERE id=?').run(orderId);
      } catch (_) { /* column missing on pre-PA-04 DBs */ }
    }
  })();
  return getOrderDetail(db, orderId);
}

module.exports = {
  createOrder,
  releaseOrder,
  cancelOrder,
  purgeOrder,
  closeOrder,
  reopenOrder,
  postReceiptFixed,
  previewReceiptFixed,
  postReceiptVariable,
  issueMaterialsVariable,
  issueTemplate,
  previewMaterialIssue,
  postMaterialReturn,
  expandShortageAlternates,
  resolveIssueStd,
  updateOrder,
  listIssues,
  reverseOrder,
  wipResidual,
  previewOrderCostReconcile,
  applyDocumentCosts,
  applyReceiptToWipNet: (...args) => require('./order-cost-reconcile').applyReceiptToWipNet(...args),
  reconcileOrderCosts: (...args) => require('./order-cost-reconcile').reconcileOrderCosts(...args),
  listOrders,
  getOrderDetail,
  listOrderLines,
  jalaliPeriod,
  assertPeriodOpen,
  ledgerBalance,
  checkCostDeviation,
  varianceAnalysis,
  checkBomRevisionSuggestion,
  recomputeOrderTotals: (db, orderId) => wipResidual(db, orderId),
};
