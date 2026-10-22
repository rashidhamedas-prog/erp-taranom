'use strict';
/**
 * Variant-aware stock movements (inventory_movements + variant_warehouse_stock).
 * Matrix products require variant_id; fabric/batch callers must not use this path.
 */
const { round3 } = require('../round3');
const {
  requiresIntegerQty,
  allocateIntegers,
  healApparelIntegerStock,
} = require('./qty-policy');

function movErr(code, status, message) {
  const e = new Error(message || code);
  e.code = code;
  e.status = status || 400;
  return e;
}

function shortErr(db, message, row) {
  return require('./shortage-error').attach(movErr('E_NEGATIVE_STOCK', 409, message), db, [row]);
}

function tableExists(db, name) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name);
}

function hasActiveMatrixVariants(db, productId) {
  if (!tableExists(db, 'product_variants')) return false;
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM product_variants
    WHERE product_id=? AND active=1 AND COALESCE(is_default,0)=0
  `).get(productId);
  return (Number(row && row.c) || 0) > 0;
}

function findExistingMovement(db, { docType, docId, docLine, warehouseId, variantId }) {
  if (docId == null) return null;
  return db.prepare(`
    SELECT * FROM inventory_movements
    WHERE doc_type=? AND doc_id=?
      AND COALESCE(doc_line,-1)=COALESCE(?, -1)
      AND COALESCE(warehouse_id,0)=COALESCE(?, 0)
      AND COALESCE(variant_id,0)=COALESCE(?, 0)
    LIMIT 1
  `).get(docType, docId, docLine == null ? null : docLine, warehouseId, variantId);
}

/**
 * One-shot opening seed: only when a matrix product has exactly one warehouse_stock row.
 * Copies product_variants.stock → variant_warehouse_stock and posts opening movements.
 * Multi-warehouse products are left untouched.
 */
function seedVariantWarehouseOpening(db) {
  if (!tableExists(db, 'product_variants') || !tableExists(db, 'warehouse_stock')) return;
  if (!tableExists(db, 'variant_warehouse_stock') || !tableExists(db, 'inventory_movements')) return;

  const products = db.prepare(`
    SELECT DISTINCT pv.product_id AS id
    FROM product_variants pv
    WHERE pv.active=1 AND COALESCE(pv.is_default,0)=0
  `).all();

  const whCountStmt = db.prepare(
    'SELECT warehouse_id, qty FROM warehouse_stock WHERE product_id=?'
  );
  const variantsStmt = db.prepare(`
    SELECT id, stock FROM product_variants
    WHERE product_id=? AND active=1 AND COALESCE(is_default,0)=0
  `);
  const vwsGet = db.prepare(
    'SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?'
  );
  const vwsIns = db.prepare(`
    INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty)
    VALUES (?,?,?)
    ON CONFLICT(variant_id, warehouse_id) DO NOTHING
  `);

  for (const p of products) {
    const whRows = whCountStmt.all(p.id);
    if (whRows.length !== 1) continue;
    const warehouseId = whRows[0].warehouse_id;
    const variants = variantsStmt.all(p.id);
    for (const v of variants) {
      const stock = round3(Number(v.stock) || 0);
      if (!vwsGet.get(v.id, warehouseId)) {
        vwsIns.run(v.id, warehouseId, stock);
      }
      const existingOpen = findExistingMovement(db, {
        docType: 'opening_seed',
        docId: p.id,
        docLine: v.id,
        warehouseId,
        variantId: v.id,
      });
      if (existingOpen) continue;
      if (stock === 0) continue;
      db.prepare(`
        INSERT INTO inventory_movements
          (product_id, variant_id, warehouse_id, qty_delta, doc_type, doc_id, doc_line, user_id, note)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(
        p.id, v.id, warehouseId, stock, 'opening_seed', p.id, v.id, null,
        'seed variant_warehouse_stock from product_variants.stock'
      );
    }
  }
}

function ensureInventorySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      variant_id INTEGER,
      warehouse_id INTEGER,
      qty_delta REAL NOT NULL,
      doc_type TEXT NOT NULL,
      doc_id INTEGER,
      doc_line INTEGER,
      user_id INTEGER,
      note TEXT DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS variant_warehouse_stock (
      variant_id INTEGER NOT NULL,
      warehouse_id INTEGER NOT NULL,
      qty REAL DEFAULT 0,
      PRIMARY KEY (variant_id, warehouse_id)
    );
  `);

  // Expression unique key so NULL variant_id / warehouse_id still idempotent
  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_inventory_movements_doc
      ON inventory_movements (
        doc_type,
        doc_id,
        COALESCE(doc_line, -1),
        COALESCE(warehouse_id, 0),
        COALESCE(variant_id, 0)
      )
      WHERE doc_id IS NOT NULL
    `);
  } catch (e) {
    // Fallback literal index if expression indexes unavailable
    try {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS ux_inventory_movements_doc_lit
        ON inventory_movements (doc_type, doc_id, doc_line, warehouse_id, variant_id)
        WHERE doc_id IS NOT NULL
      `);
    } catch (_) { /* ignore */ }
  }

  try {
    db.exec('CREATE INDEX IF NOT EXISTS ix_inv_mov_product ON inventory_movements(product_id, id)');
    db.exec('CREATE INDEX IF NOT EXISTS ix_inv_mov_variant ON inventory_movements(variant_id, id)');
    db.exec('CREATE INDEX IF NOT EXISTS ix_inv_mov_doc ON inventory_movements(doc_type, doc_id)');
  } catch (_) { /* ignore */ }

  try { seedVariantWarehouseOpening(db); } catch (e) {
    console.warn('seedVariantWarehouseOpening:', e.message);
  }
  try { reconcileVariantWarehouseProjections(db); } catch (e) {
    console.warn('reconcileVariantWarehouseProjections:', e.message);
  }
  try { healApparelIntegerStock(db); } catch (e) {
    console.warn('healApparelIntegerStock:', e.message);
  }
}

/**
 * Ensure a VWS row exists. Always seed 0 — never copy product_variants.stock.
 * Seeding with global stock on first touch of a destination warehouse caused
 * phantom double-count (transfer-in: insert global then +qty).
 */
function ensureVariantWhRow(db, variantId, warehouseId, _seedQtyIgnored) {
  if (!variantId || !warehouseId) return;
  db.prepare(`
    INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty)
    VALUES (?,?,0)
    ON CONFLICT(variant_id, warehouse_id) DO NOTHING
  `).run(variantId, warehouseId);
}

function ensureProductWhRow(db, productId, warehouseId, _seedQtyIgnored) {
  if (!productId || !warehouseId) return;
  db.prepare(`
    INSERT INTO warehouse_stock (product_id, warehouse_id, qty)
    VALUES (?,?,0)
    ON CONFLICT(product_id, warehouse_id) DO NOTHING
  `).run(productId, warehouseId);
}

/**
 * @param {object} opts
 * @param {number} opts.productId
 * @param {number|null} [opts.variantId]
 * @param {number|null} [opts.warehouseId]
 * @param {number} opts.qtyDelta  signed; keep ≤3 decimals
 * @param {string} opts.docType
 * @param {number|null} [opts.docId]
 * @param {number|null} [opts.docLine]
 * @param {number|null} [opts.userId]
 * @param {string} [opts.note]
 * @param {boolean} [opts.allowNegative=true]  firm sales keep warning-only (allow neg)
 * @param {boolean} [opts.applyHeaderStock=true]  when false, only variant projections + movement row
 * @param {boolean} [opts.writeStockLog=true]
 */
function postStockMovement(db, opts) {
  const productId = parseInt(opts.productId, 10);
  if (!productId) throw movErr('E_INV_ARGS', 400, 'product_id الزامی است');

  const variantId = opts.variantId != null && opts.variantId !== ''
    ? parseInt(opts.variantId, 10)
    : null;
  const warehouseId = opts.warehouseId != null && opts.warehouseId !== ''
    ? parseInt(opts.warehouseId, 10)
    : null;
  let qtyDelta = round3(opts.qtyDelta);
  if (!Number.isFinite(qtyDelta) || qtyDelta === 0) {
    throw movErr('E_INV_QTY', 400, 'qty_delta نامعتبر است');
  }
  // Apparel / piece goods: never accumulate fractional stock via movements
  if (requiresIntegerQty(db, productId)) {
    const rounded = Math.round(qtyDelta);
    if (Math.abs(qtyDelta - rounded) > 0.001) {
      throw movErr('E_QTY_NOT_INTEGER', 400, 'موجودی کالای قطعه‌ای باید عدد صحیح باشد');
    }
    qtyDelta = rounded;
    if (qtyDelta === 0) {
      throw movErr('E_INV_QTY', 400, 'qty_delta نامعتبر است');
    }
  }
  const docType = String(opts.docType || '').trim();
  if (!docType) throw movErr('E_INV_ARGS', 400, 'doc_type الزامی است');
  const docId = opts.docId != null ? parseInt(opts.docId, 10) : null;
  const docLine = opts.docLine != null ? parseInt(opts.docLine, 10) : null;
  const userId = opts.userId != null ? parseInt(opts.userId, 10) : null;
  const note = opts.note != null ? String(opts.note) : '';
  const allowNegative = opts.allowNegative !== false;
  const applyHeaderStock = opts.applyHeaderStock !== false;
  const writeStockLog = opts.writeStockLog !== false;

  if (hasActiveMatrixVariants(db, productId) && !variantId) {
    throw movErr('E_VARIANT_REQUIRED', 400, 'برای کالای ماتریسی انتخاب واریانت الزامی است');
  }

  if (docId != null) {
    const existing = findExistingMovement(db, {
      docType, docId, docLine, warehouseId, variantId,
    });
    if (existing) return existing;
  }

  if (variantId) {
    const v = db.prepare('SELECT id, product_id, stock, active FROM product_variants WHERE id=?').get(variantId);
    if (!v) throw movErr('E_VARIANT_NOT_FOUND', 404, 'واریانت یافت نشد');
    if (Number(v.product_id) !== productId) {
      throw movErr('E_VARIANT_MISMATCH', 400, 'واریانت متعلق به این کالا نیست');
    }
    if (!Number(v.active)) {
      throw movErr('E_VARIANT_INACTIVE', 400, 'واریانت غیرفعال است و در پک/حرکت موجودی مجاز نیست');
    }
    const nextVar = round3((Number(v.stock) || 0) + qtyDelta);
    if (nextVar < -1e-9 && !allowNegative) {
      throw shortErr(db, 'موجودی واریانت کافی نیست', {
        product_id: productId, variant_id: variantId, warehouse_id: warehouseId,
        available: Number(v.stock) || 0, needed: Math.abs(qtyDelta),
      });
    }
    try {
      require('../product-variants').adjustVariantStock(db, variantId, qtyDelta, 'delta');
    } catch (_) {
      db.prepare('UPDATE product_variants SET stock=? WHERE id=?').run(
        allowNegative ? nextVar : Math.max(0, nextVar), variantId
      );
    }

    if (warehouseId) {
      ensureVariantWhRow(db, variantId, warehouseId);
      const cur = db.prepare(
        'SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?'
      ).get(variantId, warehouseId);
      const whBefore = round3(Number(cur && cur.qty) || 0);
      const whAfter = round3(whBefore + qtyDelta);
      if (whAfter < -1e-9 && !allowNegative) {
        throw shortErr(db, 'موجودی واریانت×انبار کافی نیست', {
          product_id: productId, variant_id: variantId, warehouse_id: warehouseId,
          available: whBefore, needed: Math.abs(qtyDelta),
        });
      }
      db.prepare(
        'UPDATE variant_warehouse_stock SET qty=? WHERE variant_id=? AND warehouse_id=?'
      ).run(allowNegative ? whAfter : Math.max(0, whAfter), variantId, warehouseId);
    }
  }

  if (applyHeaderStock) {
    const prod = db.prepare('SELECT stock, warehouse_id FROM products WHERE id=?').get(productId);
    if (!prod) throw movErr('E_PRODUCT_NOT_FOUND', 404, 'کالا یافت نشد');
    const nextStock = round3((Number(prod.stock) || 0) + qtyDelta);
    if (nextStock < -1e-9 && !allowNegative) {
      throw shortErr(db, 'موجودی کالا کافی نیست', {
        product_id: productId, warehouse_id: warehouseId,
        available: Number(prod.stock) || 0, needed: Math.abs(qtyDelta),
      });
    }
    db.prepare('UPDATE products SET stock=? WHERE id=?').run(
      allowNegative ? nextStock : Math.max(0, nextStock), productId
    );

    if (warehouseId) {
      ensureProductWhRow(db, productId, warehouseId);
      const ws = db.prepare(
        'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
      ).get(productId, warehouseId);
      const whBefore = round3(Number(ws && ws.qty) || 0);
      const whAfter = round3(whBefore + qtyDelta);
      if (whAfter < -1e-9 && !allowNegative) {
        throw shortErr(db, 'موجودی انبار کافی نیست', {
          product_id: productId, warehouse_id: warehouseId,
          available: whBefore, needed: Math.abs(qtyDelta),
        });
      }
      db.prepare(
        'UPDATE warehouse_stock SET qty=? WHERE product_id=? AND warehouse_id=?'
      ).run(allowNegative ? whAfter : Math.max(0, whAfter), productId, warehouseId);
    }

    if (writeStockLog && tableExists(db, 'stock_logs')) {
      db.prepare(
        'INSERT INTO stock_logs (product_id, user_id, change, note) VALUES (?,?,?,?)'
      ).run(productId, userId || 0, qtyDelta, note || docType);
    }
  }

  const ins = db.prepare(`
    INSERT INTO inventory_movements
      (product_id, variant_id, warehouse_id, qty_delta, doc_type, doc_id, doc_line, user_id, note)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    productId,
    variantId,
    warehouseId,
    qtyDelta,
    docType,
    docId,
    docLine,
    userId,
    note
  );

  const movement = db.prepare('SELECT * FROM inventory_movements WHERE id=?').get(ins.lastInsertRowid);
  try {
    require('../website-stock-sync').notifyStockChanged(db, productId, { warehouseId });
  } catch (_) { /* sync is best-effort */ }
  return movement;
}

