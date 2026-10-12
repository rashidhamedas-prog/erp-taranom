'use strict';
/**
 * داشبورد پیشرفته فروش و خرید — KPI + روند ماهانه + Top N + مقایسه دوره قبل + هشدار.
 * منبع: فاکتور قطعی فروش (normal|final) و فاکتور خرید زنده + برگشت‌های فعال.
 * مبالغ KPI به ریال. هرگز به HTTP پرتاب نمی‌کند (caller catch می‌کند).
 */

const { firmSaleTypeSql, commissionEligibleSql } = require('./sales-document');
const { todayJalali, addDaysToJalali } = require('../jalali');

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (_) {
    return false;
  }
}

function tableHasColumn(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch (_) {
    return false;
  }
}

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function rialExpr(alias, rialCol, baseCol) {
  const a = alias ? `${alias}.` : '';
  return `COALESCE(NULLIF(${a}${rialCol},0), ROUND(${a}${baseCol}), 0)`;
}

function salesAliveSql(alias = 'i') {
  const parts = [firmSaleTypeSql(alias)];
  parts.push(`COALESCE(${alias}.deleted_at,0)=0`);
  return parts.join(' AND ');
}

function purchaseAliveSql(alias = 'p') {
  return `COALESCE(${alias}.status,'posted')<>'reversed'`;
}

function returnAliveSql(alias, db, table) {
  if (tableHasColumn(db, table, 'status')) {
    return `COALESCE(${alias}.status,'posted')<>'reversed'`;
  }
  return '1=1';
}

function dateSpanDays(from, to) {
  if (!from || !to) return 30;
  try {
    const [fy, fm, fd] = String(from).split('/').map(Number);
    const [ty, tm, td] = String(to).split('/').map(Number);
    if ([fy, fm, fd, ty, tm, td].some((x) => !Number.isFinite(x))) return 30;
    const { j2g } = require('../jalali');
    const [gfy, gfm, gfd] = j2g(fy, fm, fd);
    const [gty, gtm, gtd] = j2g(ty, tm, td);
    const a = new Date(gfy, gfm - 1, gfd);
    const b = new Date(gty, gtm - 1, gtd);
    const days = Math.round((b - a) / 86400000) + 1;
    return Math.max(1, Math.min(days, 3660));
  } catch (_) {
    return 30;
  }
}

function priorPeriod(from, to) {
  if (!from || !to) return { from: '', to: '' };
  const days = dateSpanDays(from, to);
  const priorTo = addDaysToJalali(from, -1);
  const priorFrom = addDaysToJalali(priorTo, -(days - 1));
  return { from: priorFrom, to: priorTo };
}

function pctDelta(cur, prev) {
  const c = Number(cur) || 0;
  const p = Number(prev) || 0;
  if (!p && !c) return 0;
  if (!p) return 100;
  return Math.round(((c - p) / Math.abs(p)) * 1000) / 10;
}

function buildSalesWhere(filters, alias = 'i') {
  const where = [salesAliveSql(alias)];
  const params = [];
  if (filters.from) { where.push(`${alias}.date>=?`); params.push(filters.from); }
  if (filters.to) { where.push(`${alias}.date<=?`); params.push(filters.to); }
  if (filters.cust_id) { where.push(`${alias}.cust_id=?`); params.push(filters.cust_id); }
  if (filters.user_id) { where.push(`${alias}.user_id=?`); params.push(filters.user_id); }
  if (filters.warehouse_id && filters.hasInvWh) {
    where.push(`${alias}.warehouse_id=?`);
    params.push(filters.warehouse_id);
  }
  return { where: where.join(' AND '), params };
}

function buildPurchaseWhere(filters, alias = 'p') {
  const where = [purchaseAliveSql(alias)];
  const params = [];
  if (filters.from) { where.push(`${alias}.date>=?`); params.push(filters.from); }
  if (filters.to) { where.push(`${alias}.date<=?`); params.push(filters.to); }
  if (filters.supplier_id) { where.push(`${alias}.supplier_id=?`); params.push(filters.supplier_id); }
  if (filters.user_id) { where.push(`${alias}.user_id=?`); params.push(filters.user_id); }
  if (filters.warehouse_id && filters.hasPurWh) {
    where.push(`${alias}.warehouse_id=?`);
    params.push(filters.warehouse_id);
  }
  return { where: where.join(' AND '), params };
}

