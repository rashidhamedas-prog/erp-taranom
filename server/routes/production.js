const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT r.*, p.name as product_name, p.code as product_code, p.price as product_price, p.cost as product_cost,
      w.name as warehouse_name, u.name as recorder
    FROM production_runs r
    LEFT JOIN products p ON r.product_id=p.id
    LEFT JOIN warehouses w ON r.warehouse_id=w.id
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

const OVERHEAD_KEYS = ['overhead_method', 'overhead_fixed_rate', 'overhead_period_production_qty', 'overhead_auto_suggest'];

router.get('/config', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const obj = { overhead_method: 'tag', overhead_fixed_rate: '0', overhead_period_production_qty: '0', overhead_auto_suggest: '0' };
  db.prepare(`SELECT key,value FROM settings WHERE key IN (${OVERHEAD_KEYS.map(() => '?').join(',')})`)
    .all(...OVERHEAD_KEYS).forEach(r => { obj[r.key] = r.value; });
  res.json(obj);
});

router.put('/config', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { overhead_method, overhead_fixed_rate, overhead_period_production_qty, overhead_auto_suggest } = req.body;
  const stmt = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  if (overhead_method) stmt.run('overhead_method', overhead_method);
  if (overhead_fixed_rate != null) stmt.run('overhead_fixed_rate', String(parseFloat(overhead_fixed_rate) || 0));
  if (overhead_period_production_qty != null) stmt.run('overhead_period_production_qty', String(parseInt(overhead_period_production_qty) || 0));
  if (overhead_auto_suggest != null) stmt.run('overhead_auto_suggest', overhead_auto_suggest === '1' || overhead_auto_suggest === 1 || overhead_auto_suggest === true ? '1' : '0');
  audit(req.user.id, 'update', 'settings', null, 'تنظیم سربار تولید');
  const obj = {};
  db.prepare(`SELECT key,value FROM settings WHERE key IN (${OVERHEAD_KEYS.map(() => '?').join(',')})`)
    .all(...OVERHEAD_KEYS).forEach(r => { obj[r.key] = r.value; });
  res.json(obj);
});

router.get('/overhead-suggest', auth, adminOrAccounting, (req, res) => {
  const qty = parseInt(req.query.qty) || 1;
  const from = req.query.from || '';
  const to = req.query.to || '';
  const db = getDB();

  const where = ["is_overhead=1"], params = [];
  if (from) { where.push('date>=?'); params.push(from); }
  if (to) { where.push('date<=?'); params.push(to); }
  const tagged = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM expense_payments WHERE ${where.join(' AND ')}`).get(...params).s;

  const getSetting = k => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
  const method = getSetting('overhead_method') || 'tag';
  const fixedRate = parseFloat(getSetting('overhead_fixed_rate')) || 0;

  let periodQty = parseInt(getSetting('overhead_period_production_qty')) || 0;
  if (!periodQty) {
    const prodWhere = [], prodParams = [];
    if (from) { prodWhere.push('date>=?'); prodParams.push(from); }
    if (to) { prodWhere.push('date<=?'); prodParams.push(to); }
    const prodSql = prodWhere.length
      ? `SELECT COALESCE(SUM(qty_produced),0) s FROM production_runs WHERE ${prodWhere.join(' AND ')}`
      : 'SELECT COALESCE(SUM(qty_produced),0) s FROM production_runs';
    periodQty = db.prepare(prodSql).get(...prodParams).s || 0;
  }

  let pool = 0;
  if (method === 'tag' || method === 'both') pool += tagged;
  if (method === 'fixed' || method === 'both') pool += fixedRate * periodQty;

  const perUnit = periodQty > 0 ? pool / periodQty : (qty > 0 ? pool / qty : 0);
  const suggested = Math.round(perUnit * qty);

  res.json({
    method, tagged_overhead: tagged, fixed_rate: fixedRate, period_production_qty: periodQty,
    overhead_pool: pool, per_unit: Math.round(perUnit), suggested_for_qty: suggested, qty
  });
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const {
    product_id, qty_produced, material_cost, labor_cost, overhead_cost, packaging_cost,
    waste_qty, waste_cost, date, note, update_stock, update_cost, warehouse_id
  } = req.body;
  const qty = parseInt(qty_produced);
  if (!product_id || !qty || qty <= 0) return res.status(400).json({ error: 'کالا و تعداد تولیدی معتبر الزامی است' });
  const db = getDB();
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
  if (!product) return res.status(404).json({ error: 'کالا یافت نشد' });

  const matC = parseFloat(material_cost) || 0, labC = parseFloat(labor_cost) || 0, ovC = parseFloat(overhead_cost) || 0,
        pkgC = parseFloat(packaging_cost) || 0, wsC = parseFloat(waste_cost) || 0, wsQ = parseInt(waste_qty) || 0;
  const totalCost = matC + labC + ovC + pkgC + wsC;
  const unitCost = totalCost / qty;
  const whId = warehouse_id || product.warehouse_id || null;

  const doStock = !!update_stock, doCost = !!update_cost;
  const result = db.prepare(
    `INSERT INTO production_runs (product_id,qty_produced,material_cost,labor_cost,overhead_cost,packaging_cost,waste_qty,waste_cost,date,note,stock_added,cost_updated,previous_cost,warehouse_id,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(product_id, qty, matC, labC, ovC, pkgC, wsQ, wsC, date || todayJalali(), note || '',
        doStock ? 1 : 0, doCost ? 1 : 0, product.cost, whId, req.user.id);
  const runId = result.lastInsertRowid;

  if (doStock) {
    db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(qty, product_id);
    if (whId) {
      db.prepare('INSERT INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?) ON CONFLICT(product_id,warehouse_id) DO UPDATE SET qty=qty+?')
        .run(product_id, whId, qty, qty);
      db.prepare('UPDATE products SET warehouse_id=? WHERE id=?').run(whId, product_id);
    }
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
    if (row.warehouse_id) {
      db.prepare('UPDATE warehouse_stock SET qty=MAX(0,qty-?) WHERE product_id=? AND warehouse_id=?')
        .run(row.qty_produced, row.product_id, row.warehouse_id);
    }
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
