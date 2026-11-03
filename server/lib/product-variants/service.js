'use strict';
/**
 * Product-variant domain helpers (matrix generation, stock, CRUD support).
 */

function pad2(n) {
  return String(n).padStart(2, '0');
}

function buildSku(styleCode, colorCode, sizeCode) {
  const s = String(styleCode || 'STY').trim() || 'STY';
  const c = String(colorCode || 'CLR').trim() || 'CLR';
  const z = String(sizeCode || 'SZ').trim() || 'SZ';
  return `${s}-${c}-${z}`;
}

function upsertColor(db, spec, sortOrder = 0) {
  const { normalizeAndAssertHex, assertUniqueHex } = require('./color-hex');
  const name = String(spec.name || spec.code || '').trim();
  if (!name) throw Object.assign(new Error('نام رنگ الزامی است'), { status: 400 });
  const code = String(spec.code || name).trim();
  const hex = normalizeAndAssertHex(spec.hex);
  let row = db.prepare(
    'SELECT * FROM product_colors WHERE (code=? AND code<>\'\') OR name=? LIMIT 1'
  ).get(code, name);
  assertUniqueHex(db, hex, row ? row.id : null);
  if (row) {
    db.prepare(
      'UPDATE product_colors SET name=?, hex=COALESCE(NULLIF(?,\'\'), hex), sort_order=?, active=1 WHERE id=?'
    ).run(name, hex, spec.sort_order != null ? spec.sort_order : sortOrder, row.id);
    return db.prepare('SELECT * FROM product_colors WHERE id=?').get(row.id);
  }
  const r = db.prepare(
    'INSERT INTO product_colors (code, name, hex, sort_order, active) VALUES (?,?,?,?,1)'
  ).run(code, name, hex, spec.sort_order != null ? spec.sort_order : sortOrder);
  return db.prepare('SELECT * FROM product_colors WHERE id=?').get(r.lastInsertRowid);
}

function upsertSize(db, spec, sortOrder = 0) {
  const name = String(spec.name || spec.code || '').trim();
  if (!name) throw Object.assign(new Error('نام سایز الزامی است'), { status: 400 });
  const code = String(spec.code || name).trim();
  let row = db.prepare(
    'SELECT * FROM product_sizes WHERE (code=? AND code<>\'\') OR name=? LIMIT 1'
  ).get(code, name);
  if (row) {
    db.prepare(
      'UPDATE product_sizes SET name=?, sort_order=?, active=1 WHERE id=?'
    ).run(name, spec.sort_order != null ? spec.sort_order : sortOrder, row.id);
    return db.prepare('SELECT * FROM product_sizes WHERE id=?').get(row.id);
  }
  const r = db.prepare(
    'INSERT INTO product_sizes (code, name, sort_order, active) VALUES (?,?,?,1)'
  ).run(code, name, spec.sort_order != null ? spec.sort_order : sortOrder);
  return db.prepare('SELECT * FROM product_sizes WHERE id=?').get(r.lastInsertRowid);
}

function attachStyleColor(db, productId, colorId, sortOrder = 0) {
  db.prepare(`
    INSERT INTO product_style_colors (product_id, color_id, sort_order)
    VALUES (?,?,?)
    ON CONFLICT(product_id, color_id) DO UPDATE SET sort_order=excluded.sort_order
  `).run(productId, colorId, sortOrder);
}

function attachStyleSize(db, productId, sizeId, sortOrder = 0) {
  db.prepare(`
    INSERT INTO product_style_sizes (product_id, size_id, sort_order)
    VALUES (?,?,?)
    ON CONFLICT(product_id, size_id) DO UPDATE SET sort_order=excluded.sort_order
  `).run(productId, sizeId, sortOrder);
}

function ensureDefaultVariant(db, productId) {
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!product) throw Object.assign(new Error('محصول یافت نشد'), { status: 404 });

  let def = db.prepare(
    'SELECT * FROM product_variants WHERE product_id=? AND is_default=1 LIMIT 1'
  ).get(productId);
  if (def) {
    db.prepare('UPDATE products SET is_style=1, default_variant_id=? WHERE id=?')
      .run(def.id, productId);
    return def;
  }

  const sku = (product.code && String(product.code).trim()) || `STY-${productId}`;
  const priceRial = product.price_rial != null
    ? Math.round(Number(product.price_rial) || 0)
    : Math.round(Number(product.price) || 0);
  const r = db.prepare(`
    INSERT INTO product_variants (
      product_id, color_id, size_id, sku, barcode, price, price_rial, cost, stock,
      status, is_default, active
    ) VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, 'active', 1, 1)
  `).run(
    productId,
    sku,
    product.barcode || null,
    Number(product.price) || 0,
    priceRial,
    Number(product.cost) || 0,
    0 // stock single-source: figure is derived from inventory_ledger (stock-cache), never seeded
  );
  def = db.prepare('SELECT * FROM product_variants WHERE id=?').get(r.lastInsertRowid);
  db.prepare('UPDATE products SET is_style=1, default_variant_id=? WHERE id=?')
    .run(def.id, productId);
  return def;
}

/**
 * Generate full color×size matrix for a style.
 * Does not overwrite existing matrix SKUs; returns created + existing.
 */
