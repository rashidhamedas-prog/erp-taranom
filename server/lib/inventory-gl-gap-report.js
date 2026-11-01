'use strict';
/**
 * Phase 4 (optional) — read-only inventory GL ↔ kardex gap report.
 * Never writes. No JE suggestions. Used by scripts/report-inventory-gl-gap.js
 * and GET /api/warehouses/inventory-gl-gap-report.
 *
 * Signed kardex: sv = CASE WHEN qty_out>0 THEN -amount_rial ELSE amount_rial END
 * Residual = GL − kardex(mapped wh) − Σ(causes a..f); should be 0 when explained.
 */

const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('./money');
const { jeNotDraftSql } = require('./je-live');

const SAMPLE_LIMIT = 10;

/** ref_types that normally reconcile via source (not je_id on kardex). */
const SOURCE_COMPARE_REF_PREFIXES = [
  'invoice_cogs',
  'production_receipt',
  'sales_return',
  'cutting_lay',
  'order_cost_receipt_align',
  'stock_align',
  'warehouse_doc',
  'warehouse_transfer',
  'inventory_adjust',
  'stock_adjust',
  'stocktaking',
];

function hasTable(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (_) {
    return false;
  }
}

function hasCol(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch (_) {
    return false;
  }
}

function parseWarehouseIds(raw) {
  if (Array.isArray(raw)) return raw.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return String(raw || '')
    .split(/[,;\s]+/)
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function placeholders(n) {
  return Array(n).fill('?').join(',');
}

function takeSamples(rows, mapFn) {
  return (rows || []).slice(0, SAMPLE_LIMIT).map(mapFn || ((r) => r));
}

function isSourceCompareRef(refType) {
  const rt = String(refType || '');
  return SOURCE_COMPARE_REF_PREFIXES.some((p) => rt === p || rt.startsWith(p + '_') || rt.startsWith(p));
}

function offsetBaseRefType(refType) {
  const rt = String(refType || '');
  if (!rt.includes('_offset_')) return null;
  return rt.replace(/_value_offset_.*$/i, '').replace(/_offset_.*$/i, '');
}

function signedSvSql(alias) {
  const a = alias || 'k';
  return `CASE WHEN COALESCE(${a}.qty_out,0)>0 THEN -COALESCE(${a}.amount_rial,0) ELSE COALESCE(${a}.amount_rial,0) END`;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ acct: string, warehouses: number[]|string, cutoff: string }} opts
 */
