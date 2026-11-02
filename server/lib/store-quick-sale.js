'use strict';
/**
 * فروش سریع فروشگاهی (Quick Store Sale) — thin shell over firm invoices.
 * Walk-in customer + retail defaults + warehouse/cash locks + exchange.
 */
const { resolveInvoicePayments } = require('./invoice-payments');
const { moneyRial } = require('./cash-on-document');
const { todayJalali } = require('../jalali');

const WALKIN_BIZ = 'مشتری نقدی فروشگاه';
const STORE_CHANNEL = 'store_quick';
const SETTINGS_KEY = 'store_walkin_customer_id';
const CREDITISH = new Set(['cheque', 'credit']);

function isStoreRetailRole(role) {
  return String(role || '') === 'store_retail';
}

function locksStoreWarehouse(role) {
  return isStoreRetailRole(role);
}

function locksStoreCashBox(role) {
  return isStoreRetailRole(role);
}

function isStoreQuickRequest(body, role) {
  if (isStoreRetailRole(role)) return true;
  const b = body || {};
  return !!(b.store_quick || b.sales_channel === STORE_CHANNEL);
}

function getSetting(db, key) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? String(r.value || '') : '';
}

function ensureWalkinCustomer(db) {
  const saved = parseInt(getSetting(db, SETTINGS_KEY), 10);
  if (saved > 0) {
    const exists = db.prepare('SELECT id FROM customers WHERE id=?').get(saved);
    if (exists) return saved;
  }
  let row = db.prepare('SELECT id FROM customers WHERE biz=? LIMIT 1').get(WALKIN_BIZ);
  // Devices receive the shared walk-in from central (pull). A local seed would
  // take a low id that collides with central rows and blocks pairing.
  if (!row && process.env.SYNC_ROLE === 'device') return 0;
  if (!row) {
    const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND COALESCE(active,1)=1 ORDER BY id LIMIT 1").get()
      || db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
    const userId = admin ? admin.id : 1;
    const ins = db.prepare(
      `INSERT INTO customers (user_id, biz, owner, phone, type, status, note)
       VALUES (?,?,?,?,?,?,?)`
    ).run(
      userId,
      WALKIN_BIZ,
      'فروش حضوری',
      '',
      'فروشگاه',
      'active',
      'سیستمی — فروش سریع فروشگاهی (walk-in)'
    );
    row = { id: Number(ins.lastInsertRowid) };
    try {
      require('./parties-sync').syncCustomerToParty(db, row.id);
    } catch (_) { /* optional */ }
  }
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)")
    .run(SETTINGS_KEY, String(row.id));
  return Number(row.id);
}

function getWalkinCustomerId(db) {
  return ensureWalkinCustomer(db);
}

function isWalkinCustomer(db, custId) {
  const id = parseInt(custId, 10);
  if (!(id > 0)) return false;
  const walkinId = getWalkinCustomerId(db);
  if (id === walkinId) return true;
  const row = db.prepare('SELECT biz FROM customers WHERE id=?').get(id);
  return !!(row && String(row.biz || '').trim() === WALKIN_BIZ);
}

/**
 * Invariant (v395): walk-in cash desk customer is shared, but non-admin/accounting
 * users may only READ transactions they personally created (invoices.user_id /
 * settlements.user_id / sales_returns.user_id). Impersonation uses effective req.user.
 */
function seesAllWalkinTransactions(role) {
  return role === 'admin' || role === 'accounting';
}

function restrictWalkinTransactions(db, userOrRole, custId) {
  const role = userOrRole && typeof userOrRole === 'object'
    ? userOrRole.role
    : userOrRole;
  if (seesAllWalkinTransactions(role)) return false;
  return isWalkinCustomer(db, custId);
}

/** null = not walk-in (caller keeps default RBAC); boolean = walk-in decision. */
function canViewWalkinInvoice(db, req, inv) {
  if (!inv || !isWalkinCustomer(db, inv.cust_id)) return null;
  if (seesAllWalkinTransactions(req.user && req.user.role)) return true;
  return Number(inv.user_id) === Number(req.user && req.user.id);
}

/** Visible to every scoped sales user even though customers.user_id is admin. */
function walkinListVisibilityOrSql(db, alias) {
  const a = alias || 'c';
  const id = getWalkinCustomerId(db);
  if (!(id > 0)) return { sql: '', params: [] };
  return { sql: ` OR ${a}.id=?`, params: [id] };
}

/**
 * Personal AR-ish balance for a cashier on the shared walk-in customer
 * (ledger lines they posted + firm invoices they own that are not yet in ledger).
 */
function walkinPersonalBalanceRial(db, custId, userId) {
  const cid = parseInt(custId, 10);
  const uid = parseInt(userId, 10);
  if (!(cid > 0) || !(uid > 0)) return 0;
  let bal = 0;
  try {
    bal = Number(db.prepare(`
      SELECT COALESCE(SUM(COALESCE(debit,0) - COALESCE(credit,0)), 0) AS b
      FROM customer_ledger WHERE customer_id=? AND user_id=?
    `).get(cid, uid)?.b) || 0;
  } catch (_) { bal = 0; }
  try {
    const { firmSaleTypeSql } = require('./sales-document');
    const missing = db.prepare(`
      SELECT COALESCE(SUM(i.final), 0) AS s
      FROM invoices i
      WHERE i.cust_id=? AND i.user_id=? AND ${firmSaleTypeSql('i')}
        AND COALESCE(i.deleted_at,0)=0
        AND COALESCE(i.status,'')<>'reversed'
        AND NOT EXISTS (
          SELECT 1 FROM customer_ledger cl
          WHERE cl.customer_id=i.cust_id AND cl.ref_type='invoice' AND cl.ref_id=i.id
            AND COALESCE(cl.entry_type,'')<>'reversal'
        )
    `).get(cid, uid);
    bal += Number(missing && missing.s) || 0;
  } catch (_) { /* optional */ }
  return Math.round(bal);
}

