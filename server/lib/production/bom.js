'use strict';
/**
 * Production Module 1 — BOM (Bill of Materials)
 * No ledger posting (master data only).
 */
const { allocateNumber, audit } = require('../../db');
const { todayJalali, addDaysToJalali } = require('../../jalali');
const { CONTINUOUS_UNIT_RE, hasActiveMatrixVariants } = require('../inventory/qty-policy');

function err(code, status = 422, extra = {}) {
  const e = new Error(code);
  e.code = code;
  e.status = status;
  e.extra = extra;
  return e;
}

function nowUnix() { return Math.floor(Date.now() / 1000); }

function round6(n) {
  return Math.round(Number(n) * 1e6) / 1e6;
}

function safeJson(s) {
  if (!s) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
}

function allowedSizeNamesForProduct(db, productId) {
  const style = db.prepare(`
    SELECT ps.name
    FROM product_style_sizes pss
    JOIN product_sizes ps ON ps.id = pss.size_id
    WHERE pss.product_id=? AND COALESCE(ps.active,1)=1
    ORDER BY COALESCE(pss.sort_order, ps.sort_order, 0), ps.name
  `).all(productId);
  if (style.length) return new Set(style.map(r => String(r.name)));
  const all = db.prepare(`
    SELECT name FROM product_sizes WHERE COALESCE(active,1)=1 ORDER BY sort_order, name
  `).all();
  return new Set(all.map(r => String(r.name)));
}

function validateSizeMatrixKeys(db, fgProductId, sizeMatrixRaw) {
  if (!sizeMatrixRaw) return null;
  const m = typeof sizeMatrixRaw === 'string' ? safeJson(sizeMatrixRaw) : sizeMatrixRaw;
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    throw err('E_BOM_SIZE_MATRIX', 422, { detail: 'JSON شیء نامعتبر' });
  }
  const allowed = allowedSizeNamesForProduct(db, fgProductId);
  if (!allowed.size) return m;
  const invalid = Object.keys(m).filter(k => !allowed.has(String(k)));
  if (invalid.length) {
    throw err('E_BOM_SIZE_MATRIX', 422, {
      detail: 'کلید سایز با سایزهای محصول هم‌خوان نیست',
      invalid,
      allowed: [...allowed],
    });
  }
  return m;
}

function normalizeColorMode(raw) {
  const m = String(raw || 'none').toLowerCase().trim();
  if (m === 'inherit_fg' || m === 'inherit' || m === 'fixed') {
    return m === 'inherit' ? 'inherit_fg' : m;
  }
  return 'none';
}

/** V-15: finished non-manufactured SKUs cannot be BOM components (use raw/packaging/semi). */
function assertBomComponentType(db, componentProductId) {
  if (!componentProductId) return;
  const prod = db.prepare('SELECT item_type, is_manufactured, name FROM products WHERE id=?').get(componentProductId);
  if (prod && prod.item_type === 'finished' && !prod.is_manufactured) {
    throw err('E_BOM_COMP_TYPE', 422, { name: prod.name });
  }
}

function resolveFgColorName(db, { color, colorId, bom }) {
  if (color && String(color).trim()) return String(color).trim();
  const cid = colorId != null ? colorId : bom?.color_id;
  if (cid) {
    const row = db.prepare('SELECT name FROM product_colors WHERE id=?').get(cid);
    if (row?.name) return String(row.name);
  }
  if (bom?.color_variant) return String(bom.color_variant).trim();
  return '';
}

function isContinuousComponent(db, productId) {
  const p = db.prepare('SELECT unit FROM products WHERE id=?').get(productId);
  return CONTINUOUS_UNIT_RE.test(String(p?.unit || ''));
}

function buildComponentVariantHint(db, line, { qty, sizeBreakdown, fgColor }) {
  const productId = line.component_product_id;
  if (!productId || isContinuousComponent(db, productId)) return null;
  if (!hasActiveMatrixVariants(db, productId)) return null;
  const mode = normalizeColorMode(line.component_color_mode);
  let colorWant = '';
  if (mode === 'fixed') {
    if (line.component_color_id) {
      const c = db.prepare('SELECT name FROM product_colors WHERE id=?').get(line.component_color_id);
      colorWant = c?.name ? String(c.name) : '';
    }
  } else if (mode === 'inherit_fg') {
    colorWant = fgColor || '';
  } else if (mode === 'none' && fgColor && sizeBreakdown) {
    colorWant = fgColor;
  } else {
    return null;
  }
  if (!colorWant && mode !== 'fixed') return null;
  try {
    const { resolveApparelLines } = require('../inventory/apparel-lines');
    const lines = resolveApparelLines(db, {
      productId, qty, sizeBreakdown, color: colorWant,
    });
    if (!lines.length) return null;
    return {
      variant_lines: lines.map(l => ({ variant_id: l.variantId, qty: l.qty })),
      variant_id: lines.length === 1 ? lines[0].variantId : null,
      color: colorWant,
    };
  } catch (_) {
    return null;
  }
}

function nextRev(rev) {
  if (!rev) return 'A';
  const c = String(rev).toUpperCase();
  if (c.length === 1 && c >= 'A' && c < 'Z') return String.fromCharCode(c.charCodeAt(0) + 1);
  return c + 'A';
}

