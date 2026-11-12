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

/**
 * May physical stock go below zero for this warehouse?
 * @param {{context?: 'warehouse'|'production'|'sales'|string}} [opts]
 * - warehouse / sales / default: only warehouses.allow_negative or inventory_allow_negative
 * - production: also honors production_allow_negative_stock
 */
function allowNegative(db, warehouseId, opts) {
  if (warehouseId) {
    const wh = db.prepare('SELECT allow_negative FROM warehouses WHERE id=?').get(warehouseId);
    if (wh && wh.allow_negative) return true;
  }
  if (setting(db, 'inventory_allow_negative', '0') === '1') return true;
  const ctx = opts && opts.context != null ? String(opts.context) : '';
  if (ctx === 'production' || ctx === 'prod') {
    return setting(db, 'production_allow_negative_stock', '0') === '1';
  }
  return false;
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

function shortageAttach(e, db, rows) {
  return require('./shortage-error').attach(e, db, rows);
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

/** SSOT: stock caches are rebuilt from the ledger (stock-cache.js) — no placeholder rows. Kept for callers. */
function ensureWhRow() {}

/** On-hand of (product, warehouse) — ledger-derived (= warehouse_stock cache after rebuild). */
function warehouseQty(db, productId, warehouseId) {
  return stockOf(db, { productId, warehouseId: warehouseId || null });
}

function rebuildCache(db, productId) {
  return require('./stock-cache').rebuildStockCache(db, productId);
}

/**
 * Resolve inventory GL account for a warehouse (sole source for inventory JE lines).
 * Priority: warehouses.inventory_coa_code when it is a postable leaf → else type-map /
 * coa_inventory fallback. Never uses products.coa_code.
 *
 * Empty / non-leaf inventory_coa_code (perpetual):
 *   warn    → structured log E_WAREHOUSE_COA_UNMAPPED + current type-map fallback
 *   enforce → 422 E_WAREHOUSE_COA_UNMAPPED (reuse v585)
 * readOnly skips throw (reports).
 */
function inventoryAccountForWarehouse(db, warehouseId, opts = {}) {
  if (!warehouseId) return acct(db, 'coa_inventory');
  let wh;
  try {
    wh = db.prepare(
      'SELECT warehouse_type, inventory_coa_code, inventory_system FROM warehouses WHERE id=?'
    ).get(warehouseId);
  } catch (_) {
    try {
      wh = db.prepare('SELECT warehouse_type, inventory_coa_code FROM warehouses WHERE id=?').get(warehouseId);
    } catch (__) {
      wh = db.prepare('SELECT warehouse_type FROM warehouses WHERE id=?').get(warehouseId);
    }
  }
  const policy = require('../coa-leaf-policy');
  const t = wh?.warehouse_type || '';
  const fixedAsset = policy.isFixedAssetWarehouseType(t);
  const override = String(wh?.inventory_coa_code || '').trim();

  // Phase 3: دارایی_ثابت never falls back to coa_finished_goods (1104).
  // Map must be a postable 12xx leaf; otherwise warn-log or 422 (never silent goods COA).
  if (fixedAsset) {
    if (override) {
      const chk = policy.checkMappedAccount(db, override, 'inventory', { fixedAsset: true });
      if (chk.ok) {
        const row = db.prepare(
          'SELECT code, name FROM chart_of_accounts WHERE code=? AND COALESCE(is_active,1)=1'
        ).get(override);
        if (row) return { code: row.code, name: row.name };
      }
      policy.logLeafIssue(policy.E_TYPE_UNSUPPORTED, {
        warehouse_id: Number(warehouseId), reason: chk.reason || 'bad_map', code: override, mode: policy.leafEnforcementMode(db),
      });
      if (opts && opts.readOnly) {
        return { code: null, name: null, unmapped_fixed_asset: true, inventory_reason: chk.reason || 'bad_map' };
      }
      throw policy.leafErr(
        policy.E_TYPE_UNSUPPORTED, 422,
        `انبار از نوع «دارایی ثابت» نمی‌تواند حساب ${override} داشته باشد — حساب برگ زیر گروه ۱۲ لازم است (E_WAREHOUSE_TYPE_UNSUPPORTED)`,
        { warehouse_id: Number(warehouseId), inventory_reason: chk.reason },
      );
    }
    policy.logLeafIssue(policy.E_TYPE_UNSUPPORTED, {
      warehouse_id: Number(warehouseId), reason: 'empty', mode: policy.leafEnforcementMode(db),
    });
    if (opts && opts.readOnly) {
      return { code: null, name: null, unmapped_fixed_asset: true, inventory_reason: 'empty' };
    }
    throw policy.leafErr(
      policy.E_TYPE_UNSUPPORTED, 422,
      'انبار از نوع «دارایی ثابت» است و حساب موجودی ندارد — ابتدا در اطلاعات پایه ← انبارها حساب برگ موجودی (گروه ۱۲) را تعیین کنید (E_WAREHOUSE_TYPE_UNSUPPORTED)',
      { warehouse_id: Number(warehouseId) },
    );
  }

  const invCheck = policy.checkMappedAccount(db, override, 'inventory', { fixedAsset: false });
  if (invCheck.ok) {
    const row = db.prepare(
      'SELECT code, name FROM chart_of_accounts WHERE code=? AND COALESCE(is_active,1)=1'
    ).get(override);
    if (row) return { code: row.code, name: row.name };
  }

  // Phase 2: empty/non-leaf map on perpetual warehouse
  const perpetual = policy.isPerpetualSystem(wh && wh.inventory_system != null ? wh.inventory_system : 'perpetual');
  if (perpetual && !(opts && opts.readOnly) && !invCheck.ok) {
    const mode = policy.leafEnforcementMode(db);
    if (mode === 'enforce') {
      throw policy.leafErr(
        policy.E_UNMAPPED, 422,
        `انبار #${warehouseId} نگاشت حساب برگ موجودی ندارد (${policy.reasonFa(invCheck.reason)}) — در اطلاعات پایه ← انبارها تکمیل کنید (E_WAREHOUSE_COA_UNMAPPED)`,
        { warehouse_id: Number(warehouseId), inventory_reason: invCheck.reason },
      );
    }
    policy.logLeafIssue(policy.E_UNMAPPED, {
      warehouse_id: Number(warehouseId),
      inventory_reason: invCheck.reason,
      mode,
      source: 'inventoryAccountForWarehouse',
    });
  }

  if (t === 'raw_material') return acct(db, 'coa_raw_materials');
  if (t === 'packaging') return acct(db, 'coa_packaging_materials');
  if (t === 'wip') return acct(db, 'coa_wip');
  if (t === 'scrap') return acct(db, 'coa_scrap_inventory');
  if (t === 'consignment') return acct(db, 'coa_subcontract_inventory');
  return acct(db, 'coa_finished_goods');
}

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

/** Float dust (|x| < 1e-9) → 0; any real quantity (including negative) is kept as-is. */
function cleanQty(n) {
  const x = Number(n) || 0;
  return Math.abs(x) < 1e-9 ? 0 : x;
}

/**
 * P1 SSOT: on-hand quantity = Σ live kardex rows (same LEDGER_LIVE_SQL as layer-reconcile).
 * products.stock / warehouse_stock / variant_warehouse_stock / product_variants.stock are CACHES
 * rebuilt from the ledger by stock-cache.rebuildStockCache; this function is what they must agree with.
 *
 * - warehouseId omitted → company-wide, WIP-staging (warehouse-only) rows excluded because
 *   they never reach the sellable header products.stock.
 * - variantId given     → only rows stamped with that variant (needs inventory_ledger.variant_id).
 *
 * @param {{productId:number, warehouseId?:number|null, variantId?:number|null}} q
 * @returns {number}
 */
function stockOf(db, { productId, warehouseId = null, variantId = null } = {}) {
  const pid = Number(productId) || 0;
  if (!pid) return 0;
  const { LEDGER_LIVE_SQL } = require('./layer-reconcile');
  const where = [`product_id=?`, `(${LEDGER_LIVE_SQL})`];
  const params = [pid];
  const wh = Number(warehouseId) || 0;
  const vid = Number(variantId) || 0;
  if (wh) { where.push('warehouse_id=?'); params.push(wh); }
  else {
    const set = [...WAREHOUSE_ONLY_EVENTS].map((e) => `'${e}'`).join(',');
    where.push(`COALESCE(event_type,'') NOT IN (${set})`);
  }
  if (vid) {
    if (!ledgerHasVariantColumn(db)) {
      return Math.round((Number(require('./movement').variantWarehouseQty(db, vid, wh || null)) || 0) * 1000) / 1000;
    }
    where.push('variant_id=?');
    params.push(vid);
  }
  const row = db.prepare(
    `SELECT COALESCE(SUM(COALESCE(qty_in,0) - COALESCE(qty_out,0)),0) AS q FROM inventory_ledger WHERE ${where.join(' AND ')}`
  ).get(...params);
  return Math.round((Number(row && row.q) || 0) * 1000) / 1000;
}

/**
 * SSOT gate for a qty row about to be inserted (no stock writes — the cache is rebuilt
 * from the ledger after the insert). Figures are ledger-derived (stockOf):
 *   header (company-wide, WIP staging excluded) / (product, warehouse) / (variant, warehouse).
 * Only an outbound delta can be refused; an inbound row never makes a shortage worse.
 * warehouseOnly: WIP staging — the sellable header is not gated and does not move.
 * Variant gate: legacy live rows of the warehouse without variant_id (unattributed) still
 * count as available so pre-SSOT kardex data does not block sales until healed.
 * Returns { qtyBefore, qtyAfter, avgBefore, product } (header figures).
 */
function assertStockGate(db, {
  productId, warehouseId, variantId = null, qtyDelta, allowNegative: allowNegOpt, warehouseOnly = false, product,
}) {
  const prod = product || getProduct(db, productId);
  const qtyBefore = stockOf(db, { productId });
  const avgBefore = Math.round(Number(prod.average_cost_rial) || 0);
  const qtyAfter = warehouseOnly ? qtyBefore : cleanQty(qtyBefore + qtyDelta);
  if (warehouseOnly && !warehouseId) throw invErr('E_INV_WAREHOUSE_REQUIRED', 400, { product_id: productId });
  const out = { qtyBefore, qtyAfter, avgBefore, product: prod };
  if (!(qtyDelta < 0)) return out;
  const allowNeg = allowNegOpt === true || allowNegative(db, warehouseId);
  if (allowNeg) return out;
  const needed = Math.abs(qtyDelta);

  if (!warehouseOnly && qtyAfter < -1e-9) {
    throw shortageAttach(invErr('E_NEGATIVE_STOCK', 409, {
      product_id: productId,
      name: prod.name,
      available: qtyBefore,
      needed,
    }), db, [{ product_id: productId, warehouse_id: warehouseId || null, available: qtyBefore, needed }]);
  }
  if (warehouseId) {
    const whBefore = stockOf(db, { productId, warehouseId });
    if (whBefore + qtyDelta < -1e-9) {
      throw shortageAttach(invErr('E_NEGATIVE_STOCK', 409, {
        product_id: productId,
        name: prod.name,
        warehouse_id: warehouseId,
        available: whBefore,
        needed,
      }), db, [{ product_id: productId, warehouse_id: warehouseId, available: whBefore, needed }]);
    }
  }
  if (variantId && ledgerHasVariantColumn(db)) {
    let vBefore = stockOf(db, { productId, warehouseId: warehouseId || null, variantId });
    const legacy = unattributedQty(db, productId, warehouseId || null);
    if (legacy > 0) vBefore += legacy;
    vBefore = Math.round(vBefore * 1000) / 1000;
    if (vBefore + qtyDelta < -1e-9) {
      throw shortageAttach(invErr('E_NEGATIVE_STOCK', 409, {
        product_id: productId,
        name: prod.name,
        variant_id: variantId,
        warehouse_id: warehouseId || null,
        available: vBefore,
        needed,
      }), db, [{ product_id: productId, variant_id: variantId, warehouse_id: warehouseId || null, available: vBefore, needed }]);
    }
  }
  return out;
}

/** Live ledger qty of (product[, warehouse]) that carries no variant_id (pre-SSOT rows). */
function unattributedQty(db, productId, warehouseId) {
  const { LEDGER_LIVE_SQL } = require('./layer-reconcile');
  const where = ['product_id=?', `(${LEDGER_LIVE_SQL})`, 'variant_id IS NULL'];
  const params = [productId];
  if (warehouseId) { where.push('warehouse_id=?'); params.push(warehouseId); } else {
    const set = [...WAREHOUSE_ONLY_EVENTS].map((e) => `'${e}'`).join(',');
    where.push(`COALESCE(event_type,'') NOT IN (${set})`);
  }
  const r = db.prepare(
    `SELECT COALESCE(SUM(COALESCE(qty_in,0) - COALESCE(qty_out,0)),0) AS q FROM inventory_ledger WHERE ${where.join(' AND ')}`
  ).get(...params);
  return Math.round((Number(r && r.q) || 0) * 1000) / 1000;
}

/**
 * Deprecated (pre-SSOT cache delta writer). Now only gates and re-derives the caches from the
 * ledger: a stock change without a ledger row no longer exists. Callers that used it to move
 * caches must post a ledger row (postInventoryMovement) instead.
 */
function applyStockDelta(db, {
  productId, warehouseId, qtyDelta, allowNegative: allowNegOpt, warehouseOnly = false, variantId = null,
}) {
  const info = assertStockGate(db, {
    productId, warehouseId, variantId, qtyDelta, allowNegative: allowNegOpt, warehouseOnly,
  });
  rebuildCache(db, productId);
  return info;
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
 * Does inventory_ledger have the additive nullable `variant_id` column?
 * Positive result cached per db handle; negative result re-checked after a short TTL so a
 * column added by a migration during the same process is picked up.
 */
const _variantColCache = new WeakMap();
function ledgerHasVariantColumn(db) {
  const hit = _variantColCache.get(db);
  const now = Date.now();
  if (hit && (hit.has || now - hit.at < 5000)) return hit.has;
  let has = false;
  try {
    has = db.prepare('PRAGMA table_info(inventory_ledger)').all().some((c) => c.name === 'variant_id');
  } catch (_) { has = false; }
  _variantColCache.set(db, { has, at: now });
  return has;
}

/**
 * Core: post one inventory movement (append-only).
 * @param {number} [opts.variantId]  matrix variant — written on new rows when the column exists
 * @param {object} opts
 * @param {string} opts.eventType  receipt|issue|transfer_out|transfer_in|adjustment|sale|sale_return|purchase|purchase_return|production_issue|production_receipt|scrap|opening|landed_cost|cycle_count
 * @param {number} opts.productId
 * @param {number} [opts.warehouseId]
 * @param {number} opts.qty        signed: +in / -out; or use qtyIn/qtyOut
 * @param {number} [opts.unitCostRial]  for inbound; outbound defaults to current avg
 * @param {number} [opts.amountRial]    override total
 * @param {boolean} [opts.updateAvg=true]
 * @param {boolean} [opts.skipStock=false]  no negative gate, no average/layers, no stock_logs
 *   (opening/backfill seeds). SSOT: the row still counts in every stock figure — the caches are
 *   rebuilt from the ledger after the insert, so a caller must not move them separately.
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
  // v522 monthly valuation lock: value-only postings dated in a closed month are rejected.
  if (valueOnly && reversedOf == null && date) {
    require('./period-lock').assertPeriodOpen(db, date, 'تعدیل ارزش موجودی');
  }

  const delta = qtyIn - qtyOut;
  // WIP staging never touches the header: no products.stock, no average, no cost layer, no stock_logs
  // row — but it IS an inventory_ledger row (warehouse kardex), so callers must pass its amount.
  const noHeader = !!skipStock || !!warehouseOnly;

  const isReversal = isReversalEvent(eventType, reversedOf);
  const ledVariantId = opts.variantId != null && Number(opts.variantId) > 0
    ? Math.trunc(Number(opts.variantId)) : null;
  const writeVariant = ledVariantId != null && ledgerHasVariantColumn(db);
  if (ledVariantId) {
    let vr = null;
    try { vr = db.prepare('SELECT product_id FROM product_variants WHERE id=?').get(ledVariantId); } catch (_) { vr = null; }
    if (vr && Number(vr.product_id) !== Number(productId)) {
      throw invErr('E_VARIANT_MISMATCH', 400, { product_id: productId, variant_id: ledVariantId, message: 'واریانت متعلق به این کالا نیست' });
    }
  }
  // SSOT: every qty row of a matrix product names its SKU; reversals copy the original (legacy NULL allowed).
  if (!valueOnly && !isReversal && !ledVariantId && ledgerHasVariantColumn(db)
    && require('./movement').hasActiveMatrixVariants(db, productId)) {
    throw invErr('E_VARIANT_REQUIRED', 400, {
      product_id: productId, event_type: eventType,
      message: 'برای کالای ماتریسی انتخاب واریانت الزامی است',
    });
  }

  // Snapshot first (no mutation) so zero-cost outbound can fail before stock changes.
  // Quantities are ledger-derived (stockOf), never read from the caches.
  const prodSnap = getProduct(db, productId);
  const headerQty = stockOf(db, { productId });
  let stockInfo = {
    qtyBefore: headerQty,
    qtyAfter: warehouseOnly ? headerQty : cleanQty(headerQty + delta),
    avgBefore: Math.round(Number(prodSnap.average_cost_rial) || 0),
    product: prodSnap,
  };

  const V = require('./valuation');
  const policy = V.resolvePolicy(db, { productId, warehouseId });
  const method = policy.method;
  const valueBasedOut = qtyOut > 0 && !valueOnly && isValueBasedOutbound(eventType, reversedOf);
  const isAlign = isAlignSeedOpts(eventType, sourceType, note);

  let unit = Math.round(Number(unitCostRial) || 0);
  if (!unit) unit = stockInfo.avgBefore;
  let amount = amountRial != null
    ? Math.round(Number(amountRial) || 0)
    : Math.round(unit * (qtyIn || qtyOut));

  // v522 pool AVCO: default-costed outbound takes the pool rate of its (product, warehouse):
  // separate warehouse pool → bucket avg; shared pool in a mixed product → Σvalue/Σqty of
  // shared buckets; pure shared → header avg. Transfers carry this source rate to the destination.
  // opts.priceFixed: the caller already priced the row at its pool (e.g. transfer source bucket avg).
  let poolPriced = false;
  if (qtyOut > 0 && !valueOnly && !valueBasedOut && !warehouseOnly && warehouseId
    && method === 'moving_average' && !opts.priceFixed) {
    const callerUnit = Math.round(Number(unitCostRial) || 0);
    const defaultUnit = !callerUnit || callerUnit === stockInfo.avgBefore;
    const defaultAmount = amountRial == null
      || Math.round(Number(amountRial) || 0) === Math.round((callerUnit || stockInfo.avgBefore) * qtyOut);
    if (defaultUnit && defaultAmount) {
      const pr = V.poolRate(db, productId, warehouseId);
      if (pr.unit != null) {
        unit = pr.unit;
        amount = Math.round(unit * qtyOut);
        poolPriced = unit !== stockInfo.avgBefore;
      }
    }
  }

  // v522 closed month: a back-dated external receipt enters at the current pool rate; the
  // difference vs its document cost is parked for approval. The returned amount_rial stays
  // the document cost so callers' JEs are unchanged; the parking JE moves the difference.
  const bookAmount = amount;
  let parkedRial = 0;
  if (qtyIn > 0 && !valueOnly && !isReversal && !noHeader && updateAvg && !isAlign
    && method === 'moving_average' && CLOSED_RECEIPT_EVENTS.has(String(eventType || '')) && date
    && require('./period-lock').isValueLocked(db, date)) {
    const poolUnit = closedReceiptPoolUnit(db, { productId, warehouseId, stockInfo });
    if (poolUnit != null) {
      const poolAmount = Math.round(poolUnit * qtyIn);
      if (poolAmount !== amount) {
        parkedRial = amount - poolAmount;
        amount = poolAmount;
        unit = poolUnit;
      }
    }
  }
  // v525 closed month, outbound mirror: a back-dated purchase return leaves at the pool rate so
  // the pool average is untouched; doc-vs-pool difference parked (delta = pool − doc, so the
  // parking JE Dr inventory / Cr clearing restores what the return JE over-credited).
  if (qtyOut > 0 && !valueOnly && !isReversal && !noHeader && !warehouseOnly && updateAvg && !isAlign
    && method === 'moving_average' && CLOSED_RETURN_EVENTS.has(String(eventType || '')) && date
    && require('./period-lock').isValueLocked(db, date)) {
    const poolUnit = closedReceiptPoolUnit(db, { productId, warehouseId, stockInfo });
    if (poolUnit != null) {
      const poolAmount = Math.round(poolUnit * qtyOut);
      if (poolAmount !== amount) {
        parkedRial = poolAmount - amount;
        amount = poolAmount;
        unit = poolUnit;
      }
    }
  }

  // v529: never persist qty_out>0 with zero amount — fail BEFORE stock mutation when
  // we already know cost is zero (MA from resolvePolicy, or FIFO/specific with no layers
  // and zero header avg). Method is never hardcoded to moving_average.
  if (
    qtyOut > 0
    && !valueOnly
    && !isReversal
    && !isAlign
    && !opts.allowZeroCost
    && Math.round(Number(amount) || 0) <= 0
  ) {
    let knownZero = method === 'moving_average';
    if (!knownZero && method !== 'moving_average' && !noHeader) {
      try {
        const hasLayer = db.prepare(`
          SELECT 1 AS ok FROM inventory_cost_layers
          WHERE product_id=? AND status='open' AND qty_remaining>0
            AND (? IS NULL OR warehouse_id=? OR warehouse_id IS NULL)
          LIMIT 1
        `).get(productId, warehouseId, warehouseId);
        knownZero = !hasLayer;
      } catch (_) { knownZero = true; }
    }
    if (knownZero) {
      const pname = (stockInfo.product && stockInfo.product.name) || productId;
      throw invErr('E_ZERO_OUTBOUND_COST', 422, {
        product_id: productId,
        name: pname,
        method,
        warehouse_id: warehouseId,
        qty_out: qtyOut,
        message: `بهای خروجی «${pname}» صفر است (روش ${method}) — ابتدا بهای موجودی/رسید را ثبت کنید یا میانگین را بذر کنید`,
      });
    }
  }

  if (!skipStock && !valueOnly) {
    stockInfo = assertStockGate(db, {
      productId, warehouseId, variantId: ledVariantId, qtyDelta: delta,
      allowNegative: opts.allowNegative, warehouseOnly, product: prodSnap,
    });
    // Home warehouse (not a stock figure): first inbound warehouse becomes the product default.
    if (warehouseId && !warehouseOnly && delta > 0
      && (!prodSnap.warehouse_id || Number(prodSnap.warehouse_id) === Number(warehouseId))) {
      db.prepare('UPDATE products SET warehouse_id=? WHERE id=?').run(warehouseId, productId);
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

  // FIFO / specific cost layers (optional path) — after stock, same as before v529.
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

  // Belt-and-suspenders after FIFO layer consume (layers with unit 0).
  if (
    qtyOut > 0
    && !valueOnly
    && !isReversal
    && !isAlign
    && !opts.allowZeroCost
    && Math.round(Number(amount) || 0) <= 0
  ) {
    const pname = (stockInfo.product && stockInfo.product.name) || productId;
    throw invErr('E_ZERO_OUTBOUND_COST', 422, {
      product_id: productId,
      name: pname,
      method,
      warehouse_id: warehouseId,
      qty_out: qtyOut,
      message: `بهای خروجی «${pname}» صفر است (روش ${method}) — ابتدا بهای موجودی/رسید را ثبت کنید یا میانگین را بذر کنید`,
    });
  }

  const txNo = nextTxNo(db);
  // variant_id is written whenever the column exists (additive column; old rows are not backfilled here).
  const result = db.prepare(`
    INSERT INTO inventory_ledger (
      tx_no, event_type, product_id, warehouse_id,
      qty_in, qty_out, qty_balance, unit_cost_rial, amount_rial, avg_cost_after_rial,
      batch_id, serial_id, source_type, source_id, je_id, reversed_of,
      status, date, note, created_by${writeVariant ? ', variant_id' : ''}
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?${writeVariant ? ',?' : ''})
  `).run(
    txNo, eventType, productId, warehouseId,
    qtyIn, qtyOut, stockInfo.qtyAfter, unit, amount, avgAfter,
    batchId, serialId, sourceType, sourceId, jeId, reversedOf,
    'posted', date || '', note || '', createdBy,
    ...(writeVariant ? [ledVariantId] : [])
  );

  const ledgerId = result.lastInsertRowid;
  // SSOT: the four stock figures are re-derived from the live ledger (only writer: stock-cache.js).
  if (!valueOnly) rebuildCache(db, productId);

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
  if (poolPriced && !noHeader && eventType !== 'transfer_out') {
    const synced = V.syncHeaderAvgFromBuckets(db, productId);
    if (synced != null) {
      avgAfter = synced;
      db.prepare('UPDATE inventory_ledger SET avg_cost_after_rial=? WHERE id=?').run(synced, ledgerId);
    }
  }
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

  let parkedApproval = null;
  if (parkedRial) {
    parkedApproval = require('./value-approval').parkReceiptDifference(db, {
      sourceType, sourceId, ledgerId, productId, warehouseId, qtyIn: qtyIn || qtyOut,
      diffRial: parkedRial, date, createdBy, note,
      label: qtyOut > 0 ? `${sourceType || 'خروج'} #${sourceId || ledgerId} — مابه‌التفاوت نرخ سند با میانگین استخر (قفل دوره)` : undefined,
    });
  }

  // Website stock sync: any qty movement may change what the site shows (lazy require — no top-level dependency).
  if (qtyIn || qtyOut) {
    try {
      require('../website-stock-sync').notifyStockChanged(db, productId, { warehouseId });
    } catch (_) { /* website sync is best-effort */ }
  }

  return {
    id: ledgerId,
    tx_no: txNo,
    product_id: productId,
    warehouse_id: warehouseId || null,
    qty_in: qtyIn,
    qty_out: qtyOut,
    qty_balance: stockInfo.qtyAfter,
    unit_cost_rial: parkedRial ? (qtyIn > 0 ? Math.round(bookAmount / qtyIn) : unit) : unit,
    amount_rial: parkedRial ? bookAmount : amount,
    ledger_amount_rial: amount,
    value_parked_rial: parkedRial,
    value_approval_id: parkedApproval ? parkedApproval.id : null,
    avg_cost_after_rial: avgAfter,
    value_applied_rial: valueApplied,
    value_unapplied_rial: valueUnapplied,
  };
}