function generateMatrix(db, opts) {
  const productId = parseInt(opts.product_id || opts.productId, 10);
  if (!productId) throw Object.assign(new Error('product_id الزامی است'), { status: 400 });

  const product = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!product) throw Object.assign(new Error('مدل (style) یافت نشد'), { status: 404 });
  const activeColorIdsBefore = activeMatrixColorIds(db, productId);

  const colorSpecs = Array.isArray(opts.colors) ? opts.colors : [];
  const sizeSpecs = Array.isArray(opts.sizes) ? opts.sizes : [];
  const colorIds = Array.isArray(opts.color_ids) ? opts.color_ids.map(Number) : [];
  const sizeIds = Array.isArray(opts.size_ids) ? opts.size_ids.map(Number) : [];

  if (!colorSpecs.length && !colorIds.length) {
    throw Object.assign(new Error('حداقل یک رنگ لازم است'), { status: 400 });
  }
  if (!sizeSpecs.length && !sizeIds.length) {
    throw Object.assign(new Error('حداقل یک سایز لازم است'), { status: 400 });
  }

  const colorCount = colorSpecs.length || colorIds.length;
  const sizeCount = sizeSpecs.length || sizeIds.length;
  const MAX_MATRIX_SKUS = 500;
  if (colorCount * sizeCount > MAX_MATRIX_SKUS) {
    throw Object.assign(
      new Error(`حداکثر ${MAX_MATRIX_SKUS} ترکیب SKU در هر درخواست مجاز است (دریافت: ${colorCount}×${sizeCount})`),
      { status: 400, code: 'VARIANT_MATRIX_TOO_LARGE' }
    );
  }

  const basePrice = opts.price != null ? Number(opts.price) : Number(product.price) || 0;
  const basePriceRial = opts.price_rial != null
    ? Math.round(Number(opts.price_rial) || 0)
    : (product.price_rial != null ? Math.round(Number(product.price_rial) || 0) : Math.round(basePrice));
  const baseCost = opts.cost != null ? Number(opts.cost) : Number(product.cost) || 0;
  const baseWeight = opts.weight != null ? Number(opts.weight) : 0;
  // Stock single-source: new SKUs always start at 0; quantity only arrives through ledger documents.
  const initialStock = 0;

  const findMatrix = db.prepare(`
    SELECT * FROM product_variants
    WHERE product_id=? AND color_id=? AND size_id=? AND is_default=0
    ORDER BY active DESC, id DESC
    LIMIT 1
  `);
  const insertVar = db.prepare(`
    INSERT INTO product_variants (
      product_id, color_id, size_id, sku, barcode, price, price_rial, cost, stock,
      weight, status, is_default, active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, 1)
  `);

  const result = { product_id: productId, created: [], existing: [], colors: [], sizes: [] };

  const tx = db.transaction(() => {
    ensureDefaultVariant(db, productId);

    const colors = [];
    if (colorSpecs.length) {
      colorSpecs.forEach((spec, i) => colors.push(upsertColor(db, spec, i)));
    } else {
      for (const id of colorIds) {
        const row = db.prepare('SELECT * FROM product_colors WHERE id=? AND active=1').get(id);
        if (!row) throw Object.assign(new Error(`رنگ ${id} یافت نشد`), { status: 400 });
        colors.push(row);
      }
    }

    const sizes = [];
    if (sizeSpecs.length) {
      sizeSpecs.forEach((spec, i) => sizes.push(upsertSize(db, spec, i)));
    } else {
      for (const id of sizeIds) {
        const row = db.prepare('SELECT * FROM product_sizes WHERE id=? AND active=1').get(id);
        if (!row) throw Object.assign(new Error(`سایز ${id} یافت نشد`), { status: 400 });
        sizes.push(row);
      }
    }

    colors.forEach((c, i) => attachStyleColor(db, productId, c.id, i));
    sizes.forEach((s, i) => attachStyleSize(db, productId, s.id, i));
    result.colors = colors;
    result.sizes = sizes;

    const styleCode = (product.code && String(product.code).trim()) || `STY${pad2(productId)}`;
    let n = 0;
    for (const color of colors) {
      for (const size of sizes) {
        let existing = findMatrix.get(productId, color.id, size.id);
        if (existing) {
          if (!existing.active) {
            db.prepare("UPDATE product_variants SET active=1, status='active' WHERE id=?").run(existing.id);
            existing = db.prepare('SELECT * FROM product_variants WHERE id=?').get(existing.id);
          }
          result.existing.push(existing);
          continue;
        }
        const sku = buildSku(styleCode, color.code || color.name, size.code || size.name);
        const barcode = opts.auto_barcode
          ? `2${String(productId).padStart(5, '0')}${String(color.id).padStart(3, '0')}${String(size.id).padStart(3, '0')}`
          : (opts.barcode_prefix
            ? `${opts.barcode_prefix}${String(++n).padStart(4, '0')}`
            : null);
        const r = insertVar.run(
          productId, color.id, size.id, sku, barcode,
          basePrice, basePriceRial, baseCost, initialStock, baseWeight
        );
        result.created.push(
          db.prepare('SELECT * FROM product_variants WHERE id=?').get(r.lastInsertRowid)
        );
      }
    }

    const matrixCount = db.prepare(`
      SELECT COUNT(*) c FROM product_variants
      WHERE product_id=? AND is_default=0 AND active=1
    `).get(productId).c;
    db.prepare('UPDATE products SET has_variants=?, is_style=1 WHERE id=?')
      .run(matrixCount > 0 ? 1 : 0, productId);
  });
  tx();

  result.total_skus = result.created.length + result.existing.length;
  result.variants = listVariants(db, productId, { include_default: false });
  const activeColorIdsAfter = activeMatrixColorIds(db, productId);
  return addZeroColorHint(
    result,
    [...activeColorIdsAfter].filter((colorId) => !activeColorIdsBefore.has(colorId))
  );
}

