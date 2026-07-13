const router = require('express').Router();
const { getDB, audit, createJournalEntry } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');

function warehouseQty(db, productId, warehouseId) {
  const ws = db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(productId, warehouseId);
  if (ws && ws.qty != null) return ws.qty;
  const p = db.prepare('SELECT warehouse_id, stock FROM products WHERE id=?').get(productId);
  if (p && p.warehouse_id === parseInt(warehouseId, 10)) return p.stock || 0;
  return 0;
}

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
  const db = getDB();
  const session = db.prepare('SELECT * FROM stocktaking_sessions WHERE id=?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'یافت نشد' });
  if (session.status === 'adjusted') return res.status(400).json({ error: 'قبلاً اعمال شده' });
  const items = db.prepare('SELECT * FROM stocktaking_items WHERE session_id=?').all(session.id);
  let totalGain = 0, totalLoss = 0;
  db.transaction(() => {
    for (const it of items) {
      const counted = Math.max(0, parseInt(it.counted_qty, 10) || 0);
      const system = it.system_qty || 0;
      const diff = counted - system;
      db.prepare(`
        INSERT INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)
        ON CONFLICT(product_id,warehouse_id) DO UPDATE SET qty=?
      `).run(it.product_id, session.warehouse_id, counted, counted);
      const prod = db.prepare('SELECT warehouse_id, stock, cost, name FROM products WHERE id=?').get(it.product_id);
      if (prod && prod.warehouse_id === session.warehouse_id) {
        db.prepare('UPDATE products SET stock=? WHERE id=?').run(counted, it.product_id);
      } else if (diff !== 0) {
        db.prepare('UPDATE products SET stock=MAX(0, stock+?) WHERE id=?').run(diff, it.product_id);
      }
      if (diff !== 0) {
        db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)')
          .run(it.product_id, req.user.id, diff, `انبارگردانی #${session.id}`);
        const val = Math.abs(diff) * (prod?.cost || 0);
        if (diff > 0) totalGain += val; else totalLoss += val;
      }
    }
    if (totalGain > 0 || totalLoss > 0) {
      const lines = [];
      if (totalGain > 0) {
        lines.push({ code: '1101', name: 'موجودی کالا', debit: totalGain, credit: 0, description: 'انبارگردانی — اضافه' });
        lines.push({ code: '5101', name: 'تعدیلات انبارگردانی', debit: 0, credit: totalGain, description: 'انبارگردانی' });
      }
      if (totalLoss > 0) {
        lines.push({ code: '5101', name: 'تعدیلات انبارگردانی', debit: totalLoss, credit: 0, description: 'انبارگردانی — کسری' });
        lines.push({ code: '1101', name: 'موجودی کالا', debit: 0, credit: totalLoss, description: 'انبارگردانی' });
      }
      createJournalEntry(db, {
        date: session.date || todayJalali(),
        description: `سند انبارگردانی #${session.id}`,
        ref_type: 'stocktaking', ref_id: session.id, created_by: req.user.id, lines,
      });
    }
    db.prepare("UPDATE stocktaking_sessions SET status='adjusted',approved_by=?,approved_at=strftime('%s','now') WHERE id=?")
      .run(req.user.id, session.id);
  })();
  audit(req.user.id, 'approve', 'stocktaking', session.id, 'اعمال اصلاحات انبارگردانی');
  res.json({ ok: true });
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
