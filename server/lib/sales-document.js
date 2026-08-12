/**
 * ACC-CRM-UNIFY — shared sales/purchase document helpers.
 * Firm sales = type normal|final. Proforma has no stock/JE.
 */
const { postInventoryMovement, reverseInventoryMovement, allowNegative } = require('./inventory/ledger');
const { acct } = require('./coa-map');
const { postToLedger } = require('./ledger');
const { rialToLedger } = require('./money');

const FIRM_TYPES = new Set(['normal', 'final']);
const ALL_TYPES = new Set(['proforma', 'normal', 'final']);

/** Bare SQL fragment — firm commercial sales (revenue / AR / KPIs). */
const FIRM_SALE_TYPE_SQL = "type IN ('normal','final')";

/**
 * SQL predicate for firm sale invoice types.
 * @param {string} [alias] table alias (e.g. 'i') or '' for bare `type`
 */
function firmSaleTypeSql(alias = '') {
  if (!alias) return FIRM_SALE_TYPE_SQL;
  return `${alias}.type IN ('normal','final')`;
}

/**
 * Commission base: firm + approved.
 * Normal invoices are auto-approved on create; final needs explicit approve.
 */
function commissionEligibleSql(alias = '') {
  const t = alias ? `${alias}.type` : 'type';
  const a = alias ? `${alias}.approved` : 'approved';
  return `${t} IN ('normal','final') AND COALESCE(${a},0)=1`;
}

function normalizeInvoiceType(type, fallback = 'proforma') {
  const t = String(type || fallback).trim();
  if (!ALL_TYPES.has(t)) {
    const err = new Error('نوع فاکتور نامعتبر است (proforma|normal|final)');
    err.status = 400;
    err.code = 'E_INV_TYPE';
    throw err;
  }
  return t;
}

function isFirmSale(type) {
  return FIRM_TYPES.has(String(type || ''));
}

function invoiceTypeLabel(type) {
  if (type === 'final') return 'فاکتور رسمی';
  if (type === 'normal') return 'فاکتور معمولی';
  return 'پیش‌فاکتور';
}

/** Mark normal invoices commission-ready (no Moadian / approval queue). */
function autoApproveNormalInvoice(db, invId, userId) {
  db.prepare(`
    UPDATE invoices SET approved=1, approved_at=?, approved_by=?
    WHERE id=? AND type='normal' AND COALESCE(approved,0)=0
  `).run(Date.now(), userId || null, invId);
}

function assertJournalIdempotent(db, sourceType, sourceId) {
  const existing = db.prepare(`
    SELECT id FROM journal_entries
    WHERE ref_type=? AND ref_id=? AND COALESCE(deleted_at,0)=0
      AND COALESCE(status,'posted') NOT IN ('reversed','void')
    LIMIT 1
  `).get(sourceType, sourceId);
  if (existing) {
    const err = new Error(`سند حسابداری تکراری برای ${sourceType}#${sourceId}`);
    err.status = 409;
    err.code = 'E_JE_DUPLICATE';
    throw err;
  }
}

function reservedQty(db, productId, warehouseId) {
  try {
    const row = db.prepare(`
      SELECT COALESCE(SUM(qty),0) AS q FROM inventory_reservations
      WHERE product_id=? AND warehouse_id=? AND status='active'
    `).get(productId, warehouseId);
    return Number(row?.q) || 0;
  } catch (_) {
    return 0;
  }
}

/**
 * Validate stocked lines against header warehouse.
 * Services/income rows (row_type=income or item_kind=service) are exempt.
 *
 * Backward compatible with legacy callers (devices/older UI) that send no
 * header warehouse: each line falls back to its own warehouse_id and then to
 * the product's home warehouse (products always get a default warehouse on
 * create). A hard E_WH_MISMATCH is raised only when a header warehouse IS
 * chosen and a line explicitly targets a different one. Missing
 * warehouse_stock rows use legacy seed semantics (product.stock counts as the
 * home-warehouse quantity) instead of hard-failing.
 */
