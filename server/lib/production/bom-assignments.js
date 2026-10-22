'use strict';
/**
 * BOM material assignments to operations + color×size allowlist (PA-04 / F19–F21).
 */
const { err } = require('./posting');

const ALLOCATION_MODES = new Set(['sole', 'shared']);
// same vocabulary as bom.js normalizeColorMode()
const COMPONENT_COLOR_MODES = new Set(['none', 'inherit_fg', 'fixed']);

/** bom_lines/bom_operations are trigger-locked on active BOMs — allowed-variants follow. */
function assertBomUnlocked(db, bomId) {
  const bom = db.prepare('SELECT id, status, product_id FROM bom_headers WHERE id=?').get(bomId);
  if (!bom) throw err('E_NOT_FOUND', 404, { bomId });
  if (bom.status === 'active') throw err('E_BOM_LOCKED', 409, { bomId });
  return bom;
}

/**
 * v527 — material→operation links change only WHICH stage issues a line (never qty/cost),
 * so they stay editable on an active BOM. Archived/deleted formulas are frozen.
 */
function assertBomAssignable(db, bomId) {
  const bom = db.prepare('SELECT id, status, product_id FROM bom_headers WHERE id=? AND deleted_at IS NULL').get(bomId);
  if (!bom) throw err('E_NOT_FOUND', 404, { bomId });
  if (!['draft', 'active'].includes(String(bom.status || ''))) {
    throw err('E_BOM_ASSIGN_LOCKED', 409, { bomId, status: bom.status });
  }
  return bom;
}

/** روش ساده و مستقل از engine: عملیات برش = مرکز CC-10 یا نام «برش». */
function isCuttingOperation(db, op) {
  if (!op) return false;
  if (/برش|\bCUT\b/i.test(String(op.operation_name || ''))) return true;
  const cc = op.cost_center_id
    ? db.prepare('SELECT code, name FROM cost_centers WHERE id=?').get(op.cost_center_id)
    : null;
  return !!(cc && (String(cc.code) === 'CC-10' || /برش/.test(String(cc.name || ''))));
}

/**
 * v527 — strict routing: every BOM line of a routed formula must resolve to one operation
 * (explicit assignment, or legacy stage_cost_center_id that matches an operation of this BOM).
 * Returns the lines that resolve to nothing. Empty when the BOM has no operations.
 */
function unassignedBomLines(db, bomId) {
  const hasOps = db.prepare('SELECT 1 FROM bom_operations WHERE bom_id=? LIMIT 1').get(bomId);
  if (!hasOps) return [];
  const lines = db.prepare(`
    SELECT bl.id, bl.line_no, bl.component_product_id, bl.line_type, bl.product_scope,
           bl.scoped_product_id, bl.stage_cost_center_id, bl.qty_per_base, p.name AS product_name
    FROM bom_lines bl
    LEFT JOIN products p ON p.id = bl.component_product_id
    WHERE bl.bom_id=?
    ORDER BY bl.line_no, bl.id
  `).all(bomId);
  const out = [];
  for (const L of lines) {
    if (operationIdForLine(db, bomId, L.id) != null) continue;
    out.push({
      bom_line_id: L.id,
      line_no: L.line_no,
      component_product_id: L.component_product_id,
      name: L.product_name || ('#' + L.component_product_id),
      line_type: L.line_type || 'material',
      product_scope: L.product_scope || 'shared',
      scoped_product_id: L.scoped_product_id || null,
      qty_per_base: L.qty_per_base,
    });
  }
  return out;
}

function unassignedLinesMessage(rows) {
  const names = (rows || []).map(r => `«${r.name}»${r.line_no != null ? ` (قلم ${r.line_no})` : ''}`);
  return 'این اقلام فرمول به هیچ عملیاتی وصل نیستند و روی هیچ مرحله‌ای حواله نمی‌شوند: '
    + names.join('، ')
    + '. در تب «مسیر عملیات» → «مواد را به عملیات وصل کنید» هر قلم را به عملیات مصرف‌کننده وصل کنید.';
}

function listAssignments(db, bomId) {
  return db.prepare(`
    SELECT a.*, bl.component_product_id, bl.qty_per_base, bl.line_no,
           bl.line_type, bl.stage_cost_center_id,
           op.seq AS operation_seq, op.operation_name, op.cost_center_id
    FROM bom_material_assignments a
    JOIN bom_lines bl ON bl.id = a.bom_line_id
    JOIN bom_operations op ON op.id = a.operation_id
    WHERE a.bom_id=?
    ORDER BY op.seq, bl.line_no, a.id
  `).all(bomId);
}

