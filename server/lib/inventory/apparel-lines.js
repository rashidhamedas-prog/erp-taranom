'use strict';
/**
 * Color×size quantities that ride along a header stock change.
 * The quantity is the caller's inventory_ledger row; under SSOT a matrix ledger row must carry
 * variant_id itself (one row per SKU) — this module only records the audit layer
 * (inventory_movements, applyHeaderStock false) and never moves a stock figure.
 */
const { round3 } = require('../round3');
const { colorsMatch } = require('./fabric-rolls');
const { stripSizeFitNote } = require('../display-labels');
const {
  hasActiveMatrixVariants,
  postVariantLayer,
  reverseStockDocument,
} = require('./movement');

function fail(code, status, message) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  throw e;
}

function sizesMatch(a, b) {
  const sa = String(a == null ? '' : a).trim();
  const sb = String(b == null ? '' : b).trim();
  if (!sa && !sb) return true;
  if (!sa || !sb) return false;
  if (sa === sb) return true;
  return stripSizeFitNote(sa) === stripSizeFitNote(sb);
}

function parseBreakdown(raw) {
  if (raw == null || raw === '') return [];
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (_) { return []; }
  }
  if (Array.isArray(value)) {
    return value.map(row => ({
      variantId: row && (row.variant_id || row.variantId) || null,
      size: row && (row.size || row.size_name) ? String(row.size || row.size_name) : '',
      color: row && (row.color || row.color_name) ? String(row.color || row.color_name) : '',
      qty: round3(row && row.qty),
    })).filter(row => row.qty > 0);
  }
  if (typeof value === 'object') {
    return Object.entries(value).map(([key, qty]) => {
      if (qty && typeof qty === 'object') {
        return {
          variantId: qty.variant_id || qty.variantId || null,
          size: String(qty.size || qty.size_name || key),
          color: qty.color || qty.color_name ? String(qty.color || qty.color_name) : '',
          qty: round3(qty.qty),
        };
      }
      return { variantId: null, size: String(key), color: '', qty: round3(qty) };
    }).filter(row => row.qty > 0);
  }
  return [];
}

function matrixVariants(db, productId) {
  return db.prepare(`
    SELECT pv.id, pc.name AS color_name, ps.name AS size_name
    FROM product_variants pv
    LEFT JOIN product_colors pc ON pc.id = pv.color_id
    LEFT JOIN product_sizes ps ON ps.id = pv.size_id
    WHERE pv.product_id=? AND pv.active=1 AND COALESCE(pv.is_default,0)=0
  `).all(productId);
}

/**
 * Non-matrix products return [].
 * Matrix products must name each color×size and the quantities must sum to `qty`.
 */
function resolveApparelLines(db, opts) {
  const productId = parseInt(opts.productId, 10);
  const qty = round3(opts.qty);
  if (!productId || !hasActiveMatrixVariants(db, productId)) return [];

  let lines = [];
  const explicit = Array.isArray(opts.variantLines) ? opts.variantLines : [];
  if (explicit.length) {
    lines = explicit.map(row => ({
      variantId: parseInt(row.variant_id || row.variantId, 10),
      qty: round3(row.qty),
    })).filter(row => row.variantId && row.qty > 0);
  } else if (opts.variantId) {
    lines = [{ variantId: parseInt(opts.variantId, 10), qty }];
  } else {
    const breakdown = parseBreakdown(opts.sizeBreakdown);
    const colorWant = String(opts.color || '').trim();
    const variants = matrixVariants(db, productId);
    for (const row of breakdown) {
      if (row.variantId) {
        lines.push({ variantId: parseInt(row.variantId, 10), qty: row.qty });
        continue;
      }
      const wantColor = String(row.color || colorWant).trim();
      const hits = variants.filter(v => {
        const sizeOk = !row.size || sizesMatch(v.size_name, row.size);
        const colorOk = !wantColor || colorsMatch(v.color_name, wantColor);
        return sizeOk && colorOk;
      });
      if (hits.length !== 1) {
        const sizeLabel = row.size || '—';
        if (!wantColor && hits.length > 1) {
          const cols = [...new Set(hits.map(h => h.color_name).filter(Boolean))];
          fail(
            'E_VARIANT_REQUIRED',
            400,
            `برای سایز «${sizeLabel}» چند رنگ تعریف شده — رنگ را مشخص کنید (${cols.join('، ') || '—'})`
          );
        }
        if (wantColor && hits.length === 0) {
          const sameSize = variants.filter(v => !row.size || sizesMatch(v.size_name, row.size));
          const cols = [...new Set(sameSize.map(v => v.color_name).filter(Boolean))];
          fail(
            'E_VARIANT_REQUIRED',
            400,
            `رنگ «${wantColor}» و سایز «${sizeLabel}» برای این کالا پیدا نشد`
              + (cols.length ? ` — رنگ‌های موجود: ${cols.join('، ')}` : '')
          );
        }
        fail('E_VARIANT_REQUIRED', 400, `رنگ و سایز «${wantColor || sizeLabel}» برای این کالا مشخص نیست`);
      }
      lines.push({ variantId: hits[0].id, qty: row.qty });
    }
  }

  if (!lines.length) {
    fail('E_VARIANT_REQUIRED', 400, 'برای کالای رنگ و سایز، تعداد هر ترکیب را مشخص کنید');
  }
  const sum = round3(lines.reduce((acc, row) => acc + row.qty, 0));
  if (qty > 0 && Math.abs(sum - qty) > 0.001) {
    fail('E_VARIANT_QTY', 400, `جمع رنگ و سایز (${sum}) با تعداد سند (${qty}) یکی نیست`);
  }
  return lines;
}

