'use strict';
/**
 * v421/v422 — Product essentials + BOM production readiness (computed, no new tables).
 * Hard gates: activate / createOrder / release / issue / finalize.
 * Soft: warehouse, category, polish fields; waive can relax code/cost only.
 */
const { CONTINUOUS_UNIT_RE, hasActiveMatrixVariants } = require('../inventory/qty-policy');

function err(code, status = 422, extra = {}) {
  const e = new Error(code);
  e.code = code;
  e.status = status;
  e.extra = extra;
  return e;
}

function tableExists(db, name) {
  try {
    return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  } catch (_) {
    return false;
  }
}

function classifyKind(p) {
  const t = String(p?.item_type || 'finished').toLowerCase();
  const mfg = Number(p?.is_manufactured) === 1;
  const unit = String(p?.unit || '');
  if (t === 'finished' && mfg) return 'fg';
  if (t === 'semi' && mfg) return 'semi';
  if (t === 'finished' && !mfg) return 'trade';
  if (t === 'packaging') return 'packaging';
  if (t === 'scrap') return 'scrap';
  if (t === 'service') return 'service';
  if ((t === 'raw' || t === 'material') && CONTINUOUS_UNIT_RE.test(unit)) return 'fabric';
  if (t === 'raw' || t === 'material') return 'raw';
  return t || 'other';
}

function countStyleColors(db, productId) {
  if (!tableExists(db, 'product_style_colors')) return 0;
  return Number(db.prepare(
    'SELECT COUNT(*) AS c FROM product_style_colors WHERE product_id=?'
  ).get(productId)?.c || 0);
}

function countStyleSizes(db, productId) {
  if (!tableExists(db, 'product_style_sizes')) return 0;
  return Number(db.prepare(
    'SELECT COUNT(*) AS c FROM product_style_sizes WHERE product_id=?'
  ).get(productId)?.c || 0);
}

function countActiveVariants(db, productId) {
  if (!tableExists(db, 'product_variants')) return 0;
  return Number(db.prepare(`
    SELECT COUNT(*) AS c FROM product_variants
    WHERE product_id=? AND COALESCE(active,1)=1
  `).get(productId)?.c || 0);
}

function pushMissing(list, code, field, message_fa, severity = 'hard') {
  list.push({ code, field, message_fa, severity });
}

function isStrictMode(mode) {
  return ['activate', 'order', 'issue', 'finalize', 'release'].includes(mode);
}

function isIssueLike(mode) {
  return ['issue', 'finalize', 'release'].includes(mode);
}

/**
 * Assess a single product for production use.
 * @param {'product'|'activate'|'order'|'release'|'issue'|'finalize'} mode
 * @param {{ waive?: boolean|string, role?: string }} opts
 */
