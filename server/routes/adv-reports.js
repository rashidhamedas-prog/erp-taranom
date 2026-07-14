const router = require('express').Router();
const { getDB } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { j2g, todayJalali } = require('../jalali');

function daysSinceJalali(dateStr) {
  try {
    const [jy, jm, jd] = (dateStr || '').split('/').map(Number);
    if (!jy || !jm || !jd) return 0;
    const [gy, gm, gd] = j2g(jy, jm, jd);
    const then = new Date(gy, gm - 1, gd);
    const now = new Date();
    return Math.floor((now - then) / (1000 * 60 * 60 * 24));
  } catch { return 0; }
}

router.get('/aging', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const customers = db.prepare(`
    SELECT c.id, c.biz, c.phone, u.name as salesperson
    FROM customers c LEFT JOIN users u ON c.user_id=u.id
  `).all();
  const rows = [];
  const totals = { b0_30: 0, b31_60: 0, b61_90: 0, b90plus: 0, total: 0 };
  for (const c of customers) {
    const invoices = db.prepare("SELECT id,date,final FROM invoices WHERE cust_id=? AND type='final' ORDER BY date ASC, id ASC").all(c.id);
    if (!invoices.length) continue;
    let settledPool = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM settlements WHERE cust_id=?').get(c.id).s;
    const bucket = { b0_30: 0, b31_60: 0, b61_90: 0, b90plus: 0 };
    for (const inv of invoices) {
      let remaining = inv.final;
      if (settledPool > 0) {
        const applied = Math.min(settledPool, remaining);
        remaining -= applied;
        settledPool -= applied;
      }
      if (remaining <= 0.01) continue;
      const age = daysSinceJalali(inv.date);
      if (age <= 30) bucket.b0_30 += remaining;
      else if (age <= 60) bucket.b31_60 += remaining;
      else if (age <= 90) bucket.b61_90 += remaining;
      else bucket.b90plus += remaining;
    }
    const total = bucket.b0_30 + bucket.b31_60 + bucket.b61_90 + bucket.b90plus;
    if (total <= 0.01) continue;
    rows.push({ cust_id: c.id, cust_biz: c.biz, cust_phone: c.phone, salesperson: c.salesperson, ...bucket, total });
    totals.b0_30 += bucket.b0_30; totals.b31_60 += bucket.b31_60; totals.b61_90 += bucket.b61_90; totals.b90plus += bucket.b90plus; totals.total += total;
  }
  rows.sort((a, b) => b.total - a.total);
  res.json({ rows, totals });
});

router.get('/cash-flow', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { from, to } = req.query;
  const dateFilter = (col) => {
    const where = [], params = [];
    if (from) { where.push(`${col}>=?`); params.push(from); }
    if (to) { where.push(`${col}<=?`); params.push(to); }
    return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
  };
  const settl = dateFilter('date');
  const cashIn = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM settlements ${settl.sql}`).get(...settl.params).s;
  const supPay = dateFilter('date');
  const supplierOut = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM supplier_payments ${supPay.sql}`).get(...supPay.params).s;
  const incPay = dateFilter('date');
  const incentiveOut = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM incentive_payments ${incPay.sql}`).get(...incPay.params).s;
  const expPay = dateFilter('date');
  const expenseOut = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM expense_payments ${expPay.sql}`).get(...expPay.params).s;
  const poWhere = dateFilter('date');
  const purchaseCashOut = db.prepare(`SELECT COALESCE(SUM(final),0) s FROM purchase_invoices ${poWhere.sql}${poWhere.sql ? ' AND ' : ' WHERE '}pay_type<>'credit'`).get(...poWhere.params).s;
  const totalOut = supplierOut + incentiveOut + expenseOut + purchaseCashOut;
  res.json({
    from: from || '', to: to || '',
    cashIn, supplierOut, incentiveOut, expenseOut, purchaseCashOut,
    totalOut, net: cashIn - totalOut
  });
});

function aggregateSalesByProduct(db, from, to) {
  const where = ["type='final'"];
  const params = [];
  if (from) { where.push('date>=?'); params.push(from); }
  if (to) { where.push('date<=?'); params.push(to); }
  const invoices = db.prepare(`SELECT rows FROM invoices WHERE ${where.join(' AND ')}`).all(...params);
  const byProduct = {};
  for (const inv of invoices) {
    let lines;
    try { lines = JSON.parse(inv.rows || '[]'); } catch { continue; }
    for (const l of lines) {
      if (!byProduct[l.product_id]) byProduct[l.product_id] = { product_id: l.product_id, name: l.name, qty: 0, revenue: 0 };
      byProduct[l.product_id].qty += l.qty || 0;
      byProduct[l.product_id].revenue += l.sum || 0;
    }
  }
  return byProduct;
}

