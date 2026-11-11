'use strict';
/**
 * v525 — manual stock adjustment (تعدیل موجودی) with reason, preview and full reversal.
 * stock-adjust-fix: matrix requires warehouse+variant; refuse while unallocated_net≠0;
 * counters via value-accounts (4205 / 6118 / 610801 — never 5101 / 9999); void closes cost layers.
 *
 *   planAdjust  → read-only preview (no writes): current/new qty, live outbound rate, value,
 *                 counter-account by reason+sign (value-accounts), closed-month notice.
 *   postAdjust  → one transaction: ledger row (+ variant×warehouse layer), balanced JE,
 *                 closed inventory month → JE counter side to «تعدیل بهای در انتظار تأیید» and an
 *                 approval doc via value-approval.begin/gate/finish (reason closed_period).
 *   reverseAdjust → R13: ledger reversal + variant layer + JE reversal + approval cancel + layer close.
 *
 * mode 'delta' = signed qty; mode 'count' = counted qty (delta computed inside the tx).
 * Surplus unit cost defaults to the live pool/average rate; overriding it needs
 * canDo(user,'acc_inv_valuation','create'). Outbound always leaves at the live rate.
 */
const VA = require('./value-accounts');

const JALALI_RE = /^1[3-5]\d{2}\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])$/;
const SOURCE = 'inventory_adjust';

function adjErr(code, status, message, extra) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

function round3(n) { return Math.round((Number(n) || 0) * 1000) / 1000; }

function today() { return require('../../jalali').todayJalali(); }

/**
 * Who may post / preview / list manual adjustments: admin, or acc_warehouse_ops:create
 * (role defaults give it to accounting; per-user grants/denials win). Void needs :delete.
 */
const PERM_RESOURCE = 'acc_warehouse_ops';
function canAdjustStock(user, db) {
  if (!user) return false;
  return require('../rbac').canDo(user, PERM_RESOURCE, 'create', db);
}
function canVoidAdjust(user, db) {
  if (!user) return false;
  return require('../rbac').canDo(user, PERM_RESOURCE, 'delete', db);
}

function canOverrideCost(user, db) {
  if (!user) return false;
  return require('../rbac').canDo(user, 'acc_inv_valuation', 'create', db);
}

function parseInputs(db, body = {}) {
  const productId = Number(body.product_id) || 0;
  if (!productId) throw adjErr('E_ADJUST_ARGS', 400, 'کالا الزامی است');
  const product = db.prepare('SELECT id, name, code, unit, stock, average_cost_rial, warehouse_id FROM products WHERE id=?').get(productId);
  if (!product) throw adjErr('E_PRODUCT_NOT_FOUND', 404, 'کالا یافت نشد');
  const warehouseId = Number(body.warehouse_id) || null;
  if (warehouseId && !db.prepare('SELECT 1 FROM warehouses WHERE id=?').get(warehouseId)) {
    throw adjErr('E_WAREHOUSE_NOT_FOUND', 404, 'انبار یافت نشد');
  }
  const variantId = Number(body.variant_id) || null;
  if (variantId) {
    let vr = null;
    try { vr = db.prepare('SELECT id, product_id FROM product_variants WHERE id=?').get(variantId); } catch (_) { vr = null; }
    if (!vr) throw adjErr('E_VARIANT_NOT_FOUND', 404, 'واریانت یافت نشد');
    if (Number(vr.product_id) !== productId) throw adjErr('E_VARIANT_MISMATCH', 400, 'واریانت متعلق به این کالا نیست');
  }
  const rawMode = body.mode == null || body.mode === '' ? 'delta' : String(body.mode);
  if (!['delta', 'count'].includes(rawMode)) throw adjErr('E_ADJUST_MODE', 400, 'نوع تعدیل باید «شمارش» یا «کم و زیاد» باشد');
  const qty = Number(body.qty);
  if (body.qty === '' || body.qty == null || !Number.isFinite(qty)) throw adjErr('E_ADJUST_QTY', 400, 'تعداد نامعتبر است');
  if (rawMode === 'count' && qty < 0) throw adjErr('E_ADJUST_QTY', 400, 'تعداد شمارش‌شده نمی‌تواند منفی باشد');
  const reasonCode = VA.normReason(body.reason_code);
  const date = body.date ? String(body.date).trim() : today();
  if (!JALALI_RE.test(date)) throw adjErr('E_ADJUST_DATE', 400, 'تاریخ باید به شکل ۱۴۰۵/۰۷/۳۰ باشد');
  let unitCost = null;
  if (body.unit_cost_rial !== undefined && body.unit_cost_rial !== null && body.unit_cost_rial !== '') {
    unitCost = Math.round(Number(body.unit_cost_rial));
    if (!Number.isFinite(unitCost) || unitCost < 0) throw adjErr('E_UNIT_COST', 400, 'بهای واحد نامعتبر است');
  }
  return { product, productId, warehouseId, variantId, mode: rawMode, qty, reasonCode, date, unitCost };
}

