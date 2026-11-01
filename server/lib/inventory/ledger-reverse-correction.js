'use strict';
/**
 * FR-P334-A — official additive reversal of a kardex alignment row (ابطال اصلاحی).
 *
 * Scope: rows born from an opening / alignment seed with no source document:
 *   opening_inventory — legacy «موجودی اول دوره» seeds (ledger-only, skipStock)
 *   stock_reconcile   — «هم‌ترازی کاردکس» rows (ledger-only, skipStock)
 *   opening           — legacy opening rows tagged with source_type 'opening'
 * = subledger-recon ALIGNMENT_SOURCES. Never: manual rows (MANUAL_SOURCES → POST /ledger/:id/reverse),
 * opening_stock_doc (P2 opening document → its own void), or any document-born source
 * (invoice / purchase / production / warehouse_move / warehouse_transfer / …) → E_REVERSE_VIA_SOURCE.
 *
 * Append-only: original row → status 'reversed', one new reversal row (reversed_of=id). No amount is
 * edited, nothing deleted. Stock effect is explicit:
 *   with_stock  — warehouse_stock (+ products.stock header, + variant×warehouse layer when the row
 *                 carries variant_id) move by the reversal delta; refused (409) if it would go negative.
 *   kardex_only — only the kardex/valuation buckets change; every stock cache stays untouched.
 * A row with je_id never posts a JE here: a voucher_drafts row with the reversing lines is created.
 */
const { MANUAL_SOURCES } = require('../subledger-recon');

const CORRECTION_SOURCES = new Set(['opening_inventory', 'stock_reconcile', 'opening']);
const STOCK_EFFECTS = new Set(['with_stock', 'kardex_only']);
const REASON_MIN = 5;
const JALALI_RE = /^1[3-5]\d{2}\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])$/;
const DOC_TYPE = 'ledger_reverse_correction';
const DRAFT_TAG = 'ledger-reverse-correction';
const LIVE_SQL = `status='posted' AND reversed_of IS NULL
  AND COALESCE(event_type,'') <> 'reversal' AND COALESCE(event_type,'') NOT GLOB '*_reversal'`;