function listVariants(db, productId, opts = {}) {
  const includeDefault = opts.include_default !== false;
  const sql = `
    SELECT v.*,
           c.name AS color_name, c.code AS color_code, c.hex AS color_hex,
           s.name AS size_name, s.code AS size_code
    FROM product_variants v
    LEFT JOIN product_colors c ON c.id = v.color_id
    LEFT JOIN product_sizes s ON s.id = v.size_id
    WHERE v.product_id = ?
      AND v.active = 1
      ${includeDefault ? '' : 'AND v.is_default = 0'}
    ORDER BY v.is_default DESC, COALESCE(c.sort_order, 0), COALESCE(s.sort_order, 0), v.id
  `;
  return db.prepare(sql).all(productId);
}

function getVariant(db, id) {
  return db.prepare(`
    SELECT v.*,
           c.name AS color_name, c.code AS color_code,
           s.name AS size_name, s.code AS size_code,
           p.name AS style_name, p.code AS style_code
    FROM product_variants v
    LEFT JOIN product_colors c ON c.id = v.color_id
    LEFT JOIN product_sizes s ON s.id = v.size_id
    LEFT JOIN products p ON p.id = v.product_id
    WHERE v.id = ?
  `).get(id);
}

function createVariant(db, body) {
  const productId = parseInt(body.product_id, 10);
  if (!productId) throw Object.assign(new Error('product_id الزامی است'), { status: 400 });
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!product) throw Object.assign(new Error('مدل یافت نشد'), { status: 404 });

  const colorId = body.color_id != null ? parseInt(body.color_id, 10) : null;
  const sizeId = body.size_id != null ? parseInt(body.size_id, 10) : null;
  if (colorId && sizeId) {
    const dup = db.prepare(`
      SELECT id FROM product_variants
      WHERE product_id=? AND color_id=? AND size_id=? AND active=1
    `).get(productId, colorId, sizeId);
    if (dup) throw Object.assign(new Error('این ترکیب رنگ/سایز از قبل وجود دارد'), { status: 409 });
  }

  const color = colorId
    ? db.prepare('SELECT * FROM product_colors WHERE id=?').get(colorId)
    : null;
  const size = sizeId
    ? db.prepare('SELECT * FROM product_sizes WHERE id=?').get(sizeId)
    : null;
  const styleCode = (product.code && String(product.code).trim()) || `STY${productId}`;
  const sku = body.sku || (color && size
    ? buildSku(styleCode, color.code || color.name, size.code || size.name)
    : `${styleCode}-CUSTOM`);

  const price = Number(body.price != null ? body.price : product.price) || 0;
  const priceRial = body.price_rial != null
    ? Math.round(Number(body.price_rial) || 0)
    : Math.round(price);
  const r = db.prepare(`
    INSERT INTO product_variants (
      product_id, color_id, size_id, sku, barcode, price, price_rial, cost, stock,
      weight, status, is_default, active, note
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)
  `).run(
    productId,
    colorId,
    sizeId,
    sku,
    body.barcode || null,
    price,
    priceRial,
    Number(body.cost) || 0,
    0, // stock single-source: quantity only via ledger documents (opening / adjustment / receipt)
    Number(body.weight) || 0,
    body.status || 'active',
    body.is_default ? 1 : 0,
    body.note || ''
  );
  if (colorId) attachStyleColor(db, productId, colorId);
  if (sizeId) attachStyleSize(db, productId, sizeId);
  db.prepare('UPDATE products SET has_variants=1, is_style=1 WHERE id=?').run(productId);
  return getVariant(db, r.lastInsertRowid);
}

function updateVariant(db, id, body) {
  const row = db.prepare('SELECT * FROM product_variants WHERE id=?').get(id);
  if (!row) throw Object.assign(new Error('واریانت یافت نشد'), { status: 404 });

  const fields = [];
  const params = [];
  const map = {
    sku: 'sku',
    barcode: 'barcode',
    price: 'price',
    price_rial: 'price_rial',
    cost: 'cost',
    // P1: `stock` is intentionally NOT editable here (cache layer; moves only via adjustment docs).
    weight: 'weight',
    status: 'status',
    active: 'active',
    note: 'note',
    color_id: 'color_id',
    size_id: 'size_id',
  };
  for (const [key, col] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      fields.push(`${col}=?`);
      params.push(body[key]);
    }
  }
  if (!fields.length) return getVariant(db, id);
  params.push(id);
  db.prepare(`UPDATE product_variants SET ${fields.join(',')} WHERE id=?`).run(...params);
  return getVariant(db, id);
}

/**
 * Change stock on one SKU only — never touches siblings.
 * Stock single-source: this NEVER writes product_variants.stock. The change is posted as an
 * 'adjustment' ledger row stamped with the variant (stock-cache then re-derives every figure).
 * Needs a warehouse: opts.warehouseId, else the product's own warehouse.
 * For user-facing changes prefer lib/inventory/manual-adjust.postAdjust (adds reason + JE).
 */
