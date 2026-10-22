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
    const { reservedQty: rsvOpen } = require('./inventory/reservation');
    return rsvOpen(db, productId, warehouseId);
  } catch (_) {
    return 0;
  }
}

/**
 * Validate stocked lines against warehouses.
 * Services/income rows (row_type=income or item_kind=service) are exempt.
 *
 * Firm sales must pass a header warehouse (caller enforces E_WH_REQUIRED).
 * Lines without warehouse_id inherit the header. A line may override with a
 * different warehouse_id (no E_WH_MISMATCH). Missing warehouse_stock rows use
 * legacy seed semantics (product.stock counts as the home-warehouse quantity).
 */
function isFabricRollLine(r) {
  if (!r) return false;
  if (r.is_fabric_roll) return true;
  const bid = parseInt(r.batch_id, 10);
  return Number.isFinite(bid) && bid > 0;
}

function normalizeFreightType(v) {
  const t = String(v || '').trim().toLowerCase();
  if (t === 'seller' || t === 'عهده فروشنده' || t === 'فروشنده') return 'seller';
  if (t === 'buyer' || t === 'عهده خریدار' || t === 'خریدار') return 'buyer';
  return '';
}

/** Buyer (or unspecified) charges the counterparty; seller absorbs. */
function freightChargedToCounterparty(freightType) {
  return normalizeFreightType(freightType) !== 'seller';
}

