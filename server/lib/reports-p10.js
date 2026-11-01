'use strict';
/**
 * P10 — گزارش سریع حرکت کالا (فروش/برگشت/خرید) + سود و زیان روزانهٔ تقریبی.
 * فقط‌خواندنی (SELECT). مبالغ به ریال.
 *
 * - buildQuickItemMovement: تعداد فروش/برگشت فروش/خرید/برگشت خرید به تفکیک کالا × رنگ/سایز،
 *   از سطرهای اسناد زنده. مبالغ فروش با sales_amount:view یا cost_visibility:view؛ مبالغ خرید فقط cost_visibility:view.
 * - buildDailyPnl: فروش خالص (بدون ارزش افزوده) − COGS (کاردکس زنده ← سند COGS ← برآورد)
 *   = سود ناخالص؛ − هزینه‌های ثبت/تأییدشدهٔ دوره = سود عملیاتی ساده. «تقریبی؛ قبل از بستن دوره».
 */

const { firmSaleTypeSql } = require('./sales-document');
const { todayJalali } = require('../jalali');
const { LEDGER_LIVE_SQL } = require('./inventory/layer-reconcile');
const { COGS_JE_REF_TYPES, cogsAccountCodes } = require('./inventory/cogs-per-invoice');
const { jlDebitRial, jlCreditRial } = require('./money');
const { jeNotDraftSql } = require('./je-live');

const APPROX_LABEL = 'تقریبی؛ قبل از بستن دوره';
const SALE_LEDGER_SOURCES = ['invoice', 'sale', 'sales_invoice'];
/** expense_payments زنده: posted (فعلی) یا approved (فرم تأیید هزینهٔ P8). */
const EXPENSE_LIVE_STATUSES = ['posted', 'approved'];
const DATE_RE = /^\d{4}\/\d{2}\/\d{2}$/;

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (_) {
    return false;
  }
}

function colSet(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  } catch (_) {
    return new Set();
  }
}

const num = (v) => Number(v) || 0;
const r3 = (v) => Math.round(num(v) * 1000) / 1000;

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function badRequest(message, code) {
  const e = new Error(message);
  e.status = 400;
  e.code = code;
  return e;
}

/** date | from&to → {from,to}; پیش‌فرض امروز. */
function resolveRange(query) {
  const q = query || {};
  let from = String(q.date || q.from || '').trim();
  let to = String(q.date || q.to || '').trim();
  if (!from && !to) { from = todayJalali(); to = from; }
  if (!from) from = to;
  if (!to) to = from;
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw badRequest('تاریخ باید به شکل ۱۴۰۵/۰۸/۱۰ باشد', 'E_P10_DATE');
  if (from > to) throw badRequest('تاریخ شروع بعد از تاریخ پایان است', 'E_P10_RANGE');
  return { from, to };
}

