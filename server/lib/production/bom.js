'use strict';
/**
 * Production Module 1 — BOM (Bill of Materials)
 * No ledger posting (master data only).
 */
const { allocateNumber, audit } = require('../../db');
const { todayJalali, addDaysToJalali } = require('../../jalali');

function err(code, status = 422, extra = {}) {
  const e = new Error(code);
  e.code = code;
  e.status = status;
  e.extra = extra;
  return e;
}

function nowUnix() { return Math.floor(Date.now() / 1000); }

function round6(n) {
  return Math.round(Number(n) * 1e6) / 1e6;
}

function safeJson(s) {
  if (!s) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
}

function nextRev(rev) {
  if (!rev) return 'A';
  const c = String(rev).toUpperCase();
  if (c.length === 1 && c >= 'A' && c < 'Z') return String.fromCharCode(c.charCodeAt(0) + 1);
  return c + 'A';
}

function logBomChange(db, bomId, changeType, payload, userId) {
  db.prepare(`
    INSERT INTO bom_change_log (bom_id, change_type, entity, before_json, after_json, reason, date, created_by)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    bomId,
    changeType,
    payload.entity || 'header',
    payload.before ? JSON.stringify(payload.before) : '',
    payload.after ? JSON.stringify(payload.after) : JSON.stringify(payload),
    payload.reason || '',
    todayJalali(),
    userId || null
  );
}

function emit(db, eventType, payload) {
  try {
    db.prepare(`
      INSERT INTO production_events (event_type, entity_type, entity_id, payload_json)
      VALUES (?,?,?,?)
    `).run(eventType, 'bom', payload.bomId || payload.newBomId || null, JSON.stringify(payload));
  } catch { /* events table optional during early boot */ }
}

function availableQty(db, productId) {
  const p = db.prepare('SELECT stock FROM products WHERE id=?').get(productId);
  return Number(p?.stock) || 0;
}

function lastPurchasePrice(db, productId) {
  try {
    const row = db.prepare(`
      SELECT unit_price_rial FROM purchase_invoice_items
      WHERE product_id=? ORDER BY id DESC LIMIT 1
    `).get(productId);
    return row ? Number(row.unit_price_rial) || 0 : 0;
  } catch {
    return 0;
  }
}

function getPrice(db, productId, basis, line) {
  const p = db.prepare('SELECT average_cost_rial, std_cost_rial FROM products WHERE id=?').get(productId);
  switch (basis) {
    case 'std': return Number(line?.std_cost_rial || p?.std_cost_rial) || 0;
    case 'manual': return Number(line?.std_cost_rial) || 0;
    case 'last_purchase': return lastPurchasePrice(db, productId) || Number(p?.average_cost_rial) || 0;
    default: return Number(p?.average_cost_rial) || 0;
  }
}

function sumTotals(lines) {
  let material = 0, packaging = 0;
  for (const L of lines) {
    if (L.line_kind === 'packaging') packaging += L.amount_rial || 0;
    else material += L.amount_rial || 0;
  }
  return {
    material_rial: material,
    packaging_rial: packaging,
    total_rial: material + packaging,
  };
}

function nextBomVersion(db, productId) {
  const row = db.prepare(
    'SELECT COALESCE(MAX(version),0) m FROM bom_headers WHERE product_id=? AND deleted_at IS NULL'
  ).get(productId);
  return (row?.m || 0) + 1;
}

function resolveBom(db, { productId, date, preferredBomId = null, allowAlternative = false }) {
  if (preferredBomId) {
    const b = db.prepare('SELECT * FROM bom_headers WHERE id=? AND deleted_at IS NULL').get(preferredBomId);
    if (!b) throw err('E_NO_ACTIVE_BOM', 404);
    if (b.status !== 'active' && b.status !== 'archived') throw err('E_BOM_NOT_ACTIVE', 409);
    return b;
  }
  // Historical resolve: active OR archived covering the date (T1-06)
  const rows = db.prepare(`
    SELECT * FROM bom_headers
    WHERE product_id=? AND deleted_at IS NULL
      AND status IN ('active','archived')
      AND (valid_from='' OR valid_from IS NULL OR valid_from<=?)
      AND (valid_to='' OR valid_to IS NULL OR valid_to>=?)
      ${allowAlternative ? '' : "AND bom_type='standard'"}
    ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,
             is_default DESC, valid_from DESC, version DESC
  `).all(productId, date, date);
  if (!rows.length) throw err('E_NO_ACTIVE_BOM', 404, { productId, date });
  return rows[0];
}

function resolveSubstitutes(db, lines, factor, yieldF) {
  const groups = {}, plain = [];
  for (const L of lines) {
    if (L.substitute_group) (groups[L.substitute_group] ||= []).push(L);
    else plain.push(L);
  }
  const picked = [];
  for (const g of Object.values(groups)) {
    g.sort((a, b) => (a.substitute_priority || 0) - (b.substitute_priority || 0));
    let sel = g[0];
    for (const L of g) {
      const scrapF = 1 - (L.scrap_percent || 0) / 100;
      const need = scrapF > 0
        ? (L.qty_per_base * factor) / scrapF / yieldF
        : Infinity;
      const avail = availableQty(db, L.component_product_id);
      if (avail >= need) { sel = L; break; }
    }
    picked.push(sel);
  }
  return [...plain, ...picked].sort((a, b) => a.line_no - b.line_no);
}

function explodeBom(db, { bomId, qty, sizeBreakdown = null, priceBasis = 'average', level = 0, yieldOverride = null }) {
  if (level > 10) throw err('E_BOM_TOO_DEEP', 422);
  const bom = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
  if (!bom) throw err('E_NOT_FOUND', 404);
  const lines = db.prepare('SELECT * FROM bom_lines WHERE bom_id=? ORDER BY line_no').all(bomId);
  const factor = qty / (bom.base_qty || 1);
  const yieldPct = yieldOverride != null ? Number(yieldOverride) : (bom.yield_percent || 100);
  const yieldF = yieldPct / 100;
  if (yieldF <= 0) throw err('E_BOM_YIELD_RANGE', 422);
  const out = [];
  const chosen = resolveSubstitutes(db, lines, factor, yieldF);
  const breakdown = sizeBreakdown
    ? (typeof sizeBreakdown === 'string' ? safeJson(sizeBreakdown) : sizeBreakdown)
    : null;

  for (const L of chosen) {
    let qtyNet;
    const matrix = L.size_matrix ? safeJson(L.size_matrix) : null;
    if (matrix && breakdown) {
      qtyNet = Object.entries(breakdown).reduce((s, [size, cnt]) => {
        const per = matrix[size];
        if (per == null) return s + L.qty_per_base * Number(cnt);
        return s + Number(per) * Number(cnt);
      }, 0);
    } else if (Number(L.fixed_qty) > 0) {
      qtyNet = Number(L.fixed_qty);
    } else {
      qtyNet = Number(L.qty_per_base) * factor;
    }

    const scrapF = 1 - (Number(L.scrap_percent) || 0) / 100;
    if (scrapF <= 0) throw err('E_BOM_SCRAP_RANGE', 422);
    const qtyGross = qtyNet / scrapF;
    const qtyFinal = round6(qtyGross / yieldF);
    const unitCost = getPrice(db, L.component_product_id, priceBasis, L);
    out.push({
      line_no: L.line_no,
      bom_line_id: L.id,
      product_id: L.component_product_id,
      line_kind: L.line_type,
      stage_cost_center_id: L.stage_cost_center_id,
      qty_net: round6(qtyNet),
      qty_gross: round6(qtyGross),
      qty_final: qtyFinal,
      scrap_percent: L.scrap_percent,
      unit_cost_rial: unitCost,
      amount_rial: Math.round(qtyFinal * unitCost),
      level,
    });

    const comp = db.prepare('SELECT is_manufactured FROM products WHERE id=?').get(L.component_product_id);
    if (bom.is_multilevel && comp?.is_manufactured) {
      try {
        const childBom = resolveBom(db, { productId: L.component_product_id, date: todayJalali() });
        const child = explodeBom(db, {
          bomId: childBom.id, qty: qtyFinal, priceBasis, level: level + 1,
        });
        out.push(...child.lines.map(x => ({ ...x, parent_line_no: L.line_no })));
      } catch { /* no child bom — leaf */ }
    }
  }
  return { bom, factor, lines: out, totals: sumTotals(out) };
}

/** Path-based cycle detection (visited set on the current ancestry path).
 *  Depth alone is not enough — mid-graph cycles (A→B→C→B) must raise E_BOM_CIRCULAR.
 *  Diamond DAGs (shared child via two parents) remain valid because the child is not
 *  already on the *current* path. */
function detectCircular(db, rootProductId, bomId, depth = 0, path = []) {
  if (depth > 10) throw err('E_BOM_TOO_DEEP', 422);
  const lines = db.prepare('SELECT component_product_id FROM bom_lines WHERE bom_id=?').all(bomId);
  for (const l of lines) {
    const pid = l.component_product_id;
    if (pid === rootProductId || path.includes(pid)) {
      throw err('E_BOM_CIRCULAR', 422, { path: [...path, pid].join('→') });
    }
    const child = db.prepare(`
      SELECT id FROM bom_headers
      WHERE product_id=? AND status IN ('active','draft') AND deleted_at IS NULL
      ORDER BY status='active' DESC, version DESC LIMIT 1
    `).get(pid);
    if (child) detectCircular(db, rootProductId, child.id, depth + 1, [...path, pid]);
  }
}

function validateBom(db, bomId) {
  const b = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
  if (!b) throw err('E_NOT_FOUND', 404);
  const lines = db.prepare('SELECT * FROM bom_lines WHERE bom_id=?').all(bomId);

  // V-01
  if (!lines.some(l => l.line_type === 'material' || !l.line_type || l.line_type === '')) {
    if (!lines.length) throw err('E_BOM_EMPTY', 422);
    // allow packaging-only? Spec says at least one material
    if (!lines.some(l => (l.line_type || 'material') === 'material')) throw err('E_BOM_EMPTY', 422);
  }
  if (!lines.length) throw err('E_BOM_EMPTY', 422);

  // V-04
  const y = Number(b.yield_percent);
  if (!(y > 0 && y <= 100)) throw err('E_BOM_YIELD_RANGE', 422);

  // V-13
  if (b.bom_type === 'alternative' && !b.alt_of_bom_id) throw err('E_BOM_ALT_NO_PARENT', 422);

  // V-10
  if (b.valid_from && b.valid_to && b.valid_to < b.valid_from) throw err('E_BOM_DATE_ORDER', 422);

  const seen = new Map();
  const subGroups = {};
  for (const L of lines) {
    // V-02
    if (!(Number(L.qty_per_base) > 0 || Number(L.fixed_qty) > 0)) throw err('E_BOM_QTY_ZERO', 422);
    // V-03
    const scrap = Number(L.scrap_percent) || 0;
    if (scrap < 0 || scrap >= 100) throw err('E_BOM_SCRAP_RANGE', 422);
    // V-05
    if (L.component_product_id === b.product_id) throw err('E_BOM_SELF_REF', 422);
    // V-07
    const key = L.component_product_id + '|' + (L.substitute_group || '');
    if (seen.has(L.component_product_id) && !L.substitute_group) throw err('E_BOM_DUP_LINE', 422);
    seen.set(L.component_product_id, true);
    if (L.substitute_group) {
      (subGroups[L.substitute_group] ||= []).push(L);
    }
    // V-14
    if (L.size_matrix) {
      const m = safeJson(L.size_matrix);
      if (!m || typeof m !== 'object') throw err('E_BOM_SIZE_MATRIX', 422);
    }
    // V-15
    const prod = db.prepare('SELECT item_type, is_manufactured, name FROM products WHERE id=?').get(L.component_product_id);
    if (prod && prod.item_type === 'finished' && !prod.is_manufactured) {
      throw err('E_BOM_COMP_TYPE', 422, { name: prod.name });
    }
    // V-16
    if (L.stage_cost_center_id) {
      const cc = db.prepare('SELECT is_stage FROM cost_centers WHERE id=?').get(L.stage_cost_center_id);
      if (cc && !cc.is_stage) throw err('E_BOM_STAGE_INVALID', 422);
    }
  }
  // V-17
  for (const [g, members] of Object.entries(subGroups)) {
    if (members.length < 2) throw err('E_BOM_SUB_SINGLE', 422, { group: g });
  }
  // V-06
  detectCircular(db, b.product_id, bomId);
  return true;
}

function assertDraft(b) {
  if (!b) throw err('E_NOT_FOUND', 404);
  if (b.status === 'active') throw err('E_BOM_LOCKED', 409);
  if (b.status !== 'draft') throw err('E_BOM_NOT_DRAFT', 409);
}

function createBom(db, body, userId) {
  return db.transaction(() => {
    const productId = body.product_id;
    if (!productId) throw err('E_VALIDATION', 400);
    const code = allocateNumber(db, 'bom', 'BOM');
    const ver = body.version != null ? Number(body.version) : nextBomVersion(db, productId);
    const revision = body.revision || 'A';
    // Avoid UNIQUE(product_id, version, revision) clash
    let version = ver;
    let tries = 0;
    while (tries < 20) {
      const clash = db.prepare(
        'SELECT 1 FROM bom_headers WHERE product_id=? AND version=? AND revision=? AND deleted_at IS NULL'
      ).get(productId, version, revision);
      if (!clash) break;
      version += 1;
      tries += 1;
    }
    const info = db.prepare(`
      INSERT INTO bom_headers (
        code, product_id, version, revision, name, bom_type, alt_of_bom_id, alt_reason,
        base_qty, unit_id, status, valid_from, valid_to, is_default,
        is_multilevel, has_routing, has_coproducts, yield_percent,
        size_range, color_variant, note, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      code, productId, version, revision, body.name || '',
      body.bom_type || 'standard', body.alt_of_bom_id || null, body.alt_reason || '',
      body.base_qty != null ? body.base_qty : 1, body.unit_id || null,
      body.valid_from || '', body.valid_to || '', body.is_default ? 1 : 0,
      body.is_multilevel ? 1 : 0, body.has_routing ? 1 : 0, body.has_coproducts ? 1 : 0,
      body.yield_percent != null ? body.yield_percent : 100,
      body.size_range || '', body.color_variant || '', body.note || '', userId || null
    );
    const id = info.lastInsertRowid;
    if (Array.isArray(body.lines)) {
      for (const L of body.lines) addLine(db, id, L, userId, { skipLock: true });
    }
    logBomChange(db, id, 'create', { code }, userId);
    audit(userId, 'create', 'bom', id, `ایجاد فرمول ${code}`);
    return { id, code, version, revision, status: 'draft' };
  })();
}