function retailUnitPriceRial(prod) {
  if (!prod) return 0;
  const retail = Math.round(Number(prod.retail_price_rial || prod.retail_price) || 0);
  if (retail > 0) return retail;
  return Math.round(Number(prod.price_rial || prod.price) || 0);
}

function priceOverrideForbidden(prod, listRial, sentRial) {
  const e = new Error(
    `تغییر قیمت «${(prod && prod.name) || 'کالا'}» از ${Number(listRial).toLocaleString('fa-IR')} به ${Number(sentRial).toLocaleString('fa-IR')} ریال نیازمند مجوز «تغییر قیمت فروش» (مدیر) است`
  );
  e.status = 403;
  e.code = 'E_PRICE_OVERRIDE_FORBIDDEN';
  e.product_id = prod && prod.id;
  e.list_price_rial = listRial;
  e.price_rial = sentRial;
  return e;
}

/**
 * Apply retail defaults and stamp list_price_rial / price_overridden on every product row.
 *  - opts.enforcePriceOverride (POS path): a client unit_price that differs from the list
 *    (retail) price needs opts.canOverridePrice (`price_override:edit`) → else 403
 *    E_PRICE_OVERRIDE_FORBIDDEN. No price / same price is always fine.
 *  - legacy (no enforce): forceRetail ignores client unit_price unless opts.allowPriceOverride.
 */
function applyRetailRowDefaults(db, rows, opts) {
  const forceRetail = !!(opts && opts.forceRetail);
  const allowOverride = !!(opts && opts.allowPriceOverride);
  const enforce = !!(opts && opts.enforcePriceOverride);
  const canOverride = !!(opts && opts.canOverridePrice);
  return (Array.isArray(rows) ? rows : []).map((r) => {
    if (!r || r.row_type === 'income') return r;
    const pid = parseInt(r.product_id, 10);
    if (!(pid > 0)) return r;
    const prod = db.prepare(
      'SELECT id, retail_price_rial, retail_price, price_rial, price, name, code, barcode, unit FROM products WHERE id=?'
    ).get(pid);
    if (!prod) return r;
    const retail = retailUnitPriceRial(prod);
    const sent = Math.round(Number(r.unit_price != null ? r.unit_price : r.price) || 0);
    let unit;
    if (enforce) {
      if (sent > 0 && retail > 0 && sent !== retail && !canOverride) {
        throw priceOverrideForbidden(prod, retail, sent);
      }
      unit = sent > 0 ? sent : retail;
    } else if (forceRetail && !allowOverride) {
      unit = retail > 0 ? retail : (sent > 0 ? sent : 0);
    } else {
      unit = sent > 0 ? sent : retail;
    }
    return {
      ...r,
      name: r.name || prod.name,
      code: r.code || prod.code || prod.barcode || '',
      unit: r.unit || prod.unit || 'عدد',
      unit_price: unit,
      price: unit,
      list_price_rial: retail,
      price_overridden: retail > 0 && unit !== retail ? 1 : 0,
    };
  });
}

const PRICE_FLOOR_MODE_KEY = 'store_price_floor_mode';

/** `warn` (default) | `block`. */
function getPriceFloorMode(db) {
  return getSetting(db, PRICE_FLOOR_MODE_KEY).trim().toLowerCase() === 'block' ? 'block' : 'warn';
}

/**
 * POS price floor: effective unit (after line discount) below products.min_price_rial or
 * below unit cost → warning. Mode `block` refuses (422 E_PRICE_BELOW_FLOOR) only lines the
 * cashier changed (price override or line discount); the catalog price itself only warns.
 * Cost is reported only to users with cost_visibility:view.
 * @param {Array} rows  built invoice rows (price, qty, disc_amount, list_price_rial, price_overridden)
 * @returns {{ mode:string, warnings:Array }}
 */
