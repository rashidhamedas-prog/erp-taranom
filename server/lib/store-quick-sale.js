'use strict';
/**
 * فروش سریع فروشگاهی (Quick Store Sale) — thin shell over firm invoices.
 * Walk-in customer + retail defaults + settlement rules; no parallel ledger.
 */
const { resolveInvoicePayments } = require('./invoice-payments');
const { moneyRial } = require('./cash-on-document');

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

function retailUnitPriceRial(prod) {
  if (!prod) return 0;
  const retail = Math.round(Number(prod.retail_price_rial || prod.retail_price) || 0);
  if (retail > 0) return retail;
  return Math.round(Number(prod.price_rial || prod.price) || 0);
}

function applyRetailRowDefaults(db, rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => {
    if (!r || r.row_type === 'income') return r;
    const pid = parseInt(r.product_id, 10);
    if (!(pid > 0)) return r;
    const prod = db.prepare(
      'SELECT id, retail_price_rial, retail_price, price_rial, price, name, code, barcode, unit FROM products WHERE id=?'
    ).get(pid);
    if (!prod) return r;
    const sent = Math.round(Number(r.unit_price != null ? r.unit_price : r.price) || 0);
    const unit = sent > 0 ? sent : retailUnitPriceRial(prod);
    return {
      ...r,
      name: r.name || prod.name,
      code: r.code || prod.code || prod.barcode || '',
      unit: r.unit || prod.unit || 'عدد',
      unit_price: unit,
      price: unit,
    };
  });
}

function resolveStoreWarehouseId(db, user, body) {
  const uid = user && user.id;
  const self = uid
    ? db.prepare('SELECT sales_warehouse_id FROM users WHERE id=?').get(uid)
    : null;
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

function assertWalkinSettlement(db, custId, body, finalAmt) {
  if (!isWalkinCustomer(db, custId)) return;
  const plan = resolveInvoicePayments(body || {}, finalAmt);
  const paid = (plan.splits || []).reduce((a, s) => a + Number(s.amount || 0), 0);
  const final = moneyRial(finalAmt);
  if (!(plan.splits && plan.splits.length) || Math.abs(paid - final) > 0.5) {
    const e = new Error('فروش به «مشتری نقدی فروشگاه» باید کاملاً با نقد یا کارت تسویه شود — برای نسیه مشتری واقعی انتخاب کنید');
    e.status = 400;
    e.code = 'E_WALKIN_MUST_SETTLE';
    throw e;
  }
  for (const s of plan.splits) {
    if (CREDITISH.has(s.pay_type)) {
      const e = new Error('برای چک یا نسیه باید مشتری واقعی (غیر از مشتری نقدی فروشگاه) انتخاب شود');
      e.status = 400;
      e.code = 'E_WALKIN_NO_CREDIT';
      throw e;
    }
  }
  const headerPt = String((body && body.pay_type) || '').toLowerCase();
  if (CREDITISH.has(headerPt) && !(body.pay_splits && body.pay_splits.length)) {
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

/**
 * Mutate/normalize body for store quick sale before invoice create.
 */
function prepareStoreQuickSaleBody(db, user, body) {
  const b = { ...(body || {}) };
  b.store_quick = true;
  b.sales_channel = STORE_CHANNEL;
  if (!b.type || b.type === 'proforma') b.type = 'normal';
  const walkinId = getWalkinCustomerId(db);
  const custId = parseInt(b.cust_id, 10);
  if (!(custId > 0)) b.cust_id = walkinId;
  const whId = resolveStoreWarehouseId(db, user, b);
  b.warehouse_id = whId;
  b.rows = applyRetailRowDefaults(db, b.rows);
  for (const r of b.rows) {
    if (r && r.row_type !== 'income') r.warehouse_id = whId;
  }
  return b;
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
  assertWalkinSettlement(db, custId, b, ctx && ctx.final);
}

function bootstrapStoreSale(db, user) {
  const walkinId = getWalkinCustomerId(db);
  const walkin = db.prepare(
    'SELECT id, biz, owner, phone, party_id FROM customers WHERE id=?'
  ).get(walkinId);
  const u = user && user.id
    ? db.prepare('SELECT id, name, role, sales_warehouse_id FROM users WHERE id=?').get(user.id)
    : null;
  let warehouse = null;
  if (u && u.sales_warehouse_id) {
    warehouse = db.prepare('SELECT id, name, code FROM warehouses WHERE id=?').get(u.sales_warehouse_id);
  }
  return {
    channel: STORE_CHANNEL,
    walkin_customer_id: walkinId,
    walkin_customer: walkin || null,
    warehouse_id: u ? u.sales_warehouse_id || null : null,
    warehouse,
    locks_warehouse: locksStoreWarehouse(user && user.role),
  };
}

module.exports = {
  WALKIN_BIZ,
  STORE_CHANNEL,
  SETTINGS_KEY,
  isStoreRetailRole,
  locksStoreWarehouse,
  isStoreQuickRequest,
  ensureWalkinCustomer,
  getWalkinCustomerId,
  isWalkinCustomer,
  retailUnitPriceRial,
  applyRetailRowDefaults,
  resolveStoreWarehouseId,
  prepareStoreQuickSaleBody,
  assertStoreQuickSaleRules,
  assertWalkinSettlement,
  bootstrapStoreSale,
};
