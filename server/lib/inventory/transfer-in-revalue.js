'use strict';
/**
 * audit-kardex K1 — اصلاح ارزش ورود انتقال (transfer_in با مبلغ صفر).
 *
 * Defect: heal-zero-outbound-cost-v529 re-priced zero transfer_out rows but left the paired
 * transfer_in at 0 ⇒ the destination warehouse kardex is short by out.amount (GL unchanged:
 * same-COA transfers post no JE).
 *
 * Correction (append-only, never UPDATE): one value-only row (qty 0) per leaked in-row in the
 * destination warehouse, event_type `transfer_in_revalue`, source_type/source_id = the transfer move,
 * amount = out.amount − in.amount. Pairing key: same source_type='warehouse_transfer', source_id
 * (warehouse_moves.id), product_id, out.qty_out = in.qty_in. Idempotency key: a live
 * `transfer_in_revalue` row on (source_type, source_id, product_id, destination warehouse).
 *
 * Value effects:
 *  - kardex Σ amount of the destination warehouse rises by exactly the missing amount.
 *  - destination valuation bucket: follows the row like every ledger row (applyLedgerRowToBuckets
 *    → stValue), so incremental == rebuildBuckets replay.
 *  - product header average: NOT touched (applyValue:false). A transfer is header-neutral at
 *    creation (both legs updateAvg:false) and the v529 heal never moved the header. No
 *    value_applied record is written on purpose: reversing this row (void of the transfer) then
 *    gives back the full amount from the header, which offsets the transfer_out reversal re-adding
 *    out.amount — so the void stays header-neutral.
 *  - GL: none. A pair whose warehouses map to different inventory accounts is excluded
 *    (`coa_mismatch`) — that one would need a reclass JE and is never posted silently.
 *
 * zero_zero (opt-in, `includeZeroZero` / `include_zero_zero`):
 * both legs are amount 0, so there is no outbound amount to copy. The official value is
 * qty × the source warehouse's average cost as of the transfer date. Rule `asof_live_ledger`
 * (not the current valuation bucket — that pool includes movements after the transfer):
 *   unit = Σ signed value / Σ signed qty of LIVE rows of (product, source warehouse)
 *   whose effective date is ≤ the transfer date.
 * Signed value matches kardexValueOfWarehouse (inbound +, outbound −, value-only = amount).
 * Back-dated openings count via their `date`, not `created_at`. The outbound leg itself is
 * excluded so a zero amount does not dilute the pre-outbound average. A `transfer_*_revalue`
 * row counts from the paired transfer's date even when the row itself is dated later, and
 * pairs priced earlier in the same plan are applied as virtual value rows so a chain stays
 * at one average. Same-COA pairs post two value-only rows in the caller's transaction:
 * `transfer_out_revalue` (negative, source) and `transfer_in_revalue` (positive, destination).
 * Header average is not moved (applyValue:false). GL effect stays 0. Default callers
 * (preview/POST without the flag) still exclude these pairs as `zero_zero`.
 */
const EVENT_TYPE = 'transfer_in_revalue';
const EVENT_OUT = 'transfer_out_revalue';
const SOURCE_TYPE = 'warehouse_transfer';
const NOTE_TAG = 'revalue-transfer-in';
const NOTE_TAG_OUT = 'revalue-transfer-out';
const COST_RULE = 'asof_live_ledger';
const REASON_MIN = 10;
const JALALI_RE = /^1[3-5]\d{2}\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])$/;
const LIVE_SQL = `status='posted' AND reversed_of IS NULL
  AND COALESCE(event_type,'') <> 'reversal' AND COALESCE(event_type,'') NOT GLOB '*_reversal'`;

