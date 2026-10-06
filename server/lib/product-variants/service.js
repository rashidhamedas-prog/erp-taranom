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
    Number(product.stock) || 0
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
  const initialStock = opts.stock != null ? Number(opts.stock) : 0;

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
  return result;
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
    Number(body.stock) || 0,
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
    stock: 'stock',
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

/** Change stock on one SKU only — never touches siblings or products.stock unless requested. */
function adjustVariantStock(db, id, deltaOrAbsolute, mode = 'set') {
  const { parseStockQty, requiresIntegerQty } = require('../inventory/qty-policy');
  const row = db.prepare('SELECT * FROM product_variants WHERE id=?').get(id);
  if (!row) throw Object.assign(new Error('واریانت یافت نشد'), { status: 404 });
  const integer = requiresIntegerQty(db, row.product_id);
  let next;
  if (mode === 'delta') {
    const delta = parseStockQty(deltaOrAbsolute || 0, { integer, strict: integer });
    next = (Number(row.stock) || 0) + delta;
  } else {
    next = parseStockQty(deltaOrAbsolute, { integer, strict: integer });
  }
  if (integer) next = Math.round(next);
  if (!Number.isFinite(next)) {
    throw Object.assign(new Error('موجودی نامعتبر است'), { status: 400 });
  }
  db.prepare('UPDATE product_variants SET stock=? WHERE id=?').run(next, id);
  afterVariantStockWrite(db, row.product_id);
  return getVariant(db, id);
}

/**
 * A color leaves this product's color rows when every size is company-wide zero.
 * Variants are deactivated (not deleted) so invoices keep their variant_id.
 * The shared color catalog row stays. Negative stock is kept so the shortage stays visible.
 */
function retireZeroStockColors(db, productId) {
  const id = parseInt(productId, 10);
  if (!id) return { retired: [] };
  let groups = [];
  try {
    groups = db.prepare(`
      SELECT color_id, COALESCE(SUM(stock),0) AS qty
      FROM product_variants
      WHERE product_id=? AND COALESCE(is_default,0)=0 AND COALESCE(active,1)=1
        AND color_id IS NOT NULL
      GROUP BY color_id
    `).all(id);
  } catch (_) {
    return { retired: [] };
  }
  const deactivate = db.prepare(`
    UPDATE product_variants
    SET active=0, status='inactive', stock=0
    WHERE product_id=? AND color_id=? AND COALESCE(is_default,0)=0 AND COALESCE(active,1)=1
  `);
  const dropStyle = db.prepare('DELETE FROM product_style_colors WHERE product_id=? AND color_id=?');
  const retired = [];
  for (const group of groups) {
    const qty = Number(group.qty) || 0;
    if (qty > 1e-9 || qty < -1e-9) continue;
    deactivate.run(id, group.color_id);
    try { dropStyle.run(id, group.color_id); } catch (_) { /* style table may be absent in tiny fixtures */ }
    retired.push(Number(group.color_id));
  }
  return { retired };
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
function afterVariantStockWrite(db, productId) {
  if (websiteStockPushEnabled(db)) return { deferred: true, retired: [] };
  return retireZeroStockColors(db, productId);
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

/** Live pack = distinct in-stock colors × sizes. Zero-stock colors (e.g. مشکی) leave the pack. */
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
      live_colors: 0,
      live_sizes: 0,
      has_matrix: 0,
    };
  }
  const live = variants.filter((v) => (Number(v.stock) || 0) > 0);
  const colors = new Set(live.map((v) => v.color_id || v.color_name).filter(Boolean));
  const sizes = new Set(live.map((v) => v.size_id || v.size_name).filter(Boolean));
  const auto = live.length ? Math.max(1, colors.size * sizes.size) : fallback;
  return {
    pack_size: fallback,
    pack_size_auto: auto,
    live_colors: colors.size,
    live_sizes: sizes.size,
    has_matrix: 1,
  };
}

