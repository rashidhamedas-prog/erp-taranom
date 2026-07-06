const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');

// Production cost analysis (تحلیل هزینه تولید) — a tracking/analysis tool for
// a clothing manufacturer's own production runs. This intentionally does NOT
// generate a journal entry: proper manufacturing accounting needs a raw
// materials / work-in-progress ledger this app doesn't have, so a fabricated
// Dr/Cr posting here would misrepresent the books. It optionally increases
// finished-goods stock and/or updates the product's standard cost, both of
// which are real, useful, honestly-scoped side effects.

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT r.*, p.name as product_name, p.code as product_code, p.price as product_price, p.cost as product_cost, u.name as recorder
    FROM production_runs r
    LEFT JOIN products p ON r.product_id=p.id
    LEFT JOIN users u ON r.created_by=u.id
    ORDER BY r.created_at DESC LIMIT 300
  `).all();
  rows.forEach(r => {
    r.total_cost = (r.material_cost || 0) + (r.labor_cost || 0) + (r.overhead_cost || 0) + (r.packaging_cost || 0) + (r.waste_cost || 0);
    r.unit_cost = r.qty_produced > 0 ? r.total_cost / r.qty_produced : 0;
    r.efficiency = (r.qty_produced + (r.waste_qty || 0)) > 0 ? r.qty_produced / (r.qty_produced + (r.waste_qty || 0)) : 1;
    r.margin = (r.product_price || 0) - r.unit_cost;
  });
  res.json(rows);
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const { product_id, qty_produced, material_cost, labor_cost, overhead_cost, packaging_cost, waste_qty, waste_cost, date, note, update_stock, update_cost } = req.body;
  const qty = parseInt(qty_produced);
  if (!product_id || !qty || qty <= 0) return res.status(400).json({ error: 'کالا و تعداد تولیدی معتبر الزامی است' });
  const db = getDB();
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
  if (!product) return res.status(404).json({ error: 'کالا یافت نشد' });

  const matC = parseFloat(material_cost) || 0, labC = parseFloat(labor_cost) || 0, ovC = parseFloat(overhead_cost) || 0,
        pkgC = parseFloat(packaging_cost) || 0, wsC = parseFloat(waste_cost) || 0, wsQ = parseInt(waste_qty) || 0;
  const totalCost = matC + labC + ovC + pkgC + wsC;
  const unitCost = totalCost / qty;

  const doStock = !!update_stock, doCost = !!update_cost;
  const result = db.prepare(
    `INSERT INTO production_runs (product_id,qty_produced,material_cost,labor_cost,overhead_cost,packaging_cost,waste_qty,waste_cost,date,note,stock_added,cost_updated,previous_cost,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(product_id, qty, matC, labC, ovC, pkgC, wsQ, wsC, date || todayJalali(), note || '', doStock ? 1 : 0, doCost ? 1 : 0, product.cost, req.user.id);
  const runId = result.lastInsertRowid;

  if (doStock) {
    db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(qty, product_id);
    db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)')
      .run(product_id, req.user.id, qty, `تولید داخلی (اجرای تولید #${runId})`);
  }
  if (doCost) {
    db.prepare('UPDATE products SET cost=? WHERE id=?').run(Math.round(unitCost), product_id);
  }
  audit(req.user.id, 'create', 'production_run', runId, `ثبت اجرای تولید: ${qty} عدد ${product.name} — بهای واحد ${Math.round(unitCost)}`);
  res.json({ id: runId, ok: true, unit_cost: unitCost, total_cost: totalCost });
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM production_runs WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.stock_added) {
    db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(row.qty_produced, row.product_id);
    db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)')
      .run(row.product_id, req.user.id, -row.qty_produced, `ابطال اجرای تولید #${row.id}`);
  }
  if (row.cost_updated && row.previous_cost != null) {
    db.prepare('UPDATE products SET cost=? WHERE id=?').run(row.previous_cost, row.product_id);
  }
  db.prepare('DELETE FROM production_runs WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'production_run', req.params.id, `حذف اجرای تولید #${req.params.id}`);
  res.json({ ok: true });
});

module.exports = router;
