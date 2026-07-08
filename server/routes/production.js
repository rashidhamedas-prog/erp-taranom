const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');

function enrichRun(db, r) {
  r.total_cost = (r.material_cost || 0) + (r.labor_cost || 0) + (r.overhead_cost || 0) + (r.packaging_cost || 0) + (r.waste_cost || 0);
  r.unit_cost = r.qty_produced > 0 ? r.total_cost / r.qty_produced : 0;
  r.efficiency = (r.qty_produced + (r.waste_qty || 0)) > 0 ? r.qty_produced / (r.qty_produced + (r.waste_qty || 0)) : 1;
  r.margin = (r.product_price || 0) - r.unit_cost;
  if (r.warehouse_id) {
    const wh = db.prepare('SELECT name FROM warehouses WHERE id=?').get(r.warehouse_id);
    r.warehouse_name = wh ? wh.name : null;
  }
  return r;
}

function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : fallback;
}

function suggestOverhead(db, materialCost, laborCost) {
  const method = getSetting(db, 'overhead_method', 'both');
  const ratePct = parseFloat(getSetting(db, 'overhead_rate_percent', '15')) || 15;
  const direct = materialCost + laborCost;
  const rateAmt = Math.round(direct * ratePct / 100);
  const taggedTotal = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM expense_payments WHERE is_overhead=1').get().s || 0;
  const histDirect = db.prepare('SELECT COALESCE(SUM(material_cost+labor_cost),0) s FROM production_runs').get().s || 0;
  const allocBase = histDirect + direct;
  const tagAmt = allocBase > 0 ? Math.round(taggedTotal * direct / allocBase) : 0;
  let suggested = 0;
  if (method === 'rate') suggested = rateAmt;
  else if (method === 'tag') suggested = tagAmt;
  else suggested = rateAmt + tagAmt;
  return { suggested, method, rate_percent: ratePct, rate_amount: rateAmt, tagged_pool: taggedTotal, tagged_allocation: tagAmt };
}

router.get('/overhead-suggest', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const mat = parseFloat(req.query.material_cost) || 0;
  const lab = parseFloat(req.query.labor_cost) || 0;
  res.json(suggestOverhead(db, mat, lab));
});

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT r.*, p.name as product_name, p.code as product_code, p.price as product_price, p.cost as product_cost, u.name as recorder,
      w.name as warehouse_name
    FROM production_runs r
    LEFT JOIN products p ON r.product_id=p.id
    LEFT JOIN users u ON r.created_by=u.id
    LEFT JOIN warehouses w ON r.warehouse_id=w.id
    ORDER BY r.created_at DESC LIMIT 300
  `).all();
  rows.forEach(r => enrichRun(db, r));
  res.json(rows);
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const {
    product_id, qty_produced, material_cost, labor_cost, overhead_cost, packaging_cost,
    waste_qty, waste_cost, date, note, update_stock, update_cost, warehouse_id, auto_overhead
  } = req.body;
  const qty = parseInt(qty_produced);
  if (!product_id || !qty || qty <= 0) return res.status(400).json({ error: 'کالا و تعداد تولیدی معتبر الزامی است' });
  const db = getDB();
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
  if (!product) return res.status(404).json({ error: 'کالا یافت نشد' });

  const matC = parseFloat(material_cost) || 0;
  const labC = parseFloat(labor_cost) || 0;
  let ovC = parseFloat(overhead_cost) || 0;
  if (auto_overhead && !ovC) ovC = suggestOverhead(db, matC, labC).suggested;
  const pkgC = parseFloat(packaging_cost) || 0;
  const wsC = parseFloat(waste_cost) || 0;
  const wsQ = parseInt(waste_qty) || 0;
  const totalCost = matC + labC + ovC + pkgC + wsC;
  const unitCost = totalCost / qty;
  const whId = warehouse_id ? parseInt(warehouse_id) : (product.warehouse_id || null);

  const doStock = !!update_stock;
  const doCost = !!update_cost;
  const result = db.prepare(
    `INSERT INTO production_runs (product_id,qty_produced,material_cost,labor_cost,overhead_cost,packaging_cost,waste_qty,waste_cost,date,note,stock_added,cost_updated,previous_cost,warehouse_id,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(product_id, qty, matC, labC, ovC, pkgC, wsQ, wsC, date || todayJalali(), note || '', doStock ? 1 : 0, doCost ? 1 : 0, product.cost, whId, req.user.id);
  const runId = result.lastInsertRowid;

  if (doStock) {
    db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(qty, product_id);
    db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)')
      .run(product_id, req.user.id, qty, `تولید داخلی (اجرای تولید #${runId})${whId ? ' — انبار '+whId : ''}`);
  }
  if (doCost) {
    db.prepare('UPDATE products SET cost=? WHERE id=?').run(Math.round(unitCost), product_id);
  }
  audit(req.user.id, 'create', 'production_run', runId, `ثبت اجرای تولید: ${qty} عدد ${product.name} — بهای واحد ${Math.round(unitCost)}`);
  res.json({ id: runId, ok: true, unit_cost: unitCost, total_cost: totalCost, overhead_cost: ovC });
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
