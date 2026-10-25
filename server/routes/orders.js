const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, requirePermission } = require('../middleware/auth');
const { listQueryPlan, listResponse } = require('../lib/pagination');
const {
  createReservation, releaseReservation, releaseBySource,
} = require('../lib/inventory/reservation');

function ensureOrdersWarehouseCols(db) {
  const cols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  if (!cols.includes('warehouse_id')) db.exec('ALTER TABLE orders ADD COLUMN warehouse_id INTEGER');
  if (!cols.includes('reservation_id')) db.exec('ALTER TABLE orders ADD COLUMN reservation_id INTEGER');
}

function getScope(req) {
  if (req.user.role === 'admin' && req.query.user_id) return parseInt(req.query.user_id);
  if (req.user.role === 'admin') return null;
  return req.user.id;
}

// Legacy header-only deduct desynced warehouse_stock / inventory_ledger.
// Firm stock moves belong to invoices; orders only soft-reserve.
function maybeDeductStock() { /* no-op — see CHANGE-LOG warehouse audit v305 */ }

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

router.post('/', auth, requirePermission('orders', 'create'), (req, res) => {
  const { cust_id, product_id, date, type, qty, total, paid, pay, deliver, status, note, warehouse_id } = req.body;
  if (!cust_id || !total) return res.status(400).json({ error: 'اطلاعات ناقص' });
  const db = getDB();
  try {
    ensureOrdersWarehouseCols(db);
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
  try {
    ensureOrdersWarehouseCols(db);
    db.transaction(() => {
      const nextStatus = status || 'pending';
      db.prepare('UPDATE orders SET cust_id=?,product_id=?,date=?,type=?,qty=?,total=?,paid=?,pay=?,deliver=?,status=?,note=? WHERE id=?')
        .run(cust_id, product_id || null, date || '', type || '', qty || 0, total || 0, paid || 0, pay || 'نقد', deliver || '', nextStatus, note || '', req.params.id);
      if (nextStatus === 'cancel' || nextStatus === 'cancelled') {
        if (row.reservation_id) {
          try { releaseReservation(db, row.reservation_id); } catch (_) { /* already */ }
        } else {
          releaseBySource(db, 'order', row.id);
        }
      } else if (row.reservation_id && Number(qty) !== Number(row.qty) && Number(qty) > 0) {
        try { releaseReservation(db, row.reservation_id); } catch (_) {}
        const prod = db.prepare('SELECT warehouse_id FROM products WHERE id=?').get(product_id || row.product_id);
        const wh = row.warehouse_id || prod?.warehouse_id || null;
        const rsv = createReservation(db, {
          kind: 'sales',
          productId: product_id || row.product_id,
          warehouseId: wh,
          qty: Number(qty),
          sourceType: 'order',
          sourceId: row.id,
          note: `رزرو سفارش #${row.id} (ویرایش)`,
          createdBy: req.user.id,
        });
        db.prepare('UPDATE orders SET reservation_id=? WHERE id=?').run(rsv.id, row.id);
      }
    })();
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message || String(e), code: e.code });
  }
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
