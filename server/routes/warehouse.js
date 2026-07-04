const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly, warehouseAccess } = require('../middleware/auth');
const wms = require('../services/wms');

router.use(auth, warehouseAccess);

// List warehouses with headline stock stats
router.get('/', (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT w.*,
      (SELECT COUNT(*) FROM warehouse_stock ws WHERE ws.warehouse_id=w.id AND ws.qty>0) AS product_count,
      (SELECT COALESCE(SUM(ws.qty),0) FROM warehouse_stock ws WHERE ws.warehouse_id=w.id) AS total_qty
    FROM warehouses w WHERE w.tenant_id=? ORDER BY w.is_default DESC, w.id
  `).all(req.tenantId);
  res.json(rows);
});

// Create warehouse (admin only)
router.post('/', adminOnly, (req, res) => {
  const { name, address, type, is_default } = req.body || {};
  if (!name) return res.status(400).json({ error: 'نام انبار الزامی است' });
  const db = getDB();
  if (is_default) db.prepare('UPDATE warehouses SET is_default=0 WHERE tenant_id=?').run(req.tenantId);
  const r = db.prepare('INSERT INTO warehouses (tenant_id,name,address,type,is_default) VALUES (?,?,?,?,?)')
    .run(req.tenantId, name, address || '', type || 'other', is_default ? 1 : 0);
  audit(req.tenantId, req.user.id, 'create', 'warehouse', r.lastInsertRowid, `ایجاد انبار ${name}`, req.ip);
  res.json({ id: r.lastInsertRowid, ok: true });
});

// Update warehouse (admin only)
router.put('/:id', adminOnly, (req, res) => {
  const db = getDB();
  const wh = db.prepare('SELECT * FROM warehouses WHERE id=? AND tenant_id=?').get(req.params.id, req.tenantId);
  if (!wh) return res.status(404).json({ error: 'انبار یافت نشد' });
  const { name, address, type, is_default } = req.body || {};
  if (is_default) db.prepare('UPDATE warehouses SET is_default=0 WHERE tenant_id=?').run(req.tenantId);
  db.prepare('UPDATE warehouses SET name=COALESCE(?,name), address=COALESCE(?,address), type=COALESCE(?,type), is_default=COALESCE(?,is_default) WHERE id=? AND tenant_id=?')
    .run(name ?? null, address ?? null, type ?? null, is_default !== undefined ? (is_default ? 1 : 0) : null, req.params.id, req.tenantId);
  res.json({ ok: true });
});

// Per-warehouse stock listing
router.get('/:id/stock', (req, res) => {
  const db = getDB();
  const wh = db.prepare('SELECT * FROM warehouses WHERE id=? AND tenant_id=?').get(req.params.id, req.tenantId);
  if (!wh) return res.status(404).json({ error: 'انبار یافت نشد' });
  const rows = db.prepare(`
    SELECT ws.qty, p.id as product_id, p.name, p.code, p.barcode, p.category, p.unit, p.mac_cost, p.stock_alert,
           (ws.qty * p.mac_cost) as value
    FROM warehouse_stock ws JOIN products p ON ws.product_id=p.id
    WHERE ws.warehouse_id=? AND p.tenant_id=?
    ORDER BY p.name
  `).all(wh.id, req.tenantId);
  res.json({ warehouse: wh, rows, total_value: rows.reduce((a, r) => a + (r.value || 0), 0) });
});

// Goods receipt
router.post('/receipts', (req, res) => {
  const { warehouse_id, product_id, qty, unit_cost, ref, note, date } = req.body || {};
  if (!warehouse_id || !product_id || !qty) return res.status(400).json({ error: 'انبار، محصول و مقدار الزامی است' });
  const db = getDB();
  try {
    const result = wms.addReceipt(db, {
      tenantId: req.tenantId, warehouseId: warehouse_id, productId: product_id,
      qty, unitCost: unit_cost, ref: ref || 'purchase', note: note || '', date: date || '', userId: req.user.id,
    });
    audit(req.tenantId, req.user.id, 'create', 'warehouse_receipt', result.receiptId, `رسید ${qty} عدد کالای ${product_id}`, req.ip);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Goods issue (waste / internal consumption / manual sale)
router.post('/issues', (req, res) => {
  const { warehouse_id, product_id, qty, ref, note, date } = req.body || {};
  if (!warehouse_id || !product_id || !qty) return res.status(400).json({ error: 'انبار، محصول و مقدار الزامی است' });
  const allowed = ['sale', 'waste', 'internal'];
  const issueRef = allowed.includes(ref) ? ref : 'internal';
  const db = getDB();
  try {
    const result = wms.addIssue(db, {
      tenantId: req.tenantId, warehouseId: warehouse_id, productId: product_id,
      qty, ref: issueRef, note: note || '', date: date || '', userId: req.user.id,
    });
    audit(req.tenantId, req.user.id, 'create', 'warehouse_issue', result.issueId, `حواله ${qty} عدد کالای ${product_id} (${issueRef})`, req.ip);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Inter-warehouse transfer
router.post('/transfers', (req, res) => {
  const { from_warehouse_id, to_warehouse_id, product_id, qty, note, date } = req.body || {};
  if (!from_warehouse_id || !to_warehouse_id || !product_id || !qty) {
    return res.status(400).json({ error: 'انبار مبدأ/مقصد، محصول و مقدار الزامی است' });
  }
  const db = getDB();
  // both warehouses must belong to this tenant
  const src = db.prepare('SELECT id FROM warehouses WHERE id=? AND tenant_id=?').get(from_warehouse_id, req.tenantId);
  const dst = db.prepare('SELECT id FROM warehouses WHERE id=? AND tenant_id=?').get(to_warehouse_id, req.tenantId);
  if (!src || !dst) return res.status(404).json({ error: 'انبار یافت نشد' });
  try {
    const result = wms.transfer(db, {
      tenantId: req.tenantId, fromWarehouseId: from_warehouse_id, toWarehouseId: to_warehouse_id,
      productId: product_id, qty, note: note || '', date: date || '', userId: req.user.id,
    });
    audit(req.tenantId, req.user.id, 'create', 'warehouse_transfer', result.transferId, `انتقال ${qty} عدد کالای ${product_id} از انبار ${from_warehouse_id} به ${to_warehouse_id}`, req.ip);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Movements list (receipts + issues + transfers merged, newest first)
router.get('/movements', (req, res) => {
  const db = getDB();
  const limit = Math.min(300, parseInt(req.query.limit || '100'));
  const productFilter = req.query.product_id ? Number(req.query.product_id) : null;
  const pw = productFilter ? ' AND r.product_id=' + productFilter : '';
  const receipts = db.prepare(`
    SELECT 'receipt' as kind, r.id, r.date, r.qty, r.unit_cost, r.ref, r.note, r.created_at,
           p.name as product_name, w.name as warehouse_name, u.name as user_name
    FROM warehouse_receipts r
    JOIN products p ON r.product_id=p.id JOIN warehouses w ON r.warehouse_id=w.id
    LEFT JOIN users u ON r.created_by=u.id
    WHERE r.tenant_id=?${pw} ORDER BY r.created_at DESC LIMIT ?
  `).all(req.tenantId, limit);
  const iw = productFilter ? ' AND r.product_id=' + productFilter : '';
  const issues = db.prepare(`
    SELECT 'issue' as kind, r.id, r.date, r.qty, r.unit_cost, r.ref, r.note, r.created_at,
           p.name as product_name, w.name as warehouse_name, u.name as user_name
    FROM warehouse_issues r
    JOIN products p ON r.product_id=p.id JOIN warehouses w ON r.warehouse_id=w.id
    LEFT JOIN users u ON r.created_by=u.id
    WHERE r.tenant_id=?${iw} ORDER BY r.created_at DESC LIMIT ?
  `).all(req.tenantId, limit);
  const merged = [...receipts, ...issues].sort((a, b) => b.created_at - a.created_at).slice(0, limit);
  res.json(merged);
});

// Kardex: full movement history of one product with running balance
router.get('/kardex/:productId', (req, res) => {
  const db = getDB();
  const prod = db.prepare('SELECT * FROM products WHERE id=? AND tenant_id=?').get(req.params.productId, req.tenantId);
  if (!prod) return res.status(404).json({ error: 'محصول یافت نشد' });
  const receipts = db.prepare(`
    SELECT 'receipt' as kind, r.created_at, r.date, r.qty, r.unit_cost, r.ref, r.note, w.name as warehouse_name
    FROM warehouse_receipts r JOIN warehouses w ON r.warehouse_id=w.id
    WHERE r.tenant_id=? AND r.product_id=?
  `).all(req.tenantId, prod.id);
  const issues = db.prepare(`
    SELECT 'issue' as kind, r.created_at, r.date, -r.qty as qty, r.unit_cost, r.ref, r.note, w.name as warehouse_name
    FROM warehouse_issues r JOIN warehouses w ON r.warehouse_id=w.id
    WHERE r.tenant_id=? AND r.product_id=?
  `).all(req.tenantId, prod.id);
  const rows = [...receipts, ...issues].sort((a, b) => a.created_at - b.created_at);
  let balance = 0;
  rows.forEach(r => { balance += r.qty; r.balance = balance; });
  res.json({ product: { id: prod.id, name: prod.name, code: prod.code, unit: prod.unit, mac_cost: prod.mac_cost }, rows });
});

// Cost layers of one product (MAC audit trail)
router.get('/cost-layers/:productId', (req, res) => {
  const db = getDB();
  const prod = db.prepare('SELECT id,name,mac_cost FROM products WHERE id=? AND tenant_id=?').get(req.params.productId, req.tenantId);
  if (!prod) return res.status(404).json({ error: 'محصول یافت نشد' });
  const layers = db.prepare('SELECT * FROM inventory_cost_layers WHERE product_id=? ORDER BY created_at DESC LIMIT 100').all(prod.id);
  res.json({ product: prod, layers });
});

// Inventory valuation report at MAC (whole tenant, by product with per-warehouse breakdown)
router.get('/valuation-report', (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT p.id, p.name, p.code, p.category, p.unit, p.mac_cost, p.stock,
           (p.stock * p.mac_cost) as total_value
    FROM products p WHERE p.tenant_id=? AND p.stock > 0
    ORDER BY total_value DESC
  `).all(req.tenantId);
  const perWarehouse = db.prepare(`
    SELECT w.id as warehouse_id, w.name as warehouse_name,
           COALESCE(SUM(ws.qty * p.mac_cost),0) as value, COALESCE(SUM(ws.qty),0) as qty
    FROM warehouses w
    LEFT JOIN warehouse_stock ws ON ws.warehouse_id=w.id
    LEFT JOIN products p ON ws.product_id=p.id AND p.tenant_id=w.tenant_id
    WHERE w.tenant_id=?
    GROUP BY w.id
  `).all(req.tenantId);
  res.json({
    rows,
    perWarehouse,
    totalValue: rows.reduce((a, r) => a + (r.total_value || 0), 0),
  });
});

module.exports = router;