/**
 * Reverse every movement for a document by posting opposite deltas
 * with doc_type suffix `_void` (unique key differs). Idempotent.
 */
/**
 * Variant×warehouse layer only. Header products.stock / warehouse_stock stay
 * with the perpetual inventory_ledger posting. Idempotent via inventory_movements.
 */
function postVariantLayer(db, opts) {
  const productId = parseInt(opts.productId, 10);
  const variantId = opts.variantId != null && opts.variantId !== ''
    ? parseInt(opts.variantId, 10)
    : null;
  if (hasActiveMatrixVariants(db, productId) && !variantId) {
    throw movErr('E_VARIANT_REQUIRED', 400, 'برای کالای ماتریسی انتخاب واریانت الزامی است');
  }
  if (!variantId) return null;
  return postStockMovement(db, {
    productId,
    variantId,
    warehouseId: opts.warehouseId,
    qtyDelta: opts.qtyDelta,
    docType: opts.docType,
    docId: opts.docId,
    docLine: opts.docLine,
    userId: opts.userId,
    note: opts.note,
    allowNegative: opts.allowNegative !== false,
    applyHeaderStock: false,
    writeStockLog: false,
  });
}

function reverseStockDocument(db, { docType, docId, userId, note, applyHeaderStock } = {}) {
  if (!docType || docId == null) return [];
  const rows = db.prepare(`
    SELECT * FROM inventory_movements
    WHERE doc_type=? AND doc_id=?
    ORDER BY id ASC
  `).all(docType, docId);
  const out = [];
  for (const m of rows) {
    const voidType = String(m.doc_type) + '_void';
    const existing = findExistingMovement(db, {
      docType: voidType,
      docId: m.doc_id,
      docLine: m.doc_line,
      warehouseId: m.warehouse_id,
      variantId: m.variant_id,
    });
    if (existing) {
      out.push(existing);
      continue;
    }
    const posted = postStockMovement(db, {
      productId: m.product_id,
      variantId: m.variant_id,
      warehouseId: m.warehouse_id,
      qtyDelta: -round3(Number(m.qty_delta) || 0),
      docType: voidType,
      docId: m.doc_id,
      docLine: m.doc_line,
      userId: userId != null ? userId : m.user_id,
      note: note || (`ابطال ${m.doc_type}`),
      allowNegative: true,
      applyHeaderStock: applyHeaderStock !== false,
    });
    out.push(posted);
  }
  return out;
}