function logBomChange(db, bomId, changeType, payload, userId) {
  db.prepare(`
    INSERT INTO bom_change_log (bom_id, change_type, entity, before_json, after_json, reason, date, created_by)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    bomId,
    changeType,
    payload.entity || 'header',
    payload.before ? JSON.stringify(payload.before) : '',
    payload.after ? JSON.stringify(payload.after) : JSON.stringify(payload),
    payload.reason || '',
    todayJalali(),
    userId || null
  );
}

function emit(db, eventType, payload) {
  try {
    db.prepare(`
      INSERT INTO production_events (event_type, entity_type, entity_id, payload_json)
      VALUES (?,?,?,?)
    `).run(eventType, 'bom', payload.bomId || payload.newBomId || null, JSON.stringify(payload));
  } catch { /* events table optional during early boot */ }
}

function availableQty(db, productId) {
  const p = db.prepare('SELECT stock FROM products WHERE id=?').get(productId);
  return Number(p?.stock) || 0;
}

function lastPurchasePrice(db, productId) {
  try {
    const row = db.prepare(`
      SELECT unit_price_rial FROM purchase_invoice_items
      WHERE product_id=? ORDER BY id DESC LIMIT 1
    `).get(productId);
    return row ? Number(row.unit_price_rial) || 0 : 0;
  } catch {
    return 0;
  }
}

function getPrice(db, productId, basis, line, priceOverrides = null) {
  if (priceOverrides && (basis === 'average' || basis == null || basis === '')) {
    if (priceOverrides.has(productId)) {
      return Number(priceOverrides.get(productId)) || 0;
    }
  }
  const p = db.prepare('SELECT average_cost_rial, std_cost_rial FROM products WHERE id=?').get(productId);
  switch (basis) {
    case 'std': return Number(line?.std_cost_rial || p?.std_cost_rial) || 0;
    case 'manual': return Number(line?.std_cost_rial) || 0;
    case 'last_purchase': return lastPurchasePrice(db, productId) || Number(p?.average_cost_rial) || 0;
    default: return Number(p?.average_cost_rial) || 0;
  }
}

function sumTotals(lines) {
  let material = 0, packaging = 0;
  for (const L of lines) {
    if (L.line_kind === 'packaging') packaging += L.amount_rial || 0;
    else material += L.amount_rial || 0;
  }
  return {
    material_rial: material,
    packaging_rial: packaging,
    total_rial: material + packaging,
  };
}

function nextBomVersion(db, productId) {
  // Live drafts/active only; soft-delete tombstones use version >= 1_000_000.
  const row = db.prepare(`
    SELECT COALESCE(MAX(version),0) m FROM bom_headers
    WHERE product_id=? AND deleted_at IS NULL AND version > 0 AND version < 1000000
  `).get(productId);
  return (row?.m || 0) + 1;
}

function rethrowBomConstraint(e) {
  const msg = String((e && e.message) || '');
  if (/UNIQUE constraint failed: bom_headers\.product_id/i.test(msg)
    || /bom_headers\.product_id, bom_headers\.version/i.test(msg)) {
    const err2 = err('E_BOM_VERSION_CLASH', 409);
    err2.cause = e;
    throw err2;
  }
  if (/UNIQUE constraint failed: bom_headers\.code/i.test(msg)) {
    const err2 = err('E_BOM_CODE_CLASH', 409);
    err2.cause = e;
    throw err2;
  }
  throw e;
}

/** Free unique (product,version,revision)+code when soft-deleting (R13 / wipe-safe). */
function tombstoneBomUniqueKeys(db, bomId, code) {
  const tombVer = 1_000_000 + Number(bomId);
  const base = String(code || 'BOM');
  const tombCode = base.includes('__del') ? `${base}_${bomId}` : `${base}__del${bomId}`;
  db.prepare(`
    UPDATE bom_headers SET version=?, revision='DEL', code=? WHERE id=?
  `).run(tombVer, tombCode, bomId);
}

function assertProductInBomFg(db, bom, productId) {
  const ids = bomFgProductIds(db, bom);
  if (!ids.has(Number(productId))) {
    throw err('E_BOM_PRODUCT_MISMATCH', 422, {
      product_id: productId,
      bom_id: bom.id,
      detail: 'محصول سفارش در لیست محصولات اصلی این فرمول نیست',
    });
  }
}

function isMultiproductBom(db, bomOrId) {
  const bom = typeof bomOrId === 'object' && bomOrId
    ? bomOrId
    : db.prepare('SELECT id, has_coproducts FROM bom_headers WHERE id=?').get(bomOrId);
  if (!bom) return false;
  if (Number(bom.has_coproducts) === 1) return true;
  const n = db.prepare(`
    SELECT COUNT(*) c FROM bom_outputs WHERE bom_id=? AND output_type IN ('main','co')
  `).get(bom.id)?.c || 0;
  return n > 1;
}

/**
 * دامنه explode برای سفارش:
 * - BOM چندمحصولی = اجرای مشترک کارگاه → همهٔ اقلام (shared + exclusive همه FG)
 * - تک‌محصولی → فقط shared + exclusive همان محصول سفارش
 */
function explodeProductScopeForOrder(db, po) {
  if (!po?.bom_id) return po?.product_id ?? null;
  if (isMultiproductBom(db, po.bom_id)) return null;
  return po.product_id != null ? Number(po.product_id) : null;
}

/**
 * نقشهٔ تعداد نهایی هر محصول اصلی.
 * فقط BOM چندمحصولی؛ وگرنه null تا explode تک‌محصولی دست نخورد.
 * با این نقشه، قلم مشترک × جمع تعدادها و قلم اختصاصی × تعداد همان محصول است.
 */
function parseFgPlanJson(raw) {
  if (!raw) return null;
  let rows = raw;
  if (typeof raw === 'string') {
    try { rows = JSON.parse(raw); } catch { return null; }
  }
  if (!Array.isArray(rows) || !rows.length) return null;
  const map = {};
  for (const row of rows) {
    const id = Number(row?.product_id);
    const q = Number(row?.qty != null ? row.qty : row?.qty_planned);
    if (id && q > 0) map[id] = q;
  }
  return Object.keys(map).length ? map : null;
}

function orderFgQtyMap(db, po) {
  if (!po?.bom_id || !isMultiproductBom(db, po.bom_id)) return null;
  const stored = parseFgPlanJson(po.fg_plan_json);
  if (stored) return stored;
  const plan = planBomFgOutputs(db, po.bom_id, Number(po.qty_planned) || 0, po.product_id);
  const map = {};
  for (const p of plan) {
    const q = Number(p.qty_planned) || 0;
    if (q > 0) map[p.product_id] = q;
  }
  return Object.keys(map).length ? map : null;
}

/** برنامهٔ نمایشی: اگر تعداد هر محصول جدا ذخیره شده باشد، همان جایگزین نسبت فرمول می‌شود. */
function orderFgPlanRows(db, po) {
  const formula = planBomFgOutputs(db, po.bom_id, Number(po.qty_planned) || 0, po.product_id);
  const stored = parseFgPlanJson(po.fg_plan_json);
  if (!stored) return formula;
  return formula.map(p => (
    stored[p.product_id] != null
      ? { ...p, qty_planned: stored[p.product_id] }
      : p
  ));
}

/** qty برای explode/رزرو از روی سفارش (تبدیل محصول سفارش → مقیاس لنگر فنی) */
function explodeQtyForOrder(db, po, qtyOverride = null) {
  const q = qtyOverride != null ? Number(qtyOverride) : Number(po?.qty_planned) || 0;
  if (!po?.bom_id) return q;
  return orderQtyAsMainBase(db, po.bom_id, q, po.product_id);
}

/**
 * مقدار معادل مقیاس لنگر (bom.product_id / base_qty) برای explode/مراحل.
 * اگر سفارش روی محصول اصلی دیگری باشد: qty_anchor = qty_order × base / qty_per_base
 */
function orderQtyAsMainBase(db, bomId, qtyOrder, orderProductId) {
  const bom = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
  if (!bom) return Number(qtyOrder) || 0;
  const qty = Number(qtyOrder) || 0;
  const base = Number(bom.base_qty) || 1;
  const orderPid = orderProductId != null ? Number(orderProductId) : Number(bom.product_id);
  if (!orderPid || orderPid === Number(bom.product_id)) return qty;
  const out = db.prepare(`
    SELECT qty_per_base FROM bom_outputs
    WHERE bom_id=? AND product_id=? AND output_type IN ('main','co')
  `).get(bomId, orderPid);
  if (!out) return qty;
  const qpb = Number(out.qty_per_base) || 1;
  if (!(qpb > 0)) return qty;
  return round6(qty * base / qpb);
}

/** برنامه مقدار محصولات اصلی برای سفارش (qtyOrder = مقدار همان محصول سفارش) */
function planBomFgOutputs(db, bomId, qtyOrder, orderProductId = null) {
  const bom = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
  if (!bom) return [];
  const qty = Number(qtyOrder) || 0;
  const base = Number(bom.base_qty) || 1;
  const orderPid = orderProductId != null ? Number(orderProductId) : Number(bom.product_id);
  let outs = db.prepare(`
    SELECT o.*, p.name AS product_name, p.code AS product_code
    FROM bom_outputs o
    LEFT JOIN products p ON p.id=o.product_id
    WHERE o.bom_id=? AND o.output_type IN ('main','co')
    ORDER BY CASE WHEN o.product_id=? THEN 0 ELSE 1 END, o.id
  `).all(bomId, bom.product_id);
  if (!outs.length) {
    const p = db.prepare('SELECT name, code FROM products WHERE id=?').get(bom.product_id);
    return [{
      product_id: bom.product_id,
      product_name: p?.name || ('#' + bom.product_id),
      product_code: p?.code || null,
      role: 'main',
      output_type: 'main',
      qty_per_base: 1,
      qty_planned: qty,
      cost_share_percent: 100,
    }];
  }
  const qtyAnchor = orderQtyAsMainBase(db, bomId, qty, orderPid);
  return outs.map(o => {
    let q = round6((Number(o.qty_per_base) || 1) * qtyAnchor / base);
    // محصول خود سفارش: دقیقاً همان qty واردشده
    if (Number(o.product_id) === orderPid) q = qty;
    return {
      product_id: o.product_id,
      product_name: o.product_name || ('#' + o.product_id),
      product_code: o.product_code || null,
      role: 'main',
      output_type: 'main',
      qty_per_base: Number(o.qty_per_base) || 1,
      qty_planned: q,
      cost_share_percent: Number(o.cost_share_percent) || 0,
      is_anchor: Number(o.product_id) === Number(bom.product_id),
      is_order_product: Number(o.product_id) === orderPid,
    };
  });
}

function resolveBom(db, { productId, date, preferredBomId = null, allowAlternative = false }) {
  if (preferredBomId) {
    const b = db.prepare('SELECT * FROM bom_headers WHERE id=? AND deleted_at IS NULL').get(preferredBomId);
    if (!b) throw err('E_NO_ACTIVE_BOM', 404);
    if (b.status !== 'active' && b.status !== 'archived') throw err('E_BOM_NOT_ACTIVE', 409);
    if (productId) assertProductInBomFg(db, b, productId);
    return b;
  }
  // Historical resolve: active OR archived covering the date (T1-06)
  const rows = db.prepare(`
    SELECT * FROM bom_headers
    WHERE product_id=? AND deleted_at IS NULL
      AND status IN ('active','archived')
      AND (valid_from='' OR valid_from IS NULL OR valid_from<=?)
      AND (valid_to='' OR valid_to IS NULL OR valid_to>=?)
      ${allowAlternative ? '' : "AND bom_type='standard'"}
    ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,
             is_default DESC, valid_from DESC, version DESC
  `).all(productId, date, date);
  if (rows.length) return rows[0];

  // v420/v423: محصول اصلی peer — default_bom_id یا BOM فعال با خروجی main
  const def = db.prepare('SELECT default_bom_id FROM products WHERE id=?').get(productId);
  if (def?.default_bom_id) {
    const b = db.prepare(`
      SELECT * FROM bom_headers
      WHERE id=? AND deleted_at IS NULL AND status IN ('active','archived')
    `).get(def.default_bom_id);
    if (b) {
      try {
        assertProductInBomFg(db, b, productId);
        return b;
      } catch { /* fall through */ }
    }
  }
  const viaOut = db.prepare(`
    SELECT bh.* FROM bom_outputs o
    JOIN bom_headers bh ON bh.id = o.bom_id
    WHERE o.product_id=? AND o.output_type IN ('main','co')
      AND bh.deleted_at IS NULL AND bh.status='active'
      AND (bh.valid_from='' OR bh.valid_from IS NULL OR bh.valid_from<=?)
      AND (bh.valid_to='' OR bh.valid_to IS NULL OR bh.valid_to>=?)
    ORDER BY bh.is_default DESC, bh.version DESC
    LIMIT 1
  `).get(productId, date, date);
  if (viaOut) return viaOut;

  throw err('E_NO_ACTIVE_BOM', 404, { productId, date });
}

function resolveSubstitutes(db, lines, factor, yieldF) {
  const groups = {}, plain = [];
  for (const L of lines) {
    if (L.substitute_group) (groups[L.substitute_group] ||= []).push(L);
    else plain.push(L);
  }
  const picked = [];
  for (const g of Object.values(groups)) {
    g.sort((a, b) => (a.substitute_priority || 0) - (b.substitute_priority || 0));
    let sel = g[0];
    for (const L of g) {
      const scrapF = 1 - (L.scrap_percent || 0) / 100;
      const need = scrapF > 0
        ? (L.qty_per_base * factor) / scrapF / yieldF
        : Infinity;
      const avail = availableQty(db, L.component_product_id);
      if (avail >= need) { sel = L; break; }
    }
    picked.push(sel);
  }
  return [...plain, ...picked].sort((a, b) => a.line_no - b.line_no);
}

/** محصولات FG این BOM (همهٔ محصولات اصلی / خروجی main) */
function bomFgProductIds(db, bomOrId) {
  const bom = typeof bomOrId === 'object' && bomOrId
    ? bomOrId
    : db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomOrId);
  if (!bom) return new Set();
  const ids = new Set([Number(bom.product_id)]);
  const outs = db.prepare(`
    SELECT product_id FROM bom_outputs
    WHERE bom_id=? AND output_type IN ('main','co')
  `).all(bom.id);
  for (const o of outs) ids.add(Number(o.product_id));
  return ids;
}

/**
 * تخصیص قلم/عملیات به محصول: shared | exclusive(+scoped_product_id).
 * در BOM تک‌محصولی همیشه shared برمی‌گردد.
 */
function normalizeProductScope(db, bom, body = {}) {
  const fgIds = bomFgProductIds(db, bom);
  const multi = fgIds.size > 1 || Number(bom.has_coproducts) === 1;
  let mode = String(body.product_scope != null ? body.product_scope : 'shared').toLowerCase().trim();
  if (mode !== 'shared' && mode !== 'exclusive') throw err('E_PRODUCT_SCOPE', 422, { product_scope: body.product_scope });
  if (!multi) return { product_scope: 'shared', scoped_product_id: null };
  let scoped = body.scoped_product_id != null && body.scoped_product_id !== ''
    ? Number(body.scoped_product_id) : null;
  if (mode === 'shared') return { product_scope: 'shared', scoped_product_id: null };
  if (!scoped || !Number.isFinite(scoped)) throw err('E_SCOPED_PRODUCT_REQUIRED', 422);
  if (!fgIds.has(scoped)) throw err('E_SCOPED_PRODUCT_NOT_IN_BOM', 422, { scoped_product_id: scoped });
  return { product_scope: 'exclusive', scoped_product_id: scoped };
}

function lineAppliesToProduct(L, forProductId) {
  if (forProductId == null) return true;
  const scope = String(L.product_scope || 'shared').toLowerCase();
  if (scope !== 'exclusive') return true;
  return Number(L.scoped_product_id) === Number(forProductId);
}

function explodeBom(db, {
  bomId, qty, sizeBreakdown = null, priceBasis = 'average', level = 0,
  yieldOverride = null, priceOverrides = null,   color = null, colorId = null,
  forProductId = null, qtyByProduct = null,
}) {
  if (level > 10) throw err('E_BOM_TOO_DEEP', 422);
  const bom = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
  if (!bom) throw err('E_NOT_FOUND', 404);
  const lines = db.prepare('SELECT * FROM bom_lines WHERE bom_id=? ORDER BY line_no').all(bomId);
  const factor = qty / (bom.base_qty || 1);
  const yieldPct = yieldOverride != null ? Number(yieldOverride) : (bom.yield_percent || 100);
  const yieldF = yieldPct / 100;
  if (yieldF <= 0) throw err('E_BOM_YIELD_RANGE', 422);
  const out = [];
  const chosen = resolveSubstitutes(db, lines, factor, yieldF);
  const breakdown = sizeBreakdown
    ? (typeof sizeBreakdown === 'string' ? safeJson(sizeBreakdown) : sizeBreakdown)
    : null;
  const fgColor = resolveFgColorName(db, { color, colorId, bom });

  for (const L of chosen) {
    if (!lineAppliesToProduct(L, forProductId)) continue;
    let qtyNet;
    const matrix = L.size_matrix ? safeJson(L.size_matrix) : null;
    if (matrix && breakdown) {
      qtyNet = Object.entries(breakdown).reduce((s, [size, cnt]) => {
        const per = matrix[size];
        if (per == null) return s + L.qty_per_base * Number(cnt);
        return s + Number(per) * Number(cnt);
      }, 0);
    } else if (Number(L.fixed_qty) > 0) {
      qtyNet = Number(L.fixed_qty);
    } else {
      const lineFactor = lineConsumptionFactor(bom, L, qty, qtyByProduct);
      qtyNet = Number(L.qty_per_base) * lineFactor;
    }

    const scrapF = 1 - (Number(L.scrap_percent) || 0) / 100;
    if (scrapF <= 0) throw err('E_BOM_SCRAP_RANGE', 422);
    const qtyGross = qtyNet / scrapF;
    const qtyFinal = round6(qtyGross / yieldF);
    const unitCost = getPrice(db, L.component_product_id, priceBasis, L, priceOverrides);
    const hint = buildComponentVariantHint(db, L, {
      qty: qtyFinal,
      sizeBreakdown: breakdown,
      fgColor,
    });
    out.push({
      line_no: L.line_no,
      bom_line_id: L.id,
      product_id: L.component_product_id,
      line_kind: L.line_type,
      stage_cost_center_id: L.stage_cost_center_id,
      product_scope: L.product_scope || 'shared',
      scoped_product_id: L.scoped_product_id || null,
      qty_net: round6(qtyNet),
      qty_gross: round6(qtyGross),
      qty_final: qtyFinal,
      scrap_percent: L.scrap_percent,
      unit_cost_rial: unitCost,
      amount_rial: Math.round(qtyFinal * unitCost),
      level,
      component_color_mode: normalizeColorMode(L.component_color_mode),
      component_color_id: L.component_color_id || null,
      variant_id: hint?.variant_id || null,
      variant_lines: hint?.variant_lines || null,
      size_matrix_applied: !!(matrix && breakdown),
    });

    const comp = db.prepare('SELECT is_manufactured FROM products WHERE id=?').get(L.component_product_id);
    if (bom.is_multilevel && comp?.is_manufactured) {
      try {
        const childBom = resolveBom(db, { productId: L.component_product_id, date: todayJalali() });
        const child = explodeBom(db, {
          bomId: childBom.id, qty: qtyFinal, priceBasis, level: level + 1, priceOverrides,
          color: fgColor, sizeBreakdown: breakdown, forProductId,
        });
        out.push(...child.lines.map(x => ({ ...x, parent_line_no: L.line_no })));
      } catch { /* no child bom — leaf */ }
    }
  }
  return { bom, factor, lines: out, totals: sumTotals(out), color: fgColor };
}

/** Path-based cycle detection (visited set on the current ancestry path).
 *  Depth alone is not enough — mid-graph cycles (A→B→C→B) must raise E_BOM_CIRCULAR.
 *  Diamond DAGs (shared child via two parents) remain valid because the child is not
 *  already on the *current* path. */
function detectCircular(db, rootProductId, bomId, depth = 0, path = []) {
  if (depth > 10) throw err('E_BOM_TOO_DEEP', 422);
  const lines = db.prepare('SELECT component_product_id FROM bom_lines WHERE bom_id=?').all(bomId);
  for (const l of lines) {
    const pid = l.component_product_id;
    if (pid === rootProductId || path.includes(pid)) {
      throw err('E_BOM_CIRCULAR', 422, { path: [...path, pid].join('→') });
    }
    const child = db.prepare(`
      SELECT id FROM bom_headers
      WHERE product_id=? AND status IN ('active','draft') AND deleted_at IS NULL
      ORDER BY status='active' DESC, version DESC LIMIT 1
    `).get(pid);
    if (child) detectCircular(db, rootProductId, child.id, depth + 1, [...path, pid]);
  }
}

/** Identity of a BOM line for duplicate detection.
 *  Same component may appear once per exclusive product (different consumption).
 *  Two shared rows, or two exclusive rows for the same product, are duplicates. */
function bomLineDupKey(L) {
  const comp = Number(L.component_product_id) || 0;
  const sub = String(L.substitute_group || '');
  const scope = String(L.product_scope || 'shared').toLowerCase() === 'exclusive' ? 'exclusive' : 'shared';
  const scoped = scope === 'exclusive' ? (Number(L.scoped_product_id) || 0) : 0;
  const colorMode = normalizeColorMode(L.component_color_mode);
  const colorId = colorMode === 'fixed' ? (Number(L.component_color_id) || 0) : 0;
  return `${comp}|${sub}|${scope}|${scoped}|${colorMode}|${colorId}`;
}

function assertBomLineUniqueness(lines) {
  const seen = new Map();
  const plainByComp = new Map();
  for (const L of lines || []) {
    const key = bomLineDupKey(L);
    if (seen.has(key)) {
      throw err('E_BOM_DUP_LINE', 422, {
        component_product_id: Number(L.component_product_id) || null,
        product_scope: L.product_scope || 'shared',
        scoped_product_id: L.scoped_product_id || null,
      });
    }
    seen.set(key, true);
    if (L.substitute_group) continue;
    const comp = Number(L.component_product_id) || 0;
    const bucket = plainByComp.get(comp) || [];
    bucket.push(L);
    plainByComp.set(comp, bucket);
  }
  for (const [comp, bucket] of plainByComp) {
    const hasShared = bucket.some((L) => String(L.product_scope || 'shared').toLowerCase() !== 'exclusive');
    const hasExclusive = bucket.some((L) => String(L.product_scope || 'shared').toLowerCase() === 'exclusive');
    if (hasShared && hasExclusive) {
      throw err('E_BOM_SCOPE_MIX', 422, { component_product_id: comp });
    }
  }
}

/** Scale factor for one line. With per-product qtys, exclusive uses that product
 *  and shared uses the sum (one piece of trim per garment, whichever model). */
function lineConsumptionFactor(bom, L, qty, qtyByProduct) {
  const base = Number(bom.base_qty) || 1;
  if (!qtyByProduct) return Number(qty) / base;
  const scope = String(L.product_scope || 'shared').toLowerCase();
  if (scope === 'exclusive' && L.scoped_product_id != null && L.scoped_product_id !== '') {
    const q = Number(qtyByProduct[L.scoped_product_id] ?? qtyByProduct[String(L.scoped_product_id)]) || 0;
    return q / base;
  }
  let sum = 0;
  for (const v of Object.values(qtyByProduct)) sum += Number(v) || 0;
  return sum / base;
}

function validateBom(db, bomId) {
  const b = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
  if (!b) throw err('E_NOT_FOUND', 404);
  const lines = db.prepare('SELECT * FROM bom_lines WHERE bom_id=?').all(bomId);

  // V-01
  if (!lines.some(l => l.line_type === 'material' || !l.line_type || l.line_type === '')) {
    if (!lines.length) throw err('E_BOM_EMPTY', 422);
    // allow packaging-only? Spec says at least one material
    if (!lines.some(l => (l.line_type || 'material') === 'material')) throw err('E_BOM_EMPTY', 422);
  }
  if (!lines.length) throw err('E_BOM_EMPTY', 422);

  // V-04
  const y = Number(b.yield_percent);
  if (!(y > 0 && y <= 100)) throw err('E_BOM_YIELD_RANGE', 422);

  // V-13
  if (b.bom_type === 'alternative' && !b.alt_of_bom_id) throw err('E_BOM_ALT_NO_PARENT', 422);

  // V-10
  if (b.valid_from && b.valid_to && b.valid_to < b.valid_from) throw err('E_BOM_DATE_ORDER', 422);

  const subGroups = {};
  for (const L of lines) {
    // V-02
    if (!(Number(L.qty_per_base) > 0 || Number(L.fixed_qty) > 0)) throw err('E_BOM_QTY_ZERO', 422);
    // V-03
    const scrap = Number(L.scrap_percent) || 0;
    if (scrap < 0 || scrap >= 100) throw err('E_BOM_SCRAP_RANGE', 422);
    // V-05
    if (L.component_product_id === b.product_id) throw err('E_BOM_SELF_REF', 422);
    // V-07 — uniqueness is per allocation, not per component id
    if (L.substitute_group) {
      (subGroups[L.substitute_group] ||= []).push(L);
    }
    // V-14
    if (L.size_matrix) {
      validateSizeMatrixKeys(db, b.product_id, L.size_matrix);
    }
    const cmode = normalizeColorMode(L.component_color_mode);
    if (cmode === 'fixed' && !L.component_color_id) {
      throw err('E_BOM_COMP_COLOR', 422, { line_no: L.line_no });
    }
    // V-15
    assertBomComponentType(db, L.component_product_id);
    // V-16
    if (L.stage_cost_center_id) {
      const cc = db.prepare('SELECT is_stage FROM cost_centers WHERE id=?').get(L.stage_cost_center_id);
      if (cc && !cc.is_stage) throw err('E_BOM_STAGE_INVALID', 422);
    }
  }
  assertBomLineUniqueness(lines);
  // V-17
  for (const [g, members] of Object.entries(subGroups)) {
    if (members.length < 2) throw err('E_BOM_SUB_SINGLE', 422, { group: g });
  }
  // V-06
  detectCircular(db, b.product_id, bomId);
  return true;
}

function assertDraft(b) {
  if (!b) throw err('E_NOT_FOUND', 404);
  if (b.status === 'active') throw err('E_BOM_LOCKED', 409);
  if (b.status !== 'draft') throw err('E_BOM_NOT_DRAFT', 409);
}

/**
 * ADR-006 / v472 — هر فرمول فقط یک محصول اصلی.
 * چندمحصولی فقط در سفارش (fg_plan / فرمول قدیمی) و لایه‌چینی مشترک.
 * فرعی/ضایعات (by/scrap) همچنان مجازند.
 */
function assertBomSingleMainCreate(body = {}) {
  const peerSrc = body.main_product_ids || body.peer_product_ids || body.co_product_ids;
  const peers = Array.isArray(peerSrc)
    ? peerSrc.map(Number).filter((n) => n && n !== Number(body.product_id))
    : [];
  const outputQtys = body.main_outputs || body.output_qtys;
  const outIds = Array.isArray(outputQtys)
    ? [...new Set(outputQtys.map((r) => Number(r?.product_id ?? r?.id)).filter((n) => n))]
    : [];
  const multiOut = outIds.length > 1
    || (outIds.length === 1 && Number(body.product_id) && outIds[0] !== Number(body.product_id));
  if (body.has_coproducts || peers.length || multiOut) {
    throw err('E_BOM_SINGLE_PRODUCT', 422, {
      detail: 'فرمول فقط یک محصول اصلی دارد. چند محصول را در سفارش تولید و لایه‌چینی مشترک تعریف کنید.',
    });
  }
}

function assertBomSingleMainUpdate(db, bom, body = {}) {
  const peerBody = body.main_product_ids || body.peer_product_ids || body.co_product_ids;
  if (!Array.isArray(peerBody) && body.has_coproducts == null) return;
  const peerIds = Array.isArray(peerBody)
    ? peerBody.map(Number).filter((n) => n && n !== Number(bom.product_id))
    : [];
  const wantMulti = body.has_coproducts != null ? !!body.has_coproducts : peerIds.length > 0;
  // اجازهٔ خاموش‌کردن چندمحصولی قدیمی (مهاجرت به تک‌محصول)
  if (!wantMulti && !peerIds.length) return;
  const alreadyMulti = isMultiproductBom(db, bom);
  if (alreadyMulti && peerIds.length) {
    // فقط همان peers موجود — افزودن peer جدید ممنوع
    const existing = new Set(
      db.prepare(`
        SELECT product_id FROM bom_outputs
        WHERE bom_id=? AND output_type IN ('main','co') AND product_id<>?
      `).all(bom.id, bom.product_id).map((r) => Number(r.product_id))
    );
    const extras = peerIds.filter((id) => !existing.has(id));
    if (extras.length) {
      throw err('E_BOM_SINGLE_PRODUCT', 422, {
        detail: 'افزودن محصول اصلی به فرمول ممنوع است. برای محصول جدید فرمول جدا بسازید؛ چندمحصولی در سفارش/لایه‌چینی است.',
        product_ids: extras,
      });
    }
    return;
  }
  if (wantMulti || peerIds.length) {
    throw err('E_BOM_SINGLE_PRODUCT', 422, {
      detail: 'فرمول فقط یک محصول اصلی دارد. چند محصول را در سفارش تولید و لایه‌چینی مشترک تعریف کنید.',
    });
  }
}

function createBom(db, body, userId) {
  return db.transaction(() => {
    const productId = body.product_id;
    if (!productId) throw err('E_VALIDATION', 400);
    assertBomSingleMainCreate(body);
    const code = allocateNumber(db, 'bom', 'BOM');
    const ver = body.version != null ? Number(body.version) : nextBomVersion(db, productId);
    const revision = (body.revision && String(body.revision).trim()) || 'A';
    // Avoid UNIQUE(product_id, version, revision) — check ALL rows (incl. deleted under legacy index)
    let version = ver;
    let tries = 0;
    while (tries < 50) {
      const clash = db.prepare(
        'SELECT 1 FROM bom_headers WHERE product_id=? AND version=? AND revision=?'
      ).get(productId, version, revision);
      if (!clash) break;
      version += 1;
      tries += 1;
    }
    let id;
    try {
      const info = db.prepare(`
        INSERT INTO bom_headers (
          code, product_id, version, revision, name, bom_type, alt_of_bom_id, alt_reason,
          base_qty, unit_id, status, valid_from, valid_to, is_default,
          is_multilevel, has_routing, has_coproducts, yield_percent,
          size_range, color_variant, color_id, note, created_by
        ) VALUES (?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        code, productId, version, revision, body.name || '',
        body.bom_type || 'standard', body.alt_of_bom_id || null, body.alt_reason || '',
        body.base_qty != null ? body.base_qty : 1, body.unit_id || null,
        body.valid_from || '', body.valid_to || '', body.is_default ? 1 : 0,
        body.is_multilevel ? 1 : 0, body.has_routing ? 1 : 0, body.has_coproducts ? 1 : 0,
        body.has_routing ? 100 : (body.yield_percent != null ? body.yield_percent : 100),
        body.size_range || '', body.color_variant || '', body.color_id || null,
        body.note || '', userId || null
      );
      id = info.lastInsertRowid;
    } catch (e) {
      rethrowBomConstraint(e);
    }
    // تک‌محصول: فقط ردیف خروجی لنگر (در صورت ارسال main_outputs تک‌عضوی)
    const outputQtys = body.main_outputs || body.output_qtys || null;
    if (Array.isArray(outputQtys) && outputQtys.length) {
      const { ensureShareOutputs } = require('./bom-advanced');
      ensureShareOutputs(db, id, {
        mainProductId: productId,
        peerProductIds: [],
        autoShare: null,
        outputQtys: outputQtys.filter((r) => Number(r?.product_id ?? r?.id) === Number(productId)),
      });
    }
    if (Array.isArray(body.lines)) {
      for (const L of body.lines) addLine(db, id, L, userId, { skipLock: true });
    }
    logBomChange(db, id, 'create', { code }, userId);
    audit(userId, 'create', 'bom', id, `ایجاد فرمول ${code}`);
    return { id, code, version, revision, status: 'draft' };
  })();
}

