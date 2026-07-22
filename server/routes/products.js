const router = require('express').Router();
const { allocTafsili } = require('../lib/coa-map');
const { parseQty } = require('../lib/round3');
const jwt = require('jsonwebtoken');
const { getDB, audit } = require('../db');
const { auth, adminOnly, adminOrAccounting, centralOnly, SECRET, requirePermission } = require('../middleware/auth');
const XLSX = require('xlsx');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

let sharp = null;
try { sharp = require('sharp'); } catch (e) { /* optional — falls back to raw storage */ }

const { UPLOADS_ROOT } = require('../paths');
const UPLOAD_DIR = path.join(UPLOADS_ROOT, 'products');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// Auto product code (کد کالا) when the user leaves it blank: sequential K-00001.
function nextProductCode(db) {
  const row = db.prepare("SELECT code FROM products WHERE code GLOB 'K-[0-9]*' ORDER BY id DESC LIMIT 1").get();
  let n = 1;
  if (row && row.code) {
    const m = row.code.match(/K-(\d+)/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `K-${String(n).padStart(5, '0')}`;
}

async function saveImage(buffer, originalName) {
  if (sharp) {
    try {
      const filename = 'p_' + Date.now() + '_' + Math.round(Math.random() * 1e6) + '.webp';
      const dest = path.join(UPLOAD_DIR, filename);
      await sharp(buffer)
        .resize(600, 600, { fit: 'cover', position: 'centre' })
        .webp({ quality: 82 })
        .toFile(dest);
      return filename;
    } catch (e) {
      console.error('sharp processing failed, saving original:', e.message);
    }
  }
  const ext = path.extname(originalName || '').toLowerCase() || '.jpg';
  const fallback = 'p_' + Date.now() + '_' + Math.round(Math.random() * 1e6) + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, fallback), buffer);
  return fallback;
}
const memUpload = multer({ storage: multer.memoryStorage() });

// Update 11 / B1: گروه‌های کالا سراسری‌اند — فیلتر دیده‌شدن گروه حذف شد.