function assessProduct(db, productId, mode = 'product', opts = {}) {
  const hard = [];
  const soft = [];
  const waive = !!(opts.waive && String(opts.waive).trim());
  const p = db.prepare(`
    SELECT id, name, code, unit, item_type, is_manufactured, warehouse_id,
           category_id, category, average_cost_rial, std_cost_rial, costing_method,
           barcode, colors, pack_size
    FROM products WHERE id=?
  `).get(productId);
  if (!p) {
    pushMissing(hard, 'E_PRODUCT_MISSING', 'id', 'کالا یافت نشد');
    return { ok: false, kind: 'missing', product_id: productId, hard, soft, missing: hard };
  }

  const kind = classifyKind(p);
  const name = String(p.name || '').trim();
  if (!name) pushMissing(hard, 'E_SPEC_NAME', 'name', 'نام کالا الزامی است');

  const unit = String(p.unit || '').trim();
  if (!unit) pushMissing(hard, 'E_SPEC_UNIT', 'unit', 'واحد کالا الزامی است');

  const itemType = String(p.item_type || '').trim();
  if (!itemType) pushMissing(hard, 'E_SPEC_ITEM_TYPE', 'item_type', 'طبقه‌بندی تولید (نوع کالا) الزامی است');

  const codeEmpty = !String(p.code || '').trim();
  if (codeEmpty) {
    const codeHard = isStrictMode(mode) && (kind === 'fg' || kind === 'semi') && !waive;
    pushMissing(
      codeHard ? hard : soft,
      'E_SPEC_CODE',
      'code',
      codeHard
        ? 'کد کالا برای محصول ساختنی الزامی است'
        : 'کد کالا خالی است — برای جستجو و برچسب توصیه می‌شود',
      codeHard ? 'hard' : 'soft'
    );
  }

  if (!p.warehouse_id) {
    pushMissing(soft, 'E_SPEC_WAREHOUSE', 'warehouse_id', 'انبار اصلی کالا خالی است', 'soft');
  }
  if (!(p.category_id || String(p.category || '').trim())) {
    pushMissing(soft, 'E_SPEC_CATEGORY', 'category', 'دسته‌بندی کالا خالی است', 'soft');
  }

  const cost = Number(p.average_cost_rial) || Number(p.std_cost_rial) || 0;
  if (cost <= 0 && (kind === 'raw' || kind === 'fabric' || kind === 'packaging')) {
    const costHard = isIssueLike(mode) && !waive;
    pushMissing(
      costHard ? hard : soft,
      'E_SPEC_COST',
      'average_cost_rial',
      costHard
        ? 'بهای مواد صفر است — حواله/نهایی‌سازی بدون بها مجاز نیست (یا با دلیل waive)'
        : 'بهای مواد صفر است — roll-up بها ناقص می‌شود',
      costHard ? 'hard' : 'soft'
    );
  }

  if (kind === 'fg' || kind === 'semi') {
    if (Number(p.is_manufactured) !== 1) {
      pushMissing(hard, 'E_SPEC_MANUFACTURED', 'is_manufactured',
        `«${name || '#' + productId}» باید تیک ساختنی داشته باشد`);
    }
    const nVar = countActiveVariants(db, productId);
    const nCol = countStyleColors(db, productId);
    const nSz = countStyleSizes(db, productId);
    if (kind === 'fg' && nVar === 0 && nCol === 0) {
      pushMissing(soft, 'E_SPEC_COLORS', 'colors',
        'رنگ/ماتریس برای محصول نهایی ثبت نشده — سفارش ماتریسی و رنگ inherit محدود می‌شود', 'soft');
    }
    if (kind === 'fg' && nVar === 0 && nSz === 0) {
      pushMissing(soft, 'E_SPEC_SIZES', 'sizes',
        'سایز/ماتریس برای محصول نهایی ثبت نشده — ماتریس سایز BOM محدود می‌شود', 'soft');
    }
    if (['order', 'finalize', 'release', 'issue'].includes(mode)) {
      if (hasActiveMatrixVariants(db, productId) && nVar === 0) {
        pushMissing(hard, 'E_SPEC_VARIANTS', 'variants',
          'کالای ماتریسی بدون واریانت فعال است');
      }
    }
  }

  if (kind === 'trade') {
    pushMissing(hard, 'E_SPEC_TRADE_FG', 'item_type',
      `«${name}» کالای فروش‌محض است و برای تولید/جزء BOM مجاز نیست`);
  }

  if (kind === 'fabric' && !CONTINUOUS_UNIT_RE.test(unit)) {
    pushMissing(hard, 'E_SPEC_FABRIC_UNIT', 'unit', 'پارچه باید واحد متری داشته باشد');
  }

  const missing = [...hard, ...soft];
  return {
    ok: hard.length === 0,
    kind,
    product_id: productId,
    name: p.name,
    hard,
    soft,
    missing,
    waived: waive,
    meta: {
      variant_count: countActiveVariants(db, productId),
      style_color_count: countStyleColors(db, productId),
      style_size_count: countStyleSizes(db, productId),
      has_matrix: hasActiveMatrixVariants(db, productId),
    },
  };
}

