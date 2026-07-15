const router = require('express').Router();
const { allocTafsili } = require('../lib/coa-map');
const jwt = require('jsonwebtoken');
const { getDB, audit } = require('../db');
const { auth, adminOnly, centralOnly, SECRET, requirePermission } = require('../middleware/auth');
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

// GET /  — products are GLOBAL: every authenticated user can read all.
// Filtering: ?category=&search=&stock_status=low|ok|all  (FIXED)
router.get('/', auth, (req, res) => {
  const db = getDB();
  const where = [];
  const params = [];

  const category = (req.query.category || '').trim();
  if (category && category !== 'all') { where.push('p.category = ?'); params.push(category); }

  const search = (req.query.search || '').trim();
  if (search) {
    where.push('(p.name LIKE ? OR p.code LIKE ? OR p.barcode LIKE ?)');
    params.push('%' + search + '%', '%' + search + '%', '%' + search + '%');
  }

  const stockStatus = (req.query.stock_status || 'all').trim();
  if (stockStatus === 'low') where.push('p.stock <= p.stock_alert');
  else if (stockStatus === 'ok') where.push('p.stock > p.stock_alert');

  const warehouseId = parseInt(req.query.warehouse_id);
  if (warehouseId) { where.push('(p.warehouse_id=? OR EXISTS (SELECT 1 FROM warehouse_stock ws WHERE ws.product_id=p.id AND ws.warehouse_id=? AND ws.qty>0))'); params.push(warehouseId, warehouseId); }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const whSelect = warehouseId
    ? `, (SELECT COALESCE(ws.qty, p.stock) FROM warehouse_stock ws WHERE ws.product_id=p.id AND ws.warehouse_id=${warehouseId} LIMIT 1) as wh_qty`
    : '';
  const rows = db.prepare(`
    SELECT p.*, w.name as warehouse_name${whSelect}
    FROM products p LEFT JOIN warehouses w ON p.warehouse_id=w.id
    ${whereSql} ORDER BY p.created_at DESC
  `).all(...params);
  res.json(rows);
});

// Distinct categories (for filter dropdown) — MUST be registered before /:id/*
// routes so GET /categories is never captured as an id (spec 1.0.9 §2 catalog).
router.get('/categories', auth, (req, res) => {
  const db = getDB();
  const fromTable = db.prepare('SELECT name FROM product_categories WHERE active=1 ORDER BY sort_order, name').all().map(r => r.name);
  const fromLegacy = db.prepare("SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category<>'' ORDER BY category").all().map(r => r.category);
  const seen = new Set();
  res.json([...fromTable, ...fromLegacy].filter(c => { if (seen.has(c)) return false; seen.add(c); return true; }));
});

