const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth } = require('../middleware/auth');

function getScope(req) {
  if (req.user.role === 'admin' && req.query.user_id) return parseInt(req.query.user_id);
  if (req.user.role === 'admin') return null;
  return req.user.id;
}

// Deduct stock once, when an order becomes 'done' and references a product.
function maybeDeductStock(db, order) {
  if (order.status === 'done' && order.product_id && !order.stock_deducted && order.qty > 0) {
    const prod = db.prepare('SELECT * FROM products WHERE id=? AND tenant_id=?').get(order.product_id, order.tenant_id);
    if (prod) {
      const newStock = Math.max(0, prod.stock - order.qty);
      db.prepare('UPDATE products SET stock=? WHERE id=? AND tenant_id=?').run(newStock, prod.id, order.tenant_id);
      db.prepare('INSERT INTO stock_logs (tenant_id,product_id,user_id,change,note) VALUES (?,?,?,?,?)')
        .run(order.tenant_id, prod.id, order.user_id, -order.qty, `کسر از سفارش #${order.id}`);
      db.prepare('UPDATE orders SET stock_deducted=1 WHERE id=?').run(order.id);
    }
  }
}

router.get('/', auth, (req, res) => {
  const db = getDB();
  const scope = getScope(req);
  let rows;
  if (scope === null) {
    rows = db.prepare('SELECT o.*,c.biz as cust_biz,u.name as salesperson FROM orders o LEFT JOIN customers c ON o.cust_id=c.id LEFT JOIN users u ON o.user_id=u.id WHERE o.tenant_id=? ORDER BY o.created_at DESC').all(req.tenantId);
  } else {
    rows = db.prepare('SELECT o.*,c.biz as cust_biz FROM orders o LEFT JOIN customers c ON o.cust_id=c.id WHERE o.tenant_id=? AND o.user_id=? ORDER BY o.created_at DESC').all(req.tenantId, scope);
  }
  res.json(rows);
});

router.post('/', auth, (req, res) => {
  const { cust_id, product_id, date, type, qty, total, paid, pay, deliver, status, note } = req.body;
  if (!cust_id || !total) return res.status(400).json({ error: 'اطلاعات ناقص' });
  const db = getDB();
  const result = db.prepare(
    'INSERT INTO orders (tenant_id,user_id,cust_id,product_id,date,type,qty,total,paid,pay,deliver,status,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(req.tenantId, req.user.id, cust_id, product_id || null, date || '', type || '', qty || 0, total || 0, paid || 0, pay || 'نقد', deliver || '', status || 'pending', note || '');
  const order = db.prepare('SELECT * FROM orders WHERE id=? AND tenant_id=?').get(result.lastInsertRowid, req.tenantId);
  maybeDeductStock(db, order);
  const row = db.prepare('SELECT o.*,c.biz as cust_biz FROM orders o LEFT JOIN customers c ON o.cust_id=c.id WHERE o.id=? AND o.tenant_id=?').get(result.lastInsertRowid, req.tenantId);
  res.json(row);
});

router.put('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM orders WHERE id=? AND tenant_id=?').get(req.params.id, req.tenantId);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  const { cust_id, product_id, date, type, qty, total, paid, pay, deliver, status, note } = req.body;
  db.prepare('UPDATE orders SET cust_id=?,product_id=?,date=?,type=?,qty=?,total=?,paid=?,pay=?,deliver=?,status=?,note=? WHERE id=? AND tenant_id=?')
    .run(cust_id, product_id || null, date || '', type || '', qty || 0, total || 0, paid || 0, pay || 'نقد', deliver || '', status || 'pending', note || '', req.params.id, req.tenantId);
  const updated = db.prepare('SELECT * FROM orders WHERE id=? AND tenant_id=?').get(req.params.id, req.tenantId);
  maybeDeductStock(db, updated);
  res.json({ ok: true });
});

router.delete('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM orders WHERE id=? AND tenant_id=?').get(req.params.id, req.tenantId);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  db.prepare('DELETE FROM orders WHERE id=? AND tenant_id=?').run(req.params.id, req.tenantId);
  audit(req.tenantId, req.user.id, 'delete', 'order', req.params.id, `حذف سفارش #${req.params.id}`, req.ip);
  res.json({ ok: true });
});

module.exports = router;
