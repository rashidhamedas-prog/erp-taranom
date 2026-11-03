const router = require('express').Router();
const { releaseTafsili } = require('../lib/coa-map');
const { assignProductTafsili } = require('../lib/product-tafsili');
const { parseQty } = require('../lib/round3');
const { parseStockQty, requiresIntegerQty } = require('../lib/inventory/qty-policy');
const { getDB, audit } = require('../db');
const { auth, adminOnly, adminOrAccounting, centralOnly, requirePermission } = require('../middleware/auth');
const { XLSX, readWorkbook } = require('../lib/excel-safe');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { createSecureUpload } = require('../lib/upload-policy');
const { sendSecureHtml } = require('../lib/secure-html-response');
const { listQueryPlan, listResponse, CATALOG_MAX_PAGE_SIZE } = require('../lib/pagination');
const { nextProductCode, createQuickProduct } = require('../lib/product-quick');
const { applyNameCodeBarcodeSkuSearch, attachAvailableQty } = require('../lib/inventory/product-line-search');
const { applyCatalogCostPolicy } = require('../lib/catalog-cost-policy');
const { attachVariantFlags } = require('../lib/product-variants');

const { UPLOADS_ROOT } = require('../paths');
const UPLOAD_DIR = path.join(UPLOADS_ROOT, 'products');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = createSecureUpload('image');
const uploadProductMedia = upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'images', maxCount: 12 },
]);

function listProductImages(db, productId) {
  try {
    return db.prepare('SELECT id,filename,sort_order FROM product_images WHERE product_id=? ORDER BY sort_order,id').all(productId);
  } catch (_) { return []; }
}

function jsonSafeProduct(row) {
  if (!row || typeof row !== 'object') return row;
  try {
    return JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v)));
  } catch (_) {
    const out = Object.assign({}, row);
    if (Array.isArray(row.images)) out.images = row.images.slice();
    return out;
  }
}

/** True when multipart/JSON body explicitly includes the key (even if empty string). */
function bodyHas(body, key) {
  return !!body && Object.prototype.hasOwnProperty.call(body, key);
}

async function attachUploadedImages(db, productId, files, setPrimary) {
  const raw = [];
  if (files?.image?.[0]) raw.push(files.image[0]);
  if (files?.images?.length) raw.push(...files.images);
  // Deduplicate when client accidentally sends the same file as both image and images
  const seen = new Set();
  const imgs = [];
  for (const f of raw) {
    if (!f || !f.buffer) continue;
    const key = crypto.createHash('sha256').update(f.buffer).digest('hex');
    if (seen.has(key)) continue;
    seen.add(key);
    imgs.push(f);
  }
  if (!imgs.length) return;
  let sort = db.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 s FROM product_images WHERE product_id=?').get(productId).s;
  const ins = db.prepare('INSERT INTO product_images (product_id,filename,sort_order) VALUES (?,?,?)');
  const names = [];
  const errors = [];
  for (const f of imgs) {
    let fn = null;
    try {
      fn = saveImage(f);
      ins.run(productId, fn, sort++);
      names.push(fn);
    } catch (e) {
      if (fn) {
        try { fs.unlinkSync(path.join(UPLOAD_DIR, fn)); } catch { /* file was not committed */ }
      }
      errors.push((f.originalname || 'file') + ': ' + (e && e.message ? e.message : String(e)));
    }
  }
  if (!names.length && errors.length) {
    const err = new Error('آپلود تصویر ناموفق: ' + errors.slice(0, 3).join('؛ '));
    err.status = 400;
    throw err;
  }
  if (setPrimary && names[0]) {
    // SQLite: use single quotes for empty string — double quotes are identifiers
    db.prepare("UPDATE products SET image=? WHERE id=? AND (image IS NULL OR image='')").run(names[0], productId);
  }
  try {
    const all = listProductImages(db, productId).map(r => r.filename);
    db.prepare('UPDATE products SET images_json=? WHERE id=?').run(JSON.stringify(all), productId);
  } catch (_) {}
}

const {
  canSeeAllProductGroups,
  userCatalogAclIds,
  addProductGroupVisibility,
  addCatalogAclFilter,
} = require('../lib/product-visibility');

// Auto product code lives in lib/product-quick.js (shared with Excel commit).