const EXCLUDE_REASONS_FA = {
  zero_zero: 'خروج انتقال مبلغ مثبت ندارد؛ بدون include_zero_zero اصلاح نمی‌شود و خروج منفی هرگز خودکار نیست',
  no_source_cost: 'بهای میانگین انبار مبدأ تا تاریخ انتقال صفر یا ناموجود است — خودکار ثبت نمی‌شود',
  ambiguous_variant: 'واریانت ردیف انتقال یکتا نیست — خودکار ثبت نمی‌شود',
  partial_revalue: 'فقط یک طرف اصلاح ارزش ثبت شده است — تکمیل خودکار نمی‌شود',
  reversed: 'ردیف انتقال (خروج یا ورود) ابطال شده است',
  coa_mismatch: 'حساب موجودی انبار مبدأ و مقصد متفاوت است — نیاز به سند جابه‌جایی؛ خودکار ثبت نمی‌شود',
  already_corrected: 'قبلاً اصلاح شده است',
  missing_pair: 'ردیف خروج جفت این ورود پیدا نشد',
  not_candidate: 'ردیف ورود انتقال با مبلغ صفر نیست',
};

/**
 * Σ live corrections for the transfer_in row aliased `alias` (reports: corrected ⇔ in + Σ = out).
 * dateParam: adds one `?` bind (cutoff date, inclusive).
 */
function correctionSumSql(alias, { dateParam = false } = {}) {
  const a = alias || 'i';
  return `(SELECT COALESCE(SUM(c.amount_rial),0) FROM inventory_ledger c
    WHERE c.event_type='${EVENT_TYPE}' AND c.status='posted' AND c.reversed_of IS NULL
      ${dateParam ? "AND COALESCE(c.date,'') <= ?" : ''}
      AND c.source_type=${a}.source_type AND c.source_id=${a}.source_id
      AND c.product_id=${a}.product_id AND c.warehouse_id=${a}.warehouse_id)`;
}

