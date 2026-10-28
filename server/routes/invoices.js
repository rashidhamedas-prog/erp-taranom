const { XLSX, readWorkbook } = require('../lib/excel-safe');
const router = require('express').Router();
const { getDB, audit, allocateNumber, isDevice } = require('../db');
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
const { applyCatalogCostPolicy } = require('../lib/catalog-cost-policy');
const {
  normalizeInvoiceType, isFirmSale, invoiceTypeLabel,
  assertJournalIdempotent, assertWarehouseLines,
  applyHeaderWarehouseToLines, requireFirmHeaderWarehouse,
  assertLineWarehousesAllowed, listCrossWarehouseLines,
  postSaleStockMovements, postCogsFromMovements, perpetualDocsEnabled, warehouseUsesPerpetualValuation,
  saleUsesPerpetualValuation,
  autoApproveNormalInvoice, allocateFreight, applyFreightToDocTotals,
  isFabricRollLine,
} = require('../lib/sales-document');
const {
  salesJournalLines, postInvoiceCustomerLedger,
} = require('../lib/customer-books');
const {
  resolveInvoicePayments, headerPayTypeFromSplits, applyInvoicePaySplits,
  persistInvoicePayPlan, paymentsFromStoredInvoice,
} = require('../lib/invoice-payments');
const { resolveCashPaid, assertCashBoxRequired } = require('../lib/cash-on-document');
const { amendPostedInvoiceInPlace, defaultVatExempt, resolveVatExemptFlag } = require('../lib/amend-invoice');
const { assertPartyCreditLimitOk, invoiceArDeltaRial } = require('../lib/party-credit');
// NONTAX-P0-atp: available-to-promise gate for firm sales (non-tax; no VAT/Moadian field is touched).
const { ensureAtpSchema, FULFILLMENT_STATES } = require('../lib/inventory/atp-schema');
const {
  decideSaleFulfillment, isBackorderRequested, isProvisionalRequest,
} = require('../lib/inventory/available-to-promise');
const { runWithSaleContext, consumeOpenReservationsForSale } = require('../lib/inventory/reservation');
const shortageErr = require('../lib/inventory/shortage-error');
const { assertJalaliDocDate } = require('../lib/validators');
const {
  requireClientRequestId, findByClientRequestId, isUniqueClientRequestConflict,
} = require('../lib/client-request-id');