function sumSales(db, filters) {
  const { where, params } = buildSalesWhere(filters, 'i');
  const amt = rialExpr('i', 'final_rial', 'final');
  const disc = tableHasColumn(db, 'invoices', 'disc_amt_rial')
    ? rialExpr('i', 'disc_amt_rial', 'disc_amt')
    : 'COALESCE(ROUND(i.disc_amt),0)';
  const vat = tableHasColumn(db, 'invoices', 'vat_amount_rial')
    ? rialExpr('i', 'vat_amount_rial', 'vat_amount')
    : 'COALESCE(ROUND(i.vat_amount),0)';
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS cnt,
        COALESCE(SUM(${amt}),0) AS gross,
        COALESCE(SUM(${disc}),0) AS discount,
        COALESCE(SUM(${vat}),0) AS vat
      FROM invoices i
      WHERE ${where}
    `).get(...params);
    return {
      count: Number(row && row.cnt) || 0,
      gross_rial: Math.round(Number(row && row.gross) || 0),
      discount_rial: Math.round(Number(row && row.discount) || 0),
      vat_rial: Math.round(Number(row && row.vat) || 0),
    };
  } catch (_) {
    return { count: 0, gross_rial: 0, discount_rial: 0, vat_rial: 0 };
  }
}

function sumPurchases(db, filters) {
  const { where, params } = buildPurchaseWhere(filters, 'p');
  const hasFinalRial = tableHasColumn(db, 'purchase_invoices', 'final_rial');
  const amt = hasFinalRial
    ? rialExpr('p', 'final_rial', 'final')
    : 'COALESCE(ROUND(p.final),0)';
  const vat = tableHasColumn(db, 'purchase_invoices', 'vat_amount')
    ? 'COALESCE(ROUND(p.vat_amount),0)'
    : '0';
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS cnt,
        COALESCE(SUM(${amt}),0) AS gross,
        COALESCE(SUM(${vat}),0) AS vat
      FROM purchase_invoices p
      WHERE ${where}
    `).get(...params);
    return {
      count: Number(row && row.cnt) || 0,
      gross_rial: Math.round(Number(row && row.gross) || 0),
      vat_rial: Math.round(Number(row && row.vat) || 0),
    };
  } catch (_) {
    return { count: 0, gross_rial: 0, vat_rial: 0 };
  }
}

