const router = require('express').Router();
const { getDB } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { j2g, todayJalali } = require('../jalali');

// Advanced accounting/inventory reports that go beyond what already exists
// (Receivables, General Ledger, Trial Balance, P&L, Balance Sheet, Item
// Kardex, Warehouse Stock). Tax/VAT reports are intentionally NOT included —
// this app has no VAT calculation engine, and building an empty report
// shell around a feature that doesn't exist would be a placeholder.

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

// ---- Aging report — FIFO-allocates each customer's total settlements
// against their invoices oldest-first, then buckets whatever remains
// unpaid on each invoice by its age. This is the standard approximation
// used whenever settlements aren't explicitly linked to individual invoices.
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

// ---- Cash flow summary for a period ----
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

// Shared helper: aggregate final-invoice line items by product for a period
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

module.exports = router;