function buildInventoryGlGapReport(db, opts) {
  const acct = String(opts.acct || '').trim();
  const warehouses = parseWarehouseIds(opts.warehouses);
  const cutoff = String(opts.cutoff || '').trim();
  if (!acct) {
    const err = new Error('acct الزامی است');
    err.status = 400;
    err.code = 'E_GAP_ACCT_REQUIRED';
    throw err;
  }
  if (!warehouses.length) {
    const err = new Error('warehouses الزامی است (مثلاً 34,35)');
    err.status = 400;
    err.code = 'E_GAP_WAREHOUSES_REQUIRED';
    throw err;
  }
  if (!cutoff) {
    const err = new Error('cutoff الزامی است (مثلاً 1405/08/30)');
    err.status = 400;
    err.code = 'E_GAP_CUTOFF_REQUIRED';
    throw err;
  }
  if (!hasTable(db, 'inventory_ledger') || !hasTable(db, 'journal_entries') || !hasTable(db, 'journal_lines')) {
    const err = new Error('جداول کاردکس/دفتر موجود نیستند');
    err.status = 500;
    err.code = 'E_GAP_SCHEMA';
    throw err;
  }

  const whPh = placeholders(warehouses.length);
  const sv = signedSvSql('k');
  const hasJeDeleted = hasCol(db, 'journal_entries', 'deleted_at');
  const hasJeStatus = hasCol(db, 'journal_entries', 'status');
  const liveParts = [];
  if (hasJeDeleted) liveParts.push("COALESCE(e.deleted_at,0)=0");
  else liveParts.push('1=1');
  if (hasJeStatus) liveParts.push("COALESCE(e.status,'approved') NOT IN ('reversed','void')", jeNotDraftSql('e'));
  const liveExpr = liveParts.join(' AND ');

  // ── GL by JE / ref_type ──
  const glByJeClean = db.prepare(`
    SELECT e.id AS je_id, e.ref_type AS ref_type, e.ref_id AS ref_id, e.entry_date AS entry_date,
           COUNT(*) AS line_count,
           COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}),0) AS gl_rial
    FROM journal_lines jl
    JOIN journal_entries e ON e.id = jl.entry_id
    WHERE jl.account_code = ?
      AND ${liveExpr}
      AND COALESCE(e.entry_date,'') <= ?
    GROUP BY e.id
  `).all(acct, cutoff).map((r) => ({
    je_id: r.je_id,
    ref_type: r.ref_type || '',
    ref_id: r.ref_id,
    entry_date: r.entry_date || '',
    line_count: r.line_count,
    gl_rial: Math.round(Number(r.gl_rial) || 0),
  }));

  const glTotal = glByJeClean.reduce((s, r) => s + r.gl_rial, 0);
  const glByRefTypeMap = new Map();
  for (const r of glByJeClean) {
    const key = r.ref_type || '(empty)';
    const cur = glByRefTypeMap.get(key) || { ref_type: key, je_count: 0, gl_rial: 0 };
    cur.je_count += 1;
    cur.gl_rial += r.gl_rial;
    glByRefTypeMap.set(key, cur);
  }
  const gl_by_ref_type = [...glByRefTypeMap.values()].sort((a, b) => Math.abs(b.gl_rial) - Math.abs(a.gl_rial));
  // ── Kardex signed (mapped warehouses) ──
  const kardexMapped = db.prepare(`
    SELECT k.id, k.warehouse_id, k.product_id, k.event_type, k.source_type, k.source_id,
           k.je_id, k.qty_in, k.qty_out, k.amount_rial, k.date, k.note,
           ${sv} AS sv
    FROM inventory_ledger k
    WHERE k.status='posted'
      AND COALESCE(k.date,'') <= ?
      AND k.warehouse_id IN (${whPh})
  `).all(cutoff, ...warehouses).map((r) => ({
    ...r,
    sv: Math.round(Number(r.sv) || 0),
    amount_rial: Math.round(Number(r.amount_rial) || 0),
  }));
  const kardexTotal = kardexMapped.reduce((s, r) => s + r.sv, 0);

  const kardexByWhSourceMap = new Map();
  for (const r of kardexMapped) {
    const key = `${r.warehouse_id}|${r.source_type || ''}`;
    const cur = kardexByWhSourceMap.get(key) || {
      warehouse_id: r.warehouse_id,
      source_type: r.source_type || '',
      row_count: 0,
      sv_rial: 0,
      without_je: 0,
    };
    cur.row_count += 1;
    cur.sv_rial += r.sv;
    if (r.je_id == null) cur.without_je += 1;
    kardexByWhSourceMap.set(key, cur);
  }
  const kardex_by_wh_source = [...kardexByWhSourceMap.values()]
    .sort((a, b) => a.warehouse_id - b.warehouse_id || String(a.source_type).localeCompare(String(b.source_type)));

  // Kardex sv by je_id (mapped wh only)
  const kardexByJe = new Map();
  for (const r of kardexMapped) {
    if (r.je_id == null) continue;
    kardexByJe.set(r.je_id, (kardexByJe.get(r.je_id) || 0) + r.sv);
  }

  // ── Per-JE reconcile ──
  const per_je = glByJeClean.map((g) => {
    const kSv = kardexByJe.has(g.je_id) ? kardexByJe.get(g.je_id) : null;
    const diff = kSv == null ? null : g.gl_rial - kSv;
    return {
      je_id: g.je_id,
      ref_type: g.ref_type,
      ref_id: g.ref_id,
      entry_date: g.entry_date,
      gl_rial: g.gl_rial,
      kardex_sv_rial: kSv,
      diff_rial: diff,
      link: kSv == null ? (isSourceCompareRef(g.ref_type) ? 'source_compare' : 'no_kardex_je') : 'je_id',
    };
  });

  // ── Cause a: transfer leakage ──
  const transferPairs = db.prepare(`
    SELECT o.id AS out_id, i.id AS in_id,
           o.source_id AS transfer_id,
           o.warehouse_id AS from_wh, i.warehouse_id AS to_wh,
           o.product_id AS product_id,
           o.qty_out AS qty,
           o.amount_rial AS out_amount, i.amount_rial AS in_amount,
           (o.amount_rial - i.amount_rial) AS leak_rial,
           o.date AS date
    FROM inventory_ledger o
    JOIN inventory_ledger i
      ON i.source_id = o.source_id
     AND i.source_type = o.source_type
     AND i.event_type = 'transfer_in'
     AND i.status = 'posted'
     AND COALESCE(i.date,'') <= ?
    WHERE o.status='posted'
      AND COALESCE(o.date,'') <= ?
      AND o.source_type = 'warehouse_transfer'
      AND o.event_type = 'transfer_out'
      AND (
        (o.warehouse_id IN (${whPh}) OR i.warehouse_id IN (${whPh}))
      )
      AND o.amount_rial != i.amount_rial
  `).all(cutoff, cutoff, ...warehouses, ...warehouses);

  // Same-account transfers: leakage is exactly out-in (no JE). Always count full leak for pairs touching mapped whs.
  const transferLeakRows = transferPairs.map((r) => ({
    transfer_id: r.transfer_id,
    out_id: r.out_id,
    in_id: r.in_id,
    from_wh: r.from_wh,
    to_wh: r.to_wh,
    product_id: r.product_id,
    qty: r.qty,
    out_amount: Math.round(Number(r.out_amount) || 0),
    in_amount: Math.round(Number(r.in_amount) || 0),
    leak_rial: Math.round(Number(r.leak_rial) || 0),
    date: r.date || '',
  }));
  const causeA = {
    key: 'a_transfer_leakage',
    label: 'نشت انتقال (خروج≠ورود یا ورود صفر)',
    count: transferLeakRows.length,
    amount_rial: transferLeakRows.reduce((s, r) => s + r.leak_rial, 0),
    samples: takeSamples(transferLeakRows),
  };

  // ── Cause b: NULL warehouse ──
  const nullWhRows = db.prepare(`
    SELECT k.id, k.product_id, k.event_type, k.source_type, k.source_id, k.je_id,
           k.qty_in, k.qty_out, k.amount_rial, k.date, ${sv} AS sv
    FROM inventory_ledger k
    WHERE k.status='posted'
      AND COALESCE(k.date,'') <= ?
      AND k.warehouse_id IS NULL
  `).all(cutoff).map((r) => ({
    id: r.id,
    product_id: r.product_id,
    event_type: r.event_type,
    source_type: r.source_type,
    source_id: r.source_id,
    je_id: r.je_id,
    amount_rial: Math.round(Number(r.amount_rial) || 0),
    sv: Math.round(Number(r.sv) || 0),
    date: r.date || '',
  }));
  const causeB = {
    key: 'b_null_warehouse',
    label: 'ردیف کاردکس با warehouse_id خالی',
    count: nullWhRows.length,
    amount_rial: nullWhRows.reduce((s, r) => s + r.sv, 0),
    samples: takeSamples(nullWhRows),
  };

  // ── Cause c: kardex without je_id in mapped warehouses ──
  // Exclude warehouse_transfer rows — leakage of those pairs is cause (a).
  const noJeRows = kardexMapped.filter((r) => {
    if (r.je_id != null) return false;
    const st = String(r.source_type || '');
    const et = String(r.event_type || '');
    if (st === 'warehouse_transfer' || et === 'transfer_out' || et === 'transfer_in') return false;
    return true;
  });
  const noJeBySource = new Map();
  for (const r of noJeRows) {
    const st = r.source_type || '(empty)';
    const cur = noJeBySource.get(st) || { source_type: st, count: 0, amount_rial: 0, samples: [] };
    // contribution to (GL − kardex) = −sv
    const contrib = -r.sv;
    cur.count += 1;
    cur.amount_rial += contrib;
    if (cur.samples.length < SAMPLE_LIMIT) {
      cur.samples.push({
        id: r.id,
        warehouse_id: r.warehouse_id,
        product_id: r.product_id,
        event_type: r.event_type,
        amount_rial: r.amount_rial,
        sv: r.sv,
        contrib_rial: contrib,
        date: r.date || '',
        note: r.note || '',
      });
    }
    noJeBySource.set(st, cur);
  }
  const causeC = {
    key: 'c_kardex_without_je',
    label: 'کاردکس بدون je_id در انبارهای حساب',
    count: noJeRows.length,
    amount_rial: noJeRows.reduce((s, r) => s + (-r.sv), 0),
    by_source_type: [...noJeBySource.values()].sort((a, b) => Math.abs(b.amount_rial) - Math.abs(a.amount_rial)),
    samples: takeSamples(noJeRows, (r) => ({
      id: r.id,
      warehouse_id: r.warehouse_id,
      product_id: r.product_id,
      source_type: r.source_type,
      event_type: r.event_type,
      sv: r.sv,
      contrib_rial: -r.sv,
      date: r.date || '',
    })),
  };

  // ── Cause d: offset-neutralised ──
  const offsetJes = glByJeClean.filter((g) => String(g.ref_type).includes('_offset_'));
  const offsetBases = new Set(offsetJes.map((g) => offsetBaseRefType(g.ref_type)).filter(Boolean));
  const neutralisedJeIds = new Set();
  if (offsetBases.size) {
    for (const g of glByJeClean) {
      if (offsetBases.has(g.ref_type)) neutralisedJeIds.add(g.je_id);
    }
  }
  const offsetKardex = kardexMapped.filter((r) => r.je_id != null && neutralisedJeIds.has(r.je_id));
  const causeD = {
    key: 'd_offset_neutralised',
    label: 'کاردکس با سند خنثی‌شده توسط offset',
    count: offsetKardex.length,
    amount_rial: offsetKardex.reduce((s, r) => s + (-r.sv), 0),
    offset_je_count: offsetJes.length,
    offset_gl_rial: offsetJes.reduce((s, r) => s + r.gl_rial, 0),
    base_ref_types: [...offsetBases],
    samples: takeSamples(offsetKardex, (r) => ({
      id: r.id,
      warehouse_id: r.warehouse_id,
      product_id: r.product_id,
      je_id: r.je_id,
      sv: r.sv,
      contrib_rial: -r.sv,
      date: r.date || '',
    })),
  };

  // ── Cause e: GL without kardex source ──
  const glNoKardex = [];
  for (const g of glByJeClean) {
    if (kardexByJe.has(g.je_id)) continue;
    if (String(g.ref_type).includes('_offset_')) continue;
    if (isSourceCompareRef(g.ref_type)) continue;
    // also skip if any kardex (any wh) has this je_id
    const anyK = db.prepare(`
      SELECT 1 AS x FROM inventory_ledger WHERE je_id=? AND status='posted' LIMIT 1
    `).get(g.je_id);
    if (anyK) continue;
    glNoKardex.push(g);
  }
  const causeE = {
    key: 'e_gl_without_kardex_source',
    label: 'دفتر بدون منبع کاردکس (مثل manual_voucher)',
    count: glNoKardex.length,
    amount_rial: glNoKardex.reduce((s, r) => s + r.gl_rial, 0),
    samples: takeSamples(glNoKardex, (r) => ({
      je_id: r.je_id,
      ref_type: r.ref_type,
      ref_id: r.ref_id,
      gl_rial: r.gl_rial,
      entry_date: r.entry_date,
    })),
  };

  // ── Cause f: other warehouses falling back to this account ──
  let otherWhIds = [];
  if (hasTable(db, 'warehouses')) {
    const allWh = db.prepare(`
      SELECT id, warehouse_type, ${hasCol(db, 'warehouses', 'inventory_coa_code') ? 'inventory_coa_code' : 'NULL AS inventory_coa_code'}
      FROM warehouses
    `).all();
    const mappedSet = new Set(warehouses);
    const { inventoryAccountForWarehouse } = require('./inventory/ledger');
    for (const w of allWh) {
      if (mappedSet.has(w.id)) continue;
      let code;
      try {
        code = inventoryAccountForWarehouse(db, w.id, { readOnly: true }).code;
      } catch (_) {
        code = null;
      }
      if (code === acct) otherWhIds.push(w.id);
    }
  }

  let causeFAmount = 0;
  let causeFSamples = [];
  let causeFCount = 0;
  if (otherWhIds.length) {
    const oPh = placeholders(otherWhIds.length);
    // GL of JEs linked only via other-wh kardex (not also linked from mapped whs)
    const otherLinked = db.prepare(`
      SELECT e.id AS je_id, e.ref_type, e.ref_id, e.entry_date,
             COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}),0) AS gl_rial
      FROM journal_lines jl
      JOIN journal_entries e ON e.id = jl.entry_id
      WHERE jl.account_code = ?
        AND ${liveExpr}
        AND COALESCE(e.entry_date,'') <= ?
        AND e.id IN (
          SELECT DISTINCT k.je_id FROM inventory_ledger k
          WHERE k.status='posted' AND k.je_id IS NOT NULL
            AND k.warehouse_id IN (${oPh})
            AND COALESCE(k.date,'') <= ?
        )
        AND e.id NOT IN (
          SELECT DISTINCT k2.je_id FROM inventory_ledger k2
          WHERE k2.status='posted' AND k2.je_id IS NOT NULL
            AND k2.warehouse_id IN (${whPh})
        )
      GROUP BY e.id
    `).all(acct, cutoff, ...otherWhIds, cutoff, ...warehouses);
    causeFCount = otherLinked.length;
    causeFAmount = otherLinked.reduce((s, r) => s + Math.round(Number(r.gl_rial) || 0), 0);
    causeFSamples = takeSamples(otherLinked, (r) => ({
      je_id: r.je_id,
      ref_type: r.ref_type,
      ref_id: r.ref_id,
      gl_rial: Math.round(Number(r.gl_rial) || 0),
      entry_date: r.entry_date || '',
    }));
  }
  const causeF = {
    key: 'f_other_wh_fallback',
    label: 'دفتر مربوط به انبارهای دیگر با fallback به همین حساب',
    count: causeFCount,
    amount_rial: causeFAmount,
    other_warehouse_ids: otherWhIds,
    samples: causeFSamples,
  };

  const causesSum =
    causeA.amount_rial +
    causeB.amount_rial +
    causeC.amount_rial +
    causeD.amount_rial +
    causeE.amount_rial +
    causeF.amount_rial;

  const rawGap = glTotal - kardexTotal;
  const residual = rawGap - causesSum;

  return {
    generated_at: new Date().toISOString(),
    readonly: true,
    params: { acct, warehouses, cutoff },
    summary: {
      gl_rial: glTotal,
      kardex_mapped_rial: kardexTotal,
      gap_rial: rawGap,
      causes_explained_rial: causesSum,
      residual_rial: residual,
      gl_je_count: glByJeClean.length,
      kardex_row_count: kardexMapped.length,
    },
    gl_by_ref_type,
    kardex_by_wh_source,
    per_je,
    causes: {
      a_transfer_leakage: causeA,
      b_null_warehouse: causeB,
      c_kardex_without_je: causeC,
      d_offset_neutralised: causeD,
      e_gl_without_kardex_source: causeE,
      f_other_wh_fallback: causeF,
      g_residual: {
        key: 'g_residual',
        label: 'باقی‌مانده (باید ۰ باشد)',
        count: residual === 0 ? 0 : 1,
        amount_rial: residual,
        samples: residual === 0 ? [] : [{ note: 'باقی‌مانده توضیح‌داده‌نشده', residual_rial: residual }],
      },
    },
    note: 'گزارش فقط‌خواندنی است؛ هیچ سند یا تعدیلی پیشنهاد/ایجاد نمی‌شود.',
  };
}

