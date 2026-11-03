'use strict';
/**
 * Variant-aware stock movements (inventory_movements = audit/idempotency log of variant lines).
 * SSOT: no stock figure is written here — quantities live in inventory_ledger and the caches are
 * derived by stock-cache.js. Matrix products require variant_id; fabric/batch callers must not use this path.
 */
const { round3 } = require('../round3');
const {
  requiresIntegerQty,
  healApparelIntegerStock,
} = require('./qty-policy');
const { unitPriceRialForVariant } = require('./pack-unit-price');

function movErr(code, status, message) {
  const e = new Error(message || code);
  e.code = code;
  e.status = status || 400;
  return e;
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
 * One-shot opening seed audit: only when a matrix product has exactly one warehouse_stock row.
 * Records product_variants.stock as opening_seed movements (audit only).
 * SSOT: variant_warehouse_stock is never written here — it is derived from the ledger.
 * Multi-warehouse products are left untouched.
 */
function seedVariantWarehouseOpening(db) {
  if (!tableExists(db, 'product_variants') || !tableExists(db, 'warehouse_stock')) return;
  if (!tableExists(db, 'inventory_movements')) return;

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

  for (const p of products) {
    const whRows = whCountStmt.all(p.id);
    if (whRows.length !== 1) continue;
    const warehouseId = whRows[0].warehouse_id;
    const variants = variantsStmt.all(p.id);
    for (const v of variants) {
      const stock = round3(Number(v.stock) || 0);
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
 * @param {boolean} [opts.allowNegative=false]  fail-closed; callers that need neg must pass true
 * @param {boolean} [opts.applyHeaderStock=true]  when false, only the movement row (variant layer of
 *   a caller ledger row); when true, the qty is also posted as an inventory_ledger row
 * @param {boolean} [opts.writeStockLog]  ignored — stock_logs follow the ledger row
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
  const allowNegative = opts.allowNegative === true;
  const applyHeaderStock = opts.applyHeaderStock !== false;

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
    // P1: a void/reversal must still land on a variant that was retired meanwhile.
    if (!Number(v.active) && !/_void$/.test(docType)) {
      throw movErr('E_VARIANT_INACTIVE', 400, 'واریانت غیرفعال است و در پک/حرکت موجودی مجاز نیست');
    }
  }

  // SSOT: this function never writes a stock figure.
  //  - applyHeaderStock false (variant layer): the caller's inventory_ledger row (with variant_id)
  //    is the quantity and was gated there; this only records the audit/idempotency movement.
  //  - applyHeaderStock true (legacy non-perpetual docs, feature_perpetual_docs=0): there is no
  //    caller ledger row, so the quantity is posted here as a ledger row (gated, cost-neutral).
  if (applyHeaderStock) {
    const prod = db.prepare('SELECT id, average_cost_rial FROM products WHERE id=?').get(productId);
    if (!prod) throw movErr('E_PRODUCT_NOT_FOUND', 404, 'کالا یافت نشد');
    const L = require('./ledger');
    L.postInventoryMovement(db, {
      eventType: qtyDelta > 0 ? 'receipt' : 'issue',
      productId,
      warehouseId,
      variantId,
      qty: qtyDelta,
      unitCostRial: Math.round(Number(prod.average_cost_rial) || 0),
      sourceType: `mov_${docType}`,
      sourceId: docId,
      note: note || docType,
      createdBy: userId || null,
      updateAvg: false,
      allowZeroCost: true,
      allowNegative,
    });
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
  // Idempotent re-derive (covers callers whose ledger row was written before this layer).
  require('./stock-cache').rebuildStockCache(db, productId);
  if (variantId) {
    try { require('../product-variants').afterVariantStockWrite(db, productId); } catch (_) { /* optional */ }
  }
  try {
    require('../website-stock-sync').notifyStockChanged(db, productId, { warehouseId });
  } catch (_) { /* sync is best-effort */ }
  return movement;
}

/**
 * Variant×warehouse audit layer only (the caller's inventory_ledger row carries the qty and
 * the variant_id). Idempotent via inventory_movements.
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
    allowNegative: opts.allowNegative === true,
    applyHeaderStock: false,
    writeStockLog: false,
  });
}

/** Live ledger row posted by a header movement (postStockMovement applyHeaderStock) — or null. */
function findHeaderLedgerRow(db, m) {
  const q = round3(Number(m.qty_delta) || 0);
  if (!q) return null;
  const hasVar = require('./ledger').ledgerHasVariantColumn(db);
  return db.prepare(`
    SELECT id FROM inventory_ledger
    WHERE source_type=? AND source_id=? AND product_id=?
      AND COALESCE(warehouse_id,0)=COALESCE(?,0)
      ${hasVar ? 'AND COALESCE(variant_id,0)=COALESCE(?,0)' : ''}
      AND status='posted' AND reversed_of IS NULL
      AND ABS((COALESCE(qty_in,0) - COALESCE(qty_out,0)) - ?) < 0.0005
    ORDER BY id ASC LIMIT 1
  `).get(`mov_${m.doc_type}`, m.doc_id, m.product_id, m.warehouse_id,
    ...(hasVar ? [m.variant_id] : []), q) || null;
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
    // Header void (R12): reverse the ledger row the original header movement posted. A legacy
    // pre-SSOT header movement has no ledger row — it never reached the derived stock, so the
    // void moves nothing either (only the audit movement is recorded).
    if (applyHeaderStock !== false) {
      const led = findHeaderLedgerRow(db, m);
      if (led) {
        require('./ledger').reverseInventoryMovement(db, led.id, {
          createdBy: userId != null ? userId : m.user_id,
          note: note || (`ابطال ${m.doc_type}`),
          allowNegative: true,
        });
      }
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
      applyHeaderStock: false,
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
    matrix: [],
    stocked_sku_count: 0,
    stocked_qty: 0,
    incomplete_colors: [],
    leftover_singles_qty: 0,
    full_packs_count: 0,
  });
  if (!pid) return empty();
  if (!tableExists(db, 'product_variants')) return empty();

  const variants = db.prepare(`
    SELECT pv.id AS variant_id, pv.color_id, pv.size_id, pv.stock,
      pv.price, pv.price_rial,
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

  // Stock every active matrix SKU (warehouse-scoped when warehouse_id given).
  const stocked = [];
  for (const v of variants) {
    let skuStock = round3(Number(v.stock) || 0);
    if (useWh) {
      const row = vwsGet.get(v.variant_id, whId);
      skuStock = row ? round3(Number(row.qty) || 0) : 0;
    }
    stocked.push({
      variant_id: v.variant_id,
      color_id: v.color_id,
      size_id: v.size_id,
      color_name: v.color_name || '',
      size_name: v.size_name || '',
      sku_stock: skuStock,
    });
  }

  const product = db.prepare('SELECT pack_size FROM products WHERE id=?').get(pid);
  const fallback = Math.max(1, Number(product && product.pack_size) || 1);
  const sizeIds = [...new Set(stocked.map((v) => v.size_id).filter(Boolean))];
  const colorIds = [...new Set(stocked.map((v) => v.color_id).filter(Boolean))];
  const stockByKey = new Map(
    stocked.map((v) => [`${Number(v.color_id)}:${Number(v.size_id)}`, Number(v.sku_stock) || 0])
  );

  /**
   * Live pack (v528): a color is "complete" only when every style size has stock > 0.
   * Incomplete colors drop entirely from the pack. Unit size = complete_colors × sizes.
   * full_packs_count = min floor(qty) across those cells.
   * defined mode: all active SKUs (for receive/edit), pack_size_auto = line count.
   */
  let lines = [];
  let packSizeAuto;
  let fullPacks = 0;
  let completeColorIds = [];

  if (mode === 'defined') {
    lines = stocked.map((v) => ({
      variant_id: v.variant_id,
      color_id: v.color_id,
      size_id: v.size_id,
      color_name: v.color_name,
      size_name: v.size_name,
      qty: 1,
      sku_stock: v.sku_stock,
    }));
    packSizeAuto = lines.length ? lines.length : fallback;
    if (lines.length) {
      const mins = lines.map((l) => Math.max(0, Math.floor(Number(l.sku_stock) || 0)));
      fullPacks = mins.length ? Math.min(...mins) : 0;
    }
  } else {
    completeColorIds = colorIds.filter((cid) =>
      sizeIds.length > 0
      && sizeIds.every((sid) => (stockByKey.get(`${Number(cid)}:${Number(sid)}`) || 0) > 0)
    );
    const completeSet = new Set(completeColorIds.map(Number));
    lines = stocked
      .filter((v) => completeSet.has(Number(v.color_id)) && sizeIds.includes(v.size_id))
      .map((v) => ({
        variant_id: v.variant_id,
        color_id: v.color_id,
        size_id: v.size_id,
        color_name: v.color_name,
        size_name: v.size_name,
        qty: 1,
        sku_stock: v.sku_stock,
      }));
    if (completeColorIds.length && sizeIds.length) {
      packSizeAuto = completeColorIds.length * sizeIds.length;
      const mins = lines.map((l) => Math.max(0, Math.floor(Number(l.sku_stock) || 0)));
      fullPacks = mins.length ? Math.min(...mins) : 0;
    } else {
      packSizeAuto = fallback;
      fullPacks = 0;
    }
  }

  const colors = new Set(lines.map((l) => l.color_id || l.color_name).filter(Boolean));
  const sizes = new Set(lines.map((l) => l.size_id || l.size_name).filter(Boolean));

  // Full sellable matrix (all active SKUs) — for partial-pack picker; does not change `lines`.
  const matrix = stocked.map((v) => ({
    variant_id: v.variant_id,
    color_id: v.color_id,
    color_name: v.color_name,
    size_id: v.size_id,
    size_name: v.size_name,
    qty: Math.max(0, Math.floor(Number(v.sku_stock) || 0)),
    sku_stock: v.sku_stock,
    unit_price_rial: unitPriceRialForVariant(db, pid, v.variant_id),
  }));

  const stockedSkus = matrix.filter((m) => (Number(m.sku_stock) || 0) > 0);
  const stocked_sku_count = stockedSkus.length;
  const stocked_qty = stockedSkus.reduce(
    (a, m) => a + Math.max(0, Math.floor(Number(m.sku_stock) || 0)),
    0
  );

  // incomplete_colors: colors that have at least one size with stock but miss another style size
  const incomplete_colors = [];
  if (sizeIds.length && colorIds.length) {
    for (const cid of colorIds) {
      const missing = sizeIds.filter(
        (sid) => (stockByKey.get(`${Number(cid)}:${Number(sid)}`) || 0) <= 0
      );
      const anyStock = sizeIds.some(
        (sid) => (stockByKey.get(`${Number(cid)}:${Number(sid)}`) || 0) > 0
      );
      if (anyStock && missing.length) {
        const sample = stocked.find((s) => Number(s.color_id) === Number(cid));
        const missingNames = missing.map((sid) => {
          const hit = stocked.find((s) => Number(s.size_id) === Number(sid));
          return hit ? hit.size_name : String(sid);
        });
        incomplete_colors.push({
          color_id: cid,
          color_name: (sample && sample.color_name) || '',
          missing_sizes: missingNames,
        });
      }
    }
  }

  // leftover_singles_qty (m on card) = SKU stock not covered by complete full packs.
  // covered = full_packs_count × pack_size_auto when a complete pack exists; else 0.
  const packUnit = lines.length && fullPacks > 0 ? packSizeAuto : 0;
  const covered = packUnit > 0 ? fullPacks * packUnit : 0;
  const leftover_singles_qty = Math.max(0, stocked_qty - covered);

  return {
    lines,
    pack_size_auto: packSizeAuto,
    full_packs_count: fullPacks,
    complete_colors: mode === 'live' ? completeColorIds.length : colors.size,
    live_colors: colors.size,
    live_sizes: sizes.size,
    has_matrix: variants.length > 0 ? 1 : 0,
    matrix_sku_count: variants.length,
    mode,
    matrix,
    stocked_sku_count,
    stocked_qty,
    incomplete_colors,
    leftover_singles_qty,
  };
}

/**
 * Available qty at variant×warehouse — ledger-derived (live rows stamped with the variant).
 * Without warehouseId: company-wide variant total (WIP staging excluded).
 * Old DBs without inventory_ledger.variant_id fall back to the caches.
 */
function variantWarehouseQty(db, variantId, warehouseId) {
  if (!variantId) return 0;
  const L = require('./ledger');
  if (L.ledgerHasVariantColumn(db)) {
    const v = db.prepare('SELECT product_id FROM product_variants WHERE id=?').get(variantId);
    if (!v) return 0;
    return require('./stock-cache').derivedQty(db, {
      productId: v.product_id, warehouseId: warehouseId || null, variantId,
    });
  }
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
 * One-shot (flag vws_wh_reconcile_v1): historically collapsed the VWS seed-with-global
 * double count by rewriting the caches. SSOT: the caches of every matrix product are simply
 * re-derived from the live ledger (stock-cache.js is the only writer).
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
  if (!tableExists(db, 'inventory_ledger')) return { skipped: true, reason: 'no_ledger' };

  const productIds = db.prepare(`
    SELECT DISTINCT product_id AS id FROM product_variants
    WHERE active=1 AND COALESCE(is_default,0)=0
  `).all().map((r) => Number(r.id));
  if (productIds.length) require('./stock-cache').rebuildAllStockCaches(db, { productIds });

  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('vws_wh_reconcile_v1','1')").run();
  return { scaled: 0, rebuilt: productIds.length };
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