function updateBomHeader(db, bomId, body, userId) {
  return db.transaction(() => {
    const b = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
    assertDraft(b);
    db.prepare(`
      UPDATE bom_headers SET name=?, base_qty=?, yield_percent=?, size_range=?, color_variant=?,
        color_id=?, note=?, valid_from=?, valid_to=?, is_default=?, unit_id=?
      WHERE id=?
    `).run(
      body.name != null ? body.name : b.name,
      body.base_qty != null ? body.base_qty : b.base_qty,
      body.yield_percent != null ? body.yield_percent : b.yield_percent,
      body.size_range != null ? body.size_range : b.size_range,
      body.color_variant != null ? body.color_variant : b.color_variant,
      body.color_id !== undefined ? (body.color_id || null) : b.color_id,
      body.note != null ? body.note : b.note,
      body.valid_from != null ? body.valid_from : b.valid_from,
      body.valid_to != null ? body.valid_to : b.valid_to,
      body.is_default != null ? (body.is_default ? 1 : 0) : b.is_default,
      body.unit_id != null ? body.unit_id : b.unit_id,
      bomId
    );
    // v472: قفل تک‌محصول؛ فقط خاموش‌کردن چندمحصولی قدیمی یا نگهداشت peers موجود (بدون افزودن)
    assertBomSingleMainUpdate(db, b, body);
    const peerBody = body.main_product_ids || body.peer_product_ids || body.co_product_ids;
    if (Array.isArray(peerBody) || body.has_coproducts != null) {
      const peerIds = Array.isArray(peerBody)
        ? peerBody.map(Number).filter(n => n && n !== Number(b.product_id))
        : [];
      const wantMulti = body.has_coproducts != null
        ? !!body.has_coproducts
        : peerIds.length > 0;
      if (!wantMulti && !peerIds.length) {
        db.prepare('UPDATE bom_headers SET has_coproducts=0 WHERE id=?').run(bomId);
      } else if (wantMulti || peerIds.length) {
        db.prepare('UPDATE bom_headers SET has_coproducts=? WHERE id=?').run(wantMulti ? 1 : 0, bomId);
        const { ensureShareOutputs } = require('./bom-advanced');
        ensureShareOutputs(db, bomId, {
          mainProductId: b.product_id,
          peerProductIds: peerIds,
          autoShare: body.auto_share_method || null,
          allowLegacyPeers: true,
        });
      }
    }
    logBomChange(db, bomId, 'header_edit', { after: body }, userId);
    audit(userId, 'edit', 'bom', bomId, `ویرایش فرمول ${b.code}`);
    return getBom(db, bomId);
  })();
}

