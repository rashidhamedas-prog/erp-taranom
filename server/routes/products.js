const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const XLSX = require('xlsx');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

let sharp = null;
try { sharp = require('sharp'); } catch (e) { /* optional — falls back to raw storage */ }

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'products');
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

// EAN-13 style internal barcode: prefix 200 (in-store use) + tenant(3) + product id(5) + check digit
function generateBarcode(tenantId, productId) {
  const base = '200' + String(tenantId % 1000).padStart(3, '0') + String(productId % 100000).padStart(6, '0');
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return base + check;
}

// GET / — all products of the tenant, every authenticated user can read.
// Filtering: ?category=&search=&stock_status=low|ok|all
router.get('/', auth, (req, res) => {
  const db = getDB();
  const where = ['tenant_id = ?'];
  const params = [req.tenantId];

  const category = (req.query.category || '').trim();
  if (category && category !== 'all') { where.push('category = ?'); params.push(category); }

  const search = (req.query.search || '').trim();
  if (search) {
    where.push('(name LIKE ? OR code LIKE ? OR barcode LIKE ?)');
    params.push('%' + search + '%', '%' + search + '%', '%' + search + '%');
  }

  const stockStatus = (req.query.stock_status || 'all').trim();
  if (stockStatus === 'low') where.push('stock <= stock_alert');
  else if (stockStatus === 'ok') where.push('stock > stock_alert');

  const rows = db.prepare(`SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY created_at DESC`).all(...params);
  res.json(rows);
});

// Distinct categories (for filter dropdown)
router.get('/categories', auth, (req, res) => {
  const db = getDB();
  const rows = db.prepare("SELECT DISTINCT category FROM products WHERE tenant_id=? AND category IS NOT NULL AND category<>'' ORDER BY category").all(req.tenantId);
  res.json(rows.map(r => r.category));
});

// Lookup by barcode or product code — used by the invoice builder / WMS camera scanner
router.get('/by-barcode/:code', auth, (req, res) => {
  const db = getDB();
  const code = String(req.params.code || '').trim();
  if (!code) return res.status(400).json({ error: 'کد الزامی است' });
  const row = db.prepare('SELECT * FROM products WHERE tenant_id=? AND (barcode=? OR code=?)').get(req.tenantId, code, code);
  if (!row) return res.status(404).json({ error: 'محصولی با این بارکد یافت نشد' });
  res.json(row);
});

// Generate a barcode for a product that lacks one (admin only)
router.post('/:id/generate-barcode', auth, adminOnly, (req, res) => {
  const db = getDB();
  const prod = db.prepare('SELECT * FROM products WHERE id=? AND tenant_id=?').get(req.params.id, req.tenantId);
  if (!prod) return res.status(404).json({ error: 'یافت نشد' });
  if (prod.barcode) return res.json({ ok: true, barcode: prod.barcode, existed: true });
  const barcode = generateBarcode(req.tenantId, prod.id);
  db.prepare('UPDATE products SET barcode=? WHERE id=? AND tenant_id=?').run(barcode, prod.id, req.tenantId);
  audit(req.tenantId, req.user.id, 'generate_barcode', 'product', prod.id, `تولید بارکد ${barcode} برای ${prod.name}`, req.ip);
  res.json({ ok: true, barcode });
});