function listAllowedVariants(db, bomId) {
  return db.prepare(`
    SELECT * FROM bom_allowed_variants WHERE bom_id=? ORDER BY color_id, size_id, id
  `).all(bomId);
}

function assertSameBom(db, bomId, bomLineId, operationId) {
  const line = db.prepare('SELECT id, bom_id FROM bom_lines WHERE id=?').get(bomLineId);
  if (!line || Number(line.bom_id) !== Number(bomId)) {
    throw err('E_BOM_LINE_MISMATCH', 422, { bomLineId, bomId });
  }
  const op = db.prepare('SELECT id, bom_id FROM bom_operations WHERE id=?').get(operationId);
  if (!op || Number(op.bom_id) !== Number(bomId)) {
    throw err('E_BOM_OP_MISMATCH', 422, { operationId, bomId });
  }
}

/**
 * Replace all assignments for a BOM atomically.
 * body.assignments: [{ bom_line_id, operation_id, allocation_mode, share_percent, qty_override, ...}]
 */
function normalizeAssignment(a) {
  const mode = String(a.allocation_mode || 'sole').toLowerCase().trim();
  if (!ALLOCATION_MODES.has(mode)) {
    throw err('E_ASSIGN_MODE', 422, { allocation_mode: a.allocation_mode });
  }
  let share = null;
  if (mode === 'shared') {
    share = Number(a.share_percent);
    // a negative share would let 150/−50 pass the ≈100 sum check
    if (!Number.isFinite(share) || share <= 0 || share > 100) {
      throw err('E_SHARE_RANGE', 422, { share_percent: a.share_percent });
    }
  }
  let qtyOverride = null;
  if (a.qty_override != null && a.qty_override !== '') {
    qtyOverride = Number(a.qty_override);
    if (!Number.isFinite(qtyOverride) || qtyOverride < 0) {
      throw err('E_ASSIGN_QTY', 422, { qty_override: a.qty_override });
    }
  }
  const colorMode = String(a.component_color_mode || 'none').toLowerCase().trim();
  if (!COMPONENT_COLOR_MODES.has(colorMode)) {
    throw err('E_ASSIGN_COLOR_MODE', 422, { component_color_mode: a.component_color_mode });
  }
  const colorId = a.component_color_id != null && a.component_color_id !== ''
    ? Number(a.component_color_id)
    : null;
  if (colorMode === 'fixed' && !(colorId > 0)) throw err('E_BOM_COMP_COLOR', 422);
  return { mode, share, qtyOverride, colorMode, colorId: colorId || null, note: String(a.note || '') };
}

function replaceAssignments(db, bomId, assignments, userId = null) {
  const bom = assertBomAssignable(db, bomId);

  const rows = Array.isArray(assignments) ? assignments : [];

  // ── validate the whole payload before touching the table ──
  const prepared = [];
  const byLine = new Map();
  const seen = new Set();
  for (const a of rows) {
    const lineId = Number(a.bom_line_id);
    const opId = Number(a.operation_id);
    if (!(lineId > 0) || !(opId > 0)) throw err('E_ASSIGN_ARGS', 422);
    const pair = `${lineId}:${opId}`;
    if (seen.has(pair)) {
      throw err('E_ASSIGN_DUPLICATE', 422, { bom_line_id: lineId, operation_id: opId });
    }
    seen.add(pair);
    assertSameBom(db, bomId, lineId, opId);
    const row = { lineId, opId, ...normalizeAssignment(a) };
    prepared.push(row);
    if (!byLine.has(lineId)) byLine.set(lineId, []);
    byLine.get(lineId).push(row);
  }
  for (const [lineId, group] of byLine) {
    const sharedRows = group.filter(g => g.mode === 'shared');
    // A line split across several operations must be fully shared, otherwise the
    // same material amount is attributed 100% to each operation (double count).
    if (group.length > 1 && sharedRows.length !== group.length) {
      throw err('E_ASSIGN_MODE', 422, { bom_line_id: lineId, operations: group.length });
    }
    if (!sharedRows.length) continue;
    const sum = sharedRows.reduce((s, g) => s + g.share, 0);
    if (Math.abs(sum - 100) > 0.05) {
      throw err('E_SHARE_SUM', 422, { bom_line_id: lineId, share_sum: sum });
    }
  }

  const ins = db.prepare(`
    INSERT INTO bom_material_assignments (
      bom_id, bom_line_id, operation_id, allocation_mode, share_percent, qty_override,
      component_color_mode, component_color_id, note
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `);
  db.transaction(() => {
    const before = db.prepare(`
      SELECT bom_line_id, operation_id, allocation_mode, share_percent
      FROM bom_material_assignments WHERE bom_id=? ORDER BY bom_line_id, operation_id
    `).all(bomId);
    db.prepare('DELETE FROM bom_material_assignments WHERE bom_id=?').run(bomId);
    for (const r of prepared) {
      ins.run(bomId, r.lineId, r.opId, r.mode, r.share, r.qtyOverride, r.colorMode, r.colorId, r.note);
    }
    // v527: on an active formula this is a real change of the issue routing — keep an audit trail.
    if (bom.status === 'active') {
      try {
        require('./bom').logBomChange(db, bomId, 'assignments_replace', {
          entity: 'assignments',
          before,
          after: prepared.map(r => ({
            bom_line_id: r.lineId, operation_id: r.opId, allocation_mode: r.mode, share_percent: r.share,
          })),
        }, userId);
      } catch (_) { /* audit must not block the change itself */ }
    }
  })();
  return listAssignments(db, bomId);
}