function rvErr(message, status, code, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function isConfirmed(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

function parseIds(raw) {
  if (raw == null || raw === '') return null;
  const arr = Array.isArray(raw) ? raw : String(raw).split(/[,;\s]+/).filter(Boolean);
  const ids = arr.map((x) => Number(x));
  if (!ids.length || ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw rvErr('ids باید فهرست شناسه‌های ردیف ورود انتقال (عدد صحیح مثبت) باشد', 400, 'E_REVALUE_IDS');
  }
  return [...new Set(ids)];
}

/** Filters shared by GET (query) and POST (body). Pure — no DB access. */
function parseFilters(src) {
  const s = src || {};
  let warehouseId = null;
  if (s.warehouse_id != null && String(s.warehouse_id).trim() !== '') {
    warehouseId = Number(s.warehouse_id);
    if (!Number.isInteger(warehouseId) || warehouseId <= 0) {
      throw rvErr('شناسهٔ انبار نامعتبر است', 400, 'E_REVALUE_WAREHOUSE');
    }
  }
  let date = null;
  if (s.date != null && String(s.date).trim() !== '') {
    date = String(s.date).trim();
    if (!JALALI_RE.test(date)) throw rvErr('تاریخ باید به شکل ۱۴۰۵/۰۸/۱۲ باشد', 400, 'E_REVALUE_DATE');
  }
  return { warehouseId, ids: parseIds(s.ids), date, includeZeroZero: isConfirmed(s.include_zero_zero) || isConfirmed(s.includeZeroZero) };
}

/** POST body validation — runs before any DB read/write. */
function validateBody(body) {
  const b = body || {};
  if (!isConfirmed(b.confirm)) {
    throw rvErr('برای اصلاح ارزش ورود انتقال تأیید صریح (confirm: true) الزامی است', 400, 'E_REVALUE_CONFIRM_REQUIRED');
  }
  const reason = String(b.reason == null ? '' : b.reason).trim();
  if (reason.length < REASON_MIN) {
    throw rvErr(`علت اصلاح الزامی است (حداقل ${REASON_MIN} نویسه)`, 400, 'E_REVALUE_REASON_REQUIRED');
  }
  return { reason, ...parseFilters(b) };
}

function kardexValueOfWarehouse(db, warehouseId) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN COALESCE(qty_in,0)>0 THEN ROUND(COALESCE(amount_rial,0))
      WHEN COALESCE(qty_out,0)>0 THEN -ROUND(COALESCE(amount_rial,0))
      ELSE ROUND(COALESCE(amount_rial,0)) END),0) AS v
    FROM inventory_ledger WHERE warehouse_id=? AND (${LIVE_SQL})
  `).get(warehouseId);
  return Math.round(Number(r && r.v) || 0);
}

function invCode(db, warehouseId) {
  try {
    const a = require('./ledger').inventoryAccountForWarehouse(db, warehouseId, { readOnly: true });
    return (a && a.code) || null;
  } catch (_) { return null; }
}

function whName(db, id) {
  try { return (db.prepare('SELECT name FROM warehouses WHERE id=?').get(id) || {}).name || ''; } catch (_) { return ''; }
}

function findOutPair(db, inRow) {
  if (inRow.source_id == null) return null;
  return db.prepare(`
    SELECT * FROM inventory_ledger
    WHERE event_type='transfer_out' AND source_type=? AND source_id=? AND product_id=?
      AND reversed_of IS NULL AND ABS(COALESCE(qty_out,0) - ?) < 1e-9
    ORDER BY (id = ?) DESC, id LIMIT 1
  `).get(inRow.source_type, inRow.source_id, inRow.product_id, Number(inRow.qty_in) || 0, Number(inRow.id) - 1) || null;
}

function liveCorrections(db, inRow) {
  return liveEventCorrections(db, EVENT_TYPE, inRow, inRow.warehouse_id);
}

function liveEventCorrections(db, eventType, row, warehouseId) {
  if (!row || row.source_id == null || warehouseId == null) return [];
  return db.prepare(`
    SELECT id, amount_rial FROM inventory_ledger
    WHERE event_type=? AND status='posted' AND reversed_of IS NULL
      AND source_type=? AND source_id=? AND product_id=? AND warehouse_id=?
    ORDER BY id
  `).all(eventType, row.source_type, row.source_id, row.product_id, warehouseId);
}

function positiveVariant(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Leg variant, else the single movement variant on wh_transfer_out/in for the move. */
function resolveTransferVariant(db, inRow, out) {
  const a = positiveVariant(inRow && inRow.variant_id);
  const b = positiveVariant(out && out.variant_id);
  if (a && b && a !== b) return { variant_id: null, ambiguous: true };
  if (a || b) return { variant_id: a || b, ambiguous: false };
  if (!inRow || inRow.source_id == null) return { variant_id: null, ambiguous: false };
  let movs = [];
  try {
    movs = db.prepare(`
      SELECT DISTINCT variant_id FROM inventory_movements
      WHERE product_id=? AND doc_id=? AND doc_type IN ('wh_transfer_out','wh_transfer_in')
        AND variant_id IS NOT NULL AND variant_id > 0
    `).all(inRow.product_id, inRow.source_id);
  } catch (_) { movs = []; }
  const ids = [...new Set(movs.map((m) => Number(m.variant_id)))];
  if (ids.length === 1) return { variant_id: ids[0], ambiguous: false };
  if (ids.length > 1) return { variant_id: null, ambiguous: true };
  return { variant_id: null, ambiguous: false };
}

function signedLedgerValue(r) {
  const amt = Math.round(Number(r.amount_rial) || 0);
  if ((Number(r.qty_in) || 0) > 0) return amt;
  if ((Number(r.qty_out) || 0) > 0) return -amt;
  return amt;
}

const REVALUE_EVENTS = new Set([EVENT_TYPE, EVENT_OUT]);

function transferDateOf(db, sourceId, dateCache) {
  const k = String(sourceId);
  if (dateCache && dateCache.has(k)) return dateCache.get(k);
  const t = db.prepare(`
    SELECT date FROM inventory_ledger
    WHERE source_type=? AND source_id=? AND event_type='transfer_out' AND reversed_of IS NULL
    ORDER BY id LIMIT 1
  `).get(SOURCE_TYPE, sourceId);
  const d = t && t.date ? String(t.date) : '';
  if (dateCache) dateCache.set(k, d);
  return d;
}

/** Effective date: revalue rows count from the paired transfer date when that is earlier. */
function effectiveDate(db, row, dateCache) {
  const own = String(row.date || '');
  if (!REVALUE_EVENTS.has(String(row.event_type || '')) || row.source_id == null) return own;
  const td = transferDateOf(db, row.source_id, dateCache);
  if (td && (!own || td < own)) return td;
  return own;
}

/**
 * Source-warehouse average as of a transfer. See the file header (rule asof_live_ledger).
 * @returns {{ qty:number, value_rial:number, unit_rial:number }}
 */
function sourceAvgAsOf(db, { productId, warehouseId, asOfDate, excludeIds, virtualRows, rowCache, dateCache }) {
  const asOf = String(asOfDate || '');
  const excl = excludeIds || new Set();
  const key = `${productId}:${warehouseId}`;
  let rows = rowCache && rowCache.get(key);
  if (!rows) {
    rows = db.prepare(`
      SELECT id, event_type, source_type, source_id, date, qty_in, qty_out, amount_rial
      FROM inventory_ledger
      WHERE product_id=? AND warehouse_id=? AND (${LIVE_SQL})
    `).all(productId, warehouseId);
    if (rowCache) rowCache.set(key, rows);
  }
  let qty = 0;
  let value = 0;
  for (const r of rows) {
    if (excl.has(Number(r.id))) continue;
    const d = effectiveDate(db, r, dateCache);
    if (d && d > asOf) continue;
    qty += (Number(r.qty_in) || 0) - (Number(r.qty_out) || 0);
    value += signedLedgerValue(r);
  }
  for (const v of virtualRows || []) {
    if (Number(v.product_id) !== Number(productId) || Number(v.warehouse_id) !== Number(warehouseId)) continue;
    if (String(v.date || '') > asOf) continue;
    value += Math.round(Number(v.amount_rial) || 0);
  }
  qty = Math.round(qty * 1000) / 1000;
  value = Math.round(value);
  if (!(qty > 1e-9) || !(value > 0)) return { qty, value_rial: value, unit_rial: 0 };
  return { qty, value_rial: value, unit_rial: Math.max(0, Math.round(value / qty)) };
}

function writeAudit(db, userId, action, entity, entityId, detail) {
  try {
    db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)')
      .run(userId || null, action, entity || 'inventory_ledger', entityId || null, String(detail || '').slice(0, 4000));
  } catch (_) { /* audit table optional in tiny fixtures */ }
}

/**
 * Read-only plan shared by preview and POST (POST recomputes it inside its transaction).
 * @returns {{ candidates, excluded, per_warehouse, totals, blocker, date, ... }}
 */
function computePlan(db, { warehouseId = null, ids = null, date = null, productIds = null, includeZeroZero = false } = {}) {
  const corrDate = date || require('../../jalali').todayJalali();
  const where = [`i.event_type='transfer_in'`, `i.source_type=?`, `i.reversed_of IS NULL`];
  const params = [SOURCE_TYPE];
  if (warehouseId) { where.push('i.warehouse_id=?'); params.push(warehouseId); }
  if (ids && ids.length) { where.push(`i.id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); }
  if (productIds && productIds.length) {
    where.push(`i.product_id IN (${productIds.map(() => '?').join(',')})`);
    params.push(...productIds);
  }
  // Scope = the known defect only: zero-valued inbound legs. A non-zero in ≠ out (closed-month
  // pool park, v525) is legitimate and never touched here.
  const scanned = db.prepare(`
    SELECT i.* FROM inventory_ledger i
    WHERE ${where.join(' AND ')} AND COALESCE(i.amount_rial,0)=0
    ORDER BY i.id
  `).all(...params);

  const candidates = [];
  const excluded = [];
  const seen = new Set();
  const zeroQueue = [];
  const rowCache = new Map();
  const dateCache = new Map();
  const virtualRows = [];
  for (const inRow of scanned) {
    seen.add(Number(inRow.id));
    const out = findOutPair(db, inRow);
    const base = {
      in_id: Number(inRow.id),
      out_id: out ? Number(out.id) : null,
      move_id: inRow.source_id != null ? Number(inRow.source_id) : null,
      product_id: Number(inRow.product_id),
      variant_id: inRow.variant_id != null && Number(inRow.variant_id) > 0 ? Number(inRow.variant_id) : null,
      from_warehouse_id: out && out.warehouse_id != null ? Number(out.warehouse_id) : null,
      to_warehouse_id: inRow.warehouse_id != null ? Number(inRow.warehouse_id) : null,
      qty: Number(inRow.qty_in) || 0,
      transfer_date: inRow.date || '',
      out_amount_rial: out ? Math.round(Number(out.amount_rial) || 0) : 0,
      in_amount_rial: Math.round(Number(inRow.amount_rial) || 0),
    };
    const exclude = (reason, extra) => excluded.push({ ...base, ...(extra || {}), reason, reason_fa: EXCLUDE_REASONS_FA[reason] });
    if (!out || base.to_warehouse_id == null) { exclude('missing_pair'); continue; }
    if (String(inRow.status) !== 'posted' || String(out.status) !== 'posted') { exclude('reversed'); continue; }
    if (base.out_amount_rial <= 0) {
      // Default API: both-zero (and any non-positive out) stays excluded. Opt-in prices
      // only the exact zero/zero pair; a negative outbound is still not a candidate.
      if (!includeZeroZero || base.out_amount_rial < 0 || base.in_amount_rial !== 0) {
        exclude('zero_zero');
        continue;
      }
      const inCorr = liveCorrections(db, inRow);
      const outCorr = liveEventCorrections(db, EVENT_OUT, out, base.from_warehouse_id);
      if (inCorr.length && outCorr.length) {
        exclude('already_corrected', {
          correction_ids: [...outCorr, ...inCorr].map((c) => Number(c.id)),
          corrected_rial: inCorr.reduce((s, c) => s + Math.round(Number(c.amount_rial) || 0), 0),
        });
        continue;
      }
      if (inCorr.length || outCorr.length) {
        exclude('partial_revalue', {
          correction_ids: [...outCorr, ...inCorr].map((c) => Number(c.id)),
        });
        continue;
      }
      zeroQueue.push({ inRow, out, base, exclude });
      continue;
    }
    const corr = liveCorrections(db, inRow);
    if (corr.length) {
      exclude('already_corrected', {
        correction_ids: corr.map((c) => Number(c.id)),
        corrected_rial: corr.reduce((s, c) => s + Math.round(Number(c.amount_rial) || 0), 0),
      });
      continue;
    }
    const fromCode = invCode(db, base.from_warehouse_id);
    const toCode = invCode(db, base.to_warehouse_id);
    if (!fromCode || !toCode || fromCode !== toCode) {
      exclude('coa_mismatch', { from_coa: fromCode, to_coa: toCode });
      continue;
    }
    candidates.push({
      ...base, kind: 'inbound_leak', inventory_coa: toCode, delta_rial: base.out_amount_rial - base.in_amount_rial,
    });
  }
  zeroQueue.sort((a, b) => String(a.base.transfer_date).localeCompare(String(b.base.transfer_date)) || a.base.out_id - b.base.out_id);
  for (const item of zeroQueue) {
    const { inRow, out, base, exclude } = item;
    const variant = resolveTransferVariant(db, inRow, out);
    if (variant.ambiguous) { exclude('ambiguous_variant'); continue; }
    base.variant_id = variant.variant_id;
    const avg = sourceAvgAsOf(db, {
      productId: base.product_id,
      warehouseId: base.from_warehouse_id,
      asOfDate: base.transfer_date,
      excludeIds: new Set([base.out_id]),
      virtualRows,
      rowCache,
      dateCache,
    });
    const delta = avg.unit_rial > 0 && base.qty > 0
      ? Math.round(avg.value_rial * base.qty / avg.qty)
      : 0;
    if (!(delta > 0)) {
      exclude('no_source_cost', { source_qty: avg.qty, source_value_rial: avg.value_rial, rule: COST_RULE });
      continue;
    }
    const fromCode = invCode(db, base.from_warehouse_id);
    const toCode = invCode(db, base.to_warehouse_id);
    if (!fromCode || !toCode || fromCode !== toCode) {
      exclude('coa_mismatch', { from_coa: fromCode, to_coa: toCode });
      continue;
    }
    virtualRows.push(
      { product_id: base.product_id, warehouse_id: base.from_warehouse_id, date: base.transfer_date, amount_rial: -delta },
      { product_id: base.product_id, warehouse_id: base.to_warehouse_id, date: base.transfer_date, amount_rial: delta },
    );
    candidates.push({
      ...base,
      kind: 'zero_zero',
      inventory_coa: toCode,
      delta_rial: delta,
      unit_rial: avg.unit_rial,
      source_qty: avg.qty,
      source_value_rial: avg.value_rial,
      rule: COST_RULE,
    });
  }
  if (ids && ids.length) {
    for (const id of ids) {
      if (seen.has(id)) continue;
      excluded.push({ in_id: id, reason: 'not_candidate', reason_fa: EXCLUDE_REASONS_FA.not_candidate });
    }
  }

  const whMap = new Map();
  const addWh = (id, delta) => {
    if (id == null) return;
    if (!whMap.has(id)) whMap.set(id, { warehouse_id: id, warehouse_name: whName(db, id), count: 0, amount_rial: 0 });
    const w = whMap.get(id);
    w.count += 1;
    w.amount_rial += delta;
  };
  for (const c of candidates) {
    if (c.kind === 'zero_zero') {
      addWh(c.from_warehouse_id, -c.delta_rial);
      addWh(c.to_warehouse_id, c.delta_rial);
    } else {
      addWh(c.to_warehouse_id, c.delta_rial);
    }
  }
  const per_warehouse = [...whMap.values()].sort((a, b) => a.warehouse_id - b.warehouse_id).map((w) => {
    const before = kardexValueOfWarehouse(db, w.warehouse_id);
    return { ...w, kardex_before_rial: before, kardex_after_rial: before + w.amount_rial };
  });
  const excluded_summary = {};
  for (const e of excluded) excluded_summary[e.reason] = (excluded_summary[e.reason] || 0) + 1;

  let blocker = null;
  if (candidates.length && require('./period-lock').isValueLocked(db, corrDate)) {
    blocker = {
      status: 422,
      code: 'E_INV_PERIOD_LOCKED',
      error: `ماه ${corrDate.slice(0, 7)} در ارزش‌گذاری موجودی قفل است؛ تاریخ اصلاح را در ماه باز بگذارید یا مدیر ماه را باز کند`,
      period: corrDate.slice(0, 7),
    };
  }
  return {
    date: corrDate,
    event_type: EVENT_TYPE,
    candidates,
    excluded,
    excluded_summary,
    per_warehouse,
    totals: { count: candidates.length, amount_rial: candidates.reduce((s, c) => s + c.delta_rial, 0) },
    gl_effect_rial: 0,
    je: null,
    blocker,
    ready: !blocker && candidates.length > 0,
  };
}