// Printable barcode label page (single product or all barcoded products with ?all=1)
router.get('/:id/label', auth, (req, res) => {
  const db = getDB();
  const count = Math.min(50, Math.max(1, parseInt(req.query.count || '1')));
  const prod = db.prepare('SELECT * FROM products WHERE id=? AND tenant_id=?').get(req.params.id, req.tenantId);
  if (!prod) return res.status(404).send('محصول یافت نشد');
  if (!prod.barcode) return res.status(400).send('این محصول بارکد ندارد — ابتدا بارکد تولید کنید');
  const labels = Array.from({ length: count }, () => `
    <div class="label">
      <div class="name">${(prod.name || '').replace(/</g, '&lt;')}</div>
      <svg class="bc" data-code="${prod.barcode}"></svg>
      <div class="meta">${prod.code || ''} — ${Number(prod.price || 0).toLocaleString('fa-IR')} تومان</div>
    </div>`).join('');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="UTF-8">
<title>برچسب ${prod.name}</title>
<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:'Vazirmatn',sans-serif}
body{padding:16px;display:flex;flex-wrap:wrap;gap:8px}
.label{width:58mm;height:40mm;border:1px dashed #bbb;border-radius:4px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:4px;page-break-inside:avoid}
.name{font-size:11px;font-weight:700;text-align:center;max-height:28px;overflow:hidden}
.bc{width:52mm;height:18mm}
.meta{font-size:10px;color:#444}
.pbtn{position:fixed;bottom:14px;left:14px;background:#1A5C38;color:#fff;border:none;padding:10px 26px;border-radius:8px;font-family:inherit;font-size:14px;cursor:pointer}
@media print{.pbtn{display:none}.label{border-color:transparent}}
</style></head><body>
${labels}
<button class="pbtn" onclick="window.print()">چاپ 🖨️</button>
<script>
document.querySelectorAll('svg.bc').forEach(el=>{
  const code = el.dataset.code;
  const fmt = /^\\d{13}$/.test(code) ? 'EAN13' : 'CODE128';
  try { JsBarcode(el, code, { format: fmt, height: 44, fontSize: 13, margin: 0 }); }
  catch(e) { JsBarcode(el, code, { format: 'CODE128', height: 44, fontSize: 13, margin: 0 }); }
});
</script>
</body></html>`);
});

// Bring the WMS default-warehouse quantity in line with a directly-set stock value.
// Positive delta → adjustment receipt at the given cost; negative → adjustment issue.
function syncWmsToStock(db, tenantId, productId, targetStock, unitCost, userId, note) {
  const wms = require('../services/wms');
  const wh = wms.getDefaultWarehouse(db, tenantId);
  if (!wh) return; // no warehouse yet — startup bootstrap will pick it up
  const cur = db.prepare('SELECT COALESCE(SUM(qty),0) s FROM warehouse_stock ws JOIN warehouses w ON ws.warehouse_id=w.id WHERE w.tenant_id=? AND ws.product_id=?').get(tenantId, productId).s;
  const delta = (parseInt(targetStock) || 0) - cur;
  if (delta > 0) {
    wms.addReceipt(db, { tenantId, warehouseId: wh.id, productId, qty: delta, unitCost: unitCost || 0, ref: 'adjustment', note: note || 'تنظیم دستی موجودی', userId });
  } else if (delta < 0) {
    wms.addIssue(db, { tenantId, warehouseId: wh.id, productId, qty: -delta, ref: 'adjustment', note: note || 'تنظیم دستی موجودی', userId, allowNegative: true });
  }
}

// Create product (admin only) — multipart form-data for optional image
router.post('/', auth, adminOnly, upload.single('image'), async (req, res) => {
  const { category, code, name, price, cost, stock, stock_alert, unit, note, colors, pack_size, barcode } = req.body;
  if (!name) return res.status(400).json({ error: 'نام محصول الزامی است' });
  const db = getDB();
  let image = null;
  if (req.file) {
    try { image = await saveImage(req.file.buffer, req.file.originalname); } catch (e) { image = null; }
  }
  const result = db.prepare(
    'INSERT INTO products (tenant_id,user_id,category,code,name,price,cost,mac_cost,stock,stock_alert,unit,note,image,colors,pack_size,barcode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(req.tenantId, req.user.id, category || '', code || '', name, parseFloat(price) || 0, parseFloat(cost) || 0, parseFloat(cost) || 0, 0,
        parseInt(stock_alert) || 5, unit || 'عدد', note || '', image,
        parseInt(colors) || 1, parseInt(pack_size) || 1, (barcode || '').trim() || null);
  // Initial stock enters through a WMS receipt so warehouse totals, MAC and journals stay consistent
  const initialStock = parseInt(stock) || 0;
  if (initialStock > 0) {
    try { syncWmsToStock(db, req.tenantId, result.lastInsertRowid, initialStock, parseFloat(cost) || 0, req.user.id, 'موجودی اولیه محصول'); }
    catch (e) { console.error('initial stock receipt error:', e.message); }
  }
  audit(req.tenantId, req.user.id, 'create', 'product', result.lastInsertRowid, `ساخت محصول ${name}`, req.ip);
  res.json(db.prepare('SELECT * FROM products WHERE id=?').get(result.lastInsertRowid));
});

// Update product (admin only)
router.put('/:id', auth, adminOnly, upload.single('image'), async (req, res) => {
  const db = getDB();
  const prod = db.prepare('SELECT * FROM products WHERE id=? AND tenant_id=?').get(req.params.id, req.tenantId);
  if (!prod) return res.status(404).json({ error: 'یافت نشد' });
  const { category, code, name, price, cost, stock, stock_alert, unit, note, colors, pack_size, barcode } = req.body;
  let image = prod.image;
  if (req.file) {
    try {
      image = await saveImage(req.file.buffer, req.file.originalname);
      if (prod.image) { try { fs.unlinkSync(path.join(UPLOAD_DIR, prod.image)); } catch (e) {} }
    } catch (e) { image = prod.image; }
  }
  db.prepare('UPDATE products SET category=?,code=?,name=?,price=?,cost=?,stock_alert=?,unit=?,note=?,image=?,colors=?,pack_size=?,barcode=? WHERE id=? AND tenant_id=?')
    .run(category || '', code || '', name || prod.name, parseFloat(price) || 0,
         cost !== undefined ? (parseFloat(cost) || 0) : (prod.cost || 0),
         parseInt(stock_alert) || 5, unit || 'عدد', note || '', image,
         parseInt(colors) || prod.colors || 1, parseInt(pack_size) || prod.pack_size || 1,
         barcode !== undefined ? ((barcode || '').trim() || null) : prod.barcode,
         req.params.id, req.tenantId);
  // Direct stock edits flow through WMS as adjustment receipt/issue (keeps products.stock in sync)
  if (stock !== undefined && parseInt(stock) !== prod.stock) {
    try { syncWmsToStock(db, req.tenantId, prod.id, parseInt(stock) || 0, parseFloat(cost) || prod.mac_cost || prod.cost || 0, req.user.id, 'ویرایش موجودی از فرم محصول'); }
    catch (e) { console.error('stock sync error:', e.message); }
  }
  audit(req.tenantId, req.user.id, 'update', 'product', req.params.id, `ویرایش محصول ${name || prod.name}`, req.ip);
  res.json(db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id));
});

// Update stock (admin only)
router.patch('/:id/stock', auth, adminOnly, (req, res) => {
  const { stock, note } = req.body;
  if (stock === undefined) return res.status(400).json({ error: 'موجودی الزامی است' });
  const db = getDB();
  const prod = db.prepare('SELECT * FROM products WHERE id=? AND tenant_id=?').get(req.params.id, req.tenantId);
  if (!prod) return res.status(404).json({ error: 'یافت نشد' });
  try {
    syncWmsToStock(db, req.tenantId, prod.id, parseInt(stock) || 0, prod.mac_cost || prod.cost || 0, req.user.id, note || 'تنظیم موجودی');
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const updated = db.prepare('SELECT stock FROM products WHERE id=? AND tenant_id=?').get(req.params.id, req.tenantId);
  res.json({ ok: true, new_stock: updated.stock });
});

// Delete (admin only)
router.delete('/:id', auth, adminOnly, (req, res) => {
  const db = getDB();
  const prod = db.prepare('SELECT * FROM products WHERE id=? AND tenant_id=?').get(req.params.id, req.tenantId);
  if (!prod) return res.status(404).json({ error: 'یافت نشد' });
  if (prod.image) { try { fs.unlinkSync(path.join(UPLOAD_DIR, prod.image)); } catch (e) {} }
  db.prepare('DELETE FROM products WHERE id=? AND tenant_id=?').run(req.params.id, req.tenantId);
  audit(req.tenantId, req.user.id, 'delete', 'product', req.params.id, `حذف محصول ${prod.name}`, req.ip);
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
    const stmt = db.prepare('INSERT INTO products (tenant_id,user_id,category,code,name,price,cost,mac_cost,stock,stock_alert,unit,colors,pack_size,barcode) VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?)');
    const insertMany = db.transaction((rows) => {
      for (const row of rows) {
        const name = normalizeStr(row['نام محصول'] || row['name'] || row['Name'] || '');
        if (!name) continue;
        const cost = parseFloat(row['بهای تمام‌شده'] || row['cost'] || 0) || 0;
        const r = stmt.run(
          req.tenantId,
          req.user.id,
          normalizeStr(row['دسته‌بندی'] || row['category'] || ''),
          normalizeStr(row['کد محصول'] || row['code'] || ''),
          name,
          parseFloat(row['قیمت'] || row['price'] || 0),
          cost, cost,
          parseInt(row['هشدار موجودی'] || row['stock_alert'] || 5),
          row['واحد'] || row['unit'] || 'عدد',
          parseInt(row['تعداد رنگ'] || row['colors'] || 1),
          parseInt(row['تعداد در پک'] || row['pack_size'] || 1),
          normalizeStr(row['بارکد'] || row['barcode'] || '') || null
        );
        // Imported opening stock goes through a WMS receipt (warehouse totals + cost layers)
        const importStock = parseInt(row['موجودی'] || row['stock'] || 0) || 0;
        if (importStock > 0) {
          syncWmsToStock(db, req.tenantId, r.lastInsertRowid, importStock, cost, req.user.id, 'ورود از اکسل');
        }
        inserted++;
      }
    });
    insertMany(data);
    audit(req.tenantId, req.user.id, 'import', 'product', null, `ورود ${inserted} محصول از اکسل`, req.ip);
    res.json({ ok: true, inserted });
  } catch (e) {
    res.status(400).json({ error: 'خطا در خواندن فایل: ' + e.message });
  }
});

// Export all products
router.get('/export/excel', auth, (req, res) => {
  const db = getDB();
  const rows = db.prepare('SELECT * FROM products WHERE tenant_id=? ORDER BY created_at DESC').all(req.tenantId);
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
    { 'دسته‌بندی': 'مانتو', 'کد محصول': 'MT-001', 'بارکد': '', 'نام محصول': 'مانتو لینن بهاره', 'قیمت': 350000, 'موجودی': 50, 'هشدار موجودی': 5, 'واحد': 'عدد' },
    { 'دسته‌بندی': 'شومیز', 'کد محصول': 'SH-001', 'بارکد': '', 'نام محصول': 'شومیز کتان', 'قیمت': 280000, 'موجودی': 30, 'هشدار موجودی': 5, 'واحد': 'عدد' },
  ];
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'محصولات');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=products-template.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

module.exports = router;