/** Ledger-derived on-hand (Σ live kardex rows) of the adjusted SKU / warehouse. */
function currentQty(db, { productId, warehouseId, variantId }) {
  if (variantId) return round3(require('./movement').variantWarehouseQty(db, variantId, warehouseId));
  return round3(require('./ledger').stockOf(db, { productId, warehouseId: warehouseId || null }));
}

function unallocatedNet(db, productId, warehouseId) {
  if (!warehouseId) return 0;
  try {
    const d = require('./stock-cache').deriveProductStock(db, productId);
    return round3(d.unattributed.get(Number(warehouseId)) || 0);
  } catch (_) { return 0; }
}

function warehouseQtyOf(db, productId, warehouseId) {
  if (!warehouseId) return null;
  return round3(require('./ledger').stockOf(db, { productId, warehouseId }));
}

/** Live rate an outbound row would take now; also the default surplus rate. */
function liveRate(db, { productId, warehouseId, product }) {
  const V = require('./valuation');
  const policy = V.resolvePolicy(db, { productId, warehouseId });
  const header = Math.round(Number(product.average_cost_rial) || 0);
  if (policy.method === 'moving_average' && warehouseId) {
    const pr = V.poolRate(db, productId, warehouseId);
    if (pr.unit != null) return { unit: pr.unit, source: pr.source, method: policy.method };
  }
  return { unit: header, source: 'header', method: policy.method };
}

function isPeriodic(db, warehouseId) {
  if (!warehouseId) return false;
  try { return !!require('./periodic-close').isPeriodicWarehouse(db, warehouseId); } catch (_) { return false; }
}

function counterFor(db, { inventoryCode, reasonCode, deltaQty, peek }) {
  if (!reasonCode) return null;
  const c = VA.adjustCounterAccount(db, { inventoryCode, reasonCode, deltaQty, peek });
  if (!c) return null;
  return { code: c.code, name: c.name, stage: c.stage, source: c.source };
}

/**
 * Read-only preview. Also used by postAdjust (inside its tx) so both compute identically.
 */
