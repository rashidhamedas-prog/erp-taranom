const { XLSX, readWorkbook } = require('../lib/excel-safe');
const router = require('express').Router();
const { getDB, audit, createLedgerEntry, allocateNumber, isDevice, resolveCashAccount } = require('../db');
const { acct, coaMode } = require('../lib/coa-map');
const { calcDocTotals } = require('../lib/vat');
const { postToLedger } = require('../lib/ledger');
const { enqueueMoadian } = require('./moadian');
const { assertInvoiceEditableForMoadian } = require('../lib/moadian/invoice-hooks');
const { rialToLedger } = require('../lib/money');
const { reverseCommissionAccrual } = require('../lib/rep-ledger');
const { voidInvoiceFully } = require('../lib/void-invoice');
const { sendSecureHtml } = require('../lib/secure-html-response');
const { listQueryPlan, listResponse } = require('../lib/pagination');
const {
  normalizeInvoiceType, isFirmSale, invoiceTypeLabel,
  assertJournalIdempotent, assertWarehouseLines,
  postSaleStockMovements, postCogsFromMovements, perpetualDocsEnabled,
} = require('../lib/sales-document');

// دریافتنیِ این مشتری: تفصیلی خودش (coa_code) وگرنه حساب کنترلی نگاشت‌شده
function receivableAcct(db, custId) {
  const c = db.prepare('SELECT coa_code FROM customers WHERE id=?').get(custId);
  if (c && c.coa_code) {
    const a = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(c.coa_code);
    if (a) return a;
  }
  return acct(db, 'coa_receivable');
}

// سند بهای تمام‌شده: Dr بهای تمام‌شده / Cr موجودی هر کالا (با feature_cogs_voucher).
function postCogsVoucher(db, invId, num, date, rows, userId, reverse) {
  const on = db.prepare("SELECT value FROM settings WHERE key='feature_cogs_voucher'").get();
  if (!on || on.value !== '1') return;
  if (reverse) {
    // فقط اگر سند اصلی وجود دارد معکوس بزن
    const orig = db.prepare("SELECT id FROM journal_entries WHERE ref_type='invoice_cogs' AND ref_id=? AND COALESCE(deleted_at,0)=0").get(invId);
    if (!orig) return;
  }
  const lines = [];
  let total = 0;
  for (const r of rows || []) {
    const p = db.prepare('SELECT cost,average_cost_rial,coa_code,name FROM products WHERE id=?').get(r.product_id);
    if (!p || !p.coa_code) continue;
    const unitRial = Number(p.average_cost_rial) > 0 ? Number(p.average_cost_rial) : (Number(p.cost) || 0);
    const amtRial = Math.round(unitRial * (parseQty(r.qty) || 0));
    if (amtRial <= 0) continue;
    const amt = rialToLedger(amtRial);
    total += amt;
    lines.push({ code: p.coa_code, name: p.name, debit: reverse ? amt : 0, credit: reverse ? 0 : amt });
  }
  if (!total) return;
  const cogs = acct(db, 'coa_cogs');
  lines.unshift({ code: cogs.code, name: cogs.name, debit: reverse ? 0 : total, credit: reverse ? total : 0 });
  postToLedger(db, {
    sourceType: reverse ? 'invoice_cogs_reversal' : 'invoice_cogs', sourceId: invId,
    date: date || todayJalali(), description: `بهای تمام‌شده فاکتور ${num}${reverse ? ' (ابطال)' : ''}`,
    createdBy: userId, lines,
  });
}
const { auth, adminOnly, requirePermission } = require('../middleware/auth');
const { todayJalali, addDaysToJalali } = require('../jalali');
const notif = require('../lib/notifications');

function salesJournalLines(db, custId, totals, reverse, opts = {}) {
  const payType = opts.payType || 'credit';
  const bankId = opts.bankId || null;
  const cashBoxId = opts.cashBoxId || null;
  const recv = payType === 'credit'
    ? receivableAcct(db, custId)
    : resolveCashAccount(db, payType === 'bank_transfer' ? 'bank' : payType, bankId, cashBoxId);
  const sales = acct(db, 'coa_sales');
  const salesDisc = acct(db, 'coa_sales_discount');
  const vatPay = acct(db, 'coa_vat_payable');
  const otherIncome = (() => { try { return acct(db, 'coa_other_income'); } catch { return sales; } })();
  const { discAmt, final, vatAmount, netBeforeVat } = totals;
  const L = rialToLedger;

  // Split product vs income row credits (Update 11 / I4)
  let incomeCredit = 0;
  const incomeBuckets = new Map();
  for (const r of opts.rows || []) {
    if (r.row_type === 'income') {
      const code = r.income_coa || otherIncome.code;
      const name = r.name || otherIncome.name;
      const amt = Math.round(Number(r.sum) || 0);
      incomeCredit += amt;
      const prev = incomeBuckets.get(code) || { code, name, amt: 0 };
      prev.amt += amt;
      incomeBuckets.set(code, prev);
    }
  }
  const productCredit = Math.max(0, Math.round(Number(netBeforeVat) || 0) - incomeCredit);

  if (!reverse) {
    const jLines = [{ code: recv.code, name: recv.name, debit: L(final), credit: 0 }];
    if (discAmt > 0) jLines.push({ code: salesDisc.code, name: salesDisc.name, debit: L(discAmt), credit: 0, description: 'تخفیف فاکتور' });
    if (productCredit > 0) jLines.push({ code: sales.code, name: sales.name, debit: 0, credit: L(productCredit) });
    for (const b of incomeBuckets.values()) {
      if (b.amt > 0) jLines.push({ code: b.code, name: b.name, debit: 0, credit: L(b.amt), description: 'درآمد/خدمات' });
    }
    if (vatAmount > 0) jLines.push({ code: vatPay.code, name: vatPay.name, debit: 0, credit: L(vatAmount), description: 'مالیات بر ارزش افزوده' });
    return jLines;
  }
  const jLines = [];
  if (productCredit > 0) jLines.push({ code: sales.code, name: sales.name, debit: L(productCredit), credit: 0, description: 'ابطال' });
  for (const b of incomeBuckets.values()) {
    if (b.amt > 0) jLines.push({ code: b.code, name: b.name, debit: L(b.amt), credit: 0, description: 'ابطال درآمد' });
  }
  if (vatAmount > 0) jLines.push({ code: vatPay.code, name: vatPay.name, debit: L(vatAmount), credit: 0, description: 'ابطال VAT' });
  if (discAmt > 0) jLines.push({ code: salesDisc.code, name: salesDisc.name, debit: 0, credit: L(discAmt), description: 'ابطال تخفیف' });
  jLines.push({ code: recv.code, name: recv.name, debit: 0, credit: L(final) });
  return jLines;
}