function countOpenOrdersForBom(db, bomId) {
  return db.prepare(`
    SELECT COUNT(*) c FROM production_orders
    WHERE bom_id=? AND status IN ('draft','released','in_progress')
  `).get(bomId).c;
}

/** پیش‌نمایش وابستگی برای ویرایش/حذف حرفه‌ای (بدون mutate) */
function getBomDependencies(db, bomId) {
  const b = db.prepare(`
    SELECT bh.*, p.name AS product_name, p.default_bom_id AS product_default_bom_id
    FROM bom_headers bh
    LEFT JOIN products p ON p.id = bh.product_id
    WHERE bh.id=? AND bh.deleted_at IS NULL
  `).get(bomId);
  if (!b) throw err('E_NOT_FOUND', 404);

  const openOrders = db.prepare(`
    SELECT id, order_no, status, qty_planned, date, product_id
    FROM production_orders
    WHERE bom_id=? AND status IN ('draft','released','in_progress')
    ORDER BY id DESC
    LIMIT 50
  `).all(bomId);
  const openCount = countOpenOrdersForBom(db, bomId);
  const closedOrderCount = db.prepare(`
    SELECT COUNT(*) c FROM production_orders
    WHERE bom_id=? AND status NOT IN ('draft','released','in_progress')
  `).get(bomId).c;
  const isDefault = Number(b.product_default_bom_id) === Number(bomId);

  const blockers = [];
  if (openCount > 0) {
    blockers.push({
      code: 'E_BOM_IN_USE',
      message: `این فرمول در ${openCount} سفارش تولید باز استفاده شده و قابل بایگانی/حذف نیست.`,
      n: openCount,
    });
  }

  const can = {
    view: true,
    edit_inplace: b.status === 'draft',
    version_up: b.status === 'active',
    soft_delete: b.status === 'draft' && openCount === 0,
    archive: (b.status === 'active' || b.status === 'draft') && openCount === 0,
    deactivate: b.status === 'active' && openCount === 0,
  };

  let editMode = 'view_only';
  if (can.edit_inplace) editMode = 'inplace';
  else if (can.version_up) editMode = 'version_up';

  let removeMode = 'none';
  if (can.soft_delete) removeMode = 'soft_delete';
  else if (can.archive) removeMode = 'archive';
  else if (b.status === 'archived') removeMode = 'already_archived';
  else if (openCount > 0) removeMode = 'blocked';

  return {
    id: b.id,
    code: b.code,
    name: b.name,
    status: b.status,
    version: b.version,
    revision: b.revision,
    product_id: b.product_id,
    product_name: b.product_name,
    is_default: isDefault ? 1 : 0,
    open_orders: openOrders,
    open_count: openCount,
    closed_order_count: closedOrderCount,
    can,
    blockers,
    actions: { edit: editMode, remove: removeMode },
  };
}