function planAdjust(db, body, user, { peek = true } = {}) {
  const inp = parseInputs(db, body);
  const { productId, warehouseId, variantId, mode, qty, reasonCode, date, product } = inp;
  const warnings = [];
  const mv = require('./movement');
  const matrix = mv.hasActiveMatrixVariants(db, productId);
  const unalloc = unallocatedNet(db, productId, warehouseId);
  const whQty = warehouseQtyOf(db, productId, warehouseId);
  const variantUsable = !matrix || !!variantId;
  const cur = variantUsable
    ? currentQty(db, { productId, warehouseId, variantId })
    : null;
  const delta = variantUsable ? round3(mode === 'count' ? qty - cur : qty) : null;
  const newQty = (variantUsable && delta != null) ? round3(cur + delta) : null;
  const integer = require('./qty-policy').requiresIntegerQty(db, productId, product.unit);
  if (matrix && !warehouseId) warnings.push('کالای رنگ×سایز: انبار الزامی است');
  if (matrix && !variantId) {
    warnings.push('کالای رنگ×سایز: تا رنگ/سایز انتخاب نشود «موجودی فعلی» نمایش داده نمی‌شود و ثبت ممکن نیست');
  }
  if (matrix && warehouseId && Math.abs(unalloc) > 1e-9) {
    warnings.push(
      `در این انبار ${unalloc} واحد بدون رنگ/سایز مانده است؛ ابتدا «تفکیک رنگ» یا «ابطال اصلاحی با اثر موجودی» را روی ردیف بی‌واریانت انجام دهید، سپس تعدیل رنگ`
    );
  }
  if (!matrix && !warehouseId) warnings.push('انبار انتخاب نشده؛ فقط موجودی کل کالا تعدیل می‌شود');
  if (integer && delta != null && Math.abs(delta - Math.round(delta)) > 1e-9) {
    warnings.push('این کالا قطعه‌ای است؛ تعداد باید عدد صحیح باشد');
  }
  if (delta != null && !delta) warnings.push('تعداد جدید با موجودی فعلی برابر است؛ تعدیلی لازم نیست');
  if (newQty != null && newQty < -1e-9 && !require('./ledger').allowNegative(db, warehouseId)) {
    warnings.push(`موجودی بعد از تعدیل منفی می‌شود (${newQty}) و ثبت رد خواهد شد`);
  }
  if (!reasonCode) warnings.push('دلیل را انتخاب کنید');
  const rate = liveRate(db, { productId, warehouseId, product });
  if (rate.method !== 'moving_average' && delta != null && delta < 0) {
    warnings.push('روش ارزش‌گذاری لایه‌ای است؛ مبلغ نهایی خروجی از لایه‌های بها محاسبه می‌شود');
  }
  const allowOverride = canOverrideCost(user, db);
  let unit = rate.unit;
  let costOverridden = false;
  if (delta != null && delta > 0 && inp.unitCost != null && Math.abs(inp.unitCost - rate.unit) >= 1) {
    unit = inp.unitCost;
    costOverridden = true;
    if (!allowOverride) warnings.push('تغییر بهای واحد فقط با دسترسی «ارزش‌گذاری موجودی — ثبت» مجاز است');
  }
  if (delta != null && delta > 0 && !unit) warnings.push('بهای میانگین این کالا صفر است؛ اضافی بدون ارزش ریالی وارد می‌شود');
  const valueRial = (delta == null || !delta)
    ? 0
    : Math.round(unit * Math.abs(delta)) * (delta < 0 ? -1 : 1);
  const { inventoryAccountForWarehouse } = require('./ledger');
  const inv = inventoryAccountForWarehouse(db, warehouseId);
  let counter = null;
  let counterSource = null;
  let stage = VA.stageOfInventoryCode(db, inv.code);
  if (reasonCode && delta != null) {
    try {
      const c = counterFor(db, { inventoryCode: inv.code, reasonCode, deltaQty: delta, peek });
      if (c) {
        counter = { code: c.code, name: c.name };
        counterSource = c.source;
        stage = c.stage;
      }
    } catch (e) {
      if (e && e.code === 'E_ADJUST_COUNTER_NOT_LEAF') {
        warnings.push(e.message);
        counter = null;
        counterSource = null;
        if (!peek) throw e;
      } else {
        throw e;
      }
    }
  }
  const PL = require('./period-lock');
  const periodLocked = PL.isPeriodLocked(db, date);
  const valueLocked = PL.isValueLocked(db, date);
  const periodic = isPeriodic(db, warehouseId);
  if (periodic) warnings.push('انبار ادواری است؛ سند حسابداری در بستن دورهٔ انبار صادر می‌شود');
  if (periodLocked) warnings.push('ماه بسته است؛ اثر ریالی برای تأیید می‌رود');
  return {
    product_id: productId,
    product_name: product.name,
    product_code: product.code || '',
    unit: product.unit || '',
    warehouse_id: warehouseId,
    variant_id: variantId,
    matrix,
    integer,
    mode,
    date,
    reason_code: reasonCode,
    reason_label: reasonCode ? VA.ADJUST_REASONS[reasonCode] : null,
    current_qty: cur,
    current_qty_usable: variantUsable,
    variant_qty: variantId ? cur : null,
    warehouse_qty: whQty,
    unallocated_net: unalloc,
    new_qty: newQty,
    delta_qty: delta,
    unit_cost_rial: unit,
    live_rate_rial: rate.unit,
    rate_source: rate.source,
    costing_method: rate.method,
    cost_overridden: costOverridden,
    can_override_cost: allowOverride,
    value_rial: valueRial,
    counter_account: counter,
    counter_source: counterSource,
    inventory_account: { code: inv.code, name: inv.name },
    stage,
    period_locked: periodLocked,
    value_gated: valueLocked && !periodic && !!valueRial,
    periodic,
    warnings,
  };
}

