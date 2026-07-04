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
  ).run(req.tenantId, req.user.id, category || '', code || '', name, parseFloat(price) || 0, parseFloat(cost) || 0, parseFloat(cost) || 0, parseInt(stock) || 0,
        parseInt(stock_alert) || 5, unit || 'عدد', note || '', image,
        parseInt(colors) || 1, parseInt(pack_size) || 1, (barcode || '').trim() || null);
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
  db.prepare('UPDATE products SET category=?,code=?,name=?,price=?,cost=?,stock=?,stock_alert=?,unit=?,note=?,image=?,colors=?,pack_size=?,barcode=? WHERE id=? AND tenant_id=?')
    .run(category || '', code || '', name || prod.name, parseFloat(price) || 0,
         cost !== undefined ? (parseFloat(cost) || 0) : (prod.cost || 0), parseInt(stock) || 0,
         parseInt(stock_alert) || 5, unit || 'عدد', note || '', image,
         parseInt(colors) || prod.colors || 1, parseInt(pack_size) || prod.pack_size || 1,
         barcode !== undefined ? ((barcode || '').trim() || null) : prod.barcode,
         req.params.id, req.tenantId);
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
  const change = parseInt(stock) - prod.stock;
  db.prepare('UPDATE products SET stock=? WHERE id=? AND tenant_id=?').run(parseInt(stock), req.params.id, req.tenantId);
  db.prepare('INSERT INTO stock_logs (tenant_id,product_id,user_id,change,note) VALUES (?,?,?,?,?)').run(req.tenantId, req.params.id, req.user.id, change, note || '');
  res.json({ ok: true, new_stock: parseInt(stock) });
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
    const stmt = db.prepare('INSERT INTO products (tenant_id,user_id,category,code,name,price,stock,stock_alert,unit,colors,pack_size,barcode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    const insertMany = db.transaction((rows) => {
      for (const row of rows) {
        const name = normalizeStr(row['نام محصول'] || row['name'] || row['Name'] || '');
        if (!name) continue;
        stmt.run(
          req.tenantId,
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