// GET /  — products are GLOBAL: every authenticated user can read all.
// Filtering: ?category=&search=&stock_status=low|ok|all  (FIXED)
router.get('/', auth, (req, res) => {
  const db = getDB();
  const where = [];
  const params = [];

  const category = (req.query.category || '').trim();
  if (category && category !== 'all') { where.push('p.category = ?'); params.push(category); }
  const categoryId = req.query.category_id;
  if (categoryId && String(categoryId) !== 'all' && String(categoryId) !== '') {
    where.push('p.category_id = ?');
    params.push(parseInt(categoryId, 10));
  }

  const search = (req.query.search || '').trim();
  if (search) {
    where.push('(p.name LIKE ? OR p.code LIKE ? OR p.barcode LIKE ?)');
    params.push('%' + search + '%', '%' + search + '%', '%' + search + '%');
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

  const warehouseId = parseInt(req.query.warehouse_id);
  if (warehouseId) { where.push('(p.warehouse_id=? OR EXISTS (SELECT 1 FROM warehouse_stock ws WHERE ws.product_id=p.id AND ws.warehouse_id=? AND ws.qty>0))'); params.push(warehouseId, warehouseId); }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const whSelect = warehouseId
    ? `, (SELECT COALESCE(ws.qty, p.stock) FROM warehouse_stock ws WHERE ws.product_id=p.id AND ws.warehouse_id=${warehouseId} LIMIT 1) as wh_qty`
    : '';
  const rows = db.prepare(`
    SELECT p.*, w.name as warehouse_name${whSelect}
    FROM products p
    LEFT JOIN warehouses w ON p.warehouse_id=w.id
    LEFT JOIN product_categories pc ON pc.id=p.category_id
    ${whereSql} ORDER BY p.created_at DESC
  `).all(...params);
  res.json(rows);
});

// Distinct categories (for filter dropdown) — MUST be registered before /:id/*
// routes so GET /categories is never captured as an id (spec 1.0.9 §2 catalog).
router.get('/categories', auth, (req, res) => {
  const db = getDB();
  const fromTable = db.prepare(`SELECT name FROM product_categories WHERE active=1 ORDER BY sort_order, name`).all().map(r => r.name);
  const fromLegacy = db.prepare(`
    SELECT DISTINCT p.category FROM products p
    WHERE p.category IS NOT NULL AND p.category<>''
    ORDER BY p.category
  `).all().map(r => r.category);
  const seen = new Set();
  res.json([...fromTable, ...fromLegacy].filter(c => { if (seen.has(c)) return false; seen.add(c); return true; }));
});

// Lookup by barcode or product code — used by the invoice builder camera scanner
router.get('/by-barcode/:code', auth, (req, res) => {
  const db = getDB();
  const code = String(req.params.code || '').trim();
  if (!code) return res.status(400).json({ error: 'کد الزامی است' });
  const row = db.prepare(`
    SELECT p.* FROM products p WHERE p.barcode=? OR p.code=?
  `).get(code, code);
  if (!row) return res.status(404).json({ error: 'محصولی با این بارکد یافت نشد' });
  res.json(row);
});

// Item Kardex — per-product stock movement ledger with a running balance.
// stock_logs has no explicit "opening" row, so the running balance is
// reconstructed backward from the product's current stock (i.e. the
// starting point is whatever stock existed before the earliest logged
// change) so the final computed balance always reconciles with reality.
router.get('/:id/kardex', auth, (req, res) => {
  const db = getDB();
  const product = db.prepare(`SELECT p.* FROM products p WHERE p.id=?`).get(req.params.id);
  if (!product) return res.status(404).json({ error: 'محصول یافت نشد' });

  // Prefer immutable inventory_ledger when present
  const hasLedger = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='inventory_ledger'"
  ).get();
  if (hasLedger) {
    const rows = db.prepare(`
      SELECT l.*, u.name as user_name, w.name as warehouse_name
      FROM inventory_ledger l
      LEFT JOIN users u ON l.created_by=u.id
      LEFT JOIN warehouses w ON l.warehouse_id=w.id
      WHERE l.product_id=? AND l.status IN ('posted','reversed')
      ORDER BY l.id ASC
    `).all(req.params.id);
    if (rows.length) {
      const logs = rows.map(l => ({
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
      return res.json({ product, logs, source: 'inventory_ledger' });
    }
  }

  const logs = db.prepare(`
    SELECT sl.*, u.name as user_name FROM stock_logs sl LEFT JOIN users u ON sl.user_id=u.id
    WHERE sl.product_id=? ORDER BY sl.created_at ASC, sl.id ASC
  `).all(req.params.id);
  const totalChange = logs.reduce((a, l) => a + (l.change || 0), 0);
  let running = (product.stock || 0) - totalChange;
  logs.forEach(l => { running += (l.change || 0); l.running_balance = running; l.source = 'stock_logs'; });
  res.json({ product, logs, source: 'stock_logs' });
});

// ── Barcode support (ported from CRM v4) ────────────────────────────────────

// EAN-13 style internal barcode: prefix 200 (in-store use) + 000 + product id + check digit
function generateBarcode(productId) {
  const base = '200' + '000' + String(productId % 1000000).padStart(6, '0');
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return base + check;
}

// Generate a barcode for a product that lacks one (admin only).
// Deterministic per product id → device replay converges with central.
router.post('/:id/generate-barcode', auth, adminOnly, (req, res) => {
  const db = getDB();
  const prod = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!prod) return res.status(404).json({ error: 'یافت نشد' });
  if (prod.barcode) return res.json({ ok: true, barcode: prod.barcode, existed: true });
  const barcode = generateBarcode(prod.id);
  db.prepare('UPDATE products SET barcode=? WHERE id=?').run(barcode, prod.id);
  audit(req.user.id, 'generate_barcode', 'product', prod.id, `تولید بارکد ${barcode} برای ${prod.name}`, req);
  res.json({ ok: true, barcode });
});

// Printable barcode label page. Opened as a plain link in a new tab, so the
// JWT arrives via ?token= query param instead of the Authorization header.
router.get('/:id/labels', (req, res) => {
  let tokenUser;
  try { tokenUser = jwt.verify(String(req.query.token || ''), SECRET); }
  catch { return res.status(401).send('توکن نامعتبر — دوباره وارد شوید'); }
  const db = getDB();
  const count = Math.min(50, Math.max(1, parseInt(req.query.count || '12')));
  const prod = db.prepare(`SELECT p.* FROM products p WHERE p.id=?`).get(req.params.id);
  if (!prod) return res.status(404).send('محصول یافت نشد');
  if (!prod.barcode) return res.status(400).send('این محصول بارکد ندارد — ابتدا بارکد تولید کنید');
  const escName = String(prod.name || '').replace(/</g, '&lt;');
  const labels = Array.from({ length: count }, () => `
    <div class="label">
      <div class="name">${escName}</div>
      <svg class="bc" data-code="${prod.barcode}"></svg>
      <div class="meta">${String(prod.code || '').replace(/</g, '&lt;')} — ${Number(prod.price || 0).toLocaleString('fa-IR')} ریال</div>
    </div>`).join('');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="UTF-8">
<title>برچسب ${escName}</title>
<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:'Vazirmatn',sans-serif}
body{padding:16px;display:flex;flex-wrap:wrap;gap:8px}
.label{width:58mm;height:40mm;border:1px dashed #bbb;border-radius:4px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:4px;page-break-inside:avoid}
.name{font-size:11px;font-weight:700;text-align:center}
.meta{font-size:10px;color:#444}
.pbtn{position:fixed;bottom:14px;left:14px;background:#1A5C38;color:#fff;border:none;padding:10px 26px;border-radius:8px;font-family:inherit;font-size:14px;cursor:pointer}
@media print{.pbtn{display:none}.label{border-color:transparent}}
</style></head><body>
${labels}
<button class="pbtn" onclick="window.print()">چاپ 🖨️</button>
<script>
document.querySelectorAll('svg.bc').forEach(function(el){
  try{ JsBarcode(el, el.dataset.code, {format:'ean13', width:1.6, height:44, fontSize:12, margin:0}); }
  catch(e){ el.outerHTML='<div style="font-size:12px;direction:ltr">'+el.dataset.code+'</div>'; }
});
</script></body></html>`);
});

// Quick create from invoice modals — admin/accounting only (product master lives in accounting)
router.post('/quick', auth, adminOrAccounting, (req, res) => {
  const {
    name, category_id, category, code, price, cost, warehouse_id, unit, stock, stock_alert,
    note, colors, pack_size, barcode, full_name, product_type, product_index, tax_id,
    consumer_price, location, opening_price, sms_code
  } = req.body;
  if (!name) return res.status(400).json({ error: 'نام محصول الزامی است' });
  const db = getDB();
  const codeTrim = code && String(code).trim();
  const barcodeTrim = barcode && String(barcode).trim();
  if (codeTrim && db.prepare('SELECT id FROM products WHERE code=?').get(codeTrim)) {
    return res.status(409).json({ error: 'کد کالا تکراری است — داده تکراری ذخیره نمی‌شود' });
  }
  if (barcodeTrim && db.prepare('SELECT id FROM products WHERE barcode=?').get(barcodeTrim)) {
    return res.status(409).json({ error: 'بارکد تکراری است — داده تکراری ذخیره نمی‌شود' });
  }
  if (db.prepare('SELECT id FROM products WHERE name=?').get(String(name).trim())) {
    return res.status(409).json({ error: 'نام کالا تکراری است — داده تکراری ذخیره نمی‌شود' });
  }
  let catName = category || '';
  let catId = category_id || null;
  if (catId) {
    const c = db.prepare('SELECT name FROM product_categories WHERE id=?').get(catId);
    if (!c) return res.status(400).json({ error: 'گروه کالا یافت نشد' });
    if (c) catName = c.name;
  } else if (catName) {
    const c = db.prepare('SELECT id,name FROM product_categories WHERE name=?').get(catName);
    if (c) { catId = c.id; catName = c.name; }
  }
  const defaultWarehouse = warehouse_id || db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get()?.id || null;
  const prodCode = (code && String(code).trim()) || nextProductCode(db);
  const openingStock = Math.max(0, parseQty(stock, 0));
  const pid = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO products (
        user_id,category,category_id,code,name,price,cost,stock,stock_alert,unit,warehouse_id,
        note,colors,pack_size,barcode,full_name,product_type,product_index,tax_id,consumer_price,
        location,opening_price,sms_code,tax_stuff_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      req.user.id, catName, catId, prodCode, name, parseFloat(price) || 0, parseFloat(cost) || 0,
      openingStock, parseInt(stock_alert, 10) || 5, unit || 'عدد', defaultWarehouse,
      note || '', Math.max(1, parseInt(colors, 10) || 1), Math.max(1, parseInt(pack_size, 10) || 1),
      String(barcode || '').trim() || null, full_name || '', product_type || '', product_index || '',
      tax_id || '', parseFloat(consumer_price) || 0, location || '', parseFloat(opening_price) || 0,
      sms_code || '', String(req.body.tax_stuff_id || '').trim() || null
    );
    if (defaultWarehouse) {
      db.prepare('INSERT OR REPLACE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)')
        .run(result.lastInsertRowid, defaultWarehouse, openingStock);
    }
    try {
      const cc = allocTafsili(db, 'product', name);
      if (cc) db.prepare('UPDATE products SET coa_code=? WHERE id=?').run(cc, result.lastInsertRowid);
    } catch (_) { /* optional in legacy mode */ }
    return result.lastInsertRowid;
  })();
  audit(req.user.id, 'create', 'product', pid, `ساخت سریع محصول ${name}`);
  res.json(db.prepare('SELECT * FROM products WHERE id=?').get(pid));
});

// Create product — multipart form-data for optional image (admin/accounting)
router.post('/', auth, adminOrAccounting, upload.single('image'), async (req, res) => {
  const {
    category, category_id, code, name, price, cost, stock, stock_alert, unit, note, colors,
    pack_size, barcode, warehouse_id, full_name, product_type, product_index, tax_id,
    consumer_price, location, opening_price, sms_code, tax_stuff_id
  } = req.body;
  if (!name) return res.status(400).json({ error: 'نام محصول الزامی است' });
  const db = getDB();
  let catName = category || '';
  let catId = category_id || null;
  if (catId) {
    const c = db.prepare('SELECT name FROM product_categories WHERE id=?').get(catId);
    if (c) catName = c.name;
  }
  let image = null;
  if (req.file) {
    try { image = await saveImage(req.file.buffer, req.file.originalname); } catch (e) { image = null; }
  }
  // New products default into the first warehouse so warehouse_id is never
  // null — Warehouse Transfer can relocate them afterward.
  const defaultWarehouse = warehouse_id
    ? db.prepare('SELECT id FROM warehouses WHERE id=?').get(parseInt(warehouse_id, 10))
    : db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get();
  const prodCode = (code && String(code).trim()) || nextProductCode(db);
  const result = db.prepare(
    `INSERT INTO products (
      user_id,category,category_id,code,name,price,cost,stock,stock_alert,unit,note,image,colors,
      pack_size,warehouse_id,barcode,full_name,product_type,product_index,tax_id,consumer_price,
      location,opening_price,sms_code,tax_stuff_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(req.user.id, catName, catId, prodCode, name, parseFloat(price) || 0, parseFloat(cost) || 0, parseQty(stock),
        parseInt(stock_alert) || 5, unit || 'عدد', note || '', image,
        parseInt(colors) || 1, parseInt(pack_size) || 1, defaultWarehouse ? defaultWarehouse.id : null,
        (barcode || '').trim() || null, full_name || '', product_type || '', product_index || '', tax_id || '',
        parseFloat(consumer_price) || 0, location || '', parseFloat(opening_price) || 0, sms_code || '',
        String(tax_stuff_id || '').trim() || null);
  // Seed the default warehouse's stock with the opening quantity so
  // warehouse_stock and products.stock start in agreement. Without this the
  // first official invoice seeds the row at 0 and decrements from 0, leaving
  // warehouse_stock=0 while products.stock still shows the remainder — which
  // then wrongly blocks every later sale ("موجودی انبار کافی نیست").
  if (defaultWarehouse) {
    db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)')
      .run(result.lastInsertRowid, defaultWarehouse.id, parseQty(stock));
  }
  if (req.body.retail_price != null && req.body.retail_price !== '') {
    const rp = Math.round(parseFloat(req.body.retail_price) || 0);
    db.prepare('UPDATE products SET retail_price=?, retail_price_rial=? WHERE id=?').run(rp, rp, result.lastInsertRowid);
  }
  if (req.body.costing_method !== undefined) {
    const cm = String(req.body.costing_method || '').trim() || null;
    db.prepare('UPDATE products SET costing_method=? WHERE id=?').run(cm, result.lastInsertRowid);
  }
  // حالت کدینگ محک: تفصیلی اختصاصی کالا (برای سند COGS)
  try { const cc = allocTafsili(db, 'product', name); if (cc) db.prepare('UPDATE products SET coa_code=? WHERE id=?').run(cc, result.lastInsertRowid); } catch (_) {}
  audit(req.user.id, 'create', 'product', result.lastInsertRowid, `ساخت محصول ${name}`);
  res.json(db.prepare('SELECT * FROM products WHERE id=?').get(result.lastInsertRowid));
});

// Update product (admin only)
router.put('/:id', auth, adminOrAccounting, upload.single('image'), async (req, res) => {
  const db = getDB();
  const prod = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!prod) return res.status(404).json({ error: 'یافت نشد' });
  const { category, category_id, code, name, price, cost, stock, stock_alert, unit, note, colors, pack_size, warehouse_id, barcode,
    full_name, product_type, product_index, tax_id, consumer_price, location, opening_price, sms_code, tax_stuff_id } = req.body;
  let catName = category || prod.category || '';
  let catId = category_id != null && category_id !== '' ? (parseInt(category_id) || null) : prod.category_id;
  if (catId) {
    const c = db.prepare('SELECT name FROM product_categories WHERE id=?').get(catId);
    if (c) catName = c.name;
  }
  let image = prod.image;
  if (req.file) {
    try {
      image = await saveImage(req.file.buffer, req.file.originalname);
      if (prod.image) { try { fs.unlinkSync(path.join(UPLOAD_DIR, prod.image)); } catch (e) {} }
    } catch (e) { image = prod.image; }
  }
  const whId = warehouse_id != null && warehouse_id !== '' ? (parseInt(warehouse_id) || null) : prod.warehouse_id;
  db.prepare(`UPDATE products SET category=?,category_id=?,code=?,name=?,price=?,cost=?,stock=?,stock_alert=?,unit=?,note=?,image=?,colors=?,pack_size=?,warehouse_id=?,barcode=?,
    full_name=?,product_type=?,product_index=?,tax_id=?,consumer_price=?,location=?,opening_price=?,sms_code=?,tax_stuff_id=? WHERE id=?`)
    .run(catName, catId, code || '', name || prod.name, parseFloat(price) || 0,
         cost !== undefined ? (parseFloat(cost) || 0) : (prod.cost || 0), parseQty(stock),
         parseInt(stock_alert) || 5, unit || 'عدد', note || '', image,
         parseInt(colors) || prod.colors || 1, parseInt(pack_size) || prod.pack_size || 1,
         whId, barcode !== undefined ? ((barcode || '').trim() || null) : prod.barcode,
         full_name ?? prod.full_name ?? '', product_type ?? prod.product_type ?? '',
         product_index ?? prod.product_index ?? '', tax_id ?? prod.tax_id ?? '',
         consumer_price !== undefined ? (parseFloat(consumer_price) || 0) : (prod.consumer_price || 0),
         location ?? prod.location ?? '', opening_price !== undefined ? (parseFloat(opening_price) || 0) : (prod.opening_price || 0),
         sms_code ?? prod.sms_code ?? '',
         tax_stuff_id !== undefined ? (String(tax_stuff_id || '').trim() || null) : (prod.tax_stuff_id || null),
         req.params.id);
  if (req.body.retail_price !== undefined) {
    const rp = Math.round(parseFloat(req.body.retail_price) || 0);
    db.prepare('UPDATE products SET retail_price=?, retail_price_rial=? WHERE id=?').run(rp, rp, req.params.id);
  }
  if (req.body.costing_method !== undefined) {
    const cm = String(req.body.costing_method || '').trim() || null;
    db.prepare('UPDATE products SET costing_method=? WHERE id=?').run(cm, req.params.id);
  }
  if (whId) {
    db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)')
      .run(req.params.id, whId, parseQty(stock) || prod.stock || 0);
  }
  audit(req.user.id, 'update', 'product', req.params.id, `ویرایش محصول ${name || prod.name}`);
  res.json(db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id));
});

// Update stock (admin only)
router.patch('/:id/stock', auth, adminOnly, centralOnly, (req, res) => {
  const { stock, note } = req.body;
  if (stock === undefined) return res.status(400).json({ error: 'موجودی الزامی است' });
  const db = getDB();
  const prod = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!prod) return res.status(404).json({ error: 'یافت نشد' });
  const newStock = parseQty(stock);
  const change = newStock - (Number(prod.stock) || 0);
  db.prepare('UPDATE products SET stock=? WHERE id=?').run(newStock, req.params.id);
  // Keep the product's warehouse_stock in step with the manual override so the
  // per-warehouse figure (used by invoice deduction) never drifts from
  // products.stock.
  if (prod.warehouse_id) {
    db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,0)')
      .run(req.params.id, prod.warehouse_id);
    db.prepare('UPDATE warehouse_stock SET qty=CASE WHEN qty+? < 0 THEN 0 ELSE qty+? END WHERE product_id=? AND warehouse_id=?')
      .run(change, change, req.params.id, prod.warehouse_id);
  }
  db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)').run(req.params.id, req.user.id, change, note || '');
  res.json({ ok: true, new_stock: newStock });
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

  try {
    db.transaction(() => {
      db.prepare('DELETE FROM warehouse_stock WHERE product_id=?').run(pid);
      try { db.prepare('DELETE FROM stock_logs WHERE product_id=?').run(pid); } catch (_) {}
      try { db.prepare('DELETE FROM stocktaking_items WHERE product_id=?').run(pid); } catch (_) {}
      if (prod.image) { try { fs.unlinkSync(path.join(UPLOAD_DIR, prod.image)); } catch (e) {} }
      db.prepare('DELETE FROM products WHERE id=?').run(pid);
    })();
  } catch (e) {
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
router.post('/import', auth, adminOnly, memUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایل آپلود نشد' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws);
    const db = getDB();
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
          parseQty(row['موجودی'] || row['stock'] || 0),
          parseInt(row['هشدار موجودی'] || row['stock_alert'] || 5) || 5,
          row['واحد'] || row['unit'] || 'عدد',
          parseInt(row['تعداد رنگ'] || row['colors'] || 1),
          parseInt(row['تعداد در پک'] || row['pack_size'] || 1),
          normalizeStr(row['بارکد'] || row['barcode'] || '') || null
        );
        try { const cc = allocTafsili(db, 'product', name); if (cc) db.prepare('UPDATE products SET coa_code=? WHERE id=?').run(cc, r.lastInsertRowid); } catch (_) {}
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
router.get('/export/excel', auth, adminOnly, (req, res) => {
  const db = getDB();
  const rows = db.prepare('SELECT * FROM products ORDER BY created_at DESC').all();
  const data = rows.map(r => ({
    'دسته‌بندی': r.category, 'کد محصول': r.code, 'بارکد': r.barcode || '', 'نام محصول': r.name,
    'قیمت': r.price, 'موجودی': r.stock, 'هشدار موجودی': r.stock_alert, 'واحد': r.unit
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'محصولات');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=products.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Excel template
router.get('/template', auth, (req, res) => {
  const wb = XLSX.utils.book_new();
  const data = [
    { 'دسته‌بندی': 'مانتو', 'کد محصول': 'MT-001', 'نام محصول': 'مانتو لینن بهاره', 'قیمت': 350000, 'موجودی': 50, 'هشدار موجودی': 5, 'واحد': 'عدد' },
    { 'دسته‌بندی': 'شومیز', 'کد محصول': 'SH-001', 'نام محصول': 'شومیز کتان', 'قیمت': 280000, 'موجودی': 30, 'هشدار موجودی': 5, 'واحد': 'عدد' },
  ];
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'محصولات');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=products-template.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

module.exports = router;
