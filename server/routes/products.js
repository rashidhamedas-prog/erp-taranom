const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly, centralOnly } = require('../middleware/auth');
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
  if (category && category !== 'all') { where.push('category = ?'); params.push(category); }

  const search = (req.query.search || '').trim();
  if (search) {
    where.push('(name LIKE ? OR code LIKE ?)');
    params.push('%' + search + '%', '%' + search + '%');
  }

  const stockStatus = (req.query.stock_status || 'all').trim();
  if (stockStatus === 'low') where.push('stock <= stock_alert');
  else if (stockStatus === 'ok') where.push('stock > stock_alert');

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`SELECT * FROM products ${whereSql} ORDER BY created_at DESC`).all(...params);
  res.json(rows);
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

// Distinct categories (for filter dropdown)
router.get('/categories', auth, (req, res) => {
  const db = getDB();
  const rows = db.prepare("SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category<>'' ORDER BY category").all();
  res.json(rows.map(r => r.category));
});

// Create product (admin only) — multipart form-data for optional image
router.post('/', auth, adminOnly, upload.single('image'), async (req, res) => {
  const { category, code, name, price, cost, stock, stock_alert, unit, note, colors, pack_size } = req.body;
  if (!name) return res.status(400).json({ error: 'نام محصول الزامی است' });
  const db = getDB();
  let image = null;
  if (req.file) {
    try { image = await saveImage(req.file.buffer, req.file.originalname); } catch (e) { image = null; }
  }
  // New products default into the first warehouse so warehouse_id is never
  // null — Warehouse Transfer can relocate them afterward.
  const defaultWarehouse = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get();
  const result = db.prepare(
    'INSERT INTO products (user_id,category,code,name,price,cost,stock,stock_alert,unit,note,image,colors,pack_size,warehouse_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(req.user.id, category || '', code || '', name, parseFloat(price) || 0, parseFloat(cost) || 0, parseInt(stock) || 0,
        parseInt(stock_alert) || 5, unit || 'عدد', note || '', image,
        parseInt(colors) || 1, parseInt(pack_size) || 1, defaultWarehouse ? defaultWarehouse.id : null);
  audit(req.user.id, 'create', 'product', result.lastInsertRowid, `ساخت محصول ${name}`);
  res.json(db.prepare('SELECT * FROM products WHERE id=?').get(result.lastInsertRowid));
});

// Update product (admin only)
router.put('/:id', auth, adminOnly, upload.single('image'), async (req, res) => {
  const db = getDB();
  const prod = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!prod) return res.status(404).json({ error: 'یافت نشد' });
  const { category, code, name, price, cost, stock, stock_alert, unit, note, colors, pack_size } = req.body;
  let image = prod.image;
  if (req.file) {
    try {
      image = await saveImage(req.file.buffer, req.file.originalname);
      if (prod.image) { try { fs.unlinkSync(path.join(UPLOAD_DIR, prod.image)); } catch (e) {} }
    } catch (e) { image = prod.image; }
  }
  db.prepare('UPDATE products SET category=?,code=?,name=?,price=?,cost=?,stock=?,stock_alert=?,unit=?,note=?,image=?,colors=?,pack_size=? WHERE id=?')
    .run(category || '', code || '', name || prod.name, parseFloat(price) || 0,
         cost !== undefined ? (parseFloat(cost) || 0) : (prod.cost || 0), parseInt(stock) || 0,
         parseInt(stock_alert) || 5, unit || 'عدد', note || '', image,
         parseInt(colors) || prod.colors || 1, parseInt(pack_size) || prod.pack_size || 1,
         req.params.id);
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
    const stmt = db.prepare('INSERT INTO products (user_id,category,code,name,price,stock,stock_alert,unit,colors,pack_size) VALUES (?,?,?,?,?,?,?,?,?,?)');
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
          parseInt(row['تعداد در پک'] || row['pack_size'] || 1)
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
router.get('/export/excel', auth, (req, res) => {
  const db = getDB();
  const rows = db.prepare('SELECT * FROM products ORDER BY created_at DESC').all();
  const data = rows.map(r => ({
    'دسته‌بندی': r.category, 'کد محصول': r.code, 'نام محصول': r.name,
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