const CLOSED_RECEIPT_EVENTS = new Set(['purchase', 'receipt', 'production_receipt']);
// sale_return parks in sales-document.js; transfer_in is parked by its caller (pool-to-pool only).
const CLOSED_RETURN_EVENTS = new Set(['purchase_return']);

/** Pool rate a closed-month receipt enters at; null = nothing to protect (empty pool / periodic). */
function closedReceiptPoolUnit(db, { productId, warehouseId, stockInfo }) {
  try {
    if (warehouseId && require('./periodic-close').isPeriodicWarehouse(db, warehouseId)) return null;
  } catch (_) { /* periodic module optional */ }
  const V = require('./valuation');
  const lv = V.levelFor(db, productId, warehouseId || null);
  let qty;
  let unit;
  if (lv.level === 'warehouse' && warehouseId) {
    const b = V.getBucket(db, productId, warehouseId);
    qty = Number(b && b.qty) || 0;
    unit = Math.round(Number(b && b.avg_rial) || 0);
  } else {
    const pools = V.productPools(db, productId);
    if (pools.mode === 'mixed') {
      const st = V.sharedPoolState(db, productId, pools);
      qty = st.qty;
      unit = st.avg_rial;
    } else {
      qty = Number(stockInfo.qtyBefore) || 0;
      unit = Math.round(Number(stockInfo.avgBefore) || 0);
    }
  }
  if (!(qty > 1e-9) || !(unit > 0)) return null;
  return unit;
}

