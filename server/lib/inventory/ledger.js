'use strict';
/**
 * Immutable inventory transaction engine.
 * Stock never changes without a ledger row. Reverse-only (R12).
 * Money: INTEGER rial (R1). Atomic with caller transaction (R8).
 */
const { acct } = require('../coa-map');

function setting(db, key, fallback = '') {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r?.value != null ? r.value : fallback;
}

function allowNegative(db, warehouseId) {
  if (warehouseId) {
    const wh = db.prepare('SELECT allow_negative FROM warehouses WHERE id=?').get(warehouseId);
    if (wh && wh.allow_negative) return true;
  }
  return setting(db, 'inventory_allow_negative', '0') === '1'
    || setting(db, 'production_allow_negative_stock', '0') === '1';
}

function costingMethod(db, opts = {}) {
  const scope = setting(db, 'costing_scope', 'global');
  if (scope === 'per-product' && opts.productId) {
    const p = db.prepare('SELECT costing_method FROM products WHERE id=?').get(opts.productId);
    if (p?.costing_method) return p.costing_method;
  }
  if ((scope === 'per-warehouse' || scope === 'per-product') && opts.warehouseId) {
    const w = db.prepare('SELECT costing_method FROM warehouses WHERE id=?').get(opts.warehouseId);
    if (w?.costing_method) return w.costing_method;
  }
  if (opts.productId) {
    const p = db.prepare('SELECT costing_method FROM products WHERE id=?').get(opts.productId);
    if (p?.costing_method && p.costing_method !== 'moving_average') return p.costing_method;
  }
  return setting(db, 'inventory_costing_method', 'moving_average');
}

function nextTxNo(db) {
  try {
    const { allocateNumber, isDevice } = require('../../db');
    // دستگاه‌ها ردیف‌های مرکز را pull می‌کنند (tx_no مرکزی INV-xxxx)؛ شمارندهٔ
    // محلی با آن‌ها تصادم می‌کند — مثل شماره فاکتور، شمارهٔ موقت یکتا بده.
    // بعد از replay روی مرکز، شماره واقعی همان‌جا صادر و pull می‌شود.
    if (typeof isDevice === 'function' && isDevice()) {
      return 'موقت-INV-' + Date.now().toString(36).toUpperCase() + '-'
        + Math.random().toString(36).slice(2, 7).toUpperCase();
    }
    return allocateNumber(db, 'inventory_tx', 'INV');
  } catch (_) {
    return 'INV-' + Date.now().toString(36).toUpperCase()
      + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
  }
}

/**
 * WIP staging events (F06): quantity lives in a WIP/cut warehouse only.
 * products.stock is the sellable header — it must not move, and neither may the
 * moving average or cost layers. finalize is the only WIP→FG stock increase.
 * Reversals of these rows keep the same semantics (see isWarehouseOnlyRow).
 */
const WAREHOUSE_ONLY_EVENTS = new Set(['cutting_pack']);

function isWarehouseOnlyRow(row) {
  if (!row) return false;
  const event = String(row.event_type || '');
  if (WAREHOUSE_ONLY_EVENTS.has(event)) return true;
  return event === 'reversal' && WAREHOUSE_ONLY_EVENTS.has(String(row.source_type || ''));
}

function invErr(code, status, extra) {
  const e = new Error(code);
  e.code = code;
  e.status = status || 400;
  if (extra) Object.assign(e, extra);
  return e;
}

function getProduct(db, productId) {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!p) throw invErr('E_PRODUCT_NOT_FOUND', 404, { productId });
  return p;
}

function ensureWhRow(db, productId, warehouseId) {
  if (!warehouseId) return;
  db.prepare(
    'INSERT OR IGNORE INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,0)'
  ).run(productId, warehouseId);
}

function warehouseQty(db, productId, warehouseId) {
  if (!warehouseId) {
    const p = db.prepare('SELECT stock FROM products WHERE id=?').get(productId);
    return Number(p?.stock) || 0;
  }
  const ws = db.prepare(
    'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
  ).get(productId, warehouseId);
  if (ws && ws.qty != null) return Number(ws.qty) || 0;
  const p = db.prepare('SELECT warehouse_id, stock FROM products WHERE id=?').get(productId);
  if (p && p.warehouse_id === parseInt(warehouseId, 10)) return Number(p.stock) || 0;
  return 0;
}

/**
 * Resolve inventory control account for a warehouse.
 * Priority: warehouses.inventory_coa_code (valid COA) → warehouse_type map → coa_inventory.
 * ADR-001: valuation stays at product header; this only picks the GL control account.
 */
