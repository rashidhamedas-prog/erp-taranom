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
 */
const EVENT_TYPE = 'transfer_in_revalue';
const SOURCE_TYPE = 'warehouse_transfer';
const NOTE_TAG = 'revalue-transfer-in';
const REASON_MIN = 10;
const JALALI_RE = /^1[3-5]\d{2}\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])$/;
const LIVE_SQL = `status='posted' AND reversed_of IS NULL
  AND COALESCE(event_type,'') <> 'reversal' AND COALESCE(event_type,'') NOT GLOB '*_reversal'`;

const EXCLUDE_REASONS_FA = {
  zero_zero: 'خروج و ورود هر دو صفر — مبلغی برای انتقال نیست',
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
  return { warehouseId, ids: parseIds(s.ids), date };
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
  return db.prepare(`
    SELECT id, amount_rial FROM inventory_ledger
    WHERE event_type=? AND status='posted' AND reversed_of IS NULL
      AND source_type=? AND source_id=? AND product_id=? AND warehouse_id=?
    ORDER BY id
  `).all(EVENT_TYPE, inRow.source_type, inRow.source_id, inRow.product_id, inRow.warehouse_id);
}

/**
 * Read-only plan shared by preview and POST (POST recomputes it inside its transaction).
 * @returns {{ candidates, excluded, per_warehouse, totals, blocker, date, ... }}
 */
function computePlan(db, { warehouseId = null, ids = null, date = null, productIds = null } = {}) {
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
    if (base.out_amount_rial <= 0) { exclude('zero_zero'); continue; }
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
    candidates.push({ ...base, inventory_coa: toCode, delta_rial: base.out_amount_rial - base.in_amount_rial });
  }
  if (ids && ids.length) {
    for (const id of ids) {
      if (seen.has(id)) continue;
      excluded.push({ in_id: id, reason: 'not_candidate', reason_fa: EXCLUDE_REASONS_FA.not_candidate });
    }
  }

  const whMap = new Map();
  for (const c of candidates) {
    const k = c.to_warehouse_id;
    if (!whMap.has(k)) whMap.set(k, { warehouse_id: k, warehouse_name: whName(db, k), count: 0, amount_rial: 0 });
    const w = whMap.get(k);
    w.count += 1;
    w.amount_rial += c.delta_rial;
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
function applyInTx(db, { warehouseId = null, ids = null, date = null, productIds = null, reason, user }) {
  const plan = computePlan(db, { warehouseId, ids, date, productIds });
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
    const note = `[${NOTE_TAG}:ledger#${c.in_id}] اصلاح ارزش ورود انتقال (جفت خروج ledger#${c.out_id}) — ${reason}`.slice(0, 300);
    const led = L.postInventoryMovement(db, {
      eventType: EVENT_TYPE,
      productId: c.product_id,
      warehouseId: c.to_warehouse_id,
      qtyIn: 0,
      qtyOut: 0,
      unitCostRial: c.delta_rial,
      amountRial: c.delta_rial,
      sourceType: SOURCE_TYPE,
      sourceId: c.move_id,
      variantId: c.variant_id,
      date: plan.date,
      note,
      createdBy: userId,
      updateAvg: false,
      skipStock: true,
      valueOnly: true,
      applyValue: false,
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

module.exports = {
  EVENT_TYPE,
  SOURCE_TYPE,
  NOTE_TAG,
  REASON_MIN,
  correctionSumSql,
  parseFilters,
  validateBody,
  computePlan,
  preview,
  applyInTx,
  revalue,
};
