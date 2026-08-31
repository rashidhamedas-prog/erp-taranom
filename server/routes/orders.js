const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth } = require('../middleware/auth');
const { listQueryPlan, listResponse } = require('../lib/pagination');
const { createReservation, releaseReservation } = require('../lib/inventory/reservation');

function getScope(req) {
  if (req.user.role === 'admin' && req.query.user_id) return parseInt(req.query.user_id);
  if (req.user.role === 'admin') return null;
  return req.user.id;
}

// Deduct stock once, when an order becomes 'done' and references a product.
function maybeDeductStock(db, order) {
  if (order.status === 'done' && order.product_id && !order.stock_deducted && order.qty > 0) {
    const prod = db.prepare('SELECT * FROM products WHERE id=?').get(order.product_id);
    if (prod) {
      const newStock = Math.max(0, prod.stock - order.qty);
      db.prepare('UPDATE products SET stock=? WHERE id=?').run(newStock, prod.id);
      db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)')
        .run(prod.id, order.user_id, -order.qty, `کسر از سفارش #${order.id}`);
      db.prepare('UPDATE orders SET stock_deducted=1 WHERE id=?').run(order.id);
    }
  }
}

router.get('/', auth, (req, res) => {
  const db = getDB();
  const scope = getScope(req);
  const pq = listQueryPlan(req.query);
  const where = scope === null ? '' : 'WHERE o.user_id=?';
  const params = scope === null ? [] : [scope];
  const total = pq.paginate
    ? (db.prepare(`SELECT COUNT(*) AS c FROM orders o ${where}`).get(...params)?.c || 0)
    : 0;
  const select = scope === null
    ? 'SELECT o.*,c.biz as cust_biz,u.name as salesperson FROM orders o LEFT JOIN customers c ON o.cust_id=c.id LEFT JOIN users u ON o.user_id=u.id'
    : 'SELECT o.*,c.biz as cust_biz FROM orders o LEFT JOIN customers c ON o.cust_id=c.id';
  const rows = db.prepare(`${select} ${where} ORDER BY o.created_at DESC${pq.limitSql}`).all(...params, ...pq.limitParams);
  res.json(listResponse(rows, { page: pq.page, pageSize: pq.pageSize, total: pq.paginate ? total : rows.length }, req.query));
});

router.post('/', auth, (req, res) => {
  const { cust_id, product_id, date, type, qty, total, paid, pay, deliver, status, note, warehouse_id } = req.body;
  if (!cust_id || !total) return res.status(400).json({ error: 'اطلاعات ناقص' });
  const db = getDB();
  try {
    const saved = db.transaction(() => {
      const result = db.prepare(
        'INSERT INTO orders (user_id,cust_id,product_id,date,type,qty,total,paid,pay,deliver,status,note,warehouse_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(req.user.id, cust_id, product_id || null, date || '', type || '', qty || 0, total || 0, paid || 0, pay || 'نقد', deliver || '', status || 'pending', note || '', warehouse_id || null);
      const order = db.prepare('SELECT * FROM orders WHERE id=?').get(result.lastInsertRowid);
      maybeDeductStock(db, order);
      if (order.product_id && Number(order.qty) > 0 && order.status !== 'cancel') {
        const prod = db.prepare('SELECT warehouse_id FROM products WHERE id=?').get(order.product_id);
        const wh = order.warehouse_id || prod?.warehouse_id || null;
        const rsv = createReservation(db, {
          kind: 'sales',
          productId: order.product_id,
          warehouseId: wh,
          qty: Number(order.qty),
          sourceType: 'order',
          sourceId: order.id,
          note: `رزرو سفارش #${order.id}`,
          createdBy: req.user.id,
        });
        db.prepare('UPDATE orders SET reservation_id=?, warehouse_id=? WHERE id=?').run(rsv.id, wh, order.id);
      }
      return db.prepare('SELECT o.*,c.biz as cust_biz FROM orders o LEFT JOIN customers c ON o.cust_id=c.id WHERE o.id=?').get(order.id);
    })();
    res.json(saved);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message || String(e), code: e.code });
  }
});

router.put('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  const { cust_id, product_id, date, type, qty, total, paid, pay, deliver, status, note } = req.body;
  db.prepare('UPDATE orders SET cust_id=?,product_id=?,date=?,type=?,qty=?,total=?,paid=?,pay=?,deliver=?,status=?,note=? WHERE id=?')
    .run(cust_id, product_id || null, date || '', type || '', qty || 0, total || 0, paid || 0, pay || 'نقد', deliver || '', status || 'pending', note || '', req.params.id);
  const updated = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  maybeDeductStock(db, updated);
  res.json({ ok: true });
});

router.delete('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  db.transaction(() => {
    if (row.reservation_id) {
      try { releaseReservation(db, row.reservation_id); } catch (_) { /* already released */ }
    }
    db.prepare('DELETE FROM orders WHERE id=?').run(req.params.id);
  })();
  audit(req.user.id, 'delete', 'order', req.params.id, `حذف سفارش #${req.params.id}`);
  res.json({ ok: true });
});

module.exports = router;