function inventoryAccountForWarehouse(db, warehouseId) {
  if (!warehouseId) return acct(db, 'coa_inventory');
  let wh;
  try {
    wh = db.prepare('SELECT warehouse_type, inventory_coa_code FROM warehouses WHERE id=?').get(warehouseId);
  } catch (_) {
    wh = db.prepare('SELECT warehouse_type FROM warehouses WHERE id=?').get(warehouseId);
  }
  const override = String(wh?.inventory_coa_code || '').trim();
  if (override) {
    const row = db.prepare(
      'SELECT code, name FROM chart_of_accounts WHERE code=? AND COALESCE(is_active,1)=1'
    ).get(override);
    if (row) return { code: row.code, name: row.name };
  }
  const t = wh?.warehouse_type || '';
  if (t === 'raw_material') return acct(db, 'coa_raw_materials');
  if (t === 'packaging') return acct(db, 'coa_packaging_materials');
  if (t === 'wip') return acct(db, 'coa_wip');
  if (t === 'scrap') return acct(db, 'coa_scrap_inventory');
  if (t === 'consignment') return acct(db, 'coa_subcontract_inventory');
  return acct(db, 'coa_finished_goods');
}

/**
 * Aggregate rial amounts by warehouse inventory COA for multi-line JE debits/credits.
 * @param {import('better-sqlite3').Database} db
 * @param {{ warehouseId?: number|null, amountRial: number }[]} items
 * @returns {{ code: string, name: string, amountRial: number }[]}
 */
function inventoryAmountLinesByWarehouse(db, items) {
  const map = new Map();
  for (const it of items || []) {
    const amt = Math.round(Number(it.amountRial) || 0);
    if (!amt) continue;
    const a = inventoryAccountForWarehouse(db, it.warehouseId || null);
    const prev = map.get(a.code) || { code: a.code, name: a.name, amountRial: 0 };
    prev.amountRial += amt;
    map.set(a.code, prev);
  }
  return [...map.values()];
}

/**
 * Apply qty delta to products.stock + warehouse_stock.
 * warehouseOnly: WIP staging — only warehouse_stock moves, the sellable header stays.
 * Returns { qtyBefore, qtyAfter, avgBefore }.
 */
function applyStockDelta(db, {
  productId, warehouseId, qtyDelta, allowNegative: allowNegOpt, warehouseOnly = false,
}) {
  const prod = getProduct(db, productId);
  const qtyBefore = Number(prod.stock) || 0;
  const avgBefore = Math.round(Number(prod.average_cost_rial) || 0);
  const qtyAfter = qtyBefore + qtyDelta;
  const allowNeg = allowNegOpt === true || allowNegative(db, warehouseId);

  if (warehouseOnly && !warehouseId) throw invErr('E_INV_WAREHOUSE_REQUIRED', 400, { product_id: productId });

  if (!warehouseOnly && qtyAfter < -1e-9 && !allowNeg) {
    throw invErr('E_NEGATIVE_STOCK', 409, {
      product_id: productId,
      name: prod.name,
      available: qtyBefore,
      needed: Math.abs(qtyDelta),
    });
  }

  const stockStored = warehouseOnly
    ? qtyBefore
    : (allowNeg ? qtyAfter : Math.max(0, qtyAfter));
  if (!warehouseOnly) {
    db.prepare('UPDATE products SET stock=? WHERE id=?').run(stockStored, productId);
  }

  if (warehouseId) {
    ensureWhRow(db, productId, warehouseId);
    const whBefore = warehouseQty(db, productId, warehouseId);
    const whAfter = whBefore + qtyDelta;
    if (whAfter < -1e-9 && !allowNeg) {
      throw invErr('E_NEGATIVE_STOCK', 409, {
        product_id: productId,
        warehouse_id: warehouseId,
        available: whBefore,
        needed: Math.abs(qtyDelta),
      });
    }
    const whStored = allowNeg ? whAfter : Math.max(0, whAfter);
    db.prepare(
      'UPDATE warehouse_stock SET qty=? WHERE product_id=? AND warehouse_id=?'
    ).run(whStored, productId, warehouseId);
    if (!warehouseOnly && qtyDelta > 0 && (!prod.warehouse_id || prod.warehouse_id === warehouseId)) {
      db.prepare('UPDATE products SET warehouse_id=? WHERE id=?').run(warehouseId, productId);
    }
  }

  return { qtyBefore, qtyAfter: stockStored, avgBefore, product: prod };
}

/**
 * Update moving average on inbound. amountRial = total value of inbound qty.
 */