function voucherNo(db, jeId) {
  if (!jeId) return null;
  try {
    const r = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(jeId);
    return r ? (r.voucher_number || r.entry_no || r.num || String(r.id)) : null;
  } catch (_) { return String(jeId); }
}

/**
 * Post the adjustment. body.reason (legacy text) or body.note is the description.
 * opts.requireReason → reason_code mandatory (new UI); legacy callers keep the old contract.
 */
function postAdjust(db, body, user, opts = {}) {
  const pre = parseInputs(db, body);
  const note = String(body.note != null ? body.note : (body.reason || '')).trim();
  if (opts.requireReason && !pre.reasonCode) throw adjErr('E_ADJUST_REASON_REQUIRED', 400, 'دلیل تعدیل الزامی است');
  if (!pre.reasonCode && !note) throw adjErr('E_ADJUST_REASON_REQUIRED', 400, 'کالا، تعداد و دلیل الزامی است');
  let out;
  db.transaction(() => {
    const plan = planAdjust(db, body, user, { peek: false });
    const delta = plan.delta_qty;
    // v578 Phase 5: warehouse under an open stocktaking is frozen against its kardex snapshot.
    if (plan.warehouse_id) {
      require('./cycle-count').assertWarehouseNotCounting(db, [plan.warehouse_id], { label: 'تعدیل موجودی' });
    }
    // SSOT: every ledger row of a matrix product names its SKU (the ledger refuses otherwise).
    if (plan.matrix && !plan.warehouse_id) {
      throw adjErr('E_WAREHOUSE_REQUIRED', 409, 'برای کالای رنگ×سایز، انبار را انتخاب کنید');
    }
    if (plan.matrix && !plan.variant_id) {
      throw adjErr('E_VARIANT_REQUIRED', 409, 'برای کالای رنگ×سایز، رنگ/سایز را انتخاب کنید');
    }
    if (plan.matrix && plan.warehouse_id && Math.abs(Number(plan.unallocated_net) || 0) > 1e-9) {
      throw adjErr(
        'E_ADJUST_UNATTRIBUTED_EXISTS',
        409,
        'در این انبار موجودی بدون رنگ/سایز مانده است؛ ابتدا «تفکیک رنگ» یا «ابطال اصلاحی با اثر موجودی» را انجام دهید، سپس تعدیل هر رنگ',
        { product_id: plan.product_id, warehouse_id: plan.warehouse_id, unallocated_net: plan.unallocated_net }
      );
    }
    if (delta == null || !delta) throw adjErr('E_ADJUST_NO_CHANGE', 400, 'موجودی شمارش‌شده با موجودی فعلی برابر است؛ تعدیلی ثبت نشد');
    if (plan.integer && Math.abs(delta - Math.round(delta)) > 1e-9) {
      throw adjErr('E_QTY_NOT_INTEGER', 400, 'موجودی کالای قطعه‌ای باید عدد صحیح باشد');
    }
    if (plan.cost_overridden && !plan.can_override_cost) {
      throw adjErr('E_ADJUST_COST_FORBIDDEN', 403, 'تغییر بهای واحد تعدیل فقط با دسترسی «ارزش‌گذاری موجودی — ثبت» مجاز است');
    }
    if (plan.reason_code && !plan.counter_account) {
      throw adjErr('E_ADJUST_COUNTER_NOT_LEAF', 409, 'حساب مقابل تعدیل برگ فعال نیست');
    }
    // Legacy callers (no mode/reason_code, free-text reason): keep coa_adjustment for the JE only.
    // Preview never returns 9999 when reason is empty.
    if (!plan.reason_code && !plan.counter_account) {
      try {
        const { acct } = require('../coa-map');
        const a = acct(db, 'coa_adjustment');
        plan.counter_account = { code: a.code, name: a.name };
        plan.counter_source = 'legacy';
      } catch (_) { /* */ }
    }
    const L = require('./ledger');
    // P1: adjusting a SKU that was retired/unchecked brings it back (never E_VARIANT_INACTIVE).
    if (plan.variant_id) {
      require('../product-variants').reactivateVariant(db, plan.variant_id);
    }
    const reasonFa = plan.reason_label;
    const ledgerNote = [`تعدیل دستی${reasonFa ? ' — ' + reasonFa : ''}`, note].filter(Boolean).join(' — ').slice(0, 300);
    const led = L.postInventoryMovement(db, {
      eventType: 'adjustment',
      productId: plan.product_id,
      warehouseId: plan.warehouse_id,
      // P1: the kardex row carries the SKU (inventory_ledger.variant_id) — one document, one SKU.
      variantId: plan.variant_id || undefined,
      qty: delta,
      unitCostRial: delta > 0 ? plan.unit_cost_rial : undefined,
      sourceType: SOURCE,
      sourceId: null,
      date: plan.date,
      note: ledgerNote,
      createdBy: user && user.id,
    });
    if (plan.variant_id) {
      require('./movement').postVariantLayer(db, {
        productId: plan.product_id, variantId: plan.variant_id, warehouseId: plan.warehouse_id,
        qtyDelta: delta, docType: SOURCE, docId: led.id, userId: user && user.id, note: ledgerNote,
        allowNegative: L.allowNegative(db, plan.warehouse_id),
      });
      // P1: a color leaves the live pack only when EVERY size is exactly 0 (see retireZeroStockColors).
      try { require('../product-variants').afterVariantStockWrite(db, plan.product_id); } catch (_) { /* optional */ }
    }
    const signed = (Number(led.qty_in) || 0) > 0 ? Math.round(led.amount_rial) : -Math.round(led.amount_rial);
    let counter = plan.counter_account;
    let approval = null;
    // Closed inventory month: the rial effect waits for approval (counter side parked in clearing).
    if (signed && !plan.periodic && require('./period-lock').isValueLocked(db, plan.date)) {
      const VAP = require('./value-approval');
      const ap = VAP.begin(db, {
        sourceType: SOURCE, sourceId: led.id, date: plan.date, createdBy: user && user.id,
        label: `تعدیل دستی موجودی ${led.tx_no} — ${plan.product_name}${reasonFa ? ' — ' + reasonFa : ''}`,
        note: ledgerNote,
      });
      if (ap.closed) {
        ap.gate({
          productId: plan.product_id, warehouseId: plan.warehouse_id, refQty: 0, deltaRial: -signed,
          ledgerRefId: led.id,
          note: `تعدیل دستی ${led.tx_no} — حساب مقابل: ${plan.counter_account.code} ${plan.counter_account.name}`,
          counterCode: plan.counter_account.code, counterName: plan.counter_account.name,
        });
        counter = { code: ap.clearing.code, name: ap.clearing.name };
        approval = ap.finish();
      }
    }
    const jeId = require('../subledger-recon').postInventoryValueAdjustmentJe(db, {
      warehouseId: plan.warehouse_id,
      amountRial: signed,
      date: plan.date,
      userId: user && user.id,
      sourceType: SOURCE,
      sourceId: led.id,
      description: `تعدیل دستی موجودی ${led.tx_no} — ${plan.product_name}${reasonFa ? ' — ' + reasonFa : ''}${note ? ' — ' + note.slice(0, 120) : ''}`,
      counterCode: counter ? counter.code : undefined,
      counterName: counter ? counter.name : undefined,
    });
    db.prepare('UPDATE inventory_ledger SET source_id=?, je_id=? WHERE id=?').run(led.id, jeId, led.id);
    out = {
      ...led,
      je_id: jeId,
      je_no: voucherNo(db, jeId),
      reason_code: plan.reason_code,
      reason_label: reasonFa,
      mode: plan.mode,
      current_qty: plan.current_qty,
      new_qty: plan.new_qty,
      delta_qty: delta,
      counter_account: approval ? plan.counter_account : (plan.reason_code ? counter : null),
      posted_counter_account: jeId ? counter : null,
      inventory_account: plan.inventory_account,
      stage: plan.stage,
      period_locked: plan.period_locked,
      value_approval: approval ? { id: approval.id, doc_no: approval.doc_no, status: approval.status } : null,
    };
  })();
  return out;
}

