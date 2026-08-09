'use strict';
/**
 * P0-APP1 — Product variants / colors / sizes API.
 * ORCH must mount: app.use('/api/product-variants', require('./routes/product-variants'));
 * See ORCH-MOUNT.md (do not edit server.js from this task).
 */
const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const {
  initProductVariantsSchema,
  upsertColor,
  upsertSize,
  generateMatrix,
  listVariants,
  getVariant,
  createVariant,
  updateVariant,
  adjustVariantStock,
  softDeleteVariant,
  ensureDefaultVariant,
  styleMetadata,
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
  return res.status(status).json({ error: e.message || String(e) });
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
    `).all();
    res.json(rows);
  } catch (e) { sendErr(res, e); }
});

router.post('/colors', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    ensureSchema(db);
    const row = upsertColor(db, req.body || {});
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
    const code = req.body.code != null ? String(req.body.code).trim() : existing.code;
    const hex = req.body.hex != null ? String(req.body.hex).trim() : existing.hex;
    const sort = req.body.sort_order != null ? parseInt(req.body.sort_order, 10) : existing.sort_order;
    const active = req.body.active != null ? (req.body.active ? 1 : 0) : existing.active;
    db.prepare(
      'UPDATE product_colors SET name=?, code=?, hex=?, sort_order=?, active=? WHERE id=?'
    ).run(name, code, hex, sort, active, id);
    res.json(db.prepare('SELECT * FROM product_colors WHERE id=?').get(id));
  } catch (e) { sendErr(res, e); }
});

router.delete('/colors/:id', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    ensureSchema(db);
    const id = parseInt(req.params.id, 10);
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
    const variants = listVariants(db, productId, { include_default: true });
    res.json({ ...meta, product_id: productId, variants });
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

router.patch('/:id/stock', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    ensureSchema(db);
    const id = parseInt(req.params.id, 10);
    const mode = req.body && req.body.delta != null ? 'delta' : 'set';
    const value = mode === 'delta' ? req.body.delta : req.body.stock;
    if (value == null) return res.status(400).json({ error: 'stock یا delta الزامی است' });
    const row = adjustVariantStock(db, id, value, mode);
    res.json(row);
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