/**
 * Reverse a posted ledger row (R12). Creates opposite movement + marks original reversed.
 */
function reverseInventoryMovement(db, ledgerId, {
  createdBy, date, note, skipStock, keepDate = false, allowNegative: allowNeg,
} = {}) {
  const row = db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(ledgerId);
  if (!row) throw invErr('E_LEDGER_NOT_FOUND', 404);
  if (row.status === 'reversed') throw invErr('E_ALREADY_REVERSED', 409);

  const valueOnly = (Number(row.qty_in) || 0) === 0 && (Number(row.qty_out) || 0) === 0
    && Math.round(Number(row.amount_rial) || 0) !== 0;
  // Opening / هم‌ترازی seeds were posted with skipStock — reverse must not touch warehouse_stock.
  const noteFa = String(row.note || '').replace(/\u200c/g, '').replace(/ي/g, 'ی');
  // P2: سند افتتاحیه انبار (opening_stock_doc) موجودی را واقعاً جابه‌جا کرده — برگشت آن باید اثر موجودی داشته باشد.
  const alignSeed = String(row.source_type || '') !== 'opening_stock_doc' && (
    String(row.source_type || '') === 'opening_inventory'
    || String(row.source_type || '') === 'stock_reconcile'
    || String(row.event_type || '') === 'opening'
    || /هم[\u200c\s]*ترازی\s*کاردکس/.test(noteFa)
    || /^موجودی اول دوره/.test(noteFa));
  const skip = skipStock === true || valueOnly || alignSeed;
  // Value-only reversal removes exactly what reached the header (by value, never a snapshot).
  let applyValueRial;
  if (valueOnly) {
    const applied = require('./valuation').valueAppliedFor(db, row.id);
    applyValueRial = -(applied != null ? applied : Math.round(Number(row.amount_rial) || 0));
  }
  let revDate = date || row.date;
  if (valueOnly && revDate && !keepDate) revDate = require('./period-lock').firstOpenDate(db, revDate);
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
    variantId: row.variant_id || null,
    reversedOf: row.id,
    date: revDate,
    note: note || `معکوس ${row.tx_no}`,
    createdBy,
    updateAvg: !valueOnly && !skip,
    warehouseOnly: isWarehouseOnlyRow(row),
    skipStock: skip,
    valueOnly,
    allowNegative: allowNeg === true,
  });

  db.prepare("UPDATE inventory_ledger SET status='reversed' WHERE id=?").run(row.id);
  // The pair (original reversed + reversal row) leaves the live set only now.
  if (!valueOnly) rebuildCache(db, row.product_id);
  if ((Number(row.qty_in) || 0) > 0 || CLOSED_RETURN_EVENTS.has(String(row.event_type || ''))) {
    require('./value-approval').onLedgerReversed(db, row.id, { createdBy, note: note || `معکوس ${row.tx_no}` });
  }
  if ((Number(row.qty_in) || 0) > 0 || (Number(row.qty_out) || 0) > 0) {
    try {
      require('../website-stock-sync').notifyStockChanged(db, row.product_id, { warehouseId: row.warehouse_id });
    } catch (_) { /* best-effort; idempotent with the notify in postInventoryMovement */ }
  }
  return rev;
}