function variantStockLivesInAnotherWarehouse(db, variantId, warehouseId) {
  const wh = parseInt(warehouseId, 10);
  if (!wh || !variantId) return false;
  try {
    const here = db.prepare(`
      SELECT COALESCE(qty,0) AS q FROM variant_warehouse_stock
      WHERE variant_id=? AND warehouse_id=?
    `).get(variantId, wh);
    const hereQty = Number(here && here.q) || 0;
    if (hereQty > 1e-9 || hereQty < -1e-9) return false;
    const elsewhere = db.prepare(`
      SELECT COALESCE(SUM(qty),0) AS s FROM variant_warehouse_stock
      WHERE variant_id=? AND warehouse_id!=?
    `).get(variantId, wh);
    const other = Number(elsewhere && elsewhere.s) || 0;
    return other > 1e-9 || other < -1e-9;
  } catch (_) {
    return false;
  }
}

function deactivateUnselectedVariants(db, productId, colorIds, sizeIds, opts = {}) {
  const colors = new Set((colorIds || []).map(Number).filter(Boolean));
  const sizes = new Set((sizeIds || []).map(Number).filter(Boolean));
  if (!colors.size || !sizes.size) return { deactivated: 0 };
  const rows = db.prepare(`
    SELECT id, color_id, size_id, stock FROM product_variants
    WHERE product_id=? AND is_default=0 AND active=1
  `).all(productId);
  let deactivated = 0;
  const keptColors = new Set(colors);
  const upd = db.prepare("UPDATE product_variants SET active=0, status='inactive', stock=0 WHERE id=?");
  for (const row of rows) {
    if (colors.has(Number(row.color_id)) && sizes.has(Number(row.size_id))) continue;
    // Already-zero colors stay active until retireZeroStockColors so a website
    // push can still send qty 0. Unchecking a color that still has stock removes it now.
    const qty = Number(row.stock) || 0;
    if (qty <= 1e-9 && qty >= -1e-9) continue;
    // This save only edits one warehouse. Zero here, with pieces elsewhere, stays on the product.
    if (variantStockLivesInAnotherWarehouse(db, row.id, opts.warehouse_id)) {
      keptColors.add(Number(row.color_id));
      continue;
    }
    upd.run(row.id);
    deactivated += 1;
  }
  const colorList = [...keptColors];
  const sizeList = [...sizes];
  db.prepare(`DELETE FROM product_style_colors WHERE product_id=? AND color_id NOT IN (${colorList.map(() => '?').join(',')})`)
    .run(productId, ...colorList);
  db.prepare(`DELETE FROM product_style_sizes WHERE product_id=? AND size_id NOT IN (${sizeList.map(() => '?').join(',')})`)
    .run(productId, ...sizeList);
  return { deactivated };
}

/**
 * Set per-SKU qty (color × size). Header products.stock and warehouse_stock
 * become the sum so live pack = in-stock colors × in-stock sizes.
 * Unchecked colors/sizes are deactivated so they leave the live pack.
 * Matrix SKUs are always piece goods → INTEGER qty (qty-policy).
 */