function applyPriceFloorPolicy(db, user, rows, opts) {
  const mode = getPriceFloorMode(db);
  const out = { mode, warnings: [] };
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return out;
  let canSeeCost = false;
  try {
    canSeeCost = !!(user && (user.role === 'admin'
      || require('./rbac').hasPermission(db, user, 'cost_visibility', 'view')));
  } catch (_) { canSeeCost = false; }
  const { productUnitCostRial } = require('./inventory/product-unit-cost');
  const headerDisc = !!(opts && opts.headerDiscount);
  const blocking = [];
  for (const r of list) {
    if (!r || r.row_type === 'income') continue;
    const pid = parseInt(r.product_id, 10);
    if (!(pid > 0)) continue;
    const qty = Number(r.qty) || 0;
    if (!(qty > 0)) continue;
    const prod = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
    if (!prod) continue;
    const lineDisc = Math.max(0, Math.round(Number(r.disc_amount != null ? r.disc_amount : r.disc_amt) || 0));
    const unitNet = Math.round((qty * (Number(r.price) || 0) - lineDisc) / qty);
    const minPrice = Math.max(0, Math.round(Number(prod.min_price_rial) || 0));
    let cost = 0;
    try { cost = Math.round(productUnitCostRial(prod) || 0); } catch (_) { cost = 0; }
    const userChanged = !!(Number(r.price_overridden) || lineDisc > 0 || headerDisc);
    const name = prod.name || r.name || 'کالا';
    if (minPrice > 0 && unitNet < minPrice) {
      const w = {
        code: 'W_PRICE_BELOW_MIN',
        product_id: pid,
        name,
        unit_net_rial: unitNet,
        min_price_rial: minPrice,
        message: `قیمت «${name}» (${unitNet.toLocaleString('fa-IR')} ریال) کمتر از حداقل قیمت مجاز (${minPrice.toLocaleString('fa-IR')} ریال) است`,
      };
      out.warnings.push(w);
      if (userChanged) blocking.push(w);
    }
    if (cost > 0 && unitNet < cost) {
      const w = {
        code: 'W_PRICE_BELOW_COST',
        product_id: pid,
        name,
        unit_net_rial: unitNet,
        message: canSeeCost
          ? `قیمت «${name}» (${unitNet.toLocaleString('fa-IR')} ریال) کمتر از بهای تمام‌شده (${cost.toLocaleString('fa-IR')} ریال) است`
          : `قیمت «${name}» کمتر از بهای تمام‌شده است`,
      };
      if (canSeeCost) w.cost_rial = cost;
      out.warnings.push(w);
      if (userChanged) blocking.push(w);
    }
  }
  if (mode === 'block' && blocking.length) {
    const e = new Error(`${blocking[0].message} — فروش زیر کف قیمت مسدود است (تنظیم store_price_floor_mode)`);
    e.status = 422;
    e.code = 'E_PRICE_BELOW_FLOOR';
    e.floor = blocking;
    throw e;
  }
  return out;
}

function loadUserStorePrefs(db, userId) {
  if (!(userId > 0)) return null;
  return db.prepare(
    'SELECT id, name, role, sales_warehouse_id, sales_cash_box_id FROM users WHERE id=?'
  ).get(userId);
}

function resolveStoreWarehouseId(db, user, body) {
  const uid = user && user.id;
  const self = loadUserStorePrefs(db, uid);
  if (locksStoreWarehouse(user && user.role)) {
    if (!self || !self.sales_warehouse_id) {
      const e = new Error('انبار فروش برای کاربر فروشگاهی تعریف نشده — از مدیر بخواهید در تعریف کاربر انبار فروش را تنظیم کند');
      e.status = 400;
      e.code = 'E_STORE_WAREHOUSE_REQUIRED';
      throw e;
    }
    return Number(self.sales_warehouse_id);
  }
  const fromBody = body && body.warehouse_id ? parseInt(body.warehouse_id, 10) : 0;
  if (fromBody > 0) return fromBody;
  if (self && self.sales_warehouse_id) return Number(self.sales_warehouse_id);
  const e = new Error('انبار فروشگاهی را انتخاب کنید');
  e.status = 400;
  e.code = 'E_STORE_WAREHOUSE_REQUIRED';
  throw e;
}

function resolveStoreCashBoxId(db, user, body, opts) {
  const required = !(opts && opts.optional);
  const uid = user && user.id;
  const self = loadUserStorePrefs(db, uid);
  if (locksStoreCashBox(user && user.role)) {
    if (!self || !self.sales_cash_box_id) {
      const e = new Error('صندوق فروش برای کاربر فروشگاهی تعریف نشده — از مدیر بخواهید در تعریف کاربر صندوق فروش را تنظیم کند');
      e.status = 400;
      e.code = 'E_STORE_CASHBOX_REQUIRED';
      throw e;
    }
    return Number(self.sales_cash_box_id);
  }
  const fromBody = body && body.cash_box_id ? parseInt(body.cash_box_id, 10) : 0;
  if (fromBody > 0) return fromBody;
  if (self && self.sales_cash_box_id) return Number(self.sales_cash_box_id);
  if (!required) return null;
  const e = new Error('صندوق فروشگاهی را انتخاب کنید');
  e.status = 400;
  e.code = 'E_STORE_CASHBOX_REQUIRED';
  throw e;
}

/**
 * Walk-in must settle fully with cash/card.
 * exchangeCreditRial: credit from same-ticket sales return that offsets the invoice.
 */