/**
 * Seed sole assignments from stage_cost_center_id → earliest op in that CC (migration helper).
 * Ambiguous multi-op CCs are skipped (returned in report).
 */
function backfillAssignmentsFromStageCc(db, bomId, userId = null) {
  assertBomAssignable(db, bomId);
  const ops = db.prepare('SELECT * FROM bom_operations WHERE bom_id=? ORDER BY seq, id').all(bomId);
  const byCc = new Map();
  for (const op of ops) {
    const k = Number(op.cost_center_id);
    if (!byCc.has(k)) byCc.set(k, []);
    byCc.get(k).push(op);
  }
  const cutOp = ops.find(op => isCuttingOperation(db, op)) || null;
  const lines = db.prepare('SELECT * FROM bom_lines WHERE bom_id=?').all(bomId);
  // v527: keep what is already linked explicitly — backfill only fills the gaps.
  const existing = listAssignments(db, bomId);
  const linkedLineIds = new Set(existing.map(a => Number(a.bom_line_id)));
  const assignments = existing.map(a => ({
    bom_line_id: a.bom_line_id, operation_id: a.operation_id,
    allocation_mode: a.allocation_mode || 'sole', share_percent: a.share_percent,
    qty_override: a.qty_override, component_color_mode: a.component_color_mode,
    component_color_id: a.component_color_id, note: a.note,
  }));
  const ambiguous = [];
  let added = 0;
  const push = (lineId, opId) => {
    assignments.push({ bom_line_id: lineId, operation_id: opId, allocation_mode: 'sole' });
    added += 1;
  };
  let isRoll = null;
  try { isRoll = require('./cutting').isRollFabricProduct; } catch (_) { isRoll = null; }
  for (const L of lines) {
    if (linkedLineIds.has(Number(L.id))) continue;
    const cc = L.stage_cost_center_id != null ? Number(L.stage_cost_center_id) : null;
    if (cc == null) {
      if (ops.length === 1) {
        push(L.id, ops[0].id);
      } else if (cutOp && isRoll && isRoll(db, Number(L.component_product_id))) {
        // پارچهٔ طاقه‌ای فقط در برش (لایه‌چینی) مصرف می‌شود
        push(L.id, cutOp.id);
      } else {
        ambiguous.push({ bom_line_id: L.id, reason: 'no_stage_cc' });
      }
      continue;
    }
    const list = byCc.get(cc) || [];
    if (list.length === 1) {
      push(L.id, list[0].id);
    } else if (list.length === 0) {
      ambiguous.push({ bom_line_id: L.id, reason: 'cc_not_in_routing', cc });
    } else {
      ambiguous.push({ bom_line_id: L.id, reason: 'multi_op_cc', cc, ops: list.map(o => o.id) });
    }
  }
  if (added) replaceAssignments(db, bomId, assignments, userId);
  return { assigned: added, kept: existing.length, ambiguous, unassigned: unassignedBomLines(db, bomId) };
}