function applyStockMatrix(db, productId, cells, opts = {}) {
  const { parseStockQty } = require('../inventory/qty-policy');
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!product) throw Object.assign(new Error('محصول یافت نشد'), { status: 404 });
  const list = Array.isArray(cells) ? cells : [];
  const colorIds = [...new Set(list.map((c) => Number(c.color_id)).filter(Boolean))];
  const sizeIds = [...new Set(list.map((c) => Number(c.size_id)).filter(Boolean))];
  if (colorIds.length && sizeIds.length) {
    generateMatrix(db, {
      product_id: productId,
      color_ids: colorIds,
      size_ids: sizeIds,
      auto_barcode: opts.auto_barcode !== false,
      stock: 0,
    });
    deactivateUnselectedVariants(db, productId, colorIds, sizeIds, { warehouse_id: warehouseId });
  }
  const findMatrix = db.prepare(`
    SELECT * FROM product_variants
    WHERE product_id=? AND color_id=? AND size_id=? AND active=1
    LIMIT 1
  `);
  const warehouseId = opts.warehouse_id != null && opts.warehouse_id !== ''
    ? parseInt(opts.warehouse_id, 10)
    : (product.warehouse_id ? parseInt(product.warehouse_id, 10) : null);
  const hasVws = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='variant_warehouse_stock'"
  ).get();
  const updated = [];
  for (const cell of list) {
    const colorId = Number(cell.color_id);
    const sizeId = Number(cell.size_id);
    if (!colorId || !sizeId) continue;
    let qty;
    try {
      qty = parseStockQty(cell.qty, {
        db, productId, unit: product.unit, integer: true, strict: true, fallback: 0,
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
    if (hasVws && warehouseId) {
      db.prepare(`
        INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty)
        VALUES (?,?,?)
        ON CONFLICT(variant_id, warehouse_id) DO UPDATE SET qty=excluded.qty
      `).run(row.id, warehouseId, qty);
      const sumAll = db.prepare(
        'SELECT COALESCE(SUM(qty),0) AS s FROM variant_warehouse_stock WHERE variant_id=?'
      ).get(row.id);
      const global = Math.round(Number(sumAll && sumAll.s) || 0);
      db.prepare('UPDATE product_variants SET stock=? WHERE id=?').run(global, row.id);
      updated.push({
        id: row.id, color_id: colorId, size_id: sizeId,
        stock: global, warehouse_id: warehouseId, warehouse_qty: qty,
      });
    } else {
      db.prepare('UPDATE product_variants SET stock=? WHERE id=?').run(qty, row.id);
      updated.push({ id: row.id, color_id: colorId, size_id: sizeId, stock: qty });
    }
  }

  // Rebuild product + warehouse totals from VWS (or sum of cells if no VWS)
  let productStock = 0;
  if (hasVws) {
    const byWh = db.prepare(`
      SELECT vws.warehouse_id AS warehouse_id, COALESCE(SUM(vws.qty),0) AS qty
      FROM variant_warehouse_stock vws
      JOIN product_variants pv ON pv.id=vws.variant_id
      WHERE pv.product_id=? AND COALESCE(pv.is_default,0)=0 AND pv.active=1
      GROUP BY vws.warehouse_id
    `).all(productId);
    for (const w of byWh) {
      const q = Math.round(Number(w.qty) || 0);
      productStock += q;
      db.prepare(`
        INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)
        ON CONFLICT(product_id, warehouse_id) DO UPDATE SET qty=excluded.qty
      `).run(productId, w.warehouse_id, q);
    }
    if (!byWh.length && warehouseId) {
      db.prepare(`
        INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,0)
        ON CONFLICT(product_id, warehouse_id) DO UPDATE SET qty=0
      `).run(productId, warehouseId);
    }
  } else {
    productStock = updated.reduce((a, u) => a + (Number(u.stock) || 0), 0);
    if (warehouseId) {
      db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,0)')
        .run(productId, warehouseId);
      db.prepare('UPDATE warehouse_stock SET qty=? WHERE product_id=? AND warehouse_id=?')
        .run(productStock, productId, warehouseId);
    }
  }
  afterVariantStockWrite(db, productId);
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
    liveColorCount = colorIds.length;
  }
  db.prepare('UPDATE products SET stock=?, colors=? WHERE id=?').run(
    productStock, Math.max(1, Number(liveColorCount) || 0), productId
  );
  return {
    product_id: productId,
    stock: productStock,
    warehouse_id: warehouseId || null,
    updated,
    pack: packSizeFor(db, productId),
    variants: listVariants(db, productId, { include_default: false }),
  };
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
  const colors = [...new Set(live.map((v) => String(v.color_name || '').trim()).filter(Boolean))];
  const sizes = [...new Set(live.map((v) => String(v.size_name || '').trim()).filter(Boolean))];
  const line = [colors.length ? colors.join('، ') : '', sizes.length ? sizes.join(' ') : ''].filter(Boolean).join(' · ');
  return {
    line,
    colors,
    sizes,
    live_colors: colors.length,
    live_sizes: sizes.length,
    has_matrix: 1,
    warehouse_id: scoped ? whId : null,
    stock_scope: scoped ? 'warehouse' : 'global',
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
  deactivateUnselectedVariants,
  retireZeroStockColors,
  afterVariantStockWrite,
  styleMetadata,
  variantLineSummary,
  attachVariantFlags,
};