/** v525: ATP rows stay in atp_shortages (legacy clients); every stock error also gets uniform `shortages`. */
function shortagePayload(db, e, payload) {
  const code = String((e && e.code) || '');
  if (Array.isArray(e && e.shortages) && /^E_(ATP|BACKORDER)_/.test(code)) payload.atp_shortages = e.shortages;
  try {
    const list = shortageErr.fromError(db, e);
    if (list.length) payload.shortages = list;
  } catch (_) { /* enrichment only */ }
  return payload;
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

// invoices.fulfillment_state (route-local, idempotent ALTER guarded by PRAGMA) — before any handler
// so GET lists / voids on a DB that predates the column never hit "no such column".
router.use((req, res, next) => {
  try { ensureAtpSchema(getDB()); } catch (e) { console.error('ensureAtpSchema:', e.message); }
  next();
});

function getScope(req) {
  // Accounting staff see all invoices (read scope) — needed for the Sales
  // Invoices list inside the Accounting module, same as customers.js's getScope.
  const seesAll = req.user.role === 'admin' || req.user.role === 'accounting';
  if (req.user.role === 'admin' && req.query.user_id) return parseInt(req.query.user_id);
  if (seesAll) return null;
  return req.user.id;
}

function canViewInvoice(req, inv) {
  if (!inv) return false;
  try {
    const { canViewWalkinInvoice } = require('../lib/store-quick-sale');
    const walkin = canViewWalkinInvoice(getDB(), req, inv);
    if (walkin !== null) return walkin;
  } catch (_) { /* fall through */ }
  const role = req.user && req.user.role;
  if (role === 'admin' || role === 'accounting' || role === 'sales_manager') return true;
  return Number(inv.user_id) === Number(req.user.id);
}

const INVOICE_JOIN_SQL = `SELECT i.*,c.biz as cust_biz,c.owner as cust_owner,c.city as cust_city,c.phone as cust_phone,
            c.address as cust_address,c.economic_code as cust_economic_code,c.national_id as cust_national_id,c.postal_code as cust_postal_code,
            u.name as salesperson
     FROM invoices i
     LEFT JOIN customers c ON i.cust_id=c.id
     LEFT JOIN users u ON i.user_id=u.id`;

function loadInvoiceRow(db, key) {
  const raw = String(key == null ? '' : key).trim();
  if (!raw || raw === 'undefined' || raw === 'null') return null;
  const asId = parseInt(raw, 10);
  if (Number.isFinite(asId) && String(asId) === raw) {
    const byId = db.prepare(`${INVOICE_JOIN_SQL} WHERE i.id=?`).get(asId);
    if (byId) return byId;
  }
  return db.prepare(`${INVOICE_JOIN_SQL} WHERE i.num=?`).get(raw) || null;
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
const ROLE_CHANNEL = {
  field_sales: 'field',
  inside_sales: 'phone',
  salesperson: 'field',
  store_retail: 'store_quick',
};
function resolveSalesChannel(req) {
  const forced = ROLE_CHANNEL[req.user.role];
  if (forced) return forced;
  const body = req.body || {};
  // Admin/accounting/دفتر پخش/مدیر فروش may set explicitly (incl. فروش سریع فروشگاهی)
  if (['admin', 'accounting', 'sales_manager', 'distribution_office'].includes(req.user.role)) {
    if (body.store_quick || body.sales_channel === 'store_quick') return 'store_quick';
    return body.sales_channel || '';
  }
  return '';
}

/** کارشناس فروش/بازاریاب فقط پیش‌فاکتور می‌زند؛ تبدیل و مرکز هزینه برای او بسته است. */
function isSalesProformaOnlyRole(role) {
  return role === 'field_sales' || role === 'inside_sales' || role === 'salesperson';
}

function canConvertProforma(req, inv) {
  const role = req.user && req.user.role;
  if (!req.user || !inv) return false;
  if (isSalesProformaOnlyRole(role)) return false;
  if (role === 'admin' || role === 'accounting' || role === 'sales_manager') return true;
  return Number(inv.user_id) === Number(req.user.id);
}

// Validate & normalize invoice rows.
// Price is always editable by both admin and salesperson (Phase 2 change).
// Line-item discount is only honored when canDiscount is true — enforced
// server-side so a non-privileged client can never smuggle a row discount
// through by editing the request body directly.
// product_id must be valid OR row_type='income' (Update 11 / I4).
const { parseQty, round3 } = require('../lib/round3');

function resolveProductCode(db, r, prod) {
  const fromRow = String((r && (r.code || r.sku || r.barcode)) || '').trim();
  if (fromRow) return fromRow;
  if (r && r.variant_id) {
    try {
      const v = db.prepare('SELECT sku, barcode FROM product_variants WHERE id=?').get(r.variant_id);
      if (v && (v.sku || v.barcode)) return String(v.sku || v.barcode || '').trim();
    } catch (_) { /* optional */ }
  }
  if (prod) return String(prod.code || prod.barcode || '').trim();
  if (r && r.product_id) {
    try {
      const p = db.prepare('SELECT code, barcode FROM products WHERE id=?').get(r.product_id);
      if (p) return String(p.code || p.barcode || '').trim();
    } catch (_) { /* optional */ }
  }
  return '';
}

/** Enrich stored invoice JSON rows with product/variant codes for print (legacy invoices too). */
function enrichRowsProductCodes(db, rows) {
  return (rows || []).map((r) => {
    if (!r || r.row_type === 'income') return r;
    const code = resolveProductCode(db, r, null);
    if (!code) return r;
    return Object.assign({}, r, { code, sku: r.sku || code });
  });
}

function buildRows(db, inputRows, canDiscount) {
  const { requirePositiveQty } = require('../lib/round3');
  const { requiresIntegerQty, isIntegerQty } = require('../lib/inventory/qty-policy');
  const out = [];
  let subtotal = 0;
  for (const r of (inputRows || [])) {
    const rowType = r.row_type === 'income' ? 'income' : 'product';
    const description = String(r.description || '').trim();
    let qty;
    try {
      qty = requirePositiveQty(r.qty, 1);
    } catch (e) {
      if (e && e.code === 'E_QTY_INVALID') throw e;
      const err = new Error('تعداد نامعتبر است — باید عددی بزرگ‌تر از صفر باشد');
      err.status = 400;
      err.code = 'E_QTY_INVALID';
      throw err;
    }
    let price = 0;
    let name = '';
    let pid = null;
    let incomeCoa = null;
    let productCode = '';
    let prodUnit = '';

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
      prodUnit = String(prod.unit || r.unit || '').trim();
      price = prod.price;
      if (r.price !== undefined && r.price !== null && r.price !== '') {
        price = parseFloat(r.price) || 0;
      }
      const clientPriceGiven = (parseFloat(r.price) || 0) > 0;
      productCode = resolveProductCode(db, r, prod);
      // Matrix SKU: قیمت سرور فقط وقتی قیمت کلاینت خالی/۰ است (v546: قیمت صریح کلاینت
      // overwrite نمی‌شود؛ وگرنه final سرور < payable کلاینت و پرداخت «بیش از سند» می‌شد).
      const earlyVariantId = r.variant_id ? parseInt(r.variant_id, 10) : null;
      if (earlyVariantId && !clientPriceGiven) {
        try {
          const { unitPriceRialForVariant } = require('../lib/inventory/pack-unit-price');
          const serverPrice = unitPriceRialForVariant(db, pid, earlyVariantId);
          if (serverPrice > 0) price = serverPrice;
        } catch (_) { /* keep client/style price */ }
      }
      if (requiresIntegerQty(db, pid, prodUnit || r.unit) && !isIntegerQty(qty)) {
        const err = new Error(`تعداد برای واحد شمارشی «${prodUnit || 'عدد'}» باید عدد صحیح باشد`);
        err.status = 400;
        err.code = 'E_QTY_INVALID';
        throw err;
      }
      if (requiresIntegerQty(db, pid, prodUnit || r.unit)) qty = Math.round(qty);
    }

    // Accept disc | disc_pct and disc_amount | disc_amt (UI store-quick uses disc_pct/disc_amt).
    const rawDiscPct = parseFloat(r.disc != null && r.disc !== '' ? r.disc : r.disc_pct);
    const rawDiscAmt = Math.round(parseFloat(
      r.disc_amount != null && r.disc_amount !== '' ? r.disc_amount
        : (r.disc_amt != null && r.disc_amt !== '' ? r.disc_amt : 0)
    ) || 0);
    if (canDiscount) {
      if (Number.isFinite(rawDiscPct) && (rawDiscPct < 0 || rawDiscPct > 100)) {
        const err = new Error('درصد تخفیف ردیف باید بین ۰ تا ۱۰۰ باشد');
        err.status = 400;
        err.code = 'E_DISC_RANGE';
        throw err;
      }
    }
    const disc = canDiscount ? Math.min(100, Math.max(0, Number.isFinite(rawDiscPct) ? rawDiscPct : 0)) : 0;
    const discAmountIn = canDiscount ? Math.max(0, rawDiscAmt) : 0;
    const gross = qty * price;
    const discPctAmt = Math.round(gross * disc / 100);
    // تخفیف ردیف یک‌بار: مبلغ و درصد هم‌ترازند — مبلغ اولویت دارد، وگرنه از درصد
    const discAmt = discAmountIn > 0 ? discAmountIn : discPctAmt;
    if (canDiscount && discAmt > Math.round(gross) + 0.5) {
      const err = new Error('مبلغ تخفیف ردیف نمی‌تواند از مبلغ ناخالص ردیف بیشتر باشد');
      err.status = 400;
      err.code = 'E_DISC_RANGE';
      throw err;
    }
    const discAmount = discAmt;
    const sum = Math.max(0, Math.round(gross - discAmt));
    subtotal += sum;
    const wh = r.warehouse_id ? parseInt(r.warehouse_id, 10) : null;
    let variantId = r.variant_id ? parseInt(r.variant_id, 10) : null;
    let colorId = r.color_id ? parseInt(r.color_id, 10) : null;
    let sizeId = r.size_id ? parseInt(r.size_id, 10) : null;
    let colorName = String(r.color_name || r.color || '').trim();
    let sizeName = String(r.size_name || '').trim();
    if (variantId && pid) {
      try {
        const v = require('../lib/product-variants').getVariant(db, variantId);
        if (v && Number(v.product_id) === Number(pid)) {
          colorId = v.color_id || colorId;
          sizeId = v.size_id || sizeId;
          colorName = v.color_name || colorName;
          sizeName = v.size_name || sizeName;
          if (!productCode && (v.sku || v.barcode)) productCode = String(v.sku || v.barcode || '').trim();
        } else {
          variantId = null;
        }
      } catch (_) { variantId = null; }
    }
    out.push({
      product_id: pid,
      row_type: rowType,
      name,
      description,
      code: productCode || '',
      sku: productCode || '',
      qty,
      price,
      disc,
      disc_amount: discAmount,
      disc_amt: discAmt,
      sum,
      warehouse_id: wh || null,
      income_coa: incomeCoa,
      allocated_freight: 0,
      batch_id: r.batch_id ? parseInt(r.batch_id, 10) : null,
      is_fabric_roll: r.is_fabric_roll ? 1 : 0,
      color: colorName || String(r.color || '').trim(),
      pattern: String(r.pattern || '').trim(),
      width_cm: Math.round(Number(r.width_cm) || 0),
      roll_no: String(r.roll_no || '').trim(),
      unit_cost_rial: Math.round(Number(r.unit_cost_rial) || 0),
      variant_id: variantId || null,
      color_id: colorId || null,
      size_id: sizeId || null,
      color_name: colorName,
      size_name: sizeName,
    });
  }
  return { rows: out, subtotal };
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
// Pass metaOut.docId (invoice id) for idempotent inventory_movements keys.
function deductStock(db, rows, warehouseId, userId, metaOut) {
  const { postStockMovement } = require('../lib/inventory/movement');
  const used = new Map();
  const productRows = (rows || []).filter(r => r.row_type !== 'income' && r.product_id);
  const docId = metaOut && (metaOut.docId != null ? metaOut.docId : metaOut.invoiceId);
  const custId = metaOut && metaOut.custId != null ? metaOut.custId : null;
  for (const r of productRows) {
    const prod = db.prepare('SELECT * FROM products WHERE id=?').get(r.product_id);
    if (!prod) return `محصول شناسه ${r.product_id} یافت نشد`;
    const whId = resolveRowWarehouseId(db, r, warehouseId);
    const allowNeg = warehouseAllowsNegative(db, whId);
    if (isFabricRollLine(r)) {
      const batchId = r.batch_id ? parseInt(r.batch_id, 10) : null;
      if (batchId) {
        const batchRow = db.prepare(
          "SELECT batch_no, qty_on_hand, kind, status FROM inventory_batches WHERE id=?"
        ).get(batchId);
        if (batchRow && batchRow.kind === 'fabric' && !allowNeg) {
          const { availableBatchMeters } = require('../lib/inventory/fabric-rolls');
          const onHand = availableBatchMeters(db, batchId);
          if (r.qty - onHand > 1e-9) {
            return `متر طاقه ${batchRow.batch_no} کافی نیست (مانده ${onHand}، نیاز ${r.qty})`;
          }
        }
      }
      if (whId) {
        used.set(whId, (db.prepare('SELECT name FROM warehouses WHERE id=?').get(whId)?.name) || String(whId));
      }
      continue;
    }
    // Firm sales: the ATP gate (decideSaleFulfillment, same transaction) has already proven the layer
    // covers this qty — or the caller chose backorder/provisional and never reaches this function.
    if (whId) {
      used.set(whId, (db.prepare('SELECT name FROM warehouses WHERE id=?').get(whId)?.name) || String(whId));
    }
  }
  let lineIdx = 0;
  for (const r of productRows) {
    if (isFabricRollLine(r)) {
      const batchId = r.batch_id ? parseInt(r.batch_id, 10) : null;
      if (batchId) {
        const { consumeFabricRollOnSale } = require('../lib/inventory/fabric-rolls');
        consumeFabricRollOnSale(db, { batchId, qty: r.qty });
      }
      continue;
    }
    const whId = resolveRowWarehouseId(db, r, warehouseId);
    const whName = whId ? (used.get(whId) || '') : '';
    const allowNeg = warehouseAllowsNegative(db, whId);
    // Legacy seed — same rule as postSaleStockMovements / ledger.warehouseQty: a product that predates
    // warehouse_stock gets its home-warehouse row from products.stock (0 elsewhere). The ATP check reads
    // that rule, so the movement must act on the same number instead of a fresh 0 row.
    if (whId) {
      const prod = db.prepare('SELECT stock, warehouse_id FROM products WHERE id=?').get(r.product_id);
      const seedQty = prod && Number(prod.warehouse_id) === Number(whId) ? (Number(prod.stock) || 0) : 0;
      db.prepare(
        'INSERT INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?) ON CONFLICT(product_id,warehouse_id) DO NOTHING'
      ).run(r.product_id, whId, seedQty);
    }
    try {
      postStockMovement(db, {
        productId: r.product_id,
        variantId: r.variant_id || null,
        warehouseId: whId || null,
        qtyDelta: -(Number(r.qty) || 0),
        docType: 'invoice',
        docId: docId != null ? docId : null,
        docLine: lineIdx,
        userId: userId || 0,
        note: 'کسر موجودی از فاکتور رسمی' + (whName ? ` (${whName})` : ''),
        // Only an explicit warehouse/global allow_negative switch may drive physical stock below zero.
        allowNegative: allowNeg,
      });
    } catch (e) {
      // movement.js errors carry no product name (inherited Error.name only) — add it for the 409 text.
      if (e && e.code === 'E_NEGATIVE_STOCK' && !Object.prototype.hasOwnProperty.call(e, 'name')) {
        const p = db.prepare('SELECT name FROM products WHERE id=?').get(r.product_id);
        e.name = (p && p.name) || '';
        if (e.needed == null) e.needed = Number(r.qty) || 0;
      }
      throw e;
    }
    // The customer's own order soft-lock is fulfilled by this sale (same as the perpetual path).
    if (custId) {
      try {
        consumeOpenReservationsForSale(db, { productId: r.product_id, warehouseId: whId, qty: Number(r.qty) || 0, custId });
      } catch (_) { /* soft-lock optional */ }
    }
    lineIdx += 1;
  }
  if (metaOut) metaOut.usedWarehouses = [...used.entries()].map(([id, name]) => ({ id, name }));
  return null;
}

router.get('/', auth, (req, res) => {
  const db = getDB();
  const scope = getScope(req);
  const pq = listQueryPlan(req.query);
  // List view omits the heavy `rows` JSON blob — fetch line items via GET /:id when editing.
  const cols = `i.id,i.num,i.cust_id,i.user_id,i.type,i.date,i.subtotal,i.disc,i.disc_amt,i.final,i.final_rial,i.pay_type,
    i.cheque_duration,i.cheque_due_date,i.cheque_info,i.approved,i.converted,i.note,i.created_at,i.deleted_at,
    i.seller_name,i.mahak_doc_no,i.mahak_doc_type,i.mahak_invoice_code,i.atf_no,i.visitor,i.freight_amount,
    i.settled_amount,i.balance_due,i.settlement_status,i.delivered,i.freight_alloc_method,i.fulfillment_state`;
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
    // Document date DESC (not created_at) — backdated nums must not float above today's issues.
    rows = db.prepare(`SELECT ${cols},c.biz as cust_biz,c.owner as cust_owner,u.name as salesperson FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id LEFT JOIN users u ON i.user_id=u.id ${baseWhere} ORDER BY i.date DESC, i.id DESC${pq.limitSql}`).all(...typeArgs, ...pq.limitParams);
  } else {
    rows = db.prepare(`SELECT ${cols},c.biz as cust_biz,c.owner as cust_owner FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id ${baseWhere} ORDER BY i.date DESC, i.id DESC${pq.limitSql}`).all(scope, ...typeArgs, ...pq.limitParams);
  }
  res.json(listResponse(rows, { page: pq.page, pageSize: pq.pageSize, total: pq.paginate ? total : rows.length }, req.query));
});

// Export invoices to Excel (must be before /:id to avoid route capture)
router.get('/export/excel', auth, adminOnly, async (req, res) => {
  const db = getDB();
  const scope = getScope(req);
  let rows;
  if (scope === null) {
    rows = db.prepare('SELECT i.*,c.biz as cust_biz,u.name as salesperson FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id LEFT JOIN users u ON i.user_id=u.id ORDER BY i.date DESC, i.id DESC').all();
  } else {
    rows = db.prepare('SELECT i.*,c.biz as cust_biz FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.user_id=? ORDER BY i.date DESC, i.id DESC').all(scope);
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
  const row = loadInvoiceRow(db, req.params.id);
  if (!row) return res.status(404).json({ error: 'فاکتور پیدا نشد' });
  if (!canViewInvoice(req, row)) return res.status(403).json({ error: 'دسترسی ندارید' });
  let receipts = { settlements: [], pos: [] };
  try {
    const { loadInvoiceReceipts } = require('../lib/invoice-payments');
    receipts = loadInvoiceReceipts(db, row.id);
  } catch (_) { /* optional */ }
  res.json(applyCatalogCostPolicy(db, req.user, {
    ...row,
    rows: JSON.parse(row.rows || '[]'),
    receipts,
    settlements: receipts.settlements || [],
    pos_receipts: receipts.pos || [],
  }));
});

router.post('/', auth, requirePermission('invoices', 'create'), (req, res) => {
  const db = getDB();
  const {
    isStoreQuickRequest, prepareStoreQuickSaleBody, assertStoreQuickSaleRules, locksStoreWarehouse,
  } = require('../lib/store-quick-sale');
  try {
    if (isStoreQuickRequest(req.body, req.user.role)) {
      req.body = prepareStoreQuickSaleBody(db, req.user, req.body || {});
    }
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  const { cust_id, type, date, note, rows, disc, pay_type, cheque_duration, cheque_due_date, cheque_info,
    bank_id, cash_box_id, check_category_id, warehouse_id, freight_amount, freight_type, freight_alloc_method, vat_exempt, cost_center_id,
    moadian_invoice_type, expert_user_id } = req.body;
  if (!cust_id) return res.status(400).json({ error: 'مشتری الزامی است' });
  let requestKey;
  let entryDate;
  try {
    requestKey = requireClientRequestId(req.body, { headers: req.headers });
    entryDate = assertJalaliDocDate(date, 'تاریخ فاکتور') || require('../jalali').todayJalali();
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  {
    const priorInv = findByClientRequestId(db, 'invoices', requestKey);
    if (priorInv) {
      return res.json({ ...priorInv, rows: (() => { try { return JSON.parse(priorInv.rows || '[]'); } catch { return []; } })(), idempotent_replay: true });
    }
  }
  let built;
  const canDiscount = req.user.role === 'admin' || req.user.role === 'accounting' || req.user.role === 'sales_manager';
  try { built = buildRows(db, rows, canDiscount); }
  catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }

  const discPctRaw = parseFloat(disc);
  let discPct = Number.isFinite(discPctRaw) ? discPctRaw : 0;
  const discAmtOverride = (req.body && req.body.disc_amt != null && req.body.disc_amt !== '')
    ? Math.round(Number(req.body.disc_amt) || 0)
    : null;
  // H1: store_retail may not set header discount
  if (req.user.role === 'store_retail') {
    const wantsHdrDisc = (Number.isFinite(discPctRaw) && discPctRaw !== 0)
      || (discAmtOverride != null && discAmtOverride !== 0);
    if (wantsHdrDisc) {
      return res.status(403).json({
        error: 'نقش فروشگاهی مجاز به تخفیف سرفاکتور نیست',
        code: 'E_STORE_DISC_FORBIDDEN',
      });
    }
  }
  if (canDiscount) {
    if (discPct < 0 || discPct > 100) {
      return res.status(400).json({
        error: 'درصد تخفیف باید بین ۰ تا ۱۰۰ باشد',
        code: 'E_DISC_RANGE',
      });
    }
    if (discAmtOverride != null && discAmtOverride < 0) {
      return res.status(400).json({
        error: 'مبلغ تخفیف نمی‌تواند منفی باشد',
        code: 'E_DISC_RANGE',
      });
    }
  }
  const discPctEffective = canDiscount ? discPct : 0;
  const discAmtOverrideEffective = canDiscount ? discAmtOverride : null;
  discPct = discPctEffective;
  let invType;
  try { invType = normalizeInvoiceType(type || 'proforma'); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message, code: e.code }); }
  if (isSalesProformaOnlyRole(req.user.role)) {
    if (isFirmSale(invType)) {
      return res.status(403).json({
        error: 'کارشناس فروش فقط می‌تواند پیش‌فاکتور ثبت کند',
        code: 'E_SALES_PROFORMA_ONLY',
      });
    }
    invType = 'proforma';
  }
  const vatFlag = (vat_exempt === undefined || vat_exempt === null)
    ? defaultVatExempt(invType)
    : resolveVatExemptFlag(invType, vat_exempt);
  if (canDiscount && discAmtOverrideEffective != null
    && discAmtOverrideEffective > Math.round(Number(built.subtotal) || 0)) {
    return res.status(400).json({
      error: 'مبلغ تخفیف کل نمی‌تواند از جمع اقلام بیشتر باشد',
      code: 'E_DISC_RANGE',
    });
  }
  const totals = calcDocTotals(db, built, discPctEffective, {
    vatExempt: !!vatFlag,
    discAmt: discAmtOverrideEffective,
  });
  const freightRial = Math.round(parseFloat(freight_amount) || 0);
  const allocMethod = ['amount', 'qty', 'equal'].includes(freight_alloc_method) ? freight_alloc_method : 'amount';
  allocateFreight(built.rows, freightRial, allocMethod);
  const freightAdj = applyFreightToDocTotals(totals, freightRial, freight_type);
  let { subtotal, discAmt, vatAmount, vatRate } = totals;
  let { final, netBeforeVat } = freightAdj;
  const pType = pay_type || 'cash';
  let payPlan;
  try {
    payPlan = resolveInvoicePayments(req.body || {}, final);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  const storedPayType = payPlan.splits.length
    ? headerPayTypeFromSplits(payPlan.splits, pType, final)
    : pType;
  const skipInvoiceCash = payPlan.skipInvoiceCash;

  // کارشناس فاکتور: مدیر/حسابدار می‌تواند تعیین کند؛ در غیر این صورت مشتری→کاربر جاری
  // Walk-in / فروش سریع: مالک همیشه کاربر مؤثر نشست است (نه owner سیستمی مشتری نقدی).
  let ownerUserId = req.user.id;
  const canAssignExpert = req.user.role === 'admin' || req.user.role === 'accounting';
  if (canAssignExpert && expert_user_id) {
    const eu = db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(parseInt(expert_user_id, 10));
    if (!eu) return res.status(400).json({ error: 'کارشناس انتخاب‌شده معتبر نیست' });
    ownerUserId = eu.id;
  } else if (canAssignExpert && !expert_user_id) {
    const { isWalkinCustomer: isWalkinCust, isStoreQuickRequest: isSq } = require('../lib/store-quick-sale');
    if (isWalkinCust(db, cust_id) || isSq(req.body, req.user.role)) {
      ownerUserId = req.user.id;
    } else {
      const custOwner = db.prepare('SELECT user_id FROM customers WHERE id=?').get(cust_id);
      if (custOwner?.user_id) ownerUserId = custOwner.user_id;
    }
  }

  const seller = db.prepare('SELECT name,phone,sales_warehouse_id FROM users WHERE id=?').get(ownerUserId);
  const isSalesRep = isSalesProformaOnlyRole(req.user.role);
  const lockWh = isSalesRep || locksStoreWarehouse(req.user.role);
  let whId = warehouse_id ? parseInt(warehouse_id, 10) : null;
  // فروشنده / فروشگاهی: فقط انبار تعریف‌شده در کاربر — انتخاب انبار در اقلام مجاز نیست
  if (lockWh) {
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
  try {
    assertLineWarehousesAllowed(db, req.user, built.rows, whId);
  } catch (e) {
    return res.status(e.status || 403).json({ error: e.message, code: e.code || 'E_CROSS_WH_FORBIDDEN' });
  }
  let ccId = cost_center_id ? parseInt(cost_center_id, 10) : null;
  if (isSalesRep) ccId = null;
  const journalOpts = {
    payType: skipInvoiceCash ? 'credit' : storedPayType,
    bankId: skipInvoiceCash ? null : (bank_id || null),
    cashBoxId: skipInvoiceCash ? null : (cash_box_id || null),
    rows: built.rows,
    freightRial, freightType: freight_type,
  };

  const prefixRow = db.prepare("SELECT value FROM settings WHERE key='invoice_num_prefix'").get();

  try {
    resolveCashPaid(req.body || {}, final);
    if (isFirmSale(invType) && storedPayType === 'cash' && !payPlan.splits.length) {
      assertCashBoxRequired('cash', cash_box_id);
    }
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code || 'E_CASH_BOX_REQUIRED' });
  }

  if (isStoreQuickRequest(req.body, req.user.role)) {
    try {
      const exMeta = req.body && req.body._store_exchange;
      assertStoreQuickSaleRules(db, req.user, req.body, {
        final, payPlan, invType,
        exchangeCreditRial: exMeta ? exMeta.exchange_credit_rial : 0,
      });
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message, code: e.code });
    }
  }

  if (isFirmSale(invType)) {
    try {
      whId = requireFirmHeaderWarehouse(whId);
      applyHeaderWarehouseToLines(built.rows, whId, { force: lockWh });
      assertWarehouseLines(db, built.rows, whId, { requirePositive: true, allowNegativeProduct: true });
    } catch (e) { return res.status(e.status || 400).json({ error: e.message, code: e.code }); }
    try {
      let arDelta = invoiceArDeltaRial(final, payPlan, storedPayType);
      const exMeta = req.body && req.body._store_exchange;
      if (exMeta && Number(exMeta.exchange_credit_rial) > 0) {
        arDelta = Math.max(0, arDelta - Math.round(Number(exMeta.exchange_credit_rial) || 0));
      }
      assertPartyCreditLimitOk(db, cust_id, arDelta);
    } catch (e) {
      return res.status(e.status || 409).json({
        error: e.message, code: e.code || 'E_CREDIT_LIMIT',
        credit_limit_rial: e.credit_limit_rial, used_rial: e.used_rial,
        additional_rial: e.additional_rial, available_rial: e.available_rial,
      });
    }
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
          bank_id,cash_box_id,check_category_id,warehouse_id,freight_amount,freight_type,freight_alloc_method,vat_exempt,cost_center_id,moadian_invoice_type,client_request_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(ownerUserId, cust_id, num, invType, entryDate, note || '',
            JSON.stringify(built.rows), subtotal, discPct, discAmt, final, vatAmount, vatRate,
            Math.round(subtotal), Math.round(final), Math.round(vatAmount),
            seller ? seller.name : '', seller ? (seller.phone || '') : '',
            storedPayType, cheque_duration || '', cheque_due_date || '', cheque_info || '',
            0, resolveSalesChannel(req), req.body.lead_source || '', req.body.campaign || '',
            bank_id || null, cash_box_id || null, check_category_id || null, whId, freightRial, freight_type || '',
            allocMethod, vatFlag, ccId,
            parseInt(moadian_invoice_type, 10) || 1, requestKey);
      const invId = result.lastInsertRowid;
      const stockMeta = { docId: invId, custId: cust_id };
      let saleCogsRial = 0;
      let fulfillment = null;

      if (isFirmSale(invType)) {
        // ATP gate — same transaction as the movement, BEFORE anything moves (NONTAX-P0-atp).
        // Throws 409 E_ATP_INSUFFICIENT / 403 E_BACKORDER_FORBIDDEN → whole insert rolls back.
        let forceNeg = req.user.role === 'admin';
        if (!forceNeg) {
          try { forceNeg = !!require('../lib/rbac').hasPermission(db, req.user, 'inventory_negative', 'approve'); }
          catch (_) { forceNeg = false; }
        }
        fulfillment = decideSaleFulfillment(db, {
          rows: built.rows, headerWarehouseId: whId, custId: cust_id, excludeInvoiceId: invId,
          backorderRequested: isBackorderRequested(req.body), role: req.user.role,
          provisional: isProvisionalRequest(req, isDevice),
          forceAllowNegative: forceNeg,
        });
        if (fulfillment.mode === 'deduct') {
          // Per-line: if any line WH is perpetual, post ledger+COGS split even when header is periodic.
          if (saleUsesPerpetualValuation(db, built.rows, whId)) {
            // Sale context: only this customer's own order reservations are consumed by the posting.
            const stocked = runWithSaleContext({ custId: cust_id }, () => postSaleStockMovements(db, {
              rows: built.rows, warehouseId: whId, sourceType: 'invoice', sourceId: invId,
              userId: req.user.id, date: entryDate, note: `فروش ${invoiceTypeLabel(invType)} ${num}`,
              user: req.user,
            }));
            saleCogsRial = stocked.cogsRial;
            stockMeta.usedWarehouses = stocked.usedWarehouses;
            stockMeta.movements = stocked.movements || [];
            stockMeta.negativeOverrides = stocked.negativeOverrides || [];
          } else {
            const stockErr = deductStock(db, built.rows, whId, req.user.id, stockMeta);
            if (stockErr) throw new Error(stockErr);
          }
          db.prepare('UPDATE invoices SET stock_deducted=1, fulfillment_state=? WHERE id=?')
            .run(FULFILLMENT_STATES.DEDUCTED, invId);
        } else {
          // backorder (admin/accounting) or provisional (device/offline): no physical movement, no COGS,
          // stock_deducted stays 0 so a later void can never "restore" stock that was never taken.
          db.prepare('UPDATE invoices SET stock_deducted=0, fulfillment_state=? WHERE id=?')
            .run(fulfillment.fulfillment_state, invId);
          stockMeta.usedWarehouses = [];
        }

        db.prepare("UPDATE customers SET status='active' WHERE id=?").run(cust_id);
        postInvoiceCustomerLedger(db, {
          customerId: cust_id, date: entryDate, invId, num, invType,
          final, userId: req.user.id, payType: skipInvoiceCash ? 'credit' : storedPayType,
          skipImmediatePayment: skipInvoiceCash,
        });
        assertJournalIdempotent(db, 'invoice', invId);
        postToLedger(db, {
          sourceType: 'invoice', sourceId: invId, date: entryDate,
          description: `${invoiceTypeLabel(invType)} ${num}${freightRial ? ' (با کرایه حمل)' : ''}`, createdBy: req.user.id,
          lines: salesJournalLines(db, cust_id, { subtotal, discAmt, final, vatAmount, netBeforeVat }, false, journalOpts),
          costCenterId: ccId,
        });
        persistInvoicePayPlan(db, invId, payPlan, req.body || {});
        if (payPlan.splits.length) {
          applyInvoicePaySplits(db, {
            invoiceId: invId, custId: cust_id, date: entryDate,
            splits: payPlan.splits, userId: req.user.id, num,
            chequeHeader: { cheque_info, cheque_due_date },
          });
        }
        // Periodic warehouses defer COGS to period-close — never post invoice_cogs here.
        if (saleCogsRial > 0) {
          postCogsFromMovements(db, {
            invId, num, date: entryDate, userId: req.user.id, cogsRial: saleCogsRial,
            movements: stockMeta.movements || [],
            costCenterId: ccId, warehouseId: whId,
          });
        }
        if (invType === 'final') enqueueMoadian(db, 'sales', invId);
        if (invType === 'normal') autoApproveNormalInvoice(db, invId, req.user.id);
      } else {
        persistInvoicePayPlan(db, invId, payPlan, req.body || {});
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
      try {
        require('../lib/crm-pro').onInvoiceCreated(db, {
          invoiceId: invId, custId: cust_id, userId: ownerUserId, type: invType,
          amountRial: built.final_rial || built.final || 0,
          leadSource: req.body.lead_source || '', campaign: req.body.campaign || '',
        });
      } catch (e) { console.error('crm invoice stage:', e.message); }

      return {
        id: invId,
        usedWarehouses: stockMeta.usedWarehouses || [],
        negativeOverrides: stockMeta.negativeOverrides || [],
        fulfillment,
      };
    }).immediate();
  } catch (e) {
    if (isUniqueClientRequestConflict(e)) {
      const again = findByClientRequestId(db, 'invoices', requestKey);
      if (again) {
        return res.json({
          ...again,
          rows: (() => { try { return JSON.parse(again.rows || '[]'); } catch { return []; } })(),
          idempotent_replay: true,
        });
      }
    }
    const msg = e.code === 'E_NEGATIVE_STOCK'
      ? (`موجودی «${e.name || ''}» کافی نیست` + (e.available != null ? ` (موجود: ${e.available}` + (e.needed != null ? `، نیاز: ${e.needed}` : '') + ')' : ''))
      : (e.message || 'خطا در ثبت فاکتور');
    const payload = { error: msg, code: e.code };
    shortagePayload(db, e, payload);
    return res.status(e.status || 400).json(payload);
  }

  const row = db.prepare('SELECT i.*,c.biz as cust_biz FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.id=?').get(created.id);
  try {
    for (const x of listCrossWarehouseLines(built.rows, whId)) {
      audit(req.user.id, 'cross_warehouse_sale', 'invoice', created.id, JSON.stringify(x));
    }
  } catch (_) {}
  try {
    for (const x of created.negativeOverrides || []) {
      audit(req.user.id, 'negative_stock_override', 'invoice', created.id, JSON.stringify(x));
    }
  } catch (_) {}
  if (!isDevice()) {
    try {
      const cust = db.prepare('SELECT biz FROM customers WHERE id=?').get(cust_id);
      notif.notifyNewInvoice(db, row, cust);
    } catch (e) { console.error('notify invoice:', e.message); }
    try {
      const cust = db.prepare('SELECT biz,owner,phone,mobile,party_group_id,user_id FROM customers WHERE id=?').get(cust_id);
      const { dispatchSmsEvent } = require('../lib/sms-dispatch');
      setImmediate(() => dispatchSmsEvent(db, 'invoice.created', {
        phone: cust?.mobile || cust?.phone,
        name: cust?.owner || cust?.biz,
        biz: cust?.biz,
        amount: row.final,
        num: row.num,
        date: row.date,
        status: invoiceTypeLabel(row.type),
        party_group_id: cust?.party_group_id,
        user_id: cust?.user_id,
        created_by: req.user.id,
        user: req.user.name,
      }));
    } catch (_) {}
  }
  const fulfillmentOut = created.fulfillment && created.fulfillment.mode !== 'deduct'
    ? { fulfillment_state: created.fulfillment.fulfillment_state, atp_shortages: created.fulfillment.shortages }
    : {};
  res.json(applyCatalogCostPolicy(db, req.user, {
    ...row, rows: JSON.parse(row.rows || '[]'), used_warehouses: created.usedWarehouses || [], ...fulfillmentOut,
  }));
});