function applyMovingAverageIn(db, productId, qtyIn, amountRial, qtyBefore, avgBefore) {
  const amt = Math.round(Number(amountRial) || 0);
  const q = Number(qtyIn) || 0;
  const prevVal = Math.round(qtyBefore * avgBefore);
  const newQty = qtyBefore + q;
  let newAvg = avgBefore;
  if (newQty > 0) newAvg = Math.round((prevVal + amt) / newQty);
  const { catalogCostFromAvgRial } = require('./product-unit-cost');
  db.prepare(`
    UPDATE products SET average_cost_rial=?, cost=? WHERE id=?
  `).run(newAvg, catalogCostFromAvgRial(newAvg), productId);
  return newAvg;
}

/**
 * Core: post one inventory movement (append-only).
 * @param {object} opts
 * @param {string} opts.eventType  receipt|issue|transfer_out|transfer_in|adjustment|sale|sale_return|purchase|purchase_return|production_issue|production_receipt|scrap|opening|landed_cost|cycle_count
 * @param {number} opts.productId
 * @param {number} [opts.warehouseId]
 * @param {number} opts.qty        signed: +in / -out; or use qtyIn/qtyOut
 * @param {number} [opts.unitCostRial]  for inbound; outbound defaults to current avg
 * @param {number} [opts.amountRial]    override total
 * @param {boolean} [opts.updateAvg=true]
 * @param {boolean} [opts.skipStock=false]  ledger-only: no warehouse_stock/products.stock
 *   and no stock_logs (opening/backfill already have qty on those tables)
 * @param {boolean} [opts.warehouseOnly=false]  WIP staging (F06): warehouse_stock moves but
 *   the sellable header products.stock, the moving average, cost layers and stock_logs do not.
 *   Used by a cutting pack linked to a production order; finalize is the only WIP→FG increase.
 */