function preview(db, query) {
  const f = parseFilters(query);
  return { dry_run: true, writes: 0, ...computePlan(db, f) };
}

/**
 * Post corrections for a plan inside the caller's transaction (route + heal script share this).
 * Explicit `ids` that are not eligible (other than already corrected) refuse the whole batch.
 */
function postValueRow(db, L, { eventType, candidate: c, warehouseId, amountRial, note, date, userId }) {
  return L.postInventoryMovement(db, {
    eventType,
    productId: c.product_id,
    warehouseId,
    qtyIn: 0,
    qtyOut: 0,
    unitCostRial: amountRial < 0 ? -Math.abs(c.unit_rial || amountRial) : (c.unit_rial || amountRial),
    amountRial,
    sourceType: SOURCE_TYPE,
    sourceId: c.move_id,
    variantId: c.variant_id,
    date,
    note,
    createdBy: userId,
    updateAvg: false,
    skipStock: true,
    valueOnly: true,
    applyValue: false,
  });
}

function applyInTx(db, { warehouseId = null, ids = null, date = null, productIds = null, includeZeroZero = false, reason, user }) {
  const plan = computePlan(db, { warehouseId, ids, date, productIds, includeZeroZero });
  if (plan.blocker) throw rvErr(plan.blocker.error, plan.blocker.status, plan.blocker.code, { period: plan.blocker.period });
  if (ids && ids.length) {
    const bad = plan.excluded.filter((e) => e.reason !== 'already_corrected');
    if (bad.length) {
      throw rvErr(`ردیف‌های ${bad.map((b) => '#' + b.in_id).join('، ')} قابل اصلاح نیستند (${[...new Set(bad.map((b) => b.reason_fa))].join('؛ ')})`,
        409, 'E_REVALUE_ROW_NOT_ELIGIBLE', { rows: bad.map((b) => ({ in_id: b.in_id, reason: b.reason })) });
    }
  }
  const L = require('./ledger');
  const userId = (user && user.id) || null;
  const rows = plan.candidates.map((c) => {
    if (c.kind === 'zero_zero') {
      const noteOut = `[${NOTE_TAG_OUT}:ledger#${c.out_id}] اصلاح ارزش خروج انتقال صفر (جفت ورود ledger#${c.in_id}) — ${reason}`.slice(0, 300);
      const noteIn = `[${NOTE_TAG}:ledger#${c.in_id}] اصلاح ارزش ورود انتقال صفر (جفت خروج ledger#${c.out_id}) — ${reason}`.slice(0, 300);
      const outLed = postValueRow(db, L, {
        eventType: EVENT_OUT, candidate: c, warehouseId: c.from_warehouse_id,
        amountRial: -c.delta_rial, note: noteOut, date: plan.date, userId,
      });
      const inLed = postValueRow(db, L, {
        eventType: EVENT_TYPE, candidate: c, warehouseId: c.to_warehouse_id,
        amountRial: c.delta_rial, note: noteIn, date: plan.date, userId,
      });
      return {
        ...c,
        correction_id: Number(inLed.id),
        out_correction_id: Number(outLed.id),
        correction_tx_no: inLed.tx_no,
      };
    }
    const note = `[${NOTE_TAG}:ledger#${c.in_id}] اصلاح ارزش ورود انتقال (جفت خروج ledger#${c.out_id}) — ${reason}`.slice(0, 300);
    const led = postValueRow(db, L, {
      eventType: EVENT_TYPE, candidate: c, warehouseId: c.to_warehouse_id,
      amountRial: c.delta_rial, note, date: plan.date, userId,
    });
    return { ...c, correction_id: Number(led.id), correction_tx_no: led.tx_no };
  });
  const per_warehouse = plan.per_warehouse.map((w) => ({ ...w, kardex_after_rial: kardexValueOfWarehouse(db, w.warehouse_id) }));
  return { plan, rows, per_warehouse };
}