router.put('/:id', auth, requirePermission('invoices', 'edit'), (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const canEditAny = req.user.role === 'admin' || req.user.role === 'accounting' || req.user.role === 'sales_manager';
  if (!canEditAny && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  try {
    assertInvoiceEditableForMoadian(row);
  } catch (e) {
    return res.status(e.status || 422).json({ error: e.message, code: e.code });
  }
  const { cust_id, type, date, note, rows, disc, pay_type, cheque_duration, cheque_due_date, cheque_info, sales_channel, lead_source, campaign,
    bank_id, cash_box_id, check_category_id, warehouse_id, freight_amount, freight_type, freight_alloc_method, vat_exempt, cost_center_id,
    moadian_invoice_type, expert_user_id } = req.body;
  if (row.type === 'final' && isFirmSale(type || row.type) && String(type || row.type) !== 'final') {
    return res.status(409).json({ error: 'تغییر نوع فاکتور رسمی از ویرایش مجاز نیست', code: 'E_TYPE_LOCKED' });
  }
  if (isFirmSale(type || row.type) && row.type === 'proforma') {
    return res.status(409).json({ error: 'تبدیل پیش‌فاکتور به فاکتور قطعی فقط از عملیات «تبدیل» انجام می‌شود' });
  }
  let built;
  const canDiscount = req.user.role === 'admin' || req.user.role === 'accounting' || req.user.role === 'sales_manager';
  try { built = buildRows(db, rows, canDiscount); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  let newType;
  try { newType = normalizeInvoiceType(type || row.type || 'proforma'); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message, code: e.code }); }
  if (row.type === 'proforma' && isFirmSale(newType)) {
    return res.status(409).json({ error: 'تبدیل پیش‌فاکتور به فاکتور قطعی فقط از عملیات «تبدیل» انجام می‌شود' });
  }
  if (newType !== row.type) {
    return res.status(409).json({ error: 'تغییر نوع فاکتور از ویرایش مجاز نیست', code: 'E_TYPE_LOCKED' });
  }
  if (row.type === 'final') {
    const canAmendFinal = req.user.role === 'admin'
      || req.user.role === 'accounting'
      || req.user.role === 'sales_manager';
    if (!canAmendFinal) {
      return res.status(403).json({
        error: 'ویرایش فاکتور رسمی فقط برای مدیر، حسابدار یا مدیر فروش مجاز است',
        code: 'E_FINAL_AMEND_ROLE',
      });
    }
  }
  const vatFlag = resolveVatExemptFlag(newType, vat_exempt, row.vat_exempt);
  const discPct = parseFloat(disc) || 0;
  const discAmtOverride = (req.body && req.body.disc_amt != null && req.body.disc_amt !== '')
    ? Math.max(0, Math.round(Number(req.body.disc_amt) || 0))
    : null;
  const totals = calcDocTotals(db, built, discPct, { vatExempt: !!vatFlag, discAmt: discAmtOverride });
  const freightRial = Math.round(parseFloat(freight_amount) || 0);
  const allocMethod = ['amount', 'qty', 'equal'].includes(freight_alloc_method)
    ? freight_alloc_method
    : (row.freight_alloc_method || 'amount');
  allocateFreight(built.rows, freightRial, allocMethod);
  const freightAdj = applyFreightToDocTotals(totals, freightRial, freight_type);
  let { subtotal, discAmt, vatAmount, vatRate } = totals;
  let { final } = freightAdj;

  const isSalesRep = isSalesProformaOnlyRole(req.user.role);
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
  try {
    assertLineWarehousesAllowed(db, req.user, built.rows, whId);
  } catch (e) {
    return res.status(e.status || 403).json({ error: e.message, code: e.code || 'E_CROSS_WH_FORBIDDEN' });
  }
  let ccId = cost_center_id != null && cost_center_id !== '' ? parseInt(cost_center_id, 10) : (row.cost_center_id || null);
  if (isSalesRep) ccId = row.cost_center_id || null;

  let payPlan;
  try {
    payPlan = resolveInvoicePayments(req.body || {}, final);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  const pType = pay_type || row.pay_type || 'cash';
  const storedPayType = payPlan.splits.length
    ? headerPayTypeFromSplits(payPlan.splits, pType, final)
    : pType;
  const skipInvoiceCash = payPlan.skipInvoiceCash;
  const journalOpts = {
    payType: skipInvoiceCash ? 'credit' : storedPayType,
    bankId: skipInvoiceCash ? null : (bank_id || row.bank_id || null),
    cashBoxId: skipInvoiceCash ? null : (cash_box_id || row.cash_box_id || null),
    rows: built.rows,
    freightRial, freightType: freight_type,
  };

  if (row.type === 'normal' || row.type === 'final') {
    // In-place amendment re-posts stock as deltas against the ORIGINAL rows, which presumes they were
    // deducted. A backorder/provisional invoice never moved stock — R13: cancel and re-issue instead.
    if (row.fulfillment_state === FULFILLMENT_STATES.BACKORDER || row.fulfillment_state === FULFILLMENT_STATES.PROVISIONAL) {
      return res.status(409).json({
        error: 'فاکتور بک‌اوردر/موقت (بدون کسر موجودی) قابل ویرایش نیست — آن را ابطال و دوباره ثبت کنید',
        code: 'E_ATP_AMEND_LOCKED',
        fulfillment_state: row.fulfillment_state,
      });
    }
    try {
      resolveCashPaid(req.body || {}, final);
      if (storedPayType === 'cash' && !payPlan.splits.length) {
        assertCashBoxRequired('cash', cash_box_id || row.cash_box_id);
      }
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message, code: e.code || 'E_CASH_BOX_REQUIRED' });
    }
    try {
      const amended = db.transaction(() => amendPostedInvoiceInPlace(db, {
        row, built, totals, freightAdj, req, body: req.body, newType, whId, ccId, payPlan,
        journalOpts, freightRial, freight_type, allocMethod, storedPayType, skipInvoiceCash,
        salesChannel: resolveSalesChannel(req),
      }))();
      try {
        let prevRows = [];
        try { prevRows = JSON.parse(row.rows || '[]'); } catch (_) { prevRows = []; }
        const prevKeys = new Set(listCrossWarehouseLines(prevRows, row.warehouse_id).map((x) => `${x.product_id}:${x.variant_id}:${x.from_wh}`));
        for (const x of listCrossWarehouseLines(built.rows, whId)) {
          const k = `${x.product_id}:${x.variant_id}:${x.from_wh}`;
          if (!prevKeys.has(k)) audit(req.user.id, 'cross_warehouse_sale', 'invoice', row.id, JSON.stringify(x));
        }
      } catch (_) {}
      const updated = db.prepare(`${INVOICE_JOIN_SQL} WHERE i.id=?`).get(row.id);
      return res.json(applyCatalogCostPolicy(db, req.user, {
        ...updated,
        rows: JSON.parse((updated && updated.rows) || '[]'),
        amended: true,
        journal_id: amended.journal_id,
        used_warehouses: amended.usedWarehouses || [],
      }));
    } catch (e) {
      return res.status(e.status || 400).json(shortagePayload(db, e, { error: e.message, code: e.code }));
    }
  }

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
             allocMethod, vatFlag, ccId, moadianType, req.params.id);
      persistInvoicePayPlan(db, req.params.id, payPlan, req.body || {});
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
  try {
    let prevRows = [];
    try { prevRows = JSON.parse(row.rows || '[]'); } catch (_) { prevRows = []; }
    const prevKeys = new Set(listCrossWarehouseLines(prevRows, row.warehouse_id).map((x) => `${x.product_id}:${x.variant_id}:${x.from_wh}`));
    for (const x of listCrossWarehouseLines(built.rows, whId)) {
      const k = `${x.product_id}:${x.variant_id}:${x.from_wh}`;
      if (!prevKeys.has(k)) audit(req.user.id, 'cross_warehouse_sale', 'invoice', row.id, JSON.stringify(x));
    }
  } catch (_) {}
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
  if (row.status === 'reversed') {
    return res.status(400).json({ error: 'این فاکتور قبلاً ابطال شده است' });
  }
  const activeReturns = db.prepare(
    "SELECT COUNT(*) AS c FROM sales_returns WHERE invoice_id=? AND COALESCE(status,'posted')<>'reversed'"
  ).get(row.id).c;
  if (activeReturns > 0) {
    return res.status(400).json({ error: `این فاکتور ${activeReturns} مرجوعی فروش فعال دارد — ابتدا مرجوعی را ابطال کنید` });
  }
  try {
    let result;
    // Stock reversal + full void are one unit: any failure leaves stock, JE and invoice untouched.
    db.transaction(() => {
      // When deductStock posted inventory_movements, reverse those first and clear
      // stock_deducted so voidInvoiceFully does not double-restore header stock.
      // Legacy / perpetual docs (no inventory_movements) keep void-invoice path.
      if (row.stock_deducted) {
        const movCount = db.prepare(
          "SELECT COUNT(*) AS c FROM inventory_movements WHERE doc_type='invoice' AND doc_id=?"
        ).get(row.id).c;
        if (movCount > 0) {
          const { reverseStockDocument } = require('../lib/inventory/movement');
          reverseStockDocument(db, {
            docType: 'invoice',
            docId: row.id,
            userId: req.user.id,
            note: `بازگشت موجودی از لغو فاکتور ${row.num}`,
          });
          db.prepare('UPDATE invoices SET stock_deducted=0 WHERE id=?').run(row.id);
        }
      }
      // Backorder / provisional invoices have stock_deducted=0 → nothing was taken, nothing is restored.
      result = voidInvoiceFully(db, row.id, req.user, { reason: 'void' });
      if (result.restoredToProforma && row.fulfillment_state) {
        // Un-convert: an active proforma is never committed demand — drop the backorder/provisional label.
        db.prepare('UPDATE invoices SET fulfillment_state=? WHERE id=?').run(FULFILLMENT_STATES.DEDUCTED, row.id);
      }
    })();
    res.json({
      ok: true,
      restoredToProforma: result.restoredToProforma,
      settlementsReversed: result.settlementsReversed,
      title: result.title,
      fulfillment_state: row.fulfillment_state || '',
    });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message || 'خطا در ابطال', code: e.code });
  }
});