function adjustVariantStock(db, id, deltaOrAbsolute, mode = 'set', opts = {}) {
  const { parseStockQty, requiresIntegerQty } = require('../inventory/qty-policy');
  const { derivedQty } = require('../inventory/stock-cache');
  const row = db.prepare('SELECT * FROM product_variants WHERE id=?').get(id);
  if (!row) throw Object.assign(new Error('واریانت یافت نشد'), { status: 404 });
  const integer = requiresIntegerQty(db, row.product_id);
  let whRow = null;
  if (opts.warehouseId) whRow = { warehouse_id: Number(opts.warehouseId) };
  else {
    try { whRow = db.prepare('SELECT warehouse_id FROM products WHERE id=?').get(row.product_id); } catch (_) { whRow = null; }
  }
  const warehouseId = Number(whRow && whRow.warehouse_id) || 0;
  const current = derivedQty(db, { productId: row.product_id, variantId: id, warehouseId: warehouseId || null });
  let delta;
  if (mode === 'delta') {
    delta = parseStockQty(deltaOrAbsolute || 0, { integer, strict: integer });
  } else {
    const target = parseStockQty(deltaOrAbsolute, { integer, strict: integer });
    delta = target - current;
  }
  if (integer) delta = Math.round(delta);
  if (!Number.isFinite(delta)) {
    throw Object.assign(new Error('موجودی نامعتبر است'), { status: 400 });
  }
  rememberColorStockHistory(db, row, current + delta);
  if (Math.abs(delta) > 1e-9) {
    if (!warehouseId) {
      throw Object.assign(new Error('برای تغییر موجودی واریانت انبار مشخص نیست'), { status: 422, code: 'E_STOCK_WAREHOUSE_REQUIRED' });
    }
    require('../inventory/ledger').postInventoryMovement(db, {
      eventType: 'adjustment',
      productId: row.product_id,
      warehouseId,
      variantId: id,
      qty: delta,
      sourceType: 'variant_stock_adjust',
      sourceId: null,
      date: opts.date || '',
      note: opts.note || 'تعدیل موجودی واریانت',
      createdBy: opts.userId || null,
      updateAvg: false,
      allowNegative: true,
      allowZeroCost: true,
    });
  }
  afterVariantStockWrite(db, row.product_id, opts);
  return getVariant(db, id);
}

const STOCK_EPS = 1e-9;
const ZERO_COLOR_HINT_FA = 'رنگ جدید با موجودی صفر فعال ماند؛ هر رنگ فقط وقتی موجودی همهٔ سایزهایش (پس از داشتن موجودی) به صفر برسد از پک زنده پنهان می‌شود.';
// pv.stock-only DBs (no vws/ledger) leave no durable trace that a color once held stock.
const colorStockHistory = new WeakMap();

function rememberColorStockHistory(db, variantRow, nextStock) {
  if (!variantRow || !variantRow.color_id) return;
  if (Math.abs(Number(variantRow.stock) || 0) <= STOCK_EPS
    && Math.abs(Number(nextStock) || 0) <= STOCK_EPS) return;
  let byProduct = colorStockHistory.get(db);
  if (!byProduct) colorStockHistory.set(db, (byProduct = new Map()));
  const pid = Number(variantRow.product_id);
  if (!byProduct.has(pid)) byProduct.set(pid, new Set());
  byProduct.get(pid).add(Number(variantRow.color_id));
}

function colorHadStockInProcess(db, productId, colorId) {
  const byProduct = colorStockHistory.get(db);
  const set = byProduct && byProduct.get(Number(productId));
  return !!(set && set.has(Number(colorId)));
}