function assertWalkinSettlement(db, custId, body, finalAmt, opts) {
  if (!isWalkinCustomer(db, custId)) return;
  const exchangeCredit = moneyRial((opts && opts.exchangeCreditRial) || 0);
  const plan = resolveInvoicePayments(body || {}, finalAmt);
  if (Number(plan.creditRial) > 0) {
    const e = new Error('برای نسیه باید مشتری واقعی (غیر از مشتری نقدی فروشگاه) انتخاب شود');
    e.status = 400;
    e.code = 'E_WALKIN_NO_CREDIT';
    throw e;
  }
  const paid = (plan.splits || []).reduce((a, s) => a + Number(s.amount || 0), 0);
  const final = moneyRial(finalAmt);
  const covered = moneyRial(paid) + Math.min(exchangeCredit, final);
  if (Math.abs(covered - final) > 0.5) {
    const e = new Error(
      exchangeCredit > 0
        ? 'فروش به «مشتری نقدی فروشگاه» باید با نقد/کارت به‌علاوه اعتبار برگشت همین تعویض کاملاً تسویه شود'
        : 'فروش به «مشتری نقدی فروشگاه» باید کاملاً با نقد یا کارت تسویه شود — برای نسیه مشتری واقعی انتخاب کنید'
    );
    e.status = 400;
    e.code = 'E_WALKIN_MUST_SETTLE';
    throw e;
  }
  for (const s of plan.splits || []) {
    if (CREDITISH.has(s.pay_type)) {
      const e = new Error('برای چک یا نسیه باید مشتری واقعی (غیر از مشتری نقدی فروشگاه) انتخاب شود');
      e.status = 400;
      e.code = 'E_WALKIN_NO_CREDIT';
      throw e;
    }
  }
  const headerPt = String((body && body.pay_type) || '').toLowerCase();
  if (CREDITISH.has(headerPt) && !(body.pay_splits && body.pay_splits.length) && !(exchangeCredit >= final - 0.5)) {
    const e = new Error('برای چک یا نسیه باید مشتری واقعی انتخاب شود');
    e.status = 400;
    e.code = 'E_WALKIN_NO_CREDIT';
    throw e;
  }
}

function assertFirmStoreType(invType) {
  if (invType !== 'normal' && invType !== 'final') {
    const e = new Error('فروش سریع فروشگاهی فقط فاکتور معمولی یا رسمی است');
    e.status = 400;
    e.code = 'E_STORE_FIRM_ONLY';
    throw e;
  }
}

/** FR-POS-DRAFTS: `price_override:edit` (admin always; store_retail never by default). */
function canOverrideStorePrice(db, user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  try {
    return !!require('./rbac').hasPermission(db, user, 'price_override', 'edit');
  } catch (_) {
    return false;
  }
}

/**
 * Mutate/normalize body for store quick sale before invoice create.
 */
function prepareStoreQuickSaleBody(db, user, body) {
  const b = { ...(body || {}) };
  b.store_quick = true;
  b.sales_channel = STORE_CHANNEL;
  // P6: `idempotency_key` is the settlement-contract name for client_request_id.
  if (!b.client_request_id && b.idempotency_key) b.client_request_id = String(b.idempotency_key);
  if (!b.type || b.type === 'proforma') b.type = 'normal';
  const custId = parseInt(b.cust_id, 10);
  if (!(custId > 0)) {
    const walkinId = getWalkinCustomerId(db);
    if (!(walkinId > 0)) {
      const e = new Error('مشتری نقدی فروشگاه هنوز از سرور مرکزی دریافت نشده — یک‌بار همگام‌سازی کنید');
      e.status = 409;
      throw e;
    }
    b.cust_id = walkinId;
  }
  const whId = resolveStoreWarehouseId(db, user, b);
  b.warehouse_id = whId;
  const role = user && user.role;
  const canOverridePrice = canOverrideStorePrice(db, user);
  b.rows = applyRetailRowDefaults(db, b.rows, {
    forceRetail: isStoreRetailRole(role),
    allowPriceOverride: canOverridePrice,
    enforcePriceOverride: true,
    canOverridePrice,
  });
  for (const r of b.rows) {
    if (r && r.row_type !== 'income') r.warehouse_id = whId;
  }
  // Cash box default when tender needs cash and body omitted it
  const isCashSplit = (s) => !!s && (s.pay_type === 'cash' || String(s.method || '').toLowerCase() === 'cash');
  const needsCash = String(b.pay_type || '').toLowerCase() === 'cash'
    || (Array.isArray(b.pay_splits) && b.pay_splits.some(isCashSplit));
  if (needsCash && !(parseInt(b.cash_box_id, 10) > 0)) {
    try {
      b.cash_box_id = resolveStoreCashBoxId(db, user, b, { optional: !locksStoreCashBox(user && user.role) });
    } catch (_) { /* leave for assert downstream */ }
  }
  if (Array.isArray(b.pay_splits)) {
    let lockedCash = null;
    if (locksStoreCashBox(user && user.role)) {
      lockedCash = resolveStoreCashBoxId(db, user, b);
    }
    b.pay_splits = b.pay_splits.map((s) => {
      if (!isCashSplit(s)) return s;
      const id = lockedCash || parseInt(s.cash_box_id, 10) || parseInt(b.cash_box_id, 10) || null;
      return { ...s, cash_box_id: id };
    });
  }
  return b;
}

/**
 * Quick-sale: payment sum must equal server final (no silent AR from mismatch).
 * Explicit credit pay_type without splits is allowed for non-walk-in customers.
 */