function rcErr(message, status, code, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function round3(n) { return Math.round((Number(n) || 0) * 1000) / 1000; }

function isConfirmed(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

/** Body validation — pure, runs before any DB read/write. */
function validateBody(body) {
  const b = body || {};
  const reason = String(b.reason == null ? '' : b.reason).trim();
  if (reason.length < REASON_MIN) {
    throw rcErr(`علت ابطال اصلاحی الزامی است (حداقل ${REASON_MIN} نویسه)`, 400, 'E_LEDGER_REVERSE_REASON_REQUIRED');
  }
  if (!isConfirmed(b.confirm)) {
    throw rcErr('برای ابطال اصلاحی تأیید صریح (confirm: true) الزامی است', 400, 'E_LEDGER_REVERSE_CONFIRM_REQUIRED');
  }
  const stockEffect = String(b.stock_effect == null ? '' : b.stock_effect).trim();
  if (!STOCK_EFFECTS.has(stockEffect)) {
    throw rcErr('اثر موجودی را صریحاً انتخاب کنید: with_stock (کاهش/افزایش موجودی انبار) یا kardex_only (فقط کاردکس)',
      400, 'E_LEDGER_REVERSE_STOCK_EFFECT_REQUIRED');
  }
  let date = null;
  if (b.date != null && String(b.date).trim() !== '') {
    date = String(b.date).trim();
    if (!JALALI_RE.test(date)) throw rcErr('تاریخ باید به شکل ۱۴۰۵/۰۸/۱۱ باشد', 400, 'E_LEDGER_REVERSE_DATE');
  }
  let variantBreakdown = null;
  if (b.variant_breakdown != null) {
    const arr = Array.isArray(b.variant_breakdown) ? b.variant_breakdown : null;
    const seen = new Set();
    const bad = !arr || !arr.length || arr.some((x) => {
      const vid = Number(x && x.variant_id);
      const q = Number(x && x.qty);
      if (!Number.isInteger(vid) || vid <= 0 || !(q > 0) || seen.has(vid)) return true;
      seen.add(vid);
      return false;
    });
    if (bad) {
      throw rcErr('variant_breakdown باید آرایه‌ای از {variant_id, qty>0} بدون واریانت تکراری باشد', 400, 'E_LEDGER_REVERSE_VARIANT_BREAKDOWN');
    }
    variantBreakdown = arr.map((x) => ({ variant_id: Number(x.variant_id), qty: round3(x.qty) }));
  }
  return { reason, stockEffect, date, variantBreakdown };
}

/**
 * Matrix product + row without variant_id + with_stock → the variant×warehouse layer must move too,
 * so an explicit breakdown summing to |qty_delta| is required (else the layer drifts from warehouse_stock).
 */
function resolveVariantBreakdown(db, plan, breakdown) {
  if (plan.variant_id) {
    if (breakdown) throw rcErr('ردیف خودش واریانت دارد؛ variant_breakdown نفرستید', 400, 'E_LEDGER_REVERSE_VARIANT_BREAKDOWN');
    return null;
  }
  let matrix = false;
  try { matrix = require('./movement').hasActiveMatrixVariants(db, plan.product_id); } catch (_) { matrix = false; }
  if (!matrix) {
    if (breakdown) throw rcErr('کالا رنگ×سایز نیست؛ variant_breakdown لازم نیست', 400, 'E_LEDGER_REVERSE_VARIANT_BREAKDOWN');
    return null;
  }
  if (!breakdown) {
    throw rcErr('کالای رنگ×سایز: برای ابطال با اثر موجودی، توزیع واریانت (variant_breakdown) الزامی است', 409,
      'E_LEDGER_REVERSE_VARIANT_BREAKDOWN_REQUIRED', { product_id: plan.product_id, qty: Math.abs(plan.qty_delta) });
  }
  const sum = round3(breakdown.reduce((a, x) => a + x.qty, 0));
  if (Math.abs(sum - Math.abs(plan.qty_delta)) > 1e-9) {
    throw rcErr(`جمع توزیع واریانت (${sum}) باید برابر تعداد ردیف (${Math.abs(plan.qty_delta)}) باشد`, 409,
      'E_LEDGER_REVERSE_VARIANT_BREAKDOWN_SUM', { sum, qty: Math.abs(plan.qty_delta) });
  }
  const sign = plan.qty_delta < 0 ? -1 : 1;
  return breakdown.map((x) => {
    const v = db.prepare('SELECT id, product_id FROM product_variants WHERE id=?').get(x.variant_id);
    if (!v || Number(v.product_id) !== Number(plan.product_id)) {
      throw rcErr(`واریانت ${x.variant_id} متعلق به این کالا نیست`, 409, 'E_LEDGER_REVERSE_VARIANT_FOREIGN', { variant_id: x.variant_id });
    }
    const before = vwsQty(db, x.variant_id, plan.warehouse_id) || 0;
    const after = round3(before + sign * x.qty);
    if (after < -1e-9) {
      throw rcErr(`موجودی رنگ‌سایز واریانت ${x.variant_id} منفی می‌شود (${after})`, 409, 'E_REVERSE_STOCK_NEGATIVE', {
        variant_id: x.variant_id, available: before, needed: x.qty,
      });
    }
    return { variant_id: x.variant_id, qty_delta: round3(sign * x.qty), before, after };
  });
}

function isReversalRow(row) {
  const et = String(row.event_type || '');
  return row.reversed_of != null || et === 'reversal' || et.endsWith('_reversal');
}

/** Throws the 404/409 that blocks a correction reversal of this row. */
function assertEligible(row) {
  if (!row) throw rcErr('تراکنش انبار یافت نشد', 404, 'E_LEDGER_NOT_FOUND');
  if (String(row.status || '') === 'reversed') {
    throw rcErr('این ردیف کاردکس قبلاً ابطال شده است', 409, 'E_ALREADY_REVERSED', { ledger_id: row.id });
  }
  if (isReversalRow(row)) {
    throw rcErr('ردیف معکوس (برگشتی) قابل ابطال اصلاحی نیست', 409, 'E_REVERSE_OF_REVERSAL', {
      ledger_id: row.id, reversed_of: row.reversed_of,
    });
  }
  if (String(row.status || '') !== 'posted') {
    throw rcErr('فقط ردیف ثبت‌شده قابل ابطال است', 409, 'E_LEDGER_NOT_POSTED', { status: row.status });
  }
  const st = String(row.source_type || '');
  if (!CORRECTION_SOURCES.has(st)) {
    if (MANUAL_SOURCES.has(st)) {
      throw rcErr('این ردیف تعدیل دستی است؛ از ابطال عادی (POST /api/inventory/ledger/:id/reverse) استفاده کنید',
        409, 'E_REVERSE_USE_MANUAL_ROUTE', { source_type: st });
    }
    throw rcErr('برای ابطال این ردیف سند مبدأ را ابطال کنید', 409, 'E_REVERSE_VIA_SOURCE', {
      source_type: st, source_id: row.source_id,
    });
  }
  const qIn = Number(row.qty_in) || 0;
  const qOut = Number(row.qty_out) || 0;
  if (!qIn && !qOut) {
    throw rcErr('ردیف فقط-ارزشی (بدون تعداد) با این مسیر ابطال نمی‌شود', 409, 'E_REVERSE_NOT_QTY_ROW');
  }
}

function valueDeltaOf(row) {
  const qIn = Number(row.qty_in) || 0;
  const qOut = Number(row.qty_out) || 0;
  const amt = Math.round(Number(row.amount_rial) || 0);
  if (qIn > 0) return amt;
  if (qOut > 0) return -amt;
  return amt;
}

function kardexOf(db, productId, warehouseId) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(qty_in,0)-COALESCE(qty_out,0)),0) AS q,
      COALESCE(SUM(CASE WHEN COALESCE(qty_in,0)>0 THEN ROUND(COALESCE(amount_rial,0))
        WHEN COALESCE(qty_out,0)>0 THEN -ROUND(COALESCE(amount_rial,0))
        ELSE ROUND(COALESCE(amount_rial,0)) END),0) AS v
    FROM inventory_ledger
    WHERE product_id=? AND ${warehouseId ? 'warehouse_id=?' : 'warehouse_id IS NULL'} AND (${LIVE_SQL})
  `).get(...(warehouseId ? [productId, warehouseId] : [productId]));
  return { qty: round3(r && r.q), value_rial: Math.round(Number(r && r.v) || 0) };
}

function wsQty(db, productId, warehouseId) {
  if (!warehouseId) return null;
  const r = db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(productId, warehouseId);
  return r ? round3(r.qty) : 0;
}

function vwsQty(db, variantId, warehouseId) {
  if (!variantId || !warehouseId) return null;
  try {
    const r = db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?').get(variantId, warehouseId);
    return r ? round3(r.qty) : 0;
  } catch (_) { return null; }
}

function tableHasColumn(db, table, col) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col); } catch (_) { return false; }
}

/** Reversing lines (rial) of the row's JE, or null when it has no live GL effect. */
function draftPlanFor(db, row) {
  if (!row.je_id) return null;
  const je = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(row.je_id);
  if (!je) return { je_id: row.je_id, je_status: 'missing', lines: [], needed: false };
  const dead = String(je.status || '') === 'reversed' || Number(je.deleted_at || 0) > 0;
  const hasRial = tableHasColumn(db, 'journal_lines', 'debit_rial');
  const lines = db.prepare('SELECT * FROM journal_lines WHERE entry_id=? ORDER BY id').all(je.id).map((l) => {
    const dr = hasRial && Number(l.debit_rial) ? Math.round(Number(l.debit_rial)) : Math.round((Number(l.debit) || 0) * 10);
    const cr = hasRial && Number(l.credit_rial) ? Math.round(Number(l.credit_rial)) : Math.round((Number(l.credit) || 0) * 10);
    return {
      code: l.account_code,
      debit: cr,
      credit: dr,
      description: `برگشت ${l.account_name || l.account_code} — ledger#${row.id}`,
    };
  }).filter((l) => l.debit || l.credit);
  return {
    je_id: je.id, je_status: je.status || null, needed: !dead && lines.length > 0, lines,
    debit_total_rial: lines.reduce((a, l) => a + l.debit, 0),
    credit_total_rial: lines.reduce((a, l) => a + l.credit, 0),
  };
}