function postApparelLines(db, opts) {
  const lines = opts.lines || [];
  if (!lines.length) return [];
  const sign = opts.sign < 0 ? -1 : 1;
  const start = opts.docLineStart != null ? parseInt(opts.docLineStart, 10) : 0;
  const variants = require('../product-variants');
  const out = [];
  variants.holdColorRetire(db);
  try {
    lines.forEach((line, index) => {
      out.push(postVariantLayer(db, {
        productId: opts.productId,
        variantId: line.variantId,
        warehouseId: opts.warehouseId,
        qtyDelta: round3(sign * line.qty),
        docType: opts.docType,
        docId: opts.docId,
        docLine: start + index,
        userId: opts.userId,
        note: opts.note,
        allowNegative: opts.allowNegative === true,
      }));
    });
  } finally {
    variants.releaseColorRetire(db);
  }
  variants.afterVariantStockWrite(db, opts.productId);
  return out;
}

function reverseApparelDoc(db, opts) {
  return reverseStockDocument(db, {
    docType: opts.docType,
    docId: opts.docId,
    userId: opts.userId,
    note: opts.note,
    applyHeaderStock: false,
  });
}

function normalizeLedgerLines(lines) {
  const byVariant = new Map();
  for (const l of lines || []) {
    const vid = parseInt(l && (l.variantId != null ? l.variantId : l.variant_id), 10) || 0;
    const q = round3(l && l.qty);
    if (!(q > 0)) continue;
    byVariant.set(vid, round3((byVariant.get(vid) || 0) + q));
  }
  return [...byVariant].map(([variantId, qty]) => ({ variantId: variantId || null, qty }));
}

/**
 * SSOT: post one stock change as inventory_ledger rows — one row per colour×size SKU for a
 * product with active matrix variants, the single row (no variant) otherwise.
 * Every row repeats event / source / date / note. Qty and an explicit amountRial are split by
 * line qty with the rounding remainder on the last row, so Σ amount equals the single-row
 * amount (JE amounts unchanged). Without amountRial each row is priced by the ledger as before.
 * Returns the first row's result plus totals: { id, ids, rows, qty_in, qty_out, amount_rial, … }.
 */
function postLedgerByVariant(db, opts, lines) {
  const { postInventoryMovement } = require('./ledger');
  const productId = parseInt(opts.productId, 10);
  if (opts.valueOnly || !productId || !hasActiveMatrixVariants(db, productId)) {
    return groupResult([postInventoryMovement(db, opts)]);
  }
  let qtyIn = Number(opts.qtyIn) || 0;
  let qtyOut = Number(opts.qtyOut) || 0;
  if (!qtyIn && !qtyOut && opts.qty != null) {
    const q = Number(opts.qty) || 0;
    if (q >= 0) qtyIn = q; else qtyOut = -q;
  }
  const total = round3(qtyIn || qtyOut);
  let list = normalizeLedgerLines(lines);
  if (!list.length && opts.variantId) list = [{ variantId: parseInt(opts.variantId, 10), qty: total }];
  if (!list.length || list.some((l) => !l.variantId)) {
    const p = db.prepare('SELECT name FROM products WHERE id=?').get(productId);
    fail(
      'E_VARIANT_REQUIRED',
      400,
      `کالای «${(p && p.name) || productId}» رنگ×سایز دارد — تفکیک رنگ و سایز این گردش موجودی مشخص نیست`
    );
  }
  const sum = round3(list.reduce((acc, l) => acc + l.qty, 0));
  if (Math.abs(sum - total) > 0.001) {
    fail('E_VARIANT_QTY', 400, `جمع رنگ و سایز (${sum}) با تعداد سند (${total}) یکی نیست`);
  }
  if (list.length === 1) {
    return groupResult([postInventoryMovement(db, { ...opts, variantId: list[0].variantId })]);
  }
  const amountTotal = opts.amountRial != null ? Math.round(Number(opts.amountRial) || 0) : null;
  const rows = [];
  let qtyLeft = total;
  let amtLeft = amountTotal;
  list.forEach((l, i) => {
    const last = i === list.length - 1;
    const qi = last ? round3(qtyLeft) : l.qty;
    let ai;
    if (amountTotal != null) {
      ai = last ? amtLeft : Math.round(amountTotal * qi / total);
      amtLeft -= ai;
    }
    qtyLeft = round3(qtyLeft - qi);
    rows.push(postInventoryMovement(db, {
      ...opts,
      qty: undefined,
      qtyIn: qtyIn ? qi : 0,
      qtyOut: qtyOut ? qi : 0,
      amountRial: ai,
      variantId: l.variantId,
    }));
  });
  return groupResult(rows);
}

