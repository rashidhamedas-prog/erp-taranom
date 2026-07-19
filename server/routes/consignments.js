const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');

// Consignment goods — ownership stays with the original owner until settled.
// "out" = we gave our own goods to someone else to sell on our behalf (they
// physically leave our warehouse, so stock is decremented, but no revenue is
// recognized since we haven't sold anything yet — that happens separately,
// as a real invoice, when settled).
// "in" = we're holding someone else's goods to sell on their behalf; they
// were never our inventory, so our stock is never touched.
// Settling/returning only updates status and (for "out") reverses the stock
// deduction on return — the real sale/payment, if any, is recorded
// separately through the normal Sales/Payment flows, same pattern as trust checks.

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { direction, status } = req.query;
  const where = [], params = [];
  if (direction) { where.push('c.direction=?'); params.push(direction); }
  if (status) { where.push('c.status=?'); params.push(status); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT c.*, p.name as product_name, p.code as product_code
    FROM consignments c LEFT JOIN products p ON c.product_id=p.id
    ${whereSql} ORDER BY c.created_at DESC
  `).all(...params);
  res.json(rows);
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const { direction, party_name, party_phone, product_id, qty, unit_price, date, note, status } = req.body;
  if (!direction || !['in', 'out'].includes(direction)) return res.status(400).json({ error: 'جهت امانت (نزد ما/نزد دیگری) الزامی است' });
  if (!party_name) return res.status(400).json({ error: 'نام طرف حساب الزامی است' });
  const q = parseInt(qty);
  const initialStatus = ['open', 'settled', 'returned'].includes(status) ? status : 'open';
  if (!product_id || !q || q <= 0) return res.status(400).json({ error: 'کالا و تعداد معتبر الزامی است' });
  const db = getDB();
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
  if (!product) return res.status(404).json({ error: 'کالا یافت نشد' });
  if (direction === 'out' && initialStatus !== 'returned') {
    if (product.stock < q) return res.status(400).json({ error: `موجودی کافی نیست (موجود: ${product.stock})` });
    db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(q, product_id);
    db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)')
      .run(product_id, req.user.id, -q, `ارسال امانی به ${party_name}`);
  }
  const result = db.prepare(
    'INSERT INTO consignments (direction,party_name,party_phone,product_id,qty,unit_price,date,note,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(direction, party_name, party_phone || '', product_id, q, parseFloat(unit_price) || 0,
    date || todayJalali(), note || '', initialStatus, req.user.id);
  audit(req.user.id, 'create', 'consignment', result.lastInsertRowid, `کالای امانی ${direction==='out'?'ارسالی به':'دریافتی از'} ${party_name}: ${q} عدد ${product.name}`);
  res.json(db.prepare('SELECT * FROM consignments WHERE id=?').get(result.lastInsertRowid));
});

router.patch('/:id/status', auth, adminOrAccounting, (req, res) => {
  const { status } = req.body;
  if (!['open', 'settled', 'returned'].includes(status)) return res.status(400).json({ error: 'وضعیت نامعتبر' });
  const db = getDB();
  const row = db.prepare('SELECT * FROM consignments WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.status !== 'open') return res.status(400).json({ error: 'این رکورد قبلاً بسته شده است' });
  // "out" goods physically come back to our warehouse on return (not on settle,
  // since settling means it was actually sold and stays with the buyer)
  if (row.direction === 'out' && status === 'returned') {
    db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(row.qty, row.product_id);
    db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)')
      .run(row.product_id, req.user.id, row.qty, `استرداد کالای امانی از ${row.party_name}`);
  }
  db.prepare('UPDATE consignments SET status=? WHERE id=?').run(status, req.params.id);
  audit(req.user.id, 'update', 'consignment', req.params.id, `تغییر وضعیت کالای امانی به ${status}`);
  res.json({ ok: true });
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM consignments WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.status === 'open' && row.direction === 'out') {
    db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(row.qty, row.product_id);
    db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)')
      .run(row.product_id, req.user.id, row.qty, `ابطال کالای امانی ارسالی به ${row.party_name}`);
  }
  db.prepare('DELETE FROM consignments WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'consignment', req.params.id, `حذف کالای امانی #${req.params.id}`);
  res.json({ ok: true });
});

module.exports = router;