function getScope(req) {
  // Accounting staff see all invoices (read scope) — needed for the Sales
  // Invoices list inside the Accounting module, same as customers.js's getScope.
  const seesAll = req.user.role === 'admin' || req.user.role === 'accounting';
  if (req.user.role === 'admin' && req.query.user_id) return parseInt(req.query.user_id);
  if (seesAll) return null;
  return req.user.id;
}

function getSetting(db, key) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : '';
}

function faNum(n) {
  return Number(n || 0).toLocaleString('fa-IR');
}

// Sales channel is derived from WHO issues the invoice — never from the
// request body for sales roles (spec 1.0.9 §1).
const ROLE_CHANNEL = { field_sales: 'field', inside_sales: 'phone', salesperson: 'field' };
function resolveSalesChannel(req) {
  const forced = ROLE_CHANNEL[req.user.role];
  if (forced) return forced;
  // Admin/accounting may set explicitly when creating on behalf of the company
  if (['admin', 'accounting', 'sales_manager'].includes(req.user.role)) {
    return req.body.sales_channel || '';
  }
  return '';
}

// Validate & normalize invoice rows.
// Price is always editable by both admin and salesperson (Phase 2 change).
// Line-item discount is only honored when canDiscount is true — enforced
// server-side so a non-privileged client can never smuggle a row discount
// through by editing the request body directly.
// product_id must be valid OR row_type='income' (Update 11 / I4).
const { parseQty, round3 } = require('../lib/round3');

function buildRows(db, inputRows, canDiscount) {
  const out = [];
  let subtotal = 0;
  for (const r of (inputRows || [])) {
    const rowType = r.row_type === 'income' ? 'income' : 'product';
    const description = String(r.description || '').trim();
    const qty = Math.max(0.001, parseQty(r.qty, 1));
    let price = 0;
    let name = '';
    let pid = null;
    let incomeCoa = null;

    if (rowType === 'income') {
      name = String(r.name || r.description || 'درآمد/خدمات').trim() || 'درآمد/خدمات';
      price = parseFloat(r.price) || 0;
      incomeCoa = String(r.income_coa || r.coa_code || '').trim() || null;
    } else {
      pid = parseInt(r.product_id);
      if (!pid) throw new Error('هر ردیف باید یک محصول معتبر داشته باشد');
      const prod = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
      if (!prod) throw new Error('محصول یافت نشد (شناسه ' + pid + ')');
      name = prod.name;
      price = prod.price;
      if (r.price !== undefined && r.price !== null && r.price !== '') {
        price = parseFloat(r.price) || 0;
      }
    }

    const disc = canDiscount ? Math.min(100, Math.max(0, parseFloat(r.disc) || 0)) : 0;
    const discAmountIn = canDiscount ? Math.max(0, Math.round(parseFloat(r.disc_amount) || 0)) : 0;
    const gross = qty * price;
    const discPctAmt = Math.round(gross * disc / 100);
    // تخفیف ردیف یک‌بار: مبلغ و درصد هم‌ترازند — مبلغ اولویت دارد، وگرنه از درصد
    const discAmt = discAmountIn > 0 ? discAmountIn : discPctAmt;
    const discAmount = discAmt;
    const sum = Math.max(0, Math.round(gross - discAmt));
    subtotal += sum;
    const wh = r.warehouse_id ? parseInt(r.warehouse_id, 10) : null;
    out.push({
      product_id: pid,
      row_type: rowType,
      name,
      description,
      qty,
      price,
      disc,
      disc_amount: discAmount,
      disc_amt: discAmt,
      sum,
      warehouse_id: wh || null,
      income_coa: incomeCoa,
      allocated_freight: 0,
    });
  }
  return { rows: out, subtotal };
}