function assertStorePaymentMatchesFinal(body, finalAmt, opts) {
  const exchangeCredit = moneyRial((opts && opts.exchangeCreditRial) || 0);
  const final = moneyRial(finalAmt);
  const expect = Math.max(0, final - Math.min(exchangeCredit, final));
  const headerPt = String((body && body.pay_type) || '').toLowerCase();
  const explicitCredit = CREDITISH.has(headerPt)
    && !(Array.isArray(body.pay_splits) && body.pay_splits.length);
  if (explicitCredit) return;
  if (expect <= 0) return;
  const plan = resolveInvoicePayments(body || {}, expect);
  // P6: explicit `method:'credit'` portions stay on AR and count as covered.
  const paid = (plan.splits || []).reduce((a, s) => a + moneyRial(s.amount), 0)
    + moneyRial(plan.creditRial || 0);
  if (Math.abs(moneyRial(paid) - expect) > 0.5) {
    const diff = moneyRial(paid) - expect;
    const e = new Error(
      `جمع پرداخت (${moneyRial(paid)}) با مبلغ نهایی فاکتور (${expect}) هم‌خوان نیست — `
      + (diff < 0 ? `${-diff} ریال کم است` : `${diff} ریال بیشتر است`)
      + '؛ ردیف‌های تسویه (نقد/کارت/چک/نسیه) را اصلاح کنید'
    );
    e.status = 400;
    e.code = 'E_STORE_TOTAL_MISMATCH';
    e.paid = moneyRial(paid);
    e.final = expect;
    throw e;
  }
}

function assertStoreQuickSaleRules(db, user, body, ctx) {
  const b = body || {};
  assertFirmStoreType(ctx && ctx.invType);
  const custId = parseInt(b.cust_id, 10);
  if (!(custId > 0)) {
    const e = new Error('مشتری الزامی است');
    e.status = 400;
    e.code = 'E_STORE_CUST_REQUIRED';
    throw e;
  }
  if (locksStoreWarehouse(user && user.role)) {
    resolveStoreWarehouseId(db, user, b);
  }
  assertStorePaymentMatchesFinal(b, ctx && ctx.final, {
    exchangeCreditRial: ctx && ctx.exchangeCreditRial,
  });
  assertWalkinSettlement(db, custId, b, ctx && ctx.final, {
    exchangeCreditRial: ctx && ctx.exchangeCreditRial,
  });
}

const STOCK_MODE_KEY = 'store_insufficient_stock_mode';

/** `warn` (default) | `block`. Anything else reads as warn. */
function getInsufficientStockMode(db) {
  return getSetting(db, STOCK_MODE_KEY).trim().toLowerCase() === 'block' ? 'block' : 'warn';
}

/**
 * P6 — store sale vs. insufficient stock (setting `store_insufficient_stock_mode`).
 *  - block → 422 E_STORE_INSUFFICIENT_STOCK (sale refused, nothing posted).
 *  - warn  → sale proceeds; stock may go negative for THIS ticket (`force`), response carries a warning.
 * Explicit backorder requests keep their own (admin/accounting) path and skip this policy.
 * @returns {{ mode:string, shortages:Array, force:boolean, warnings:Array }}
 */
function applyInsufficientStockPolicy(db, { rows, warehouseId, custId, backorder } = {}) {
  const mode = getInsufficientStockMode(db);
  const none = { mode, shortages: [], force: false, warnings: [] };
  if (backorder) return none;
  const atp = require('./inventory/available-to-promise');
  const { shortages } = atp.evaluateAvailableToPromise(db, rows || [], warehouseId, { custId });
  if (!shortages || !shortages.length) return none;
  const msg = atp.shortageMessage(shortages[0]);
  if (mode === 'block') {
    const e = new Error(msg);
    e.status = 422;
    e.code = 'E_STORE_INSUFFICIENT_STOCK';
    e.shortages = shortages;
    throw e;
  }
  return {
    mode,
    shortages,
    force: true,
    warnings: [{ code: 'W_STORE_INSUFFICIENT_STOCK', message: msg, shortages }],
  };
}

/**
 * Scale pay_splits so they sum to targetRial (preserve ratios). Empty if target <= 0.
 */
function scalePaySplitsToNet(splits, targetRial) {
  const target = moneyRial(targetRial);
  if (!(target > 0)) return [];
  const list = Array.isArray(splits) ? splits.filter((s) => s && Number(s.amount) > 0) : [];
  if (!list.length) return [];
  const sum = list.reduce((a, s) => a + moneyRial(s.amount), 0);
  if (!(sum > 0)) return [];
  let allocated = 0;
  const out = list.map((s, i) => {
    if (i === list.length - 1) {
      return { ...s, amount: Math.max(0, target - allocated) };
    }
    const amt = Math.round((moneyRial(s.amount) / sum) * target);
    allocated += amt;
    return { ...s, amount: amt };
  });
  return out.filter((s) => moneyRial(s.amount) > 0);
}

/**
 * Resolve stable numeric source id for store_exchange_refund JE / customer_ledger.
 * Prefer sales_return id so R13 void can find rows despite INTEGER affinity
 * (legacy string keys like ret-12 / ex-12-34 often coerced or stored as TEXT).
 */
function storeExchangeRefundSourceId({ returnId, exchangeKey, custId } = {}) {
  if (Number(returnId) > 0) return Number(returnId);
  const key = String(exchangeKey || '');
  const m = key.match(/^(?:ret|ex)-(\d+)/);
  if (m) return Number(m[1]);
  if (/^\d+$/.test(key)) return Number(key);
  return String(key || `${custId || 0}-${Date.now()}`).slice(0, 64);
}

/**
 * Refund excess return credit to customer from cash box (AR debit + cash credit).
 */