function updateBomHeader(db, bomId, body, userId) {
  return db.transaction(() => {
    const b = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
    assertDraft(b);
    db.prepare(`
      UPDATE bom_headers SET name=?, base_qty=?, yield_percent=?, size_range=?, color_variant=?,
        note=?, valid_from=?, valid_to=?, is_default=?, unit_id=?
      WHERE id=?
    `).run(
      body.name != null ? body.name : b.name,
      body.base_qty != null ? body.base_qty : b.base_qty,
      body.yield_percent != null ? body.yield_percent : b.yield_percent,
      body.size_range != null ? body.size_range : b.size_range,
      body.color_variant != null ? body.color_variant : b.color_variant,
      body.note != null ? body.note : b.note,
      body.valid_from != null ? body.valid_from : b.valid_from,
      body.valid_to != null ? body.valid_to : b.valid_to,
      body.is_default != null ? (body.is_default ? 1 : 0) : b.is_default,
      body.unit_id != null ? body.unit_id : b.unit_id,
      bomId
    );
    logBomChange(db, bomId, 'header_edit', { after: body }, userId);
    audit(userId, 'edit', 'bom', bomId, `ویرایش سرفصل ${b.code}`);
    return getBom(db, bomId);
  })();
}

function softDeleteBom(db, bomId, userId) {
  return db.transaction(() => {
    const b = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
    assertDraft(b);
    db.prepare("UPDATE bom_headers SET deleted_at=?, status='obsolete' WHERE id=?").run(nowUnix(), bomId);
    audit(userId, 'delete', 'bom', bomId, `حذف پیش‌نویس ${b.code}`);
    return { ok: true };
  })();
}

