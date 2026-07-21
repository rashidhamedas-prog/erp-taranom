const router = require('express').Router();
const { getDB } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { j2g, todayJalali } = require('../jalali');
const { acct } = require('../lib/coa-map');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');

function parseQuarter(query) {
  if (query.quarter) {
    const m = String(query.quarter).match(/^(\d{4})-Q([1-4])$/i);
    if (m) return { year: m[1], quarter: parseInt(m[2], 10) };
  }
  const year = query.year || query.fiscal_year;
  const q = parseInt(query.q || query.quarter_num, 10);
  if (year && q >= 1 && q <= 4) return { year: String(year), quarter: q };
  return null;
}

function quarterDateRange(year, quarter) {
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const pad = n => String(n).padStart(2, '0');
  const endDay = endMonth <= 6 ? '31' : (endMonth === 12 ? '29' : '30');
  return {
    from: `${year}/${pad(startMonth)}/01`,
    to: `${year}/${pad(endMonth)}/${endDay}`,
    label: `${year}-Q${quarter}`,
  };
}

function accountTypeMap(db) {
  const rows = db.prepare('SELECT code, type FROM chart_of_accounts').all();
  const map = {};
  for (const r of rows) map[r.code] = r.type || '';
  return map;
}

function classifyCashFlowCounterpart(code, typeMap) {
  const type = typeMap[code] || '';
  if (String(code).startsWith('12')) return 'investing';
  if (type === 'liability' || type === 'equity') return 'financing';
  return 'operating';
}

function buildCashFlowReport(db, from, to) {
  const cashCode = acct(db, 'coa_cash_default').code;
  const bankCode = acct(db, 'coa_bank_default').code;
  const typeMap = accountTypeMap(db);
  const dateWhere = [], dateParams = [];
  if (from) { dateWhere.push('je.entry_date>=?'); dateParams.push(from); }
  if (to) { dateWhere.push('je.entry_date<=?'); dateParams.push(to); }

  const entries = db.prepare(`
    SELECT je.id, je.entry_date, je.description
    FROM journal_entries je
    WHERE COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'approved')<>'reversed'
      ${dateWhere.length ? 'AND ' + dateWhere.join(' AND ') : ''}
      AND EXISTS (
        SELECT 1 FROM journal_lines jl
        WHERE jl.entry_id=je.id
          AND (jl.account_code=? OR jl.account_code LIKE ? OR jl.account_code=? OR jl.account_code LIKE ?)
      )
  `).all(...dateParams, cashCode, cashCode + '-%', bankCode, bankCode + '-%');

  const sections = {
    operating: { inflow_rial: 0, outflow_rial: 0, net_rial: 0, lines: [] },
    investing: { inflow_rial: 0, outflow_rial: 0, net_rial: 0, lines: [] },
    financing: { inflow_rial: 0, outflow_rial: 0, net_rial: 0, lines: [] },
  };

  for (const entry of entries) {
    const lines = db.prepare(`
      SELECT account_code, account_name,
        (${SQL_JL_DEBIT_RIAL}) debit_rial, (${SQL_JL_CREDIT_RIAL}) credit_rial
      FROM journal_lines WHERE entry_id=?
    `).all(entry.id);
    const cashLines = lines.filter(l =>
      l.account_code === cashCode || l.account_code === bankCode ||
      l.account_code.startsWith(cashCode + '-') || l.account_code.startsWith(bankCode + '-')
    );
    const otherLines = lines.filter(l => !cashLines.includes(l));
    const cashNet = cashLines.reduce((s, l) => s + (l.debit_rial || 0) - (l.credit_rial || 0), 0);
    if (!cashNet) continue;

    let section = 'operating';
    if (otherLines.length) {
      const counts = { operating: 0, investing: 0, financing: 0 };
      for (const ol of otherLines) counts[classifyCashFlowCounterpart(ol.account_code, typeMap)]++;
      section = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    }

    const item = {
      entry_id: entry.id, date: entry.entry_date, description: entry.description,
      amount_rial: cashNet,
    };
    sections[section].lines.push(item);
    if (cashNet > 0) sections[section].inflow_rial += cashNet;
    else sections[section].outflow_rial += Math.abs(cashNet);
    sections[section].net_rial += cashNet;
  }

  const totalNet = sections.operating.net_rial + sections.investing.net_rial + sections.financing.net_rial;
  return { from: from || '', to: to || '', sections, total_net_rial: totalNet };
}