function postStoreExchangeRefund(db, {
  custId, amountRial, cashBoxId, userId, date, note, exchangeKey, returnId,
}) {
  const amt = moneyRial(amountRial);
  if (!(amt > 0)) return null;
  if (!(parseInt(cashBoxId, 10) > 0)) {
    const e = new Error('برای استرداد وجه، صندوق الزامی است');
    e.status = 400;
    e.code = 'E_STORE_REFUND_CASHBOX';
    throw e;
  }
  const { createLedgerEntry } = require('../db');
  const { postToLedger } = require('./ledger');
  const { settlementAssetAccount } = require('./invoice-payments');
  const { acct } = require('./coa-map');
  const cash = settlementAssetAccount(db, { pay_type: 'cash', cash_box_id: cashBoxId });
  const c = custId ? db.prepare('SELECT coa_code FROM customers WHERE id=?').get(custId) : null;
  let ar = null;
  if (c && c.coa_code) {
    ar = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(c.coa_code);
  }
  if (!ar) ar = acct(db, 'coa_receivable');

  const sourceId = storeExchangeRefundSourceId({ returnId, exchangeKey, custId });
  createLedgerEntry(db, {
    customer_id: custId,
    date: date || todayJalali(),
    entry_type: 'store_exchange_refund',
    ref_type: 'store_exchange_refund',
    ref_id: sourceId,
    description: note || 'استرداد تعویض فروشگاهی',
    debit: amt,
    credit: 0,
    user_id: userId,
  });
  const jeId = postToLedger(db, {
    sourceType: 'store_exchange_refund',
    sourceId,
    date: date || todayJalali(),
    description: note || 'استرداد تعویض فروشگاهی',
    createdBy: userId,
    lines: [
      { code: ar.code, name: ar.name, debit: amt, credit: 0 },
      { code: cash.code, name: cash.name, debit: 0, credit: amt },
    ],
  });
  return { journal_id: jeId, amount_rial: amt, cash_box_id: Number(cashBoxId), source_id: sourceId };
}

/**
 * R13: soft-void store_exchange_refund JE + retire customer_ledger for a sales return.
 * Matches numeric return id (v504+) and legacy string keys / description tokens.
 */
function voidStoreExchangeRefund(db, { returnId, userId, reason } = {}) {
  const rid = Number(returnId);
  if (!(rid > 0)) return { voided: 0, ledger: 0 };
  const { reverseJournalEntry } = require('./void-journal');
  const reasonText = reason || `ابطال استرداد فروشگاهی — برگشت #${rid}`;
  const jes = db.prepare(`
    SELECT id FROM journal_entries
    WHERE ref_type='store_exchange_refund'
      AND COALESCE(deleted_at,0)=0
      AND COALESCE(status,'posted') NOT IN ('reversed','void')
      AND (
        CAST(ref_id AS TEXT)=?
        OR CAST(ref_id AS TEXT)=?
        OR CAST(ref_id AS TEXT) LIKE ?
        OR description LIKE ?
      )
  `).all(String(rid), `ret-${rid}`, `ex-${rid}-%`, `%برگشت #${rid}%`);

  let voided = 0;
  for (const je of jes) {
    reverseJournalEntry(db, je.id, {
      userId,
      reason: reasonText,
      sourceType: 'store_exchange_refund',
    });
    voided += 1;
  }

  const { retireCustomerLedgerByRef } = require('./party-ledger-retire');
  let ledger = retireCustomerLedgerByRef(db, {
    refTypes: ['store_exchange_refund'],
    refId: rid,
  });
  try {
    const leg = db.prepare(`
      DELETE FROM customer_ledger
      WHERE ref_type='store_exchange_refund'
        AND (
          CAST(ref_id AS TEXT)=?
          OR CAST(ref_id AS TEXT)=?
          OR CAST(ref_id AS TEXT) LIKE ?
          OR (COALESCE(ref_id,0)=0 AND description LIKE ?)
        )
    `).run(String(rid), `ret-${rid}`, `ex-${rid}-%`, `%برگشت #${rid}%`);
    ledger += Number(leg.changes || 0);
  } catch (_) { /* ignore */ }

  return { voided, ledger };
}

/**
 * Rough final from rows (retail prices + header disc% or header disc_amt rial) — for scaling
 * tender before invoice create. A non-empty discAmt wins over discPct (same as invoices create).
 */
function estimateSaleFinalRial(rows, discPct, discAmt) {
  let sub = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.row_type === 'income') continue;
    const qty = Number(r.qty) || 0;
    const price = Math.round(Number(r.unit_price != null ? r.unit_price : r.price) || 0);
    let line = Math.round(qty * price);
    const dPct = Math.max(0, Math.min(100, Number(r.disc_pct != null ? r.disc_pct : r.disc) || 0));
    const dAmt = Math.max(0, Math.round(Number(r.disc_amt != null ? r.disc_amt : r.disc_amount) || 0));
    // Amount wins over percent (buildRows parity): one line discount, not both.
    line = dAmt > 0 ? Math.max(0, line - dAmt) : Math.max(0, Math.round(line * (1 - dPct / 100)));
    sub += line;
  }
  if (discAmt != null && discAmt !== '') {
    const amt = Math.max(0, Math.round(Number(discAmt) || 0));
    return Math.max(0, sub - Math.min(amt, sub));
  }
  const hdr = Math.max(0, Math.min(100, Number(discPct) || 0));
  return Math.max(0, Math.round(sub * (1 - hdr / 100)));
}