function normalizeColorIds(ids) {
  return [...new Set((ids || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
}

function addZeroColorHint(result, colorIds) {
  const kept = normalizeColorIds(colorIds);
  if (!kept.length) return result;
  result.kept_new_color_ids = kept;
  result.zero_color_hint_fa = ZERO_COLOR_HINT_FA;
  return result;
}

function activeMatrixColorIds(db, productId) {
  try {
    return new Set(db.prepare(`
      SELECT DISTINCT color_id FROM product_variants
      WHERE product_id=? AND COALESCE(is_default,0)=0
        AND COALESCE(active,1)=1 AND color_id IS NOT NULL
    `).all(productId).map((row) => Number(row.color_id)).filter(Boolean));
  } catch (_) {
    return new Set();
  }
}

/**
 * True when this SKU still carries ANY quantity in any layer: product_variants.stock,
 * any variant_warehouse_stock row, or a live kardex Σ stamped with the variant (P1).
 */
function variantCarriesStock(db, variantRow) {
  if (Math.abs(Number(variantRow.stock) || 0) > STOCK_EPS) return true;
  try {
    const hit = db.prepare(`
      SELECT 1 AS x FROM variant_warehouse_stock
      WHERE variant_id=? AND ABS(COALESCE(qty,0)) > ? LIMIT 1
    `).get(variantRow.id, STOCK_EPS);
    if (hit) return true;
  } catch (_) { /* vws table may be absent in tiny fixtures */ }
  try {
    const L = require('../inventory/ledger');
    if (L.ledgerHasVariantColumn(db)) {
      const q = L.stockOf(db, { productId: variantRow.product_id, variantId: variantRow.id });
      if (Math.abs(q) > STOCK_EPS) return true;
    }
  } catch (_) { /* ledger table may be absent in tiny fixtures */ }
  return false;
}

/**
 * A zero SKU counts as previously stocked when any durable stock projection/history exists.
 * `variant_warehouse_stock` row existence (even now zero) intentionally counts as history:
 * legacy imports/tests wrote that cache directly before immutable ledgers carried variant_id.
 */
function variantHasStockHistory(db, variantRow) {
  if (Math.abs(Number(variantRow.stock) || 0) > STOCK_EPS) return true;
  if (colorHadStockInProcess(db, variantRow.product_id, variantRow.color_id)) return true;
  try {
    const hit = db.prepare(
      'SELECT 1 AS x FROM variant_warehouse_stock WHERE variant_id=? LIMIT 1'
    ).get(variantRow.id);
    if (hit) return true;
  } catch (_) { /* VWS table may be absent in tiny fixtures */ }
  try {
    const L = require('../inventory/ledger');
    if (L.ledgerHasVariantColumn(db)) {
      const hit = db.prepare(
        'SELECT 1 AS x FROM inventory_ledger WHERE variant_id=? LIMIT 1'
      ).get(variantRow.id);
      if (hit) return true;
    }
  } catch (_) { /* ledger table/column may be absent in tiny fixtures */ }
  for (const table of ['inventory_movements', 'variant_stock_moves']) {
    try {
      const hit = db.prepare(`SELECT 1 AS x FROM ${table} WHERE variant_id=? LIMIT 1`)
        .get(variantRow.id);
      if (hit) return true;
    } catch (_) { /* optional/legacy movement table */ }
  }
  return false;
}

/**
 * P1: bring a retired / unchecked SKU back (adjust, receipt, matrix re-check).
 * Style color/size rows are re-attached; stock is never touched here.
 */
function reactivateVariant(db, variantId) {
  const v = db.prepare('SELECT * FROM product_variants WHERE id=?').get(variantId);
  if (!v) throw Object.assign(new Error('واریانت یافت نشد'), { status: 404 });
  if (Number(v.active)) return { reactivated: false, variant: v };
  db.prepare("UPDATE product_variants SET active=1, status='active' WHERE id=?").run(variantId);
  try {
    if (v.color_id) attachStyleColor(db, v.product_id, v.color_id);
    if (v.size_id) attachStyleSize(db, v.product_id, v.size_id);
    db.prepare('UPDATE products SET has_variants=1, is_style=1 WHERE id=?').run(v.product_id);
  } catch (_) { /* style tables optional in tiny fixtures */ }
  return { reactivated: true, variant: db.prepare('SELECT * FROM product_variants WHERE id=?').get(variantId) };
}

/**
 * A color leaves this product's live pack ONLY when every one of its sizes is EXACTLY zero
 * (not Σ=0: S=-1,M=+1 keeps both) and no layer still carries a quantity — vws / kardex included.
 * Variants are deactivated (not deleted) so invoices keep their variant_id; stock is never
 * written here (P1 — the old `stock=0` wipe hid negatives) and product_style_colors is kept
 * (soft: re-adding the color or a postAdjust re-activates it without losing sort order).
 */
function retireZeroStockColors(db, productId, opts = {}) {
  const id = parseInt(productId, 10);
  if (!id) return { retired: [], kept_new_color_ids: [] };
  const keepColorIds = new Set(normalizeColorIds(opts.keepColorIds));
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT * FROM product_variants
      WHERE product_id=? AND COALESCE(is_default,0)=0 AND color_id IS NOT NULL
    `).all(id);
  } catch (_) {
    return { retired: [] };
  }
  const byColor = new Map();
  for (const r of rows) {
    const k = Number(r.color_id);
    if (!byColor.has(k)) byColor.set(k, []);
    byColor.get(k).push(r);
  }
  const deactivate = db.prepare(`
    UPDATE product_variants
    SET active=0, status='inactive'
    WHERE product_id=? AND color_id=? AND COALESCE(is_default,0)=0 AND COALESCE(active,1)=1
  `);
  const retired = [];
  const keptNew = [];
  for (const [colorId, list] of byColor) {
    const active = list.filter((r) => Number(r.active) !== 0);
    if (!active.length) continue;
    // every SKU of the color (active or not) must be clean — a hidden SKU holding qty blocks retirement
    if (list.some((r) => variantCarriesStock(db, r))) continue;
    // A color is hidden only after it really carried stock and returned to zero.
    // This also protects delayed website-outbox drains after a structure-only save.
    if (keepColorIds.has(colorId) || !list.some((r) => variantHasStockHistory(db, r))) {
      keptNew.push(colorId);
      continue;
    }
    deactivate.run(id, colorId);
    retired.push(colorId);
  }
  return { retired, kept_new_color_ids: normalizeColorIds(keptNew) };
}

function websiteStockPushEnabled(db) {
  try {
    return !!require('../website-stock-sync').isStockPushEnabled(db);
  } catch (_) {
    return false;
  }
}

/**
 * Drop zero colors immediately when the website is not pushing stock.
 * When it is pushing, leave the SKU active at qty 0 so the next matrix push
 * sends 0; drain retires the color after that push is accepted.
 */
const colorRetireHolds = new WeakMap();

/** A multi-line receipt must finish every color before zero-stock colors are retired. */
function holdColorRetire(db) {
  colorRetireHolds.set(db, (colorRetireHolds.get(db) || 0) + 1);
}

function releaseColorRetire(db) {
  const next = (colorRetireHolds.get(db) || 1) - 1;
  if (next <= 0) colorRetireHolds.delete(db);
  else colorRetireHolds.set(db, next);
}

function afterVariantStockWrite(db, productId, opts = {}) {
  if (colorRetireHolds.get(db) > 0) return { deferred: true, retired: [] };
  if (websiteStockPushEnabled(db)) return { deferred: true, retired: [] };
  return retireZeroStockColors(db, productId, opts);
}

function softDeleteVariant(db, id) {
  const row = db.prepare('SELECT * FROM product_variants WHERE id=?').get(id);
  if (!row) throw Object.assign(new Error('واریانت یافت نشد'), { status: 404 });
  if (row.is_default) {
    throw Object.assign(new Error('واریانت پیش‌فرض قابل حذف نیست'), { status: 400 });
  }
  db.prepare("UPDATE product_variants SET active=0, status='inactive' WHERE id=?").run(id);
  return { ok: true, id: Number(id) };
}

/**
 * Live pack (v528): complete colors × style sizes.
 * A color is complete only when every active style size has stock > 0 for that color.
 * Incomplete colors leave the pack entirely (not partial SKU fill).
 */
function packSizeFor(db, productId) {
  const product = db.prepare('SELECT pack_size FROM products WHERE id=?').get(productId);
  const fallback = Math.max(1, Number(product && product.pack_size) || 1);
  let variants = [];
  try {
    variants = listVariants(db, productId, { include_default: false });
  } catch (_) {
    variants = [];
  }
  if (!variants.length) {
    return {
      pack_size: fallback,
      pack_size_auto: fallback,
      full_packs_count: 0,
      complete_colors: 0,
      live_colors: 0,
      live_sizes: 0,
      has_matrix: 0,
    };
  }
  const sizeIds = [...new Set(variants.map((v) => v.size_id).filter(Boolean))];
  const colorIds = [...new Set(variants.map((v) => v.color_id).filter(Boolean))];
  const stockByKey = new Map(
    variants.map((v) => [`${Number(v.color_id)}:${Number(v.size_id)}`, Number(v.stock) || 0])
  );
  const completeColorIds = colorIds.filter((cid) =>
    sizeIds.length > 0
    && sizeIds.every((sid) => (stockByKey.get(`${Number(cid)}:${Number(sid)}`) || 0) > 0)
  );
  if (!completeColorIds.length || !sizeIds.length) {
    return {
      pack_size: fallback,
      pack_size_auto: fallback,
      full_packs_count: 0,
      complete_colors: 0,
      live_colors: 0,
      live_sizes: 0,
      has_matrix: 1,
    };
  }
  const completeSet = new Set(completeColorIds.map(Number));
  const cellQtys = [];
  for (const cid of completeColorIds) {
    for (const sid of sizeIds) {
      cellQtys.push(Math.max(0, Math.floor(stockByKey.get(`${Number(cid)}:${Number(sid)}`) || 0)));
    }
  }
  const fullPacks = cellQtys.length ? Math.min(...cellQtys) : 0;
  return {
    pack_size: fallback,
    pack_size_auto: completeColorIds.length * sizeIds.length,
    full_packs_count: fullPacks,
    complete_colors: completeColorIds.length,
    live_colors: completeColorIds.length,
    live_sizes: sizeIds.length,
    has_matrix: 1,
  };
}

/**
 * Unchecked color×size leaves the live pack — but ONLY when it carries no quantity in any
 * layer (P1: the old code zeroed `stock` of a SKU that still held pieces in this/other
 * warehouses, silently erasing real — or negative — stock). SKUs that still carry stock stay
 * active (and keep their style color/size rows); the user zeroes them with an adjustment first.
 */
function deactivateUnselectedVariants(db, productId, colorIds, sizeIds) {
  const colors = new Set((colorIds || []).map(Number).filter(Boolean));
  const sizes = new Set((sizeIds || []).map(Number).filter(Boolean));
  if (!colors.size || !sizes.size) return { deactivated: 0, kept: [] };
  const rows = db.prepare(`
    SELECT * FROM product_variants
    WHERE product_id=? AND is_default=0 AND active=1
  `).all(productId);
  let deactivated = 0;
  const kept = [];
  const keptColors = new Set(colors);
  const keptSizes = new Set(sizes);
  const upd = db.prepare("UPDATE product_variants SET active=0, status='inactive' WHERE id=?");
  for (const row of rows) {
    if (colors.has(Number(row.color_id)) && sizes.has(Number(row.size_id))) continue;
    if (variantCarriesStock(db, row)) {
      keptColors.add(Number(row.color_id));
      keptSizes.add(Number(row.size_id));
      kept.push(Number(row.id));
      continue;
    }
    upd.run(row.id);
    deactivated += 1;
  }
  const colorList = [...keptColors];
  const sizeList = [...keptSizes];
  db.prepare(`DELETE FROM product_style_colors WHERE product_id=? AND color_id NOT IN (${colorList.map(() => '?').join(',')})`)
    .run(productId, ...colorList);
  db.prepare(`DELETE FROM product_style_sizes WHERE product_id=? AND size_id NOT IN (${sizeList.map(() => '?').join(',')})`)
    .run(productId, ...sizeList);
  return { deactivated, kept };
}

/** Number of live colors (Σ stock > 0) — catalog field products.colors, not a stock layer. */
function refreshLiveColorCount(db, productId, fallback = 1) {
  let liveColorCount = 0;
  try {
    liveColorCount = db.prepare(`
      SELECT COUNT(*) AS c FROM (
        SELECT color_id FROM product_variants
        WHERE product_id=? AND COALESCE(is_default,0)=0 AND COALESCE(active,1)=1
          AND color_id IS NOT NULL
        GROUP BY color_id
        HAVING COALESCE(SUM(stock),0) > 0.0000001
      )
    `).get(productId).c;
  } catch (_) {
    liveColorCount = fallback;
  }
  db.prepare('UPDATE products SET colors=? WHERE id=?').run(Math.max(1, Number(liveColorCount) || 0), productId);
}

/**
 * P1 — matrix STRUCTURE only: build / re-activate the color×size SKUs for the cells' colors
 * and sizes and hide unselected SKUs that carry no stock. It never writes a quantity
 * (cells[].qty is ignored here); quantities go through postStockMatrix → manualAdjust.postAdjust
 * (mode=count, variant_id) so every change is a kardex row + JE.
 */
function applyStockMatrix(db, productId, cells, opts = {}) {
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!product) throw Object.assign(new Error('محصول یافت نشد'), { status: 404 });
  const activeColorIdsBefore = activeMatrixColorIds(db, productId);
  const list = Array.isArray(cells) ? cells : [];
  const colorIds = [...new Set(list.map((c) => Number(c.color_id)).filter(Boolean))];
  const sizeIds = [...new Set(list.map((c) => Number(c.size_id)).filter(Boolean))];
  const warehouseId = opts.warehouse_id != null && opts.warehouse_id !== ''
    ? parseInt(opts.warehouse_id, 10)
    : (product.warehouse_id ? parseInt(product.warehouse_id, 10) : null);
  if (colorIds.length && sizeIds.length) {
    const generated = generateMatrix(db, {
      product_id: productId,
      color_ids: colorIds,
      size_ids: sizeIds,
      auto_barcode: opts.auto_barcode !== false,
      stock: 0,
    });
    deactivateUnselectedVariants(db, productId, colorIds, sizeIds);
    opts = {
      ...opts,
      generatedKeepColorIds: generated.kept_new_color_ids || [],
    };
  }
  const activeColorIdsAfter = activeMatrixColorIds(db, productId);
  const newlyActivated = [...activeColorIdsAfter]
    .filter((colorId) => !activeColorIdsBefore.has(colorId));
  // In the HTTP save flow generate-matrix is a separate request immediately before this one,
  // so a selected never-stocked color is also considered new even though it was already active
  // when stock-matrix began.
  const neverStockedSelected = [];
  for (const colorId of colorIds) {
    let variants = [];
    try {
      variants = db.prepare(`
        SELECT * FROM product_variants
        WHERE product_id=? AND color_id=? AND COALESCE(is_default,0)=0
      `).all(productId, colorId);
    } catch (_) { variants = []; }
    if (variants.length && !variants.some((v) => variantHasStockHistory(db, v))) {
      neverStockedSelected.push(colorId);
    }
  }
  const keepColorIds = normalizeColorIds([
    ...(opts.generatedKeepColorIds || []),
    ...newlyActivated,
    ...neverStockedSelected,
  ]);
  afterVariantStockWrite(db, productId, { keepColorIds });
  refreshLiveColorCount(db, productId, colorIds.length);
  const live = db.prepare('SELECT stock FROM products WHERE id=?').get(productId);
  return addZeroColorHint({
    product_id: productId,
    stock: Number(live && live.stock) || 0,
    warehouse_id: warehouseId || null,
    updated: [],
    pack: packSizeFor(db, productId),
    variants: listVariants(db, productId, { include_default: false }),
  }, keepColorIds);
}

/** Qty a SKU holds right now in the target warehouse (vws; company-wide pv.stock when no warehouse). */
function skuQtyAt(db, variantId, warehouseId) {
  return require('../inventory/movement').variantWarehouseQty(db, variantId, warehouseId || null);
}

/**
 * P1 — set per-SKU quantities from the matrix grid. Structure first (applyStockMatrix), then
 * every CHANGED cell becomes one manualAdjust.postAdjust(mode='count', variant_id) inside the
 * caller's transaction (this function opens one if none) with a shared batch note.
 * Colors are retired once, at the end, never between cells.
 *
 * @param {object} opts  warehouse_id, reason_code, date, note, auto_barcode
 * @param {object|null} user
 */
function postStockMatrix(db, productId, cells, opts = {}, user = null) {
  const { parseStockQty } = require('../inventory/qty-policy');
  const MA = require('../inventory/manual-adjust');
  const list = Array.isArray(cells) ? cells : [];
  let out;
  db.transaction(() => {
    holdColorRetire(db);
    try {
      const base = applyStockMatrix(db, productId, list, opts);
      const product = db.prepare('SELECT unit FROM products WHERE id=?').get(productId);
      const warehouseId = base.warehouse_id;
      const batch = `ماتریس رنگ×سایز #${Date.now().toString(36)}`;
      const findMatrix = db.prepare(`
        SELECT * FROM product_variants
        WHERE product_id=? AND color_id=? AND size_id=? AND active=1
        LIMIT 1
      `);
      const updated = [];
      for (const cell of list) {
        const colorId = Number(cell.color_id);
        const sizeId = Number(cell.size_id);
        if (!colorId || !sizeId) continue;
        if (cell.qty === undefined || cell.qty === null || cell.qty === '') continue;
        let qty;
        try {
          qty = parseStockQty(cell.qty, {
            db, productId, unit: product && product.unit, integer: true, strict: true, fallback: 0,
          });
        } catch (e) {
          if (e && e.code === 'E_QTY_NOT_INTEGER') {
            throw Object.assign(new Error('موجودی رنگ×سایز باید عدد صحیح باشد (مثلاً ۳ نه ۰٫۷۵)'), {
              status: 400, code: 'E_QTY_NOT_INTEGER',
            });
          }
          throw Object.assign(new Error('موجودی رنگ×سایز نامعتبر است'), { status: 400 });
        }
        if (!Number.isFinite(qty) || qty < 0) {
          throw Object.assign(new Error('موجودی رنگ×سایز نامعتبر است'), { status: 400 });
        }
        const row = findMatrix.get(productId, colorId, sizeId);
        if (!row) continue;
        const cur = skuQtyAt(db, row.id, warehouseId);
        if (Math.abs(cur - qty) < 1e-9) continue;
        const r = MA.postAdjust(db, {
          product_id: productId,
          variant_id: row.id,
          warehouse_id: warehouseId,
          mode: 'count',
          qty,
          reason_code: opts.reason_code || undefined,
          date: opts.date || undefined,
          note: [batch, opts.note].filter(Boolean).join(' — '),
        }, user);
        updated.push({
          id: row.id, color_id: colorId, size_id: sizeId, warehouse_id: warehouseId,
          warehouse_qty: qty, delta_qty: r.delta_qty, ledger_id: r.id, tx_no: r.tx_no, je_id: r.je_id,
        });
      }
      out = { ...base, updated };
    } finally {
      releaseColorRetire(db);
    }
    afterVariantStockWrite(db, productId, { keepColorIds: out.kept_new_color_ids || [] });
    refreshLiveColorCount(db, productId);
    const live = db.prepare('SELECT stock FROM products WHERE id=?').get(productId);
    out.stock = Number(live && live.stock) || 0;
    out.pack = packSizeFor(db, productId);
    out.variants = listVariants(db, productId, { include_default: false });
  })();
  return out;
}

