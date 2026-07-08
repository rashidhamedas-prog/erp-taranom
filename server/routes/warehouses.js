const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');

// Multiple warehouses — each product belongs to exactly one warehouse
// (products.stock stays the single total, untouched by this module so every
// existing invoice/purchase/return code path keeps working unchanged).
// Receipt/Issue adjust total stock at a location; Transfer relocates a
// product's full current stock to a different warehouse. Splitting one
// product's stock across multiple warehouses isn't supported by this
// simplified model — a real per-warehouse quantity ledger would be a much
// larger change across every stock-adjusting route in the app.

// Stock overview — all warehouses with product quantities
router.get('/stock/overview', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const warehouses = db.prepare('SELECT * FROM warehouses WHERE active=1 ORDER BY name').all();
  const stockRows = db.prepare(`
    SELECT p.id, p.code, p.name, p.unit, p.warehouse_id, p.stock,
      ws.warehouse_id as ws_wh, ws.qty as ws_qty
    FROM products p
    LEFT JOIN warehouse_stock ws ON ws.product_id=p.id
    ORDER BY p.name
  `).all();
  const result = warehouses.map(w => {
    const products = [];
    const seen = new Set();
    for (const p of stockRows) {
      if (p.warehouse_id === w.id && !seen.has(p.id)) {
        products.push({ id: p.id, code: p.code, name: p.name, unit: p.unit, qty: p.stock || 0 });
        seen.add(p.id);
      }
      if (p.ws_wh === w.id) {
        const qty = p.ws_qty != null ? p.ws_qty : (p.warehouse_id === w.id ? p.stock : 0);
        if (!seen.has(p.id)) {
          products.push({ id: p.id, code: p.code, name: p.name, unit: p.unit, qty: qty || 0 });
          seen.add(p.id);
        }
      }
    }
    const totalQty = products.reduce((a, p) => a + (p.qty || 0), 0);
    return { ...w, product_count: products.length, total_qty: totalQty, products };
  });
  res.json(result);
});

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  res.json(db.prepare('SELECT * FROM warehouses ORDER BY name').all());
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const { name, address } = req.body;
  if (!name) return res.status(400).json({ error: 'نام انبار الزامی است' });
  const db = getDB();
  const result = db.prepare('INSERT INTO warehouses (name,address) VALUES (?,?)').run(name, address || '');
  audit(req.user.id, 'create', 'warehouse', result.lastInsertRowid, `ساخت انبار ${name}`);
  res.json(db.prepare('SELECT * FROM warehouses WHERE id=?').get(result.lastInsertRowid));
});

router.put('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM warehouses WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const { name, address, active } = req.body;
  db.prepare('UPDATE warehouses SET name=?,address=?,active=? WHERE id=?')
    .run(name || row.name, address ?? row.address, active != null ? (active ? 1 : 0) : row.active, req.params.id);
  audit(req.user.id, 'update', 'warehouse', req.params.id, `ویرایش انبار ${name || row.name}`);
  res.json({ ok: true });
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM warehouses WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const inUse = db.prepare('SELECT COUNT(*) c FROM products WHERE warehouse_id=?').get(req.params.id).c;
  if (inUse > 0) return res.status(400).json({ error: 'این انبار دارای کالا است و قابل حذف نیست — می‌توانید آن را غیرفعال کنید' });
  db.prepare('DELETE FROM warehouses WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'warehouse', req.params.id, `حذف انبار ${row.name}`);
  res.json({ ok: true });
});

// Products currently assigned to a warehouse (= "warehouse stock report")
router.get('/:id/stock', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare('SELECT id,code,name,stock,unit,stock_alert FROM products WHERE warehouse_id=? ORDER BY name').all(req.params.id);
  res.json(rows);
});