// Convert proforma → normal|final (default final for backward compatibility)
router.post('/:id/convert', auth, (req, res) => {
  const db = getDB();
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'یافت نشد' });
  if (!canConvertProforma(req, inv)) {
    return res.status(403).json({
      error: isSalesProformaOnlyRole(req.user.role)
        ? 'تبدیل پیش‌فاکتور برای کارشناس فروش مجاز نیست — فقط مدیر یا حسابدار'
        : 'دسترسی ندارید',
      code: 'E_CONVERT_FORBIDDEN',
    });
  }
  if (inv.converted) return res.status(400).json({ error: 'قبلاً تبدیل شده' });
  if (isFirmSale(inv.type)) return res.status(400).json({ error: 'این فاکتور قبلاً قطعی است' });

  let targetType;
  try { targetType = normalizeInvoiceType(req.body?.target_type || req.body?.type || 'final'); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message, code: e.code }); }
  if (!isFirmSale(targetType)) {
    return res.status(400).json({ error: 'هدف تبدیل باید فاکتور معمولی یا رسمی باشد' });
  }

  const rows = JSON.parse(inv.rows || '[]');
  // Preserve proforma pricing policy on convert (v539): same vat_exempt + disc_amt as create/amend.
  // Without this, exempt/normal proformas were recalculated with default VAT → final jumped ~+10%.
  const built = { rows, subtotal: inv.subtotal };
  const convertVatExempt = !!Number(inv.vat_exempt);
  const convertDiscAmt = (inv.disc_amt != null && inv.disc_amt !== '')
    ? Math.max(0, Math.round(Number(inv.disc_amt) || 0))
    : null;
  const totals = calcDocTotals(db, built, inv.disc || 0, {
    vatExempt: convertVatExempt,
    ...(convertDiscAmt != null ? { discAmt: convertDiscAmt } : {}),
  });
  const freightAdj = applyFreightToDocTotals(totals, inv.freight_amount, inv.freight_type);
  totals.final = freightAdj.final;
  totals.netBeforeVat = freightAdj.netBeforeVat;
  const owner = db.prepare('SELECT role, sales_warehouse_id FROM users WHERE id=?').get(inv.user_id);
  let convertWhId = req.body?.warehouse_id
    ? parseInt(req.body.warehouse_id, 10)
    : (inv.warehouse_id || null);
  if (owner && isSalesProformaOnlyRole(owner.role)) {
    if (!owner.sales_warehouse_id) {
      return res.status(400).json({ error: 'انبار فروش برای کاربر صادرکننده تعریف نشده' });
    }
    convertWhId = owner.sales_warehouse_id;
    applyHeaderWarehouseToLines(rows, convertWhId, { force: true });
  } else if (!convertWhId && owner?.sales_warehouse_id) {
    convertWhId = owner.sales_warehouse_id;
  }

  try {
    // Convert gate uses the converting user (req.user), not the original issuer.
    assertLineWarehousesAllowed(db, req.user, rows, convertWhId);
  } catch (e) {
    return res.status(e.status || 403).json({ error: e.message, code: e.code || 'E_CROSS_WH_FORBIDDEN' });
  }

  try {
    convertWhId = requireFirmHeaderWarehouse(convertWhId);
    applyHeaderWarehouseToLines(rows, convertWhId, { force: false });
    assertWarehouseLines(db, rows, convertWhId, { requirePositive: true, allowNegativeProduct: true });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }

  let convertPay;
  try {
    convertPay = paymentsFromStoredInvoice(inv, totals.final);
    resolveCashPaid({
      pay_type: inv.pay_type, pay_amount: inv.pay_amount_rial,
      cash_box_id: inv.cash_box_id, bank_id: inv.bank_id,
    }, totals.final);
    if (String(inv.pay_type || 'cash') === 'cash' && !convertPay.splits.length) {
      assertCashBoxRequired('cash', inv.cash_box_id);
    }
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code || 'E_CASH_BOX_REQUIRED' });
  }
  try {
    const storedPt = convertPay.skipInvoiceCash ? 'credit' : (inv.pay_type || 'cash');
    const arDelta = invoiceArDeltaRial(totals.final, convertPay, storedPt);
    assertPartyCreditLimitOk(db, inv.cust_id, arDelta);
  } catch (e) {
    return res.status(e.status || 409).json({
      error: e.message, code: e.code || 'E_CREDIT_LIMIT',
      credit_limit_rial: e.credit_limit_rial, used_rial: e.used_rial,
      additional_rial: e.additional_rial, available_rial: e.available_rial,
    });
  }

  let convertFulfillment = null;
  let convertMovements = [];
  let convertNegOverrides = [];
  try {
    db.transaction(() => {
      let stockDeducted = inv.stock_deducted || 0;
      let saleCogsRial = 0;
      let fulfillmentState = FULFILLMENT_STATES.DEDUCTED;
      if (!stockDeducted) {
        // ATP gate — same transaction, before any movement (NONTAX-P0-atp). Throws → convert rolls back.
        let forceNegC = req.user.role === 'admin';
        if (!forceNegC) {
          try { forceNegC = !!require('../lib/rbac').hasPermission(db, req.user, 'inventory_negative', 'approve'); }
          catch (_) { forceNegC = false; }
        }
        convertFulfillment = decideSaleFulfillment(db, {
          rows, headerWarehouseId: convertWhId, custId: inv.cust_id, excludeInvoiceId: inv.id,
          backorderRequested: isBackorderRequested(req.body || {}), role: req.user.role,
          provisional: isProvisionalRequest(req, isDevice),
          forceAllowNegative: forceNegC,
        });
        if (convertFulfillment.mode === 'deduct') {
          if (saleUsesPerpetualValuation(db, rows, convertWhId)) {
            const stocked = runWithSaleContext({ custId: inv.cust_id }, () => postSaleStockMovements(db, {
              rows, warehouseId: convertWhId, sourceType: 'invoice', sourceId: inv.id,
              userId: req.user.id, date: inv.date || '', note: `تبدیل به ${invoiceTypeLabel(targetType)} ${inv.num}`,
              user: req.user,
            }));
            saleCogsRial = stocked.cogsRial;
            convertMovements = stocked.movements || [];
            convertNegOverrides = stocked.negativeOverrides || [];
          } else {
            const stockErr = deductStock(db, rows, convertWhId, req.user.id, { docId: inv.id, custId: inv.cust_id });
            if (stockErr) throw new Error(stockErr);
          }
          stockDeducted = 1;
        } else {
          // backorder / provisional: stock_deducted stays 0, no movement, no COGS.
          fulfillmentState = convertFulfillment.fulfillment_state;
        }
      }

      db.prepare('UPDATE invoices SET type=?,converted=1,stock_deducted=?,fulfillment_state=?,final=?,vat_amount=?,vat_rate=?,final_rial=?,vat_amount_rial=?,disc_amt=?,warehouse_id=COALESCE(?,warehouse_id),rows=? WHERE id=?')
        .run(targetType, stockDeducted, fulfillmentState, totals.final, totals.vatAmount, totals.vatRate,
          Math.round(totals.final), Math.round(totals.vatAmount), totals.discAmt, convertWhId, JSON.stringify(rows), inv.id);
      db.prepare("UPDATE customers SET status='active' WHERE id=?").run(inv.cust_id);

      postInvoiceCustomerLedger(db, {
        customerId: inv.cust_id, date: inv.date || '', invId: inv.id, num: inv.num,
        invType: targetType, final: totals.final, userId: req.user.id,
        payType: convertPay.skipInvoiceCash ? 'credit' : (inv.pay_type || 'cash'),
        skipImmediatePayment: convertPay.skipInvoiceCash,
      });
      assertJournalIdempotent(db, 'invoice', inv.id);
      postToLedger(db, {
        sourceType: 'invoice', sourceId: inv.id, date: inv.date || '',
        description: `${invoiceTypeLabel(targetType)} ${inv.num} (تبدیل از پیش‌فاکتور)`,
        createdBy: req.user.id, lines: salesJournalLines(db, inv.cust_id, {
          subtotal: totals.subtotal, discAmt: totals.discAmt, final: totals.final,
          vatAmount: totals.vatAmount, netBeforeVat: totals.netBeforeVat,
        }, false, {
          payType: convertPay.skipInvoiceCash ? 'credit' : (inv.pay_type || 'cash'),
          bankId: convertPay.skipInvoiceCash ? null : inv.bank_id,
          cashBoxId: convertPay.skipInvoiceCash ? null : inv.cash_box_id,
          rows, freightRial: Math.round(inv.freight_amount || 0), freightType: inv.freight_type,
        }),
      });
      if (convertPay.splits.length) {
        applyInvoicePaySplits(db, {
          invoiceId: inv.id, custId: inv.cust_id, date: inv.date || '',
          splits: convertPay.splits, userId: req.user.id, num: inv.num,
          chequeHeader: { cheque_info: inv.cheque_info, cheque_due_date: inv.cheque_due_date },
        });
      }
      if (saleCogsRial > 0) {
        postCogsFromMovements(db, {
          invId: inv.id, num: inv.num, date: inv.date, userId: req.user.id, cogsRial: saleCogsRial,
          movements: convertMovements,
          costCenterId: inv.cost_center_id, warehouseId: convertWhId,
        });
      }
      if (targetType === 'final') enqueueMoadian(db, 'sales', inv.id);
      if (targetType === 'normal') autoApproveNormalInvoice(db, inv.id, req.user.id);
    })();
  } catch (e) {
    const payload = { error: e.message, code: e.code };
    shortagePayload(db, e, payload);
    return res.status(e.status || 400).json(payload);
  }
  audit(req.user.id, 'convert', 'invoice', inv.id, `تبدیل پیش‌فاکتور ${inv.num} به ${invoiceTypeLabel(targetType)}`);
  try {
    for (const x of listCrossWarehouseLines(rows, convertWhId)) {
      audit(req.user.id, 'cross_warehouse_sale', 'invoice', inv.id, JSON.stringify(x));
    }
  } catch (_) {}
  try {
    for (const x of convertNegOverrides || []) {
      audit(req.user.id, 'negative_stock_override', 'invoice', inv.id, JSON.stringify(x));
    }
  } catch (_) {}

  if (!isDevice()) {
    try {
      const cust = inv.cust_id ? db.prepare('SELECT biz,owner,phone,mobile,party_group_id,user_id FROM customers WHERE id=?').get(inv.cust_id) : null;
      const { dispatchSmsEvent } = require('../lib/sms-dispatch');
      setImmediate(() => dispatchSmsEvent(db, 'invoice.converted', {
        phone: cust?.mobile || cust?.phone,
        name: cust?.owner || cust?.biz,
        biz: cust?.biz,
        amount: totals.final,
        num: inv.num,
        date: inv.date,
        status: invoiceTypeLabel(targetType),
        party_group_id: cust?.party_group_id,
        user_id: cust?.user_id,
        created_by: req.user.id,
        user: req.user.name,
      }));
    } catch (_) {}
  }

  res.json({
    ok: true,
    type: targetType,
    fulfillment_state: convertFulfillment ? convertFulfillment.fulfillment_state : (inv.fulfillment_state || ''),
    ...(convertFulfillment && convertFulfillment.mode !== 'deduct' ? { atp_shortages: convertFulfillment.shortages } : {}),
  });
});