/**
 * Read-only plan (preview + in-tx pre-checks). stockEffect null → both effects reported.
 */
function planCorrection(db, ledgerId, { stockEffect = null } = {}) {
  const row = db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(Number(ledgerId) || 0);
  let blocker = null;
  try { assertEligible(row); } catch (e) {
    if (!row) throw e;
    blocker = { status: e.status, code: e.code, error: e.message };
  }
  const productId = Number(row.product_id);
  const warehouseId = row.warehouse_id != null ? Number(row.warehouse_id) : null;
  const qtyDelta = round3(-((Number(row.qty_in) || 0) - (Number(row.qty_out) || 0)));
  const valueDelta = -valueDeltaOf(row);
  const k = kardexOf(db, productId, warehouseId);
  const kAfter = blocker ? k : { qty: round3(k.qty + qtyDelta), value_rial: k.value_rial + valueDelta };
  const ws = wsQty(db, productId, warehouseId);
  const prod = db.prepare('SELECT id, name, code, unit, stock FROM products WHERE id=?').get(productId) || {};
  const headerBefore = round3(prod.stock);
  const variantId = row.variant_id != null && Number(row.variant_id) > 0 ? Number(row.variant_id) : null;
  const vws = vwsQty(db, variantId, warehouseId);
  let matrix = false;
  try { matrix = require('./movement').hasActiveMatrixVariants(db, productId); } catch (_) { matrix = false; }
  const wsAfterWith = ws == null ? null : round3(ws + qtyDelta);
  const vwsAfterWith = vws == null ? null : round3(vws + qtyDelta);
  const withStockOk = warehouseId != null
    && wsAfterWith >= -1e-9
    && (vwsAfterWith == null || vwsAfterWith >= -1e-9);
  const warnings = [];
  if (warehouseId == null) warnings.push('ردیف انبار ندارد؛ فقط حالت «فقط کاردکس» ممکن است');
  if (!withStockOk && warehouseId != null) {
    warnings.push(`با اثر موجودی، موجودی انبار منفی می‌شود (${wsAfterWith}${vwsAfterWith != null ? ` / رنگ‌سایز ${vwsAfterWith}` : ''}) و ثبت رد خواهد شد`);
  }
  if (matrix && !variantId) warnings.push('کالای رنگ×سایز: ردیف واریانت ندارد؛ با اثر موجودی، توزیع واریانت (variant_breakdown) الزامی است');
  let variantLayer = null;
  if (matrix && !variantId && warehouseId != null) {
    try {
      variantLayer = db.prepare(`
        SELECT v.id AS variant_id, COALESCE(s.qty,0) AS qty FROM product_variants v
        LEFT JOIN variant_warehouse_stock s ON s.variant_id=v.id AND s.warehouse_id=?
        WHERE v.product_id=? AND v.active=1 AND COALESCE(v.is_default,0)=0 ORDER BY v.id
      `).all(warehouseId, productId).map((r) => ({ variant_id: r.variant_id, qty: round3(r.qty) }));
    } catch (_) { variantLayer = null; }
  }
  const draft = draftPlanFor(db, row);
  if (draft && draft.needed) warnings.push(`ردیف سند حسابداری دارد (JE#${draft.je_id})؛ سند ثبت نمی‌شود و فقط پیش‌نویس سند برگشت ساخته می‌شود`);
  const out = {
    ledger_id: Number(row.id),
    tx_no: row.tx_no || null,
    date: row.date || '',
    event_type: row.event_type,
    source_type: row.source_type || '',
    product_id: productId,
    product_name: prod.name || '',
    product_code: prod.code || '',
    unit: prod.unit || '',
    warehouse_id: warehouseId,
    variant_id: variantId,
    qty_in: Number(row.qty_in) || 0,
    qty_out: Number(row.qty_out) || 0,
    amount_rial: Math.round(Number(row.amount_rial) || 0),
    je_id: row.je_id || null,
    eligible: !blocker,
    blocker,
    qty_delta: qtyDelta,
    value_delta_rial: valueDelta,
    kardex: { before: k, after: kAfter },
    warehouse_stock: {
      before: ws,
      after_with_stock: blocker ? ws : wsAfterWith,
      after_kardex_only: ws,
    },
    header_stock: {
      before: headerBefore,
      after_with_stock: blocker ? headerBefore : round3(headerBefore + qtyDelta),
      after_kardex_only: headerBefore,
    },
    variant_warehouse_stock: variantId ? {
      before: vws,
      after_with_stock: blocker ? vws : vwsAfterWith,
      after_kardex_only: vws,
    } : null,
    matrix,
    variant_breakdown_required: !!(matrix && !variantId),
    variant_layer_in_warehouse: variantLayer,
    with_stock_allowed: !blocker && withStockOk,
    kardex_only_allowed: !blocker,
    voucher_draft: draft ? {
      will_create: !!draft.needed, je_id: draft.je_id, je_status: draft.je_status, lines: draft.lines,
    } : null,
    warnings,
  };
  if (stockEffect && STOCK_EFFECTS.has(stockEffect)) {
    out.stock_effect = stockEffect;
    out.warehouse_stock.after = stockEffect === 'with_stock' ? out.warehouse_stock.after_with_stock : ws;
    out.ready = stockEffect === 'with_stock' ? out.with_stock_allowed : out.kardex_only_allowed;
  }
  return { plan: out, row, draft };
}