function bootstrapStoreSale(db, user) {
  const walkinId = getWalkinCustomerId(db);
  const walkin = db.prepare(
    'SELECT id, biz, owner, phone, party_id FROM customers WHERE id=?'
  ).get(walkinId);
  const u = loadUserStorePrefs(db, user && user.id);
  let warehouse = null;
  if (u && u.sales_warehouse_id) {
    warehouse = db.prepare('SELECT id, name, code FROM warehouses WHERE id=?').get(u.sales_warehouse_id);
  }
  let cashBox = null;
  if (u && u.sales_cash_box_id) {
    cashBox = db.prepare('SELECT id, name FROM cash_boxes WHERE id=?').get(u.sales_cash_box_id);
  }
  let warehouses = [];
  try {
    warehouses = db.prepare(
      "SELECT id, name, code FROM warehouses WHERE COALESCE(active,1)=1 ORDER BY name"
    ).all();
  } catch (_) { warehouses = []; }
  let cashBoxes = [];
  try {
    cashBoxes = db.prepare(
      "SELECT id, name FROM cash_boxes WHERE COALESCE(active,1)=1 ORDER BY name"
    ).all();
  } catch (_) { cashBoxes = []; }
  let vatRate = 10;
  try {
    const { getVatRate } = require('./vat');
    vatRate = getVatRate(db);
  } catch (_) { /* default */ }
  return {
    channel: STORE_CHANNEL,
    walkin_customer_id: walkinId,
    walkin_customer: walkin || null,
    warehouse_id: u ? u.sales_warehouse_id || null : null,
    warehouse,
    warehouses,
    locks_warehouse: locksStoreWarehouse(user && user.role),
    cash_box_id: u ? u.sales_cash_box_id || null : null,
    cash_box: cashBox,
    cash_boxes: cashBoxes,
    locks_cash_box: locksStoreCashBox(user && user.role),
    vat_rate: vatRate,
    insufficient_stock_mode: getInsufficientStockMode(db),
    price_floor_mode: getPriceFloorMode(db),
    can_override_price: canOverrideStorePrice(db, user),
  };
}

/**
 * Three settlement cases for exchange:
 * - collect: sale > return → customer pays net
 * - refund: return > sale → cash refund to customer
 * - even: equal → no tender
 */
function computeExchangeSettlement(saleFinalRial, returnGrossRial) {
  const saleFinal = moneyRial(saleFinalRial);
  const returnGross = moneyRial(returnGrossRial);
  const netCollect = Math.max(0, saleFinal - returnGross);
  const refundRial = Math.max(0, returnGross - saleFinal);
  const exchangeCreditRial = Math.min(returnGross, saleFinal);
  let settlementCase = 'even';
  if (netCollect > 0) settlementCase = 'collect';
  else if (refundRial > 0) settlementCase = 'refund';
  return {
    saleFinal,
    returnGross,
    netCollect,
    refundRial,
    exchangeCreditRial,
    settlementCase,
  };
}

/**
 * Build sale body for exchange: net tender after return credit.
 * @returns {{ body, netCollect, refundRial, returnGross, exchangeCreditRial, saleFinal, settlementCase }}
 */
function prepareExchangeSaleBody(db, user, saleBody, returnGrossRial) {
  const prepared = prepareStoreQuickSaleBody(db, user, saleBody || {});
  const saleFinal = estimateSaleFinalRial(prepared.rows, prepared.disc, prepared.disc_amt);
  const settle = computeExchangeSettlement(saleFinal, returnGrossRial);
  const {
    returnGross, netCollect, refundRial, exchangeCreditRial, settlementCase,
  } = settle;

  const wantsCredit = String(prepared.pay_type || '').toLowerCase() === 'credit'
    || (!(Array.isArray(prepared.pay_splits) && prepared.pay_splits.length)
      && String((saleBody && saleBody.pay_type) || '').toLowerCase() === 'credit');
  const walkin = isWalkinCustomer(db, prepared.cust_id);

  const origSplits = Array.isArray(prepared.pay_splits) ? prepared.pay_splits : [];
  if (netCollect > 0) {
    if (wantsCredit && !walkin) {
      // Net difference stays on customer AR
      prepared.pay_splits = [];
      prepared.pay_type = 'credit';
    } else {
      let scaled = scalePaySplitsToNet(origSplits, netCollect);
      if (!scaled.length) {
        const cashId = resolveStoreCashBoxId(db, user, prepared, { optional: false });
        scaled = [{ pay_type: 'cash', amount: netCollect, cash_box_id: cashId }];
        prepared.pay_type = 'cash';
        prepared.cash_box_id = cashId;
      }
      prepared.pay_splits = scaled;
      prepared.pay_type = scaled[0].pay_type || 'cash';
    }
  } else {
    // even or refund: invoice fully covered by return credit (refund posted separately)
    prepared.pay_splits = [];
    prepared.pay_type = 'credit';
  }

  prepared._store_exchange = {
    return_gross: returnGross,
    sale_final: saleFinal,
    net_collect: netCollect,
    refund_rial: refundRial,
    exchange_credit_rial: exchangeCreditRial,
    settlement_case: settlementCase,
  };
  return {
    body: prepared,
    netCollect,
    refundRial,
    returnGross,
    exchangeCreditRial,
    saleFinal,
    settlementCase,
  };
}