function assertWarehouseLines(db, rows, headerWarehouseId, { requirePositive = true } = {}) {
  const productRows = (rows || []).filter((r) => {
    if (r.row_type === 'income') return false;
    if (r.item_kind === 'service') return false;
    return !!r.product_id;
  });
  if (!productRows.length) return;

  if (headerWarehouseId) {
    const wh = db.prepare('SELECT id,name,active,allow_negative FROM warehouses WHERE id=?').get(headerWarehouseId);
    if (!wh || !wh.active) {
      const err = new Error('انبار مبدأ معتبر نیست');
      err.status = 400;
      err.code = 'E_WH_INVALID';
      throw err;
    }
  }

  for (const r of productRows) {
    const prod = db.prepare('SELECT id,name,stock,warehouse_id FROM products WHERE id=?').get(r.product_id);
    if (!prod) {
      const err = new Error(`کالای ردیف یافت نشد (شناسه ${r.product_id})`);
      err.status = 400;
      err.code = 'E_WH_PRODUCT';
      throw err;
    }
    const lineWh = r.warehouse_id ? parseInt(r.warehouse_id, 10) : null;
    if (headerWarehouseId && lineWh && lineWh !== headerWarehouseId) {
      const err = new Error(`کالای «${r.name || prod.name}» متعلق به انبار دیگری است`);
      err.status = 409;
      err.code = 'E_WH_MISMATCH';
      throw err;
    }
    const effWh = headerWarehouseId || lineWh || prod.warehouse_id || null;
    if (!effWh) {
      const err = new Error(`برای کالای «${r.name || prod.name}» انبار مبدأ مشخص نیست — ابتدا انبار را انتخاب کنید`);
      err.status = 400;
      err.code = 'E_WH_REQUIRED';
      throw err;
    }
    const allowNeg = allowNegative ? allowNegative(db, effWh) : false;
    const ws = db.prepare(
      'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
    ).get(r.product_id, effWh);
    // Legacy seed semantics: no warehouse_stock row → the product's own stock
    // counts as its home-warehouse quantity, zero elsewhere.
    const baseQty = ws ? Number(ws.qty) : (prod.warehouse_id === effWh ? Number(prod.stock) || 0 : 0);
    const avail = baseQty - reservedQty(db, r.product_id, effWh);
    const qty = Number(r.qty) || 0;
    if (requirePositive && !allowNeg && avail < qty) {
      const err = new Error(
        `موجودی قابل فروش «${r.name || prod.name}» در انبار کافی نیست (قابل فروش: ${avail})`
      );
      err.status = 409;
      err.code = 'E_WH_INSUFFICIENT';
      throw err;
    }
  }
}

/**
 * Post perpetual sale stock movements; returns { cogsRial, movements, usedWarehouses }.
 */
function postSaleStockMovements(db, {
  rows, warehouseId, sourceType, sourceId, userId, date, note,
}) {
  const used = new Map();
  const movements = [];
  let cogsRial = 0;
  const productRows = (rows || []).filter((r) => r.row_type !== 'income' && r.item_kind !== 'service' && r.product_id);
  for (const r of productRows) {
    const prod = db.prepare('SELECT stock, warehouse_id FROM products WHERE id=?').get(r.product_id);
    let whId = r.warehouse_id ? parseInt(r.warehouse_id, 10) : warehouseId;
    if (!whId) whId = prod?.warehouse_id || null;
    // Legacy seed: products that predate warehouse_stock get their home-warehouse
    // row initialized from products.stock (mirrors the old invoices.js behavior)
    if (whId && prod) {
      const seedQty = prod.warehouse_id === whId ? (Number(prod.stock) || 0) : 0;
      db.prepare(
        'INSERT INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?) ON CONFLICT(product_id,warehouse_id) DO NOTHING'
      ).run(r.product_id, whId, seedQty);
    }
    const mv = postInventoryMovement(db, {
      eventType: 'sale',
      productId: r.product_id,
      warehouseId: whId,
      qtyOut: Number(r.qty) || 0,
      sourceType,
      sourceId,
      date: date || '',
      note: note || 'فروش',
      createdBy: userId,
      updateAvg: false,
    });
    movements.push(mv);
    cogsRial += Math.round(Number(mv.amount_rial) || 0);
    if (whId) {
      const wh = db.prepare('SELECT name FROM warehouses WHERE id=?').get(whId);
      used.set(whId, wh?.name || String(whId));
    }
  }
  return {
    cogsRial,
    movements,
    usedWarehouses: [...used.entries()].map(([id, name]) => ({ id, name })),
  };
}

function postPurchaseStockMovements(db, {
  rows, warehouseId, sourceType, sourceId, userId, date, note,
}) {
  const movements = [];
  for (const r of rows || []) {
    if (!r.product_id) continue;
    const whId = r.warehouse_id ? parseInt(r.warehouse_id, 10) : warehouseId;
    const qty = Number(r.qty) || 0;
    // DB/UI contract: amounts are INTEGER rial. Prefer explicit amount_rial (landed
    // after discount/freight); else price_rial / price already in rial — never ×10.
    const amountOverride = r.amount_rial != null ? Math.round(Number(r.amount_rial) || 0) : null;
    const unit = Math.round(
      Number(
        r.price_rial != null
          ? r.price_rial
          : (amountOverride != null && qty ? amountOverride / qty : (Number(r.price) || 0))
      ) || 0
    );
    const mv = postInventoryMovement(db, {
      eventType: 'purchase',
      productId: r.product_id,
      warehouseId: whId,
      qtyIn: qty,
      unitCostRial: unit,
      amountRial: amountOverride != null ? amountOverride : undefined,
      sourceType,
      sourceId,
      date: date || '',
      note: note || 'خرید',
      createdBy: userId,
      updateAvg: true,
    });
    movements.push(mv);
  }
  return { movements };
}