function sumReturns(db, table, partyCol, filters, side) {
  if (!tableExists(db, table)) return { count: 0, amount_rial: 0, vat_rial: 0 };
  const alias = 'r';
  const where = [returnAliveSql(alias, db, table)];
  const params = [];
  if (filters.from) { where.push(`${alias}.date>=?`); params.push(filters.from); }
  if (filters.to) { where.push(`${alias}.date<=?`); params.push(filters.to); }
  if (side === 'sales' && filters.cust_id) {
    where.push(`${alias}.${partyCol}=?`);
    params.push(filters.cust_id);
  }
  if (side === 'purchase' && filters.supplier_id) {
    where.push(`${alias}.${partyCol}=?`);
    params.push(filters.supplier_id);
  }
  if (filters.user_id && tableHasColumn(db, table, 'user_id')) {
    where.push(`${alias}.user_id=?`);
    params.push(filters.user_id);
  }
  const amtCol = tableHasColumn(db, table, 'amount_rial')
    ? `COALESCE(NULLIF(${alias}.amount_rial,0), ROUND(${alias}.amount), 0)`
    : `COALESCE(ROUND(${alias}.amount),0)`;
  const vatCol = tableHasColumn(db, table, 'vat_amount')
    ? `COALESCE(ROUND(${alias}.vat_amount),0)`
    : '0';
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS cnt,
        COALESCE(SUM(${amtCol}),0) AS amt,
        COALESCE(SUM(${vatCol}),0) AS vat
      FROM ${table} ${alias}
      WHERE ${where.join(' AND ')}
    `).get(...params);
    return {
      count: Number(row && row.cnt) || 0,
      amount_rial: Math.round(Number(row && row.amt) || 0),
      vat_rial: Math.round(Number(row && row.vat) || 0),
    };
  } catch (_) {
    return { count: 0, amount_rial: 0, vat_rial: 0 };
  }
}

function productUnitCostMap(db) {
  const map = {};
  const hasAvg = tableHasColumn(db, 'products', 'average_cost_rial');
  try {
    const rows = hasAvg
      ? db.prepare('SELECT id, COALESCE(NULLIF(average_cost_rial,0), ROUND(cost), 0) AS unit_cost FROM products').all()
      : db.prepare('SELECT id, COALESCE(ROUND(cost),0) AS unit_cost FROM products').all();
    for (const p of rows) map[p.id] = Number(p.unit_cost) || 0;
  } catch (_) { /* */ }
  return map;
}

function lineUnitCost(line, costMap) {
  const fromLine = Number(line.unit_cost_rial) || Number(line.cost_rial) || Number(line.cost) || 0;
  if (fromLine > 0) return fromLine;
  return costMap[Number(line.product_id) || 0] || 0;
}

/** بهای تمام‌شده فروش از خطوط فاکتور قطعی — هم‌تراز منطق /accounting/general. */
function sumCogsFromSales(db, filters) {
  const { where, params } = buildSalesWhere(filters, 'i');
  const costMap = productUnitCostMap(db);
  const wantPid = filters.product_id || 0;
  let cogs = 0;
  try {
    const invoices = db.prepare(`SELECT i.rows FROM invoices i WHERE ${where}`).all(...params);
    for (const inv of invoices) {
      let lines;
      try { lines = JSON.parse(inv.rows || '[]'); } catch (_) { continue; }
      if (!Array.isArray(lines)) continue;
      for (const l of lines) {
        const pid = Number(l.product_id) || 0;
        if (wantPid && pid !== wantPid) continue;
        cogs += (Number(l.qty) || 0) * lineUnitCost(l, costMap);
      }
    }
  } catch (_) { /* */ }
  return Math.round(cogs);
}

function sumSalesReturnCogs(db, filters) {
  if (!tableExists(db, 'sales_returns')) return 0;
  const alias = 'r';
  const where = [returnAliveSql(alias, db, 'sales_returns')];
  const params = [];
  if (filters.from) { where.push(`${alias}.date>=?`); params.push(filters.from); }
  if (filters.to) { where.push(`${alias}.date<=?`); params.push(filters.to); }
  if (filters.cust_id) { where.push(`${alias}.cust_id=?`); params.push(filters.cust_id); }
  if (filters.user_id && tableHasColumn(db, 'sales_returns', 'user_id')) {
    where.push(`${alias}.user_id=?`);
    params.push(filters.user_id);
  }
  if (tableHasColumn(db, 'sales_returns', 'cost_amount')) {
    try {
      const row = db.prepare(`
        SELECT COALESCE(SUM(COALESCE(${alias}.cost_amount,0)),0) AS c
        FROM sales_returns ${alias}
        WHERE ${where.join(' AND ')}
      `).get(...params);
      return Math.round(Number(row && row.c) || 0);
    } catch (_) { /* fall through */ }
  }
  // fallback: برآورد از خطوط برگشت × بهای کاتالوگ
  const costMap = productUnitCostMap(db);
  const wantPid = filters.product_id || 0;
  let cogs = 0;
  try {
    const rows = db.prepare(`SELECT ${alias}.rows FROM sales_returns ${alias} WHERE ${where.join(' AND ')}`).all(...params);
    for (const r of rows) {
      let lines;
      try { lines = JSON.parse(r.rows || '[]'); } catch (_) { continue; }
      if (!Array.isArray(lines)) continue;
      for (const l of lines) {
        const pid = Number(l.product_id) || 0;
        if (wantPid && pid !== wantPid) continue;
        cogs += (Number(l.qty) || 0) * lineUnitCost(l, costMap);
      }
    }
  } catch (_) { /* */ }
  return Math.round(cogs);
}

/** انگیزه فروش برآوردی — همان الگوی /accounting/general با فیلتر بازه/طرف. */
function sumCommissionExpense(db, filters) {
  const where = [commissionEligibleSql('i'), 'COALESCE(i.deleted_at,0)=0'];
  const params = [];
  if (filters.from) { where.push('i.date>=?'); params.push(filters.from); }
  if (filters.to) { where.push('i.date<=?'); params.push(filters.to); }
  if (filters.cust_id) { where.push('i.cust_id=?'); params.push(filters.cust_id); }
  if (filters.user_id) { where.push('i.user_id=?'); params.push(filters.user_id); }
  if (filters.warehouse_id && filters.hasInvWh) {
    where.push('i.warehouse_id=?');
    params.push(filters.warehouse_id);
  }
  const amt = rialExpr('i', 'final_rial', 'final');
  try {
    const users = db.prepare('SELECT id, commission_cash, commission_cheque FROM users WHERE active=1').all();
    let total = 0;
    for (const u of users) {
      if (filters.user_id && Number(u.id) !== filters.user_id) continue;
      const cash = db.prepare(`
        SELECT COALESCE(SUM(${amt}),0) s FROM invoices i
        WHERE ${where.join(' AND ')} AND i.user_id=? AND i.pay_type='cash'
      `).get(...params, u.id);
      const cheq = db.prepare(`
        SELECT COALESCE(SUM(${amt}),0) s FROM invoices i
        WHERE ${where.join(' AND ')} AND i.user_id=? AND i.pay_type='cheque'
      `).get(...params, u.id);
      total += (Number(cash && cash.s) || 0) * (Number(u.commission_cash) || 0) / 100;
      total += (Number(cheq && cheq.s) || 0) * (Number(u.commission_cheque) || 0) / 100;
    }
    return Math.round(total);
  } catch (_) {
    return 0;
  }
}

function marginPct(profit, sales) {
  const s = Number(sales) || 0;
  if (!s) return 0;
  return Math.round(((Number(profit) || 0) / s) * 1000) / 10;
}

function buildProfitBlock(db, filters, salesNet) {
  const cogsGross = sumCogsFromSales(db, filters);
  const cogsReturns = sumSalesReturnCogs(db, filters);
  const cogsNet = Math.max(0, cogsGross - cogsReturns);
  const grossProfit = Math.round(salesNet - cogsNet);
  const commission = sumCommissionExpense(db, filters);
  const netProfit = Math.round(grossProfit - commission);
  return {
    cogs_gross_rial: cogsGross,
    cogs_returns_rial: cogsReturns,
    cogs_rial: cogsNet,
    gross_profit_rial: grossProfit,
    gross_margin_pct: marginPct(grossProfit, salesNet),
    commission_rial: commission,
    net_profit_rial: netProfit,
    net_margin_pct: marginPct(netProfit, salesNet),
    method_note: 'سود ناخالص = فروش خالص − بهای تمام‌شده (qty×میانگین/بهای کالا، منهای بهای برگشت). سود خالص = سود ناخالص − برآورد انگیزه فروش (مثل صورت سود و زیان). خرید در سود مستقیم نیست (موجودی).',
  };
}

function monthlySeries(db, filters) {
  const salesW = buildSalesWhere(filters, 'i');
  const purW = buildPurchaseWhere(filters, 'p');
  const sAmt = rialExpr('i', 'final_rial', 'final');
  const hasFinalRial = tableHasColumn(db, 'purchase_invoices', 'final_rial');
  const pAmt = hasFinalRial
    ? rialExpr('p', 'final_rial', 'final')
    : 'COALESCE(ROUND(p.final),0)';
  const map = {};
  const ensure = (month) => {
    if (!map[month]) {
      map[month] = {
        month,
        sales_rial: 0,
        purchase_rial: 0,
        sales_count: 0,
        purchase_count: 0,
        cogs_rial: 0,
        net_profit_rial: 0,
      };
    }
    return map[month];
  };
  try {
    const sRows = db.prepare(`
      SELECT substr(i.date,1,7) AS month,
        COALESCE(SUM(${sAmt}),0) AS sales_rial,
        COUNT(*) AS sales_count
      FROM invoices i
      WHERE ${salesW.where}
      GROUP BY substr(i.date,1,7)
      ORDER BY month
    `).all(...salesW.params);
    for (const r of sRows) {
      const m = ensure(r.month);
      m.sales_rial = Math.round(Number(r.sales_rial) || 0);
      m.sales_count = Number(r.sales_count) || 0;
    }
  } catch (_) { /* */ }
  try {
    const pRows = db.prepare(`
      SELECT substr(p.date,1,7) AS month,
        COALESCE(SUM(${pAmt}),0) AS purchase_rial,
        COUNT(*) AS purchase_count
      FROM purchase_invoices p
      WHERE ${purW.where}
      GROUP BY substr(p.date,1,7)
      ORDER BY month
    `).all(...purW.params);
    for (const r of pRows) {
      const m = ensure(r.month);
      m.purchase_rial = Math.round(Number(r.purchase_rial) || 0);
      m.purchase_count = Number(r.purchase_count) || 0;
    }
  } catch (_) { /* */ }

  // COGS ماهانه از خطوط فاکتور (بدون انگیزه برای سبک بودن سری)
  const costMap = productUnitCostMap(db);
  const wantPid = filters.product_id || 0;
  try {
    const invs = db.prepare(`
      SELECT substr(i.date,1,7) AS month, i.rows
      FROM invoices i WHERE ${salesW.where}
    `).all(...salesW.params);
    for (const inv of invs) {
      let lines;
      try { lines = JSON.parse(inv.rows || '[]'); } catch (_) { continue; }
      if (!Array.isArray(lines)) continue;
      let cogs = 0;
      for (const l of lines) {
        const pid = Number(l.product_id) || 0;
        if (wantPid && pid !== wantPid) continue;
        cogs += (Number(l.qty) || 0) * lineUnitCost(l, costMap);
      }
      const m = ensure(inv.month);
      m.cogs_rial += Math.round(cogs);
    }
  } catch (_) { /* */ }
  for (const k of Object.keys(map)) {
    const m = map[k];
    m.cogs_rial = Math.round(m.cogs_rial || 0);
    m.net_profit_rial = Math.round((m.sales_rial || 0) - (m.cogs_rial || 0));
  }
  return Object.keys(map).sort().map((k) => map[k]);
}

function topCustomers(db, filters, limit) {
  const { where, params } = buildSalesWhere(filters, 'i');
  const amt = rialExpr('i', 'final_rial', 'final');
  try {
    return db.prepare(`
      SELECT c.id, c.biz AS name, COUNT(i.id) AS doc_count,
        COALESCE(SUM(${amt}),0) AS amount_rial
      FROM invoices i
      JOIN customers c ON c.id = i.cust_id
      WHERE ${where}
      GROUP BY c.id
      ORDER BY amount_rial DESC
      LIMIT ?
    `).all(...params, limit).map((r) => ({
      id: r.id,
      name: r.name,
      doc_count: Number(r.doc_count) || 0,
      amount_rial: Math.round(Number(r.amount_rial) || 0),
    }));
  } catch (_) {
    return [];
  }
}

function topSuppliers(db, filters, limit) {
  const { where, params } = buildPurchaseWhere(filters, 'p');
  const hasFinalRial = tableHasColumn(db, 'purchase_invoices', 'final_rial');
  const amt = hasFinalRial
    ? rialExpr('p', 'final_rial', 'final')
    : 'COALESCE(ROUND(p.final),0)';
  try {
    return db.prepare(`
      SELECT s.id, s.name, COUNT(p.id) AS doc_count,
        COALESCE(SUM(${amt}),0) AS amount_rial
      FROM purchase_invoices p
      JOIN suppliers s ON s.id = p.supplier_id
      WHERE ${where}
      GROUP BY s.id
      ORDER BY amount_rial DESC
      LIMIT ?
    `).all(...params, limit).map((r) => ({
      id: r.id,
      name: r.name,
      doc_count: Number(r.doc_count) || 0,
      amount_rial: Math.round(Number(r.amount_rial) || 0),
    }));
  } catch (_) {
    return [];
  }
}

function topReps(db, filters, limit) {
  const { where, params } = buildSalesWhere(filters, 'i');
  const amt = rialExpr('i', 'final_rial', 'final');
  try {
    return db.prepare(`
      SELECT u.id, COALESCE(u.name, u.username, '—') AS name,
        COUNT(i.id) AS doc_count,
        COALESCE(SUM(${amt}),0) AS amount_rial
      FROM invoices i
      LEFT JOIN users u ON u.id = i.user_id
      WHERE ${where}
      GROUP BY i.user_id
      ORDER BY amount_rial DESC
      LIMIT ?
    `).all(...params, limit).map((r) => ({
      id: r.id,
      name: r.name,
      doc_count: Number(r.doc_count) || 0,
      amount_rial: Math.round(Number(r.amount_rial) || 0),
    }));
  } catch (_) {
    return [];
  }
}

function aggregateProducts(db, filters, limit) {
  const { where, params } = buildSalesWhere(filters, 'i');
  let invoices;
  try {
    invoices = db.prepare(`SELECT i.rows FROM invoices i WHERE ${where}`).all(...params);
  } catch (_) {
    return [];
  }
  const by = {};
  const wantPid = filters.product_id || 0;
  for (const inv of invoices) {
    let lines;
    try { lines = JSON.parse(inv.rows || '[]'); } catch (_) { continue; }
    if (!Array.isArray(lines)) continue;
    for (const l of lines) {
      const pid = Number(l.product_id) || 0;
      if (wantPid && pid !== wantPid) continue;
      const key = pid || String(l.name || 'unknown');
      if (!by[key]) {
        by[key] = {
          product_id: pid || null,
          name: l.name || ('کالا #' + (pid || '?')),
          qty: 0,
          amount_rial: 0,
        };
      }
      by[key].qty += Number(l.qty) || 0;
      by[key].amount_rial += Math.round(Number(l.sum) || ((Number(l.price) || 0) * (Number(l.qty) || 0)) || 0);
    }
  }
  return Object.values(by)
    .sort((a, b) => b.amount_rial - a.amount_rial)
    .slice(0, limit)
    .map((r) => ({
      ...r,
      qty: Math.round(r.qty * 1000) / 1000,
      amount_rial: Math.round(r.amount_rial),
    }));
}

function mapSalesDoc(r) {
  return {
    kind: 'sales',
    id: r.id,
    num: r.num,
    date: r.date,
    type: r.type,
    party_id: r.party_id || null,
    party_name: r.party_name || '—',
    amount_rial: Math.round(Number(r.amount_rial) || 0),
    open_action: 'invoice',
    nav: 'acc-sales-invoices',
  };
}

function mapPurchaseDoc(r) {
  return {
    kind: 'purchase',
    id: r.id,
    num: r.num,
    date: r.date,
    type: 'purchase',
    party_id: r.party_id || null,
    party_name: r.party_name || '—',
    amount_rial: Math.round(Number(r.amount_rial) || 0),
    open_action: 'purchase',
    nav: 'acc-purchases',
  };
}

function listSalesDocs(db, filters, limit) {
  const salesW = buildSalesWhere(filters, 'i');
  const sAmt = rialExpr('i', 'final_rial', 'final');
  try {
    return db.prepare(`
      SELECT i.id, i.num, i.date, i.type, i.cust_id AS party_id,
        ${sAmt} AS amount_rial, c.biz AS party_name
      FROM invoices i
      LEFT JOIN customers c ON c.id = i.cust_id
      WHERE ${salesW.where}
      ORDER BY i.date DESC, i.id DESC
      LIMIT ?
    `).all(...salesW.params, limit).map(mapSalesDoc);
  } catch (_) {
    return [];
  }
}

function listPurchaseDocs(db, filters, limit) {
  const purW = buildPurchaseWhere(filters, 'p');
  const hasFinalRial = tableHasColumn(db, 'purchase_invoices', 'final_rial');
  const pAmt = hasFinalRial
    ? rialExpr('p', 'final_rial', 'final')
    : 'COALESCE(ROUND(p.final),0)';
  try {
    return db.prepare(`
      SELECT p.id, p.num, p.date, p.supplier_id AS party_id,
        ${pAmt} AS amount_rial, s.name AS party_name
      FROM purchase_invoices p
      LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE ${purW.where}
      ORDER BY p.date DESC, p.id DESC
      LIMIT ?
    `).all(...purW.params, limit).map(mapPurchaseDoc);
  } catch (_) {
    return [];
  }
}

function recentDocs(db, filters, limit) {
  const half = Math.max(4, Math.ceil(limit / 2));
  const out = [...listSalesDocs(db, filters, half), ...listPurchaseDocs(db, filters, half)];
  out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || (b.id - a.id));
  return out.slice(0, limit);
}

/** اسناد فروش که شامل product_id هستند — مبلغ ردیف همان کالا. */
function listSalesDocsForProduct(db, filters, productId, limit) {
  const salesW = buildSalesWhere(filters, 'i');
  const sAmt = rialExpr('i', 'final_rial', 'final');
  let rows;
  try {
    rows = db.prepare(`
      SELECT i.id, i.num, i.date, i.type, i.cust_id AS party_id, i.rows,
        ${sAmt} AS amount_rial, c.biz AS party_name
      FROM invoices i
      LEFT JOIN customers c ON c.id = i.cust_id
      WHERE ${salesW.where}
      ORDER BY i.date DESC, i.id DESC
    `).all(...salesW.params);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const r of rows) {
    let lines;
    try { lines = JSON.parse(r.rows || '[]'); } catch (_) { continue; }
    if (!Array.isArray(lines)) continue;
    let lineSum = 0;
    let hit = false;
    for (const l of lines) {
      if (Number(l.product_id) !== productId) continue;
      hit = true;
      lineSum += Math.round(Number(l.sum) || ((Number(l.price) || 0) * (Number(l.qty) || 0)) || 0);
    }
    if (!hit) continue;
    out.push(mapSalesDoc({
      ...r,
      amount_rial: lineSum || r.amount_rial,
    }));
    if (out.length >= limit) break;
  }
  return out;
}

function resolveDrillTitle(db, drillType, drillId) {
  try {
    if (drillType === 'customer') {
      const r = db.prepare('SELECT biz AS name FROM customers WHERE id=?').get(drillId);
      return r && r.name ? ('مشتری: ' + r.name) : ('مشتری #' + drillId);
    }
    if (drillType === 'supplier') {
      const r = db.prepare('SELECT name FROM suppliers WHERE id=?').get(drillId);
      return r && r.name ? ('تأمین‌کننده: ' + r.name) : ('تأمین‌کننده #' + drillId);
    }
    if (drillType === 'product') {
      const r = db.prepare('SELECT name, code FROM products WHERE id=?').get(drillId);
      if (!r) return 'کالا #' + drillId;
      return 'کالا: ' + (r.code ? (r.code + ' · ') : '') + (r.name || '');
    }
    if (drillType === 'rep') {
      const r = db.prepare('SELECT COALESCE(name, username) AS name FROM users WHERE id=?').get(drillId);
      return r && r.name ? ('کارشناس: ' + r.name) : ('کارشناس #' + drillId);
    }
  } catch (_) { /* */ }
  if (drillType === 'sales') return 'همه فاکتورهای فروش بازه';
  if (drillType === 'purchase') return 'همه فاکتورهای خرید بازه';
  return 'جزئیات';
}

/**
 * Drill سطح ۱: KPI/بعد → لیست اسناد تراکنشی (با حفظ فیلترهای داشبورد).
 * drill_type: customer|supplier|product|rep|sales|purchase
 */
function buildDrill(db, filters, drillType, drillId, limit) {
  const type = String(drillType || '').trim().toLowerCase();
  if (!type) return null;
  const id = toInt(drillId);
  const title = resolveDrillTitle(db, type, id);
  let docs = [];
  if (type === 'customer') {
    if (!id) return null;
    docs = listSalesDocs(db, { ...filters, cust_id: id }, limit);
  } else if (type === 'supplier') {
    if (!id) return null;
    docs = listPurchaseDocs(db, { ...filters, supplier_id: id }, limit);
  } else if (type === 'rep') {
    if (!id) return null;
    docs = listSalesDocs(db, { ...filters, user_id: id }, limit);
  } else if (type === 'product') {
    if (!id) return null;
    docs = listSalesDocsForProduct(db, filters, id, limit);
  } else if (type === 'sales') {
    docs = listSalesDocs(db, filters, limit);
  } else if (type === 'purchase') {
    docs = listPurchaseDocs(db, filters, limit);
  } else {
    return null;
  }
  const total_rial = docs.reduce((a, d) => a + (d.amount_rial || 0), 0);
  return {
    type,
    id: id || null,
    title,
    count: docs.length,
    total_rial: Math.round(total_rial),
    docs,
    open_hint: type === 'purchase' || (docs[0] && docs[0].kind === 'purchase')
      ? 'باز کردن = پیش‌نمایش چاپ فاکتور خرید'
      : 'باز کردن = فرم/جزئیات فاکتور فروش',
  };
}

function buildAlerts(kpis, comparison, topCustomersList) {
  const alerts = [];
  const sales = kpis.sales_net_rial || 0;
  const purchase = kpis.purchase_net_rial || 0;
  if (sales > 0 && purchase > sales * 1.15) {
    alerts.push({
      severity: 'warn',
      title: 'خرید بالاتر از فروش خالص',
      detail: 'در این بازه خرید خالص بیش از ۱۵٪ از فروش خالص بیشتر است — نقدینگی و موجودی را بررسی کنید.',
      action_nav: 'acc-purchases',
    });
  }
  if ((kpis.returns_sales_rial || 0) > 0 && sales > 0
      && (kpis.returns_sales_rial / (sales + kpis.returns_sales_rial)) > 0.08) {
    alerts.push({
      severity: 'warn',
      title: 'نرخ برگشت فروش بالا',
      detail: 'برگشت از فروش بیش از ۸٪ فروش ناخالص دوره است.',
      action_nav: 'acc-sales-returns',
    });
  }
  if ((comparison.sales_delta_pct || 0) <= -15) {
    alerts.push({
      severity: 'fail',
      title: 'افت فروش نسبت به دوره قبل',
      detail: `فروش ${comparison.sales_delta_pct}٪ نسبت به دورهٔ هم‌طول قبلی کاهش یافته.`,
      action_nav: 'acc-sales-invoices',
    });
  } else if ((comparison.sales_delta_pct || 0) >= 20) {
    alerts.push({
      severity: 'ok',
      title: 'رشد فروش دوره',
      detail: `فروش ${comparison.sales_delta_pct}٪ نسبت به دوره قبل رشد داشته.`,
      action_nav: 'acc-sales-invoices',
    });
  }
  if ((kpis.net_profit_rial || 0) < 0 && (kpis.sales_net_rial || 0) > 0) {
    alerts.push({
      severity: 'fail',
      title: 'سود خالص منفی',
      detail: 'پس از کسر بهای تمام‌شده و برآورد انگیزه، دوره زیان‌ده است.',
      action_nav: 'acc-pl-statement',
    });
  } else if ((kpis.gross_margin_pct || 0) > 0 && (kpis.gross_margin_pct || 0) < 10 && (kpis.sales_net_rial || 0) > 0) {
    alerts.push({
      severity: 'warn',
      title: 'حاشیه ناخالص پایین',
      detail: `حاشیه ناخالص حدود ${kpis.gross_margin_pct}٪ است — بها یا قیمت فروش را بررسی کنید.`,
      action_nav: 'acc-pl-statement',
    });
  }
  const topShare = topCustomersList[0] && sales > 0
    ? Math.round((topCustomersList[0].amount_rial / sales) * 1000) / 10
    : 0;
  if (topShare >= 40) {
    alerts.push({
      severity: 'medium',
      title: 'تمرکز مشتری',
      detail: `بزرگ‌ترین مشتری حدود ${topShare}٪ فروش دوره را دارد.`,
      action_nav: 'acc-receivables',
    });
  }
  if (!sales && !purchase) {
    alerts.push({
      severity: 'warn',
      title: 'بدون سند در بازه',
      detail: 'در این فیلتر فاکتور فروش یا خریدی نیست — بازه یا فیلترها را عوض کنید.',
      action_nav: 'acc-sales-purchase-dashboard',
    });
  }
  return alerts;
}

function healthScore(kpis, alerts) {
  let score = 100;
  for (const a of alerts) {
    if (a.severity === 'fail') score -= 20;
    else if (a.severity === 'warn' || a.severity === 'medium') score -= 10;
  }
  if ((kpis.sales_net_rial || 0) > (kpis.purchase_net_rial || 0)) score = Math.min(100, score + 5);
  return Math.max(0, Math.min(100, score));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} query
 */
function buildSalesPurchaseDashboard(db, query = {}) {
  const from = String(query.from || '').trim();
  const to = String(query.to || '').trim() || (from ? todayJalali() : '');
  const filters = {
    from,
    to,
    cust_id: toInt(query.cust_id),
    supplier_id: toInt(query.supplier_id),
    user_id: toInt(query.user_id),
    warehouse_id: toInt(query.warehouse_id),
    product_id: toInt(query.product_id),
    hasInvWh: tableHasColumn(db, 'invoices', 'warehouse_id'),
    hasPurWh: tableHasColumn(db, 'purchase_invoices', 'warehouse_id'),
  };
  const limit = Math.min(Math.max(toInt(query.limit) || 10, 5), 50);
  const drillLimit = Math.min(Math.max(toInt(query.drill_limit) || 40, 10), 100);
  const drillType = String(query.drill_type || '').trim().toLowerCase();
  const drillId = toInt(query.drill_id);

  const sales = sumSales(db, filters);
  const purchases = sumPurchases(db, filters);
  const sRet = sumReturns(db, 'sales_returns', 'cust_id', filters, 'sales');
  const pRet = sumReturns(db, 'purchase_returns', 'supplier_id', filters, 'purchase');

  const salesNet = Math.max(0, sales.gross_rial - sRet.amount_rial);
  const purchaseNet = Math.max(0, purchases.gross_rial - pRet.amount_rial);

  const prior = priorPeriod(from, to || todayJalali());
  const priorFilters = { ...filters, from: prior.from, to: prior.to };
  const priorSales = prior.from ? sumSales(db, priorFilters) : { gross_rial: 0, count: 0 };
  const priorPurchases = prior.from ? sumPurchases(db, priorFilters) : { gross_rial: 0, count: 0 };
  const priorSRet = prior.from
    ? sumReturns(db, 'sales_returns', 'cust_id', priorFilters, 'sales')
    : { amount_rial: 0 };
  const priorPRet = prior.from
    ? sumReturns(db, 'purchase_returns', 'supplier_id', priorFilters, 'purchase')
    : { amount_rial: 0 };
  const priorSalesNet = Math.max(0, priorSales.gross_rial - priorSRet.amount_rial);
  const priorPurchaseNet = Math.max(0, priorPurchases.gross_rial - priorPRet.amount_rial);
  const profit = buildProfitBlock(db, filters, salesNet);
  const priorProfit = prior.from
    ? buildProfitBlock(db, priorFilters, priorSalesNet)
    : { net_profit_rial: 0, gross_profit_rial: 0, cogs_rial: 0 };

  const comparison = {
    prior_from: prior.from,
    prior_to: prior.to,
    prior_sales_rial: priorSalesNet,
    prior_purchase_rial: priorPurchaseNet,
    prior_net_profit_rial: priorProfit.net_profit_rial || 0,
    prior_gross_profit_rial: priorProfit.gross_profit_rial || 0,
    sales_delta_pct: pctDelta(salesNet, priorSalesNet),
    purchase_delta_pct: pctDelta(purchaseNet, priorPurchaseNet),
    net_profit_delta_pct: pctDelta(profit.net_profit_rial, priorProfit.net_profit_rial),
    gross_profit_delta_pct: pctDelta(profit.gross_profit_rial, priorProfit.gross_profit_rial),
  };

  const kpis = {
    sales_gross_rial: sales.gross_rial,
    sales_net_rial: salesNet,
    sales_count: sales.count,
    sales_avg_rial: sales.count ? Math.round(salesNet / sales.count) : 0,
    purchase_gross_rial: purchases.gross_rial,
    purchase_net_rial: purchaseNet,
    purchase_count: purchases.count,
    purchase_avg_rial: purchases.count ? Math.round(purchaseNet / purchases.count) : 0,
    trade_gap_rial: salesNet - purchaseNet,
    returns_sales_rial: sRet.amount_rial,
    returns_sales_count: sRet.count,
    returns_purchase_rial: pRet.amount_rial,
    returns_purchase_count: pRet.count,
    discount_rial: sales.discount_rial,
    vat_sales_rial: sales.vat_rial,
    vat_purchase_rial: purchases.vat_rial,
    vat_net_rial: sales.vat_rial - purchases.vat_rial - sRet.vat_rial + pRet.vat_rial,
    cogs_rial: profit.cogs_rial,
    cogs_gross_rial: profit.cogs_gross_rial,
    cogs_returns_rial: profit.cogs_returns_rial,
    gross_profit_rial: profit.gross_profit_rial,
    gross_margin_pct: profit.gross_margin_pct,
    commission_rial: profit.commission_rial,
    net_profit_rial: profit.net_profit_rial,
    net_margin_pct: profit.net_margin_pct,
  };

  const byCustomer = topCustomers(db, filters, limit);
  const bySupplier = topSuppliers(db, filters, limit);
  const byRep = topReps(db, filters, limit);
  const byProduct = aggregateProducts(db, filters, limit);
  const monthly = monthlySeries(db, filters);
  const recent = recentDocs(db, filters, 16);
  const drill = drillType
    ? buildDrill(db, filters, drillType, drillId, drillLimit)
    : null;
  const alerts = buildAlerts(kpis, comparison, byCustomer);
  const health = healthScore(kpis, alerts);

  const totalCust = byCustomer.reduce((a, r) => a + r.amount_rial, 0) || salesNet || 1;
  const top3 = byCustomer.slice(0, 3).reduce((a, r) => a + r.amount_rial, 0);
  const concentration = {
    top3_pct: Math.round((top3 / totalCust) * 1000) / 10,
    top_name: (byCustomer[0] && byCustomer[0].name) || '—',
    top_pct: byCustomer[0]
      ? Math.round((byCustomer[0].amount_rial / totalCust) * 1000) / 10
      : 0,
  };

  return {
    generated_at: new Date().toISOString(),
    from: from || '',
    to: to || '',
    currency: 'IRR',
    unit_note: 'مبالغ به ریال — فاکتور قطعی فروش (معمولی/رسمی) و فاکتور خرید زنده؛ برگشت‌های فعال از خالص کسر شده‌اند. سود خالص = فروش خالص − COGS − برآورد انگیزه (مثل صورت سود و زیان). خرید موجودی است و مستقیم از سود کم نمی‌شود. Drill: KPI/بعد → اسناد → باز کردن فاکتور.',
    filters_applied: {
      cust_id: filters.cust_id || null,
      supplier_id: filters.supplier_id || null,
      user_id: filters.user_id || null,
      warehouse_id: filters.warehouse_id || null,
      product_id: filters.product_id || null,
    },
    health_score: health,
    kpis,
    profit,
    comparison,
    concentration,
    monthly,
    by_customer: byCustomer.map((r) => ({
      ...r,
      share_pct: Math.round((r.amount_rial / totalCust) * 1000) / 10,
      drill_type: 'customer',
      drill_id: r.id,
    })),
    by_supplier: bySupplier.map((r) => ({
      ...r,
      drill_type: 'supplier',
      drill_id: r.id,
    })),
    by_rep: byRep.map((r) => ({
      ...r,
      drill_type: 'rep',
      drill_id: r.id,
    })),
    by_product: byProduct.map((r) => ({
      ...r,
      drill_type: 'product',
      drill_id: r.product_id,
    })),
    recent_docs: recent,
    drill,
    alerts,
  };
}

module.exports = { buildSalesPurchaseDashboard, buildDrill };
