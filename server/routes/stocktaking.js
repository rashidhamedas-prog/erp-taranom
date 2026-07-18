const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');
const { warehouseQty } = require('../lib/inventory/ledger');
const { applyCycleCount } = require('../lib/inventory/cycle-count');

function productsForWarehouse(db, warehouseId) {
  const rows = db.prepare(`
    SELECT p.id, p.code, p.name, p.unit, p.stock, p.warehouse_id,
      COALESCE(ws.qty, CASE WHEN p.warehouse_id=? THEN p.stock ELSE 0 END) as wh_qty
    FROM products p
    LEFT JOIN warehouse_stock ws ON ws.product_id=p.id AND ws.warehouse_id=?
    WHERE p.warehouse_id=? OR ws.warehouse_id=? OR ws.qty IS NOT NULL
    ORDER BY p.name
  `).all(warehouseId, warehouseId, warehouseId, warehouseId);
  const seen = new Set();
  return rows.filter(r => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return (r.warehouse_id === parseInt(warehouseId, 10)) || (r.wh_qty != null && r.wh_qty > 0);
  }).map(r => ({
    product_id: r.id,
    code: r.code,
    name: r.name,
    unit: r.unit,
    system_qty: r.wh_qty != null ? r.wh_qty : (r.warehouse_id === parseInt(warehouseId, 10) ? (r.stock || 0) : 0)
  }));
}

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { warehouse_id, user_id, date_from, date_to, status } = req.query;
  const where = [];
  const params = [];
  if (warehouse_id) { where.push('s.warehouse_id=?'); params.push(parseInt(warehouse_id, 10)); }
  if (user_id) { where.push('s.responsible_user_id=?'); params.push(parseInt(user_id, 10)); }
  if (status) { where.push('s.status=?'); params.push(status); }
  if (date_from) { where.push('s.date >= ?'); params.push(date_from); }
  if (date_to) { where.push('s.date <= ?'); params.push(date_to); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT s.*, w.name as warehouse_name, u.name as responsible_name, c.name as creator_name
    FROM stocktaking_sessions s
    LEFT JOIN warehouses w ON s.warehouse_id=w.id
    LEFT JOIN users u ON s.responsible_user_id=u.id
    LEFT JOIN users c ON s.created_by=c.id
    ${whereSql}
    ORDER BY s.created_at DESC LIMIT 200
  `).all(...params);
  res.json(rows);
});

router.get('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const session = db.prepare(`
    SELECT s.*, w.name as warehouse_name, u.name as responsible_name
    FROM stocktaking_sessions s
    LEFT JOIN warehouses w ON s.warehouse_id=w.id
    LEFT JOIN users u ON s.responsible_user_id=u.id
    WHERE s.id=?
  `).get(req.params.id);
  if (!session) return res.status(404).json({ error: 'یافت نشد' });
  const items = db.prepare(`
    SELECT i.*, p.code, p.name, p.unit
    FROM stocktaking_items i
    JOIN products p ON i.product_id=p.id
    WHERE i.session_id=?
    ORDER BY p.name
  `).all(session.id);
  items.forEach(it => { it.variance = (it.counted_qty || 0) - (it.system_qty || 0); });
  res.json({ session, items });
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const { warehouse_id, date, responsible_user_id, note } = req.body;
  const whId = parseInt(warehouse_id, 10);
  if (!whId) return res.status(400).json({ error: 'انبار الزامی است' });
  const db = getDB();
  const wh = db.prepare('SELECT id FROM warehouses WHERE id=?').get(whId);
  if (!wh) return res.status(404).json({ error: 'انبار یافت نشد' });
  const result = db.prepare(`
    INSERT INTO stocktaking_sessions (warehouse_id,date,responsible_user_id,note,status,created_by)
    VALUES (?,?,?,?,'draft',?)
  `).run(whId, date || todayJalali(), responsible_user_id ? parseInt(responsible_user_id, 10) : req.user.id, note || '', req.user.id);
  const sessionId = result.lastInsertRowid;
  const prods = productsForWarehouse(db, whId);
  const ins = db.prepare('INSERT INTO stocktaking_items (session_id,product_id,system_qty,counted_qty) VALUES (?,?,?,?)');
  for (const p of prods) ins.run(sessionId, p.product_id, p.system_qty, p.system_qty);
  audit(req.user.id, 'create', 'stocktaking', sessionId, `شروع انبارگردانی انبار #${whId}`);
  res.json({ id: sessionId, item_count: prods.length });
});

router.put('/:id/items', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const session = db.prepare('SELECT * FROM stocktaking_sessions WHERE id=?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'یافت نشد' });
  if (session.status === 'adjusted') return res.status(400).json({ error: 'این انبارگردانی قبلاً اعمال شده است' });
  const items = req.body.items || [];
  const upd = db.prepare('UPDATE stocktaking_items SET counted_qty=? WHERE id=? AND session_id=?');
  db.transaction(() => {
    for (const it of items) {
      if (!it.id) continue;
      upd.run(Math.max(0, parseInt(it.counted_qty, 10) || 0), it.id, session.id);
    }
  })();
  res.json({ ok: true });
});

router.post('/:id/complete', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const session = db.prepare('SELECT * FROM stocktaking_sessions WHERE id=?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'یافت نشد' });
  if (session.status === 'adjusted') return res.status(400).json({ error: 'قبلاً اعمال شده' });
  db.prepare("UPDATE stocktaking_sessions SET status='completed' WHERE id=?").run(session.id);
  audit(req.user.id, 'update', 'stocktaking', session.id, 'تکمیل انبارگردانی');
  res.json({ ok: true });
});

router.post('/:id/apply', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const result = applyCycleCount(db, +req.params.id, { createdBy: req.user.id });
    audit(req.user.id, 'approve', 'stocktaking', req.params.id, 'اعمال اصلاحات انبارگردانی');
    res.json(result);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const session = db.prepare('SELECT * FROM stocktaking_sessions WHERE id=?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'یافت نشد' });
  if (session.status === 'adjusted') return res.status(400).json({ error: 'انبارگردانی اعمال‌شده قابل حذف نیست' });
  db.prepare('DELETE FROM stocktaking_items WHERE session_id=?').run(session.id);
  db.prepare('DELETE FROM stocktaking_sessions WHERE id=?').run(session.id);
  audit(req.user.id, 'delete', 'stocktaking', session.id, 'حذف انبارگردانی');
  res.json({ ok: true });
});

module.exports = router;