function buildVatReturnReport(db, query) {
  const q = parseQuarter(query);
  let from = query.from || '';
  let to = query.to || '';
  let label = '';
  if (q) {
    const range = quarterDateRange(q.year, q.quarter);
    from = range.from;
    to = range.to;
    label = range.label;
  }

  const vatOutput = acct(db, 'coa_vat_payable').code;
  const vatInput = acct(db, 'coa_vat_receivable').code;
  const dateWhere = [], dateParams = [];
  if (from) { dateWhere.push('je.entry_date>=?'); dateParams.push(from); }
  if (to) { dateWhere.push('je.entry_date<=?'); dateParams.push(to); }

  const outputLedger = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_CREDIT_RIAL} - ${SQL_JL_DEBIT_RIAL}), 0) v
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0
      AND COALESCE(je.status,'approved')<>'reversed'
      ${dateWhere.length ? 'AND ' + dateWhere.join(' AND ') : ''}
  `).get(vatOutput, ...dateParams)?.v || 0;

  const inputLedger = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}), 0) v
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0
      AND COALESCE(je.status,'approved')<>'reversed'
      ${dateWhere.length ? 'AND ' + dateWhere.join(' AND ') : ''}
  `).get(vatInput, ...dateParams)?.v || 0;

  const invWhere = ["type='final'"], invParams = [];
  if (from) { invWhere.push('date>=?'); invParams.push(from); }
  if (to) { invWhere.push('date<=?'); invParams.push(to); }
  const salesVat = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(NULLIF(vat_amount_rial,0),ROUND(vat_amount),0)),0) v
    FROM invoices WHERE ${invWhere.join(' AND ')}
  `).get(...invParams)?.v || 0;

  const purWhere = ['1=1'], purParams = [];
  if (from) { purWhere.push('date>=?'); purParams.push(from); }
  if (to) { purWhere.push('date<=?'); purParams.push(to); }
  const purchaseVat = db.prepare(`
    SELECT COALESCE(SUM(ROUND(vat_amount)),0) v FROM purchase_invoices WHERE ${purWhere.join(' AND ')}
  `).get(...purParams)?.v || 0;

  const outputVat = Math.max(outputLedger, salesVat);
  const inputVat = Math.max(inputLedger, purchaseVat);
  return {
    quarter: label, from, to,
    output_vat_rial: outputVat, input_vat_rial: inputVat,
    net_payable_rial: outputVat - inputVat,
    ledger_output_rial: outputLedger, ledger_input_rial: inputLedger,
    invoice_output_rial: salesVat, invoice_input_rial: purchaseVat,
  };
}

function buildSeasonal169Report(db, query) {
  const q = parseQuarter(query);
  if (!q) throw new Error('فصل نامعتبر — از quarter=1405-Q1 استفاده کنید');
  const range = quarterDateRange(q.year, q.quarter);

  const sales = db.prepare(`
    SELECT i.num, i.date, COALESCE(NULLIF(i.final_rial,0),ROUND(i.final),0) amount_rial,
           COALESCE(i.buyer_economic_code, c.economic_code, '') economic_code, c.biz party_name
    FROM invoices i JOIN customers c ON c.id=i.cust_id
    WHERE i.type='final' AND i.date>=? AND i.date<=?
    ORDER BY i.date, i.id
  `).all(range.from, range.to);

  const purchases = db.prepare(`
    SELECT p.num, p.date, ROUND(p.final) amount_rial,
           COALESCE(s.economic_code, '') economic_code, s.name party_name
    FROM purchase_invoices p JOIN suppliers s ON s.id=p.supplier_id
    WHERE p.date>=? AND p.date<=?
    ORDER BY p.date, p.id
  `).all(range.from, range.to);

  return {
    quarter: range.label, from: range.from, to: range.to,
    sales, purchases,
    totals: {
      sales_count: sales.length,
      sales_rial: sales.reduce((s, r) => s + (r.amount_rial || 0), 0),
      purchase_count: purchases.length,
      purchase_rial: purchases.reduce((s, r) => s + (r.amount_rial || 0), 0),
    },
  };
}

function sumBalanceByPrefix(db, prefix) {
  return db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}), 0) v
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.account_code LIKE ? AND COALESCE(je.deleted_at,0)=0
      AND COALESCE(je.status,'approved')<>'reversed'
  `).get(prefix + '%')?.v || 0;
}