function normalizeColorMode(v) {
  const s = String(v || 'none').toLowerCase();
  if (s === 'fixed' || s === 'inherit_fg' || s === 'inherit' || s === 'none') {
    return s === 'inherit' ? 'inherit_fg' : s;
  }
  return 'none';
}

/**
 * Full BOM + product readiness for activate / UI dry-run.
 */
function assessBom(db, bomId, mode = 'activate', opts = {}) {
  const hard = [];
  const soft = [];
  const waive = !!(opts.waive && String(opts.waive).trim());
  const bom = db.prepare('SELECT * FROM bom_headers WHERE id=? AND deleted_at IS NULL').get(bomId);
  if (!bom) {
    pushMissing(hard, 'E_NOT_FOUND', 'bom_id', 'فرمول یافت نشد');
    return { ok: false, bom_id: bomId, hard, soft, missing: hard, products: [] };
  }

  const productMode = mode === 'activate' ? 'activate' : mode;
  const products = [];
  const headerAssess = assessProduct(db, bom.product_id, productMode, { waive, role: 'main' });
  products.push({ role: 'main', ...headerAssess });
  for (const m of headerAssess.hard) hard.push({ ...m, product_id: bom.product_id, role: 'main' });
  for (const m of headerAssess.soft) soft.push({ ...m, product_id: bom.product_id, role: 'main' });

  const outs = db.prepare(`
    SELECT product_id, output_type FROM bom_outputs
    WHERE bom_id=? AND output_type IN ('main','co')
  `).all(bomId);
  for (const o of outs) {
    if (Number(o.product_id) === Number(bom.product_id)) continue;
    const a = assessProduct(db, o.product_id, productMode, { waive, role: o.output_type });
    products.push({ role: o.output_type, ...a });
    for (const m of a.hard) hard.push({ ...m, product_id: o.product_id, role: o.output_type });
    for (const m of a.soft) soft.push({ ...m, product_id: o.product_id, role: o.output_type });
  }

  const lines = db.prepare('SELECT * FROM bom_lines WHERE bom_id=?').all(bomId);
  if (!lines.length) {
    pushMissing(hard, 'E_BOM_EMPTY', 'lines', 'فرمول بدون قلم مواد است');
  }
  const materialOk = lines.some(L => (L.line_type || 'material') === 'material');
  if (lines.length && !materialOk) {
    pushMissing(hard, 'E_BOM_EMPTY', 'lines', 'حداقل یک قلم مواد الزامی است');
  }

  const compMode = isIssueLike(mode) ? mode : 'product';
  let needsFgColors = false;
  let needsFgSizes = false;
  for (const L of lines) {
    const ca = assessProduct(db, L.component_product_id, compMode, { waive, role: 'component' });
    products.push({ role: 'component', line_no: L.line_no, ...ca });
    for (const m of ca.hard) {
      hard.push({ ...m, product_id: L.component_product_id, role: 'component', line_no: L.line_no });
    }
    for (const m of ca.soft) {
      soft.push({ ...m, product_id: L.component_product_id, role: 'component', line_no: L.line_no });
    }
    const cmode = normalizeColorMode(L.component_color_mode);
    if (cmode === 'inherit_fg') needsFgColors = true;
    if (cmode === 'fixed' && !L.component_color_id) {
      pushMissing(hard, 'E_BOM_COMP_COLOR', 'component_color_id',
        `قلم ${L.line_no}: رنگ ثابت انتخاب نشده`, 'hard');
    }
    if (L.size_matrix) needsFgSizes = true;
  }

  if (needsFgColors) {
    const nCol = countStyleColors(db, bom.product_id) + countActiveVariants(db, bom.product_id);
    if (nCol === 0) {
      pushMissing(hard, 'E_SPEC_FG_COLOR', 'colors',
        'اقلام با رنگ «از محصول نهایی» هستند ولی برای سرفصل رنگی ثبت نشده');
    }
  }
  if (needsFgSizes) {
    const nSz = countStyleSizes(db, bom.product_id);
    const hasMatrix = hasActiveMatrixVariants(db, bom.product_id);
    if (nSz === 0 && !hasMatrix) {
      const globalSz = tableExists(db, 'product_sizes')
        ? Number(db.prepare('SELECT COUNT(*) c FROM product_sizes WHERE COALESCE(active,1)=1').get()?.c || 0)
        : 0;
      if (globalSz === 0) {
        pushMissing(hard, 'E_SPEC_FG_SIZE', 'sizes',
          'ماتریس سایز در BOM هست ولی سایزی در سیستم تعریف نشده');
      } else {
        pushMissing(soft, 'E_SPEC_FG_SIZE_STYLE', 'sizes',
          'ماتریس سایز بدون سایز اختصاصی استایل — از سایزهای سراسری استفاده می‌شود', 'soft');
      }
    }
  }

  if (bom.has_routing && (mode === 'activate' || mode === 'product')) {
    const ops = Number(db.prepare('SELECT COUNT(*) c FROM bom_operations WHERE bom_id=?').get(bomId)?.c || 0);
    if (!ops) pushMissing(hard, 'E_ROUTING_EMPTY', 'operations', 'مسیر عملیات خالی است');
    if (Math.abs((Number(bom.yield_percent) || 100) - 100) > 0.001) {
      pushMissing(hard, 'E_YIELD_DOUBLE_COUNT', 'yield_percent',
        'با مسیر عملیات، بازده سرفصل باید ۱۰۰٪ باشد (R6)');
    }
  }

  if ((bom.has_coproducts || outs.length > 1) && mode === 'activate') {
    const shares = outs.filter(o => ['main', 'co'].includes(o.output_type));
    if (Number(bom.has_coproducts) === 1 && shares.filter(o => o.output_type === 'co').length === 0) {
      pushMissing(hard, 'E_NO_COPRODUCT', 'outputs', 'حالت چندمحصولی بدون هم‌محصول است');
    }
  }

  if (isIssueLike(mode) && bom.status !== 'active') {
    pushMissing(hard, 'E_BOM_NOT_ACTIVE', 'status', 'فرمول سفارش باید فعال باشد');
  }

  const missing = [...hard, ...soft];
  return {
    ok: hard.length === 0,
    bom_id: bomId,
    product_id: bom.product_id,
    status: bom.status,
    hard,
    soft,
    missing,
    products,
    waived: waive,
  };
}

