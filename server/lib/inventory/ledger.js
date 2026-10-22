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

/** Effective costing method (v521: delegates to valuation policy — product > warehouse > global by precedence). */
function costingMethod(db, opts = {}) {
  return require('./valuation').resolvePolicy(db, {
    productId: opts.productId, warehouseId: opts.warehouseId,
  }).method;
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
        name: prod.name,
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

function writeHeaderAvg(db, productId, avg) {
  const { catalogCostFromAvgRial } = require('./product-unit-cost');
  db.prepare(`
    UPDATE products SET average_cost_rial=?, cost=? WHERE id=?
  `).run(avg, catalogCostFromAvgRial(avg), productId);
}

/**
 * Update moving average on inbound. amountRial = total value of inbound qty.
 * On-hand ≤ 0 → new avg = inbound unit (negative balances never blend); the
 * mis-costed value of the negative balance is returned as trueup for the queue.
 */
function applyMovingAverageIn(db, productId, qtyIn, amountRial, qtyBefore, avgBefore) {
  const V = require('./valuation');
  const st = V.headerState(qtyBefore, avgBefore);
  const { trueup } = V.stIn(st, qtyIn, amountRial);
  writeHeaderAvg(db, productId, st.avg);
  return { avg: st.avg, trueup };
}

function isReversalEvent(eventType, reversedOf) {
  const et = String(eventType || '');
  return et === 'reversal' || et.endsWith('_reversal') || reversedOf != null;
}

/** Outbound rows whose amount is a specific historical value (not the current avg). */
function isValueBasedOutbound(eventType, reversedOf) {
  return isReversalEvent(eventType, reversedOf) || String(eventType || '') === 'purchase';
}

function isAlignSeedOpts(eventType, sourceType, note) {
  const st = String(sourceType || '');
  if (st === 'opening_inventory' || st === 'stock_reconcile' || String(eventType || '') === 'opening') return true;
  const noteFa = String(note || '').replace(/\u200c/g, '').replace(/ي/g, 'ی');
  return /هم[\u200c\s]*ترازی\s*کاردکس/.test(noteFa) || /^موجودی اول دوره/.test(noteFa);
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

  const V = require('./valuation');
  const policy = V.resolvePolicy(db, { productId, warehouseId });
  const method = policy.method;
  const isReversal = isReversalEvent(eventType, reversedOf);
  const valueBasedOut = qtyOut > 0 && !valueOnly && isValueBasedOutbound(eventType, reversedOf);
  const isAlign = isAlignSeedOpts(eventType, sourceType, note);

  let unit = Math.round(Number(unitCostRial) || 0);
  if (!unit) unit = stockInfo.avgBefore;
  let amount = amountRial != null
    ? Math.round(Number(amountRial) || 0)
    : Math.round(unit * (qtyIn || qtyOut));

  // Warehouse-level AVCO: default-costed outbound takes the source bucket average.
  if (qtyOut > 0 && !valueOnly && !valueBasedOut && !warehouseOnly && warehouseId
    && policy.level === 'warehouse' && method === 'moving_average') {
    const callerUnit = Math.round(Number(unitCostRial) || 0);
    const defaultUnit = !callerUnit || callerUnit === stockInfo.avgBefore;
    const defaultAmount = amountRial == null
      || Math.round(Number(amountRial) || 0) === Math.round((callerUnit || stockInfo.avgBefore) * qtyOut);
    if (defaultUnit && defaultAmount) {
      const b = V.getBucket(db, productId, warehouseId);
      if (b && Number(b.qty) > 1e-9 && Number(b.avg_rial) > 0) {
        unit = Math.round(Number(b.avg_rial));
        amount = Math.round(unit * qtyOut);
      }
    }
  }

  let avgAfter = stockInfo.avgBefore;
  let headerTrueup = 0;
  let valueApplied = null;
  let valueUnapplied = 0;
  if (updateAvg && qtyIn > 0 && !noHeader) {
    const r = applyMovingAverageIn(
      db, productId, qtyIn, amount, stockInfo.qtyBefore, stockInfo.avgBefore
    );
    avgAfter = r.avg;
    headerTrueup = r.trueup;
  } else if (valueBasedOut && !noHeader) {
    // Reversal of an inbound (or amend qty decrease): re-average by value, not by snapshot.
    const st = V.headerState(stockInfo.qtyBefore, stockInfo.avgBefore);
    V.stOut(st, qtyOut, amount);
    if (st.avg !== stockInfo.avgBefore) writeHeaderAvg(db, productId, st.avg);
    avgAfter = st.avg;
  } else if (valueOnly && !warehouseOnly && opts.applyValue !== false) {
    const d = opts.applyValueRial != null ? Math.round(Number(opts.applyValueRial) || 0) : amount;
    const st = V.headerState(stockInfo.qtyBefore, stockInfo.avgBefore);
    valueApplied = V.stValue(st, d);
    valueUnapplied = d - valueApplied;
    if (st.avg !== stockInfo.avgBefore) writeHeaderAvg(db, productId, st.avg);
    avgAfter = st.avg;
  } else if (!skipStock) {
    const p2 = db.prepare('SELECT average_cost_rial FROM products WHERE id=?').get(productId);
    avgAfter = Math.round(Number(p2?.average_cost_rial) || stockInfo.avgBefore);
  }

  // FIFO / specific cost layers (optional path)
  let layerInId = null;
  if (method !== 'moving_average' && !noHeader) {
    const { applyCostLayerIn, applyCostLayerOut } = require('./costing');
    if (qtyIn > 0) {
      const layer = applyCostLayerIn(db, {
        productId, warehouseId, batchId, qty: qtyIn, unitCostRial: unit,
        amountRial: amount, sourceType, sourceId,
      });
      layerInId = layer && layer.id;
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
      const layer = applyCostLayerIn(db, {
        productId, warehouseId, batchId, qty: qtyIn, unitCostRial: unit,
        amountRial: amount, sourceType, sourceId,
      });
      layerInId = layer && layer.id;
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

  if (layerInId) {
    try {
      db.prepare('UPDATE inventory_cost_layers SET ledger_id=? WHERE id=? AND ledger_id IS NULL').run(ledgerId, layerInId);
    } catch (_) { /* legacy layer table */ }
  }

  // Valuation buckets (per product×warehouse) follow every row, WIP staging included.
  const bucketRes = V.applyLedgerRowToBuckets(db, {
    id: ledgerId, product_id: productId, warehouse_id: warehouseId,
    qty_in: qtyIn, qty_out: qtyOut, amount_rial: amount,
  });
  if (valueOnly && valueApplied != null) V.recordValueApplied(db, ledgerId, valueApplied, valueUnapplied);
  V.afterMovementPosted(db, {
    ledgerId, productId, warehouseId, eventType, sourceType, sourceId, date,
    qtyIn, amount, method, level: policy.level,
    headerTrueup, bucketTrueup: bucketRes.trueup, unappliedRial: valueUnapplied,
    warehouseOnly, isReversal, isAlign, valueOnly,
    qtyBefore: policy.level === 'warehouse'
      ? (bucketRes.bucket ? bucketRes.bucket.qty - qtyIn + qtyOut : 0)
      : stockInfo.qtyBefore,
  });

  // Keep legacy stock_logs in sync for old kardex consumers.
  // skipStock (opening/backfill) must not invent a second kardex row.
  if (!valueOnly && !noHeader && delta !== 0) {
    db.prepare(
      'INSERT INTO stock_logs (product_id, user_id, change, note) VALUES (?,?,?,?)'
    ).run(productId, createdBy || 0, delta, note || eventType);
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
    value_applied_rial: valueApplied,
    value_unapplied_rial: valueUnapplied,
  };
}

/**
 * Reverse a posted ledger row (R12). Creates opposite movement + marks original reversed.
 */
function reverseInventoryMovement(db, ledgerId, { createdBy, date, note, skipStock } = {}) {
  const row = db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(ledgerId);
  if (!row) throw invErr('E_LEDGER_NOT_FOUND', 404);
  if (row.status === 'reversed') throw invErr('E_ALREADY_REVERSED', 409);

  const valueOnly = (Number(row.qty_in) || 0) === 0 && (Number(row.qty_out) || 0) === 0
    && Math.round(Number(row.amount_rial) || 0) !== 0;
  // Opening / هم‌ترازی seeds were posted with skipStock — reverse must not touch warehouse_stock.
  const noteFa = String(row.note || '').replace(/\u200c/g, '').replace(/ي/g, 'ی');
  const alignSeed = String(row.source_type || '') === 'opening_inventory'
    || String(row.source_type || '') === 'stock_reconcile'
    || String(row.event_type || '') === 'opening'
    || /هم[\u200c\s]*ترازی\s*کاردکس/.test(noteFa)
    || /^موجودی اول دوره/.test(noteFa);
  const skip = skipStock === true || valueOnly || alignSeed;
  // Value-only reversal removes exactly what reached the header (by value, never a snapshot).
  let applyValueRial;
  if (valueOnly) {
    const applied = require('./valuation').valueAppliedFor(db, row.id);
    applyValueRial = -(applied != null ? applied : Math.round(Number(row.amount_rial) || 0));
  }
  const rev = postInventoryMovement(db, {
    applyValueRial,
    eventType: 'reversal',
    productId: row.product_id,
    warehouseId: row.warehouse_id,
    qtyIn: row.qty_out,
    qtyOut: row.qty_in,
    unitCostRial: row.unit_cost_rial,
    // Opposite value for value-only revals (landed cost / GRNI variance)
    amountRial: valueOnly ? -Math.round(Number(row.amount_rial) || 0) : row.amount_rial,
    sourceType: row.source_type,
    sourceId: row.source_id,
    batchId: row.batch_id,
    serialId: row.serial_id,
    reversedOf: row.id,
    date: date || row.date,
    note: note || `معکوس ${row.tx_no}`,
    createdBy,
    updateAvg: !valueOnly && !skip,
    warehouseOnly: isWarehouseOnlyRow(row),
    skipStock: skip,
    valueOnly,
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
  let wipIds = new Set();
  try {
    wipIds = new Set(db.prepare(
      "SELECT id FROM warehouses WHERE kind='wip' OR warehouse_type='wip'"
    ).all().map((w) => Number(w.id)));
  } catch (_) { wipIds = new Set(); }
  const wipView = warehouseId && wipIds.has(Number(warehouseId));
  return { product, rows: rows.filter((r) => {
    if (!wipView && (isWarehouseOnlyRow(r) || wipIds.has(Number(r.warehouse_id)))) return false;
    if (!(Number(r.qty_in) || 0) && !(Number(r.qty_out) || 0)) return false;
    if (String(r.status || '') === 'reversed') return false;
    const et = String(r.event_type || '');
    if (et === 'reversal' || et.endsWith('_reversal')) return false;
    if (r.reversed_of) return false;
    const note = String(r.note || '').trim();
    if (/^\[?ابطال/.test(note)) return false;
    return true;
  }) };
}

/** True when a posted row has no qty and no value — amend ghost / noop. */
function isZeroQtyValueGhost(row) {
  if (!row) return false;
  const qIn = Number(row.qty_in) || 0;
  const qOut = Number(row.qty_out) || 0;
  const amt = Math.round(Number(row.amount_rial) || 0);
  return qIn === 0 && qOut === 0 && amt === 0;
}

/**
 * Soft-retire a posted ledger row without posting an opposite movement.
 * Use when stock was already adjusted elsewhere (amend) or the row is a zero ghost.
 */
function softRetireLedgerRow(db, ledgerId, { note } = {}) {
  const row = db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(ledgerId);
  if (!row) return null;
  if (row.status === 'reversed') return row;
  if (note) {
    db.prepare("UPDATE inventory_ledger SET status='reversed', note=? WHERE id=?").run(String(note).slice(0, 240), ledgerId);
  } else {
    db.prepare("UPDATE inventory_ledger SET status='reversed' WHERE id=?").run(ledgerId);
  }
  return db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(ledgerId);
}

/**
 * One-shot heal: tombstone historical amend ghosts (posted qty=0 amount=0).
 */
function retireZeroQtyLedgerGhosts(db) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inventory_ledger'").get()) {
    return { skipped: true, reason: 'no_table' };
  }
  const info = db.prepare(`
    SELECT COUNT(*) c FROM inventory_ledger
    WHERE status='posted'
      AND COALESCE(qty_in,0)=0 AND COALESCE(qty_out,0)=0
      AND COALESCE(amount_rial,0)=0
  `).get();
  const n = Number(info && info.c) || 0;
  if (n <= 0) return { count: 0 };
  const r = db.prepare(`
    UPDATE inventory_ledger
    SET status='reversed'
    WHERE status='posted'
      AND COALESCE(qty_in,0)=0 AND COALESCE(qty_out,0)=0
      AND COALESCE(amount_rial,0)=0
  `).run();
  return { count: r.changes || 0 };
}

/**
 * Historical fabric/material voids left the opposite row posted after the
 * original was marked reversed. That posted opposite is a second subtraction.
 * Retire it without another stock move. liveBatchMeters sums every status.
 */
function retirePostedReversalTwins(db) {
  if (process.env.SYNC_ROLE === 'device') return { skipped: true, reason: 'device' };
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inventory_ledger'").get()) {
    return { skipped: true, reason: 'no_table' };
  }
  const rows = db.prepare(`
    SELECT r.id
    FROM inventory_ledger r
    JOIN inventory_ledger o ON o.id = r.reversed_of
    WHERE r.status='posted' AND o.status='reversed'
      AND (r.event_type='reversal' OR r.event_type GLOB '*_reversal')
  `).all();
  let count = 0;
  const run = db.transaction(() => {
    for (const r of rows) {
      softRetireLedgerRow(db, r.id);
      count += 1;
    }
  });
  run();
  return { count };
}

/**
 * reverseStage used to leave production_issue posted and only add a twin
 * «ابطال مرحله…» return. Soft-retire both sides without another stock move
 * (qty already netted). Also retire the original when its material issue row
 * is reversed/missing and a twin return already restored stock.
 */
function retireOrphanVoidedProductionIssues(db) {
  if (process.env.SYNC_ROLE === 'device') return { skipped: true, reason: 'device' };
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inventory_ledger'").get()) {
    return { skipped: true, reason: 'no_table' };
  }
  const issues = db.prepare(`
    SELECT id, product_id, warehouse_id, qty_out, note, source_id
    FROM inventory_ledger
    WHERE status='posted' AND event_type='production_issue'
      AND (
        note GLOB 'مرحله *'
        OR note GLOB 'حواله مرحله *'
        OR note GLOB 'مصرف *'
      )
  `).all();
  let retired = 0;
  let reversed = 0;
  const adminId = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get()?.id
    || db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()?.id
    || 1;
  const run = db.transaction(() => {
    for (const o of issues) {
      const note = String(o.note || '');
      const token = (note.match(/PO-\d+/i) || note.match(/PR-\d+/i) || [])[0];
      const stage = (note.match(/مرحله\s*(\d+)/) || [])[1];
      const qOrig = Number(o.qty_out) || 0;
      const twins = db.prepare(`
        SELECT id, note, qty_in FROM inventory_ledger
        WHERE status='posted' AND product_id=?
          AND event_type IN ('production_return','reversal')
          AND note LIKE 'ابطال%'
        ORDER BY id DESC
      `).all(o.product_id);
      const twin = twins.find((t) => {
        const tNote = String(t.note || '');
        const tToken = (tNote.match(/PO-\d+/i) || tNote.match(/PR-\d+/i) || [])[0];
        const ts = (tNote.match(/مرحله\s*(\d+)/) || [])[1];
        if (stage && ts && ts !== stage) return false;
        if (token && tToken && token !== tToken) return false;
        if (token && tNote.includes(token)) return true;
        if (tToken && o.source_id) {
          try {
            const oid = db.prepare(
              'SELECT id FROM production_orders WHERE order_no=? COLLATE NOCASE LIMIT 1'
            ).get(tToken)?.id;
            if (oid != null && Number(oid) === Number(o.source_id)) {
              const qTwin = Number(t.qty_in) || 0;
              if (qOrig > 0 && qTwin > 0 && Math.abs(qTwin - qOrig) > 1e-3) return false;
              return true;
            }
          } catch (_) { /* */ }
        }
        if (!token && stage && ts === stage) {
          const qTwin = Number(t.qty_in) || 0;
          if (qOrig > 0 && qTwin > 0 && Math.abs(qTwin - qOrig) > 1e-3) return false;
          return true;
        }
        return false;
      }) || null;

      // Twin already restored qty — retire both without another stock move.
      if (twin) {
        softRetireLedgerRow(db, o.id, { note: 'بازنشسته — عملیات پشت سند ابطال شده' });
        softRetireLedgerRow(db, twin.id, { note: 'بازنشسته — جفت ابطال مرحله' });
        retired += 1;
        continue;
      }

      // No twin: reverse when MI is voided or the production order itself is dead.
      let dead = false;
      try {
        if (o.source_id) {
          const liveMi = db.prepare(`
            SELECT id FROM production_material_issues
            WHERE order_id=? AND product_id=?
              AND COALESCE(status,'posted')='posted'
            LIMIT 1
          `).get(o.source_id, o.product_id);
          const anyMi = db.prepare(`
            SELECT id, status FROM production_material_issues
            WHERE order_id=? AND product_id=?
            ORDER BY id DESC LIMIT 1
          `).get(o.source_id, o.product_id);
          const po = db.prepare(
            'SELECT id, status FROM production_orders WHERE id=?'
          ).get(o.source_id);
          const poStatus = String(po?.status || '').toLowerCase();
          const orderDead = !po || ['reversed', 'void', 'cancelled', 'canceled', 'voided'].includes(poStatus);
          if (anyMi && String(anyMi.status || '') === 'reversed' && !liveMi) dead = true;
          if (orderDead && !liveMi) dead = true;
        }
      } catch (_) { dead = false; }
      if (!dead) continue;
      const rev = reverseInventoryMovement(db, o.id, {
        note: 'بازنشسته — عملیات پشت سند ابطال شده',
        createdBy: adminId,
      });
      if (rev && rev.id) softRetireLedgerRow(db, rev.id);
      reversed += 1;
    }
  });
  run();
  return { retired, reversed, count: retired + reversed };
}

module.exports = {
  postInventoryMovement,
  reverseInventoryMovement,
  getKardex,
  isZeroQtyValueGhost,
  softRetireLedgerRow,
  retireZeroQtyLedgerGhosts,
  retirePostedReversalTwins,
  retireOrphanVoidedProductionIssues,
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