function addLine(db, bomId, body, userId, opts = {}) {
  const run = () => {
    const b = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
    if (!opts.skipLock) assertDraft(b);
    if (body.component_product_id === b.product_id) throw err('E_BOM_SELF_REF', 422);
    const scrap = Number(body.scrap_percent) || 0;
    if (scrap < 0 || scrap >= 100) throw err('E_BOM_SCRAP_RANGE', 422);
    const maxLine = db.prepare('SELECT COALESCE(MAX(line_no),0) m FROM bom_lines WHERE bom_id=?').get(bomId).m;
    const info = db.prepare(`
      INSERT INTO bom_lines (
        bom_id, line_no, component_product_id, qty_per_base, unit_id, scrap_percent, fixed_qty,
        line_type, stage_cost_center_id, backflush, is_optional, substitute_group, substitute_priority,
        size_matrix, std_cost_rial, note
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      bomId,
      body.line_no || maxLine + 1,
      body.component_product_id,
      body.qty_per_base != null ? body.qty_per_base : 0,
      body.unit_id || null,
      scrap,
      body.fixed_qty || 0,
      body.line_type || 'material',
      body.stage_cost_center_id || null,
      body.backflush != null ? (body.backflush ? 1 : 0) : 1,
      body.is_optional ? 1 : 0,
      body.substitute_group || '',
      body.substitute_priority || 0,
      body.size_matrix ? (typeof body.size_matrix === 'string' ? body.size_matrix : JSON.stringify(body.size_matrix)) : '',
      body.std_cost_rial || 0,
      body.note || ''
    );
    if (!opts.skipLock) {
      logBomChange(db, bomId, 'line_add', { lineId: info.lastInsertRowid }, userId);
      audit(userId, 'edit', 'bom', bomId, 'افزودن قلم فرمول');
    }
    return { id: info.lastInsertRowid };
  };
  return opts.skipLock ? run() : db.transaction(run)();
}

function updateLine(db, bomId, lineId, body, userId) {
  return db.transaction(() => {
    const b = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
    assertDraft(b);
    const L = db.prepare('SELECT * FROM bom_lines WHERE id=? AND bom_id=?').get(lineId, bomId);
    if (!L) throw err('E_NOT_FOUND', 404);
    if (body.component_product_id === b.product_id) throw err('E_BOM_SELF_REF', 422);
    const scrap = body.scrap_percent != null ? Number(body.scrap_percent) : L.scrap_percent;
    if (scrap < 0 || scrap >= 100) throw err('E_BOM_SCRAP_RANGE', 422);
    db.prepare(`
      UPDATE bom_lines SET
        component_product_id=?, qty_per_base=?, unit_id=?, scrap_percent=?, fixed_qty=?,
        line_type=?, stage_cost_center_id=?, backflush=?, is_optional=?,
        substitute_group=?, substitute_priority=?, size_matrix=?, std_cost_rial=?, note=?
      WHERE id=?
    `).run(
      body.component_product_id != null ? body.component_product_id : L.component_product_id,
      body.qty_per_base != null ? body.qty_per_base : L.qty_per_base,
      body.unit_id != null ? body.unit_id : L.unit_id,
      scrap,
      body.fixed_qty != null ? body.fixed_qty : L.fixed_qty,
      body.line_type != null ? body.line_type : L.line_type,
      body.stage_cost_center_id != null ? body.stage_cost_center_id : L.stage_cost_center_id,
      body.backflush != null ? (body.backflush ? 1 : 0) : L.backflush,
      body.is_optional != null ? (body.is_optional ? 1 : 0) : L.is_optional,
      body.substitute_group != null ? body.substitute_group : L.substitute_group,
      body.substitute_priority != null ? body.substitute_priority : L.substitute_priority,
      body.size_matrix != null
        ? (typeof body.size_matrix === 'string' ? body.size_matrix : JSON.stringify(body.size_matrix))
        : L.size_matrix,
      body.std_cost_rial != null ? body.std_cost_rial : L.std_cost_rial,
      body.note != null ? body.note : L.note,
      lineId
    );
    logBomChange(db, bomId, 'line_edit', { lineId }, userId);
    return { ok: true };
  })();
}

function deleteLine(db, bomId, lineId, userId) {
  return db.transaction(() => {
    const b = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
    assertDraft(b);
    db.prepare('DELETE FROM bom_lines WHERE id=? AND bom_id=?').run(lineId, bomId);
    logBomChange(db, bomId, 'line_del', { lineId }, userId);
    return { ok: true };
  })();
}

function activateBom(db, bomId, validFrom, userId) {
  return db.transaction(() => {
    const b = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
    if (!b) throw err('E_NOT_FOUND', 404);
    if (b.status !== 'draft') throw err('E_BOM_NOT_DRAFT', 409);
    if (!validFrom) throw err('E_VALIDATION', 400);
    validateBom(db, bomId);

    const prev = db.prepare(`
      SELECT * FROM bom_headers
      WHERE product_id=? AND bom_type=? AND status='active' AND id<>? AND deleted_at IS NULL
    `).get(b.product_id, b.bom_type, bomId);

    if (prev) {
      if (prev.valid_from && prev.valid_from >= validFrom) {
        throw err('E_BOM_OVERLAP', 409, { prev: prev.version });
      }
      const validTo = addDaysToJalali(validFrom, -1);
      db.prepare("UPDATE bom_headers SET valid_to=?, status='archived' WHERE id=?")
        .run(validTo, prev.id);
      logBomChange(db, prev.id, 'archive', { reason: `جایگزینی با نسخه ${b.version}` }, userId);
    }

    const isDefault = prev ? prev.is_default : 1;
    db.prepare(`
      UPDATE bom_headers SET status='active', valid_from=?, is_default=?, approved_by=?, approved_at=?
      WHERE id=?
    `).run(validFrom, isDefault, userId, nowUnix(), bomId);

    if (!prev || prev.is_default) {
      db.prepare('UPDATE products SET default_bom_id=? WHERE id=?').run(bomId, b.product_id);
    }

    logBomChange(db, bomId, 'activate', { valid_from: validFrom }, userId);
    audit(userId, 'approve', 'bom', bomId, `فعال‌سازی فرمول ${b.code} نسخه ${b.version}`);
    emit(db, 'bom.activated', {
      bomId, productId: b.product_id, version: b.version, validFrom, prevBomId: prev?.id,
    });
    return { ok: true, bomId, archivedPrev: prev?.id || null };
  })();
}

function deactivateBom(db, bomId, userId) {
  return db.transaction(() => {
    const b = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
    if (!b || b.status !== 'active') throw err('E_BOM_NOT_ACTIVE', 409);
    const open = db.prepare(`
      SELECT COUNT(*) c FROM production_orders
      WHERE bom_id=? AND status IN ('draft','released','in_progress')
    `).get(bomId).c;
    if (open) throw err('E_BOM_IN_USE', 409, { n: open });
    db.prepare("UPDATE bom_headers SET status='draft' WHERE id=?").run(bomId);
    audit(userId, 'edit', 'bom', bomId, `غیرفعال‌سازی ${b.code}`);
    return { ok: true };
  })();
}

function archiveBom(db, bomId, reason, userId) {
  return db.transaction(() => {
    const b = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
    if (!b) throw err('E_NOT_FOUND', 404);
    const open = db.prepare(`
      SELECT COUNT(*) c FROM production_orders
      WHERE bom_id=? AND status IN ('draft','released','in_progress')
    `).get(bomId).c;
    if (open) throw err('E_BOM_IN_USE', 409, { n: open });
    db.prepare("UPDATE bom_headers SET status='archived' WHERE id=?").run(bomId);
    logBomChange(db, bomId, 'archive', { reason }, userId);
    audit(userId, 'edit', 'bom', bomId, `بایگانی ${b.code}`);
    return { ok: true };
  })();
}

function copyChildRows(db, table, fromBomId, toBomId) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
    .map(c => c.name)
    .filter(n => n !== 'id');
  const srcCols = cols.filter(c => c !== 'bom_id');
  const sql = `
    INSERT INTO ${table} (bom_id, ${srcCols.join(',')})
    SELECT ?, ${srcCols.join(',')} FROM ${table} WHERE bom_id=?
  `;
  db.prepare(sql).run(toBomId, fromBomId);
}

function versionUpBom(db, bomId, reason, userId) {
  return db.transaction(() => {
    const old = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
    if (!old) throw err('E_NOT_FOUND', 404);
    if (old.status !== 'active') throw err('E_ONLY_ACTIVE_CAN_VERSION_UP', 409);

    let version = nextBomVersion(db, old.product_id);
    const revision = nextRev(old.revision);
    // Ensure unique pair
    while (db.prepare(
      'SELECT 1 FROM bom_headers WHERE product_id=? AND version=? AND revision=?'
    ).get(old.product_id, version, revision)) {
      version += 1;
    }

    const code = allocateNumber(db, 'bom', 'BOM');
    const info = db.prepare(`
      INSERT INTO bom_headers (
        code, product_id, version, revision, name, bom_type, alt_of_bom_id,
        base_qty, unit_id, status, is_default, is_multilevel, has_routing, has_coproducts,
        yield_percent, size_range, color_variant, note, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,'draft',0,?,?,?,?,?,?,?,?)
    `).run(
      code, old.product_id, version, revision, old.name, old.bom_type,
      old.alt_of_bom_id, old.base_qty, old.unit_id,
      old.is_multilevel, old.has_routing, old.has_coproducts,
      old.yield_percent, old.size_range, old.color_variant,
      `نسخه‌برداری از v${old.version} — ${reason || ''}`, userId
    );
    const newId = info.lastInsertRowid;
    copyChildRows(db, 'bom_lines', bomId, newId);
    copyChildRows(db, 'bom_operations', bomId, newId);
    copyChildRows(db, 'bom_outputs', bomId, newId);
    logBomChange(db, newId, 'version_up', { from: bomId, reason }, userId);
    emit(db, 'bom.version_up', { oldBomId: bomId, newBomId: newId, reason });
    audit(userId, 'create', 'bom', newId, `نسخه جدید ${code}`);
    return { id: newId, code, version, revision };
  })();
}

function cloneBom(db, bomId, { product_id, name }, userId) {
  return db.transaction(() => {
    const old = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
    if (!old) throw err('E_NOT_FOUND', 404);
    if (!product_id) throw err('E_VALIDATION', 400);
    const code = allocateNumber(db, 'bom', 'BOM');
    const version = nextBomVersion(db, product_id);
    const info = db.prepare(`
      INSERT INTO bom_headers (
        code, product_id, version, revision, name, bom_type,
        base_qty, unit_id, status, is_default, is_multilevel, has_routing, has_coproducts,
        yield_percent, size_range, color_variant, note, created_by
      ) VALUES (?,?,?,'A',?,'standard',?,?,'draft',0,?,?,?,?,?,?,?,?)
    `).run(
      code, product_id, version, name || old.name, old.base_qty, old.unit_id,
      old.is_multilevel, old.has_routing, old.has_coproducts,
      old.yield_percent, old.size_range, old.color_variant, old.note, userId
    );
    const newId = info.lastInsertRowid;
    copyChildRows(db, 'bom_lines', bomId, newId);
    copyChildRows(db, 'bom_operations', bomId, newId);
    copyChildRows(db, 'bom_outputs', bomId, newId);
    audit(userId, 'create', 'bom', newId, `کپی فرمول ${code}`);
    return { id: newId, code, version, status: 'draft' };
  })();
}

function createAlternative(db, bomId, reason, userId) {
  return db.transaction(() => {
    const old = db.prepare('SELECT * FROM bom_headers WHERE id=?').get(bomId);
    if (!old) throw err('E_NOT_FOUND', 404);
    if (old.bom_type !== 'standard') throw err('E_BOM_ALT_CHAIN', 422);
    const code = allocateNumber(db, 'bom', 'BOM');
    const info = db.prepare(`
      INSERT INTO bom_headers (
        code, product_id, version, revision, name, bom_type, alt_of_bom_id, alt_reason,
        base_qty, unit_id, status, yield_percent, size_range, created_by
      ) VALUES (?,?,1,'A',?,'alternative',?,?,?,?,'draft',?,?,?)
    `).run(
      code, old.product_id, (old.name || '') + ' (جایگزین)', bomId, reason || '',
      old.base_qty, old.unit_id, old.yield_percent, old.size_range, userId
    );
    const newId = info.lastInsertRowid;
    copyChildRows(db, 'bom_lines', bomId, newId);
    return { id: newId, code, status: 'draft' };
  })();
}

function getBom(db, bomId) {
  const bom = db.prepare('SELECT * FROM bom_headers WHERE id=? AND deleted_at IS NULL').get(bomId);
  if (!bom) throw err('E_NOT_FOUND', 404);
  const lines = db.prepare(`
    SELECT bl.*, p.name AS product_name, p.item_type
    FROM bom_lines bl LEFT JOIN products p ON p.id=bl.component_product_id
    WHERE bl.bom_id=? ORDER BY bl.line_no
  `).all(bomId);
  const operations = db.prepare('SELECT * FROM bom_operations WHERE bom_id=? ORDER BY seq').all(bomId);
  const outputs = db.prepare('SELECT * FROM bom_outputs WHERE bom_id=?').all(bomId);
  return { ...bom, lines, operations, outputs };
}

function listBoms(db, q = {}) {
  const where = ['deleted_at IS NULL'];
  const params = [];
  if (q.product_id) { where.push('product_id=?'); params.push(q.product_id); }
  if (q.status) { where.push('status=?'); params.push(q.status); }
  if (q.bom_type) { where.push('bom_type=?'); params.push(q.bom_type); }
  if (q.search) {
    where.push('(code LIKE ? OR name LIKE ?)');
    params.push('%' + q.search + '%', '%' + q.search + '%');
  }
  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(100, Number(q.limit) || 50);
  const offset = (page - 1) * limit;
  const rows = db.prepare(`
    SELECT bh.*, p.name AS product_name
    FROM bom_headers bh LEFT JOIN products p ON p.id=bh.product_id
    WHERE ${where.join(' AND ')}
    ORDER BY bh.id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) c FROM bom_headers WHERE ${where.join(' AND ')}`).get(...params).c;
  return { rows, total, page, limit };
}

function whereUsed(db, productId) {
  return db.prepare(`
    SELECT bh.id, bh.code, bh.version, bh.status, bh.product_id, p.name AS product_name, bl.qty_per_base
    FROM bom_lines bl
    JOIN bom_headers bh ON bh.id=bl.bom_id
    JOIN products p ON p.id=bh.product_id
    WHERE bl.component_product_id=? AND bh.deleted_at IS NULL
    ORDER BY bh.code
  `).all(productId);
}

function stdCost(db, bomId, { qty = 1, priceBasis = 'average' } = {}) {
  const exploded = explodeBom(db, { bomId, qty, priceBasis });
  const unit = qty > 0 ? Math.round(exploded.totals.total_rial / qty) : 0;
  return {
    ...exploded.totals,
    unit_rial: unit,
    qty,
    lines: exploded.lines,
  };
}

function compareBoms(db, aId, bId) {
  const a = getBom(db, aId);
  const b = getBom(db, bId);
  const mapA = new Map(a.lines.map(l => [l.component_product_id, l]));
  const mapB = new Map(b.lines.map(l => [l.component_product_id, l]));
  const ids = new Set([...mapA.keys(), ...mapB.keys()]);
  const diff = [];
  for (const id of ids) {
    const la = mapA.get(id);
    const lb = mapB.get(id);
    if (!la) diff.push({ type: 'added', product_id: id, b: lb });
    else if (!lb) diff.push({ type: 'removed', product_id: id, a: la });
    else if (la.qty_per_base !== lb.qty_per_base || la.scrap_percent !== lb.scrap_percent) {
      diff.push({ type: 'changed', product_id: id, a: la, b: lb });
    }
  }
  return { a: { id: aId, code: a.code, version: a.version }, b: { id: bId, code: b.code, version: b.version }, diff };
}

function bomTree(db, bomId, level = 0) {
  const bom = getBom(db, bomId);
  return {
    ...bom,
    level,
    children: bom.lines.map(l => {
      const child = db.prepare(`
        SELECT id FROM bom_headers WHERE product_id=? AND status='active' AND deleted_at IS NULL
        ORDER BY is_default DESC LIMIT 1
      `).get(l.component_product_id);
      return child ? bomTree(db, child.id, level + 1) : { product_id: l.component_product_id, leaf: true, line: l };
    }),
  };
}

function assertProductNotInBom(db, productId) {
  const n = db.prepare('SELECT COUNT(*) c FROM bom_lines WHERE component_product_id=?').get(productId).c;
  if (n) {
    const e = err('E_PRODUCT_IN_BOM', 409, { n });
    throw e;
  }
}

module.exports = {
  err, resolveBom, explodeBom, resolveSubstitutes, getPrice,
  validateBom, detectCircular,
  activateBom, deactivateBom, archiveBom, versionUpBom, cloneBom, createAlternative,
  createBom, updateBomHeader, softDeleteBom, addLine, updateLine, deleteLine,
  getBom, listBoms, whereUsed, stdCost, compareBoms, bomTree, logBomChange,
  assertProductNotInBom, round6,
};
