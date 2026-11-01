'use strict';
/**
 * P0-APP1 — Product variants / colors / sizes API.
 * ORCH must mount: app.use('/api/product-variants', require('./routes/product-variants'));
 * See ORCH-MOUNT.md (do not edit server.js from this task).
 */
const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting, centralOnly } = require('../middleware/auth');
const {
  initProductVariantsSchema,
  upsertColor,
  upsertSize,
  generateMatrix,
  applyStockMatrix,
  postStockMatrix,
  listVariants,
  getVariant,
  createVariant,
  updateVariant,
  softDeleteVariant,
  ensureDefaultVariant,
  styleMetadata,
  decorateColor,
  normalizeAndAssertHex,
  assertUniqueHex,
  variantLineSummary,
} = require('../lib/product-variants');

function ensureSchema(db) {
  try {
    initProductVariantsSchema(db);
  } catch (e) {
    // Tables may already exist; surface real errors to caller
    if (!String(e.message || e).includes('already')) throw e;
  }
}

function sendErr(res, e) {
  const status = e.status || e.statusCode || 500;
  const body = { error: e.message || String(e) };
  if (e.code) body.code = e.code;
  if (e.existing_id) body.existing_id = e.existing_id;
  return res.status(status).json(body);
}

// ── Colors ──────────────────────────────────────────────────────────────

router.get('/colors', auth, (req, res) => {
  try {
    const db = getDB();
    ensureSchema(db);
    const activeOnly = String(req.query.all || '') !== '1';
    const rows = db.prepare(`
      SELECT * FROM product_colors
      ${activeOnly ? 'WHERE active=1' : ''}
      ORDER BY sort_order, id
    `).all().map(decorateColor);
    res.json(rows);
  } catch (e) { sendErr(res, e); }
});

router.post('/colors', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    ensureSchema(db);
    const row = decorateColor(upsertColor(db, req.body || {}));
    try { audit(req.user.id, 'create', 'product_colors', row.id, `رنگ ${row.name}`, req); } catch (_) {}
    res.status(201).json(row);
  } catch (e) { sendErr(res, e); }
});

router.put('/colors/:id', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    ensureSchema(db);
    const id = parseInt(req.params.id, 10);
    const existing = db.prepare('SELECT * FROM product_colors WHERE id=?').get(id);
    if (!existing) return res.status(404).json({ error: 'رنگ یافت نشد' });
    const name = req.body.name != null ? String(req.body.name).trim() : existing.name;
    if (!name) return res.status(400).json({ error: 'نام رنگ الزامی است' });
    const code = req.body.code != null ? String(req.body.code).trim() : existing.code;
    const hex = req.body.hex != null ? normalizeAndAssertHex(req.body.hex) : existing.hex;
    assertUniqueHex(db, hex, id);
    const sort = req.body.sort_order != null ? parseInt(req.body.sort_order, 10) : existing.sort_order;
    const active = req.body.active != null ? (req.body.active ? 1 : 0) : existing.active;
    db.prepare(
      'UPDATE product_colors SET name=?, code=?, hex=?, sort_order=?, active=? WHERE id=?'
    ).run(name, code, hex, sort, active, id);
    res.json(decorateColor(db.prepare('SELECT * FROM product_colors WHERE id=?').get(id)));
  } catch (e) { sendErr(res, e); }
});

router.delete('/colors/:id', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    ensureSchema(db);
    const id = parseInt(req.params.id, 10);
    const { colorInUse } = require('../lib/product-master');
    if (colorInUse(db, id)) {
      return res.status(409).json({
        error: 'این رنگ در واریانت فعال استفاده شده و قابل حذف نیست',
        code: 'E_COLOR_IN_USE',
      });
    }
    db.prepare('UPDATE product_colors SET active=0 WHERE id=?').run(id);
    res.json({ ok: true, id });
  } catch (e) { sendErr(res, e); }
});

// ── Sizes ───────────────────────────────────────────────────────────────

router.get('/sizes', auth, (req, res) => {
  try {
    const db = getDB();
    ensureSchema(db);
    const activeOnly = String(req.query.all || '') !== '1';
    const rows = db.prepare(`
      SELECT * FROM product_sizes
      ${activeOnly ? 'WHERE active=1' : ''}
      ORDER BY sort_order, id
    `).all();
    res.json(rows);
  } catch (e) { sendErr(res, e); }
});