// ---- Warehouse movement history ----
router.get('/moves/list', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT m.*, p.name as product_name, p.code as product_code,
      fw.name as from_warehouse_name, tw.name as to_warehouse_name, u.name as recorder
    FROM warehouse_moves m
    LEFT JOIN products p ON m.product_id=p.id
    LEFT JOIN warehouses fw ON m.from_warehouse_id=fw.id
    LEFT JOIN warehouses tw ON m.to_warehouse_id=tw.id
    LEFT JOIN users u ON m.created_by=u.id
    ORDER BY m.created_at DESC LIMIT 300
  `).all();
  res.json(rows);
});

router.post('/moves/receipt', auth, adminOrAccounting, (req, res) => {
  const { product_id, warehouse_id, qty, date, note } = req.body;
  const q = parseInt(qty);
  if (!product_id || !warehouse_id || !q || q <= 0) return res.status(400).json({ error: 'کالا، انبار و تعداد معتبر الزامی است' });
  const db = getDB();
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
  if (!product) return res.status(404).json({ error: 'کالا یافت نشد' });
  const warehouse = db.prepare('SELECT * FROM warehouses WHERE id=?').get(warehouse_id);
  if (!warehouse) return res.status(404).json({ error: 'انبار یافت نشد' });
  db.prepare('UPDATE products SET stock=stock+?, warehouse_id=? WHERE id=?').run(q, warehouse_id, product_id);
  db.prepare(`
    INSERT INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)
    ON CONFLICT(product_id,warehouse_id) DO UPDATE SET qty=qty+?
  `).run(product_id, warehouse_id, q, q);
  db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)')
    .run(product_id, req.user.id, q, `رسید انبار (${warehouse.name})${note ? ' - ' + note : ''}`);
  const result = db.prepare('INSERT INTO warehouse_moves (type,product_id,to_warehouse_id,qty,date,note,created_by) VALUES (?,?,?,?,?,?,?)')
    .run('receipt', product_id, warehouse_id, q, date || todayJalali(), note || '', req.user.id);
  audit(req.user.id, 'create', 'warehouse_move', result.lastInsertRowid, `رسید انبار: ${q} عدد ${product.name} به ${warehouse.name}`);
  res.json({ id: result.lastInsertRowid, ok: true });
});

router.post('/moves/issue', auth, adminOrAccounting, (req, res) => {
  const { product_id, warehouse_id, qty, date, note } = req.body;
  const q = parseInt(qty);
  if (!product_id || !warehouse_id || !q || q <= 0) return res.status(400).json({ error: 'کالا، انبار و تعداد معتبر الزامی است' });
  const db = getDB();
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
  if (!product) return res.status(404).json({ error: 'کالا یافت نشد' });
  if (product.warehouse_id !== parseInt(warehouse_id)) return res.status(400).json({ error: 'این کالا در انبار انتخاب‌شده موجود نیست' });
  if (product.stock < q) return res.status(400).json({ error: `موجودی کافی نیست (موجود: ${product.stock})` });
  const warehouse = db.prepare('SELECT * FROM warehouses WHERE id=?').get(warehouse_id);
  db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(q, product_id);
  db.prepare(`
    UPDATE warehouse_stock SET qty=CASE WHEN qty-? < 0 THEN 0 ELSE qty-? END
    WHERE product_id=? AND warehouse_id=?
  `).run(q, q, product_id, warehouse_id);
  db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)')
    .run(product_id, req.user.id, -q, `حواله انبار (${warehouse.name})${note ? ' - ' + note : ''}`);
  const result = db.prepare('INSERT INTO warehouse_moves (type,product_id,from_warehouse_id,qty,date,note,created_by) VALUES (?,?,?,?,?,?,?)')
    .run('issue', product_id, warehouse_id, q, date || todayJalali(), note || '', req.user.id);
  audit(req.user.id, 'create', 'warehouse_move', result.lastInsertRowid, `حواله انبار: ${q} عدد ${product.name} از ${warehouse.name}`);
  res.json({ id: result.lastInsertRowid, ok: true });
});

router.post('/moves/transfer', auth, adminOrAccounting, (req, res) => {
  const { product_id, from_warehouse_id, to_warehouse_id, date, note } = req.body;
  if (!product_id || !from_warehouse_id || !to_warehouse_id) return res.status(400).json({ error: 'کالا، انبار مبدأ و مقصد الزامی است' });
  if (String(from_warehouse_id) === String(to_warehouse_id)) return res.status(400).json({ error: 'انبار مبدأ و مقصد نمی‌تواند یکسان باشد' });
  const db = getDB();
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
  if (!product) return res.status(404).json({ error: 'کالا یافت نشد' });
  if (product.warehouse_id !== parseInt(from_warehouse_id)) return res.status(400).json({ error: 'این کالا در انبار مبدأ انتخاب‌شده موجود نیست' });
  const toWarehouse = db.prepare('SELECT * FROM warehouses WHERE id=?').get(to_warehouse_id);
  if (!toWarehouse) return res.status(404).json({ error: 'انبار مقصد یافت نشد' });
  db.prepare('UPDATE products SET warehouse_id=? WHERE id=?').run(to_warehouse_id, product_id);
  const result = db.prepare('INSERT INTO warehouse_moves (type,product_id,from_warehouse_id,to_warehouse_id,qty,date,note,created_by) VALUES (?,?,?,?,?,?,?,?)')
    .run('transfer', product_id, from_warehouse_id, to_warehouse_id, product.stock, date || todayJalali(), note || '', req.user.id);
  audit(req.user.id, 'create', 'warehouse_move', result.lastInsertRowid, `انتقال کالا: ${product.name} به ${toWarehouse.name}`);
  res.json({ id: result.lastInsertRowid, ok: true });
});

module.exports = router;