function saveImage(file) {
  const allowed = new Set(['image/webp', 'image/jpeg', 'image/png']);
  if (!file || !file.uploadValidated || !allowed.has(file.mimetype) || !Buffer.isBuffer(file.buffer)) {
    const error = new Error('تصویر پیش از ذخیره‌سازی اعتبارسنجی نشده است');
    error.status = 400;
    throw error;
  }
  const ext = /^\.(webp|jpe?g|png)$/i.test(file.extension || '')
    ? String(file.extension).toLowerCase().replace('.jpeg', '.jpg')
    : (file.mimetype === 'image/png' ? '.png' : file.mimetype === 'image/jpeg' ? '.jpg' : '.webp');
  const filename = `p_${crypto.randomBytes(18).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), file.buffer, { flag: 'wx', mode: 0o600 });
  return filename;
}
const excelUpload = createSecureUpload('xlsx');

// GET / — visibility: shared groups (+ creator) for users; optional per-user catalog ACL.
// Filtering: ?category=&search=&stock_status=low|ok|all
router.get('/', auth, (req, res) => {
  const db = getDB();
  const where = [];
  const params = [];
  addProductGroupVisibility(req.user, where, params);
  addCatalogAclFilter(db, req.user, where, params);

  const category = (req.query.category || '').trim();
  if (category && category !== 'all') { where.push('p.category = ?'); params.push(category); }
  const categoryId = req.query.category_id;
  if (categoryId && String(categoryId) !== 'all' && String(categoryId) !== '') {
    where.push('p.category_id = ?');
    params.push(parseInt(categoryId, 10));
  }

  const search = (req.query.q || req.query.search || '').trim();
  if (search) {
    applyNameCodeBarcodeSkuSearch(db, where, params, search);
  }

  const stockStatus = (req.query.stock_status || 'all').trim();
  if (stockStatus === 'low') where.push('p.stock <= p.stock_alert');
  else if (stockStatus === 'ok') where.push('p.stock > p.stock_alert');

  // Hide portal-created pending products from sales catalogs unless explicitly requested
  const hasApproval = db.prepare("PRAGMA table_info(products)").all()
    .some(c => c.name === 'approval_status');
  if (hasApproval && String(req.query.include_pending || '') !== '1') {
    where.push("(p.approval_status IS NULL OR p.approval_status='' OR p.approval_status='approved')");
  }

  // POS catalog scope (flagged backend change for store quick-sale search)
  if (String(req.query.for || '') === 'pos') {
    where.push("(p.item_type IS NULL OR p.item_type='' OR p.item_type!='raw')");
    where.push("(p.status IS NULL OR p.status='' OR p.status='active')");
  }

  const warehouseId = parseInt(req.query.warehouse_id, 10);
  if (warehouseId) {
    const includeZero = String(req.query.include_zero || '') === '1';
    const allowNeg = (() => {
      try {
        const wh = db.prepare('SELECT allow_negative FROM warehouses WHERE id=?').get(warehouseId);
        if (wh?.allow_negative) return true;
        const g = db.prepare("SELECT value FROM settings WHERE key='inventory_allow_negative'").get();
        return g && g.value === '1';
      } catch (_) { return false; }
    })();
    // Stocked products must have a warehouse_stock row in the selected WH
    where.push(`EXISTS (SELECT 1 FROM warehouse_stock ws WHERE ws.product_id=p.id AND ws.warehouse_id=? ${includeZero || allowNeg ? '' : 'AND ws.qty>0'})`);
    params.push(warehouseId);
  }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const pq = listQueryPlan(req.query, { maxPageSize: CATALOG_MAX_PAGE_SIZE });
  // Visibility filter may reference `pc.*` — COUNT must use the same joins as the list query.
  const total = pq.paginate
    ? (db.prepare(`SELECT COUNT(*) AS c FROM products p LEFT JOIN product_categories pc ON pc.id=p.category_id ${whereSql}`).get(...params)?.c || 0)
    : 0;
  // Never fall back to company-wide products.stock for another warehouse —
  // missing warehouse_stock row means 0 in that WH (invoice picker scope).
  const whSelect = warehouseId
    ? `, COALESCE((SELECT ws.qty FROM warehouse_stock ws WHERE ws.product_id=p.id AND ws.warehouse_id=${Number(warehouseId)} LIMIT 1), 0) as wh_qty`
    : '';
  const rows = db.prepare(`
    SELECT p.*, w.name as warehouse_name${whSelect}
    FROM products p
    LEFT JOIN warehouses w ON p.warehouse_id=w.id
    LEFT JOIN product_categories pc ON pc.id=p.category_id
    ${whereSql} ORDER BY CAST(p.stock AS REAL) DESC, p.id DESC
    ${pq.limitSql}
  `).all(...params, ...pq.limitParams);
  // Single grouped query over inventory_ledger (LIVE rule) so list/card stock always equals kardex
  try {
    const ids = rows.map((r) => Number(r.id)).filter((n) => n > 0);
    if (ids.length && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inventory_ledger'").get()) {
      const { LEDGER_LIVE_SQL } = require('../lib/inventory/layer-reconcile');
      const { WAREHOUSE_ONLY_EVENTS } = require('../lib/inventory/stock-cache');
      const woList = WAREHOUSE_ONLY_EVENTS.map((e) => `'${e}'`).join(',');
      const ph = ids.map(() => '?').join(',');
      const ledRows = db.prepare(`
        SELECT product_id, warehouse_id,
          SUM(COALESCE(qty_in,0) - COALESCE(qty_out,0)) AS q,
          SUM(CASE WHEN COALESCE(event_type,'') NOT IN (${woList}) THEN COALESCE(qty_in,0) - COALESCE(qty_out,0) ELSE 0 END) AS hq
        FROM inventory_ledger
        WHERE product_id IN (${ph}) AND (${LEDGER_LIVE_SQL})
        GROUP BY product_id, warehouse_id
      `).all(...ids);
      if (ledRows.length) {
        const byProd = new Map();
        const byProdWh = new Map();
        for (const lr of ledRows) {
          const pid = Number(lr.product_id);
          byProd.set(pid, (byProd.get(pid) || 0) + (Number(lr.hq) || 0));
          if (lr.warehouse_id != null) {
            const k = `${pid}:${Number(lr.warehouse_id)}`;
            byProdWh.set(k, (byProdWh.get(k) || 0) + (Number(lr.q) || 0));
          }
        }
        const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
        for (const row of rows) {
          const pid = Number(row.id);
          if (byProd.has(pid)) row.stock = r3(byProd.get(pid));
          if (warehouseId && byProdWh.has(`${pid}:${warehouseId}`)) {
            row.wh_qty = r3(byProdWh.get(`${pid}:${warehouseId}`));
          }
        }
      }
    }
  } catch (_) { /* keep cached columns on error */ }
  // Attach gallery filenames for album UI (catalog / marketer / cards)
  for (const row of rows) {
    let imgs = listProductImages(db, row.id);
    if (!imgs.length && row.images_json) {
      try {
        imgs = JSON.parse(row.images_json).map((filename, i) => ({ id: 0, filename, sort_order: i }));
      } catch (_) { imgs = []; }
    }
    if (!imgs.length && row.image) imgs = [{ id: 0, filename: row.image, sort_order: 0 }];
    row.images = imgs;
    if (!row.image && imgs[0]) row.image = imgs[0].filename;
  }
  attachVariantFlags(db, rows);
  if (warehouseId) attachAvailableQty(db, rows, warehouseId);
  res.json(applyCatalogCostPolicy(db, req.user, listResponse(rows, { page: pq.page, pageSize: pq.pageSize, total: pq.paginate ? total : rows.length }, req.query)));
});

// Distinct categories (for filter dropdown) — MUST be registered before /:id/*
// routes so GET /categories is never captured as an id (spec 1.0.9 §2 catalog).
router.get('/categories', auth, (req, res) => {
  const db = getDB();
  const visibility = canSeeAllProductGroups(req.user) ? '' : ' AND (is_shared=1 OR created_by=?)';
  const args = visibility ? [req.user.id] : [];
  let fromTable = db.prepare(`SELECT id,name FROM product_categories WHERE active=1${visibility} ORDER BY sort_order, name`).all(...args);
  const acl = userCatalogAclIds(db, req.user);
  if (acl && acl.length) {
    const set = new Set(acl);
    fromTable = fromTable.filter(c => set.has(c.id));
  }
  const names = fromTable.map(r => r.name);
  const fromLegacy = db.prepare(`
    SELECT DISTINCT p.category FROM products p
    LEFT JOIN product_categories pc ON pc.id=p.category_id
    WHERE p.category IS NOT NULL AND p.category<>''
      ${canSeeAllProductGroups(req.user) ? '' : 'AND (p.category_id IS NULL OR pc.id IS NULL OR pc.is_shared=1 OR pc.created_by=?)'}
    ORDER BY p.category
  `).all(...args).map(r => r.category);
  const seen = new Set();
  const filteredLegacy = acl
    ? fromLegacy.filter(n => names.includes(n))
    : fromLegacy;
  res.json([...names, ...filteredLegacy].filter(c => { if (seen.has(c)) return false; seen.add(c); return true; }));
});

// Lookup by barcode or product code — used by the invoice builder camera scanner
router.get('/by-barcode/:code', auth, (req, res) => {
  const db = getDB();
  const { normalizeDigits } = require('../lib/round3');
  const raw = String(req.params.code || '').trim();
  const code = normalizeDigits(raw).trim();
  if (!code) return res.status(400).json({ error: 'کد الزامی است' });
  // P5: a variant barcode/SKU wins over products.barcode (the scanned label names the exact colour/size).
  let row = null;
  let variant = null;
  try {
    const v = db.prepare(`
      SELECT v.id AS variant_id, v.product_id, v.color_id, v.size_id,
             c.name AS color_name, s.name AS size_name
      FROM product_variants v
      LEFT JOIN product_colors c ON c.id=v.color_id
      LEFT JOIN product_sizes s ON s.id=v.size_id
      WHERE (v.barcode=? OR v.sku=?) AND COALESCE(v.active,1)=1
      ORDER BY CASE WHEN v.barcode=? THEN 0 ELSE 1 END, v.id
      LIMIT 1
    `).get(code, code, code);
    if (v && v.product_id) {
      const where2 = ['p.id=?'];
      const params2 = [v.product_id];
      addProductGroupVisibility(req.user, where2, params2);
      addCatalogAclFilter(db, req.user, where2, params2);
      row = db.prepare(`
        SELECT p.* FROM products p
        LEFT JOIN product_categories pc ON pc.id=p.category_id
        WHERE ${where2.join(' AND ')}
      `).get(...params2);
      if (row) variant = v;
    }
  } catch (_) { /* variants table optional */ }
  if (!row) {
    const where = ['(p.barcode=? OR p.code=?)'];
    const params = [code, code];
    addProductGroupVisibility(req.user, where, params);
    addCatalogAclFilter(db, req.user, where, params);
    row = db.prepare(`
      SELECT p.* FROM products p
      LEFT JOIN product_categories pc ON pc.id=p.category_id
      WHERE ${where.join(' AND ')}
    `).get(...params);
  }
  if (!row) return res.status(404).json({ error: 'محصولی با این بارکد یافت نشد' });
  row.images = listProductImages(db, row.id);
  if (variant) {
    row.variant_id = Number(variant.variant_id) || null;
    row.color_id = variant.color_id || null;
    row.size_id = variant.size_id || null;
    row.color_name = variant.color_name || '';
    row.size_name = variant.size_name || '';
    row.matched_by = 'variant';
  } else {
    row.matched_by = 'product';
  }
  res.json(applyCatalogCostPolicy(db, req.user, row));
});

router.delete('/images/:imageId', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const img = db.prepare('SELECT * FROM product_images WHERE id=?').get(req.params.imageId);
  if (!img) return res.status(404).json({ error: 'یافت نشد' });
  db.prepare('DELETE FROM product_images WHERE id=?').run(img.id);
  try { fs.unlinkSync(path.join(UPLOAD_DIR, img.filename)); } catch (_) {}
  const all = listProductImages(db, img.product_id).map(r => r.filename);
  try { db.prepare('UPDATE products SET images_json=? WHERE id=?').run(JSON.stringify(all), img.product_id); } catch (_) {}
  res.json({ ok: true, images: all });
});

// Image-only upload — NEVER touches stock/pack_size/price/code/note/etc.
// Instant gallery upload in the product modal must use this endpoint, not PUT.
router.post('/:id/images', auth, adminOrAccounting, uploadProductMedia, async (req, res) => {
  const db = getDB();
  const prod = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!prod) return res.status(404).json({ error: 'یافت نشد' });
  try {
    await attachUploadedImages(db, req.params.id, req.files, !prod.image);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || 'آپلود تصویر ناموفق' });
  }
  try {
    audit(req.user.id, 'update', 'product', req.params.id, `آپلود تصویر محصول ${prod.name}`);
  } catch (_) {}
  const row = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  row.images = listProductImages(db, row.id);
  res.json(jsonSafeProduct(row));
});

router.get('/:id/completeness', auth, (req, res) => {
  try {
    const completeness = require('../lib/production/product-completeness');
    const mode = String(req.query.mode || 'product');
    res.json(completeness.assessProduct(getDB(), Number(req.params.id), mode));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code || e.message, ...(e.extra || {}) });
  }
});

router.get('/:id', auth, (req, res) => {
  const db = getDB();
  const where = ['p.id=?'];
  const params = [req.params.id];
  addProductGroupVisibility(req.user, where, params);
  addCatalogAclFilter(db, req.user, where, params);
  const row = db.prepare(`
    SELECT p.*, w.name as warehouse_name
    FROM products p
    LEFT JOIN warehouses w ON w.id=p.warehouse_id
    LEFT JOIN product_categories pc ON pc.id=p.category_id
    WHERE ${where.join(' AND ')}
  `).get(...params);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  row.images = listProductImages(db, row.id);
  if (!row.images.length && row.images_json) {
    try { row.images = JSON.parse(row.images_json).map((filename, i) => ({ id: 0, filename, sort_order: i })); } catch (_) {}
  }
  if (!row.image && row.images && row.images[0]) row.image = row.images[0].filename;
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inventory_ledger' AND EXISTS (SELECT 1 FROM inventory_ledger WHERE product_id=? LIMIT 1)").get(row.id)) {
      const { derivedQty } = require('../lib/inventory/stock-cache');
      row.stock = derivedQty(db, { productId: row.id });
    }
  } catch (_) {}
  attachVariantFlags(db, row);
  res.json(applyCatalogCostPolicy(db, req.user, jsonSafeProduct(row)));
});

// Item Kardex — per-product stock movement ledger with a running balance.
// stock_logs has no explicit "opening" row, so the running balance is
// reconstructed backward from the product's current stock (i.e. the
// starting point is whatever stock existed before the earliest logged
// change) so the final computed balance always reconciles with reality.
router.get('/:id/kardex', auth, (req, res) => {
  const db = getDB();
  const where = ['p.id=?'];
  const params = [req.params.id];
  addProductGroupVisibility(req.user, where, params);
  addCatalogAclFilter(db, req.user, where, params);
  const product = db.prepare(`
    SELECT p.* FROM products p
    LEFT JOIN product_categories pc ON pc.id=p.category_id
    WHERE ${where.join(' AND ')}
  `).get(...params);
  if (!product) return res.status(404).json({ error: 'محصول یافت نشد' });

  // Prefer immutable inventory_ledger when present (live rows only via LEDGER_LIVE_SQL)
  const hasLedger = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='inventory_ledger'"
  ).get();
  if (hasLedger) {
    const { LEDGER_LIVE_SQL } = require('../lib/inventory/layer-reconcile');
    const { derivedQty } = require('../lib/inventory/stock-cache');
    product.stock = derivedQty(db, { productId: product.id });
    const rows = db.prepare(`
      SELECT l.*, u.name as user_name, w.name as warehouse_name
      FROM inventory_ledger l
      LEFT JOIN users u ON l.created_by=u.id
      LEFT JOIN warehouses w ON l.warehouse_id=w.id
      WHERE l.product_id=? AND (${LEDGER_LIVE_SQL})
      ORDER BY l.date ASC, l.id ASC
    `).all(req.params.id);
    const { isVoidPairStockRow } = require('../lib/ledgers');
    const liveRows = rows.filter((l) => !isVoidPairStockRow(l));
    const logs = liveRows.map(l => ({
      id: l.id,
      tx_no: l.tx_no,
      event_type: l.event_type,
      change: (Number(l.qty_in) || 0) - (Number(l.qty_out) || 0),
      qty_in: l.qty_in,
      qty_out: l.qty_out,
      running_balance: l.qty_balance,
      unit_cost_rial: l.unit_cost_rial,
      amount_rial: l.amount_rial,
      avg_cost_after_rial: l.avg_cost_after_rial,
      note: l.note,
      date: l.date,
      warehouse_name: l.warehouse_name,
      user_name: l.user_name,
      created_at: l.created_at,
      status: l.status,
      source: 'inventory_ledger',
    }));
    require('../lib/report-order').sortReportRows(logs, { date: 'date', dir: 'asc' });
    let runQty = 0;
    for (const l of logs) {
      runQty += Number(l.change) || 0;
      l.running_balance = runQty;
    }
    return res.json(applyCatalogCostPolicy(db, req.user, { product, logs, source: 'inventory_ledger' }));
  }

  return res.json(applyCatalogCostPolicy(db, req.user, { product, logs: [], source: 'inventory_ledger' }));
});

// ── Barcode support (ported from CRM v4) ────────────────────────────────────

// P5: EAN-13 / Code128 helpers live in lib/barcode-gen.js (pure, unit-tested).
const BarcodeGen = require('../lib/barcode-gen');
const { escapeHtml } = BarcodeGen;

// Generate a barcode for a product that lacks one (admin only).
// Deterministic per product id → device replay converges with central.
router.post('/:id/generate-barcode', auth, adminOnly, (req, res) => {
  const db = getDB();
  const prod = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!prod) return res.status(404).json({ error: 'یافت نشد' });
  if (prod.barcode) return res.json({ ok: true, barcode: prod.barcode, existed: true });
  let out;
  try {
    out = BarcodeGen.assignProductBarcode(db, prod.id);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  audit(req.user.id, 'generate_barcode', 'product', prod.id, `تولید بارکد ${out.barcode} برای ${prod.name}`, req);
  res.json({ ok: true, barcode: out.barcode });
});

const LABEL_LAYOUTS = new Set(['40x25', '50x30', 'a4-3x8']);
const LABEL_SYMBOLOGIES = new Set(['auto', 'ean13', 'code128']);

// Printable barcode labels are fetched with the normal Authorization header.
// Never place a bearer token in the URL: query strings leak via logs/history/referrers.
// P5: ?variant_id= &layout=40x25|50x30|a4-3x8 &symbology=auto|ean13|code128 — consumer (retail) price.
router.get('/:id/labels', auth, requirePermission('products', 'view'), (req, res) => {
  const db = getDB();
  const layout = LABEL_LAYOUTS.has(String(req.query.layout || '')) ? String(req.query.layout) : '50x30';
  const symbology = LABEL_SYMBOLOGIES.has(String(req.query.symbology || '').toLowerCase())
    ? String(req.query.symbology).toLowerCase() : 'auto';
  const defCount = layout === 'a4-3x8' ? 24 : 12;
  const requestedCount = Number.parseInt(String(req.query.count || defCount), 10);
  const count = Math.min(96, Math.max(1, Number.isFinite(requestedCount) ? requestedCount : defCount));
  const where = ['p.id=?'];
  const params = [req.params.id];
  addProductGroupVisibility(req.user, where, params);
  addCatalogAclFilter(db, req.user, where, params);
  const prod = db.prepare(`
    SELECT p.* FROM products p
    LEFT JOIN product_categories pc ON pc.id=p.category_id
    WHERE ${where.join(' AND ')}
  `).get(...params);
  if (!prod) return res.status(404).send('محصول یافت نشد');
  let variant = null;
  const variantId = parseInt(req.query.variant_id, 10);
  if (variantId > 0) {
    try {
      variant = db.prepare(`
        SELECT v.id, v.product_id, v.barcode, v.sku, v.price_rial, v.price,
               c.name AS color_name, s.name AS size_name
        FROM product_variants v
        LEFT JOIN product_colors c ON c.id=v.color_id
        LEFT JOIN product_sizes s ON s.id=v.size_id
        WHERE v.id=? AND v.product_id=?
      `).get(variantId, prod.id);
    } catch (_) { variant = null; }
    if (!variant) return res.status(404).send('تنوع کالا یافت نشد');
  }
  const code = variant ? (variant.barcode || '') : (prod.barcode || '');
  if (!code) {
    return res.status(400).send(variant
      ? 'این تنوع بارکد ندارد — ابتدا بارکد تنوع را تولید کنید'
      : 'این محصول بارکد ندارد — ابتدا بارکد تولید کنید');
  }
  const { retailUnitPriceRial } = require('../lib/store-quick-sale');
  const variantPrice = variant ? Math.round(Number(variant.price_rial || variant.price) || 0) : 0;
  const consumerPrice = variantPrice > 0 ? variantPrice : retailUnitPriceRial(prod);
  const escName = escapeHtml(prod.name);
  const attrs = variant ? [variant.color_name, variant.size_name].filter(Boolean).join(' / ') : '';
  const barcode = BarcodeGen.barcodeSvg(code, symbology);
  const labels = Array.from({ length: count }, () => `
    <div class="label">
      <div class="name">${escName}</div>
      ${attrs ? `<div class="attrs">${escapeHtml(attrs)}</div>` : ''}
      ${barcode}
      <div class="meta">${escapeHtml(prod.code || '')}</div>
      <div class="price">${Number(consumerPrice || 0).toLocaleString('fa-IR')} ریال</div>
    </div>`).join('');
  const html = `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="UTF-8">
<title>برچسب ${escName}</title>
<link href="/vendor/vazirmatn/vazirmatn.css" rel="stylesheet">
<link href="/labels-print.css?v=596" rel="stylesheet">
</head><body class="labels layout-${layout}">
<div class="sheet">${labels}</div>
<button class="pbtn" type="button" data-print>چاپ 🖨️</button>
<script src="/print-page.js"></script></body></html>`;
  return sendSecureHtml(res, html, { allowPrintScript: true });
});

// Quick create from invoice modals — admin/accounting only (product master lives in accounting)
router.post('/quick', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  let pid;
  try {
    pid = createQuickProduct(db, req.user, req.body || {});
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    throw e;
  }
  audit(req.user.id, 'create', 'product', pid, `ساخت سریع محصول ${(req.body && req.body.name) || ''}`);
  const quickRow = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
  try {
    const od = db.prepare(`
      SELECT d.id, d.doc_no, d.status FROM opening_stock_docs d
      JOIN opening_stock_lines l ON l.doc_id=d.id WHERE l.product_id=? ORDER BY d.id DESC LIMIT 1
    `).get(pid);
    if (od) quickRow.opening_doc = od;
  } catch (_) { /* table optional */ }
  res.json(quickRow);
});

// Create product — multipart form-data for optional image(s) (admin/accounting)
router.post('/', auth, adminOrAccounting, uploadProductMedia, async (req, res) => {
  const {
    category, category_id, code, name, price, cost, stock, stock_alert, unit, note, colors,
    pack_size, barcode, warehouse_id, full_name, product_type, product_index, tax_id,
    consumer_price, location, opening_price, sms_code, tax_stuff_id
  } = req.body;
  if (!name) return res.status(400).json({ error: 'نام محصول الزامی است' });
  const db = getDB();
  try {
    const { validateProductCreateFields } = require('../lib/product-master');
    validateProductCreateFields(db, req.body || {});
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  let catName = category || '';
  let catId = category_id || null;
  if (catId) {
    const c = db.prepare('SELECT name FROM product_categories WHERE id=?').get(catId);
    if (c) catName = c.name;
  }
  let image = null;
  // Create: defer image save to attachUploadedImages (single pass, no duplicate)
  // New products default into the first warehouse so warehouse_id is never
  // null — Warehouse Transfer can relocate them afterward.
  const defaultWarehouse = warehouse_id
    ? db.prepare('SELECT id FROM warehouses WHERE id=?').get(parseInt(warehouse_id, 10))
    : db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get();
  const prodCode = (code && String(code).trim()) || nextProductCode(db);
  const { resolveProductUnit } = require('../lib/uom');
  let resolvedUnit;
  try {
    resolvedUnit = resolveProductUnit(db, req.body || {}, null);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    throw e;
  }
  const unitVal = resolvedUnit.unit || 'عدد';
  // No direct stock on product create — opening qty only via «موجودی اول دوره» (سند افتتاحیه).
  const stockOpen = parseStockQty(stock, { unit: unitVal, integer: requiresIntegerQty(null, null, unitVal) });
  const openingQtyRaw = Number(req.body.opening_qty) || 0;
  if (stockOpen > 0 || openingQtyRaw > 0) {
    return res.status(422).json({
      error: 'موجودی اول دوره از جدول «موجودی اول دوره» همان فرم کالا ثبت می‌شود (سند افتتاحیه)',
      code: 'E_STOCK_VIA_OPENING',
    });
  }
  const openingUnit = Math.round(parseFloat(cost) || parseFloat(opening_price) || 0);
  const allowedItemTypes = new Set(['finished', 'semi', 'raw', 'packaging', 'material', 'scrap', 'service']);
  if (req.body.item_type != null && String(req.body.item_type).trim()
    && !allowedItemTypes.has(String(req.body.item_type).trim())) {
    return res.status(400).json({ error: 'نوع کالا نامعتبر است', code: 'E_ITEM_TYPE' });
  }
  const createProduct = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO products (
        user_id,category,category_id,code,name,price,cost,stock,stock_alert,unit,note,image,colors,
        pack_size,warehouse_id,barcode,full_name,product_type,product_index,tax_id,consumer_price,
        location,opening_price,sms_code,tax_stuff_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(req.user.id, catName, catId, prodCode, name, parseFloat(price) || 0, parseFloat(cost) || 0, 0,
          parseInt(stock_alert) || 5, unitVal, note || '', image,
          parseInt(colors) || 1, parseInt(pack_size) || 1, defaultWarehouse ? defaultWarehouse.id : null,
          (barcode || '').trim() || null, full_name || '', product_type || '', product_index || '', tax_id || '',
          parseFloat(consumer_price) || 0, location || '', parseFloat(opening_price) || 0, sms_code || '',
          String(tax_stuff_id || '').trim() || null);
    if (resolvedUnit.unit_id) {
      db.prepare('UPDATE products SET unit_id=? WHERE id=?').run(resolvedUnit.unit_id, result.lastInsertRowid);
    }
    if (req.body.retail_price != null && req.body.retail_price !== '') {
      const rp = Math.round(parseFloat(req.body.retail_price) || 0);
      db.prepare('UPDATE products SET retail_price=?, retail_price_rial=? WHERE id=?').run(rp, rp, result.lastInsertRowid);
    }
    if (req.body.min_price_rial != null && req.body.min_price_rial !== '') {
      const mp = Math.max(0, Math.round(parseFloat(req.body.min_price_rial) || 0));
      db.prepare('UPDATE products SET min_price_rial=? WHERE id=?').run(mp > 0 ? mp : null, result.lastInsertRowid);
    }
    if (req.body.costing_method !== undefined) {
      const cm = String(req.body.costing_method || '').trim() || null;
      db.prepare('UPDATE products SET costing_method=? WHERE id=?').run(cm, result.lastInsertRowid);
    }
    if (req.body.valuation_level !== undefined) {
      try { require('../lib/inventory/valuation').setLayerLevel(db, 'products', result.lastInsertRowid, req.body.valuation_level, { userId: req.user.id }); } catch (_) { /* column optional */ }
    }
    if (req.body.item_type != null && String(req.body.item_type).trim()) {
      db.prepare('UPDATE products SET item_type=? WHERE id=?').run(String(req.body.item_type).trim(), result.lastInsertRowid);
    }
    if (req.body.is_manufactured != null) {
      const raw = req.body.is_manufactured;
      const mfg = raw === true || raw === 1 || raw === '1' ? 1 : 0;
      db.prepare('UPDATE products SET is_manufactured=? WHERE id=?')
        .run(mfg, result.lastInsertRowid);
    }
    if (req.body.average_cost_rial != null) {
      db.prepare('UPDATE products SET average_cost_rial=? WHERE id=?')
        .run(Math.round(Number(req.body.average_cost_rial) || 0), result.lastInsertRowid);
    } else {
      const costRial = Math.round(parseFloat(cost) || openingUnit || 0);
      if (costRial > 0) {
        db.prepare(`
          UPDATE products SET average_cost_rial=?
          WHERE id=? AND COALESCE(average_cost_rial,0)=0
        `).run(costRial, result.lastInsertRowid);
      }
    }
    if (req.body.std_cost_rial != null) {
      db.prepare('UPDATE products SET std_cost_rial=? WHERE id=?')
        .run(Math.round(Number(req.body.std_cost_rial) || 0), result.lastInsertRowid);
    }
    try { assignProductTafsili(db, result.lastInsertRowid, name); } catch (_) {}
    if (bodyHas(req.body, 'website_stock_push')) {
      const { normalizeWebsiteStockPush } = require('../lib/website-stock-sync');
      const flag = normalizeWebsiteStockPush(req.body.website_stock_push, 1);
      db.prepare('UPDATE products SET website_stock_push=? WHERE id=?').run(flag, result.lastInsertRowid);
    }
    return result;
  });
  let result;
  try {
    result = createProduct();
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    throw e;
  }
  try {
    await attachUploadedImages(db, result.lastInsertRowid, req.files, true);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || 'آپلود تصویر ناموفق' });
  }
  audit(req.user.id, 'create', 'product', result.lastInsertRowid, `ساخت محصول ${name}`);
  try { require('../lib/website-stock-sync').notifyStockChanged(db, result.lastInsertRowid); } catch (_) {}
  const row = db.prepare('SELECT * FROM products WHERE id=?').get(result.lastInsertRowid);
  row.images = listProductImages(db, row.id);
  try {
    const completeness = require('../lib/production/product-completeness');
    const ready = completeness.assessProduct(db, result.lastInsertRowid, 'activate');
    row.production_readiness = { ok: ready.ok, hard: ready.hard, soft: ready.soft, kind: ready.kind };
  } catch (_) {}
  res.json(jsonSafeProduct(row));
});

// Update product (admin only)
// IMPORTANT: absent body fields must keep existing DB values.
// Image-only FormData (old instant-upload) used to send no stock/pack_size/price
// and wipe them to 0/defaults via parseQty(undefined) / parseFloat(undefined)||0.
router.put('/:id', auth, adminOrAccounting, uploadProductMedia, async (req, res) => {
  const db = getDB();
  const prod = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!prod) return res.status(404).json({ error: 'یافت نشد' });
  const body = req.body || {};
  const { category, category_id, code, name, price, cost, stock, stock_alert, unit, note, colors, pack_size, warehouse_id, barcode,
    full_name, product_type, product_index, tax_id, consumer_price, location, opening_price, sms_code, tax_stuff_id } = body;
  try {
    const { validateProductUpdateFields } = require('../lib/product-master');
    validateProductUpdateFields(db, body, Number(req.params.id));
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }

  let catName = prod.category || '';
  let catId = prod.category_id;
  if (bodyHas(body, 'category_id')) {
    catId = category_id != null && category_id !== '' ? (parseInt(category_id, 10) || null) : null;
  }
  if (bodyHas(body, 'category') && category) catName = category;
  else if (!bodyHas(body, 'category') && !bodyHas(body, 'category_id')) catName = prod.category || '';
  if (catId) {
    const c = db.prepare('SELECT name FROM product_categories WHERE id=?').get(catId);
    if (c) catName = c.name;
  } else if (bodyHas(body, 'category')) {
    catName = category || '';
  }

  let image = prod.image;
  // Gallery add only — never replace/delete existing primary on edit.
  const whId = bodyHas(body, 'warehouse_id')
    ? (warehouse_id != null && warehouse_id !== '' ? (parseInt(warehouse_id, 10) || null) : null)
    : prod.warehouse_id;

  const oldStock = prod.stock;
  const excelHasMoves = !!(body.excel_upsert || body.from_excel)
    && !!db.prepare('SELECT 1 FROM warehouse_moves WHERE product_id=? LIMIT 1').get(req.params.id);
  const nameVal = bodyHas(body, 'name') ? (name || prod.name) : prod.name;
  // Excel upsert: empty code must not wipe existing product code
  const codeVal = bodyHas(body, 'code')
    ? ((code && String(code).trim()) || prod.code || '')
    : (prod.code || '');
  const priceVal = bodyHas(body, 'price') ? (parseFloat(price) || 0) : (Number(prod.price) || 0);
  const costVal = bodyHas(body, 'cost') ? (parseFloat(cost) || 0) : (Number(prod.cost) || 0);
  const { resolveProductUnit } = require('../lib/uom');
  let resolvedUnit = { unit: prod.unit || 'عدد', unit_id: prod.unit_id || null };
  if (bodyHas(body, 'unit') || bodyHas(body, 'unit_id')) {
    try {
      resolvedUnit = resolveProductUnit(db, {
        unit: bodyHas(body, 'unit') ? unit : undefined,
        unit_id: bodyHas(body, 'unit_id') ? body.unit_id : undefined,
      }, prod);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      throw e;
    }
  }
  const unitVal = resolvedUnit.unit || 'عدد';
  const intStock = requiresIntegerQty(db, Number(req.params.id), unitVal);
  // P1 — stock is NEVER written by a product edit. Quantity only moves through a document
  // (manualAdjust.postAdjust → kardex row + JE). A client that sends a DIFFERENT stock gets 409;
  // the same number (read-only form echo) is ignored. The Excel import is the one caller allowed
  // to carry an absolute qty, and it goes through postAdjust(mode=count) below.
  const isExcelUpsert = !!(body.excel_upsert || body.from_excel);
  let excelWantStock = null;
  if (bodyHas(body, 'stock') && stock !== null && String(stock).trim() !== '') {
    let want = null;
    try {
      want = parseStockQty(stock, { db, productId: Number(req.params.id), unit: unitVal, integer: intStock });
    } catch (_) { want = parseQty(stock, NaN); }
    if (Number.isFinite(want)) {
      if (isExcelUpsert) {
        if (!excelHasMoves) excelWantStock = want;
      } else {
        // Compared against the ledger-derived on-hand (single source), not the cache column.
        const liveStock = require('../lib/inventory/stock-cache').derivedQty(db, { productId: Number(req.params.id) });
        if (Math.abs(want - liveStock) > 1e-6) {
          return res.status(409).json({
            error: 'موجودی فقط با سند تعدیل/افتتاحیه تغییر می‌کند — از «تعدیل موجودی» استفاده کنید',
            code: 'E_STOCK_VIA_DOCUMENT',
            current_stock: liveStock,
          });
        }
      }
    }
  }
  const alertVal = bodyHas(body, 'stock_alert') ? (parseInt(stock_alert, 10) || 5) : (parseInt(prod.stock_alert, 10) || 5);
  const noteVal = bodyHas(body, 'note') ? (note || '') : (prod.note || '');
  const colorsVal = bodyHas(body, 'colors')
    ? Math.max(1, parseInt(colors, 10) || 1)
    : Math.max(1, parseInt(prod.colors, 10) || 1);
  const packVal = bodyHas(body, 'pack_size')
    ? Math.max(1, parseInt(pack_size, 10) || 1)
    : Math.max(1, parseInt(prod.pack_size, 10) || 1);
  const barcodeVal = bodyHas(body, 'barcode')
    ? ((barcode || '').trim() || null)
    : prod.barcode;
  const fullNameVal = bodyHas(body, 'full_name') ? (full_name || '') : (prod.full_name || '');
  const productTypeVal = bodyHas(body, 'product_type') ? (product_type || '') : (prod.product_type || '');
  const productIndexVal = bodyHas(body, 'product_index') ? (product_index || '') : (prod.product_index || '');
  const taxIdVal = bodyHas(body, 'tax_id') ? (tax_id || '') : (prod.tax_id || '');
  const consumerVal = bodyHas(body, 'consumer_price')
    ? (parseFloat(consumer_price) || 0)
    : (Number(prod.consumer_price) || 0);
  const locationVal = bodyHas(body, 'location') ? (location || '') : (prod.location || '');
  const openingPriceVal = bodyHas(body, 'opening_price')
    ? (parseFloat(opening_price) || 0)
    : (Number(prod.opening_price) || 0);
  const smsCodeVal = bodyHas(body, 'sms_code') ? (sms_code || '') : (prod.sms_code || '');
  const taxStuffVal = bodyHas(body, 'tax_stuff_id')
    ? (String(tax_stuff_id || '').trim() || null)
    : (prod.tax_stuff_id || null);

  db.prepare(`UPDATE products SET category=?,category_id=?,code=?,name=?,price=?,cost=?,stock_alert=?,unit=?,unit_id=?,note=?,image=?,colors=?,pack_size=?,warehouse_id=?,barcode=?,
    full_name=?,product_type=?,product_index=?,tax_id=?,consumer_price=?,location=?,opening_price=?,sms_code=?,tax_stuff_id=? WHERE id=?`)
    .run(catName, catId, codeVal, nameVal, priceVal, costVal, alertVal, unitVal, resolvedUnit.unit_id, noteVal, image,
         colorsVal, packVal, whId, barcodeVal,
         fullNameVal, productTypeVal, productIndexVal, taxIdVal, consumerVal,
         locationVal, openingPriceVal, smsCodeVal, taxStuffVal,
         req.params.id);
  if (bodyHas(body, 'retail_price')) {
    const rp = Math.round(parseFloat(body.retail_price) || 0);
    db.prepare('UPDATE products SET retail_price=?, retail_price_rial=? WHERE id=?').run(rp, rp, req.params.id);
  }
  if (bodyHas(body, 'min_price_rial')) {
    const mp = Math.max(0, Math.round(parseFloat(body.min_price_rial) || 0));
    db.prepare('UPDATE products SET min_price_rial=? WHERE id=?').run(mp > 0 ? mp : null, req.params.id);
  }
  if (bodyHas(body, 'full_pack_mode')) {
    try {
      const cols = db.prepare('PRAGMA table_info(products)').all();
      if (cols.some((c) => c.name === 'full_pack_mode')) {
        const raw = body.full_pack_mode;
        const mode = (raw == null || String(raw).trim() === '')
          ? null
          : (String(raw).trim().toLowerCase() === 'optional' ? 'optional' : 'required');
        db.prepare('UPDATE products SET full_pack_mode=? WHERE id=?').run(mode, req.params.id);
      }
    } catch (_) { /* column may be absent before migration */ }
  }
  if (bodyHas(body, 'costing_method')) {
    const cm = String(body.costing_method || '').trim() || null;
    db.prepare('UPDATE products SET costing_method=? WHERE id=?').run(cm, req.params.id);
  }
  if (bodyHas(body, 'valuation_level')) {
    try { require('../lib/inventory/valuation').setLayerLevel(db, 'products', Number(req.params.id), body.valuation_level, { userId: req.user.id }); } catch (_) { /* column optional */ }
  }
  // Production master-data fields (BOM / MRP / costing)
  if (bodyHas(body, 'item_type')) {
    const allowed = new Set(['finished', 'semi', 'raw', 'packaging', 'material', 'scrap', 'service']);
    const it = String(body.item_type || '').trim() || 'finished';
    if (!allowed.has(it)) return res.status(400).json({ error: 'نوع کالا نامعتبر است', code: 'E_ITEM_TYPE' });
    db.prepare('UPDATE products SET item_type=? WHERE id=?').run(it, req.params.id);
  }
  if (bodyHas(body, 'is_manufactured')) {
    const raw = body.is_manufactured;
    const mfg = raw === true || raw === 1 || raw === '1' ? 1 : 0;
    db.prepare('UPDATE products SET is_manufactured=? WHERE id=?')
      .run(mfg, req.params.id);
  }
  if (bodyHas(body, 'average_cost_rial')) {
    db.prepare('UPDATE products SET average_cost_rial=? WHERE id=?')
      .run(Math.round(Number(body.average_cost_rial) || 0), req.params.id);
  } else if (bodyHas(body, 'cost')) {
    // Catalog بها is Rial; seed moving average only when still unset so
    // warehouse valuation does not fall through a stale toman×10 path.
    const costRial = Math.round(Number(costVal) || 0);
    if (costRial > 0) {
      db.prepare(`
        UPDATE products SET average_cost_rial=?
        WHERE id=? AND COALESCE(average_cost_rial,0)=0
      `).run(costRial, req.params.id);
    }
  }
  if (bodyHas(body, 'std_cost_rial')) {
    db.prepare('UPDATE products SET std_cost_rial=? WHERE id=?')
      .run(Math.round(Number(body.std_cost_rial) || 0), req.params.id);
  }
  let websitePushNext = null;
  if (bodyHas(body, 'website_stock_push')) {
    const { normalizeWebsiteStockPush } = require('../lib/website-stock-sync');
    const next = normalizeWebsiteStockPush(body.website_stock_push, 1);
    const prev = normalizeWebsiteStockPush(prod.website_stock_push, 1);
    if (next !== prev) {
      db.prepare('UPDATE products SET website_stock_push=? WHERE id=?').run(next, req.params.id);
      websitePushNext = next;
    }
  }
  // P1 — Excel upsert is the only absolute-qty caller: it posts a count adjustment (kardex row +
  // JE) on the primary warehouse. After warehouse circulation Excel must not smash live qty
  // (excelHasMoves → excelWantStock stays null). A normal UI PUT never touches warehouse_stock.
  let excelAdjusted = false;
  if (excelWantStock != null) {
    const MA = require('../lib/inventory/manual-adjust');
    const mv = require('../lib/inventory/movement');
    if (mv.hasActiveMatrixVariants(db, Number(req.params.id))) {
      // matrix SKUs need a variant per cell — Excel's single qty column cannot express that
    } else {
      const L = require('../lib/inventory/ledger');
      const curQty = L.warehouseQty(db, Number(req.params.id), whId || null);
      if (Math.abs(excelWantStock - curQty) > 1e-9) {
        try {
          MA.postAdjust(db, {
            product_id: Number(req.params.id),
            warehouse_id: whId || undefined,
            mode: 'count',
            qty: excelWantStock,
            note: 'موجودی اکسل',
          }, req.user);
          excelAdjusted = true;
        } catch (e) {
          return res.status(e.status || 400).json({ error: e.message || 'ثبت موجودی اکسل ناموفق', code: e.code || 'E_EXCEL_STOCK' });
        }
      }
    }
  }
  // Excel upsert must never clear primary image / gallery
  if ((body.excel_upsert || body.from_excel) && prod.image) {
    db.prepare('UPDATE products SET image=? WHERE id=?').run(prod.image, req.params.id);
  }
  try {
    await attachUploadedImages(db, req.params.id, req.files, !prod.image);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || 'آپلود تصویر ناموفق' });
  }
  try {
    audit(req.user.id, 'update', 'product', req.params.id, `ویرایش محصول ${nameVal}`);
  } catch (_) {}
  if (websitePushNext === 0) {
    try { require('../lib/website-stock-sync').silenceProductWebsiteOutbox(db, req.params.id); } catch (_) {}
  } else if (websitePushNext === 1 || excelAdjusted) {
    try { require('../lib/website-stock-sync').notifyStockChanged(db, req.params.id); } catch (_) {}
  }
  const row = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  row.images = listProductImages(db, row.id);
  try {
    const completeness = require('../lib/production/product-completeness');
    const ready = completeness.assessProduct(db, Number(req.params.id), 'activate');
    row.production_readiness = { ok: ready.ok, hard: ready.hard, soft: ready.soft, kind: ready.kind };
  } catch (_) {}
  res.json(jsonSafeProduct(row));
});

// Update stock (admin only) — P1: a thin wrapper over manualAdjust.postAdjust(mode='count').
// No raw UPDATE of products/warehouse_stock any more: the change is a kardex row (+ variant_id for
// matrix products) with its JE, ws = Σledger. warehouse_id is required; matrix products need variant_id.
router.patch('/:id/stock', auth, adminOnly, centralOnly, (req, res) => {
  const body = req.body || {};
  if (body.stock === undefined || body.stock === null || body.stock === '') {
    return res.status(400).json({ error: 'موجودی الزامی است' });
  }
  const db = getDB();
  const pid = Number(req.params.id);
  const prod = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
  if (!prod) return res.status(404).json({ error: 'یافت نشد' });
  const warehouseId = Number(body.warehouse_id) || 0;
  if (!warehouseId) {
    return res.status(422).json({
      error: 'برای تعدیل موجودی باید انبار مشخص باشد',
      code: 'E_STOCK_WAREHOUSE_REQUIRED',
    });
  }
  const MA = require('../lib/inventory/manual-adjust');
  const variantId = Number(body.variant_id) || 0;
  if (!variantId && require('../lib/inventory/movement').hasActiveMatrixVariants(db, pid)) {
    return res.status(422).json({
      error: 'کالای رنگ×سایز: برای تعدیل، واریانت (رنگ/سایز) را مشخص کنید',
      code: 'E_VARIANT_REQUIRED',
    });
  }
  let qty;
  try {
    qty = parseStockQty(body.stock, {
      db, productId: pid, unit: prod.unit,
      integer: requiresIntegerQty(db, pid, prod.unit),
    });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || 'موجودی نامعتبر است', code: e.code });
  }
  const note = String(body.note || '').trim() || 'تعدیل دستی موجودی';
  const adjBody = {
    product_id: pid,
    warehouse_id: warehouseId,
    variant_id: variantId || undefined,
    mode: 'count',
    qty,
    reason_code: body.reason_code || undefined,
    date: body.date || undefined,
    note,
  };
  let out = null;
  try {
    const plan = MA.planAdjust(db, adjBody, req.user);
    if (plan.delta_qty > 0 && !plan.unit_cost_rial) {
      return res.status(422).json({
        error: 'موجودی بدون بهای میانگین مجاز نیست — ابتدا بها را از حواله مواد یا کارت کالا ثبت کنید',
        code: 'E_OPENING_COST_REQUIRED',
        name: prod.name,
      });
    }
    if (plan.delta_qty) out = MA.postAdjust(db, adjBody, req.user);
  } catch (e) {
    return res.status(e.status || 400).json({
      error: e.message || 'تعدیل موجودی ناموفق',
      code: e.code || 'E_STOCK_ADJUST',
      ...(e.shortages ? { shortages: e.shortages } : {}),
    });
  }
  if (out) {
    audit(req.user.id, 'update_stock', 'product', pid, note || `موجودی → ${qty}`);
    try { require('../lib/website-stock-sync').notifyStockChanged(db, pid, { warehouseId }); } catch (_) {}
  }
  const live = db.prepare('SELECT stock FROM products WHERE id=?').get(pid);
  res.json({
    ok: true,
    stock: Number(live && live.stock) || 0,
    new_stock: Number(live && live.stock) || 0,
    warehouse_id: warehouseId,
    variant_id: variantId || null,
    warehouse_qty: qty,
    delta_qty: out ? out.delta_qty : 0,
    ledger_id: out ? out.id : null,
    tx_no: out ? out.tx_no : null,
    je_id: out ? out.je_id : null,
    je_no: out ? out.je_no : null,
  });
});

// Delete (admin only) — cascade stock children; block if used in documents
router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const prod = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!prod) return res.status(404).json({ error: 'یافت نشد' });
  const pid = parseInt(req.params.id, 10);

  const usedInInvoice = db.prepare(`
    SELECT id, num FROM invoices WHERE COALESCE(deleted_at,0)=0 AND rows LIKE ?
    LIMIT 1
  `).get(`%"product_id":${pid}%`) || db.prepare(`
    SELECT id, num FROM invoices WHERE COALESCE(deleted_at,0)=0 AND rows LIKE ?
    LIMIT 1
  `).get(`%"product_id": ${pid}%`);
  if (usedInInvoice) {
    return res.status(409).json({ error: `این کالا در فاکتور ${usedInInvoice.num || usedInInvoice.id} استفاده شده و قابل حذف نیست` });
  }
  const usedInPurchase = db.prepare(`
    SELECT id, num FROM purchase_invoices WHERE COALESCE(status,'posted')<>'reversed' AND rows LIKE ?
    LIMIT 1
  `).get(`%"product_id":${pid}%`);
  if (usedInPurchase) {
    return res.status(409).json({ error: `این کالا در فاکتور خرید ${usedInPurchase.num || usedInPurchase.id} استفاده شده و قابل حذف نیست` });
  }
    try {
      const bomHit = db.prepare(`
        SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='bom_lines'
      `).get();
      if (bomHit) {
        const cols = db.prepare('PRAGMA table_info(bom_lines)').all().map((c) => c.name);
        if (cols.includes('component_product_id') && db.prepare('SELECT id FROM bom_lines WHERE component_product_id=? LIMIT 1').get(pid)) {
          return res.status(409).json({ error: 'این کالا در فرمول تولید (BOM) استفاده شده و قابل حذف نیست' });
        }
        if (cols.includes('product_id') && db.prepare('SELECT id FROM bom_lines WHERE product_id=? LIMIT 1').get(pid)) {
          return res.status(409).json({ error: 'این کالا در فرمول تولید (BOM) استفاده شده و قابل حذف نیست' });
        }
      }
    } catch (_) { /* optional */ }

  // Stock single-source: a product with kardex history can never be deleted (the ledger is the truth).
  try {
    const hist = db.prepare('SELECT 1 AS x FROM inventory_ledger WHERE product_id=? LIMIT 1').get(pid);
    if (hist) {
      return res.status(409).json({ error: 'این کالا گردش انبار (کاردکس) دارد و قابل حذف نیست', code: 'E_PRODUCT_HAS_LEDGER' });
    }
  } catch (_) { /* ledger table absent in tiny fixtures */ }
  try {
    db.transaction(() => {
      // Only zero cache rows can remain here (no ledger history) — dropped so the product row can go (FK).
      db.prepare('DELETE FROM warehouse_stock WHERE product_id=?').run(pid);
      try { db.prepare('DELETE FROM stock_logs WHERE product_id=?').run(pid); } catch (_) {}
      try { db.prepare('DELETE FROM stocktaking_items WHERE product_id=?').run(pid); } catch (_) {}
      try { db.prepare('DELETE FROM product_images WHERE product_id=?').run(pid); } catch (_) {}
      if (prod.image) { try { fs.unlinkSync(path.join(UPLOAD_DIR, prod.image)); } catch (e) {} }
      db.prepare('DELETE FROM products WHERE id=?').run(pid);
      // پس از حذف کالا، تفصیلی بدون گردش هم حذف می‌شود (سینک tombstone)
      if (prod.coa_code) {
        const rel = releaseTafsili(db, prod.coa_code);
        if (!rel.ok && rel.reason === 'in_use') {
          const err = new Error(rel.error || 'کدینگ در گردش است');
          err.status = 409;
          throw err;
        }
      }
    })();
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    return res.status(409).json({ error: e.message.includes('FOREIGN KEY')
      ? 'این کالا به اسناد دیگر وابسته است و قابل حذف نیست'
      : (e.message || 'حذف ناموفق') });
  }
  audit(req.user.id, 'delete', 'product', pid, `حذف محصول ${prod.name}`);
  res.json({ ok: true });
});

function normalizeStr(s) {
  if (!s) return '';
  return String(s)
    .replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/ة/g, 'ه')
    .replace(/[٠١٢٣٤٥٦٧٨٩]/g, d => d.charCodeAt(0) - 0x0660)
    .replace(/[۰۱۲۳۴۵۶۷۸۹]/g, d => d.charCodeAt(0) - 0x06F0)
    .trim();
}

// Import from Excel (admin only)
router.post('/import', auth, adminOnly, excelUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایل آپلود نشد' });
  try {
    const wb = await readWorkbook(req.file.buffer);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws);
    const db = getDB();
    // No direct stock from import — any row with موجودی > 0 rejects the whole file.
    const stockRows = [];
    data.forEach((row, i) => {
      if (parseQty(row['موجودی'] || row['stock'] || 0) > 0) stockRows.push(i + 2);
    });
    if (stockRows.length) {
      return res.status(422).json({
        error: `موجودی اول دوره از جدول «موجودی اول دوره» همان فرم کالا ثبت می‌شود (سند افتتاحیه) — ستون موجودی را خالی/صفر کنید (ردیف‌های ${stockRows.slice(0, 50).join('، ')})`,
        code: 'E_STOCK_VIA_OPENING',
        rows: stockRows,
      });
    }
    let inserted = 0;
    const stmt = db.prepare('INSERT INTO products (user_id,category,code,name,price,stock,stock_alert,unit,colors,pack_size,barcode) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    const insertMany = db.transaction((rows) => {
      for (const row of rows) {
        const name = normalizeStr(row['نام محصول'] || row['name'] || row['Name'] || '');
        if (!name) continue;
        const r = stmt.run(
          req.user.id,
          normalizeStr(row['دسته‌بندی'] || row['category'] || ''),
          normalizeStr(row['کد محصول'] || row['code'] || ''),
          name,
          parseFloat(row['قیمت'] || row['price'] || 0),
          0,
          parseInt(row['هشدار موجودی'] || row['stock_alert'] || 5) || 5,
          row['واحد'] || row['unit'] || 'عدد',
          parseInt(row['تعداد رنگ'] || row['colors'] || 1),
          parseInt(row['تعداد در پک'] || row['pack_size'] || 1),
          normalizeStr(row['بارکد'] || row['barcode'] || '') || null
        );
        try { assignProductTafsili(db, r.lastInsertRowid, name); } catch (_) {}
        inserted++;
      }
    });
    insertMany(data);
    audit(req.user.id, 'import', 'product', null, `ورود ${inserted} محصول از اکسل`);
    res.json({ ok: true, inserted });
  } catch (e) {
    res.status(400).json({ error: 'خطا در خواندن فایل: ' + e.message });
  }
});

// Export all products
router.get('/export/excel', auth, adminOnly, async (req, res) => {
  const db = getDB();
  const rows = db.prepare('SELECT * FROM products ORDER BY created_at DESC').all();
  const data = rows.map(r => ({
    'دسته‌بندی': r.category, 'کد محصول': r.code, 'بارکد': r.barcode || '', 'نام محصول': r.name,
    'قیمت': r.price, 'موجودی': r.stock, 'هشدار موجودی': r.stock_alert, 'واحد': r.unit
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'محصولات');
  const buf = await XLSX.write(wb);
  res.setHeader('Content-Disposition', 'attachment; filename=products.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Excel template
router.get('/template', auth, async (req, res) => {
  const wb = XLSX.utils.book_new();
  const data = [
    { 'دسته‌بندی': 'مانتو', 'کد محصول': 'MT-001', 'نام محصول': 'مانتو لینن بهاره', 'قیمت': 350000, 'موجودی': 0, 'هشدار موجودی': 5, 'واحد': 'عدد' },
    { 'دسته‌بندی': 'شومیز', 'کد محصول': 'SH-001', 'نام محصول': 'شومیز کتان', 'قیمت': 280000, 'موجودی': 0, 'هشدار موجودی': 5, 'واحد': 'عدد' },
  ];
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'محصولات');
  const buf = await XLSX.write(wb);
  res.setHeader('Content-Disposition', 'attachment; filename=products-template.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

module.exports = router;