/**
 * Live pack lines for sales: active non-default variants (optionally stock > 0).
 * When warehouseId is set, ALWAYS read variant_warehouse_stock (missing row = 0).
 * Never fall back to global product_variants.stock for a scoped warehouse.
 *
 * opts.mode:
 *   'live'    — only SKUs with stock > 0 (default; invoice/auto-pack)
 *   'defined' — every active matrix SKU (purchase inbound / allow-negative empty pack)
 *
 * pack_size_auto = number of returned lines (actual SKUs), never a cartesian fill
 * of missing color×size cells.
 */
function expandLivePack(db, productId, warehouseId, opts) {
  const mode = opts && String(opts.mode || '').toLowerCase() === 'defined' ? 'defined' : 'live';
  const pid = parseInt(productId, 10);
  const empty = () => ({
    lines: [],
    pack_size_auto: 1,
    live_colors: 0,
    live_sizes: 0,
    has_matrix: 0,
    matrix_sku_count: 0,
    mode,
  });
  if (!pid) return empty();
  if (!tableExists(db, 'product_variants')) return empty();

  const variants = db.prepare(`
    SELECT pv.id AS variant_id, pv.color_id, pv.size_id, pv.stock,
      pc.name AS color_name, ps.name AS size_name
    FROM product_variants pv
    LEFT JOIN product_colors pc ON pc.id = pv.color_id
    LEFT JOIN product_sizes ps ON ps.id = pv.size_id
    WHERE pv.product_id=? AND pv.active=1 AND COALESCE(pv.is_default,0)=0
      AND (pv.color_id IS NULL OR COALESCE(pc.active,1)=1)
      AND (pv.size_id IS NULL OR COALESCE(ps.active,1)=1)
    ORDER BY pv.id
  `).all(pid);

  const whId = warehouseId != null && warehouseId !== '' ? parseInt(warehouseId, 10) : null;
  const useWh = !!(whId && Number.isFinite(whId) && tableExists(db, 'variant_warehouse_stock'));

  const vwsGet = useWh
    ? db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?')
    : null;

  const lines = [];
  for (const v of variants) {
    let skuStock = round3(Number(v.stock) || 0);
    if (useWh) {
      const row = vwsGet.get(v.variant_id, whId);
      skuStock = row ? round3(Number(row.qty) || 0) : 0;
    }
    if (mode === 'live' && skuStock <= 0) continue;
    lines.push({
      variant_id: v.variant_id,
      color_id: v.color_id,
      size_id: v.size_id,
      color_name: v.color_name || '',
      size_name: v.size_name || '',
      qty: 1,
      sku_stock: skuStock,
    });
  }

  const colors = new Set(lines.map((l) => l.color_id || l.color_name).filter(Boolean));
  const sizes = new Set(lines.map((l) => l.size_id || l.size_name).filter(Boolean));
  let packSizeAuto;
  if (!lines.length) {
    const product = db.prepare('SELECT pack_size FROM products WHERE id=?').get(pid);
    packSizeAuto = Math.max(1, Number(product && product.pack_size) || 1);
  } else {
    packSizeAuto = lines.length;
  }

  return {
    lines,
    pack_size_auto: packSizeAuto,
    live_colors: colors.size,
    live_sizes: sizes.size,
    has_matrix: variants.length > 0 ? 1 : 0,
    matrix_sku_count: variants.length,
    mode,
  };
}