/** Truthy query flag: 1 / true / yes / on. */
function parseKardexFlag(v) {
  if (v === true || v === 1) return true;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * Cancelled (void) ledger row — STRUCTURAL only (status / reversed_of / event_type).
 * No note/description regex: a note is free text and never decides a balance.
 */
function isCancelledLedgerRow(r) {
  if (!r) return false;
  if (String(r.status || '') === 'reversed') return true;
  if (r.reversed_of != null && r.reversed_of !== '' && Number(r.reversed_of) !== 0) return true;
  const et = String(r.event_type || '');
  return et === 'reversal' || et.endsWith('_reversal');
}

/** value effect of one ledger row on the stock value (same sign rule as layer-reconcile Σ). */
function ledgerValueDelta(r) {
  const qIn = Number(r.qty_in) || 0;
  const qOut = Number(r.qty_out) || 0;
  const amt = Math.round(Number(r.amount_rial) || 0);
  if (qIn > 0) return amt;
  if (qOut > 0) return -amt;
  return amt;
}

/**
 * Kardex (fallback for /inventory/kardex/:productId).
 * Same rules as buildStockLedger: ORDER BY COALESCE(date,''), id; running qty AND running value
 * computed for the SAME filter; opening for the period; optional pagination with page opening.
 *
 * @param {object} [opts]
 * @param {number} [opts.warehouseId]
 * @param {number} [opts.variantId]     filter by inventory_ledger.variant_id (only when the column exists)
 * @param {string} [opts.from] [opts.to] Jalali YYYY/MM/DD
 * @param {number} [opts.page] [opts.pageSize]  pagination only when one of them is given; pageSize ≤ 500
 * @param {boolean} [opts.showWip] [opts.showWarehouseOnly] [opts.showCancelled]
 * @param {number} [opts.limit]  legacy explicit cap on returned rows (no default — never silently truncates)
 */
function getKardex(db, productId, opts = {}) {
  const {
    warehouseId, variantId, from, to, page, pageSize, limit,
  } = opts;
  const showWip = parseKardexFlag(opts.showWip);
  const showWarehouseOnly = parseKardexFlag(opts.showWarehouseOnly);
  const showCancelled = parseKardexFlag(opts.showCancelled);
  const { reportDateKey } = require('../report-order');
  const product = getProduct(db, productId);
  const where = ['l.product_id=?'];
  const params = [productId];
  if (warehouseId) { where.push('l.warehouse_id=?'); params.push(warehouseId); }
  let variantApplied = false;
  if (variantId != null && variantId !== '' && Number(variantId) > 0 && ledgerHasVariantColumn(db)) {
    where.push('l.variant_id=?');
    params.push(Number(variantId));
    variantApplied = true;
  }
  const rows = db.prepare(`
    SELECT l.*, u.name as user_name, w.name as warehouse_name
    FROM inventory_ledger l
    LEFT JOIN users u ON l.created_by=u.id
    LEFT JOIN warehouses w ON l.warehouse_id=w.id
    WHERE ${where.join(' AND ')} AND l.status IN ('posted','reversed')
    ORDER BY COALESCE(l.date,''), l.id
  `).all(...params);
  let wipIds = new Set();
  try {
    wipIds = new Set(db.prepare(
      "SELECT id FROM warehouses WHERE kind='wip' OR warehouse_type='wip'"
    ).all().map((w) => Number(w.id)));
  } catch (_) { wipIds = new Set(); }
  const wipView = !!warehouseId && wipIds.has(Number(warehouseId));
  const wipOk = showWip || wipView;
  const woOk = showWarehouseOnly || wipView;
  const fromK = from ? reportDateKey(from) : null;
  const toK = to ? reportDateKey(to) : null;

  const reversedByOf = new Map();
  for (const r of rows) if (r.reversed_of) reversedByOf.set(Number(r.reversed_of), r.id);

  // pass 1 — which rows exist in the stream
  const stream = [];
  for (const r of rows) {
    if (isZeroQtyValueGhost(r)) continue;
    if (!woOk && isWarehouseOnlyRow(r)) continue;
    if (!wipOk && wipIds.has(Number(r.warehouse_id))) continue;
    const cancelled = isCancelledLedgerRow(r);
    if (cancelled && !showCancelled) continue;
    stream.push({ r, cancelled });
  }

  let openingQty = 0;
  let openingValue = 0;
  let periodIn = 0;
  let periodOut = 0;
  let periodValue = 0;
  let valueOnlyRial = 0;
  let runQty = 0;
  let runVal = 0;
  const out = [];
  // pass 2 — opening (rows before «from») then period rows with running qty + value
  for (const phase of ['opening', 'period']) {
    if (phase === 'period') { runQty = openingQty; runVal = openingValue; }
    for (const { r, cancelled } of stream) {
      const dk = reportDateKey(r.date);
      const before = fromK && dk < fromK;
      if (phase === 'opening') {
        if (!before || cancelled) continue;
        openingQty += (Number(r.qty_in) || 0) - (Number(r.qty_out) || 0);
        openingValue += ledgerValueDelta(r);
        continue;
      }
      if (before) continue;
      if (toK && dk > toK) continue;
      const qIn = Number(r.qty_in) || 0;
      const qOut = Number(r.qty_out) || 0;
      const vd = ledgerValueDelta(r);
      const valueOnly = !qIn && !qOut;
      if (!cancelled) {
        runQty += qIn - qOut;
        runVal += vd;
        periodIn += qIn;
        periodOut += qOut;
        periodValue += vd;
        if (valueOnly) valueOnlyRial += vd;
      }
      if (valueOnly) continue; // value-only revaluations move the value, not the kardex table
      out.push({
        ...r,
        is_reversed: cancelled,
        reversed_by: reversedByOf.get(Number(r.id)) || null,
        reversal_of: r.reversed_of || null,
        value_delta_rial: cancelled ? 0 : vd,
        running_qty: runQty,
        running_value_rial: runVal,
      });
    }
  }

  const closingQty = openingQty + periodIn - periodOut;
  const closingValue = openingValue + periodValue;
  const totalRows = out.length;

  let pageRows = out;
  let pg = 1;
  let size = totalRows;
  let totalPages = 1;
  let paginated = false;
  let pageOpeningQty = openingQty;
  let pageOpeningValue = openingValue;
  const wantPage = page != null && page !== '';
  const wantSize = pageSize != null && pageSize !== '';
  if (wantPage || wantSize) {
    paginated = true;
    size = Math.min(500, Math.max(1, parseInt(pageSize, 10) || 200));
    totalPages = Math.max(1, Math.ceil(totalRows / size));
    pg = Math.max(1, parseInt(page, 10) || 1);
    const start = (pg - 1) * size;
    pageRows = out.slice(start, start + size);
    if (pageRows.length) {
      const f = pageRows[0];
      const effQ = f.is_reversed ? 0 : (Number(f.qty_in) || 0) - (Number(f.qty_out) || 0);
      pageOpeningQty = f.running_qty - effQ;
      pageOpeningValue = f.running_value_rial - f.value_delta_rial;
    } else if (start > 0) {
      pageOpeningQty = closingQty;
      pageOpeningValue = closingValue;
    }
  } else if (Number(limit) > 0) {
    pageRows = out.slice(0, Math.floor(Number(limit)));
  }
  const last = pageRows[pageRows.length - 1];

  return {
    product,
    rows: pageRows,
    warehouse_id: warehouseId || null,
    variant_id: variantApplied ? Number(variantId) : null,
    variant_filter_applied: variantApplied,
    from: from || null,
    to: to || null,
    toggles: { show_wip: showWip, show_warehouse_only: showWarehouseOnly, show_cancelled: showCancelled },
    period_opening_qty: openingQty,
    period_opening_value_rial: openingValue,
    opening_qty: pageOpeningQty,
    opening_value_rial: pageOpeningValue,
    period_qty_in: periodIn,
    period_qty_out: periodOut,
    period_net_qty: periodIn - periodOut,
    period_value_delta_rial: periodValue,
    value_only_rial: valueOnlyRial,
    closing_qty: closingQty,
    closing_value_rial: closingValue,
    page_closing_qty: last ? last.running_qty : pageOpeningQty,
    page_closing_value_rial: last ? last.running_value_rial : pageOpeningValue,
    paginated,
    page: pg,
    page_size: size,
    total_rows: totalRows,
    total_pages: totalPages,
    has_more: paginated ? pg < totalPages : false,
  };
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
 * SSOT: the row leaves the live set, so its qty leaves every stock figure (caches rebuilt here).
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
  rebuildCache(db, row.product_id);
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
  stockOf,
  cleanQty,
  ledgerHasVariantColumn,
  reverseInventoryMovement,
  getKardex,
  parseKardexFlag,
  isCancelledLedgerRow,
  ledgerValueDelta,
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
  assertStockGate,
  unattributedQty,
  isWarehouseOnlyRow,
  WAREHOUSE_ONLY_EVENTS,
};