/** Allocate freight onto product rows (Update 11 / I3). method: amount|qty|equal */
function allocateFreight(rows, freightAmount, method) {
  const freight = Math.round(Number(freightAmount) || 0);
  if (freight <= 0) return rows;
  const targets = rows.filter(r => r.row_type !== 'income' && r.product_id);
  if (!targets.length) return rows;
  const m = method === 'qty' || method === 'equal' ? method : 'amount';
  let weights;
  if (m === 'equal') weights = targets.map(() => 1);
  else if (m === 'qty') weights = targets.map(r => Number(r.qty) || 0);
  else weights = targets.map(r => Number(r.sum) || 0);
  const totalW = weights.reduce((a, b) => a + b, 0);
  if (totalW <= 0) return rows;
  let allocated = 0;
  targets.forEach((r, i) => {
    const share = i === targets.length - 1
      ? freight - allocated
      : Math.round(freight * weights[i] / totalW);
    allocated += share;
    r.allocated_freight = share;
  });
  return rows;
}

function resolveRowWarehouseId(db, row, headerWarehouseId) {
  if (row && row.warehouse_id) return parseInt(row.warehouse_id, 10);
  if (headerWarehouseId) return parseInt(headerWarehouseId, 10);
  const def = db.prepare('SELECT id FROM warehouses WHERE active=1 AND is_default=1 ORDER BY id LIMIT 1').get();
  if (def) return def.id;
  const prod = row?.product_id ? db.prepare('SELECT warehouse_id FROM products WHERE id=?').get(row.product_id) : null;
  if (prod?.warehouse_id) return prod.warehouse_id;
  const any = db.prepare('SELECT id FROM warehouses WHERE active=1 ORDER BY id LIMIT 1').get();
  return any ? any.id : null;
}

function warehouseAllowsNegative(db, whId) {
  if (!whId) {
    const g = db.prepare("SELECT value FROM settings WHERE key='inventory_allow_negative'").get();
    return g && g.value === '1';
  }
  const wh = db.prepare('SELECT allow_negative FROM warehouses WHERE id=?').get(whId);
  if (wh && wh.allow_negative) return true;
  const g = db.prepare("SELECT value FROM settings WHERE key='inventory_allow_negative'").get();
  return g && g.value === '1';
}

// Deduct stock for each row; returns error message if stock insufficient.
// Also returns { usedWarehouses: [{id,name}] } via out param on success when 3rd-party wants toast info.
function deductStock(db, rows, warehouseId, userId, metaOut) {
  const used = new Map();
  const productRows = (rows || []).filter(r => r.row_type !== 'income' && r.product_id);
  for (const r of productRows) {
    const prod = db.prepare('SELECT * FROM products WHERE id=?').get(r.product_id);
    if (!prod) return `محصول شناسه ${r.product_id} یافت نشد`;
    const whId = resolveRowWarehouseId(db, r, warehouseId);
    const allowNeg = warehouseAllowsNegative(db, whId);
    if (!allowNeg && prod.stock < r.qty) {
      return `موجودی ${prod.name} کافی نیست (موجود: ${prod.stock})`;
    }
    if (whId) {
      const ws = db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(r.product_id, whId);
      const avail = ws ? ws.qty : (prod.warehouse_id === whId ? prod.stock : 0);
      if (!allowNeg && avail < r.qty) {
        const wh = db.prepare('SELECT name FROM warehouses WHERE id=?').get(whId);
        return `موجودی انبار «${wh?.name || whId}» برای ${prod.name} کافی نیست (موجود: ${avail})`;
      }
      used.set(whId, (db.prepare('SELECT name FROM warehouses WHERE id=?').get(whId)?.name) || String(whId));
    }
  }
  for (const r of productRows) {
    const whId = resolveRowWarehouseId(db, r, warehouseId);
    const allowNeg = warehouseAllowsNegative(db, whId);
    // Read the product BEFORE decrementing products.stock so the warehouse_stock
    // row can be seeded consistently with the read path's fallback below.
    const prod = db.prepare('SELECT stock, warehouse_id FROM products WHERE id=?').get(r.product_id);
    db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(r.qty, r.product_id);
    const whName = whId ? (used.get(whId) || '') : '';
    db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)').run(
      r.product_id, userId || 0, -r.qty, 'کسر موجودی از فاکتور رسمی' + (whName ? ` (${whName})` : '')
    );
    if (whId) {
      const seedQty = (prod && prod.warehouse_id === whId) ? prod.stock : 0;
      db.prepare(`
        INSERT INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)
        ON CONFLICT(product_id,warehouse_id) DO NOTHING
      `).run(r.product_id, whId, seedQty);
      if (allowNeg) {
        db.prepare('UPDATE warehouse_stock SET qty=qty-? WHERE product_id=? AND warehouse_id=?')
          .run(r.qty, r.product_id, whId);
      } else {
        db.prepare('UPDATE warehouse_stock SET qty=CASE WHEN qty-? < 0 THEN 0 ELSE qty-? END WHERE product_id=? AND warehouse_id=?')
          .run(r.qty, r.qty, r.product_id, whId);
      }
    }
  }
  if (metaOut) metaOut.usedWarehouses = [...used.entries()].map(([id, name]) => ({ id, name }));
  return null;
}