router.post('/sizes', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    ensureSchema(db);
    const row = upsertSize(db, req.body || {});
    try { audit(req.user.id, 'create', 'product_sizes', row.id, `سایز ${row.name}`, req); } catch (_) {}
    res.status(201).json(row);
  } catch (e) { sendErr(res, e); }
});

router.put('/sizes/:id', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    ensureSchema(db);
    const id = parseInt(req.params.id, 10);
    const existing = db.prepare('SELECT * FROM product_sizes WHERE id=?').get(id);
    if (!existing) return res.status(404).json({ error: 'سایز یافت نشد' });
    const name = req.body.name != null ? String(req.body.name).trim() : existing.name;
    const code = req.body.code != null ? String(req.body.code).trim() : existing.code;
    const sort = req.body.sort_order != null ? parseInt(req.body.sort_order, 10) : existing.sort_order;
    const active = req.body.active != null ? (req.body.active ? 1 : 0) : existing.active;
    db.prepare(
      'UPDATE product_sizes SET name=?, code=?, sort_order=?, active=? WHERE id=?'
    ).run(name, code, sort, active, id);
    res.json(db.prepare('SELECT * FROM product_sizes WHERE id=?').get(id));
  } catch (e) { sendErr(res, e); }
});

router.delete('/sizes/:id', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    ensureSchema(db);
    const id = parseInt(req.params.id, 10);
    const { sizeInUse } = require('../lib/product-master');
    if (sizeInUse(db, id)) {
      return res.status(409).json({
        error: 'این سایز در واریانت فعال استفاده شده و قابل حذف نیست',
        code: 'E_SIZE_IN_USE',
      });
    }
    db.prepare('UPDATE product_sizes SET active=0 WHERE id=?').run(id);
    res.json({ ok: true, id });
  } catch (e) { sendErr(res, e); }
});

// ── Matrix generation ───────────────────────────────────────────────────

router.post('/generate-matrix', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    ensureSchema(db);
    const result = generateMatrix(db, req.body || {});
    try {
      audit(
        req.user.id, 'create', 'product_variants', result.product_id,
        `ماتریس واریانت: ${result.created.length} SKU جدید / ${result.total_skus} کل`,
        req
      );
    } catch (_) {}
    res.status(201).json(result);
  } catch (e) { sendErr(res, e); }
});

router.post('/stock-matrix', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    ensureSchema(db);
    const productId = parseInt(req.body.product_id || req.body.productId, 10);
    if (!productId) return res.status(400).json({ error: 'product_id الزامی است' });
    const cells = Array.isArray(req.body.cells) ? req.body.cells : [];
    const opts = {
      warehouse_id: req.body.warehouse_id,
      auto_barcode: req.body.auto_barcode !== false,
      reason_code: req.body.reason_code,
      date: req.body.date,
      note: req.body.note,
    };
    // P1: structure_only → build/activate SKUs only (product form save). Otherwise every CHANGED
    // cell is one postAdjust(mode=count, variant_id) in a single transaction (kardex row + JE).
    const row = db.transaction(() => (req.body.structure_only === true || req.body.structure_only === 1
      ? applyStockMatrix(db, productId, cells, opts)
      : postStockMatrix(db, productId, cells, opts, req.user)))();
    try { audit(req.user.id, 'update', 'product_variants', productId, `ماتریس موجودی ${row.stock}`, req); } catch (_) {}
    try { require('../lib/website-stock-sync').notifyStockChanged(db, productId); } catch (_) {}
    res.json(row);
  } catch (e) { sendErr(res, e); }
});

// ── Style helpers ───────────────────────────────────────────────────────

router.post('/ensure-default/:productId', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    ensureSchema(db);
    const productId = parseInt(req.params.productId, 10);
    const def = ensureDefaultVariant(db, productId);
    res.json({ ok: true, default_variant: def, style: styleMetadata(db, productId) });
  } catch (e) { sendErr(res, e); }
});