function applyStockEffect(db, { row, plan, user, reversalId, note, variantPlan }) {
  const productId = plan.product_id;
  const warehouseId = plan.warehouse_id;
  const delta = plan.qty_delta;
  db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,0)').run(productId, warehouseId);
  const wsBefore = wsQty(db, productId, warehouseId);
  const wsAfter = round3(wsBefore + delta);
  if (wsAfter < -1e-9) {
    throw rcErr(`موجودی انبار منفی می‌شود (${wsAfter})`, 409, 'E_REVERSE_STOCK_NEGATIVE', {
      warehouse_id: warehouseId, available: wsBefore, needed: Math.abs(delta),
    });
  }
  db.prepare('UPDATE warehouse_stock SET qty=? WHERE product_id=? AND warehouse_id=?').run(wsAfter, productId, warehouseId);
  const p = db.prepare('SELECT stock FROM products WHERE id=?').get(productId);
  db.prepare('UPDATE products SET stock=? WHERE id=?').run(round3((Number(p && p.stock) || 0) + delta), productId);
  try {
    db.prepare('INSERT INTO stock_logs (product_id, user_id, change, note) VALUES (?,?,?,?)')
      .run(productId, (user && user.id) || 0, delta, note);
  } catch (_) { /* legacy stock_logs optional */ }
  if (plan.variant_id) {
    require('./movement').postVariantLayer(db, {
      productId, variantId: plan.variant_id, warehouseId, qtyDelta: delta,
      docType: DOC_TYPE, docId: reversalId, docLine: 0, userId: user && user.id, note, allowNegative: false,
    });
  }
  (variantPlan || []).forEach((v, i) => {
    require('./movement').postVariantLayer(db, {
      productId, variantId: v.variant_id, warehouseId, qtyDelta: v.qty_delta,
      docType: DOC_TYPE, docId: reversalId, docLine: i + 1, userId: user && user.id, note, allowNegative: false,
    });
  });
  return { before: wsBefore, after: wsAfter };
}

