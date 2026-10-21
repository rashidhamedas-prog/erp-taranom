'use strict';
/**
 * Shared multi-product cutting batch.
 * Single-product is the same engine with one output row.
 * Legacy cutting_lays without batch_id keep the old path.
 * Issue valuation is the product-header weighted average (ADR-001), not the lot rate.
 */

const { todayJalali } = require('../../jalali');
const { assertSafeRial } = require('../money');
const { assertJournalIdempotent } = require('../sales-document');
const { postInventoryMovement, reverseInventoryMovement } = require('../inventory/ledger');
const { adjustBatchQty } = require('../inventory/batch-serial');
const { availableBatchMeters, applyLiveRollQty } = require('../inventory/fabric-rolls');
const { dr, cr, postEvent, resolveCuttingCostCenterId } = require('./posting');
const { setting, avgUnitRial } = require('./costing');
const { resolveLayUnit, markerToUnit, metresToUnit } = require('./lay-unit');

function httpErr(status, message, code, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function roundM(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

function remnantThreshold(policy, markerLengthM) {
  const mode = policy && policy.mode === 'fixed_m' ? 'fixed_m' : 'formula';
  const min = Math.max(0, Number(policy && policy.min_remnant_m) || 0);
  const ratio = Math.max(0, Number(policy && policy.remnant_ratio) || 0);
  const marker = Math.max(0, Number(markerLengthM) || 0);
  const threshold_m = mode === 'fixed_m' ? min : Math.max(min, roundM(ratio * marker));
  return { mode, min_remnant_m: min, remnant_ratio: ratio, threshold_m: roundM(threshold_m) };
}

function classifyUsableRemaining(remainingM, thresholdM, opts) {
  const remaining = roundM(remainingM);
  const T = roundM(thresholdM);
  if (opts && opts.defective) return { destination: 'scrap', remaining_m: remaining, threshold_m: T };
  if (!(remaining > 0)) return { destination: 'none', remaining_m: 0, threshold_m: T };
  if (remaining <= T + 1e-9) return { destination: 'remnant', remaining_m: remaining, threshold_m: T };
  return { destination: 'return_roll', remaining_m: remaining, threshold_m: T };
}

function rollEquation(row, toleranceM) {
  const opening = roundM(row.opening_m);
  const laid = roundM(row.laid_m);
  const returned = roundM(row.returned_m);
  const remnant = roundM(row.remnant_m);
  const loss = roundM(row.length_loss_m);
  const adj = roundM(row.adjustment_m);
  const sum = roundM(laid + returned + remnant + loss + adj);
  const diff = roundM(opening - sum);
  const tol = Math.max(0, Number(toleranceM) || 0);
  return { opening_m: opening, sum_m: sum, diff_m: diff, ok: Math.abs(diff) <= tol + 1e-9 };
}

function plannedPieces(acceptedPlies, piecesPerPly) {
  const plies = Math.round(Number(acceptedPlies) || 0);
  const per = Number(piecesPerPly) || 0;
  return Math.round(plies * per);
}

/** ADR-006 W1 — تسهیم قابل‌انتخاب لای مشترک */
const ALLOC_BASES = new Set(['pieces', 'fabric', 'manual', 'hybrid']);

function normalizeAllocationBasis(raw) {
  const b = String(raw || 'pieces').trim().toLowerCase();
  if (!ALLOC_BASES.has(b)) {
    throw httpErr(400, 'روش تسهیم نامعتبر است (pieces|fabric|manual|hybrid)', 'E_ALLOC_BASIS');
  }
  return b;
}

function weightsToBps(rawWeights) {
  const sum = rawWeights.reduce((s, n) => s + (Number(n) || 0), 0);
  if (!(sum > 0)) throw httpErr(400, 'جمع سهم خروجی صفر است', 'E_SHARE_ZERO');
  const bps = rawWeights.map((n) => Math.floor(((Number(n) || 0) / sum) * 10000));
  let left = 10000 - bps.reduce((s, n) => s + n, 0);
  const order = bps.map((_, i) => i).sort((a, b) => bps[b] - bps[a] || a - b);
  for (const i of order) {
    if (left <= 0) break;
    bps[i] += 1;
    left -= 1;
  }
  return bps.map((n) => n / 100);
}

function blendHybridWeights(pieceWeights, fabricWeights) {
  const n = pieceWeights.length;
  const mixed = [];
  for (let i = 0; i < n; i++) {
    const p = Number(pieceWeights[i]) || 0;
    const f = Number(fabricWeights[i]) || 0;
    if (f > 0 && p > 0) mixed.push((p + f) / 2);
    else if (f > 0) mixed.push(f);
    else mixed.push(p);
  }
  return weightsToBps(mixed);
}

function allocateRial(commonRial, weights) {
  const common = Math.round(Number(commonRial) || 0);
  const rows = (weights || []).map((w) => ({
    product_id: Number(w.product_id),
    size_code: String(w.size_code || ''),
    weight: Number(w.weight) || 0,
  })).filter((w) => w.product_id && w.weight > 0);
  const sumW = rows.reduce((s, w) => s + w.weight, 0);
  if (!(sumW > 0)) throw httpErr(400, 'جمع سهم خروجی صفر است', 'E_SHARE_ZERO');
  if (Math.abs(sumW - 100) > 0.05 && Math.abs(sumW - 1) > 0.0001) {
    throw httpErr(400, 'جمع سهم فنی باید ۱۰۰٪ باشد', 'E_SHARE_SUM', { sum: sumW });
  }
  const scale = Math.abs(sumW - 1) <= 0.0001 ? 1 : sumW;
  const draft = rows.map((w) => {
    const exact = common * (w.weight / scale);
    return { ...w, amount_rial: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let leftover = common - draft.reduce((s, r) => s + r.amount_rial, 0);
  const order = draft.slice().sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.product_id - b.product_id;
  });
  for (const row of order) {
    if (leftover <= 0) break;
    row.amount_rial += 1;
    leftover -= 1;
  }
  return draft.map((r) => ({ product_id: r.product_id, size_code: r.size_code, weight: r.weight, amount_rial: r.amount_rial }));
}

function assertFlag(db) {
  if (String(setting(db, 'production_shared_cut', '0')) !== '1') {
    throw httpErr(403, 'برش مشترک خاموش است', 'E_SHARED_CUT_OFF');
  }
}

function globalPolicy(db) {
  return {
    mode: setting(db, 'production_remnant_mode', 'formula') === 'fixed_m' ? 'fixed_m' : 'formula',
    min_remnant_m: Number(setting(db, 'production_remnant_min_m', '1.20')) || 0,
    remnant_ratio: Number(setting(db, 'production_remnant_ratio', '0.20')) || 0,
    scope: 'global',
  };
}

function loadPolicy(db, ctx) {
  const marker = Number(ctx && ctx.marker_length_m) || 0;
  let best = null;
  let bestScore = -1;
  const rules = db.prepare(`SELECT * FROM cutting_remnant_rules WHERE COALESCE(active,1)=1`).all();
  const fabric = Number(ctx && ctx.fabric_product_id) || 0;
  const width = Math.round(Number(ctx && ctx.width_cm) || 0);
  const wh = Number(ctx && ctx.warehouse_id) || 0;
  for (const rule of rules) {
    const rf = Number(rule.fabric_product_id) || 0;
    const rw = Math.round(Number(rule.width_cm) || 0);
    const rwh = Number(rule.warehouse_id) || 0;
    if (rf && rf !== fabric) continue;
    if (rw && rw !== width) continue;
    if (rwh && rwh !== wh) continue;
    let score = 0;
    if (rf && rw && rwh) score = 4;
    else if (rf && rw) score = 3;
    else if (rf) score = 2;
    else if (rwh) score = 1;
    else continue;
    if (score > bestScore) {
      bestScore = score;
      best = rule;
    }
  }
  const base = best ? {
    mode: best.mode === 'fixed_m' ? 'fixed_m' : 'formula',
    min_remnant_m: Number(best.min_remnant_m) || 0,
    remnant_ratio: Number(best.remnant_ratio) || 0,
    scope: 'override',
    rule_id: best.id,
  } : globalPolicy(db);
  return { ...base, ...remnantThreshold(base, marker) };
}

/**
 * @param {object[]} outputs
 * @param {number} acceptedPlies
 * @param {{ allocation_basis?: string }} [opts]
 * allocation_basis: pieces | fabric | manual | hybrid (ADR-006)
 * fabric: نیاز به fabric_std_m (متر استاندارد پارچه به‌ازای یک قطعه در مارکر) روی هر خروجی
 * manual: weight/weight_pct اجباری جمع ≈۱۰۰
 * hybrid: میانگین pieces و fabric؛ اگر weight دستی باشد همان وزن می‌ماند
 */
function normalizeOutputs(outputs, acceptedPlies, opts) {
  const basis = normalizeAllocationBasis(opts && opts.allocation_basis);
  const rows = Array.isArray(outputs) ? outputs : [];
  if (!rows.length) throw httpErr(400, 'حداقل یک خروجی لازم است', 'E_OUTPUTS');
  const mapped = rows.map((o) => {
    const pieces = Number(o.pieces_per_ply);
    if (!(pieces > 0)) throw httpErr(400, 'قطعه در هر لایه باید بزرگ‌تر از صفر باشد', 'E_PIECES');
    const pid = Number(o.product_id);
    if (!pid) throw httpErr(400, 'کالای خروجی الزامی است', 'E_OUTPUT_PRODUCT');
    const fabricStd = Number(o.fabric_std_m != null ? o.fabric_std_m : o.std_fabric_m);
    return {
      product_id: pid,
      size_code: String(o.size_code || ''),
      pieces_per_ply: pieces,
      fabric_std_m: Number.isFinite(fabricStd) && fabricStd > 0 ? fabricStd : 0,
      weight: Number(o.weight != null ? o.weight : o.weight_pct),
      planned_pieces: plannedPieces(acceptedPlies, pieces),
    };
  });

  const pieceRaw = mapped.map((o) => o.pieces_per_ply);
  const fabricRaw = mapped.map((o) => o.fabric_std_m * o.pieces_per_ply);
  const hasManual = mapped.every((o) => Number.isFinite(o.weight) && o.weight > 0);
  const hasFabric = fabricRaw.every((n) => n > 0);

  let weights;
  if (basis === 'manual') {
    if (!hasManual) throw httpErr(400, 'در تسهیم دستی درصد هر محصول الزامی است', 'E_ALLOC_MANUAL');
    weights = weightsToBps(mapped.map((o) => o.weight));
  } else if (basis === 'fabric') {
    if (!hasFabric) {
      throw httpErr(400, 'در تسهیم پارچه، متر استاندارد پارچه (fabric_std_m) برای هر محصول لازم است', 'E_ALLOC_FABRIC');
    }
    weights = weightsToBps(fabricRaw);
  } else if (basis === 'hybrid') {
    if (hasManual) {
      weights = weightsToBps(mapped.map((o) => o.weight));
    } else {
      const pw = weightsToBps(pieceRaw);
      if (!hasFabric) {
        weights = pw;
      } else {
        const fw = weightsToBps(fabricRaw);
        weights = blendHybridWeights(pw, fw);
      }
    }
  } else {
    // pieces — اگر weight دستی ارسال شده باشد محترم است (سازگاری با کلاینت قدیمی)
    if (hasManual) weights = weightsToBps(mapped.map((o) => o.weight));
    else weights = weightsToBps(pieceRaw);
  }

  return mapped.map((o, i) => ({
    ...o,
    weight: weights[i],
    allocation_basis: basis,
  }));
}

function normalizeExtraM(raw, opening, laid) {
  const extra = roundM(raw || 0);
  if (extra < -1e-9) throw httpErr(400, 'اضافه طاقه نمی‌تواند منفی باشد', 'E_ROLL_EXTRA');
  const cap = roundM(Math.max(Number(opening) || 0, Number(laid) || 0));
  if (extra > cap + 1e-6) {
    throw httpErr(400, 'اضافه طاقه از طول پهن‌شده و ماندهٔ دفتر بزرگ‌تر است', 'E_ROLL_EXTRA', { extra_m: extra, cap_m: cap });
  }
  return extra;
}

function previewRolls(rolls, policy, markerLengthM, tolerance) {
  const T = remnantThreshold(policy, markerLengthM);
  return (rolls || []).map((r, idx) => {
    const plies = Math.round(Number(r.ply_count) || 0);
    const laid = roundM(r.laid_m != null ? r.laid_m : plies * markerLengthM);
    const loss = roundM(r.length_loss_m || 0);
    const adj = roundM(r.adjustment_m || 0);
    const book = roundM(r.opening_m);
    const extra = normalizeExtraM(r.extra_m, book, laid);
    const opening = roundM(book + extra);
    let returned = r.returned_m != null ? roundM(r.returned_m) : null;
    let remnant = r.remnant_m != null ? roundM(r.remnant_m) : null;
    let destination = r.destination || '';
    if (returned == null && remnant == null) {
      const usable = roundM(opening - laid - loss - adj);
      const cls = classifyUsableRemaining(Math.max(0, usable), T.threshold_m, { defective: !!r.defective });
      destination = cls.destination;
      if (cls.destination === 'remnant') { remnant = cls.remaining_m; returned = 0; }
      else if (cls.destination === 'return_roll') { returned = cls.remaining_m; remnant = 0; }
      else if (cls.destination === 'scrap') { remnant = 0; returned = 0; }
      else { remnant = 0; returned = 0; }
    }
    returned = roundM(returned || 0);
    remnant = roundM(remnant || 0);
    const eq = rollEquation({
      opening_m: opening, laid_m: laid, returned_m: returned, remnant_m: remnant,
      length_loss_m: loss, adjustment_m: adj,
    }, tolerance);
    return {
      index: idx,
      batch_id: Number(r.batch_id),
      color: String(r.color || ''),
      ply_count: plies,
      opening_m: book,
      extra_m: extra,
      effective_opening_m: opening,
      laid_m: laid,
      returned_m: returned,
      remnant_m: remnant,
      length_loss_m: loss,
      adjustment_m: adj,
      destination: destination || (remnant > 0 ? 'remnant' : (returned > 0 ? 'return_roll' : 'none')),
      defective: !!r.defective,
      equation: eq,
      preview: true,
    };
  });
}

/**
 * متر واقعی اندازه‌گیری‌شده (v513): per-roll laid_m یا جمع actual_meters که به نسبت لایه پخش می‌شود.
 * بدون هیچ‌کدام = طول مارکر × لایه (سازگاری API قدیمی؛ فرم جدید اجازه نمی‌دهد).
 */
function applyMeasuredLaid(rolls, actualMeters, marker) {
  const rows = (Array.isArray(rolls) ? rolls : []).map((r) => {
    const copy = { ...r };
    const laid = Number(copy.laid_m);
    if (copy.laid_m == null || copy.laid_m === '' || !(laid > 0) || !Number.isFinite(laid)) delete copy.laid_m;
    else copy.laid_m = roundM(laid);
    return copy;
  });
  const withLaid = rows.filter((r) => r.laid_m != null).length;
  if (withLaid) return { rolls: rows, source: withLaid === rows.length ? 'roll' : 'mixed' };
  const hasHeader = actualMeters != null && actualMeters !== '';
  if (!hasHeader) return { rolls: rows, source: 'standard' };
  const total = Number(actualMeters);
  if (!(total > 0) || !Number.isFinite(total)) {
    throw httpErr(400, 'مصرف واقعی نامعتبر است', 'E_CUT_ACTUAL');
  }
  const plies = rows.map((r) => Math.max(0, Math.round(Number(r.ply_count) || 0)));
  const sumPlies = plies.reduce((s, n) => s + n, 0);
  if (!(sumPlies > 0)) return { rolls: rows, source: 'standard' };
  let left = roundM(total);
  rows.forEach((r, i) => {
    const last = i === rows.length - 1;
    const part = last ? left : roundM(total * plies[i] / sumPlies);
    r.laid_m = roundM(part);
    left = roundM(left - part);
  });
  return { rolls: rows, source: 'header' };
}

/** استاندارد BOM پارچه برای خروجی‌های برش مشترک؛ complete=false اگر یک محصول استاندارد ندارد. */
function sharedMatrixMeters(db, outputs, fabricProductId, bomId) {
  const byPid = new Map();
  for (const o of outputs || []) {
    const pid = Number(o.product_id);
    if (!byPid.has(pid)) byPid.set(pid, []);
    byPid.get(pid).push(o);
  }
  let total = 0;
  let complete = byPid.size > 0;
  for (const [pid, rows] of byPid) {
    if (rows.every((o) => Number(o.fabric_std_m) > 0)) {
      total += rows.reduce((s, o) => s + Number(o.fabric_std_m) * (Number(o.planned_pieces) || 0), 0);
      continue;
    }
    const sizeBreakdown = {};
    rows.forEach((o) => {
      const key = String(o.size_code || 'ALL');
      sizeBreakdown[key] = (sizeBreakdown[key] || 0) + (Number(o.planned_pieces) || 0);
    });
    let m = 0;
    try {
      const { fabricLineFromBom } = require('./cutting');
      const r = fabricLineFromBom(db, {
        productId: pid,
        bomId: byPid.size === 1 ? bomId : null,
        sizeBreakdown,
        fabricProductId,
      });
      m = Number(r && r.matrixMeters) || 0;
    } catch (_) { m = 0; }
    if (m > 0) total += m;
    else complete = false;
  }
  return { matrix_m: roundM(total), complete };
}

/**
 * انحراف/ضایعات برش مشترک از متر واقعی:
 * planned = مارکر × لایه، actual = پهن واقعی + اتلاف طولی، matrix = استاندارد BOM.
 * مازاد پهن بیش از سقف ضایعات عادی (همان درصد لایهٔ کلاسیک) غیرعادی است و به ۵۲۲۱ می‌رود.
 */
function sharedLayMeters(db, { rolls, outputs, marker, fabricProductId, bomId }) {
  const planned = roundM((rolls || []).reduce((s, r) => s + (Number(r.ply_count) || 0) * marker, 0));
  const laid = roundM((rolls || []).reduce((s, r) => s + (Number(r.laid_m) || 0), 0));
  const loss = roundM((rolls || []).reduce((s, r) => s + (Number(r.length_loss_m) || 0), 0));
  const actual = roundM(laid + loss);
  const mx = sharedMatrixMeters(db, outputs, fabricProductId, bomId);
  const pct = Number(setting(db, 'production_normal_waste_default_pct', '3')) || 3;
  let wN = 0;
  let laidAbnormal = 0;
  if (mx.complete && mx.matrix_m > 0) {
    const over = Math.max(0, laid - mx.matrix_m);
    const allowed = Math.max(0, actual * pct / 100);
    wN = Math.min(over, allowed);
    laidAbnormal = roundM(Math.max(0, over - allowed));
  }
  return {
    planned_meters: planned,
    actual_meters: actual,
    laid_meters: laid,
    matrix_meters: mx.matrix_m,
    matrix_complete: mx.complete,
    waste_normal_m: roundM(wN),
    waste_abnormal_m: roundM(loss + laidAbnormal),
    laid_abnormal_m: laidAbnormal,
    fabric_variance_m: mx.matrix_m > 0 ? roundM(actual - mx.matrix_m) : 0,
    spread_variance_m: roundM(laid - planned),
    normal_waste_pct: pct,
  };
}

function writeLayMeters(db, layId, plan) {
  db.prepare(`
    UPDATE cutting_lays SET matrix_meters=?, waste_normal_m=?, waste_abnormal_m=?, waste_allowed_m=?
    WHERE id=?
  `).run(
    Number(plan.matrix_meters) || 0,
    Number(plan.waste_normal_m) || 0,
    Number(plan.waste_abnormal_m) || 0,
    roundM((Number(plan.actual_meters) || 0) * (Number(plan.normal_waste_pct) || 0) / 100),
    layId
  );
  if (plan.qty_unit) {
    db.prepare('UPDATE cutting_lays SET qty_unit=?, marker_unit=?, marker_factor=? WHERE id=?')
      .run(plan.qty_unit, plan.marker_unit || null, Number(plan.marker_factor) || null, layId);
    db.prepare(`
      UPDATE cutting_batches SET qty_unit=?, marker_unit=?, marker_factor=?
      WHERE id=(SELECT batch_id FROM cutting_lays WHERE id=?)
    `).run(plan.qty_unit, plan.marker_unit || null, Number(plan.marker_factor) || null, layId);
  }
}

/** سهم ریالی مازاد غیرعادی پهن از WIP به ۵۲۲۱ منتقل می‌شود. */
function splitAbnormalLaid(commonRial, plan) {
  const laid = Number(plan.laid_meters != null ? plan.laid_meters : plan.laid_m) || 0;
  const ab = Number(plan.laid_abnormal_m) || 0;
  if (!(laid > 0) || !(ab > 0)) return { common: commonRial, abnormal: 0 };
  const abnormal = Math.min(commonRial, Math.round(commonRial * ab / laid));
  return { common: commonRial - abnormal, abnormal };
}

function previewSharedCut(db, body) {
  const marker = Number(body.marker_length_m);
  if (!(marker > 0)) throw httpErr(400, 'قد الگو باید بزرگ‌تر از صفر باشد', 'E_MARKER');
  const layUnit = resolveLayUnit(db, {
    fabricProductId: body.fabric_product_id,
    batchIds: (Array.isArray(body.rolls) ? body.rolls : []).map((r) => r && r.batch_id),
    markerFactor: body.marker_factor,
    widthCm: body.width_cm,
  });
  // Every quantity below is in the rolls' unit; the marker is converted once here.
  const markerU = markerToUnit(layUnit, marker);
  const basePolicy = body.policy_snapshot || loadPolicy(db, {
    marker_length_m: marker,
    fabric_product_id: body.fabric_product_id,
    width_cm: body.width_cm,
    warehouse_id: body.warehouse_id,
  });
  const thresholdU = remnantThreshold({
    ...basePolicy,
    min_remnant_m: metresToUnit(layUnit, basePolicy.min_remnant_m),
  }, markerU);
  const policy = {
    ...basePolicy,
    threshold_m: thresholdU.threshold_m,
    threshold_unit: layUnit.qty_unit,
  };
  const tol = Number(setting(db, 'production_roll_balance_tolerance_m', '0.01'));
  const pliesHint = (body.rolls || []).reduce((s, r) => s + Math.round(Number(r.ply_count) || 0), 0);
  const allocation_basis = normalizeAllocationBasis(body.allocation_basis);
  const outputs = normalizeOutputs(body.outputs, pliesHint, { allocation_basis });
  const measured = applyMeasuredLaid(body.rolls, body.actual_meters, markerU);
  const rolls = previewRolls(measured.rolls, {
    ...basePolicy,
    min_remnant_m: metresToUnit(layUnit, basePolicy.min_remnant_m),
  }, markerU, tol);
  const bad = rolls.filter((r) => !r.equation.ok);
  const meters = sharedLayMeters(db, {
    rolls, outputs, marker: markerU, fabricProductId: body.fabric_product_id, bomId: body.bom_id,
  });
  return {
    preview: true,
    marker_length_m: marker,
    marker_in_unit_qty: markerU,
    qty_unit: layUnit.qty_unit,
    unit_name: layUnit.unit_name,
    marker_unit: layUnit.marker_unit,
    marker_unit_name: layUnit.marker_unit_name,
    marker_factor: layUnit.marker_factor,
    factor_source: layUnit.factor_source,
    allocation_basis,
    policy,
    outputs,
    rolls,
    actual_source: measured.source,
    planned_meters: meters.planned_meters,
    actual_meters: meters.actual_meters,
    matrix_meters: meters.matrix_meters,
    waste_normal_m: meters.waste_normal_m,
    waste_abnormal_m: meters.waste_abnormal_m,
    fabric_variance_m: meters.fabric_variance_m,
    spread_variance_m: meters.spread_variance_m,
    laid_abnormal_m: meters.laid_abnormal_m,
    matrix_complete: meters.matrix_complete,
    normal_waste_pct: meters.normal_waste_pct,
    balanced: bad.length === 0,
    errors: bad.map((r) => ({ index: r.index, code: 'E_ROLL_BALANCE', diff_m: r.equation.diff_m })),
    returned_m: roundM(rolls.reduce((s, r) => s + r.returned_m, 0)),
    remnant_m: roundM(rolls.reduce((s, r) => s + r.remnant_m, 0)),
    laid_m: roundM(rolls.reduce((s, r) => s + r.laid_m, 0)),
    extra_m: roundM(rolls.reduce((s, r) => s + r.extra_m, 0)),
    shortfall_m: roundM(bad.reduce((s, r) => s + Math.max(0, -r.equation.diff_m), 0)),
  };
}

function assertLayOrderOpen(db, orderId) {
  const po = db.prepare('SELECT order_no, status FROM production_orders WHERE id=?').get(Number(orderId));
  if (!po) throw httpErr(404, 'سفارش تولید یافت نشد', 'E_PACK_ORDER');
  if (['cancelled', 'closed', 'voided', 'completed'].includes(String(po.status || ''))) {
    throw httpErr(409, `سفارش ${po.order_no} بسته یا نهایی شده است. لایه‌چینی جدید پارچه را دوباره مصرف می‌کند و رسید قبلی را پاک نمی‌کند.`, 'E_PACK_ORDER_STATUS');
  }
}

function bookRollSurplus(db, { batch, extraM, unit, layId, date, user, batchNo }) {
  const extra = roundM(extraM);
  if (!(extra > 0)) return { extra_m: 0, extra_ledger_id: null, extra_rial: 0 };
  const amount = assertSafeRial(Math.round(unit * extra), 'extra');
  const led = postInventoryMovement(db, {
    eventType: 'production_receipt',
    productId: batch.product_id,
    warehouseId: batch.warehouse_id,
    qtyIn: extra,
    unitCostRial: unit,
    amountRial: amount,
    sourceType: 'cutting_roll_surplus',
    sourceId: layId,
    batchId: batch.id,
    date,
    note: `اضافه طاقه ${batchNo || ''}`.trim(),
    createdBy: user && user.id,
  });
  adjustBatchQty(db, batch.id, extra);
  return { extra_m: extra, extra_ledger_id: led && led.id, extra_rial: amount };
}

function rememberWipSetting(db, settingKey, warehouseId) {
  if (!settingKey || !warehouseId) return;
  const cur = db.prepare('SELECT value FROM settings WHERE key=?').get(settingKey);
  if (!cur) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?,?)').run(settingKey, String(warehouseId));
    return;
  }
  if (!String(cur.value || '').trim()) {
    db.prepare('UPDATE settings SET value=? WHERE key=?').run(String(warehouseId), settingKey);
  }
}

function warehouseByCode(db, code, settingKey) {
  const id = Number(setting(db, settingKey, '')) || 0;
  if (id) {
    const row = db.prepare('SELECT * FROM warehouses WHERE id=?').get(id);
    if (row) return row;
  }
  const byCode = db.prepare('SELECT * FROM warehouses WHERE code=?').get(code);
  if (byCode) return byCode;
  if (code !== 'WH-WIP') return null;
  const typed = db.prepare(`
    SELECT * FROM warehouses
    WHERE active IS NULL OR active=1
  `).all().find((wh) => {
    const types = [String(wh.warehouse_type || ''), String(wh.kind || ''), String(wh.code || '')];
    return types.some((t) => t === 'wip' || t === 'work_in_process' || t === 'semi' || t === 'WH-CUT');
  });
  if (typed) {
    rememberWipSetting(db, settingKey, typed.id);
    return typed;
  }
  const info = db.prepare('PRAGMA table_info(warehouses)').all().map((c) => c.name);
  const cols = ['code', 'name'];
  const vals = ['WH-WIP', 'انبار کار در جریان'];
  if (info.includes('active')) { cols.push('active'); vals.push(1); }
  if (info.includes('address')) { cols.push('address'); vals.push(''); }
  if (info.includes('warehouse_type')) { cols.push('warehouse_type'); vals.push('wip'); }
  if (info.includes('kind')) { cols.push('kind'); vals.push('wip'); }
  if (info.includes('entity')) { cols.push('entity'); vals.push('workshop'); }
  db.prepare(`INSERT INTO warehouses (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
  const created = db.prepare("SELECT * FROM warehouses WHERE code='WH-WIP'").get();
  if (created) rememberWipSetting(db, settingKey, created.id);
  return created || null;
}

function postSharedCut(db, body, user) {
  assertFlag(db);
  const key = String(body.idempotency_key || '').trim();
  if (!key) throw httpErr(400, 'کلید تکرارناپذیر الزامی است', 'E_CUT_IDEMPOTENCY');
  const prev = db.prepare('SELECT id FROM cutting_batches WHERE idempotency_key=?').get(key);
  if (prev) return getSharedCut(db, prev.id);

  const plan = previewSharedCut(db, body);
  if (!plan.balanced && !body.override_balance) {
    throw httpErr(400, 'تراز طاقه خارج از تلرانس است', 'E_ROLL_BALANCE', { errors: plan.errors });
  }
  const productIds = [...new Set(plan.outputs.map((o) => Number(o.product_id)).filter((n) => n > 0))];
  const poIdReq = Number(body.production_order_id) || 0;
  if (productIds.length >= 2 && !poIdReq) {
    throw httpErr(400, 'برای برش چندمحصول، سفارش تولید را انتخاب کنید تا لایه به همان سفارش وصل شود.', 'E_CUT_PO_REQUIRED');
  }
  if (poIdReq) assertLayOrderOpen(db, poIdReq);
  let date = String(body.date || '').trim();
  if (!date && poIdReq) {
    const poRow = db.prepare('SELECT date FROM production_orders WHERE id=?').get(poIdReq);
    if (poRow && poRow.date) date = String(poRow.date).trim();
  }
  if (!date) date = todayJalali();
  const anchor = plan.outputs.slice().sort((a, b) => a.product_id - b.product_id)[0];

  return db.transaction(() => {
    const { allocateNumber } = require('../../db');
    const batchNo = allocateNumber(db, 'cutting_batch', 'CB');
    const layNo = allocateNumber(db, 'cutting_lay', 'LAY');
    const head = db.prepare(`
      INSERT INTO cutting_batches
        (batch_no, marker_length_m, width_cm, bom_id, fabric_product_id, status, policy_json,
         idempotency_key, date, note, created_by, allocation_basis)
      VALUES (?,?,?,?,?,'posted',?,?,?,?,?,?)
    `).run(
      batchNo, plan.marker_length_m, Math.round(Number(body.width_cm) || 0),
      body.bom_id || null, body.fabric_product_id || null,
      JSON.stringify(plan.policy), key, date, String(body.note || ''), user && user.id,
      plan.allocation_basis || 'pieces'
    );
    const batchId = head.lastInsertRowid;
    const insOut = db.prepare(`
      INSERT INTO cutting_batch_outputs
        (batch_id, product_id, size_code, pieces_per_ply, weight_pct, planned_pieces, accepted_plies, good_pieces, fabric_std_m)
      VALUES (?,?,?,?,?,?,?,?,?)
    `);
    for (const o of plan.outputs) {
      insOut.run(
        batchId, o.product_id, o.size_code, o.pieces_per_ply, o.weight, o.planned_pieces, 0, o.planned_pieces,
        Number(o.fabric_std_m) || 0
      );
    }
    const poId = Number(body.production_order_id) || null;
    const lay = db.prepare(`
      INSERT INTO cutting_lays
        (lay_no, product_id, bom_id, fabric_product_id, marker_length_m, ply_count,
         planned_meters, actual_meters, qty_pieces, status, idempotency_key, date, note, created_by, batch_id, color, width_cm, production_order_id)
      VALUES (?,?,?,?,?,?,?,?,?,'posted',?,?,?,?,?,?,?,?)
    `).run(
      layNo, anchor.product_id, body.bom_id || null, body.fabric_product_id || null,
      plan.marker_length_m,
      plan.rolls.reduce((s, r) => s + r.ply_count, 0),
      plan.planned_meters, plan.actual_meters,
      plan.outputs.reduce((s, o) => s + o.planned_pieces, 0),
      key + ':lay', date, String(body.note || ''), user && user.id, batchId,
      String(body.color || ''), Math.round(Number(body.width_cm) || 0), poId
    );
    const layId = lay.lastInsertRowid;
    writeLayMeters(db, layId, plan);
    let common = 0;
    let lossRial = 0;
    let extraRial = 0;
    const whRaw = warehouseByCode(db, 'WH-RAW', 'production_wh_raw_id');
    const whRem = warehouseByCode(db, 'WH-SCRAP', 'production_wh_remnant_id');
    for (const roll of plan.rolls) {
      const batch = db.prepare("SELECT * FROM inventory_batches WHERE id=?").get(roll.batch_id);
      if (!batch) throw httpErr(400, 'طاقه یافت نشد', 'E_CUT_ROLL');
      const busy = db.prepare(`
        SELECT r.id FROM cutting_lay_rolls r
        JOIN cutting_lays l ON l.id=r.lay_id
        WHERE r.batch_id=? AND r.status='posted' AND l.status='posted'
      `).get(batch.id);
      if (busy) throw httpErr(409, 'این طاقه روی لایهٔ باز دیگری مصرف شده است', 'E_ROLL_BUSY');
      applyLiveRollQty(db, batch);
      const avail = availableBatchMeters(db, batch.id);
      const issueM = roundM(roll.laid_m + roll.length_loss_m + roll.remnant_m);
      const extraNeed = roundM(roll.extra_m || 0);
      if (avail + extraNeed + 1e-6 < issueM) {
        throw httpErr(409, `مانده طاقه (${plan.unit_name || 'متر'}) کافی نیست`, 'E_CUT_ROLL_QTY', { avail, need: issueM, extra_m: extraNeed, batch_id: batch.id });
      }
      const unit = avgUnitRial(db, batch.product_id);
      const surplus = bookRollSurplus(db, {
        batch, extraM: extraNeed, unit, layId, date, user, batchNo,
      });
      extraRial += surplus.extra_rial;
      const laidRial = assertSafeRial(Math.round(unit * roll.laid_m), 'laid');
      const lossPart = assertSafeRial(Math.round(unit * roll.length_loss_m), 'loss');
      common += laidRial;
      lossRial += lossPart;
      let ledgerId = null;
      if (issueM > 0) {
        const led = postInventoryMovement(db, {
          eventType: 'production_issue',
          productId: batch.product_id,
          warehouseId: batch.warehouse_id || (whRaw && whRaw.id),
          qtyOut: issueM,
          unitCostRial: unit,
          amountRial: assertSafeRial(Math.round(unit * issueM), 'issue'),
          sourceType: 'cutting_lay',
          sourceId: layId,
          batchId: batch.id,
          date,
          note: `برش مشترک ${batchNo}`,
          createdBy: user && user.id,
        });
        ledgerId = led && led.id;
        adjustBatchQty(db, batch.id, -issueM);
      }
      let remnantBatchId = null;
      let remnantLedgerId = null;
      if (roll.remnant_m > 0) {
        if (!whRem) throw httpErr(400, 'انبار ته‌طاقه تنظیم نشده', 'E_REMNANT_WH');
        const ins = db.prepare(`
          INSERT INTO inventory_batches
            (batch_no, product_id, warehouse_id, qty_on_hand, qty_received, status, kind, color, width_cm, unit, unit_cost_rial, source_type, source_id, note)
          VALUES (?,?,?,?,?,'active','fabric',?,?, ?, ?, 'cutting_remnant', ?, ?)
        `).run(
          `${batch.batch_no}-R`, batch.product_id, whRem.id, roll.remnant_m, roll.remnant_m,
          batch.color || '', Math.round(Number(batch.width_cm) || 0), batch.unit || 'm', unit, batchId, 'ته‌طاقه'
        );
        remnantBatchId = ins.lastInsertRowid;
        const remLed = postInventoryMovement(db, {
          eventType: 'production_receipt',
          productId: batch.product_id,
          warehouseId: whRem.id,
          qtyIn: roll.remnant_m,
          unitCostRial: unit,
          amountRial: assertSafeRial(Math.round(unit * roll.remnant_m), 'remnant'),
          sourceType: 'cutting_remnant',
          sourceId: batchId,
          batchId: remnantBatchId,
          date,
          note: `ته‌طاقه ${batchNo}`,
          createdBy: user && user.id,
        });
        remnantLedgerId = remLed && remLed.id;
      }
      db.prepare(`
        INSERT INTO cutting_lay_rolls
          (lay_id, batch_id, meters, unit_cost_rial, amount_rial, ledger_id, status,
           opening_m, ply_count, laid_m, returned_m, remnant_m, length_loss_m, adjustment_m, destination, remnant_batch_id, remnant_ledger_id, extra_m, extra_ledger_id)
        VALUES (?,?,?,?,?,?,'posted',?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        layId, batch.id, issueM, unit, laidRial + lossPart, ledgerId,
        roll.opening_m, roll.ply_count, roll.laid_m, roll.returned_m, roll.remnant_m,
        roll.length_loss_m, roll.adjustment_m, roll.destination, remnantBatchId, remnantLedgerId,
        surplus.extra_m, surplus.extra_ledger_id
      );
    }
    common = assertSafeRial(common, 'common');
    {
      const split = splitAbnormalLaid(common, plan);
      common = split.common;
      lossRial += split.abnormal;
    }
    const cutCc = resolveCuttingCostCenterId(db, {
      explicitId: body.cost_center_id,
      bomId: body.bom_id,
      warehouseId: whRaw && whRaw.id,
    });
    db.prepare('UPDATE cutting_lays SET cost_center_id=? WHERE id=?').run(cutCc, layId);
    assertJournalIdempotent(db, 'production_material_issue', layId);
    let journalId = null;
    if (common > 0) {
      const je = postEvent(db, {
        event: 'PRD-01',
        sourceId: layId,
        date,
        description: `مصرف خالص برش مشترک ${batchNo}`,
        createdBy: user && user.id,
        costCenterId: cutCc,
        warehouseId: whRaw && whRaw.id,
        lines: [dr(db, 'coa_wip', common), cr(db, 'coa_raw_materials', common)],
      });
      journalId = je ? je.je_id : null;
    }
    let wasteJe = null;
    if (lossRial > 0) {
      assertJournalIdempotent(db, 'production_waste', layId);
      const wje = postEvent(db, {
        event: 'PRD-09',
        sourceId: layId,
        date,
        description: `اتلاف طولی برش ${batchNo}`,
        createdBy: user && user.id,
        lines: [dr(db, 'coa_abnormal_waste', lossRial), cr(db, 'coa_raw_materials', lossRial)],
        costCenterId: cutCc,
        warehouseId: whRaw && whRaw.id,
      });
      wasteJe = wje ? wje.je_id : null;
    }
    if (extraRial > 0) {
      assertJournalIdempotent(db, 'cutting_roll_surplus', layId);
      const eje = postEvent(db, {
        event: 'PRD-18',
        sourceId: layId,
        date,
        description: `اضافه طاقه برش ${batchNo}`,
        createdBy: user && user.id,
        lines: [dr(db, 'coa_raw_materials', extraRial), cr(db, 'coa_var_material_qty', extraRial)],
        costCenterId: cutCc,
        warehouseId: whRaw && whRaw.id,
      });
      const extraJe = eje ? eje.je_id : null;
      if (extraJe) db.prepare('UPDATE cutting_lays SET extra_journal_id=? WHERE id=?').run(extraJe, layId);
    }
    const shares = allocateRial(common, plan.outputs.map((o) => ({
      product_id: o.product_id, size_code: o.size_code, weight: o.weight,
    })));
    const allocBasis = plan.allocation_basis || 'pieces';
    const byProduct = new Map();
    for (const s of shares) {
      const cur = byProduct.get(s.product_id) || 0;
      byProduct.set(s.product_id, cur + s.amount_rial);
      db.prepare(`
        INSERT INTO cutting_batch_allocations (batch_id, product_id, weight, amount_rial, basis)
        VALUES (?,?,?,?,?)
      `).run(batchId, s.product_id, s.weight, s.amount_rial, allocBasis);
    }
    db.prepare(`
      UPDATE cutting_lays SET journal_id=?, waste_journal_id=?, amount_rial=?, waste_amount_rial=?, unit_cost_rial=?
      WHERE id=?
    `).run(journalId, wasteJe, common + lossRial, lossRial, plan.laid_m > 0 ? Math.round(common / plan.laid_m) : 0, layId);
    db.prepare('UPDATE cutting_batches SET journal_id=?, waste_journal_id=?, lay_id=?, common_rial=? WHERE id=?')
      .run(journalId, wasteJe, layId, common, batchId);
    let stageBind = null;
    if (poId) {
      try {
        const { applyCuttingLayToStage } = require('./engine-advanced');
        stageBind = applyCuttingLayToStage(db, {
          orderId: poId,
          layId,
          layNo,
          fabricProductId: body.fabric_product_id,
          amountRial: common,
          wasteAmountRial: lossRial,
          qtyPieces: plan.outputs.reduce((s, o) => s + o.planned_pieces, 0),
          meters: plan.laid_m,
          date,
          userId: user && user.id,
        });
      } catch (e) {
        if (e && e.code && String(e.code).startsWith('E_')) throw e;
        // سفارش غیرپیشرفته: فقط پیوند production_order_id کافی است
      }
    }
    const posted = getSharedCut(db, batchId);
    if (stageBind) posted.stage_bind = stageBind;
    return posted;
  })();
}