router.get('/style/:productId', auth, (req, res) => {
  try {
    const db = getDB();
    ensureSchema(db);
    const productId = parseInt(req.params.productId, 10);
    const meta = styleMetadata(db, productId);
    if (!meta) return res.status(404).json({ error: 'مدل یافت نشد' });
    let variants = listVariants(db, productId, { include_default: true });
    // When warehouse_id is given, expose per-warehouse qty (missing row = 0), not global stock.
    const warehouseId = req.query.warehouse_id != null && req.query.warehouse_id !== ''
      ? parseInt(req.query.warehouse_id, 10)
      : null;
    const scoped = !!(warehouseId && Number.isFinite(warehouseId));
    let stockScope = scoped ? 'warehouse' : 'global';
    let warehouseName = null;
    if (scoped) {
      try {
        const wh = db.prepare('SELECT name, code FROM warehouses WHERE id=?').get(warehouseId);
        if (wh) {
          const n = String(wh.name || '').trim();
          const c = wh.code ? String(wh.code).trim() : '';
          warehouseName = (n + (c ? ` (${c})` : '')) || null;
        }
      } catch (_) { /* warehouses table may be absent on old DBs */ }
      let qtyStmt = null;
      try {
        qtyStmt = db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?');
      } catch (_) { qtyStmt = null; }
      variants = variants.map((v) => {
        const stockGlobal = Number(v.stock) || 0;
        let stock = 0;
        if (qtyStmt) {
          const row = qtyStmt.get(v.id, warehouseId);
          stock = row ? Number(row.qty) || 0 : 0;
        }
        return { ...v, stock, stock_global: stockGlobal, warehouse_id: warehouseId };
      });
      // Pack meta must match warehouse-scoped live pack (not global packSizeFor).
      try {
        const { expandLivePack } = require('../lib/inventory/movement');
        const live = expandLivePack(db, productId, warehouseId, { mode: 'live' });
        meta.pack_size_auto = live.pack_size_auto;
        meta.live_colors = live.live_colors;
        meta.live_sizes = live.live_sizes;
      } catch (_) { /* keep global meta */ }
    } else {
      variants = variants.map((v) => ({ ...v, stock_global: Number(v.stock) || 0 }));
    }
    res.json({
      ...meta,
      product_id: productId,
      variants,
      warehouse_id: scoped ? warehouseId : null,
      stock_scope: stockScope,
      warehouse_name: warehouseName,
      stock_by_warehouse: (() => {
        try {
          return db.prepare(`
            SELECT w.id AS warehouse_id, w.name AS warehouse_name,
              COALESCE(SUM(vws.qty),0) AS qty
            FROM variant_warehouse_stock vws
            JOIN product_variants pv ON pv.id=vws.variant_id
            JOIN warehouses w ON w.id=vws.warehouse_id
            WHERE pv.product_id=? AND COALESCE(pv.is_default,0)=0 AND pv.active=1
            GROUP BY w.id
            HAVING qty > 0
            ORDER BY w.name
          `).all(productId);
        } catch (_) { return []; }
      })(),
    });
  } catch (e) { sendErr(res, e); }
});

router.get('/summaries', auth, (req, res) => {
  try {
    const db = getDB();
    ensureSchema(db);
    const ids = String(req.query.ids || '')
      .split(',')
      .map((x) => parseInt(x, 10))
      .filter((n) => Number.isFinite(n) && n > 0)
      .slice(0, 80);
    const warehouseId = req.query.warehouse_id != null && req.query.warehouse_id !== ''
      ? parseInt(req.query.warehouse_id, 10)
      : null;
    const scopedWh = warehouseId && Number.isFinite(warehouseId) ? warehouseId : null;
    const out = {};
    for (const id of ids) out[id] = variantLineSummary(db, id, scopedWh);
    res.json(out);
  } catch (e) { sendErr(res, e); }
});

// Live pack (in-stock SKUs) — must be before /:id
// mode=live (default): stock>0 only | mode=defined: all active matrix SKUs
router.get('/live-pack/:productId', auth, (req, res) => {
  try {
    const db = getDB();
    ensureSchema(db);
    const { expandLivePack } = require('../lib/inventory/movement');
    const productId = parseInt(req.params.productId, 10);
    if (!productId) return res.status(400).json({ error: 'product_id الزامی است' });
    const warehouseId = req.query.warehouse_id != null && req.query.warehouse_id !== ''
      ? parseInt(req.query.warehouse_id, 10)
      : null;
    const mode = String(req.query.mode || 'live').toLowerCase() === 'defined' ? 'defined' : 'live';
    const pack = expandLivePack(db, productId, warehouseId, { mode });
    try {
      const {
        resolveFullPackMode, canSellPartialPack,
      } = require('../lib/inventory/full-pack-settings');
      const fullPackMode = resolveFullPackMode(db, productId);
      pack.full_pack_mode = fullPackMode;
      pack.can_sell_partial = canSellPartialPack(fullPackMode, req.user);
    } catch (_) {
      pack.full_pack_mode = 'required';
      pack.can_sell_partial = !!(req.user && (
        req.user.role === 'admin' || req.user.role === 'accounting' || req.user.role === 'sales_manager'
      ));
    }
    res.json(pack);
  } catch (e) { sendErr(res, e); }
});