router.get('/', auth, (req, res) => {
  const db = getDB();
  const scope = getScope(req);
  const pq = listQueryPlan(req.query);
  // List view omits the heavy `rows` JSON blob — fetch line items via GET /:id when editing.
  const cols = `i.id,i.num,i.cust_id,i.user_id,i.type,i.date,i.subtotal,i.disc,i.disc_amt,i.final,i.pay_type,
    i.cheque_duration,i.cheque_due_date,i.cheque_info,i.approved,i.converted,i.note,i.created_at,
    i.seller_name,i.mahak_doc_no,i.mahak_doc_type,i.mahak_invoice_code,i.atf_no,i.visitor,i.freight_amount,
    i.settled_amount,i.balance_due,i.settlement_status,i.delivered,i.freight_alloc_method`;
  const typeFilter = String(req.query.type || '').trim();
  const typeSql = (typeFilter === 'proforma' || typeFilter === 'final' || typeFilter === 'normal') ? ' AND i.type=?' : '';
  const typeArgs = typeSql ? [typeFilter] : [];
  const baseWhere = scope === null
    ? `WHERE COALESCE(i.deleted_at,0)=0${typeSql}`
    : `WHERE i.user_id=? AND COALESCE(i.deleted_at,0)=0${typeSql}`;
  const countParams = scope === null ? [...typeArgs] : [scope, ...typeArgs];
  const total = pq.paginate
    ? (db.prepare(`SELECT COUNT(*) AS c FROM invoices i ${baseWhere}`).get(...countParams)?.c || 0)
    : 0;
  let rows;
  if (scope === null) {
    rows = db.prepare(`SELECT ${cols},c.biz as cust_biz,c.owner as cust_owner,u.name as salesperson FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id LEFT JOIN users u ON i.user_id=u.id ${baseWhere} ORDER BY i.created_at DESC${pq.limitSql}`).all(...typeArgs, ...pq.limitParams);
  } else {
    rows = db.prepare(`SELECT ${cols},c.biz as cust_biz,c.owner as cust_owner FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id ${baseWhere} ORDER BY i.created_at DESC${pq.limitSql}`).all(scope, ...typeArgs, ...pq.limitParams);
  }
  res.json(listResponse(rows, { page: pq.page, pageSize: pq.pageSize, total: pq.paginate ? total : rows.length }, req.query));
});