function getSharedCut(db, id) {
  const batch = db.prepare('SELECT * FROM cutting_batches WHERE id=?').get(Number(id));
  if (!batch) throw httpErr(404, 'برنامه برش یافت نشد', 'E_BATCH');
  batch.policy = JSON.parse(batch.policy_json || '{}');
  batch.outputs = db.prepare('SELECT * FROM cutting_batch_outputs WHERE batch_id=? ORDER BY id').all(batch.id);
  batch.allocations = db.prepare('SELECT * FROM cutting_batch_allocations WHERE batch_id=? ORDER BY id').all(batch.id);
  batch.rolls = batch.lay_id
    ? db.prepare('SELECT * FROM cutting_lay_rolls WHERE lay_id=? ORDER BY id').all(batch.lay_id)
    : [];
  batch.packs = batch.lay_id
    ? db.prepare("SELECT * FROM cutting_packs WHERE lay_id=? AND status='posted'").all(batch.lay_id)
    : [];
  if (batch.lay_id) {
    const lay = db.prepare('SELECT lay_no, status FROM cutting_lays WHERE id=?').get(batch.lay_id);
    if (lay) {
      batch.lay_no = lay.lay_no;
      batch.lay_status = lay.status;
    }
  }
  return batch;
}

/** Reverse JE/stock/packs/rolls. Caller must be inside a transaction when used by amend. */
function reverseSharedCutEffects(db, batch, user, reason) {
  const lay = db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(batch.lay_id);
  if (lay && (lay.stage_id || lay.production_order_id)) {
    try {
      const { unlinkCuttingLayFromStage } = require('./engine-advanced');
      unlinkCuttingLayFromStage(db, {
        orderId: lay.production_order_id,
        layId: lay.id,
        layNo: lay.lay_no,
        amountRial: lay.amount_rial,
        wasteAmountRial: lay.waste_amount_rial,
        userId: user && user.id,
        date: lay.date,
      });
    } catch (e) {
      if (e && (e.code === 'E_ORDER_FINALIZED' || e.code === 'E_CANNOT_REVERSE' || e.code === 'E_INVALID_STATUS')) {
        // مراحل بعدی جلوتر رفته‌اند یا سفارش نهایی شده — فقط JE/طاقه؛ مرحله باز نمی‌شود
        try {
          db.prepare('UPDATE cutting_lays SET stage_id=NULL WHERE id=?').run(lay.id);
        } catch (_) { /* ignore */ }
      } else if (e && e.code && String(e.code).startsWith('E_')) {
        throw e;
      }
    }
  }
  const packs = batch.packs && batch.packs.length
    ? batch.packs
    : (batch.lay_id
      ? db.prepare("SELECT * FROM cutting_packs WHERE lay_id=? AND COALESCE(status,'posted')='posted'").all(batch.lay_id)
      : []);
  for (const pack of packs) {
    // PACK WIP مشترک معمولاً بدون ledger/JE است — فقط وضعیت. با ledger، معکوس موجودی بدون تراکنش تو در تو.
    if (pack.ledger_id) {
      reverseInventoryMovement(db, pack.ledger_id, {
        createdBy: user && user.id,
        note: reason || 'ابطال PACK برش مشترک',
      });
    }
    if (pack.journal_id) {
      const { reverseJournalEntry } = require('../void-journal');
      reverseJournalEntry(db, pack.journal_id, {
        userId: user && user.id,
        reason: reason || 'ابطال PACK برش مشترک',
        sourceType: 'production_receipt_reversal',
      });
    }
    db.prepare("UPDATE cutting_packs SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=? WHERE id=?")
      .run(user && user.id, pack.id);
  }
  const rolls = batch.rolls && batch.rolls.length
    ? batch.rolls
    : (batch.lay_id
      ? db.prepare("SELECT * FROM cutting_lay_rolls WHERE lay_id=? AND COALESCE(status,'posted')='posted'").all(batch.lay_id)
      : []);
  for (const roll of rolls) {
    if (String(roll.status || '') === 'reversed') continue;
    // مثل reverseCuttingLayEffects: معکوس ledger + بازگرداندن qty_on_hand
    if (roll.ledger_id) {
      try {
        reverseInventoryMovement(db, roll.ledger_id, { createdBy: user && user.id, note: reason || 'ابطال برش مشترک' });
      } catch (e) {
        if (!(e && e.code === 'E_ALREADY_REVERSED')) throw e;
      }
    }
    const issueM = Number(roll.meters) || 0;
    if (issueM) adjustBatchQty(db, roll.batch_id, issueM);
    if (Number(roll.extra_m) > 0) {
      if (roll.extra_ledger_id) {
        try {
          reverseInventoryMovement(db, roll.extra_ledger_id, { createdBy: user && user.id, note: reason || 'ابطال اضافه طاقه' });
        } catch (e) {
          if (!(e && e.code === 'E_ALREADY_REVERSED')) throw e;
        }
      }
      adjustBatchQty(db, roll.batch_id, -(Number(roll.extra_m) || 0));
    }
    if (roll.remnant_batch_id) {
      const remLedger = Number(roll.remnant_ledger_id) || (db.prepare(`
        SELECT id FROM inventory_ledger
        WHERE source_type='cutting_remnant' AND batch_id=? AND COALESCE(status,'posted')='posted'
        ORDER BY id DESC LIMIT 1
      `).get(roll.remnant_batch_id) || {}).id;
      if (remLedger) {
        reverseInventoryMovement(db, remLedger, { createdBy: user && user.id, note: reason || 'ابطال ته‌طاقه' });
      }
      adjustBatchQty(db, roll.remnant_batch_id, -(Number(roll.remnant_m) || 0));
      db.prepare("UPDATE inventory_batches SET status='reversed' WHERE id=?").run(roll.remnant_batch_id);
    }
    db.prepare("UPDATE cutting_lay_rolls SET status='reversed' WHERE id=?").run(roll.id);
  }
  const { reverseJournalEntry } = require('../void-journal');
  let revJe = null;
  if (lay && lay.extra_journal_id) {
    reverseJournalEntry(db, lay.extra_journal_id, {
      userId: user && user.id, reason: reason || 'ابطال اضافه طاقه', sourceType: 'cutting_roll_surplus_reversal',
    });
  }
  if (lay && lay.waste_journal_id) {
    reverseJournalEntry(db, lay.waste_journal_id, {
      userId: user && user.id, reason: reason || 'ابطال اتلاف', sourceType: 'production_waste_reversal',
    });
  }
  if (lay && lay.journal_id) {
    const rev = reverseJournalEntry(db, lay.journal_id, {
      userId: user && user.id, reason: reason || 'ابطال برش مشترک', sourceType: 'production_material_issue_reversal',
    });
    revJe = rev && (rev.id || rev.je_id || rev);
  }
  return { lay, revJe };
}