// ── Variants CRUD ───────────────────────────────────────────────────────

router.get('/', auth, (req, res) => {
  try {
    const db = getDB();
    ensureSchema(db);
    const productId = parseInt(req.query.product_id, 10);
    if (!productId) return res.status(400).json({ error: 'product_id الزامی است' });
    const includeDefault = String(req.query.include_default || '1') !== '0';
    res.json(listVariants(db, productId, { include_default: includeDefault }));
  } catch (e) { sendErr(res, e); }
});

router.get('/:id', auth, (req, res) => {
  try {
    const db = getDB();
    ensureSchema(db);
    const row = getVariant(db, parseInt(req.params.id, 10));
    if (!row) return res.status(404).json({ error: 'واریانت یافت نشد' });
    res.json(row);
  } catch (e) { sendErr(res, e); }
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    ensureSchema(db);
    const row = createVariant(db, req.body || {});
    try { audit(req.user.id, 'create', 'product_variants', row.id, `SKU ${row.sku}`, req); } catch (_) {}
    res.status(201).json(row);
  } catch (e) { sendErr(res, e); }
});

router.put('/:id', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    ensureSchema(db);
    const row = updateVariant(db, parseInt(req.params.id, 10), req.body || {});
    res.json(row);
  } catch (e) { sendErr(res, e); }
});

// P5: idempotent internal EAN-13 (prefix 21/23/…) for a variant without a barcode.
router.post('/:id/generate-barcode', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    ensureSchema(db);
    const out = require('../lib/barcode-gen').assignVariantBarcode(db, parseInt(req.params.id, 10));
    if (!out.existed) {
      try { audit(req.user.id, 'generate_barcode', 'product_variant', req.params.id, `تولید بارکد تنوع ${out.barcode}`, req); } catch (_) {}
    }
    res.json({ ok: true, barcode: out.barcode, existed: !!out.existed, product_id: out.product_id });
  } catch (e) { sendErr(res, e); }
});

router.patch('/:id/stock', auth, adminOrAccounting, centralOnly, (req, res) => {
  try {
    const db = getDB();
    ensureSchema(db);
    const id = parseInt(req.params.id, 10);
    const mode = req.body && req.body.delta != null ? 'delta' : 'set';
    const value = mode === 'delta' ? req.body.delta : req.body.stock;
    if (value == null) return res.status(400).json({ error: 'stock یا delta الزامی است' });
    // P1: no raw stock write — a variant stock change is an adjustment document
    // (kardex row with variant_id + JE). warehouse_id is required.
    const v = getVariant(db, id);
    if (!v) return res.status(404).json({ error: 'واریانت یافت نشد' });
    const warehouseId = Number(req.body.warehouse_id) || 0;
    if (!warehouseId) {
      return res.status(422).json({ error: 'برای تعدیل موجودی باید انبار مشخص باشد', code: 'E_STOCK_WAREHOUSE_REQUIRED' });
    }
    const MA = require('../lib/inventory/manual-adjust');
    const out = db.transaction(() => MA.postAdjust(db, {
      product_id: v.product_id,
      variant_id: id,
      warehouse_id: warehouseId,
      mode: mode === 'delta' ? 'delta' : 'count',
      qty: value,
      reason_code: req.body.reason_code || undefined,
      date: req.body.date || undefined,
      note: String(req.body.note || '').trim() || 'تعدیل موجودی واریانت',
    }, req.user))();
    const row = getVariant(db, id);
    res.json({ ...row, ledger_id: out.id, tx_no: out.tx_no, je_id: out.je_id, warehouse_id: warehouseId });
  } catch (e) { sendErr(res, e); }
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    ensureSchema(db);
    res.json(softDeleteVariant(db, parseInt(req.params.id, 10)));
  } catch (e) { sendErr(res, e); }
});

module.exports = router;