function allocateFreight(rows, freightAmount, method) {
  const freight = Math.round(Number(freightAmount) || 0);
  if (freight <= 0) return rows;
  const targets = (rows || []).filter((r) => r.row_type !== 'income' && r.product_id);
  if (!targets.length) return rows;
  const m = method === 'qty' || method === 'equal' ? method : 'amount';
  let weights;
  if (m === 'equal') weights = targets.map(() => 1);
  else if (m === 'qty') weights = targets.map((r) => Number(r.qty) || 0);
  else weights = targets.map((r) => Number(r.sum) || 0);
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

function applyFreightToDocTotals(totals, freightAmount, freightType) {
  const freight = Math.round(Number(freightAmount) || 0);
  const type = normalizeFreightType(freightType);
  const charge = freightChargedToCounterparty(type) && freight > 0;
  return {
    freight,
    freightType: type,
    chargeToParty: charge,
    final: Math.round(Number(totals.final) || 0) + (charge ? freight : 0),
    netBeforeVat: Math.round(Number(totals.netBeforeVat) || 0) + (charge ? freight : 0),
  };
}

function applyHeaderWarehouseToLines(rows, headerWarehouseId, { force = false } = {}) {
  const wh = parseInt(headerWarehouseId, 10);
  if (!Number.isFinite(wh) || wh <= 0) return;
  for (const r of rows || []) {
    if (r.row_type === 'income' || r.item_kind === 'service') continue;
    // Fabric rolls live in the roll's warehouse (typically WH-RAW). Never
    // overwrite that with the invoice header warehouse (often FG).
    if (isFabricRollLine(r) && r.warehouse_id) continue;
    if (force || !r.warehouse_id) r.warehouse_id = wh;
  }
}

function requireFirmHeaderWarehouse(headerWarehouseId) {
  const whId = parseInt(headerWarehouseId, 10);
  if (!Number.isFinite(whId) || whId <= 0) {
    const err = new Error('فاکتور قطعی نیازمند انبار مبدأ در سربرگ است');
    err.status = 400;
    err.code = 'E_WH_REQUIRED';
    throw err;
  }
  return whId;
}

function assertWarehouseLines(db, rows, headerWarehouseId, {
  requirePositive = true, allowNegativeProduct = false, heldByBatch = null,
} = {}) {
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
    const batchId = r.batch_id ? parseInt(r.batch_id, 10) : null;
    if (batchId) {
      const batchRow = db.prepare(
        "SELECT id, batch_no, qty_on_hand, kind, status, warehouse_id FROM inventory_batches WHERE id=?"
      ).get(batchId);
      if (batchRow && !r.warehouse_id && batchRow.warehouse_id) {
        r.warehouse_id = batchRow.warehouse_id;
      }
      if (batchRow && batchRow.kind === 'fabric') {
        if (batchRow.status === 'reversed') {
          const err = new Error('این طاقه ابطال شده است');
          err.status = 409; err.code = 'E_FABRIC_REVERSED';
          throw err;
        }
        const { availableBatchMeters } = require('./inventory/fabric-rolls');
        // Amend: meters this same invoice already took from the roll are still "its own".
        const held = heldByBatch ? (Number(heldByBatch.get(batchId)) || 0) : 0;
        const onHand = availableBatchMeters(db, batchId) + held;
        const qty = Number(r.qty) || 0;
        if (requirePositive && qty - onHand > 1e-9) {
          const err = new Error(`متر طاقه ${batchRow.batch_no} کافی نیست (مانده ${onHand}، نیاز ${qty})`);
          err.status = 409; err.code = 'E_FABRIC_QTY';
          throw err;
        }
        continue;
      }
    }
    const lineWh = r.warehouse_id ? parseInt(r.warehouse_id, 10) : null;
    const effWh = lineWh || headerWarehouseId || prod.warehouse_id || null;
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
    if (requirePositive && !allowNeg && !allowNegativeProduct && avail < qty) {
      const err = new Error(
        `موجودی قابل فروش «${r.name || prod.name}» در انبار کافی نیست (قابل فروش: ${avail})`
      );
      err.status = 409;
      err.code = 'E_WH_INSUFFICIENT';
      throw require('./inventory/shortage-error').attach(err, db, [{ product_id: r.product_id, warehouse_id: effWh, available: avail, needed: qty }]);
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
    const batchId = r.batch_id ? parseInt(r.batch_id, 10) : null;
    const need = Number(r.qty) || 0;
    // Assert fabric-roll availability BEFORE posting the ledger qty_out. Once the
    // sale row is posted, liveBatchMeters drops by `need`, so the downstream
    // consumeFabricRollOnSale re-check would see the post-sale balance and reject
    // a valid sale (the "-20 مانده" bug). Check the pre-sale balance here.
    let isFabric = false;
    if (batchId) {
      const { availableBatchMeters } = require('./inventory/fabric-rolls');
      const batchRow = db.prepare(
        "SELECT batch_no, qty_on_hand, kind, status, warehouse_id FROM inventory_batches WHERE id=?"
      ).get(batchId);
      if (batchRow && batchRow.kind === 'fabric') {
        isFabric = true;
        if (batchRow.status === 'reversed') {
          const err = new Error('این طاقه ابطال شده است');
          err.status = 409; err.code = 'E_FABRIC_REVERSED';
          throw err;
        }
        if (!whId && batchRow.warehouse_id) {
          whId = batchRow.warehouse_id;
          r.warehouse_id = whId;
        }
        const onHand = availableBatchMeters(db, batchId);
        if (need - onHand > 1e-9) {
          const err = new Error(`متر طاقه ${batchRow.batch_no} کافی نیست (مانده ${onHand}، نیاز ${need})`);
          err.status = 409; err.code = 'E_FABRIC_QTY';
          throw err;
        }
        // Align product warehouse cache with Σ roll meters before stock delta.
        if (whId) {
          const { syncFabricProductWarehouse } = require('./inventory/fabric-rolls');
          syncFabricProductWarehouse(db, r.product_id, whId);
        }
      }
    }
    // Legacy seed: products that predate warehouse_stock get their home-warehouse
    // row initialized from products.stock. Never seed 0 over a fabric roll WH.
    if (whId && prod && !isFabric) {
      const seedQty = prod.warehouse_id === whId ? (Number(prod.stock) || 0) : 0;
      db.prepare(
        'INSERT INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?) ON CONFLICT(product_id,warehouse_id) DO NOTHING'
      ).run(r.product_id, whId, seedQty);
    }
    let skipStock = false;
    if (isFabric) {
      const ws = whId
        ? db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?')
          .get(r.product_id, whId)
        : null;
      skipStock = !ws || (Number(ws.qty) + 1e-9 < need);
    }
    const mv = postInventoryMovement(db, {
      eventType: 'sale',
      productId: r.product_id,
      warehouseId: whId,
      qtyOut: need,
      sourceType,
      sourceId,
      batchId: batchId || null,
      date: date || '',
      note: note || 'فروش',
      createdBy: userId,
      updateAvg: false,
      skipStock,
      // Firm sales: product/SKU may go negative (UI warning only). Fabric lots stay hard-checked above.
      allowNegative: !isFabric,
    });
    if (batchId) {
      if (isFabric) {
        const { consumeFabricRollOnSale } = require('./inventory/fabric-rolls');
        consumeFabricRollOnSale(db, { batchId, qty: need });
      } else {
        const { adjustBatchQty } = require('./inventory/batch-serial');
        adjustBatchQty(db, batchId, -need);
      }
    }
    try {
      const { consumeOpenReservationsForSale } = require('./inventory/reservation');
      consumeOpenReservationsForSale(db, { productId: r.product_id, warehouseId: whId, qty: need });
    } catch (_) { /* soft-lock optional */ }
    if (!isFabric) {
      require('./inventory/movement').postVariantLayer(db, {
        productId: r.product_id,
        variantId: r.variant_id || null,
        warehouseId: whId,
        qtyDelta: -need,
        docType: 'invoice_sku',
        docId: sourceId,
        docLine: movements.length,
        userId,
        note: (note || 'فروش') + ' / رنگ×سایز',
        allowNegative: true,
      });
    }
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
  rows, warehouseId, sourceType, sourceId, userId, date, note, supplierId,
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
    let isFabricLine = false;
    try {
      isFabricLine = require('./inventory/fabric-rolls').isFabricPurchaseLine(db, r, whId);
    } catch (_) { isFabricLine = false; }
    if (!isFabricLine) {
      require('./inventory/movement').postVariantLayer(db, {
        productId: r.product_id,
        variantId: r.variant_id || null,
        warehouseId: whId,
        qtyDelta: qty,
        docType: 'purchase_sku',
        docId: sourceId,
        docLine: movements.length,
        userId,
        note: (note || 'خرید') + ' / رنگ×سایز',
        allowNegative: true,
      });
    }
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
    try {
      const fabric = require('./inventory/fabric-rolls');
      if (fabric.isFabricPurchaseLine(db, r, whId)) {
        fabric.attachFabricIdentityOnPurchase(db, {
          row: r,
          movement: mv,
          supplierId,
          user: { id: userId },
          date,
          warehouseId: whId,
          sourceId,
        });
      }
    } catch (e) {
      if (e && e.code && String(e.code).startsWith('E_FABRIC')) throw e;
      if (db.inTransaction) throw e;
    }
  }
  return { movements };
}

/** Average issue cost (rial/unit) of a product on the invoice's live sale rows; null if none. */
function originalIssueUnitRial(db, invoiceId, productId) {
  if (!invoiceId || !productId) return null;
  const r = db.prepare(`
    SELECT COALESCE(SUM(qty_out),0) AS q, COALESCE(SUM(amount_rial),0) AS a FROM inventory_ledger
    WHERE source_type='invoice' AND source_id=? AND product_id=? AND event_type='sale'
      AND status='posted' AND reversed_of IS NULL AND qty_out>0
  `).get(invoiceId, productId);
  const q = Number(r && r.q) || 0;
  if (!(q > 1e-9)) return null;
  const unit = Math.round((Number(r.a) || 0) / q);
  return unit > 0 ? unit : null;
}

/**
 * Sales return restores stock (qtyIn) via perpetual ledger.
 * Open month (v526): qty enters at the original invoice issue unit cost (else the line cost) so
 * the return reverses the same rate that left — no approval queue.
 * Closed month (v525): qty enters at the current pool average; the difference vs the original
 * issue cost is parked in ONE closed_period approval doc. Returned amount_rial stays the document
 * cost so the return JE (Dr inventory / Cr COGS) is unchanged; the parking JE moves the difference.
 */
function postSaleReturnStockMovements(db, {
  rows, warehouseId, sourceType, sourceId, userId, date, note, invoiceId = null,
}) {
  const movements = [];
  let costRial = 0;
  const closed = !!date && require('./inventory/period-lock').isValueLocked(db, date);
  for (const r of rows || []) {
    if (!r.product_id) continue;
    const whId = r.warehouse_id ? parseInt(r.warehouse_id, 10) : warehouseId;
    const qty = Number(r.qty) || 0;
    // cost_rial / unit_cost are rial under money.js contract (legacy unit_cost
    // that was toman×display is no longer multiplied here).
    const unitCost = Math.round(
      Number(r.cost_rial != null ? r.cost_rial : (Number(r.unit_cost) || 0)) || 0
    );
    const batchId = r.batch_id ? parseInt(r.batch_id, 10) : null;
    if (!batchId) {
      require('./inventory/movement').postVariantLayer(db, {
        productId: r.product_id,
        variantId: r.variant_id || null,
        warehouseId: whId,
        qtyDelta: qty,
        docType: 'sale_return_sku',
        docId: sourceId,
        docLine: movements.length,
        userId,
        note: (note || 'برگشت از فروش') + ' / رنگ×سایز',
        allowNegative: true,
      });
    }
    const issueUnit = originalIssueUnitRial(db, invoiceId, r.product_id);
    let entryUnit = unitCost;
    let docUnit = null;
    if (closed && qty > 0) {
      const VAP = require('./inventory/value-approval');
      const du = issueUnit || unitCost;
      const poolUnit = VAP.closedInboundPoolUnit(db, r.product_id, whId);
      if (du > 0 && poolUnit != null && poolUnit !== du) {
        entryUnit = poolUnit;
        docUnit = du;
      } else if (du > 0) {
        entryUnit = du;
      }
    } else if (qty > 0 && issueUnit > 0) {
      // Open month: always reverse at the rate that left (owner decision v526).
      entryUnit = issueUnit;
    }
    let mv = postInventoryMovement(db, {
      eventType: 'sale_return',
      productId: r.product_id,
      warehouseId: whId,
      qtyIn: qty,
      unitCostRial: entryUnit || undefined,
      amountRial: docUnit != null ? Math.round(entryUnit * qty) : undefined,
      sourceType,
      sourceId,
      batchId: batchId || undefined,
      date: date || '',
      note: note || 'برگشت از فروش',
      createdBy: userId,
      updateAvg: true,
    });
    if (docUnit != null) {
      const docAmount = Math.round(docUnit * qty);
      const diff = docAmount - Math.round(Number(mv.amount_rial) || 0);
      const parked = require('./inventory/value-approval').parkReceiptDifference(db, {
        sourceType, sourceId, ledgerId: mv.id, productId: r.product_id, warehouseId: whId,
        qtyIn: qty, diffRial: diff, date, createdBy: userId,
        note: 'برگشت از فروش با تاریخ ماه قفل‌شده — مابه‌التفاوت بهای فروش با میانگین',
        label: `برگشت از فروش #${sourceId} — مابه‌التفاوت بهای فروش با میانگین (قفل دوره)`,
      });
      mv = {
        ...mv,
        unit_cost_rial: docUnit,
        amount_rial: docAmount,
        ledger_amount_rial: mv.amount_rial,
        value_parked_rial: diff,
        value_approval_id: parked ? parked.id : null,
      };
    }
    movements.push(mv);
    costRial += Math.round(Number(mv.amount_rial) || 0);
    if (batchId && qty > 0) {
      try {
        const { adjustBatchQty } = require('./inventory/batch-serial');
        adjustBatchQty(db, batchId, qty);
      } catch (_) { /* batch may be gone */ }
    }
  }
  return { movements, costRial };
}

function reverseStockBySource(db, sourceType, sourceId, { createdBy, date, note } = {}) {
  const { softRetireLedgerRow, isZeroQtyValueGhost } = require('./inventory/ledger');
  const rows = db.prepare(`
    SELECT id, batch_id, qty_out, qty_in, amount_rial FROM inventory_ledger
    WHERE source_type=? AND source_id=? AND status='posted' AND COALESCE(reversed_of,0)=0
    ORDER BY id DESC
  `).all(sourceType, sourceId);
  const out = [];
  for (const r of rows) {
    if (isZeroQtyValueGhost(r)) {
      softRetireLedgerRow(db, r.id, { note: note || 'بازنشستگی ردیف صفر اصلاح' });
      continue;
    }
    out.push(reverseInventoryMovement(db, r.id, { createdBy, date, note }));
  }
  try {
    const fabric = require('./inventory/fabric-rolls');
    fabric.restoreFabricQtyFromLedgerRows(db, rows);
    fabric.reverseFabricIdentitiesBySource(db, sourceType, sourceId);
  } catch (_) { /* fabric module optional on old DBs */ }
  return out;
}

/**
 * COGS JE from inventory movement totals (always for firm sales when cogsRial>0).
 * Falls back to product average if movements empty but rows given (legacy).
 */
function postCogsFromMovements(db, {
  invId, num, date, userId, cogsRial, reverse = false, inventoryCoaCode = null,
  costCenterId = null, warehouseId = null,
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
    if (inventoryCoaCode) {
      invAcct = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(inventoryCoaCode);
    }
    if (!invAcct) {
      // Prefer finished-goods control (same default as warehouse type map).
      try { invAcct = acct(db, 'coa_finished_goods'); }
      catch (_) { invAcct = acct(db, 'coa_inventory'); }
    }
  } catch (_) {
    invAcct = acct(db, 'coa_inventory');
  }
  let ccId = costCenterId ? parseInt(costCenterId, 10) : null;
  if (!ccId && warehouseId) {
    try {
      const { warehouseCostCenterId } = require('./cost-center-policy');
      ccId = warehouseCostCenterId(db, warehouseId);
    } catch (_) { ccId = null; }
  }
  if (!ccId && invId) {
    try {
      const inv = db.prepare('SELECT cost_center_id, warehouse_id FROM invoices WHERE id=?').get(invId);
      ccId = parseInt(inv?.cost_center_id, 10) || null;
      if (!ccId && inv?.warehouse_id) {
        const { warehouseCostCenterId } = require('./cost-center-policy');
        ccId = warehouseCostCenterId(db, inv.warehouse_id);
      }
    } catch (_) { /* ignore */ }
  }
  const L = rialToLedger(amt);
  const lines = reverse
    ? [
      { code: invAcct.code, name: invAcct.name, debit: L, credit: 0 },
      { code: cogs.code, name: cogs.name, debit: 0, credit: L },
    ]
    : [
      { code: cogs.code, name: cogs.name, debit: L, credit: 0, cost_center_id: ccId || null },
      { code: invAcct.code, name: invAcct.name, debit: 0, credit: L },
    ];
  return postToLedger(db, {
    sourceType: reverse ? 'invoice_cogs_reversal' : 'invoice_cogs',
    sourceId: invId,
    date: date || '',
    description: `بهای تمام‌شده فاکتور ${num}${reverse ? ' (ابطال)' : ''}`,
    createdBy: userId,
    costCenterId: ccId || null,
    warehouseId: warehouseId || null,
    lines,
  });
}

function perpetualDocsEnabled(db) {
  const off = db.prepare("SELECT value FROM settings WHERE key='feature_perpetual_docs'").get();
  if (off && off.value === '0') return false;
  return true;
}

/** Perpetual valuation for a warehouse — periodic warehouses defer COGS to period close. */
function warehouseUsesPerpetualValuation(db, warehouseId) {
  if (!perpetualDocsEnabled(db)) return false;
  if (!warehouseId) return true;
  try {
    const { isPeriodicWarehouse } = require('./inventory/periodic-close');
    if (isPeriodicWarehouse(db, warehouseId)) return false;
  } catch (_) {}
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
  isFabricRollLine,
  normalizeFreightType,
  freightChargedToCounterparty,
  allocateFreight,
  applyFreightToDocTotals,
  applyHeaderWarehouseToLines,
  requireFirmHeaderWarehouse,
  assertWarehouseLines,
  postSaleStockMovements,
  postPurchaseStockMovements,
  postSaleReturnStockMovements,
  reverseStockBySource,
  postCogsFromMovements,
  perpetualDocsEnabled,
  warehouseUsesPerpetualValuation,
  reservedQty,
};