function buildFinancialRatios(db) {
  const currentAssets = sumBalanceByPrefix(db, '11');
  const inventory = Math.max(0, sumBalanceByPrefix(db, acct(db, 'coa_inventory').code));
  const currentLiabilities = Math.max(0, -sumBalanceByPrefix(db, '21'));
  const totalAssets = Math.max(1, sumBalanceByPrefix(db, '1'));
  const equity = Math.max(1, -sumBalanceByPrefix(db, '3'));
  const netIncome = -sumBalanceByPrefix(db, '3');
  const ar = Math.max(0, sumBalanceByPrefix(db, acct(db, 'coa_receivable').code));
  const ap = Math.max(0, -sumBalanceByPrefix(db, acct(db, 'coa_payable').code));

  const sales365 = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(NULLIF(final_rial,0),ROUND(final),0)),0) v
    FROM invoices WHERE type='final' AND date>=?
  `).get(todayJalali().slice(0, 4) + '/01/01')?.v || 0;
  const cogs365 = Math.abs(sumBalanceByPrefix(db, acct(db, 'coa_cogs').code));
  const purchases365 = db.prepare(`
    SELECT COALESCE(SUM(ROUND(final)),0) v FROM purchase_invoices WHERE date>=?
  `).get(todayJalali().slice(0, 4) + '/01/01')?.v || 0;

  const dailySales = sales365 / 365;
  const dailyCogs = cogs365 / 365;
  const dailyPurchases = purchases365 / 365;

  return {
    current_ratio: currentLiabilities ? currentAssets / currentLiabilities : null,
    quick_ratio: currentLiabilities ? (currentAssets - inventory) / currentLiabilities : null,
    roa: netIncome / totalAssets,
    roe: netIncome / equity,
    dso_days: dailySales ? ar / dailySales : null,
    dio_days: dailyCogs ? inventory / dailyCogs : null,
    dpo_days: dailyPurchases ? ap / dailyPurchases : null,
    components: { current_assets_rial: currentAssets, current_liabilities_rial: currentLiabilities, inventory_rial: inventory, ar_rial: ar, ap_rial: ap },
  };
}

function buildKpiDashboard(db) {
  const ratios = buildFinancialRatios(db);
  const cashCycle = (ratios.dso_days || 0) + (ratios.dio_days || 0) - (ratios.dpo_days || 0);
  const topCustomers = db.prepare(`
    SELECT c.id, c.biz, COALESCE(SUM(COALESCE(NULLIF(i.final_rial,0),ROUND(i.final),0)),0) revenue_rial
    FROM customers c JOIN invoices i ON i.cust_id=c.id AND i.type='final'
    GROUP BY c.id ORDER BY revenue_rial DESC LIMIT 10
  `).all();
  const totalRevenue = topCustomers.reduce((s, r) => s + (r.revenue_rial || 0), 0) || 1;
  return {
    dso_days: ratios.dso_days,
    dio_days: ratios.dio_days,
    dpo_days: ratios.dpo_days,
    cash_cycle_days: cashCycle,
    top_customers: topCustomers.map(r => ({
      ...r, concentration_pct: Math.round((r.revenue_rial / totalRevenue) * 10000) / 100,
    })),
    top3_concentration_pct: Math.round(
      topCustomers.slice(0, 3).reduce((s, r) => s + r.revenue_rial, 0) / totalRevenue * 10000
    ) / 100,
  };
}

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
    const invoices = db.prepare("SELECT id,date,COALESCE(NULLIF(final_rial,0),ROUND(final),0) final_rial FROM invoices WHERE cust_id=? AND type='final' ORDER BY date ASC, id ASC").all(c.id);
    if (!invoices.length) continue;
    let settledPool = db.prepare('SELECT COALESCE(SUM(COALESCE(NULLIF(amount_rial,0),ROUND(amount),0)),0) s FROM settlements WHERE cust_id=?').get(c.id).s;
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
  res.json(buildCashFlowReport(db, req.query.from, req.query.to));
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
      byProduct[l.product_id].revenue += Math.round(l.sum || 0);
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
  const rows = db.prepare('SELECT id,code,name,stock,COALESCE(NULLIF(average_cost_rial,0),ROUND(cost),0) cost,COALESCE(NULLIF(price_rial,0),ROUND(price),0) price FROM products ORDER BY name').all();
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
  const salesVat = db.prepare(`SELECT COALESCE(SUM(COALESCE(NULLIF(vat_amount_rial,0),ROUND(vat_amount),0)),0) s, COALESCE(SUM(COALESCE(NULLIF(final_rial,0),ROUND(final),0)),0) f FROM invoices WHERE ${where.join(' AND ')}`).get(...params);
  const pWhere = ['1=1'], pParams = [];
  if (from) { pWhere.push('date>=?'); pParams.push(from); }
  if (to) { pWhere.push('date<=?'); pParams.push(to); }
  const purchaseVat = db.prepare(`SELECT COALESCE(SUM(ROUND(vat_amount)),0) s, COALESCE(SUM(ROUND(final)),0) f FROM purchase_invoices WHERE ${pWhere.join(' AND ')}`).get(...pParams);
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
    SELECT c.id, c.biz as name, 'customer' as party_type, COUNT(i.id) doc_count, COALESCE(SUM(COALESCE(NULLIF(i.final_rial,0),ROUND(i.final),0)),0) turnover
    FROM invoices i JOIN customers c ON i.cust_id=c.id
    WHERE ${invWhere.join(' AND ')}
    GROUP BY c.id ORDER BY turnover DESC LIMIT ?
  `).all(...invParams, lim);
  const purWhere = ['1=1'], purParams = [];
  if (from) { purWhere.push('p.date>=?'); purParams.push(from); }
  if (to) { purWhere.push('p.date<=?'); purParams.push(to); }
  const purchases = db.prepare(`
    SELECT s.id, s.name, 'supplier' as party_type, COUNT(p.id) doc_count, COALESCE(SUM(ROUND(p.final)),0) turnover
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
      rows: db.prepare("SELECT id,num,date,subtotal,subtotal_rial,vat_rate,vat_amount,vat_amount_rial FROM invoices WHERE type='final' AND COALESCE(vat_amount_rial,ROUND(vat_amount),0)>0").all(),
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
        const baseRial = Math.round(row.subtotal_rial || row.subtotal || 0);
        const vatRial = Math.round(row.vat_amount_rial || row.vat_amount || 0);
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
           SUM(${SQL_JL_DEBIT_RIAL}-${SQL_JL_CREDIT_RIAL}) balance_rial
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
      COALESCE((SELECT SUM(ROUND(ep.amount)) FROM expense_payments ep
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

router.get('/vat-return', auth, adminOrAccounting, (req, res) => {
  try {
    res.json(buildVatReturnReport(getDB(), req.query));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/seasonal-169', auth, adminOrAccounting, (req, res) => {
  try {
    res.json(buildSeasonal169Report(getDB(), req.query));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/financial-ratios', auth, adminOrAccounting, (req, res) => {
  res.json(buildFinancialRatios(getDB()));
});

router.get('/kpi-dashboard', auth, adminOrAccounting, (req, res) => {
  res.json(buildKpiDashboard(getDB()));
});

module.exports = router;
module.exports.buildVatReturnReport = buildVatReturnReport;
module.exports.buildSeasonal169Report = buildSeasonal169Report;