/**
 * Execute (own transaction). Body is validated BEFORE any read/write.
 * @returns response payload
 */
function reverseCorrection(db, ledgerId, body, user, { audit } = {}) {
  const { reason, stockEffect, date, variantBreakdown } = validateBody(body);
  let out;
  db.transaction(() => {
    const { plan, row, draft } = planCorrection(db, ledgerId, { stockEffect });
    if (plan.blocker) throw rcErr(plan.blocker.error, plan.blocker.status, plan.blocker.code, { ledger_id: plan.ledger_id });
    let variantPlan = null;
    if (stockEffect === 'with_stock' && plan.warehouse_id != null) {
      variantPlan = resolveVariantBreakdown(db, plan, variantBreakdown);
    } else if (variantBreakdown) {
      throw rcErr('variant_breakdown فقط با with_stock معنا دارد', 400, 'E_LEDGER_REVERSE_VARIANT_BREAKDOWN');
    }
    if (stockEffect === 'with_stock' && !plan.with_stock_allowed) {
      if (plan.warehouse_id == null) {
        throw rcErr('ردیف انبار ندارد؛ فقط «فقط کاردکس» ممکن است', 409, 'E_REVERSE_NO_WAREHOUSE');
      }
      throw rcErr(`ابطال با اثر موجودی، موجودی انبار را منفی می‌کند (${plan.warehouse_stock.after_with_stock})`, 409,
        'E_REVERSE_STOCK_NEGATIVE', {
          warehouse_id: plan.warehouse_id,
          available: plan.warehouse_stock.before,
          needed: Math.abs(plan.qty_delta),
        });
    }
    const revDate = date || require('../../jalali').todayJalali();
    const note = `ابطال اصلاحی ${row.tx_no || ('#' + row.id)} (${stockEffect === 'with_stock' ? 'با اثر موجودی' : 'فقط کاردکس'}) — ${reason}`.slice(0, 300);
    const rev = require('./ledger').reverseInventoryMovement(db, row.id, {
      createdBy: user && user.id, date: revDate, note, skipStock: true,
    });
    let ws = { before: plan.warehouse_stock.before, after: plan.warehouse_stock.before };
    if (stockEffect === 'with_stock') {
      ws = applyStockEffect(db, { row, plan, user, reversalId: Number(rev.id), note, variantPlan });
    }
    let draftId = null;
    if (draft && draft.needed) {
      const desc = `[${DRAFT_TAG}:ledger#${row.id}] برگشت JE#${draft.je_id} — ابطال اصلاحی ردیف کاردکس ${row.tx_no || ('#' + row.id)} — علت: ${reason}`.slice(0, 500);
      draftId = Number(db.prepare(`
        INSERT INTO voucher_drafts (date, description, lines_json, cost_center_id, created_by) VALUES (?,?,?,?,?)
      `).run(revDate, desc, JSON.stringify(draft.lines), null, (user && user.id) || null).lastInsertRowid);
    }
    const kAfter = kardexOf(db, plan.product_id, plan.warehouse_id);
    out = {
      ok: true,
      ledger_id: plan.ledger_id,
      reversal_id: Number(rev.id),
      reversal_tx_no: rev.tx_no,
      stock_effect: stockEffect,
      reason,
      product_id: plan.product_id,
      warehouse_id: plan.warehouse_id,
      qty_delta: plan.qty_delta,
      value_delta_rial: plan.value_delta_rial,
      kardex: { before: plan.kardex.before, after: kAfter },
      warehouse_stock: ws,
      variant_breakdown: variantPlan,
      je_id: plan.je_id,
      je_posted: false,
      voucher_draft_id: draftId,
    };
    if (typeof audit === 'function') {
      audit((user && user.id) || null, 'ledger_reverse_correction', 'inventory_ledger', plan.ledger_id, JSON.stringify({
        reason,
        stock_effect: stockEffect,
        qty: plan.qty_in || plan.qty_out,
        qty_delta: plan.qty_delta,
        amount_rial: plan.amount_rial,
        value_delta_rial: plan.value_delta_rial,
        source_type: plan.source_type,
        product_id: plan.product_id,
        warehouse_id: plan.warehouse_id,
        reversal_id: out.reversal_id,
        warehouse_stock_before: ws.before,
        warehouse_stock_after: ws.after,
        variant_breakdown: variantPlan,
        kardex_before: plan.kardex.before,
        kardex_after: kAfter,
        je_id: plan.je_id,
        voucher_draft_id: draftId,
        confirm: true,
      }));
    }
  })();
  return out;
}

module.exports = {
  CORRECTION_SOURCES,
  STOCK_EFFECTS,
  REASON_MIN,
  DRAFT_TAG,
  validateBody,
  assertEligible,
  planCorrection,
  reverseCorrection,
  kardexOf,
};