/** Sales return restores stock (qtyIn) via perpetual ledger. */
function postSaleReturnStockMovements(db, {
  rows, warehouseId, sourceType, sourceId, userId, date, note,
}) {
  const movements = [];
  let costRial = 0;
  for (const r of rows || []) {
    if (!r.product_id) continue;
    const whId = r.warehouse_id ? parseInt(r.warehouse_id, 10) : warehouseId;
    const qty = Number(r.qty) || 0;
    // cost_rial / unit_cost are rial under money.js contract (legacy unit_cost
    // that was toman×display is no longer multiplied here).
    const unitCost = Math.round(
      Number(r.cost_rial != null ? r.cost_rial : (Number(r.unit_cost) || 0)) || 0
    );
    const mv = postInventoryMovement(db, {
      eventType: 'sale_return',
      productId: r.product_id,
      warehouseId: whId,
      qtyIn: qty,
      unitCostRial: unitCost || undefined,
      sourceType,
      sourceId,
      date: date || '',
      note: note || 'برگشت از فروش',
      createdBy: userId,
      updateAvg: true,
    });
    movements.push(mv);
    costRial += Math.round(Number(mv.amount_rial) || 0);
  }
  return { movements, costRial };
}

function reverseStockBySource(db, sourceType, sourceId, { createdBy, date, note } = {}) {
  const rows = db.prepare(`
    SELECT id FROM inventory_ledger
    WHERE source_type=? AND source_id=? AND status='posted' AND COALESCE(reversed_of,0)=0
    ORDER BY id DESC
  `).all(sourceType, sourceId);
  const out = [];
  for (const r of rows) {
    out.push(reverseInventoryMovement(db, r.id, { createdBy, date, note }));
  }
  return out;
}

/**
 * COGS JE from inventory movement totals (always for firm sales when cogsRial>0).
 * Falls back to product average if movements empty but rows given (legacy).
 */
function postCogsFromMovements(db, {
  invId, num, date, userId, cogsRial, reverse = false, inventoryCoaCode = null,
}) {
  const amt = Math.round(Number(cogsRial) || 0);
  if (amt <= 0) return null;
  if (reverse) {
    const orig = db.prepare(
      "SELECT id FROM journal_entries WHERE ref_type='invoice_cogs' AND ref_id=? AND COALESCE(deleted_at,0)=0"
    ).get(invId);
    if (!orig) return null;
  } else {
    assertJournalIdempotent(db, 'invoice_cogs', invId);
  }
  const cogs = acct(db, 'coa_cogs');
  let invAcct;
  try {
    invAcct = inventoryCoaCode
      ? db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(inventoryCoaCode)
      : acct(db, 'coa_inventory');
  } catch (_) {
    invAcct = acct(db, 'coa_inventory');
  }
  const L = rialToLedger(amt);
  const lines = reverse
    ? [
      { code: invAcct.code, name: invAcct.name, debit: L, credit: 0 },
      { code: cogs.code, name: cogs.name, debit: 0, credit: L },
    ]
    : [
      { code: cogs.code, name: cogs.name, debit: L, credit: 0 },
      { code: invAcct.code, name: invAcct.name, debit: 0, credit: L },
    ];
  return postToLedger(db, {
    sourceType: reverse ? 'invoice_cogs_reversal' : 'invoice_cogs',
    sourceId: invId,
    date: date || '',
    description: `بهای تمام‌شده فاکتور ${num}${reverse ? ' (ابطال)' : ''}`,
    createdBy: userId,
    lines,
  });
}

function perpetualDocsEnabled(db) {
  const off = db.prepare("SELECT value FROM settings WHERE key='feature_perpetual_docs'").get();
  if (off && off.value === '0') return false;
  return true;
}

module.exports = {
  FIRM_TYPES,
  ALL_TYPES,
  FIRM_SALE_TYPE_SQL,
  firmSaleTypeSql,
  commissionEligibleSql,
  normalizeInvoiceType,
  isFirmSale,
  invoiceTypeLabel,
  autoApproveNormalInvoice,
  assertJournalIdempotent,
  assertWarehouseLines,
  postSaleStockMovements,
  postPurchaseStockMovements,
  postSaleReturnStockMovements,
  reverseStockBySource,
  postCogsFromMovements,
  perpetualDocsEnabled,
  reservedQty,
};