/** Close open cost layers born by this inbound adjust (MA path does not consume them on reverse). */
function closeCostLayersForLedger(db, ledgerId) {
  const id = Number(ledgerId) || 0;
  if (!id) return 0;
  try {
    const r = db.prepare(`
      UPDATE inventory_cost_layers
      SET qty_remaining=0, amount_rial=0, status='closed'
      WHERE ledger_id=? AND status='open'
    `).run(id);
    return Number(r.changes) || 0;
  } catch (_) { return 0; }
}

/** R13 full reversal of a manual adjustment ledger row (inside caller transaction). */
function reverseAdjustInTx(db, row, user, { date, note } = {}) {
  const L = require('./ledger');
  const why = String(note || '').trim() || `ابطال تعدیل انبار ${row.tx_no || row.id}`;
  const rev = L.reverseInventoryMovement(db, row.id, { createdBy: user && user.id, date: date || today(), note: why });
  if (String(row.source_type || '') === SOURCE) {
    require('./movement').reverseStockDocument(db, {
      docType: SOURCE, docId: row.id, userId: user && user.id, note: why, applyHeaderStock: false,
    });
    require('./value-approval').cancelForSource(db, SOURCE, row.id, user, why);
    // P1: the reversal put a quantity back on a SKU that was retired meanwhile → bring it back,
    // otherwise the color would vanish from the form/kardex while still holding pieces.
    if (row.variant_id) {
      try {
        const PV = require('../product-variants');
        const v = db.prepare('SELECT * FROM product_variants WHERE id=?').get(row.variant_id);
        if (v && !Number(v.active) && PV.variantCarriesStock(db, v)) PV.reactivateVariant(db, v.id);
      } catch (_) { /* variant tables optional */ }
    }
  }
  if (row.je_id) {
    require('../void-journal').reverseJournalEntry(db, row.je_id, { userId: user && user.id, reason: why });
  }
  // MA inbound opens a layer but reverse OUT does not close it — close by ledger_id, then rebuild buckets.
  if ((Number(row.qty_in) || 0) > 0) closeCostLayersForLedger(db, row.id);
  try {
    require('./valuation').rebuildBuckets(db, { productId: row.product_id });
  } catch (_) { /* valuation optional */ }
  return rev;
}