function replaceAllowedVariants(db, bomId, variants) {
  const bom = assertBomUnlocked(db, bomId);
  const rows = Array.isArray(variants) ? variants : [];
  // Resolve before the delete so a bad payload cannot wipe the existing allowlist.
  const resolved = [];
  const seen = new Set();
  for (const v of rows) {
    const colorId = v.color_id != null && v.color_id !== '' ? Number(v.color_id) : null;
    const sizeId = v.size_id != null && v.size_id !== '' ? Number(v.size_id) : null;
    let variantId = v.variant_id != null && v.variant_id !== '' ? Number(v.variant_id) : null;
    if ((colorId !== null && !(colorId > 0))
      || (sizeId !== null && !(sizeId > 0))
      || (variantId !== null && !(variantId > 0))) {
      throw err('E_VARIANT_ARGS', 422, { color_id: v.color_id, size_id: v.size_id, variant_id: v.variant_id });
    }
    if (variantId) {
      // an explicit variant from another product would silently widen that BOM's domain
      const owned = db.prepare('SELECT id FROM product_variants WHERE id=? AND product_id=?')
        .get(variantId, bom.product_id);
      if (!owned) {
        throw err('E_VARIANT_PRODUCT_MISMATCH', 422, { variant_id: variantId, product_id: bom.product_id });
      }
    }
    if (!variantId && colorId && sizeId) {
      const found = db.prepare(`
        SELECT id FROM product_variants
        WHERE product_id=? AND color_id=? AND size_id=? AND COALESCE(active,1)=1
        LIMIT 1
      `).get(bom.product_id, colorId, sizeId);
      variantId = found?.id || null;
    }
    if (!colorId && !sizeId && !variantId) continue;
    // ux_bav_tuple does not dedupe NULL members in SQLite — dedupe here.
    const k = `${colorId ?? ''}|${sizeId ?? ''}|${variantId ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    resolved.push([colorId, sizeId, variantId, v.is_allowed == null || v.is_allowed ? 1 : 0]);
  }

  const ins = db.prepare(`
    INSERT INTO bom_allowed_variants (bom_id, color_id, size_id, variant_id, is_allowed)
    VALUES (?,?,?,?,?)
  `);
  db.transaction(() => {
    db.prepare('DELETE FROM bom_allowed_variants WHERE bom_id=?').run(bomId);
    for (const r of resolved) ins.run(bomId, r[0], r[1], r[2], r[3]);
  })();
  return listAllowedVariants(db, bomId);
}

/**
 * Resolve which operation owns a bom_line for explode/issue.
 * Prefer explicit assignment; fall back to stage_cost_center first-op (legacy).
 */
function operationIdForLine(db, bomId, bomLineId) {
  const a = db.prepare(`
    SELECT a.operation_id
    FROM bom_material_assignments a
    JOIN bom_operations op ON op.id = a.operation_id
    WHERE a.bom_id=? AND a.bom_line_id=?
    ORDER BY CASE WHEN a.allocation_mode='sole' THEN 0 ELSE 1 END,
             COALESCE(a.share_percent, 0) DESC, op.seq, a.id
    LIMIT 1
  `).get(bomId, bomLineId);
  if (a) return Number(a.operation_id);
  const legacy = db.prepare(`
    SELECT op.id
    FROM bom_lines bl
    JOIN bom_operations op ON op.bom_id = bl.bom_id AND op.cost_center_id = bl.stage_cost_center_id
    WHERE bl.id=? AND bl.bom_id=?
    ORDER BY op.seq, op.id
    LIMIT 1
  `).get(bomLineId, bomId);
  return legacy ? Number(legacy.id) : null;
}

/**
 * Explicit assignments only. Empty Map → callers must use stage_cost_center_id legacy path.
 * Do NOT auto-fill legacy here: a non-empty Map would skip bom-advanced fallback forever.
 */
function materialsByOperation(db, bomId) {
  const assigned = listAssignments(db, bomId);
  const map = new Map();
  for (const a of assigned) {
    const k = Number(a.operation_id);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(a);
  }
  return map;
}

module.exports = {
  listAssignments,
  listAllowedVariants,
  replaceAssignments,
  replaceAllowedVariants,
  backfillAssignmentsFromStageCc,
  operationIdForLine,
  materialsByOperation,
  assertBomAssignable,
  unassignedBomLines,
  unassignedLinesMessage,
  isCuttingOperation,
};