function styleMetadata(db, productId) {
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!product) return null;
  const variantCount = db.prepare(`
    SELECT COUNT(*) c FROM product_variants
    WHERE product_id=? AND active=1 AND is_default=0
  `).get(productId).c;
  const defaultVariant = product.default_variant_id
    ? getVariant(db, product.default_variant_id)
    : db.prepare(
      'SELECT * FROM product_variants WHERE product_id=? AND is_default=1 LIMIT 1'
    ).get(productId);
  const pack = packSizeFor(db, productId);
  return {
    is_style: product.is_style != null ? product.is_style : 1,
    has_variants: product.has_variants != null ? product.has_variants : (variantCount > 0 ? 1 : 0),
    default_variant_id: defaultVariant ? defaultVariant.id : null,
    variant_count: variantCount,
    pack_size: pack.pack_size,
    pack_size_auto: pack.pack_size_auto,
    live_colors: pack.live_colors,
    live_sizes: pack.live_sizes,
  };
}

/**
 * Stamp live SKU flags onto product list/detail rows so sales catalog
 * buttons do not depend on the stale products.has_variants column alone.
 */
function attachVariantFlags(db, rows) {
  const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  if (!list.length) return rows;
  try {
    const ids = list.map((r) => Number(r && r.id)).filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) return rows;
    const map = new Map();
    const chunk = 200;
    for (let i = 0; i < ids.length; i += chunk) {
      const part = ids.slice(i, i + chunk);
      const ph = part.map(() => '?').join(',');
      const counts = db.prepare(`
        SELECT product_id, COUNT(*) AS c
        FROM product_variants
        WHERE active=1 AND COALESCE(is_default,0)=0 AND product_id IN (${ph})
        GROUP BY product_id
      `).all(...part);
      counts.forEach((x) => map.set(Number(x.product_id), Number(x.c) || 0));
    }
    for (const row of list) {
      const c = map.get(Number(row.id)) || 0;
      row.variant_sku_count = c;
      if (c > 0) row.has_variants = 1;
    }
  } catch (_) { /* product_variants may be absent on very old DBs */ }
  return rows;
}