function voidSharedCut(db, id, user, reason) {
  const batch = getSharedCut(db, id);
  if (batch.status === 'reversed') throw httpErr(409, 'این برنامه قبلاً ابطال شده', 'E_CUT_REVERSED');
  db.transaction(() => {
    const { lay, revJe } = reverseSharedCutEffects(db, batch, user, reason);
    if (lay) {
      db.prepare(`UPDATE cutting_lays SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=?, reversal_journal_id=? WHERE id=?`)
        .run(user && user.id, revJe || null, lay.id);
    }
    db.prepare(`UPDATE cutting_batches SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=?, reversal_journal_id=? WHERE id=?`)
      .run(user && user.id, revJe || null, batch.id);
  })();
  return getSharedCut(db, id);
}

/**
 * W2 — ویرایش اتمی برش مشترک: reverse اثرات + ثبت مجدد روی همان batch/lay.
 * body مثل postSharedCut (outputs, rolls, allocation_basis, …).
 */
function amendSharedCut(db, id, body, user) {
  assertFlag(db);
  const existing = getSharedCut(db, id);
  if (existing.status === 'reversed') {
    throw httpErr(409, 'برنامه ابطال‌شده قابل ویرایش نیست', 'E_CUT_REVERSED');
  }
  const livePacks = (existing.packs || []).filter((p) => p.status === 'posted');
  for (const p of livePacks) {
    if (p.ledger_id || p.journal_id) {
      throw httpErr(409, 'ابتدا رسید محصول (PACK انبار) را ابطال کنید', 'E_CUT_HAS_PACK');
    }
  }
  if (body.marker_factor == null && Number(existing.marker_factor) > 0) {
    body = { ...body, marker_factor: existing.marker_factor };
  }
  const plan = previewSharedCut(db, body);
  if (!plan.balanced && !body.override_balance) {
    throw httpErr(400, 'تراز طاقه خارج از تلرانس است', 'E_ROLL_BALANCE', { errors: plan.errors });
  }
  const date = String(body.date || existing.date || todayJalali()).trim();
  const anchor = plan.outputs.slice().sort((a, b) => a.product_id - b.product_id)[0];
  const poId = Number(body.production_order_id != null ? body.production_order_id : (
    existing.lay_id && (db.prepare('SELECT production_order_id FROM cutting_lays WHERE id=?').get(existing.lay_id) || {}).production_order_id
  )) || null;
  if (poId) assertLayOrderOpen(db, poId);

  return db.transaction(() => {
    reverseSharedCutEffects(db, existing, user, body.reason || 'ویرایش برش مشترک');
    db.prepare('DELETE FROM cutting_batch_allocations WHERE batch_id=?').run(existing.id);
    db.prepare('DELETE FROM cutting_batch_outputs WHERE batch_id=?').run(existing.id);
    db.prepare('DELETE FROM cutting_packs WHERE lay_id=?').run(existing.lay_id);
    db.prepare('DELETE FROM cutting_lay_rolls WHERE lay_id=?').run(existing.lay_id);

    db.prepare(`
      UPDATE cutting_batches SET
        marker_length_m=?, width_cm=?, bom_id=?, fabric_product_id=?, policy_json=?,
        date=?, note=?, allocation_basis=?, status='posted',
        journal_id=NULL, waste_journal_id=NULL, common_rial=0,
        reversed_at=NULL, reversed_by=NULL, reversal_journal_id=NULL
      WHERE id=?
    `).run(
      plan.marker_length_m, Math.round(Number(body.width_cm) || 0),
      body.bom_id || null, body.fabric_product_id || null,
      JSON.stringify(plan.policy), date, String(body.note || existing.note || ''),
      plan.allocation_basis || 'pieces', existing.id
    );

    const insOut = db.prepare(`
      INSERT INTO cutting_batch_outputs
        (batch_id, product_id, size_code, pieces_per_ply, weight_pct, planned_pieces, accepted_plies, good_pieces, fabric_std_m)
      VALUES (?,?,?,?,?,?,?,?,?)
    `);
    for (const o of plan.outputs) {
      insOut.run(
        existing.id, o.product_id, o.size_code, o.pieces_per_ply, o.weight, o.planned_pieces, 0, o.planned_pieces,
        Number(o.fabric_std_m) || 0
      );
    }

    db.prepare(`
      UPDATE cutting_lays SET
        product_id=?, bom_id=?, fabric_product_id=?, marker_length_m=?, ply_count=?,
        planned_meters=?, actual_meters=?, qty_pieces=?, color=?, width_cm=?,
        production_order_id=?, date=?, note=?, status='posted',
        journal_id=NULL, waste_journal_id=NULL, extra_journal_id=NULL, amount_rial=0, waste_amount_rial=0, unit_cost_rial=0,
        reversed_at=NULL, reversed_by=NULL, reversal_journal_id=NULL, stage_id=NULL
      WHERE id=?
    `).run(
      anchor.product_id, body.bom_id || null, body.fabric_product_id || null,
      plan.marker_length_m, plan.rolls.reduce((s, r) => s + r.ply_count, 0),
      plan.planned_meters, plan.actual_meters, plan.outputs.reduce((s, o) => s + o.planned_pieces, 0),
      String(body.color || ''), Math.round(Number(body.width_cm) || 0),
      poId, date, String(body.note || ''), existing.lay_id
    );
    writeLayMeters(db, existing.lay_id, plan);

    const layId = existing.lay_id;
    const batchId = existing.id;
    let common = 0;
    let lossRial = 0;
    let extraRial = 0;
    const whRaw = warehouseByCode(db, 'WH-RAW', 'production_wh_raw_id');
    const whRem = warehouseByCode(db, 'WH-SCRAP', 'production_wh_remnant_id');
    for (const roll of plan.rolls) {
      const fabBatch = db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(roll.batch_id);
      if (!fabBatch) throw httpErr(400, 'طاقه یافت نشد', 'E_CUT_ROLL');
      const busy = db.prepare(`
        SELECT r.id FROM cutting_lay_rolls r
        JOIN cutting_lays l ON l.id=r.lay_id
        WHERE r.batch_id=? AND r.status='posted' AND l.status='posted' AND l.id<>?
      `).get(fabBatch.id, layId);
      if (busy) throw httpErr(409, 'این طاقه روی لایهٔ باز دیگری مصرف شده است', 'E_ROLL_BUSY');
      applyLiveRollQty(db, fabBatch);
      const avail = availableBatchMeters(db, fabBatch.id);
      const issueM = roundM(roll.laid_m + roll.length_loss_m + roll.remnant_m);
      const extraNeed = roundM(roll.extra_m || 0);
      // تسهیم/برگشت روی طاقه در leave قدیمی گاهی از avail بزرگ‌تر می‌شود؛ ملاک مصرف واقعی است
      if (avail + extraNeed + 1e-6 < issueM) {
        throw httpErr(409, `مانده طاقه (${plan.unit_name || 'متر'}) کافی نیست`, 'E_CUT_ROLL_QTY', { avail, need: issueM, extra_m: extraNeed, batch_id: fabBatch.id });
      }
      const unit = avgUnitRial(db, fabBatch.product_id);
      const surplus = bookRollSurplus(db, {
        batch: fabBatch, extraM: extraNeed, unit, layId, date, user, batchNo: existing.batch_no,
      });
      extraRial += surplus.extra_rial;
      const laidRial = assertSafeRial(Math.round(unit * roll.laid_m), 'laid');
      const lossPart = assertSafeRial(Math.round(unit * roll.length_loss_m), 'loss');
      common += laidRial;
      lossRial += lossPart;
      let ledgerId = null;
      if (issueM > 0) {
        const led = postInventoryMovement(db, {
          eventType: 'production_issue',
          productId: fabBatch.product_id,
          warehouseId: fabBatch.warehouse_id || (whRaw && whRaw.id),
          qtyOut: issueM,
          unitCostRial: unit,
          amountRial: assertSafeRial(Math.round(unit * issueM), 'issue'),
          sourceType: 'cutting_lay',
          sourceId: layId,
          batchId: fabBatch.id,
          date,
          note: `برش مشترک اصلاح ${existing.batch_no}`,
          createdBy: user && user.id,
        });
        ledgerId = led && led.id;
        adjustBatchQty(db, fabBatch.id, -issueM);
      }
      let remnantBatchId = null;
      let remnantLedgerId = null;
      if (roll.remnant_m > 0) {
        if (!whRem) throw httpErr(400, 'انبار ته‌طاقه تنظیم نشده', 'E_REMNANT_WH');
        const ins = db.prepare(`
          INSERT INTO inventory_batches
            (batch_no, product_id, warehouse_id, qty_on_hand, qty_received, status, kind, color, width_cm, unit, unit_cost_rial, source_type, source_id, note)
          VALUES (?,?,?,?,?,'active','fabric',?,?, ?, ?, 'cutting_remnant', ?, ?)
        `).run(
          `${existing.batch_no}-R`, fabBatch.product_id, whRem.id, roll.remnant_m, roll.remnant_m,
          existing.color || body.color || '', Math.round(Number(body.width_cm) || 0), fabBatch.unit || 'm', unit, batchId, 'ته‌طاقه'
        );
        remnantBatchId = ins.lastInsertRowid;
        const remLed = postInventoryMovement(db, {
          eventType: 'production_receipt',
          productId: fabBatch.product_id,
          warehouseId: whRem.id,
          qtyIn: roll.remnant_m,
          unitCostRial: unit,
          amountRial: assertSafeRial(Math.round(unit * roll.remnant_m), 'remnant'),
          sourceType: 'cutting_remnant',
          sourceId: batchId,
          batchId: remnantBatchId,
          date,
          note: `ته‌طاقه ${existing.batch_no}`,
          createdBy: user && user.id,
        });
        remnantLedgerId = remLed && remLed.id;
      }
      db.prepare(`
        INSERT INTO cutting_lay_rolls
          (lay_id, batch_id, meters, unit_cost_rial, amount_rial, ledger_id, status,
           opening_m, ply_count, laid_m, returned_m, remnant_m, length_loss_m, adjustment_m, destination, remnant_batch_id, remnant_ledger_id, extra_m, extra_ledger_id)
        VALUES (?,?,?,?,?,?,'posted',?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        layId, fabBatch.id, issueM, unit, laidRial + lossPart, ledgerId,
        roll.opening_m, roll.ply_count, roll.laid_m, roll.returned_m, roll.remnant_m,
        roll.length_loss_m, roll.adjustment_m, roll.destination, remnantBatchId, remnantLedgerId,
        surplus.extra_m, surplus.extra_ledger_id
      );
    }
    common = assertSafeRial(common, 'common');
    {
      const split = splitAbnormalLaid(common, plan);
      common = split.common;
      lossRial += split.abnormal;
    }
    const cutCc = resolveCuttingCostCenterId(db, {
      explicitId: body.cost_center_id,
      bomId: body.bom_id,
      warehouseId: whRaw && whRaw.id,
    });
    db.prepare('UPDATE cutting_lays SET cost_center_id=? WHERE id=?').run(cutCc, layId);
    assertJournalIdempotent(db, 'production_material_issue', layId);
    let journalId = null;
    if (common > 0) {
      const je = postEvent(db, {
        event: 'PRD-01',
        sourceId: layId,
        date,
        description: `مصرف خالص برش مشترک (ویرایش) ${existing.batch_no}`,
        createdBy: user && user.id,
        costCenterId: cutCc,
        warehouseId: whRaw && whRaw.id,
        lines: [dr(db, 'coa_wip', common), cr(db, 'coa_raw_materials', common)],
      });
      journalId = je ? je.je_id : null;
    }
    let wasteJe = null;
    if (lossRial > 0) {
      assertJournalIdempotent(db, 'production_waste', layId);
      const wje = postEvent(db, {
        event: 'PRD-09',
        sourceId: layId,
        date,
        description: `اتلاف طولی برش (ویرایش) ${existing.batch_no}`,
        createdBy: user && user.id,
        lines: [dr(db, 'coa_abnormal_waste', lossRial), cr(db, 'coa_raw_materials', lossRial)],
        costCenterId: cutCc,
        warehouseId: whRaw && whRaw.id,
      });
      wasteJe = wje ? wje.je_id : null;
    }
    if (extraRial > 0) {
      assertJournalIdempotent(db, 'cutting_roll_surplus', layId);
      const eje = postEvent(db, {
        event: 'PRD-18',
        sourceId: layId,
        date,
        description: `اضافه طاقه برش (ویرایش) ${existing.batch_no}`,
        createdBy: user && user.id,
        lines: [dr(db, 'coa_raw_materials', extraRial), cr(db, 'coa_var_material_qty', extraRial)],
        costCenterId: cutCc,
        warehouseId: whRaw && whRaw.id,
      });
      const extraJe = eje ? eje.je_id : null;
      if (extraJe) db.prepare('UPDATE cutting_lays SET extra_journal_id=? WHERE id=?').run(extraJe, layId);
    }
    const shares = allocateRial(common, plan.outputs.map((o) => ({
      product_id: o.product_id, size_code: o.size_code, weight: o.weight,
    })));
    const allocBasis = plan.allocation_basis || 'pieces';
    const byProduct = new Map();
    for (const s of shares) {
      const cur = byProduct.get(s.product_id) || 0;
      byProduct.set(s.product_id, cur + s.amount_rial);
      db.prepare(`
        INSERT INTO cutting_batch_allocations (batch_id, product_id, weight, amount_rial, basis)
        VALUES (?,?,?,?,?)
      `).run(batchId, s.product_id, s.weight, s.amount_rial, allocBasis);
    }
    db.prepare(`
      UPDATE cutting_lays SET journal_id=?, waste_journal_id=?, amount_rial=?, waste_amount_rial=?, unit_cost_rial=?
      WHERE id=?
    `).run(journalId, wasteJe, common + lossRial, lossRial, plan.laid_m > 0 ? Math.round(common / plan.laid_m) : 0, layId);
    db.prepare('UPDATE cutting_batches SET journal_id=?, waste_journal_id=?, common_rial=? WHERE id=?')
      .run(journalId, wasteJe, common, batchId);
    let stageBind = null;
    if (poId) {
      try {
        const { applyCuttingLayToStage } = require('./engine-advanced');
        const layRow = db.prepare('SELECT lay_no FROM cutting_lays WHERE id=?').get(layId);
        stageBind = applyCuttingLayToStage(db, {
          orderId: poId,
          layId,
          layNo: layRow && layRow.lay_no,
          fabricProductId: body.fabric_product_id,
          amountRial: common,
          wasteAmountRial: lossRial,
          qtyPieces: plan.outputs.reduce((s, o) => s + o.planned_pieces, 0),
          meters: plan.laid_m,
          date,
          userId: user && user.id,
        });
      } catch (e) {
        if (e && e.code && String(e.code).startsWith('E_')) throw e;
      }
    }
    const amended = getSharedCut(db, batchId);
    if (stageBind) amended.stage_bind = stageBind;
    return amended;
  })();
}

function listPersonLaborConflicts(db) {
  return db.prepare(`
    SELECT id, person_id, ref_id, credit, date
    FROM person_ledger
    WHERE ref_type='production_labor' AND COALESCE(credit,0) > 0
    ORDER BY id
  `).all();
}

function periodChecks(db, period) {
  const checks = [];
  let unbalanced = 0;
  try {
    const tol = Number(setting(db, 'production_roll_balance_tolerance_m', '0.01'));
    const rows = db.prepare(`
      SELECT r.* FROM cutting_lay_rolls r
      JOIN cutting_lays l ON l.id=r.lay_id
      WHERE r.status='posted' AND l.status='posted' AND l.batch_id IS NOT NULL
    `).all();
    unbalanced = rows.filter((r) => !rollEquation(r, tol).ok).length;
  } catch (_) { unbalanced = 0; }
  checks.push({
    code: 'ROLL_BALANCE',
    status: unbalanced ? 'fail' : 'pass',
    severity: 'error',
    message: unbalanced ? `${unbalanced} طاقهٔ نامتوازن` : 'تراز طاقه‌های برش مشترک برقرار است',
  });

  let missingRates = [];
  try {
    const used = db.prepare(`
      SELECT DISTINCT cost_center_id AS id FROM production_overhead_applications
      WHERE period_label=? AND COALESCE(status,'posted')<>'reversed' AND cost_center_id IS NOT NULL
      UNION
      SELECT DISTINCT cost_center_id AS id FROM production_labor_entries
      WHERE period_label=? AND COALESCE(status,'posted')<>'reversed' AND cost_center_id IS NOT NULL
    `).all(period);
    for (const u of used) {
      const hit = db.prepare('SELECT id FROM cost_center_rates WHERE cost_center_id=? AND period_label=?').get(u.id, period);
      if (!hit) missingRates.push(u.id);
    }
  } catch (_) { missingRates = []; }
  checks.push({
    code: 'RATES_FOR_USED_CENTERS',
    status: missingRates.length ? 'fail' : 'pass',
    severity: 'error',
    message: missingRates.length ? `نرخ دوره برای مراکز ${missingRates.join(',')} نیست` : 'نرخ مراکز استفاده‌شده موجود است',
  });

  let dupFail = false;
  try {
    const dups = db.prepare(`
      SELECT account_code, SUM(absorb_pct) pct, COUNT(*) c
      FROM cost_center_account_maps
      WHERE COALESCE(active,1)=1
      GROUP BY account_code
      HAVING c > 1 AND SUM(absorb_pct) > 100.001
    `).all();
    dupFail = dups.length > 0;
  } catch (_) { dupFail = false; }
  checks.push({
    code: 'SHARED_MOEIN',
    status: dupFail ? 'fail' : 'pass',
    severity: 'error',
    message: dupFail ? 'همان معین در چند مرکز بیش از ۱۰۰٪ جذب می‌شود' : 'جذب معین مشترک از ۱۰۰٪ بیشتر نیست',
  });
  return checks;
}

module.exports = {
  roundM,
  remnantThreshold,
  classifyUsableRemaining,
  rollEquation,
  previewRolls,
  plannedPieces,
  allocateRial,
  normalizeAllocationBasis,
  weightsToBps,
  blendHybridWeights,
  normalizeOutputs,
  loadPolicy,
  previewSharedCut,
  postSharedCut,
  getSharedCut,
  reverseSharedCutEffects,
  voidSharedCut,
  amendSharedCut,
  listPersonLaborConflicts,
  periodChecks,
};