router.get('/sales-by-product', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const byProduct = aggregateSalesByProduct(db, req.query.from, req.query.to);
  const rows = Object.values(byProduct).sort((a, b) => b.revenue - a.revenue);
  const totals = rows.reduce((a, r) => ({ qty: a.qty + r.qty, revenue: a.revenue + r.revenue }), { qty: 0, revenue: 0 });
  res.json({ rows, totals });
});

router.get('/inventory-valuation', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare('SELECT id,code,name,stock,cost,price FROM products ORDER BY name').all();
  rows.forEach(p => { p.cost_value = (p.stock || 0) * (p.cost || 0); p.retail_value = (p.stock || 0) * (p.price || 0); });
  const totals = rows.reduce((a, r) => ({ stock: a.stock + (r.stock || 0), cost_value: a.cost_value + r.cost_value, retail_value: a.retail_value + r.retail_value }), { stock: 0, cost_value: 0, retail_value: 0 });
  res.json({ rows, totals });
});

router.get('/inventory-health', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { from, to } = req.query;
  const products = db.prepare('SELECT id,code,name,stock,unit,stock_alert FROM products ORDER BY name').all();
  const soldByProduct = aggregateSalesByProduct(db, from, to);
  const negative = products.filter(p => (p.stock || 0) <= 0);
  const fastMoving = Object.values(soldByProduct).sort((a, b) => b.qty - a.qty).slice(0, 20);
  const soldIds = new Set(Object.keys(soldByProduct).map(Number));
  const slowMoving = products.filter(p => !soldIds.has(p.id) && (p.stock || 0) > 0).sort((a, b) => (b.stock || 0) - (a.stock || 0)).slice(0, 20);
  res.json({ negative, fastMoving, slowMoving, period: { from: from || '', to: to || todayJalali() } });
});

router.get('/vat-summary', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { from, to } = req.query;
  const where = ["type='final'"], params = [];
  if (from) { where.push('date>=?'); params.push(from); }
  if (to) { where.push('date<=?'); params.push(to); }
  const salesVat = db.prepare(`SELECT COALESCE(SUM(vat_amount),0) s, COALESCE(SUM(final),0) f FROM invoices WHERE ${where.join(' AND ')}`).get(...params);
  const pWhere = ['1=1'], pParams = [];
  if (from) { pWhere.push('date>=?'); pParams.push(from); }
  if (to) { pWhere.push('date<=?'); pParams.push(to); }
  const purchaseVat = db.prepare(`SELECT COALESCE(SUM(vat_amount),0) s, COALESCE(SUM(final),0) f FROM purchase_invoices WHERE ${pWhere.join(' AND ')}`).get(...pParams);
  const outputVat = salesVat?.s || 0;
  const inputVat = purchaseVat?.s || 0;
  res.json({
    from: from || '', to: to || '',
    output_vat: outputVat, input_vat: inputVat, net_payable: outputVat - inputVat,
    sales_total: salesVat?.f || 0, purchase_total: purchaseVat?.f || 0
  });
});

router.get('/party-turnover', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { from, to, limit } = req.query;
  const lim = Math.min(parseInt(limit, 10) || 50, 200);
  const invWhere = ["i.type='final'"], invParams = [];
  if (from) { invWhere.push('i.date>=?'); invParams.push(from); }
  if (to) { invWhere.push('i.date<=?'); invParams.push(to); }
  const sales = db.prepare(`
    SELECT c.id, c.biz as name, 'customer' as party_type, COUNT(i.id) doc_count, COALESCE(SUM(i.final),0) turnover
    FROM invoices i JOIN customers c ON i.cust_id=c.id
    WHERE ${invWhere.join(' AND ')}
    GROUP BY c.id ORDER BY turnover DESC LIMIT ?
  `).all(...invParams, lim);
  const purWhere = ['1=1'], purParams = [];
  if (from) { purWhere.push('p.date>=?'); purParams.push(from); }
  if (to) { purWhere.push('p.date<=?'); purParams.push(to); }
  const purchases = db.prepare(`
    SELECT s.id, s.name, 'supplier' as party_type, COUNT(p.id) doc_count, COALESCE(SUM(p.final),0) turnover
    FROM purchase_invoices p JOIN suppliers s ON p.supplier_id=s.id
    WHERE ${purWhere.join(' AND ')}
    GROUP BY s.id ORDER BY turnover DESC LIMIT ?
  `).all(...purParams, lim);
  res.json({ from: from || '', to: to || '', sales, purchases });
});

module.exports = router;
