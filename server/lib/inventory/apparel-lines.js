'use strict';
/**
 * Color×size quantities that ride along a header stock change.
 * Header products.stock / warehouse_stock stay with the caller.
 * This module only posts the variant layer (applyHeaderStock false).
 */
const { round3 } = require('../round3');
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
        const sizeOk = !row.size || String(v.size_name || '') === String(row.size);
        const colorOk = !wantColor || String(v.color_name || '') === wantColor;
        return sizeOk && colorOk;
      });
      if (hits.length !== 1) {
        fail('E_VARIANT_REQUIRED', 400, `رنگ و سایز «${row.size || '—'}» برای این کالا مشخص نیست`);
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
  const out = [];
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
};