// Export invoices to Excel (must be before /:id to avoid route capture)
router.get('/export/excel', auth, adminOnly, async (req, res) => {
  const db = getDB();
  const scope = getScope(req);
  let rows;
  if (scope === null) {
    rows = db.prepare('SELECT i.*,c.biz as cust_biz,u.name as salesperson FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id LEFT JOIN users u ON i.user_id=u.id ORDER BY i.created_at DESC').all();
  } else {
    rows = db.prepare('SELECT i.*,c.biz as cust_biz FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.user_id=? ORDER BY i.created_at DESC').all(scope);
  }
  const data = rows.map(r => ({
    'شماره': r.num || '',
    'مشتری': r.cust_biz || '',
    'نوع': invoiceTypeLabel(r.type),
    'تاریخ': r.date || '',
    'مبلغ کل (ت)': r.subtotal || 0,
    'تخفیف (٪)': r.disc || 0,
    'مبلغ نهایی (ت)': r.final || 0,
    'نوع پرداخت': r.pay_type === 'cheque' ? 'چک' : 'نقد',
    'تأیید شده': r.approved ? 'بله' : 'خیر',
    'کارشناس': r.salesperson || '',
    'یادداشت': r.note || ''
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [12,20,12,12,18,10,18,12,10,15,20].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'فاکتورها');
  const buf = await XLSX.write(wb);
  res.setHeader('Content-Disposition', 'attachment; filename=invoices.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.get('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT i.*,c.biz as cust_biz,c.owner as cust_owner,c.city as cust_city,c.phone as cust_phone FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  res.json({ ...row, rows: JSON.parse(row.rows || '[]') });
});

router.post('/', auth, requirePermission('invoices', 'create'), (req, res) => {
  const { cust_id, type, date, note, rows, disc, pay_type, cheque_duration, cheque_due_date, cheque_info,
    bank_id, cash_box_id, check_category_id, warehouse_id, freight_amount, freight_type, freight_alloc_method, vat_exempt, cost_center_id,
    moadian_invoice_type, expert_user_id } = req.body;
  if (!cust_id) return res.status(400).json({ error: 'مشتری الزامی است' });
  const db = getDB();
  let built;
  const canDiscount = req.user.role === 'admin' || req.user.role === 'accounting';
  try { built = buildRows(db, rows, canDiscount); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const discPct = parseFloat(disc) || 0;
  const totals = calcDocTotals(db, built, discPct, { vatExempt: !!vat_exempt });
  const freightRial = Math.round(parseFloat(freight_amount) || 0);
  const allocMethod = ['amount', 'qty', 'equal'].includes(freight_alloc_method) ? freight_alloc_method : 'amount';
  allocateFreight(built.rows, freightRial, allocMethod);
  let { subtotal, discAmt, final, vatAmount, vatRate, netBeforeVat } = totals;
  final += freightRial;
  netBeforeVat += freightRial;
  const entryDate = date || todayJalali();
  const pType = pay_type || 'cash';

  // کارشناس فاکتور: مدیر/حسابدار می‌تواند تعیین کند؛ در غیر این صورت مشتری→کاربر جاری
  let ownerUserId = req.user.id;
  const canAssignExpert = req.user.role === 'admin' || req.user.role === 'accounting';
  if (canAssignExpert && expert_user_id) {
    const eu = db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(parseInt(expert_user_id, 10));
    if (!eu) return res.status(400).json({ error: 'کارشناس انتخاب‌شده معتبر نیست' });
    ownerUserId = eu.id;
  } else if (canAssignExpert && !expert_user_id) {
    const custOwner = db.prepare('SELECT user_id FROM customers WHERE id=?').get(cust_id);
    if (custOwner?.user_id) ownerUserId = custOwner.user_id;
  }

  const seller = db.prepare('SELECT name,phone,sales_warehouse_id FROM users WHERE id=?').get(ownerUserId);
  const isSalesRep = req.user.role === 'field_sales' || req.user.role === 'inside_sales';
  let whId = warehouse_id ? parseInt(warehouse_id, 10) : null;
  // فروشنده: فقط انبار تعریف‌شده در کاربر — انتخاب انبار در اقلام مجاز نیست
  if (isSalesRep) {
    const selfSeller = db.prepare('SELECT sales_warehouse_id FROM users WHERE id=?').get(req.user.id);
    if (!selfSeller?.sales_warehouse_id) {
      return res.status(400).json({ error: 'انبار فروش برای این کاربر تعریف نشده — از مدیر بخواهید در تعریف کاربر انبار فروش را تنظیم کند' });
    }
    whId = selfSeller.sales_warehouse_id;
    for (const r of built.rows) {
      if (r.row_type !== 'income') r.warehouse_id = whId;
    }
  } else if (!whId && seller?.sales_warehouse_id) {
    whId = seller.sales_warehouse_id;
  }
  const ccId = cost_center_id ? parseInt(cost_center_id, 10) : null;
  const journalOpts = { payType: pType, bankId: bank_id || null, cashBoxId: cash_box_id || null, rows: built.rows };

  const prefixRow = db.prepare("SELECT value FROM settings WHERE key='invoice_num_prefix'").get();
  let invType;
  try { invType = normalizeInvoiceType(type || 'proforma'); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message, code: e.code }); }

  if (isFirmSale(invType)) {
    try { assertWarehouseLines(db, built.rows, whId, { requirePositive: true }); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message, code: e.code }); }
  }

  let created;
  try {
    created = db.transaction(() => {
      const num = isDevice()
        ? ('موقت-' + Date.now().toString(36).toUpperCase())
        : allocateNumber(db, 'invoice', prefixRow?.value || 'T');

      const result = db.prepare(
        `INSERT INTO invoices (user_id,cust_id,num,type,date,note,rows,subtotal,disc,disc_amt,final,vat_amount,vat_rate,subtotal_rial,final_rial,vat_amount_rial,
          seller_name,seller_phone,pay_type,cheque_duration,cheque_due_date,cheque_info,stock_deducted,sales_channel,lead_source,campaign,
          bank_id,cash_box_id,check_category_id,warehouse_id,freight_amount,freight_type,freight_alloc_method,vat_exempt,cost_center_id,moadian_invoice_type)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(ownerUserId, cust_id, num, invType, entryDate, note || '',
            JSON.stringify(built.rows), subtotal, discPct, discAmt, final, vatAmount, vatRate,
            Math.round(subtotal), Math.round(final), Math.round(vatAmount),
            seller ? seller.name : '', seller ? (seller.phone || '') : '',
            pType, cheque_duration || '', cheque_due_date || '', cheque_info || '',
            0, resolveSalesChannel(req), req.body.lead_source || '', req.body.campaign || '',
            bank_id || null, cash_box_id || null, check_category_id || null, whId, freightRial, freight_type || '',
            allocMethod, vat_exempt ? 1 : 0, ccId,
            parseInt(moadian_invoice_type, 10) || 1);
      const invId = result.lastInsertRowid;
      const stockMeta = {};
      let saleCogsRial = 0;

      if (isFirmSale(invType)) {
        if (perpetualDocsEnabled(db)) {
          const stocked = postSaleStockMovements(db, {
            rows: built.rows, warehouseId: whId, sourceType: 'invoice', sourceId: invId,
            userId: req.user.id, date: entryDate, note: `فروش ${invoiceTypeLabel(invType)} ${num}`,
          });
          saleCogsRial = stocked.cogsRial;
          stockMeta.usedWarehouses = stocked.usedWarehouses;
        } else {
          const stockErr = deductStock(db, built.rows, whId, req.user.id, stockMeta);
          if (stockErr) throw new Error(stockErr);
        }
        db.prepare('UPDATE invoices SET stock_deducted=1 WHERE id=?').run(invId);

        db.prepare("UPDATE customers SET status='active' WHERE id=?").run(cust_id);
        if (pType === 'credit') {
          createLedgerEntry(db, {
            customer_id: cust_id, date: entryDate, entry_type: 'invoice',
            ref_type: 'invoice', ref_id: invId,
            description: `${invoiceTypeLabel(invType)} ${num}`,
            debit: final, credit: 0, user_id: req.user.id
          });
        }
        assertJournalIdempotent(db, 'invoice', invId);
        postToLedger(db, {
          sourceType: 'invoice', sourceId: invId, date: entryDate,
          description: `${invoiceTypeLabel(invType)} ${num}${freightRial ? ' (با کرایه حمل)' : ''}`, createdBy: req.user.id,
          lines: salesJournalLines(db, cust_id, { subtotal, discAmt, final, vatAmount, netBeforeVat }, false, journalOpts),
          costCenterId: ccId,
        });
        if (perpetualDocsEnabled(db) && saleCogsRial > 0) {
          postCogsFromMovements(db, {
            invId, num, date: entryDate, userId: req.user.id, cogsRial: saleCogsRial,
          });
        } else {
          postCogsVoucher(db, invId, num, entryDate, built.rows, req.user.id, false);
        }
        if (invType === 'final') enqueueMoadian(db, 'sales', invId);
      }

      // Auto-create a 7-day quality follow-up — only if the customer has
      // auto-followup enabled. Central-only: on a device this would duplicate
      // the follow-up central generates when the invoice op is replayed.
      try {
        const cust = isDevice() ? null : db.prepare('SELECT auto_followup FROM customers WHERE id=?').get(cust_id);
        if (!isDevice() && (!cust || cust.auto_followup == null || cust.auto_followup)) {
          const invoiceDate = date || todayJalali();
          const followupDate = addDaysToJalali(invoiceDate, 7);
          const productList = built.rows.map(r => r.name).join('، ') || '-';
          db.prepare(
            'INSERT INTO followups (user_id,cust_id,date,type,subject,note,next_date,status,priority) VALUES (?,?,?,?,?,?,?,?,?)'
          ).run(
            ownerUserId, cust_id, invoiceDate,
            '🧾 پیگیری فاکتور',
            'بررسی رضایت از کیفیت کالا',
            `پیگیری پس از فاکتور ${num}\nمحصولات: ${productList}`,
            followupDate, 'open', 'mid'
          );
        }
      } catch (e) {
        console.error('auto-followup error:', e.message);
      }

      return { id: invId, usedWarehouses: stockMeta.usedWarehouses || [] };
    })();
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const row = db.prepare('SELECT i.*,c.biz as cust_biz FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.id=?').get(created.id);
  if (!isDevice()) {
    try {
      const cust = db.prepare('SELECT biz FROM customers WHERE id=?').get(cust_id);
      notif.notifyNewInvoice(db, row, cust);
    } catch (e) { console.error('notify invoice:', e.message); }
  }
  res.json({ ...row, rows: JSON.parse(row.rows || '[]'), used_warehouses: created.usedWarehouses || [] });
});

router.put('/:id', auth, requirePermission('invoices', 'edit'), (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  try {
    assertInvoiceEditableForMoadian(row);
  } catch (e) {
    return res.status(e.status || 422).json({ error: e.message, code: e.code });
  }
  const { cust_id, type, date, note, rows, disc, pay_type, cheque_duration, cheque_due_date, cheque_info, sales_channel, lead_source, campaign,
    bank_id, cash_box_id, check_category_id, warehouse_id, freight_amount, freight_type, freight_alloc_method, vat_exempt, cost_center_id,
    moadian_invoice_type, expert_user_id } = req.body;
  if (isFirmSale(row.type)) {
    return res.status(409).json({ error: 'فاکتور قطعی ثبت حسابداری شده است؛ برای اصلاح، آن را ابطال و فاکتور جدید ثبت کنید' });
  }
  if (isFirmSale(type || row.type)) {
    return res.status(409).json({ error: 'تبدیل پیش‌فاکتور به فاکتور قطعی فقط از عملیات «تبدیل» انجام می‌شود' });
  }
  let built;
  const canDiscount = req.user.role === 'admin' || req.user.role === 'accounting';
  try { built = buildRows(db, rows, canDiscount); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const discPct = parseFloat(disc) || 0;
  const totals = calcDocTotals(db, built, discPct, { vatExempt: !!vat_exempt });
  const freightRial = Math.round(parseFloat(freight_amount) || 0);
  const allocMethod = ['amount', 'qty', 'equal'].includes(freight_alloc_method)
    ? freight_alloc_method
    : (row.freight_alloc_method || 'amount');
  allocateFreight(built.rows, freightRial, allocMethod);
  let { subtotal, discAmt, final, vatAmount, vatRate } = totals;
  final += freightRial;

  let newType;
  try { newType = normalizeInvoiceType(type || 'proforma'); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message, code: e.code }); }
  if (isFirmSale(newType)) {
    return res.status(409).json({ error: 'تبدیل پیش‌فاکتور به فاکتور قطعی فقط از عملیات «تبدیل» انجام می‌شود' });
  }
  const isSalesRep = req.user.role === 'field_sales' || req.user.role === 'inside_sales';
  let whId = warehouse_id != null && warehouse_id !== '' ? parseInt(warehouse_id, 10) : (row.warehouse_id || null);
  const uWh = db.prepare('SELECT sales_warehouse_id FROM users WHERE id=?').get(req.user.id);
  if (isSalesRep) {
    if (!uWh?.sales_warehouse_id) {
      return res.status(400).json({ error: 'انبار فروش برای این کاربر تعریف نشده — از مدیر بخواهید در تعریف کاربر انبار فروش را تنظیم کند' });
    }
    whId = uWh.sales_warehouse_id;
    for (const r of built.rows) {
      if (r.row_type !== 'income') r.warehouse_id = whId;
    }
  } else if (!whId && uWh?.sales_warehouse_id) {
    whId = uWh.sales_warehouse_id;
  }
  const ccId = cost_center_id != null && cost_center_id !== '' ? parseInt(cost_center_id, 10) : (row.cost_center_id || null);

  try {
    db.transaction(() => {
      const moadianType = moadian_invoice_type != null && moadian_invoice_type !== ''
        ? (parseInt(moadian_invoice_type, 10) || 1)
        : (row.moadian_invoice_type != null ? row.moadian_invoice_type : 1);
      db.prepare(`UPDATE invoices SET cust_id=?,type=?,date=?,note=?,rows=?,subtotal=?,disc=?,disc_amt=?,final=?,vat_amount=?,vat_rate=?,
        subtotal_rial=?,final_rial=?,vat_amount_rial=?,pay_type=?,cheque_duration=?,cheque_due_date=?,cheque_info=?,stock_deducted=?,
        sales_channel=?,lead_source=?,campaign=?,bank_id=?,cash_box_id=?,check_category_id=?,warehouse_id=?,freight_amount=?,freight_type=?,freight_alloc_method=?,vat_exempt=?,cost_center_id=?,moadian_invoice_type=?
        WHERE id=?`)
        .run(cust_id, newType, date || '', note || '', JSON.stringify(built.rows), subtotal, discPct, discAmt, final,
             vatAmount, vatRate, Math.round(subtotal), Math.round(final), Math.round(vatAmount),
             pay_type || row.pay_type || 'cash', cheque_duration || '', cheque_due_date || '', cheque_info || '',
             row.stock_deducted || 0, resolveSalesChannel(req), lead_source || '', campaign || '',
             bank_id || null, cash_box_id || null, check_category_id || null, whId, freightRial, freight_type || '',
             allocMethod, vat_exempt ? 1 : 0, ccId, moadianType, req.params.id);
      if ((req.user.role === 'admin' || req.user.role === 'accounting') && expert_user_id) {
        const eu = db.prepare('SELECT id,name,phone FROM users WHERE id=? AND active=1').get(parseInt(expert_user_id, 10));
        if (eu) {
          db.prepare('UPDATE invoices SET user_id=?, seller_name=?, seller_phone=? WHERE id=?')
            .run(eu.id, eu.name || '', eu.phone || '', req.params.id);
        }
      }
    })();
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  res.json({ ok: true });
});

router.delete('/:id', auth, requirePermission('invoices', 'delete'), (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM invoices WHERE id=? AND COALESCE(deleted_at,0)=0').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && req.user.role !== 'accounting' && row.user_id !== req.user.id) {
    return res.status(403).json({ error: 'دسترسی ندارید' });
  }
  try {
    assertInvoiceEditableForMoadian(row);
  } catch (e) {
    return res.status(e.status || 422).json({
      error: e.message || 'فاکتور قفل مودیان — ابطال محلی مجاز نیست؛ سند اصلاحی/ابطالی مودیان لازم است',
      code: e.code || 'MOADIAN_LOCKED',
    });
  }
  try {
    const result = voidInvoiceFully(db, row.id, req.user, { reason: 'void' });
    res.json({
      ok: true,
      restoredToProforma: result.restoredToProforma,
      settlementsReversed: result.settlementsReversed,
      title: result.title,
    });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || 'خطا در ابطال' });
  }
});

// Convert proforma → normal|final (default final for backward compatibility)
router.post('/:id/convert', auth, (req, res) => {
  const db = getDB();
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && inv.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  if (inv.converted) return res.status(400).json({ error: 'قبلاً تبدیل شده' });
  if (isFirmSale(inv.type)) return res.status(400).json({ error: 'این فاکتور قبلاً قطعی است' });

  let targetType;
  try { targetType = normalizeInvoiceType(req.body?.target_type || req.body?.type || 'final'); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message, code: e.code }); }
  if (!isFirmSale(targetType)) {
    return res.status(400).json({ error: 'هدف تبدیل باید فاکتور معمولی یا رسمی باشد' });
  }

  const rows = JSON.parse(inv.rows || '[]');
  const built = { rows, subtotal: inv.subtotal };
  const totals = calcDocTotals(db, built, inv.disc || 0);
  const owner = db.prepare('SELECT role, sales_warehouse_id FROM users WHERE id=?').get(inv.user_id);
  let convertWhId = inv.warehouse_id || null;
  if (owner && (owner.role === 'field_sales' || owner.role === 'inside_sales')) {
    if (!owner.sales_warehouse_id) {
      return res.status(400).json({ error: 'انبار فروش برای کاربر صادرکننده تعریف نشده' });
    }
    convertWhId = owner.sales_warehouse_id;
    for (const r of rows) {
      if (r.row_type !== 'income') r.warehouse_id = convertWhId;
    }
  } else if (!convertWhId && owner?.sales_warehouse_id) {
    convertWhId = owner.sales_warehouse_id;
  }

  try {
    assertWarehouseLines(db, rows, convertWhId, { requirePositive: true });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }

  try {
    db.transaction(() => {
      let stockDeducted = inv.stock_deducted || 0;
      let saleCogsRial = 0;
      if (!stockDeducted) {
        if (perpetualDocsEnabled(db)) {
          const stocked = postSaleStockMovements(db, {
            rows, warehouseId: convertWhId, sourceType: 'invoice', sourceId: inv.id,
            userId: req.user.id, date: inv.date || '', note: `تبدیل به ${invoiceTypeLabel(targetType)} ${inv.num}`,
          });
          saleCogsRial = stocked.cogsRial;
        } else {
          const stockErr = deductStock(db, rows, convertWhId, req.user.id);
          if (stockErr) throw new Error(stockErr);
        }
        stockDeducted = 1;
      }

      db.prepare('UPDATE invoices SET type=?,converted=1,stock_deducted=?,final=?,vat_amount=?,vat_rate=?,final_rial=?,vat_amount_rial=?,warehouse_id=COALESCE(?,warehouse_id),rows=? WHERE id=?')
        .run(targetType, stockDeducted, totals.final, totals.vatAmount, totals.vatRate,
          Math.round(totals.final), Math.round(totals.vatAmount), convertWhId, JSON.stringify(rows), inv.id);
      db.prepare("UPDATE customers SET status='active' WHERE id=?").run(inv.cust_id);

      if ((inv.pay_type || 'cash') === 'credit') {
        createLedgerEntry(db, {
          customer_id: inv.cust_id, date: inv.date || '', entry_type: 'invoice',
          ref_type: 'invoice', ref_id: inv.id,
          description: `تبدیل پیش‌فاکتور ${inv.num} به ${invoiceTypeLabel(targetType)}`,
          debit: totals.final, credit: 0, user_id: req.user.id
        });
      }
      assertJournalIdempotent(db, 'invoice', inv.id);
      postToLedger(db, {
        sourceType: 'invoice', sourceId: inv.id, date: inv.date || '',
        description: `${invoiceTypeLabel(targetType)} ${inv.num} (تبدیل از پیش‌فاکتور)`,
        createdBy: req.user.id, lines: salesJournalLines(db, inv.cust_id, {
          subtotal: totals.subtotal, discAmt: totals.discAmt, final: totals.final,
          vatAmount: totals.vatAmount, netBeforeVat: totals.netBeforeVat,
        }, false, {
          payType: inv.pay_type || 'cash', bankId: inv.bank_id, cashBoxId: inv.cash_box_id,
        }),
      });
      if (perpetualDocsEnabled(db) && saleCogsRial > 0) {
        postCogsFromMovements(db, {
          invId: inv.id, num: inv.num, date: inv.date, userId: req.user.id, cogsRial: saleCogsRial,
        });
      } else {
        postCogsVoucher(db, inv.id, inv.num, inv.date, rows, req.user.id, false);
      }
      if (targetType === 'final') enqueueMoadian(db, 'sales', inv.id);
    })();
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  audit(req.user.id, 'convert', 'invoice', inv.id, `تبدیل پیش‌فاکتور ${inv.num} به ${invoiceTypeLabel(targetType)}`);

  res.json({ ok: true, type: targetType });
});

// Standalone printable HTML page — templates from server/lib/invoice-print.js
router.get('/:id/print', auth, (req, res) => {
  const db = getDB();
  const inv = db.prepare(
    `SELECT i.*,c.biz as cust_biz,c.owner as cust_owner,c.city as cust_city,c.phone as cust_phone,
            u.name as salesperson
     FROM invoices i
     LEFT JOIN customers c ON i.cust_id=c.id
     LEFT JOIN users u ON i.user_id=u.id
     WHERE i.id=?`
  ).get(req.params.id);
  if (!inv) return res.status(404).send('فاکتور یافت نشد');
  if (req.user.role !== 'admin' && inv.user_id !== req.user.id) return res.status(403).send('دسترسی ندارید');
  let rows = [];
  try { rows = JSON.parse(inv.rows || '[]'); } catch (_) { rows = []; }

  const settings = {
    company_name: getSetting(db, 'company_name'),
    company_address: getSetting(db, 'company_address'),
    company_phone: getSetting(db, 'company_phone'),
    invoice_template_formal: getSetting(db, 'invoice_template_formal') || 'formal-official',
    invoice_template_casual: 'casual-simple',
    invoice_paper_size: getSetting(db, 'invoice_paper_size') || 'A4',
    invoice_thermal_width: getSetting(db, 'invoice_thermal_width') || '80',
    invoice_customize: getSetting(db, 'invoice_customize') || '',
  };
  const paperQ = String(req.query.paper || settings.invoice_paper_size || 'A4').toUpperCase();
  let paper = 'A4';
  if (paperQ === 'A5') paper = 'A5';
  else if (paperQ === 'THERMAL' || paperQ === '80MM' || paperQ === '58MM') paper = paperQ === '58MM' ? '58MM' : (paperQ === '80MM' ? '80MM' : 'THERMAL');
  const tmpl = String(req.query.template || '');
  const { renderInvoicePrintHtml } = require('../lib/invoice-print');
  const html = renderInvoicePrintHtml({
    inv, rows, settings, paper,
    templateOverride: tmpl === 'thermal' ? 'thermal' : (tmpl || undefined),
  });
  return sendSecureHtml(res, html, { allowPrintScript: true });
});

module.exports = router;