function assertProductReady(db, productId, mode = 'order', opts = {}) {
  const a = assessProduct(db, productId, mode, opts);
  if (!a.ok) {
    const first = a.hard[0];
    throw err(first?.code || 'E_PRODUCT_INCOMPLETE', 422, {
      missing: a.hard,
      soft: a.soft,
      kind: a.kind,
      product_id: productId,
      name: a.name,
      detail: first?.message_fa,
    });
  }
  return a;
}

function assertBomReady(db, bomId, mode = 'activate', opts = {}) {
  const a = assessBom(db, bomId, mode, opts);
  if (!a.ok) {
    const first = a.hard[0];
    throw err(first?.code || 'E_BOM_INCOMPLETE', 422, {
      missing: a.hard,
      soft: a.soft,
      bom_id: bomId,
      detail: first?.message_fa,
    });
  }
  return a;
}

/**
 * Gate for release / issue / finalize on an existing production order.
 */
function assertOrderReady(db, orderId, mode = 'issue') {
  const po = db.prepare('SELECT * FROM production_orders WHERE id=?').get(orderId);
  if (!po) throw err('E_NOT_FOUND', 404);
  const waive = String(po.completeness_waive_reason || '').trim();
  assertProductReady(db, po.product_id, mode, { waive, role: 'main' });
  if (po.bom_id) {
    assertBomReady(db, po.bom_id, mode, { waive });
  } else if (mode !== 'product') {
    throw err('E_NO_ACTIVE_BOM', 422);
  }
  return { order: po, waive: !!waive };
}

module.exports = {
  classifyKind,
  assessProduct,
  assessBom,
  assertProductReady,
  assertBomReady,
  assertOrderReady,
  isStrictMode,
  isIssueLike,
};
