const router = require('express').Router();
const { getDB } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { j2g, todayJalali } = require('../jalali');
const { acct } = require('../lib/coa-map');

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
    const invoices = db.prepare("SELECT id,date,COALESCE(NULLIF(final_rial,0),ROUND(final*10),0) final_rial FROM invoices WHERE cust_id=? AND type='final' ORDER BY date ASC, id ASC").all(c.id);
    if (!invoices.length) continue;
    let settledPool = db.prepare('SELECT COALESCE(SUM(COALESCE(NULLIF(amount_rial,0),ROUND(amount*10),0)),0) s FROM settlements WHERE cust_id=?').get(c.id).s;
    const bucket = { b0_30: 0, b31_60: 0, b61_90: 0, b90plus: 0 };
    for (const inv of invoices) {
      let remaining = inv.final_rial;
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
  const cashIn = db.prepare(`SELECT COALESCE(SUM(COALESCE(NULLIF(amount_rial,0),ROUND(amount*10),0)),0) s FROM settlements ${settl.sql}`).get(...settl.params).s;
  const supPay = dateFilter('date');
  const supplierOut = db.prepare(`SELECT COALESCE(SUM(ROUND(amount*10)),0) s FROM supplier_payments ${supPay.sql}`).get(...supPay.params).s;
  const incPay = dateFilter('date');
  const incentiveOut = db.prepare(`SELECT COALESCE(SUM(ROUND(amount*10)),0) s FROM incentive_payments ${incPay.sql}`).get(...incPay.params).s;
  const expPay = dateFilter('date');
  const expenseOut = db.prepare(`SELECT COALESCE(SUM(ROUND(amount*10)),0) s FROM expense_payments ${expPay.sql}`).get(...expPay.params).s;
  const poWhere = dateFilter('date');
  const purchaseCashOut = db.prepare(`SELECT COALESCE(SUM(ROUND(final*10)),0) s FROM purchase_invoices ${poWhere.sql}${poWhere.sql ? ' AND ' : ' WHERE '}pay_type<>'credit'`).get(...poWhere.params).s;
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
      byProduct[l.product_id].revenue += Math.round((l.sum || 0) * 10);
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
  const rows = db.prepare('SELECT id,code,name,stock,COALESCE(NULLIF(average_cost_rial,0),ROUND(cost*10),0) cost,COALESCE(NULLIF(price_rial,0),ROUND(price*10),0) price FROM products ORDER BY name').all();
  rows.forEach(p => { p.cost_value = Math.round((p.stock || 0) * (p.cost || 0)); p.retail_value = Math.round((p.stock || 0) * (p.price || 0)); });
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
  const salesVat = db.prepare(`SELECT COALESCE(SUM(COALESCE(NULLIF(vat_amount_rial,0),ROUND(vat_amount*10),0)),0) s, COALESCE(SUM(COALESCE(NULLIF(final_rial,0),ROUND(final*10),0)),0) f FROM invoices WHERE ${where.join(' AND ')}`).get(...params);
  const pWhere = ['1=1'], pParams = [];
  if (from) { pWhere.push('date>=?'); pParams.push(from); }
  if (to) { pWhere.push('date<=?'); pParams.push(to); }
  const purchaseVat = db.prepare(`SELECT COALESCE(SUM(ROUND(vat_amount*10)),0) s, COALESCE(SUM(ROUND(final*10)),0) f FROM purchase_invoices WHERE ${pWhere.join(' AND ')}`).get(...pParams);
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
    SELECT c.id, c.biz as name, 'customer' as party_type, COUNT(i.id) doc_count, COALESCE(SUM(COALESCE(NULLIF(i.final_rial,0),ROUND(i.final*10),0)),0) turnover
    FROM invoices i JOIN customers c ON i.cust_id=c.id
    WHERE ${invWhere.join(' AND ')}
    GROUP BY c.id ORDER BY turnover DESC LIMIT ?
  `).all(...invParams, lim);
  const purWhere = ['1=1'], purParams = [];
  if (from) { purWhere.push('p.date>=?'); purParams.push(from); }
  if (to) { purWhere.push('p.date<=?'); purParams.push(to); }
  const purchases = db.prepare(`
    SELECT s.id, s.name, 'supplier' as party_type, COUNT(p.id) doc_count, COALESCE(SUM(ROUND(p.final*10)),0) turnover
    FROM purchase_invoices p JOIN suppliers s ON p.supplier_id=s.id
    WHERE ${purWhere.join(' AND ')}
    GROUP BY s.id ORDER BY turnover DESC LIMIT ?
  `).all(...purParams, lim);
  res.json({ from: from || '', to: to || '', sales, purchases });
});

function syncVatRecords(db) {
  const vatOutput = acct(db, 'coa_vat_payable').code;
  const vatInput = acct(db, 'coa_vat_receivable').code;
  const upsert = db.prepare(`
    INSERT INTO vat_records
      (journal_line_id,source_type,source_id,invoice_number,invoice_date,base_amount_rial,
       vat_rate_bp,vat_amount_rial,vat_category,fiscal_period,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,'posted')
    ON CONFLICT(source_type,source_id,vat_category) DO UPDATE SET
      journal_line_id=excluded.journal_line_id,invoice_number=excluded.invoice_number,
      invoice_date=excluded.invoice_date,base_amount_rial=excluded.base_amount_rial,
      vat_rate_bp=excluded.vat_rate_bp,vat_amount_rial=excluded.vat_amount_rial,
      fiscal_period=excluded.fiscal_period,
      status=CASE WHEN vat_records.status='reversed' THEN 'reversed' ELSE 'posted' END
  `);
  const sources = [
    {
      table: 'invoices', sourceType: 'invoice', category: 'output', account: vatOutput,
      rows: db.prepare("SELECT id,num,date,subtotal,subtotal_rial,vat_rate,vat_amount,vat_amount_rial FROM invoices WHERE type='final' AND COALESCE(vat_amount_rial,ROUND(vat_amount*10),0)>0").all(),
    },
    {
      table: 'purchase_invoices', sourceType: 'purchase', category: 'input', account: vatInput,
      rows: db.prepare("SELECT id,num,date,subtotal,vat_rate,vat_amount FROM purchase_invoices WHERE COALESCE(vat_amount,0)>0").all(),
    },
  ];
  db.transaction(() => {
    for (const source of sources) {
      for (const row of source.rows) {
        const line = db.prepare(`
          SELECT jl.id FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id
          WHERE je.ref_type=? AND je.ref_id=? AND jl.account_code=?
          ORDER BY je.id DESC,jl.id LIMIT 1
        `).get(source.sourceType, row.id, source.account);
        const baseRial = Math.round(row.subtotal_rial || (row.subtotal || 0) * 10);
        const vatRial = Math.round(row.vat_amount_rial || (row.vat_amount || 0) * 10);
        const period = String(row.date || '').slice(0, 7).replace('/', '-');
        upsert.run(line?.id || null, source.sourceType, row.id, row.num || String(row.id), row.date || '',
          baseRial, Math.round((Number(row.vat_rate) || 0) * 100), vatRial, source.category, period);
      }
    }
  })();
}

router.get('/vat-records', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  syncVatRecords(db);
  const where = ["status<>'reversed'"], params = [];
  if (req.query.period) { where.push('fiscal_period=?'); params.push(req.query.period); }
  const rows = db.prepare(`
    SELECT * FROM vat_records WHERE ${where.join(' AND ')} ORDER BY invoice_date,id
  `).all(...params);
  const totals = rows.reduce((sum, row) => {
    const key = row.vat_category === 'output' ? 'output_vat_rial' : 'input_vat_rial';
    sum[key] += row.vat_amount_rial || 0;
    sum.base_amount_rial += row.base_amount_rial || 0;
    return sum;
  }, { output_vat_rial: 0, input_vat_rial: 0, base_amount_rial: 0 });
  totals.net_payable_rial = totals.output_vat_rial - totals.input_vat_rial;
  res.json({ rows, totals });
});

router.get('/report-configurations', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const params = [];
  let where = 'WHERE active=1';
  if (req.query.report_name) { where += ' AND report_name=?'; params.push(req.query.report_name); }
  res.json(db.prepare(`
    SELECT * FROM report_configurations ${where} ORDER BY report_name,row_number
  `).all(...params).map(row => ({ ...row, account_prefixes: JSON.parse(row.account_prefixes_json || '[]') })));
});

router.put('/report-configurations/:reportName', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const reportName = String(req.params.reportName || '').trim();
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!reportName || !rows.length) throw new Error('نام گزارش و ردیف‌ها الزامی است');
    db.transaction(() => {
      db.prepare('UPDATE report_configurations SET active=0 WHERE report_name=?').run(reportName);
      const upsert = db.prepare(`
        INSERT INTO report_configurations
          (report_name,row_number,row_label,operation,account_prefixes_json,show_subtotal,active,created_by)
        VALUES (?,?,?,?,?,?,1,?)
        ON CONFLICT(report_name,row_number) DO UPDATE SET row_label=excluded.row_label,
          operation=excluded.operation,account_prefixes_json=excluded.account_prefixes_json,
          show_subtotal=excluded.show_subtotal,active=1
      `);
      rows.forEach((row, index) => {
        const prefixes = Array.isArray(row.account_prefixes) ? row.account_prefixes.map(String) : [];
        if (!prefixes.every(p => /^\d[\d-]*$/.test(p))) throw new Error(`کد حساب ردیف ${index + 1} نامعتبر است`);
        if (!['sum','subtract','subtotal'].includes(row.operation || 'sum')) throw new Error(`عملگر ردیف ${index + 1} نامعتبر است`);
        upsert.run(reportName, index + 1, row.row_label || `ردیف ${index + 1}`, row.operation || 'sum',
          JSON.stringify(prefixes), row.show_subtotal ? 1 : 0, req.user.id);
      });
    })();
    res.json({ ok: true, count: rows.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/dynamic-statement/:reportName', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const configs = db.prepare(`
    SELECT * FROM report_configurations WHERE report_name=? AND active=1 ORDER BY row_number
  `).all(req.params.reportName);
  const dateWhere = [], dateParams = [];
  if (req.query.from) { dateWhere.push('je.entry_date>=?'); dateParams.push(req.query.from); }
  if (req.query.to) { dateWhere.push('je.entry_date<=?'); dateParams.push(req.query.to); }
  const balances = db.prepare(`
    SELECT jl.account_code,
           SUM(COALESCE(jl.debit_rial,ROUND(jl.debit*10),0)-COALESCE(jl.credit_rial,ROUND(jl.credit*10),0)) balance_rial
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'approved')<>'reversed'
      ${dateWhere.length ? 'AND ' + dateWhere.join(' AND ') : ''}
    GROUP BY jl.account_code
  `).all(...dateParams);
  let running = 0;
  const rows = configs.map(config => {
    const prefixes = JSON.parse(config.account_prefixes_json || '[]');
    let amount = balances.filter(b => prefixes.some(prefix => String(b.account_code).startsWith(prefix)))
      .reduce((sum, b) => sum + (b.balance_rial || 0), 0);
    if (config.operation === 'subtract') amount = -amount;
    if (config.operation !== 'subtotal') running += amount;
    return { ...config, account_prefixes: prefixes, amount_rial: config.operation === 'subtotal' ? running : amount };
  });
  res.json({ report_name: req.params.reportName, rows });
});

router.get('/cost-accounting', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const period = req.query.period || '';
  const rows = db.prepare(`
    SELECT cc.id,cc.code,cc.name,
      COALESCE((SELECT SUM(ROUND(ep.amount*10)) FROM expense_payments ep
        WHERE ep.cost_center_id=cc.id AND COALESCE(ep.is_overhead,0)=1
          AND (?='' OR substr(ep.date,1,7)=?)),0) total_cost_rial,
      COALESCE((SELECT SUM(poa.amount_rial) FROM production_overhead_applications poa
        WHERE poa.cost_center_id=cc.id AND poa.status='posted'
          AND (?='' OR poa.period_label=?)),0) applied_cost_rial
    FROM cost_centers cc WHERE COALESCE(cc.active,1)=1 ORDER BY cc.code,cc.name
  `).all(period, period, period, period).map(row => ({
    ...row, variance_rial: row.total_cost_rial - row.applied_cost_rial,
  }));
  res.json({ period, rows });
});

module.exports = router;