/** Estimate return credit for UI (qty × net_unit); server still uses createSalesReturn totals. */
function estimateReturnGrossFromLines(lines) {
  let sum = 0;
  for (const ln of Array.isArray(lines) ? lines : []) {
    if (!ln) continue;
    const qty = Number(ln.qty) || 0;
    if (!(qty > 0)) continue;
    const net = Math.round(Number(
      ln.net_unit != null ? ln.net_unit
        : (ln.unit_price != null ? ln.unit_price : ln.price)
    ) || 0);
    sum += Math.max(0, Math.round(qty * net));
  }
  return moneyRial(sum);
}

/**
 * Apply exchange return credit onto the *replacement* invoice settled balance
 * (no JE — return JE + sale JE already net AR). Works even when the return is
 * linked to the original invoice (allocateReturnCredit rejects that path).
 */
function applyStoreExchangeCreditAllocation(db, {
  returnId, invoiceId, amountRial, userId, note,
}) {
  const amt = moneyRial(amountRial);
  const retId = parseInt(returnId, 10);
  const invId = parseInt(invoiceId, 10);
  if (!(amt > 0) || !(retId > 0) || !(invId > 0)) return null;

  const { SIDE_SALES, sumAllocationsFromReturn } = require('./return-credit-allocate');
  const { recomputeInvoiceSettledBalances } = require('./invoice-payments');

  const ret = db.prepare('SELECT * FROM sales_returns WHERE id=?').get(retId);
  if (!ret || String(ret.status || 'posted') === 'reversed') {
    const e = new Error('برگشت تعویض برای تخصیص اعتبار یافت نشد');
    e.status = 400;
    e.code = 'E_STORE_EXCHANGE_ALLOC_RETURN';
    throw e;
  }
  const retGross = moneyRial(Number(ret.amount) || 0) + moneyRial(Number(ret.vat_amount) || 0);
  const already = sumAllocationsFromReturn(db, SIDE_SALES, retId);
  const remaining = Math.max(0, retGross - already);
  const applyAmt = Math.min(amt, remaining);
  if (!(applyAmt > 0)) return { amount_rial: 0, skipped: true };

  const inv = db.prepare(
    'SELECT id, cust_id, final, final_rial, status, deleted_at FROM invoices WHERE id=?'
  ).get(invId);
  if (!inv || inv.deleted_at || String(inv.status || '') === 'reversed') {
    const e = new Error('فاکتور جایگزین برای تخصیص اعتبار یافت نشد');
    e.status = 400;
    e.code = 'E_STORE_EXCHANGE_ALLOC_INV';
    throw e;
  }
  if (Number(inv.cust_id) !== Number(ret.cust_id)) {
    const e = new Error('مشتری فاکتور جایگزین با برگشت یکی نیست');
    e.status = 400;
    e.code = 'E_STORE_EXCHANGE_ALLOC_PARTY';
    throw e;
  }

  const before = recomputeInvoiceSettledBalances(db, invId);
  const due = before ? moneyRial(before.balance_due) : moneyRial(inv.final_rial || inv.final);
  const capped = Math.min(applyAmt, due);
  if (!(capped > 0)) return { amount_rial: 0, skipped: true, balance_due: due };

  const ins = db.prepare(`
    INSERT INTO return_credit_allocations
      (side, return_id, invoice_id, amount_rial, status, note, user_id)
    VALUES (?,?,?,?, 'posted', ?, ?)
  `).run(
    SIDE_SALES,
    retId,
    invId,
    capped,
    note || `اعتبار تعویض فروشگاهی ← برگشت #${retId}`,
    userId || null
  );
  const after = recomputeInvoiceSettledBalances(db, invId);
  return {
    id: Number(ins.lastInsertRowid),
    amount_rial: capped,
    balance_due: after ? after.balance_due : null,
    settled_amount: after ? after.paid : null,
  };
}

module.exports = {
  WALKIN_BIZ,
  STORE_CHANNEL,
  SETTINGS_KEY,
  isStoreRetailRole,
  locksStoreWarehouse,
  locksStoreCashBox,
  isStoreQuickRequest,
  ensureWalkinCustomer,
  getWalkinCustomerId,
  isWalkinCustomer,
  seesAllWalkinTransactions,
  restrictWalkinTransactions,
  canViewWalkinInvoice,
  walkinListVisibilityOrSql,
  walkinPersonalBalanceRial,
  retailUnitPriceRial,
  applyRetailRowDefaults,
  canOverrideStorePrice,
  PRICE_FLOOR_MODE_KEY,
  getPriceFloorMode,
  applyPriceFloorPolicy,
  resolveStoreWarehouseId,
  resolveStoreCashBoxId,
  prepareStoreQuickSaleBody,
  assertStoreQuickSaleRules,
  assertStorePaymentMatchesFinal,
  assertWalkinSettlement,
  STOCK_MODE_KEY,
  getInsufficientStockMode,
  applyInsufficientStockPolicy,
  bootstrapStoreSale,
  scalePaySplitsToNet,
  postStoreExchangeRefund,
  voidStoreExchangeRefund,
  storeExchangeRefundSourceId,
  prepareExchangeSaleBody,
  computeExchangeSettlement,
  estimateSaleFinalRial,
  estimateReturnGrossFromLines,
  applyStoreExchangeCreditAllocation,
};