/** POST handler body: validate (400, no DB access) → one transaction → audit. */
function revalue(db, body, user, { audit } = {}) {
  const v = validateBody(body);
  let out;
  db.transaction(() => {
    const { plan, rows, per_warehouse } = applyInTx(db, { ...v, user });
    out = {
      ok: true,
      date: plan.date,
      event_type: EVENT_TYPE,
      reason: v.reason,
      created: rows.length,
      noop: rows.length === 0,
      rows,
      excluded: plan.excluded,
      excluded_summary: plan.excluded_summary,
      per_warehouse,
      totals: plan.totals,
      gl_effect_rial: 0,
      je: null,
    };
    if (rows.length && typeof audit === 'function') {
      audit((user && user.id) || null, 'ledger_revalue_transfer_in', 'inventory_ledger', null, JSON.stringify({
        reason: v.reason,
        date: plan.date,
        filters: { warehouse_id: v.warehouseId, ids: v.ids },
        in_ids: rows.map((r) => r.in_id),
        correction_ids: rows.map((r) => r.correction_id),
        totals: plan.totals,
        per_warehouse: per_warehouse.map((w) => ({
          warehouse_id: w.warehouse_id, count: w.count, amount_rial: w.amount_rial,
          kardex_before_rial: w.kardex_before_rial, kardex_after_rial: w.kardex_after_rial,
        })),
        excluded_summary: plan.excluded_summary,
        gl_effect_rial: 0,
        confirm: true,
      }));
    }
  })();
  return out;
}