function listRecent(db, { limit = 50, productId = null, warehouseId = null } = {}) {
  const lim = Math.min(300, Math.max(1, Number(limit) || 50));
  const where = ["l.source_type IN ('inventory_adjust','stock_adjust')", "l.event_type='adjustment'", 'l.reversed_of IS NULL'];
  const params = [];
  if (productId) { where.push('l.product_id=?'); params.push(Number(productId)); }
  if (warehouseId) { where.push('l.warehouse_id=?'); params.push(Number(warehouseId)); }
  const rows = db.prepare(`
    SELECT l.id, l.tx_no, l.date, l.product_id, l.warehouse_id, l.qty_in, l.qty_out, l.unit_cost_rial, l.amount_rial,
      l.status, l.note, l.je_id, l.source_type, l.created_by,
      p.name AS product_name, p.code AS product_code, p.unit AS unit, w.name AS warehouse_name, u.name AS user_name
    FROM inventory_ledger l
    LEFT JOIN products p ON p.id=l.product_id
    LEFT JOIN warehouses w ON w.id=l.warehouse_id
    LEFT JOIN users u ON u.id=l.created_by
    WHERE ${where.join(' AND ')}
    ORDER BY l.id DESC LIMIT ?
  `).all(...params, lim);
  let apprStmt = null;
  try {
    apprStmt = db.prepare(`SELECT id, doc_no, status FROM inventory_value_approvals WHERE source_type=? AND source_id=? ORDER BY id DESC LIMIT 1`);
  } catch (_) { apprStmt = null; }
  return rows.map((r) => ({
    ...r,
    delta_qty: round3((Number(r.qty_in) || 0) - (Number(r.qty_out) || 0)),
    je_no: voucherNo(db, r.je_id),
    value_approval: apprStmt ? (apprStmt.get(SOURCE, r.id) || null) : null,
  }));
}

module.exports = {
  SOURCE,
  canAdjustStock,
  canVoidAdjust,
  canOverrideCost,
  planAdjust,
  postAdjust,
  reverseAdjustInTx,
  closeCostLayersForLedger,
  listRecent,
};
