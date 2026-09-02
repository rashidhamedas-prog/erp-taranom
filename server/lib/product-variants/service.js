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
    WHERE product_id=? AND color_id=? AND size_id=? AND active=1
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
        const existing = findMatrix.get(productId, color.id, size.id);
        if (existing) {
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
  const row = db.prepare('SELECT * FROM product_variants WHERE id=?').get(id);
  if (!row) throw Object.assign(new Error('واریانت یافت نشد'), { status: 404 });
  let next;
  if (mode === 'delta') {
    next = (Number(row.stock) || 0) + Number(deltaOrAbsolute || 0);
  } else {
    next = Number(deltaOrAbsolute);
  }
  if (!Number.isFinite(next)) {
    throw Object.assign(new Error('موجودی نامعتبر است'), { status: 400 });
  }
  db.prepare('UPDATE product_variants SET stock=? WHERE id=?').run(next, id);
  return getVariant(db, id);
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

/** Live pack = distinct in-stock colors × sizes (fallback: all active SKUs, then products.pack_size). */
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
  const pool = live.length ? live : variants;
  const colors = new Set(pool.map((v) => v.color_id || v.color_name).filter(Boolean));
  const sizes = new Set(pool.map((v) => v.size_id || v.size_name).filter(Boolean));
  const auto = Math.max(1, colors.size * sizes.size);
  return {
    pack_size: fallback,
    pack_size_auto: auto,
    live_colors: colors.size,
    live_sizes: sizes.size,
    has_matrix: 1,
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
  styleMetadata,
};