/**
 * Live color×size summary for catalog/invoice picker chips.
 * With warehouseId: qty from variant_warehouse_stock only (missing row = 0).
 * Without warehouseId: product_variants.stock (company-wide).
 */
function variantLineSummary(db, productId, warehouseId) {
  const pack = packSizeFor(db, productId);
  if (!pack.has_matrix) {
    return {
      line: '', colors: [], sizes: [], live_colors: 0, live_sizes: 0, has_matrix: 0,
      warehouse_id: null, stock_scope: 'none',
      full_packs_count: 0, leftover_singles_qty: 0, stocked_qty: 0,
    };
  }
  let variants = [];
  try { variants = listVariants(db, productId, { include_default: false }); } catch (_) { variants = []; }

  const whId = warehouseId != null && warehouseId !== '' ? parseInt(warehouseId, 10) : null;
  const scoped = !!(whId && Number.isFinite(whId));
  let qtyStmt = null;
  if (scoped) {
    try {
      qtyStmt = db.prepare(
        'SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?'
      );
    } catch (_) { qtyStmt = null; }
  }

  const live = variants.filter((v) => {
    if (scoped) {
      if (!qtyStmt) return false;
      const row = qtyStmt.get(v.id, whId);
      return row ? (Number(row.qty) || 0) > 0 : false;
    }
    return (Number(v.stock) || 0) > 0;
  });
  const { displaySizeName } = require('../display-labels');
  const colors = [...new Set(live.map((v) => String(v.color_name || '').trim()).filter(Boolean))];
  // sizes[] = نام کامل master (هویت/match)؛ line = برچسب نمایش بدون «(مناسب تا/از …)»
  const sizes = [...new Set(live.map((v) => String(v.size_name || '').trim()).filter(Boolean))];
  const sizesDisp = [...new Set(sizes.map((z) => displaySizeName(z)).filter(Boolean))];
  const line = [colors.length ? colors.join('، ') : '', sizesDisp.length ? sizesDisp.join(' ') : ''].filter(Boolean).join(' · ');

  let full_packs_count = Number(pack.full_packs_count) || 0;
  let leftover_singles_qty = 0;
  let stocked_qty = 0;
  if (scoped) {
    try {
      const { expandLivePack } = require('../inventory/movement');
      const lp = expandLivePack(db, productId, whId, { mode: 'live' });
      full_packs_count = Number(lp.full_packs_count) || 0;
      leftover_singles_qty = Number(lp.leftover_singles_qty) || 0;
      stocked_qty = Number(lp.stocked_qty) || 0;
    } catch (_) { /* keep packSizeFor globals */ }
  } else {
    stocked_qty = live.reduce((a, v) => a + Math.max(0, Math.floor(Number(v.stock) || 0)), 0);
    const packUnit = Number(pack.pack_size_auto) || 0;
    leftover_singles_qty = Math.max(0, stocked_qty - (full_packs_count * packUnit));
  }

  return {
    line,
    colors,
    sizes,
    live_colors: colors.length,
    live_sizes: sizes.length,
    has_matrix: 1,
    warehouse_id: scoped ? whId : null,
    stock_scope: scoped ? 'warehouse' : 'global',
    full_packs_count,
    leftover_singles_qty,
    stocked_qty,
  };
}

module.exports = {
  buildSku,
  upsertColor,
  upsertSize,
  attachStyleColor,
  attachStyleSize,
  ensureDefaultVariant,
  generateMatrix,
  listVariants,
  getVariant,
  createVariant,
  updateVariant,
  adjustVariantStock,
  softDeleteVariant,
  packSizeFor,
  applyStockMatrix,
  postStockMatrix,
  reactivateVariant,
  variantCarriesStock,
  deactivateUnselectedVariants,
  retireZeroStockColors,
  afterVariantStockWrite,
  holdColorRetire,
  releaseColorRetire,
  styleMetadata,
  variantLineSummary,
  attachVariantFlags,
};