// Standalone printable HTML page — templates from server/lib/invoice-print.js
router.get('/:id/print', auth, (req, res) => {
  const db = getDB();
  let inv = loadInvoiceRow(db, req.params.id);
  if (!inv) return res.status(404).send('فاکتور پیدا نشد');
  if (!canViewInvoice(req, inv)) return res.status(403).send('دسترسی ندارید');
  let rows = [];
  try { rows = JSON.parse(inv.rows || '[]'); } catch (_) { rows = []; }
  rows = enrichRowsProductCodes(db, rows);

  // Per-expert: hide seller phone on print when admin disabled it for that user.
  if (inv.user_id) {
    try {
      const u = db.prepare('SELECT show_phone_on_invoice FROM users WHERE id=?').get(inv.user_id);
      if (u && Number(u.show_phone_on_invoice) === 0) {
        inv = Object.assign({}, inv, { seller_phone: '' });
      }
    } catch (_) { /* column may be missing on very old DBs until migrate */ }
  }

  const settings = {
    company_name: getSetting(db, 'company_name'),
    company_address: getSetting(db, 'company_address'),
    company_phone: getSetting(db, 'company_phone'),
    company_economic_code: getSetting(db, 'company_economic_code'),
    company_national_id: getSetting(db, 'company_national_id'),
    company_postal_code: getSetting(db, 'company_postal_code'),
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
  try {
    const { renderInvoicePrintHtml } = require('../lib/invoice-print');
    let settlements = [];
    let posReceipts = [];
    try {
      const { loadInvoiceReceipts } = require('../lib/invoice-payments');
      const receipts = loadInvoiceReceipts(db, inv.id);
      settlements = receipts.settlements || [];
      posReceipts = receipts.pos || [];
    } catch (re) {
      console.warn('invoice print receipts:', re && re.message);
    }
    const html = renderInvoicePrintHtml({
      inv, rows, settings, paper, db,
      settlements,
      posReceipts,
      templateOverride: tmpl === 'thermal' ? 'thermal' : (tmpl || undefined),
    });
    return sendSecureHtml(res, html, { allowPrintScript: true });
  } catch (e) {
    console.error('invoice print:', e && e.stack || e);
    return res.status(500).send('خطا در ساخت چاپ فاکتور');
  }
});

/** برگه حواله خروج انبار — عملیاتی برای انباردار (بدون مبلغ) */
router.get('/:id/warehouse-slip', auth, (req, res) => {
  const db = getDB();
  const inv = loadInvoiceRow(db, req.params.id);
  if (!inv) return res.status(404).send('فاکتور پیدا نشد');
  if (!canViewInvoice(req, inv)) return res.status(403).send('دسترسی ندارید');
  let rows = [];
  try { rows = JSON.parse(inv.rows || '[]'); } catch (_) { rows = []; }
  rows = enrichRowsProductCodes(db, rows);
  const paperQ = String(req.query.paper || getSetting(db, 'invoice_paper_size') || 'A4').toUpperCase();
  const paper = paperQ === 'A5' ? 'A5' : 'A4';
  try {
    const {
      buildSalesInvoiceSlip, companySettings,
    } = require('../lib/warehouse-slip-print');
    const html = buildSalesInvoiceSlip(db, inv, rows, companySettings(db, getSetting), paper);
    return sendSecureHtml(res, html, { allowPrintScript: true });
  } catch (e) {
    console.error('invoice warehouse-slip:', e && e.stack || e);
    return res.status(500).send('خطا در ساخت حواله انبار');
  }
});

module.exports = router;