function parseRows(json) {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

function lineAmount(l) {
  const s = Number(l.sum);
  if (Number.isFinite(s) && s !== 0) return Math.round(s);
  return Math.round(num(l.price) * num(l.qty));
}

/** شرط کاربر شعبه (users.branch_id) روی ستون کاربر سند. */
function branchSql(col, branchId) {
  if (!branchId) return { sql: '', params: [] };
  return { sql: ` AND ${col} IN (SELECT id FROM users WHERE branch_id=?)`, params: [branchId] };
}

function salesWhere(db, f, alias = 'i') {
  const where = [firmSaleTypeSql(alias), `COALESCE(${alias}.deleted_at,0)=0`, `${alias}.date>=?`, `${alias}.date<=?`];
  const params = [f.from, f.to];
  const cols = colSet(db, 'invoices');
  if (cols.has('status')) where.push(`COALESCE(${alias}.status,'') NOT IN ('reversed','void','cancelled')`);
  if (f.headerWarehouse && f.warehouse_id && cols.has('warehouse_id')) {
    where.push(`${alias}.warehouse_id=?`);
    params.push(f.warehouse_id);
  }
  const b = branchSql(`${alias}.user_id`, f.branch_id);
  return { sql: where.join(' AND ') + b.sql, params: [...params, ...b.params] };
}

function docWhere(db, table, f, alias, userCol) {
  const cols = colSet(db, table);
  const where = [`${alias}.date>=?`, `${alias}.date<=?`];
  const params = [f.from, f.to];
  if (cols.has('status')) where.push(`COALESCE(${alias}.status,'posted') NOT IN ('reversed','void','cancelled','draft')`);
  if (cols.has('deleted_at')) where.push(`COALESCE(${alias}.deleted_at,0)=0`);
  if (f.headerWarehouse && f.warehouse_id && cols.has('warehouse_id')) {
    where.push(`${alias}.warehouse_id=?`);
    params.push(f.warehouse_id);
  }
  const b = cols.has(userCol) ? branchSql(`${alias}.${userCol}`, f.branch_id) : { sql: '', params: [] };
  return { sql: where.join(' AND ') + b.sql, params: [...params, ...b.params] };
}

// ────────────────────────────────────────────────────────────────────────────
// گزارش سریع حرکت کالا
// ────────────────────────────────────────────────────────────────────────────

const MOVE_KINDS = {
  sale: { qty: 'sold_qty', amount: 'sales_amount_rial' },
  sale_return: { qty: 'returned_qty', amount: 'returns_amount_rial' },
  purchase: { qty: 'purchased_qty', amount: 'purchase_amount_rial' },
  purchase_return: { qty: 'purchase_returned_qty', amount: 'purchase_returns_amount_rial' },
};

/**
 * showAmounts (cost_visibility:view) → همهٔ مبالغ؛ showSalesAmounts (sales_amount:view) → فقط مبالغ فروش/برگشت فروش.
 * مبالغ خرید/برگشت خرید فقط با showAmounts.
 */
function buildQuickItemMovement(db, query = {}, { showAmounts = false, showSalesAmounts = false } = {}) {
  const showSale = !!(showAmounts || showSalesAmounts);
  const showPurchase = !!showAmounts;
  const { from, to } = resolveRange(query);
  const type = ['sale', 'purchase', 'both'].includes(String(query.type || '')) ? String(query.type) : 'both';
  const f = {
    from, to,
    warehouse_id: toInt(query.warehouse_id),
    branch_id: toInt(query.branch_id || query.branch),
    product_id: toInt(query.product_id),
  };
  const search = String(query.q || '').trim().toLowerCase();
  const by = new Map();

  const add = (kind, header, l) => {
    const pid = toInt(l.product_id);
    if (!pid) return;
    if (f.product_id && pid !== f.product_id) return;
    const wh = toInt(l.warehouse_id) || toInt(header.warehouse_id) || null;
    if (f.warehouse_id && wh !== f.warehouse_id) return;
    const vid = toInt(l.variant_id) || null;
    const key = `${pid}:${vid || 0}`;
    let row = by.get(key);
    if (!row) {
      row = {
        product_id: pid, variant_id: vid, name: l.name || '',
        color_name: l.color_name || l.color || '', size_name: l.size_name || l.size || '',
        sold_qty: 0, returned_qty: 0, purchased_qty: 0, purchase_returned_qty: 0,
        sales_amount_rial: 0, returns_amount_rial: 0, purchase_amount_rial: 0, purchase_returns_amount_rial: 0,
        docs: new Set(),
      };
      by.set(key, row);
    }
    const k = MOVE_KINDS[kind];
    row[k.qty] += num(l.qty);
    row[k.amount] += lineAmount(l);
    row.docs.add(`${kind}:${header.id}`);
  };

  const scan = (kind, sql, params) => {
    for (const d of db.prepare(sql).all(...params)) {
      for (const l of parseRows(d.rows)) add(kind, d, l);
    }
  };

  if (type !== 'purchase') {
    const sw = salesWhere(db, f, 'i');
    scan('sale', `SELECT i.id, i.warehouse_id, i.rows FROM invoices i WHERE ${sw.sql}`, sw.params);
    if (tableExists(db, 'sales_returns')) {
      const rw = docWhere(db, 'sales_returns', f, 'r', 'user_id');
      const hasWh = colSet(db, 'invoices').has('warehouse_id');
      scan('sale_return', `SELECT r.id, ${hasWh ? 'inv.warehouse_id' : 'NULL'} AS warehouse_id, r.rows
        FROM sales_returns r LEFT JOIN invoices inv ON inv.id=r.invoice_id WHERE ${rw.sql}`, rw.params);
    }
  }
  if (type !== 'sale') {
    if (tableExists(db, 'purchase_invoices')) {
      const pw = docWhere(db, 'purchase_invoices', f, 'p', 'user_id');
      const hasWh = colSet(db, 'purchase_invoices').has('warehouse_id');
      scan('purchase', `SELECT p.id, ${hasWh ? 'p.warehouse_id' : 'NULL AS warehouse_id'}, p.rows FROM purchase_invoices p WHERE ${pw.sql}`, pw.params);
    }
    if (tableExists(db, 'purchase_returns')) {
      const prw = docWhere(db, 'purchase_returns', f, 'r', 'user_id');
      const hasWh = colSet(db, 'purchase_invoices').has('warehouse_id');
      scan('purchase_return', `SELECT r.id, ${hasWh ? 'pi.warehouse_id' : 'NULL'} AS warehouse_id, r.rows
        FROM purchase_returns r LEFT JOIN purchase_invoices pi ON pi.id=r.purchase_invoice_id WHERE ${prw.sql}`, prw.params);
    }
  }

  // نام/کد کالا و SKU رنگ/سایز از جدول مرجع
  const pIds = [...new Set([...by.values()].map((r) => r.product_id))];
  const prodMap = new Map();
  for (let i = 0; i < pIds.length; i += 500) {
    const chunk = pIds.slice(i, i + 500);
    for (const p of db.prepare(`SELECT id, name, code FROM products WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk)) {
      prodMap.set(p.id, p);
    }
  }
  const vIds = [...new Set([...by.values()].map((r) => r.variant_id).filter(Boolean))];
  const varMap = new Map();
  if (vIds.length && tableExists(db, 'product_variants')) {
    for (let i = 0; i < vIds.length; i += 500) {
      const chunk = vIds.slice(i, i + 500);
      for (const v of db.prepare(`SELECT id, sku FROM product_variants WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk)) {
        varMap.set(v.id, v);
      }
    }
  }

  let rows = [...by.values()].map((r) => {
    const p = prodMap.get(r.product_id) || {};
    const v = r.variant_id ? varMap.get(r.variant_id) : null;
    const out = {
      product_id: r.product_id,
      variant_id: r.variant_id,
      code: p.code || '',
      name: p.name || r.name || ('کالا #' + r.product_id),
      sku: (v && v.sku) || '',
      color_name: r.color_name,
      size_name: r.size_name,
      sold_qty: r3(r.sold_qty),
      returned_qty: r3(r.returned_qty),
      net_sold_qty: r3(r.sold_qty - r.returned_qty),
      purchased_qty: r3(r.purchased_qty),
      purchase_returned_qty: r3(r.purchase_returned_qty),
      net_purchased_qty: r3(r.purchased_qty - r.purchase_returned_qty),
      doc_count: r.docs.size,
    };
    if (showSale) {
      out.sales_amount_rial = Math.round(r.sales_amount_rial);
      out.returns_amount_rial = Math.round(r.returns_amount_rial);
      out.net_sales_amount_rial = Math.round(r.sales_amount_rial - r.returns_amount_rial);
    }
    if (showPurchase) {
      out.purchase_amount_rial = Math.round(r.purchase_amount_rial);
      out.purchase_returns_amount_rial = Math.round(r.purchase_returns_amount_rial);
    }
    return out;
  });
  if (search) {
    rows = rows.filter((r) => [r.name, r.code, r.sku, r.color_name, r.size_name]
      .some((s) => String(s || '').toLowerCase().includes(search)));
  }
  rows.sort((a, b) => (b.sold_qty + b.purchased_qty) - (a.sold_qty + a.purchased_qty)
    || String(a.name).localeCompare(String(b.name), 'fa') || (a.variant_id || 0) - (b.variant_id || 0));

  const totals = rows.reduce((t, r) => {
    for (const k of ['sold_qty', 'returned_qty', 'net_sold_qty', 'purchased_qty', 'purchase_returned_qty', 'net_purchased_qty']) t[k] = r3(t[k] + r[k]);
    if (showSale) {
      for (const k of ['sales_amount_rial', 'returns_amount_rial', 'net_sales_amount_rial']) t[k] = (t[k] || 0) + r[k];
    }
    if (showPurchase) {
      for (const k of ['purchase_amount_rial', 'purchase_returns_amount_rial']) t[k] = (t[k] || 0) + r[k];
    }
    return t;
  }, { sold_qty: 0, returned_qty: 0, net_sold_qty: 0, purchased_qty: 0, purchase_returned_qty: 0, net_purchased_qty: 0 });

  return {
    generated_at: new Date().toISOString(),
    from, to, type,
    filters: { warehouse_id: f.warehouse_id || null, branch_id: f.branch_id || null, product_id: f.product_id || null, q: search || null },
    amounts_visible: showSale || showPurchase,
    sales_amounts_visible: showSale,
    purchase_amounts_visible: showPurchase,
    unit_note: showPurchase
      ? 'تعداد از سطرهای اسناد زنده (فاکتور قطعی فروش، برگشت فروش، فاکتور خرید، برگشت خرید). مبلغ = جمع سطر قبل از تخفیف سربرگ و ارزش افزوده (ریال).'
      : showSale
        ? 'مبلغ فروش/برگشت فروش = جمع سطر قبل از تخفیف سربرگ و ارزش افزوده (ریال). مبلغ خرید نیاز به مجوز «مشاهدهٔ بها/سود» دارد.'
        : 'فقط تعداد نمایش داده می‌شود؛ مبلغ فروش نیاز به مجوز «مشاهدهٔ مبلغ فروش» و مبلغ خرید نیاز به «مشاهدهٔ بها/سود» دارد.',
    count: rows.length,
    totals,
    rows,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// سود و زیان روزانه
// ────────────────────────────────────────────────────────────────────────────

function rialCol(cols, alias, rialName, baseName) {
  if (cols.has(rialName)) return `COALESCE(NULLIF(${alias}.${rialName},0), ROUND(COALESCE(${alias}.${baseName},0)), 0)`;
  if (cols.has(baseName)) return `ROUND(COALESCE(${alias}.${baseName},0))`;
  return '0';
}

function productCostMap(db) {
  const cols = colSet(db, 'products');
  const expr = cols.has('average_cost_rial') ? 'COALESCE(NULLIF(average_cost_rial,0), ROUND(COALESCE(cost,0)), 0)' : 'ROUND(COALESCE(cost,0))';
  const m = new Map();
  for (const p of db.prepare(`SELECT id, ${expr} AS c FROM products`).all()) m.set(p.id, num(p.c));
  return m;
}

function emptyDay(date) {
  return {
    date,
    invoice_count: 0, sales_gross_rial: 0, sales_vat_rial: 0, sales_ex_vat_rial: 0,
    returns_count: 0, returns_rial: 0, net_sales_rial: 0,
    cogs_sales_rial: 0, cogs_returns_rial: 0, cogs_rial: 0, gross_profit_rial: 0,
    expenses_rial: 0, operating_profit_rial: 0,
  };
}

function buildDailyPnl(db, query = {}) {
  const { from, to } = resolveRange(query);
  const f = {
    from, to, headerWarehouse: true,
    warehouse_id: toInt(query.warehouse_id),
    branch_id: toInt(query.branch_id || query.branch),
  };
  const days = new Map();
  const day = (d) => {
    const k = String(d || '').slice(0, 10);
    if (!days.has(k)) days.set(k, emptyDay(k));
    return days.get(k);
  };

  // ── فروش (بدون ارزش افزوده) ──
  const invCols = colSet(db, 'invoices');
  const sw = salesWhere(db, f, 'i');
  const finalExpr = rialCol(invCols, 'i', 'final_rial', 'final');
  const vatExpr = rialCol(invCols, 'i', 'vat_amount_rial', 'vat_amount');
  const invoices = db.prepare(`SELECT i.id, i.date, i.rows, ${finalExpr} AS final_rial, ${vatExpr} AS vat_rial FROM invoices i WHERE ${sw.sql}`).all(...sw.params);

  // ── COGS فروش: کاردکس زنده ← سند COGS دفتر ← برآورد qty×میانگین ──
  const kardex = new Map();
  if (tableExists(db, 'inventory_ledger')) {
    const ph = SALE_LEDGER_SOURCES.map(() => '?').join(',');
    for (const r of db.prepare(`
      SELECT source_id, SUM(COALESCE(amount_rial,0)) AS amt
      FROM inventory_ledger
      WHERE ${LEDGER_LIVE_SQL}
        AND source_type IN (${ph}) AND COALESCE(qty_out,0) > 0
        AND source_id IN (SELECT i.id FROM invoices i WHERE ${sw.sql})
      GROUP BY source_id`).all(...SALE_LEDGER_SOURCES, ...sw.params)) {
      kardex.set(r.source_id, Math.round(num(r.amt)));
    }
  }
  const glCogs = new Map();
  if (tableExists(db, 'journal_entries') && tableExists(db, 'journal_lines')) {
    const { codes } = cogsAccountCodes(db);
    const jeCols = colSet(db, 'journal_entries');
    const jlCols = colSet(db, 'journal_lines');
    const live = [];
    if (jeCols.has('deleted_at')) live.push('COALESCE(e.deleted_at,0)=0');
    if (jeCols.has('status')) live.push("COALESCE(e.status,'approved') NOT IN ('reversed','void')", jeNotDraftSql('e'));
    const acctCol = jlCols.has('account_code') ? 'account_code' : 'code';
    const ph = COGS_JE_REF_TYPES.map(() => '?').join(',');
    for (const l of db.prepare(`
      SELECT e.ref_id AS invoice_id, l.${acctCol} AS code, l.debit, l.credit
        ${jlCols.has('debit_rial') ? ', l.debit_rial' : ', NULL AS debit_rial'}
        ${jlCols.has('credit_rial') ? ', l.credit_rial' : ', NULL AS credit_rial'}
      FROM journal_entries e JOIN journal_lines l ON l.entry_id=e.id
      WHERE e.ref_type IN (${ph}) ${live.length ? 'AND ' + live.join(' AND ') : ''}
        AND e.ref_id IN (SELECT i.id FROM invoices i WHERE ${sw.sql})`).all(...COGS_JE_REF_TYPES, ...sw.params)) {
      if (!codes.has(String(l.code || ''))) continue;
      glCogs.set(l.invoice_id, (glCogs.get(l.invoice_id) || 0) + jlDebitRial(l) - jlCreditRial(l));
    }
  }
  let costMap = null;
  const cogsSource = { kardex: 0, journal: 0, estimate: 0 };
  for (const inv of invoices) {
    const d = day(inv.date);
    const gross = Math.round(num(inv.final_rial));
    const vat = Math.round(num(inv.vat_rial));
    d.invoice_count += 1;
    d.sales_gross_rial += gross;
    d.sales_vat_rial += vat;
    d.sales_ex_vat_rial += gross - vat;
    let cogs;
    if (kardex.has(inv.id)) { cogs = kardex.get(inv.id); cogsSource.kardex += 1; }
    else if (glCogs.has(inv.id)) { cogs = Math.round(glCogs.get(inv.id)); cogsSource.journal += 1; }
    else {
      if (!costMap) costMap = productCostMap(db);
      cogs = 0;
      for (const l of parseRows(inv.rows)) {
        const lc = num(l.unit_cost_rial) || num(l.cost_rial) || costMap.get(toInt(l.product_id)) || 0;
        cogs += num(l.qty) * lc;
      }
      cogs = Math.round(cogs);
      cogsSource.estimate += 1;
    }
    d.cogs_sales_rial += cogs;
  }

  // ── برگشت از فروش: مبلغ خالص (بدون VAT) + بهای برگشتی ثبت‌شده (cost_amount از کاردکس) ──
  if (tableExists(db, 'sales_returns')) {
    const srCols = colSet(db, 'sales_returns');
    const rw = docWhere(db, 'sales_returns', { ...f, headerWarehouse: false }, 'r', 'user_id');
    let whSql = '';
    const whParams = [];
    if (f.warehouse_id && invCols.has('warehouse_id')) {
      whSql = ' AND r.invoice_id IN (SELECT id FROM invoices WHERE warehouse_id=?)';
      whParams.push(f.warehouse_id);
    }
    const costExpr = srCols.has('cost_amount') ? 'ROUND(COALESCE(r.cost_amount,0))' : '0';
    for (const r of db.prepare(`SELECT r.date, ROUND(COALESCE(r.amount,0)) AS amt, ${costExpr} AS cost
      FROM sales_returns r WHERE ${rw.sql}${whSql}`).all(...rw.params, ...whParams)) {
      const d = day(r.date);
      d.returns_count += 1;
      d.returns_rial += Math.round(num(r.amt));
      d.cogs_returns_rial += Math.round(num(r.cost));
    }
  }

  // ── هزینه‌های دوره (غیرسربار): پرداخت هزینه posted/approved + کارمزد بانکی + هزینهٔ نماینده approved ──
  const expenseRows = [];
  if (tableExists(db, 'expense_payments')) {
    const eCols = colSet(db, 'expense_payments');
    const where = ['e.date>=?', 'e.date<=?'];
    const params = [from, to];
    if (eCols.has('status')) where.push(`COALESCE(e.status,'posted') IN (${EXPENSE_LIVE_STATUSES.map(() => '?').join(',')})`), params.push(...EXPENSE_LIVE_STATUSES);
    if (eCols.has('is_overhead')) where.push('COALESCE(e.is_overhead,0)=0');
    const b = branchSql('e.created_by', f.branch_id);
    const fee = eCols.has('fee_rial') ? 'ROUND(COALESCE(e.fee_rial,0))' : '0';
    const catName = tableExists(db, 'expense_categories')
      ? `COALESCE((SELECT c.name FROM expense_categories c WHERE c.code=e.category LIMIT 1), e.category)`
      : 'e.category';
    for (const r of db.prepare(`SELECT e.id, e.date, e.title, ${catName} AS category, ROUND(COALESCE(e.amount,0)) AS amt, ${fee} AS fee
      FROM expense_payments e WHERE ${where.join(' AND ')}${b.sql}`).all(...params, ...b.params)) {
      expenseRows.push({ kind: 'expense_payment', id: r.id, date: r.date, title: r.title || '', category: r.category || '', amount_rial: Math.round(num(r.amt) + num(r.fee)) });
    }
  }
  // P8: پیش‌نویس هزینهٔ روزانه فقط پس از تأیید سند دارد (JE مستقیم، بدون ردیف expense_payments) → یک‌بار از همین جدول.
  if (tableExists(db, 'expense_drafts')) {
    const b = branchSql('d.created_by', f.branch_id);
    const catName = tableExists(db, 'expense_categories')
      ? `COALESCE((SELECT c.name FROM expense_categories c WHERE c.code=d.category LIMIT 1), d.category)`
      : 'd.category';
    for (const r of db.prepare(`SELECT d.id, d.date, d.title, ${catName} AS category, ROUND(COALESCE(d.amount,0)) AS amt
      FROM expense_drafts d WHERE d.status='approved' AND d.date>=? AND d.date<=?${b.sql}`).all(from, to, ...b.params)) {
      expenseRows.push({ kind: 'expense_draft', id: r.id, date: r.date, title: r.title || '', category: r.category || '', amount_rial: Math.round(num(r.amt)) });
    }
  }
  if (tableExists(db, 'rep_expenses')) {
    const b = branchSql('x.rep_id', f.branch_id);
    for (const r of db.prepare(`SELECT x.id, x.date, x.description, x.category, ROUND(COALESCE(x.amount,0)) AS amt
      FROM rep_expenses x WHERE x.status='approved' AND x.date>=? AND x.date<=?${b.sql}`).all(from, to, ...b.params)) {
      expenseRows.push({ kind: 'rep_expense', id: r.id, date: r.date, title: r.description || '', category: r.category || '', amount_rial: Math.round(num(r.amt)) });
    }
  }
  const expByCat = new Map();
  for (const e of expenseRows) {
    day(e.date).expenses_rial += e.amount_rial;
    const k = e.category || '—';
    expByCat.set(k, (expByCat.get(k) || 0) + e.amount_rial);
  }

  // ── P9: انگیزهٔ چندطرفه — فقط سطر اطلاعاتی جدا (از سود عملیاتی کسر نمی‌شود)؛ با فیلتر شعبه/انبار محاسبه نمی‌شود ──
  let commission = { available: false, total_rial: null, by_day: new Map(), note: '' };
  if (f.branch_id || f.warehouse_id) {
    commission.note = 'برآورد انگیزه با فیلتر شعبه/انبار محاسبه نمی‌شود';
  } else {
    try {
      const { computeContributions } = require('./commissions-multi');
      const contribs = computeContributions(db, { from, to }) || [];
      commission = { available: true, total_rial: 0, by_day: new Map(), note: 'برآورد انگیزهٔ P9 (قواعد سرپرست/فروشنده، منهای برگشت) — فقط اطلاعاتی؛ از سود عملیاتی کسر نشده است' };
      for (const c of contribs) {
        const k = String(c.date || '').slice(0, 10);
        commission.by_day.set(k, num(commission.by_day.get(k)) + num(c.amount));
        commission.total_rial += num(c.amount);
      }
      commission.total_rial = Math.round(commission.total_rial);
    } catch (e) {
      commission = { available: false, total_rial: null, by_day: new Map(), note: 'برآورد انگیزه در دسترس نیست' };
    }
  }

  // ── جمع‌بندی ──
  const rows = [...days.values()].filter((d) => d.date).sort((a, b) => a.date.localeCompare(b.date));
  const total = emptyDay('');
  delete total.date;
  for (const d of rows) {
    d.net_sales_rial = d.sales_ex_vat_rial - d.returns_rial;
    d.cogs_rial = d.cogs_sales_rial - d.cogs_returns_rial;
    d.gross_profit_rial = d.net_sales_rial - d.cogs_rial;
    d.operating_profit_rial = d.gross_profit_rial - d.expenses_rial;
    for (const k of Object.keys(total)) total[k] += d[k];
  }
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  total.gross_margin_pct = pct(total.gross_profit_rial, total.net_sales_rial);
  total.operating_margin_pct = pct(total.operating_profit_rial, total.net_sales_rial);
  if (commission.available) {
    for (const d of rows) d.commission_p9_rial = Math.round(num(commission.by_day.get(d.date)));
    total.commission_p9_rial = commission.total_rial;
    total.operating_profit_after_commission_rial = total.operating_profit_rial - commission.total_rial;
  }

  return {
    generated_at: new Date().toISOString(),
    from, to,
    approximate: true,
    label: APPROX_LABEL,
    filters: { warehouse_id: f.warehouse_id || null, branch_id: f.branch_id || null },
    totals: total,
    days: rows,
    expenses: {
      count: expenseRows.length,
      by_category: [...expByCat.entries()].map(([category, amount_rial]) => ({ category, amount_rial }))
        .sort((a, b) => b.amount_rial - a.amount_rial),
      items: expenseRows.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.id - b.id).slice(0, 200),
    },
    cogs_source: cogsSource,
    commission_p9: { available: commission.available, total_rial: commission.total_rial, deducted: false, note: commission.note },
    method_note: `${APPROX_LABEL}. فروش خالص = فاکتور قطعی فروش زنده منهای ارزش افزوده، منهای مبلغ خالص برگشت از فروش. `
      + 'بهای تمام‌شده = خروج فروش در کاردکس زنده (اگر نبود سند COGS دفتر؛ اگر نبود تعداد×میانگین بها) منهای بهای برگشتی ثبت‌شده. '
      + 'هزینه‌ها = پرداخت هزینهٔ ثبت‌شده (بدون سربار تولید) + کارمزد بانکی + پیش‌نویس هزینهٔ روزانهٔ تأییدشده (P8) + هزینهٔ تأییدشدهٔ نماینده. '
      + 'انگیزهٔ فروش (P9) فقط به‌صورت سطر جدای برآوردی نمایش داده می‌شود و از سود عملیاتی کسر نمی‌شود؛ استهلاک و حقوق در این گزارش نیست.',
  };
}

module.exports = { buildQuickItemMovement, buildDailyPnl, resolveRange, APPROX_LABEL };