function reportToMarkdown(rep, meta) {
  const md = [];
  md.push('# گزارش تطبیق حساب موجودی با کاردکس (فقط‌خواندنی)');
  md.push('');
  if (meta && meta.db) md.push(`- db: \`${meta.db}\``);
  md.push(`- حساب: **${rep.params.acct}**`);
  md.push(`- انبارها: **${rep.params.warehouses.join(', ')}**`);
  md.push(`- تاریخ قطع: **${rep.params.cutoff}**`);
  md.push(`- تولید: ${rep.generated_at}`);
  md.push('');
  md.push('## خلاصه');
  md.push('');
  md.push(`| شاخص | ریال |`);
  md.push(`|---|---:|`);
  md.push(`| دفتر (GL) | ${rep.summary.gl_rial} |`);
  md.push(`| کاردکس انبارهای انتخابی | ${rep.summary.kardex_mapped_rial} |`);
  md.push(`| اختلاف (GL − کاردکس) | ${rep.summary.gap_rial} |`);
  md.push(`| جمع علل a–f | ${rep.summary.causes_explained_rial} |`);
  md.push(`| باقی‌مانده (g) | ${rep.summary.residual_rial} |`);
  md.push('');
  md.push('> هیچ پیشنهاد سند خودکاری تولید نشده است.');
  md.push('');
  md.push('## علل');
  md.push('');
  md.push('| کد | توضیح | تعداد | مبلغ (ریال) |');
  md.push('|---|---|---:|---:|');
  const order = [
    'a_transfer_leakage',
    'b_null_warehouse',
    'c_kardex_without_je',
    'd_offset_neutralised',
    'e_gl_without_kardex_source',
    'f_other_wh_fallback',
    'g_residual',
  ];
  for (const k of order) {
    const c = rep.causes[k];
    md.push(`| ${c.key} | ${c.label} | ${c.count} | ${c.amount_rial} |`);
  }
  md.push('');
  md.push('## دفتر بر اساس ref_type');
  md.push('');
  md.push('| ref_type | تعداد سند | مبلغ (ریال) |');
  md.push('|---|---:|---:|');
  for (const r of rep.gl_by_ref_type) {
    md.push(`| ${r.ref_type} | ${r.je_count} | ${r.gl_rial} |`);
  }
  md.push('');
  md.push('## کاردکس بر اساس انبار / source_type');
  md.push('');
  md.push('| انبار | source_type | ردیف | sv | بدون je |');
  md.push('|---:|---|---:|---:|---:|');
  for (const r of rep.kardex_by_wh_source) {
    md.push(`| ${r.warehouse_id} | ${r.source_type || ''} | ${r.row_count} | ${r.sv_rial} | ${r.without_je} |`);
  }
  md.push('');
  return md.join('\n') + '\n';
}

module.exports = {
  buildInventoryGlGapReport,
  reportToMarkdown,
  parseWarehouseIds,
  SAMPLE_LIMIT,
  SOURCE_COMPARE_REF_PREFIXES,
};