/**
 * After a back-dated opening lands in `warehouseId`, price zero/zero transfers that left
 * that warehouse on or after the opening date. Period lock does not throw — the opening
 * stays posted and the caller gets a pending note (also written to audit_log).
 * Must run inside the caller's transaction, after the opening ledger row is inserted.
 */
function revalueTransfersAfterBackdatedInbound(db, { productId, warehouseId, date, user, reason } = {}) {
  const pid = Number(productId) || 0;
  const wh = Number(warehouseId) || 0;
  const openingDate = String(date || '');
  const corrDate = require('../../jalali').todayJalali();
  const why = String(reason || 'افتتاحیهٔ معوق — اصلاح ارزش انتقال صفر').trim();
  const base = { ok: true, pending: false, posted: 0, note: null, rows: [], excluded: [] };
  if (!pid || !wh) return base;
  const PL = require('./period-lock');
  if (PL.isValueLocked(db, corrDate)) {
    const note = `ماه ${corrDate.slice(0, 7)} در ارزش‌گذاری موجودی قفل است؛ اصلاح ارزش انتقال‌های صفر پس از افتتاحیه برای بررسی دستی ماند`;
    writeAudit(db, user && user.id, 'transfer_revalue_pending', 'product', pid, note);
    return { ...base, ok: false, pending: true, note };
  }
  let plan;
  try {
    plan = computePlan(db, { productIds: [pid], includeZeroZero: true, date: corrDate });
  } catch (e) {
    if (e && e.code === 'E_INV_PERIOD_LOCKED') {
      writeAudit(db, user && user.id, 'transfer_revalue_pending', 'product', pid, e.message);
      return { ...base, ok: false, pending: true, note: e.message };
    }
    throw e;
  }
  if (plan.blocker) {
    writeAudit(db, user && user.id, 'transfer_revalue_pending', 'product', pid, plan.blocker.error);
    return { ...base, ok: false, pending: true, note: plan.blocker.error, excluded: plan.excluded };
  }
  const mine = plan.candidates.filter((c) => c.kind === 'zero_zero'
    && c.from_warehouse_id === wh
    && String(c.transfer_date || '') >= openingDate);
  const manual = (plan.excluded || []).filter((e) => e.product_id === pid
    && e.from_warehouse_id === wh
    && String(e.transfer_date || '') >= openingDate
    && (e.reason === 'coa_mismatch' || e.reason === 'no_source_cost' || e.reason === 'ambiguous_variant' || e.reason === 'partial_revalue'));
  const manualNote = manual.length
    ? `انتقال صفر بدون اصلاح خودکار: ${manual.map((m) => '#' + m.in_id + ' ' + (m.reason_fa || m.reason)).join('؛ ')}`
    : null;
  if (!mine.length) {
    if (manualNote) writeAudit(db, user && user.id, 'transfer_revalue_pending', 'product', pid, manualNote);
    return { ...base, pending: !!manualNote, note: manualNote, excluded: manual };
  }
  try {
    const applied = applyInTx(db, {
      ids: mine.map((c) => c.in_id),
      includeZeroZero: true,
      date: corrDate,
      productIds: [pid],
      reason: why,
      user,
    });
    if (manualNote) writeAudit(db, user && user.id, 'transfer_revalue_pending', 'product', pid, manualNote);
    return {
      ok: true,
      pending: !!manualNote,
      posted: applied.rows.length,
      note: manualNote,
      rows: applied.rows,
      excluded: manual,
    };
  } catch (e) {
    const locked = e && (e.code === 'E_INV_PERIOD_LOCKED' || (e.status === 422 && /قفل/.test(String(e.message || ''))));
    const ineligible = e && e.code === 'E_REVALUE_ROW_NOT_ELIGIBLE';
    if (locked || ineligible) {
      const note = e.message || (locked
        ? 'دورهٔ ارزش‌گذاری قفل است؛ اصلاح انتقال صفر برای بررسی دستی ماند'
        : 'اصلاح ارزش انتقال صفر در این افتتاحیه قطعی نشد و برای بررسی دستی ماند');
      writeAudit(db, user && user.id, 'transfer_revalue_pending', 'product', pid, note);
      return { ...base, ok: false, pending: true, note, excluded: manual };
    }
    throw e;
  }
}

module.exports = {
  EVENT_TYPE,
  EVENT_OUT,
  SOURCE_TYPE,
  NOTE_TAG,
  NOTE_TAG_OUT,
  COST_RULE,
  REASON_MIN,
  EXCLUDE_REASONS_FA,
  correctionSumSql,
  parseFilters,
  validateBody,
  computePlan,
  preview,
  applyInTx,
  revalue,
  revalueTransfersAfterBackdatedInbound,
  sourceAvgAsOf,
};