// Lookup by barcode or product code — used by the invoice builder camera scanner
router.get('/by-barcode/:code', auth, (req, res) => {
  const db = getDB();
  const code = String(req.params.code || '').trim();
  if (!code) return res.status(400).json({ error: 'کد الزامی است' });
  const row = db.prepare('SELECT * FROM products WHERE barcode=? OR code=?').get(code, code);
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
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'محصول یافت نشد' });
  const logs = db.prepare(`
    SELECT sl.*, u.name as user_name FROM stock_logs sl LEFT JOIN users u ON sl.user_id=u.id
    WHERE sl.product_id=? ORDER BY sl.created_at ASC, sl.id ASC
  `).all(req.params.id);
  const totalChange = logs.reduce((a, l) => a + (l.change || 0), 0);
  let running = (product.stock || 0) - totalChange;
  logs.forEach(l => { running += (l.change || 0); l.running_balance = running; });
  res.json({ product, logs });
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
  try { jwt.verify(String(req.query.token || ''), SECRET); }
  catch { return res.status(401).send('توکن نامعتبر — دوباره وارد شوید'); }
  const db = getDB();
  const count = Math.min(50, Math.max(1, parseInt(req.query.count || '12')));
  const prod = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!prod) return res.status(404).send('محصول یافت نشد');
  if (!prod.barcode) return res.status(400).send('این محصول بارکد ندارد — ابتدا بارکد تولید کنید');
  const escName = String(prod.name || '').replace(/</g, '&lt;');
  const labels = Array.from({ length: count }, () => `
    <div class="label">
      <div class="name">${escName}</div>
      <svg class="bc" data-code="${prod.barcode}"></svg>
      <div class="meta">${String(prod.code || '').replace(/</g, '&lt;')} — ${Number(prod.price || 0).toLocaleString('fa-IR')} تومان</div>
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

// Quick create from invoice modals — managers and accountants (v1.0.11)
router.post('/quick', auth, requirePermission('products', 'create'), (req, res) => {
  const { name, category_id, category, code, price, cost, warehouse_id, unit } = req.body;
  if (!name) return res.status(400).json({ error: 'نام محصول الزامی است' });
  const db = getDB();
  let catName = category || '';
  let catId = category_id || null;
  if (catId) {
    const c = db.prepare('SELECT name FROM product_categories WHERE id=?').get(catId);
    if (c) catName = c.name;
  }
  const defaultWarehouse = warehouse_id || db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get()?.id || null;
  const result = db.prepare(
    'INSERT INTO products (user_id,category,category_id,code,name,price,cost,stock,stock_alert,unit,warehouse_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(req.user.id, catName, catId, code || '', name, parseFloat(price) || 0, parseFloat(cost) || 0, 0, 5, unit || 'عدد', defaultWarehouse);
  const pid = result.lastInsertRowid;
  if (defaultWarehouse) {
    db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,0)')
      .run(pid, defaultWarehouse);
  }
  // حالت کدینگ محک: تفصیلی اختصاصی کالا زیر معین موجودی (برای سند COGS)
  try { const cc = allocTafsili(db, 'product', name); if (cc) db.prepare('UPDATE products SET coa_code=? WHERE id=?').run(cc, pid); } catch (_) {}
  audit(req.user.id, 'create', 'product', pid, `ساخت سریع محصول ${name}`);
  res.json(db.prepare('SELECT * FROM products WHERE id=?').get(pid));
});

// Create product (admin only) — multipart form-data for optional image
router.post('/', auth, adminOnly, upload.single('image'), async (req, res) => {
  const { category, category_id, code, name, price, cost, stock, stock_alert, unit, note, colors, pack_size, barcode } = req.body;
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
  const defaultWarehouse = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get();
  const result = db.prepare(
    'INSERT INTO products (user_id,category,category_id,code,name,price,cost,stock,stock_alert,unit,note,image,colors,pack_size,warehouse_id,barcode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(req.user.id, catName, catId, code || '', name, parseFloat(price) || 0, parseFloat(cost) || 0, parseInt(stock) || 0,
        parseInt(stock_alert) || 5, unit || 'عدد', note || '', image,
        parseInt(colors) || 1, parseInt(pack_size) || 1, defaultWarehouse ? defaultWarehouse.id : null,
        (barcode || '').trim() || null);
  // حالت کدینگ محک: تفصیلی اختصاصی کالا (برای سند COGS)
  try { const cc = allocTafsili(db, 'product', name); if (cc) db.prepare('UPDATE products SET coa_code=? WHERE id=?').run(cc, result.lastInsertRowid); } catch (_) {}
  audit(req.user.id, 'create', 'product', result.lastInsertRowid, `ساخت محصول ${name}`);
  res.json(db.prepare('SELECT * FROM products WHERE id=?').get(result.lastInsertRowid));
});

// Update product (admin only)
router.put('/:id', auth, adminOnly, upload.single('image'), async (req, res) => {
  const db = getDB();
  const prod = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!prod) return res.status(404).json({ error: 'یافت نشد' });
  const { category, category_id, code, name, price, cost, stock, stock_alert, unit, note, colors, pack_size, warehouse_id, barcode,
    full_name, product_type, product_index, tax_id, consumer_price, location, opening_price, sms_code } = req.body;
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
    full_name=?,product_type=?,product_index=?,tax_id=?,consumer_price=?,location=?,opening_price=?,sms_code=? WHERE id=?`)
    .run(catName, catId, code || '', name || prod.name, parseFloat(price) || 0,
         cost !== undefined ? (parseFloat(cost) || 0) : (prod.cost || 0), parseInt(stock) || 0,
         parseInt(stock_alert) || 5, unit || 'عدد', note || '', image,
         parseInt(colors) || prod.colors || 1, parseInt(pack_size) || prod.pack_size || 1,
         whId, barcode !== undefined ? ((barcode || '').trim() || null) : prod.barcode,
         full_name ?? prod.full_name ?? '', product_type ?? prod.product_type ?? '',
         product_index ?? prod.product_index ?? '', tax_id ?? prod.tax_id ?? '',
         consumer_price !== undefined ? (parseFloat(consumer_price) || 0) : (prod.consumer_price || 0),
         location ?? prod.location ?? '', opening_price !== undefined ? (parseFloat(opening_price) || 0) : (prod.opening_price || 0),
         sms_code ?? prod.sms_code ?? '', req.params.id);
  if (whId) {
    db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)')
      .run(req.params.id, whId, parseInt(stock) || prod.stock || 0);
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
  const change = parseInt(stock) - prod.stock;
  db.prepare('UPDATE products SET stock=? WHERE id=?').run(parseInt(stock), req.params.id);
  db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)').run(req.params.id, req.user.id, change, note || '');
  res.json({ ok: true, new_stock: parseInt(stock) });
});

// Delete (admin only)
router.delete('/:id', auth, adminOnly, (req, res) => {
  const db = getDB();
  const prod = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!prod) return res.status(404).json({ error: 'یافت نشد' });
  if (prod.image) { try { fs.unlinkSync(path.join(UPLOAD_DIR, prod.image)); } catch (e) {} }
  db.prepare('DELETE FROM products WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'product', req.params.id, `حذف محصول ${prod.name}`);
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
        stmt.run(
          req.user.id,
          normalizeStr(row['دسته‌بندی'] || row['category'] || ''),
          normalizeStr(row['کد محصول'] || row['code'] || ''),
          name,
          parseFloat(row['قیمت'] || row['price'] || 0),
          parseInt(row['موجودی'] || row['stock'] || 0),
          parseInt(row['هشدار موجودی'] || row['stock_alert'] || 5),
          row['واحد'] || row['unit'] || 'عدد',
          parseInt(row['تعداد رنگ'] || row['colors'] || 1),
          parseInt(row['تعداد در پک'] || row['pack_size'] || 1),
          normalizeStr(row['بارکد'] || row['barcode'] || '') || null
        );
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