function softDeleteBom(db, bomId, userId) {
  return db.transaction(() => {
    const b = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
    assertDraft(b);
    const open = countOpenOrdersForBom(db, bomId);
    if (open) throw err('E_BOM_IN_USE', 409, { n: open });
    try {
      const tombVer = 1_000_000 + Number(bomId);
      const base = String(b.code || 'BOM');
      const tombCode = base.includes('__del') ? `${base}_${bomId}` : `${base}__del${bomId}`;
      db.prepare(`
        UPDATE bom_headers
        SET deleted_at=?, status='obsolete', version=?, revision='DEL', code=?
        WHERE id=?
      `).run(nowUnix(), tombVer, tombCode, bomId);
    } catch (e) {
      rethrowBomConstraint(e);
    }
    clearDefaultBomPointers(db, bomId, b.product_id);
    audit(userId, 'delete', 'bom', bomId, `حذف پیش‌نویس ${b.code}`);
    return { ok: true };
  })();
}

function addLine(db, bomId, body, userId, opts = {}) {
  const run = () => {
    const b = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
    if (!opts.skipLock) assertDraft(b);
    if (body.component_product_id === b.product_id) throw err('E_BOM_SELF_REF', 422);
    assertBomComponentType(db, body.component_product_id);
    const scrap = Number(body.scrap_percent) || 0;
    if (scrap < 0 || scrap >= 100) throw err('E_BOM_SCRAP_RANGE', 422);
    const colorMode = normalizeColorMode(body.component_color_mode);
    if (colorMode === 'fixed' && !(body.component_color_id || null)) {
      throw err('E_BOM_COMP_COLOR', 422);
    }
    let sizeMatrixStr = '';
    if (body.size_matrix) {
      const m = validateSizeMatrixKeys(db, b.product_id, body.size_matrix);
      sizeMatrixStr = JSON.stringify(m);
    }
    const scope = normalizeProductScope(db, b, body);
    const maxLine = db.prepare('SELECT COALESCE(MAX(line_no),0) m FROM bom_lines WHERE bom_id=?').get(bomId).m;
    const info = db.prepare(`
      INSERT INTO bom_lines (
        bom_id, line_no, component_product_id, qty_per_base, unit_id, scrap_percent, fixed_qty,
        line_type, stage_cost_center_id, backflush, is_optional, substitute_group, substitute_priority,
        size_matrix, component_color_mode, component_color_id,
        product_scope, scoped_product_id, std_cost_rial, note
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      bomId,
      body.line_no || maxLine + 1,
      body.component_product_id,
      body.qty_per_base != null ? body.qty_per_base : 0,
      body.unit_id || null,
      scrap,
      body.fixed_qty || 0,
      body.line_type || 'material',
      body.stage_cost_center_id || null,
      body.backflush != null ? (body.backflush ? 1 : 0) : 1,
      body.is_optional ? 1 : 0,
      body.substitute_group || '',
      body.substitute_priority || 0,
      sizeMatrixStr,
      colorMode,
      body.component_color_id || null,
      scope.product_scope,
      scope.scoped_product_id,
      body.std_cost_rial || 0,
      body.note || ''
    );
    if (!opts.skipLock) {
      logBomChange(db, bomId, 'line_add', { lineId: info.lastInsertRowid }, userId);
      audit(userId, 'edit', 'bom', bomId, 'افزودن قلم فرمول');
    }
    return { id: info.lastInsertRowid };
  };
  return opts.skipLock ? run() : db.transaction(run)();
}

function updateLine(db, bomId, lineId, body, userId) {
  return db.transaction(() => {
    const b = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
    assertDraft(b);
    const L = db.prepare('SELECT * FROM bom_lines WHERE id=? AND bom_id=?').get(lineId, bomId);
    if (!L) throw err('E_NOT_FOUND', 404);
    if (body.component_product_id === b.product_id) throw err('E_BOM_SELF_REF', 422);
    const nextCompId = body.component_product_id != null ? body.component_product_id : L.component_product_id;
    assertBomComponentType(db, nextCompId);
    const scrap = body.scrap_percent != null ? Number(body.scrap_percent) : L.scrap_percent;
    if (scrap < 0 || scrap >= 100) throw err('E_BOM_SCRAP_RANGE', 422);
    const colorMode = body.component_color_mode != null
      ? normalizeColorMode(body.component_color_mode)
      : normalizeColorMode(L.component_color_mode);
    const colorId = body.component_color_id !== undefined
      ? (body.component_color_id || null)
      : L.component_color_id;
    if (colorMode === 'fixed' && !colorId) throw err('E_BOM_COMP_COLOR', 422);
    let sizeMatrix = L.size_matrix;
    if (body.size_matrix != null) {
      if (body.size_matrix === '' || body.size_matrix === null) sizeMatrix = '';
      else {
        const m = validateSizeMatrixKeys(db, b.product_id, body.size_matrix);
        sizeMatrix = JSON.stringify(m);
      }
    }
    const scopeBody = (body.product_scope != null || body.scoped_product_id !== undefined)
      ? {
        product_scope: body.product_scope != null ? body.product_scope : L.product_scope,
        scoped_product_id: body.scoped_product_id !== undefined ? body.scoped_product_id : L.scoped_product_id,
      }
      : { product_scope: L.product_scope || 'shared', scoped_product_id: L.scoped_product_id };
    const scope = normalizeProductScope(db, b, scopeBody);
    db.prepare(`
      UPDATE bom_lines SET
        component_product_id=?, qty_per_base=?, unit_id=?, scrap_percent=?, fixed_qty=?,
        line_type=?, stage_cost_center_id=?, backflush=?, is_optional=?,
        substitute_group=?, substitute_priority=?, size_matrix=?,
        component_color_mode=?, component_color_id=?,
        product_scope=?, scoped_product_id=?, std_cost_rial=?, note=?
      WHERE id=?
    `).run(
      body.component_product_id != null ? body.component_product_id : L.component_product_id,
      body.qty_per_base != null ? body.qty_per_base : L.qty_per_base,
      body.unit_id != null ? body.unit_id : L.unit_id,
      scrap,
      body.fixed_qty != null ? body.fixed_qty : L.fixed_qty,
      body.line_type != null ? body.line_type : L.line_type,
      body.stage_cost_center_id != null ? body.stage_cost_center_id : L.stage_cost_center_id,
      body.backflush != null ? (body.backflush ? 1 : 0) : L.backflush,
      body.is_optional != null ? (body.is_optional ? 1 : 0) : L.is_optional,
      body.substitute_group != null ? body.substitute_group : L.substitute_group,
      body.substitute_priority != null ? body.substitute_priority : L.substitute_priority,
      sizeMatrix,
      colorMode,
      colorId,
      scope.product_scope,
      scope.scoped_product_id,
      body.std_cost_rial != null ? body.std_cost_rial : L.std_cost_rial,
      body.note != null ? body.note : L.note,
      lineId
    );
    logBomChange(db, bomId, 'line_edit', { lineId }, userId);
    return { ok: true };
  })();
}

function deleteLine(db, bomId, lineId, userId) {
  return db.transaction(() => {
    const b = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
    assertDraft(b);
    db.prepare('DELETE FROM bom_lines WHERE id=? AND bom_id=?').run(lineId, bomId);
    logBomChange(db, bomId, 'line_del', { lineId }, userId);
    return { ok: true };
  })();
}

/** جایگزینی اتمیک همهٔ اقلام پیش‌نویس — یک تراکنش */
function replaceLines(db, bomId, lines, userId) {
  return db.transaction(() => {
    const b = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
    assertDraft(b);
    const existing = db.prepare('SELECT id FROM bom_lines WHERE bom_id=?').all(bomId);
    for (const row of existing) {
      db.prepare('DELETE FROM bom_lines WHERE id=? AND bom_id=?').run(row.id, bomId);
    }
    const out = [];
    for (const L of lines) {
      out.push(addLine(db, bomId, L, userId, { skipLock: true }));
    }
    assertBomLineUniqueness(db.prepare('SELECT * FROM bom_lines WHERE bom_id=?').all(bomId));
    logBomChange(db, bomId, 'lines_replace', { count: out.length }, userId);
    audit(userId, 'edit', 'bom', bomId, `جایگزینی ${out.length} قلم فرمول`);
    return { ok: true, count: out.length, ids: out.map(x => x.id) };
  })();
}

function activateBom(db, bomId, validFrom, userId) {
  return db.transaction(() => {
    try {
      const b = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
      if (!b) throw err('E_NOT_FOUND', 404);
      if (b.status !== 'draft') throw err('E_BOM_NOT_DRAFT', 409);
      if (!validFrom) throw err('E_VALIDATION', 400);
      validateBom(db, bomId);

      // v421 — essential product specs + BOM readiness (FG/co/components)
      const { assertBomReady } = require('./product-completeness');
      assertBomReady(db, bomId, 'activate');

      // V4-21 / advanced gates: routing or ops/outputs must pass validateAdvancedBom
      // (lazy require — bom-advanced already requires ./bom)
      const hasOps = db.prepare('SELECT 1 FROM bom_operations WHERE bom_id=? LIMIT 1').get(bomId);
      const hasOuts = db.prepare('SELECT 1 FROM bom_outputs WHERE bom_id=? LIMIT 1').get(bomId);
      if (b.has_routing || hasOps || hasOuts || b.has_coproducts) {
        const { validateAdvancedBom, ensureMainOutputRow } = require('./bom-advanced');
        if (b.has_coproducts || hasOuts) ensureMainOutputRow(db, bomId);
        validateAdvancedBom(db, bomId);
      }

      const prev = db.prepare(`
        SELECT * FROM bom_headers
        WHERE product_id=? AND bom_type=? AND status='active' AND id<>? AND deleted_at IS NULL
      `).get(b.product_id, b.bom_type, bomId);

      if (prev) {
        if (prev.valid_from && prev.valid_from >= validFrom) {
          throw err('E_BOM_OVERLAP', 409, { prev: prev.version });
        }
        const validTo = addDaysToJalali(validFrom, -1);
        db.prepare("UPDATE bom_headers SET valid_to=?, status='archived' WHERE id=?")
          .run(validTo, prev.id);
        logBomChange(db, prev.id, 'archive', { reason: `جایگزینی با نسخه ${b.version}` }, userId);
      }

      const isDefault = prev ? prev.is_default : 1;
      db.prepare(`
        UPDATE bom_headers SET status='active', valid_from=?, is_default=?, approved_by=?, approved_at=?
        WHERE id=?
      `).run(validFrom, isDefault, userId, nowUnix(), bomId);

      if (!prev || prev.is_default) {
        db.prepare('UPDATE products SET default_bom_id=? WHERE id=?').run(bomId, b.product_id);
      }

      // Multi-output: point peer mains' default_bom when this share BOM is their sole active
      const outs = db.prepare(`
        SELECT product_id FROM bom_outputs WHERE bom_id=? AND output_type IN ('main','co')
      `).all(bomId);
      for (const o of outs) {
        if (Number(o.product_id) === Number(b.product_id)) continue;
        const hasOwn = db.prepare(`
          SELECT 1 FROM bom_headers
          WHERE product_id=? AND status='active' AND deleted_at IS NULL AND id<>?
          LIMIT 1
        `).get(o.product_id, bomId);
        if (!hasOwn) {
          db.prepare('UPDATE products SET default_bom_id=? WHERE id=?').run(bomId, o.product_id);
        }
      }

      logBomChange(db, bomId, 'activate', { valid_from: validFrom }, userId);
      audit(userId, 'approve', 'bom', bomId, `فعال‌سازی فرمول ${b.code} نسخه ${b.version}`);
      emit(db, 'bom.activated', {
        bomId, productId: b.product_id, version: b.version, validFrom, prevBomId: prev?.id,
      });
      return { ok: true, bomId, archivedPrev: prev?.id || null };
    } catch (e) {
      rethrowBomConstraint(e);
    }
  })();
}

/** Clear products.default_bom_id for every FG (anchor + peer mains) pointing at this BOM. */
function clearDefaultBomPointers(db, bomId, headerProductId) {
  const ids = new Set([Number(headerProductId)]);
  const outs = db.prepare(`
    SELECT product_id FROM bom_outputs WHERE bom_id=? AND output_type IN ('main','co')
  `).all(bomId);
  for (const o of outs) ids.add(Number(o.product_id));
  const clear = db.prepare('UPDATE products SET default_bom_id=NULL WHERE id=? AND default_bom_id=?');
  for (const pid of ids) clear.run(pid, bomId);
}

function deactivateBom(db, bomId, userId) {
  return db.transaction(() => {
    const b = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
    if (!b || b.status !== 'active') throw err('E_BOM_NOT_ACTIVE', 409);
    const open = countOpenOrdersForBom(db, bomId);
    if (open) throw err('E_BOM_IN_USE', 409, { n: open });
    db.prepare("UPDATE bom_headers SET status='draft' WHERE id=?").run(bomId);
    clearDefaultBomPointers(db, bomId, b.product_id);
    audit(userId, 'edit', 'bom', bomId, `غیرفعال‌سازی ${b.code}`);
    return { ok: true };
  })();
}

function archiveBom(db, bomId, reason, userId) {
  return db.transaction(() => {
    const b = db.prepare('SELECT * FROM bom_headers WHERE id=? AND deleted_at IS NULL').get(bomId);
    if (!b) throw err('E_NOT_FOUND', 404);
    if (b.status === 'archived') return { ok: true, already: true };
    if (b.status === 'obsolete') throw err('E_NOT_FOUND', 404);
    if (b.status !== 'active' && b.status !== 'draft') {
      throw err('E_BOM_NOT_DRAFT', 409);
    }
    const open = countOpenOrdersForBom(db, bomId);
    if (open) throw err('E_BOM_IN_USE', 409, { n: open });
    db.prepare("UPDATE bom_headers SET status='archived' WHERE id=?").run(bomId);
    clearDefaultBomPointers(db, bomId, b.product_id);
    logBomChange(db, bomId, 'archive', { reason: reason || '' }, userId);
    audit(userId, 'edit', 'bom', bomId, `بایگانی ${b.code}`);
    return { ok: true };
  })();
}

function copyChildRows(db, table, fromBomId, toBomId) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
    .map(c => c.name)
    .filter(n => n !== 'id');
  const srcCols = cols.filter(c => c !== 'bom_id');
  const sql = `
    INSERT INTO ${table} (bom_id, ${srcCols.join(',')})
    SELECT ?, ${srcCols.join(',')} FROM ${table} WHERE bom_id=?
  `;
  db.prepare(sql).run(toBomId, fromBomId);
}

function versionUpBom(db, bomId, reason, userId) {
  return db.transaction(() => {
    const old = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
    if (!old) throw err('E_NOT_FOUND', 404);
    if (old.status !== 'active') throw err('E_ONLY_ACTIVE_CAN_VERSION_UP', 409);

    let version = nextBomVersion(db, old.product_id);
    const revision = nextRev(old.revision);
    // Ensure unique pair
    while (db.prepare(
      'SELECT 1 FROM bom_headers WHERE product_id=? AND version=? AND revision=?'
    ).get(old.product_id, version, revision)) {
      version += 1;
    }

    const code = allocateNumber(db, 'bom', 'BOM');
    let newId;
    try {
      const info = db.prepare(`
        INSERT INTO bom_headers (
          code, product_id, version, revision, name, bom_type, alt_of_bom_id,
          base_qty, unit_id, status, is_default, is_multilevel, has_routing, has_coproducts,
          yield_percent, size_range, color_variant, note, created_by
        ) VALUES (?,?,?,?,?,?,?,?,?,'draft',0,?,?,?,?,?,?,?,?)
      `).run(
        code, old.product_id, version, revision, old.name, old.bom_type,
        old.alt_of_bom_id, old.base_qty, old.unit_id,
        old.is_multilevel, old.has_routing, old.has_coproducts,
        old.yield_percent, old.size_range, old.color_variant,
        `نسخه‌برداری از v${old.version} — ${reason || ''}`, userId
      );
      newId = info.lastInsertRowid;
    } catch (e) {
      rethrowBomConstraint(e);
    }
    copyChildRows(db, 'bom_lines', bomId, newId);
    copyChildRows(db, 'bom_operations', bomId, newId);
    copyChildRows(db, 'bom_outputs', bomId, newId);
    logBomChange(db, newId, 'version_up', { from: bomId, reason }, userId);
    emit(db, 'bom.version_up', { oldBomId: bomId, newBomId: newId, reason });
    audit(userId, 'create', 'bom', newId, `نسخه جدید ${code}`);
    return { id: newId, code, version, revision };
  })();
}

function cloneBom(db, bomId, { product_id, name }, userId) {
  return db.transaction(() => {
    const old = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
    if (!old) throw err('E_NOT_FOUND', 404);
    if (!product_id) throw err('E_VALIDATION', 400);
    const code = allocateNumber(db, 'bom', 'BOM');
    const version = nextBomVersion(db, product_id);
    const info = db.prepare(`
      INSERT INTO bom_headers (
        code, product_id, version, revision, name, bom_type,
        base_qty, unit_id, status, is_default, is_multilevel, has_routing, has_coproducts,
        yield_percent, size_range, color_variant, note, created_by
      ) VALUES (?,?,?,'A',?,'standard',?,?,'draft',0,?,?,?,?,?,?,?,?)
    `).run(
      code, product_id, version, name || old.name, old.base_qty, old.unit_id,
      old.is_multilevel, old.has_routing, old.has_coproducts,
      old.yield_percent, old.size_range, old.color_variant, old.note, userId
    );
    const newId = info.lastInsertRowid;
    copyChildRows(db, 'bom_lines', bomId, newId);
    copyChildRows(db, 'bom_operations', bomId, newId);
    copyChildRows(db, 'bom_outputs', bomId, newId);
    audit(userId, 'create', 'bom', newId, `کپی فرمول ${code}`);
    return { id: newId, code, version, status: 'draft' };
  })();
}

function createAlternative(db, bomId, reason, userId) {
  return db.transaction(() => {
    const old = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
    if (!old) throw err('E_NOT_FOUND', 404);
    if (old.bom_type !== 'standard') throw err('E_BOM_ALT_CHAIN', 422);
    const code = allocateNumber(db, 'bom', 'BOM');
    let version = nextBomVersion(db, old.product_id);
    const revision = 'A';
    while (db.prepare(
      'SELECT 1 FROM bom_headers WHERE product_id=? AND version=? AND revision=?'
    ).get(old.product_id, version, revision)) {
      version += 1;
    }
    let newId;
    try {
      const info = db.prepare(`
        INSERT INTO bom_headers (
          code, product_id, version, revision, name, bom_type, alt_of_bom_id, alt_reason,
          base_qty, unit_id, status, yield_percent, size_range, color_variant, color_id, created_by
        ) VALUES (?,?,?,?,?,'alternative',?,?,?,?,'draft',?,?,?,?,?)
      `).run(
        code, old.product_id, version, revision, (old.name || '') + ' (جایگزین)', bomId, reason || '',
        old.base_qty, old.unit_id, old.yield_percent, old.size_range || '',
        old.color_variant || '', old.color_id || null, userId
      );
      newId = info.lastInsertRowid;
    } catch (e) {
      rethrowBomConstraint(e);
    }
    copyChildRows(db, 'bom_lines', bomId, newId);
    return { id: newId, code, version, status: 'draft' };
  })();
}

function getBom(db, bomId) {
  const bom = db.prepare('SELECT * FROM bom_headers WHERE id=? AND deleted_at IS NULL').get(bomId);
  if (!bom) throw err('E_NOT_FOUND', 404);
  const lines = db.prepare(`
    SELECT bl.*, p.name AS product_name, p.item_type,
           sp.name AS scoped_product_name
    FROM bom_lines bl
    LEFT JOIN products p ON p.id=bl.component_product_id
    LEFT JOIN products sp ON sp.id=bl.scoped_product_id
    WHERE bl.bom_id=? ORDER BY bl.line_no
  `).all(bomId);
  const operations = db.prepare(`
    SELECT op.*, sp.name AS scoped_product_name
    FROM bom_operations op
    LEFT JOIN products sp ON sp.id=op.scoped_product_id
    WHERE op.bom_id=? ORDER BY op.seq
  `).all(bomId);
  const outputs = db.prepare(`
    SELECT o.*, p.name AS product_name
    FROM bom_outputs o LEFT JOIN products p ON p.id=o.product_id
    WHERE o.bom_id=?
  `).all(bomId);
  const fgIds = [...bomFgProductIds(db, bom)];
  const fg_products = fgIds.map(id => {
    const p = db.prepare('SELECT id, name, code FROM products WHERE id=?').get(id);
    // v423: all FGs are peer mains; is_anchor marks technical scale product only
    const isAnchor = Number(id) === Number(bom.product_id);
    return p
      ? { id: p.id, name: p.name, code: p.code || null, role: 'main', is_anchor: isAnchor }
      : { id, name: '#' + id, code: null, role: 'main', is_anchor: isAnchor };
  });
  return {
    ...bom,
    lines,
    operations,
    outputs,
    fg_products,
    is_multiproduct: fg_products.length > 1 || Number(bom.has_coproducts) === 1,
  };
}

function listBoms(db, q = {}) {
  const where = ['bh.deleted_at IS NULL'];
  const params = [];
  // for_product_id: سرفصل یا هم‌محصول (main/co) یا default_bom_id — برای انتخاب فرمول در سفارش
  const forPid = q.for_product_id != null && q.for_product_id !== ''
    ? Number(q.for_product_id)
    : (q.product_id != null && q.product_id !== '' && String(q.include_co || '') === '1'
      ? Number(q.product_id)
      : null);
  if (forPid) {
    where.push(`(
      bh.product_id=?
      OR bh.id IN (
        SELECT o.bom_id FROM bom_outputs o
        WHERE o.product_id=? AND o.output_type IN ('main','co')
      )
      OR bh.id IN (
        SELECT p.default_bom_id FROM products p
        WHERE p.id=? AND p.default_bom_id IS NOT NULL
      )
    )`);
    params.push(forPid, forPid, forPid);
  } else if (q.product_id) {
    where.push('bh.product_id=?');
    params.push(q.product_id);
  }
  if (q.status) { where.push('bh.status=?'); params.push(q.status); }
  if (q.bom_type) { where.push('bh.bom_type=?'); params.push(q.bom_type); }
  if (q.search) {
    where.push('(bh.code LIKE ? OR bh.name LIKE ?)');
    params.push('%' + q.search + '%', '%' + q.search + '%');
  }
  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(100, Number(q.limit) || 50);
  const offset = (page - 1) * limit;
  const rows = db.prepare(`
    SELECT bh.*, p.name AS product_name
    FROM bom_headers bh LEFT JOIN products p ON p.id=bh.product_id
    WHERE ${where.join(' AND ')}
    ORDER BY bh.id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const total = db.prepare(`
    SELECT COUNT(*) c FROM bom_headers bh WHERE ${where.join(' AND ')}
  `).get(...params).c;
  return { rows, total, page, limit };
}

function whereUsed(db, productId) {
  return db.prepare(`
    SELECT bh.id, bh.code, bh.version, bh.status, bh.product_id, p.name AS product_name, bl.qty_per_base
    FROM bom_lines bl
    JOIN bom_headers bh ON bh.id=bl.bom_id
    JOIN products p ON p.id=bh.product_id
    WHERE bl.component_product_id=? AND bh.deleted_at IS NULL
    ORDER BY bh.code
  `).all(productId);
}

function stdCost(db, bomId, { qty = 1, priceBasis = 'average' } = {}) {
  const exploded = explodeBom(db, { bomId, qty, priceBasis });
  const unit = qty > 0 ? Math.round(exploded.totals.total_rial / qty) : 0;
  return {
    ...exploded.totals,
    unit_rial: unit,
    qty,
    lines: exploded.lines,
  };
}

function compareBoms(db, aId, bId) {
  const a = getBom(db, aId);
  const b = getBom(db, bId);
  const mapA = new Map(a.lines.map(l => [l.component_product_id, l]));
  const mapB = new Map(b.lines.map(l => [l.component_product_id, l]));
  const ids = new Set([...mapA.keys(), ...mapB.keys()]);
  const diff = [];
  for (const id of ids) {
    const la = mapA.get(id);
    const lb = mapB.get(id);
    if (!la) diff.push({ type: 'added', product_id: id, b: lb });
    else if (!lb) diff.push({ type: 'removed', product_id: id, a: la });
    else if (la.qty_per_base !== lb.qty_per_base || la.scrap_percent !== lb.scrap_percent) {
      diff.push({ type: 'changed', product_id: id, a: la, b: lb });
    }
  }
  return { a: { id: aId, code: a.code, version: a.version }, b: { id: bId, code: b.code, version: b.version }, diff };
}

function bomTree(db, bomId, level = 0) {
  const bom = getBom(db, bomId);
  return {
    ...bom,
    level,
    children: bom.lines.map(l => {
      const child = db.prepare(`
        SELECT id FROM bom_headers WHERE product_id=? AND status='active' AND deleted_at IS NULL
        ORDER BY is_default DESC LIMIT 1
      `).get(l.component_product_id);
      return child ? bomTree(db, child.id, level + 1) : { product_id: l.component_product_id, leaf: true, line: l };
    }),
  };
}

function assertProductNotInBom(db, productId) {
  const n = db.prepare('SELECT COUNT(*) c FROM bom_lines WHERE component_product_id=?').get(productId).c;
  if (n) {
    const e = err('E_PRODUCT_IN_BOM', 409, { n });
    throw e;
  }
}

module.exports = {
  err, resolveBom, explodeBom, resolveSubstitutes, getPrice,
  validateBom, detectCircular, assertBomComponentType,
  activateBom, deactivateBom, archiveBom, versionUpBom, cloneBom, createAlternative,
  createBom, updateBomHeader, softDeleteBom, addLine, updateLine, deleteLine, replaceLines,
  getBom, getBomDependencies, listBoms, whereUsed, stdCost, compareBoms, bomTree, logBomChange,
  assertProductNotInBom, round6,
  allowedSizeNamesForProduct, validateSizeMatrixKeys,
  buildComponentVariantHint, normalizeColorMode, resolveFgColorName,
  bomFgProductIds, normalizeProductScope, lineAppliesToProduct,
  assertBomLineUniqueness, lineConsumptionFactor,
  assertProductInBomFg, isMultiproductBom, explodeProductScopeForOrder, planBomFgOutputs,
  orderQtyAsMainBase, explodeQtyForOrder, orderFgQtyMap, orderFgPlanRows, parseFgPlanJson,
};