function groupResult(rows) {
  const first = rows[0];
  const last = rows[rows.length - 1];
  const sum = (k) => rows.reduce((acc, r) => acc + (Number(r && r[k]) || 0), 0);
  const qty = round3(sum('qty_in') || sum('qty_out'));
  const amount = Math.round(sum('amount_rial'));
  return {
    ...first,
    ids: rows.map((r) => r.id),
    rows,
    qty_in: round3(sum('qty_in')),
    qty_out: round3(sum('qty_out')),
    qty_balance: last.qty_balance,
    amount_rial: amount,
    ledger_amount_rial: Math.round(sum('ledger_amount_rial')),
    value_parked_rial: Math.round(sum('value_parked_rial')),
    unit_cost_rial: rows.length > 1 && qty > 0 ? Math.round(amount / qty) : first.unit_cost_rial,
    avg_cost_after_rial: last.avg_cost_after_rial,
  };
}

/**
 * Ids of the rows one postLedgerByVariant call wrote, found from any one of them: adjacent rows
 * of the same product with the same event / source / warehouse / date / note and distinct
 * variants (a repeated SKU starts another posting). A row without variant is its own group.
 */
function ledgerGroupIds(db, anchorId) {
  const anchor = db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(anchorId);
  if (!anchor) return [];
  if (!(Number(anchor.variant_id) > 0)) return [Number(anchor.id)];
  const same = (r) => r
    && String(r.event_type || '') === String(anchor.event_type || '')
    && String(r.source_type || '') === String(anchor.source_type || '')
    && String(r.source_id == null ? '' : r.source_id) === String(anchor.source_id == null ? '' : anchor.source_id)
    && String(r.warehouse_id == null ? '' : r.warehouse_id) === String(anchor.warehouse_id == null ? '' : anchor.warehouse_id)
    && String(r.date || '') === String(anchor.date || '')
    && String(r.note || '') === String(anchor.note || '')
    && ((Number(r.qty_in) || 0) > 0) === ((Number(anchor.qty_in) || 0) > 0)
    && r.reversed_of == null
    && Number(r.variant_id) > 0;
  const seen = new Set([Number(anchor.variant_id)]);
  const ids = [Number(anchor.id)];
  const walk = (sql) => {
    for (const r of db.prepare(sql).all(anchor.product_id, anchor.id)) {
      if (!same(r) || seen.has(Number(r.variant_id))) break;
      seen.add(Number(r.variant_id));
      ids.push(Number(r.id));
    }
  };
  walk('SELECT * FROM inventory_ledger WHERE product_id=? AND id<? ORDER BY id DESC LIMIT 500');
  walk('SELECT * FROM inventory_ledger WHERE product_id=? AND id>? ORDER BY id ASC LIMIT 500');
  return ids.sort((a, b) => a - b);
}

/** Reverse every still-live row of the group around anchorId (newest first). */
function reverseLedgerGroup(db, anchorId, opts = {}) {
  const { reverseInventoryMovement } = require('./ledger');
  const out = [];
  for (const id of ledgerGroupIds(db, anchorId).reverse()) {
    const r = db.prepare('SELECT status, reversed_of FROM inventory_ledger WHERE id=?').get(id);
    if (!r || r.status !== 'posted' || r.reversed_of != null) continue;
    out.push(reverseInventoryMovement(db, id, opts));
  }
  return out;
}

function serializeVariantLinesJson(lines) {
  if (!lines || !lines.length) return '';
  return JSON.stringify(lines.map(l => ({
    variant_id: l.variantId != null ? l.variantId : l.variant_id,
    qty: round3(l.qty),
  })).filter(l => l.variant_id && l.qty > 0));
}

function saveDocVariantLines(db, table, id, lines) {
  const json = serializeVariantLinesJson(lines);
  if (!id) return json;
  try {
    db.prepare(`UPDATE ${table} SET variant_lines_json=? WHERE id=?`).run(json || '', id);
  } catch (_) { /* column may not exist mid-boot */ }
  return json;
}

module.exports = {
  resolveApparelLines,
  postApparelLines,
  reverseApparelDoc,
  serializeVariantLinesJson,
  saveDocVariantLines,
  postLedgerByVariant,
  ledgerGroupIds,
  reverseLedgerGroup,
};