function postInventoryMovement(db, opts) {
  const {
    eventType, productId, warehouseId = null,
    qty, qtyIn: qInOpt, qtyOut: qOutOpt,
    unitCostRial, amountRial,
    sourceType = '', sourceId = null,
    jeId = null, batchId = null, serialId = null,
    reversedOf = null, date = '', note = '',
    createdBy = null, updateAvg = true, skipStock = false,
    warehouseOnly = false,
  } = opts;

  if (!eventType || !productId) throw invErr('E_INV_ARGS', 400);

  let qtyIn = Number(qInOpt) || 0;
  let qtyOut = Number(qOutOpt) || 0;
  if (!qtyIn && !qtyOut && qty != null) {
    const q = Number(qty) || 0;
    if (q >= 0) qtyIn = q; else qtyOut = -q;
  }
  if (qtyIn < 0 || qtyOut < 0) throw invErr('E_INV_QTY', 400);
  const valueOnly = !!opts.valueOnly;
  if (qtyIn === 0 && qtyOut === 0 && !valueOnly) throw invErr('E_INV_QTY_ZERO', 400);

  const delta = qtyIn - qtyOut;
  // WIP staging never touches the header: no products.stock, no average, no cost layer, no kardex row.
  const noHeader = !!skipStock || !!warehouseOnly;
  let stockInfo = { qtyBefore: 0, qtyAfter: 0, avgBefore: 0, product: null };
  if (!skipStock && !valueOnly) {
    stockInfo = applyStockDelta(db, {
      productId, warehouseId, qtyDelta: delta, allowNegative: opts.allowNegative, warehouseOnly,
    });
  } else {
    const p = getProduct(db, productId);
    stockInfo = {
      qtyBefore: Number(p.stock) || 0,
      qtyAfter: Number(p.stock) || 0,
      avgBefore: Math.round(Number(p.average_cost_rial) || 0),
      product: p,
    };
  }

  let unit = Math.round(Number(unitCostRial) || 0);
  if (!unit) unit = stockInfo.avgBefore;
  let amount = amountRial != null
    ? Math.round(Number(amountRial) || 0)
    : Math.round(unit * (qtyIn || qtyOut));

  let avgAfter = stockInfo.avgBefore;
  if (updateAvg && qtyIn > 0 && !noHeader) {
    avgAfter = applyMovingAverageIn(
      db, productId, qtyIn, amount, stockInfo.qtyBefore, stockInfo.avgBefore
    );
  } else if (!skipStock) {
    const p2 = db.prepare('SELECT average_cost_rial FROM products WHERE id=?').get(productId);
    avgAfter = Math.round(Number(p2?.average_cost_rial) || stockInfo.avgBefore);
  }

  // FIFO / specific cost layers (optional path)
  const method = costingMethod(db, { productId, warehouseId });
  if (method !== 'moving_average' && !noHeader) {
    const { applyCostLayerIn, applyCostLayerOut } = require('./costing');
    if (qtyIn > 0) {
      applyCostLayerIn(db, {
        productId, warehouseId, batchId, qty: qtyIn, unitCostRial: unit,
        amountRial: amount, sourceType, sourceId,
      });
    }
    if (qtyOut > 0) {
      const layered = applyCostLayerOut(db, {
        productId, warehouseId, qty: qtyOut, method,
      });
      amount = layered.amountRial;
      unit = qtyOut > 0 ? Math.round(amount / qtyOut) : unit;
    }
  } else if (method === 'moving_average' && qtyIn > 0 && !noHeader) {
    // Still record a layer for audit / future FIFO switch
    try {
      const { applyCostLayerIn } = require('./costing');
      applyCostLayerIn(db, {
        productId, warehouseId, batchId, qty: qtyIn, unitCostRial: unit,
        amountRial: amount, sourceType, sourceId,
      });
    } catch (_) { /* costing module optional during bootstrap */ }
  }

  const txNo = nextTxNo(db);
  const result = db.prepare(`
    INSERT INTO inventory_ledger (
      tx_no, event_type, product_id, warehouse_id,
      qty_in, qty_out, qty_balance, unit_cost_rial, amount_rial, avg_cost_after_rial,
      batch_id, serial_id, source_type, source_id, je_id, reversed_of,
      status, date, note, created_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    txNo, eventType, productId, warehouseId,
    qtyIn, qtyOut, stockInfo.qtyAfter, unit, amount, avgAfter,
    batchId, serialId, sourceType, sourceId, jeId, reversedOf,
    'posted', date || '', note || '', createdBy
  );

  const ledgerId = result.lastInsertRowid;

  // Keep legacy stock_logs in sync for old kardex consumers.
  // skipStock (opening/backfill) must not invent a second kardex row.
  if (!valueOnly && !noHeader && delta !== 0) {
    db.prepare(
      'INSERT INTO stock_logs (product_id, user_id, change, note) VALUES (?,?,?,?)'
    ).run(productId, createdBy, delta, note || eventType);
  }

  return {
    id: ledgerId,
    tx_no: txNo,
    product_id: productId,
    warehouse_id: warehouseId || null,
    qty_in: qtyIn,
    qty_out: qtyOut,
    qty_balance: stockInfo.qtyAfter,
    unit_cost_rial: unit,
    amount_rial: amount,
    avg_cost_after_rial: avgAfter,
  };
}

/**
 * Reverse a posted ledger row (R12). Creates opposite movement + marks original reversed.
 */
function reverseInventoryMovement(db, ledgerId, { createdBy, date, note } = {}) {
  const row = db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(ledgerId);
  if (!row) throw invErr('E_LEDGER_NOT_FOUND', 404);
  if (row.status === 'reversed') throw invErr('E_ALREADY_REVERSED', 409);

  const rev = postInventoryMovement(db, {
    eventType: 'reversal',
    productId: row.product_id,
    warehouseId: row.warehouse_id,
    qtyIn: row.qty_out,
    qtyOut: row.qty_in,
    unitCostRial: row.unit_cost_rial,
    amountRial: row.amount_rial,
    sourceType: row.source_type,
    sourceId: row.source_id,
    batchId: row.batch_id,
    serialId: row.serial_id,
    reversedOf: row.id,
    date: date || row.date,
    note: note || `معکوس ${row.tx_no}`,
    createdBy,
    updateAvg: true,
    warehouseOnly: isWarehouseOnlyRow(row),
  });

  db.prepare("UPDATE inventory_ledger SET status='reversed' WHERE id=?").run(row.id);
  return rev;
}

function getKardex(db, productId, { warehouseId, limit = 500 } = {}) {
  const product = getProduct(db, productId);
  const where = ['product_id=?'];
  const params = [productId];
  if (warehouseId) { where.push('warehouse_id=?'); params.push(warehouseId); }
  const rows = db.prepare(`
    SELECT l.*, u.name as user_name, w.name as warehouse_name
    FROM inventory_ledger l
    LEFT JOIN users u ON l.created_by=u.id
    LEFT JOIN warehouses w ON l.warehouse_id=w.id
    WHERE ${where.join(' AND ')}
    ORDER BY l.id ASC
    LIMIT ?
  `).all(...params, limit);
  return { product, rows };
}

module.exports = {
  postInventoryMovement,
  reverseInventoryMovement,
  getKardex,
  warehouseQty,
  inventoryAccountForWarehouse,
  inventoryAmountLinesByWarehouse,
  allowNegative,
  costingMethod,
  invErr,
  ensureWhRow,
  applyStockDelta,
  isWarehouseOnlyRow,
  WAREHOUSE_ONLY_EVENTS,
};