/**
 * Available qty at variant×warehouse.
 * With warehouseId: missing VWS row = 0 (no global fallback).
 * Without warehouseId: product_variants.stock (company-wide total).
 */
function variantWarehouseQty(db, variantId, warehouseId) {
  if (!variantId) return 0;
  if (warehouseId && tableExists(db, 'variant_warehouse_stock')) {
    const row = db.prepare(
      'SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?'
    ).get(variantId, warehouseId);
    return row ? round3(Number(row.qty) || 0) : 0;
  }
  const v = db.prepare('SELECT stock FROM product_variants WHERE id=?').get(variantId);
  return round3(Number(v && v.stock) || 0);
}

/**
 * One-shot: collapse phantom double-count from VWS seed-with-global bug,
 * then rebuild warehouse_stock / products.stock from VWS for matrix SKUs.
 * Idempotent via settings flag vws_wh_reconcile_v1.
 */
function reconcileVariantWarehouseProjections(db) {
  if (!tableExists(db, 'variant_warehouse_stock') || !tableExists(db, 'product_variants')) {
    return { skipped: true };
  }
  if (!tableExists(db, 'settings')) {
    return { skipped: true, reason: 'no_settings' };
  }
  const flag = db.prepare("SELECT value FROM settings WHERE key='vws_wh_reconcile_v1'").get();
  if (flag && String(flag.value) === '1') return { already: true };

  const variants = db.prepare(`
    SELECT id, product_id, stock FROM product_variants
    WHERE active=1 AND COALESCE(is_default,0)=0
  `).all();
  const vwsRows = db.prepare(
    'SELECT variant_id, warehouse_id, qty FROM variant_warehouse_stock WHERE variant_id=?'
  );
  const vwsUpd = db.prepare(
    'UPDATE variant_warehouse_stock SET qty=? WHERE variant_id=? AND warehouse_id=?'
  );
  const varUpd = db.prepare('UPDATE product_variants SET stock=? WHERE id=?');

  let scaled = 0;
  for (const v of variants) {
    const rows = vwsRows.all(v.id);
    if (!rows.length) continue;
    const sum = rows.reduce((a, r) => a + round3(Number(r.qty) || 0), 0);
    const global = round3(Number(v.stock) || 0);
    if (sum > global + 0.001 && global >= 0) {
      if (global === 0 || sum <= 0) {
        for (const r of rows) vwsUpd.run(0, v.id, r.warehouse_id);
      } else if (requiresIntegerQty(db, v.product_id)) {
        // Integer-safe scale (largest remainder) — never invent 0.667 from 2/3
        const target = Math.round(global);
        const next = allocateIntegers(rows.map((r) => Number(r.qty) || 0), target);
        rows.forEach((r, i) => vwsUpd.run(next[i], v.id, r.warehouse_id));
      } else {
        const factor = global / sum;
        let assigned = 0;
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          let next;
          if (i === rows.length - 1) next = round3(global - assigned);
          else {
            next = round3((Number(r.qty) || 0) * factor);
            assigned = round3(assigned + next);
          }
          if (next < 0) next = 0;
          vwsUpd.run(next, v.id, r.warehouse_id);
        }
      }
      scaled += 1;
    }
  }

  // Rebuild warehouse_stock + products.stock from VWS for matrix products
  const matrixProducts = db.prepare(`
    SELECT DISTINCT product_id AS id FROM product_variants
    WHERE active=1 AND COALESCE(is_default,0)=0
  `).all();
  const sumByWh = db.prepare(`
    SELECT vws.warehouse_id AS warehouse_id, COALESCE(SUM(vws.qty),0) AS qty
    FROM variant_warehouse_stock vws
    JOIN product_variants pv ON pv.id=vws.variant_id
    WHERE pv.product_id=? AND COALESCE(pv.is_default,0)=0 AND pv.active=1
    GROUP BY vws.warehouse_id
  `);
  const wsUpsert = db.prepare(`
    INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)
    ON CONFLICT(product_id, warehouse_id) DO UPDATE SET qty=excluded.qty
  `);
  const prodUpd = db.prepare('UPDATE products SET stock=? WHERE id=?');
  let rebuilt = 0;
  for (const p of matrixProducts) {
    const whs = sumByWh.all(p.id);
    let total = 0;
    for (const w of whs) {
      const q = round3(Number(w.qty) || 0);
      total = round3(total + q);
      wsUpsert.run(p.id, w.warehouse_id, q);
    }
    prodUpd.run(total, p.id);
    const vids = db.prepare(`
      SELECT id FROM product_variants
      WHERE product_id=? AND active=1 AND COALESCE(is_default,0)=0
    `).all(p.id);
    for (const row of vids) {
      const s = db.prepare(
        'SELECT COALESCE(SUM(qty),0) AS s FROM variant_warehouse_stock WHERE variant_id=?'
      ).get(row.id);
      varUpd.run(round3(Number(s && s.s) || 0), row.id);
    }
    rebuilt += 1;
  }

  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('vws_wh_reconcile_v1','1')").run();
  return { scaled, rebuilt };
}

module.exports = {
  ensureInventorySchema,
  postStockMovement,
  postVariantLayer,
  reverseStockDocument,
  expandLivePack,
  hasActiveMatrixVariants,
  variantWarehouseQty,
  seedVariantWarehouseOpening,
  reconcileVariantWarehouseProjections,
  healApparelIntegerStock,
};
