'use strict';
/**
 * v574 — فاز ۱ انبار: تطبیق لایه‌های موجودی (فقط‌خواندنی).
 *
 * فقط SELECT. هیچ UPDATE/INSERT/DELETE روی جداول موجودی انجام نمی‌شود و هیچ اصلاح خودکاری وجود ندارد.
 * اصلاح اختلاف‌ها فقط با «سند تعدیل» (/inventory/adjust) و تأیید انسانی انجام می‌شود.
 *
 * لایه‌ها (برای هر کالا × انبار):
 *   products.stock            سرستون کالا (کل شرکت)
 *   warehouse_stock.qty       ws
 *   Σ variant_warehouse_stock vws  (همهٔ واریانت‌ها / فقط ماتریس فعال)
 *   Σ product_variants.stock  pv   (واریانت ماتریسی فعال، سطح کالا — pv به انبار وابسته نیست)
 *   Σ inventory_ledger        (status='posted'، بدون ردیف‌های معکوس/ابطال)
 *   Σ inventory_movements     (اگر جدول موجود باشد)
 *   ارزش ledger و stock × avg
 */

const QTY_EPS = 1e-6;
const VALUE_TOL_RIAL = 1000; // تلورانس گرد کردن ارزش (ریال)

// ردیف‌های زندهٔ کاردکس: posted، نه معکوس‌شده، نه ردیف ابطال (هم‌سو با getKardex)
const LEDGER_LIVE_SQL = `
  status='posted'
  AND reversed_of IS NULL
  AND COALESCE(event_type,'') <> 'reversal'
  AND COALESCE(event_type,'') NOT GLOB '*_reversal'
`;

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function colSet(db, table) {
  try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)); }
  catch (_) { return new Set(); }
}
const n = (v) => Number(v) || 0;
const r6 = (v) => Math.round(n(v) * 1e6) / 1e6;
const differs = (a, b) => Math.abs(n(a) - n(b)) > QTY_EPS;
const key = (p, w) => `${p}:${w}`;

function inClause(ids) {
  return `(${ids.map(() => '?').join(',')})`;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {number} [opts.productId]
 * @param {number} [opts.warehouseId]
 * @param {boolean} [opts.onlyDrift]   فقط ردیف‌های دارای اختلاف/استثنا
 * @param {Array<{product_id:number,warehouse_id:number}>} [opts.pairs]  محدود به این جفت‌ها
 * @param {number} [opts.limit]        سقف تعداد ردیف خروجی (summary همیشه کامل است)
 */
function computeLayerReconcile(db, opts = {}) {
  const pairs = Array.isArray(opts.pairs) ? opts.pairs : null;
  let productIds = null;
  if (opts.productId) productIds = [Number(opts.productId)];
  if (pairs) {
    const s = new Set(pairs.map((p) => Number(p.product_id)).filter(Boolean));
    productIds = productIds ? productIds.filter((x) => s.has(x)) : [...s];
  }
  const pairSet = pairs ? new Set(pairs.map((p) => key(Number(p.product_id), Number(p.warehouse_id)))) : null;
  const whFilter = opts.warehouseId ? Number(opts.warehouseId) : null;

  const pInSql = (col) => (productIds ? ` AND ${col} IN ${inClause(productIds)}` : '');
  const pArgs = () => (productIds ? [...productIds] : []);

  const hasPv = tableExists(db, 'product_variants');
  const hasVws = tableExists(db, 'variant_warehouse_stock');
  const hasMov = tableExists(db, 'inventory_movements');
  const hasLedger = tableExists(db, 'inventory_ledger');
  const hasWs = tableExists(db, 'warehouse_stock');
  const pvCols = hasPv ? colSet(db, 'product_variants') : new Set();
  const prodCols = colSet(db, 'products');

  const activeMatrixSql = `${pvCols.has('active') ? 'pv.active=1' : '1=1'} AND ${pvCols.has('is_default') ? 'COALESCE(pv.is_default,0)=0' : '1=1'}`;
  const defaultSql = pvCols.has('is_default') ? 'COALESCE(pv.is_default,0)=1' : '0=1';

  // ── کالاها ───────────────────────────────────────────────
  const prodSel = ['id', 'name', 'code', 'stock', 'average_cost_rial']
    .filter((c) => prodCols.has(c)).join(',');
  const products = new Map();
  for (const p of db.prepare(`SELECT ${prodSel} FROM products WHERE 1=1${pInSql('id')}`).all(...pArgs())) {
    products.set(p.id, p);
  }

  const whNames = new Map();
  if (tableExists(db, 'warehouses')) {
    for (const w of db.prepare('SELECT id, name FROM warehouses').all()) whNames.set(w.id, w.name);
  }

  // ── ws ───────────────────────────────────────────────────
  const ws = new Map();
  if (hasWs) {
    for (const r of db.prepare(`SELECT product_id, warehouse_id, qty FROM warehouse_stock WHERE 1=1${pInSql('product_id')}`).all(...pArgs())) {
      ws.set(key(r.product_id, r.warehouse_id), n(r.qty));
    }
  }

  // ── vws (به تفکیک کالا×انبار) ────────────────────────────
  const vws = new Map();
  if (hasVws && hasPv) {
    const q = `
      SELECT pv.product_id AS product_id, v.warehouse_id AS warehouse_id,
             SUM(v.qty) AS sum_all,
             SUM(CASE WHEN ${activeMatrixSql} THEN v.qty ELSE 0 END) AS sum_matrix,
             COUNT(*) AS n
      FROM variant_warehouse_stock v
      JOIN product_variants pv ON pv.id=v.variant_id
      WHERE 1=1${pInSql('pv.product_id')}
      GROUP BY pv.product_id, v.warehouse_id`;
    for (const r of db.prepare(q).all(...pArgs())) {
      vws.set(key(r.product_id, r.warehouse_id), { all: n(r.sum_all), matrix: n(r.sum_matrix), n: r.n });
    }
  }

  // ── pv (سطح کالا) ────────────────────────────────────────
  const pvAgg = new Map();
  const defaultVariants = new Map();
  if (hasPv) {
    const q = `
      SELECT pv.product_id AS product_id, COUNT(*) AS matrix_n, SUM(COALESCE(pv.stock,0)) AS stock_sum
      FROM product_variants pv
      WHERE ${activeMatrixSql}${pInSql('pv.product_id')}
      GROUP BY pv.product_id`;
    for (const r of db.prepare(q).all(...pArgs())) {
      pvAgg.set(r.product_id, { matrix_n: r.matrix_n, stock_sum: n(r.stock_sum) });
    }
    if (pvCols.has('is_default')) {
      const dq = `
        SELECT pv.id, pv.product_id, COALESCE(pv.stock,0) AS stock,
               ${hasVws ? '(SELECT COALESCE(SUM(v.qty),0) FROM variant_warehouse_stock v WHERE v.variant_id=pv.id)' : '0'} AS vws_qty
        FROM product_variants pv
        WHERE ${defaultSql}${pInSql('pv.product_id')}`;
      for (const r of db.prepare(dq).all(...pArgs())) {
        const cur = defaultVariants.get(r.product_id) || { variant_ids: [], stock: 0, vws_qty: 0 };
        cur.variant_ids.push(r.id); cur.stock += n(r.stock); cur.vws_qty += n(r.vws_qty);
        defaultVariants.set(r.product_id, cur);
      }
    }
  }

  // ── ledger (به تفکیک کالا×انبار؛ شامل warehouse_id NULL) ──
  const led = new Map();
  const ledNoWh = [];
  const dupOpen = [];
  const ledTotalByProduct = new Map();
  if (hasLedger) {
    const q = `
      SELECT product_id, warehouse_id,
             SUM(COALESCE(qty_in,0) - COALESCE(qty_out,0)) AS qty,
             SUM(CASE WHEN COALESCE(qty_in,0)>0 THEN COALESCE(amount_rial,0)
                      WHEN COALESCE(qty_out,0)>0 THEN -COALESCE(amount_rial,0)
                      ELSE COALESCE(amount_rial,0) END) AS value_rial,
             COUNT(*) AS n,
             SUM(CASE WHEN source_type='opening_inventory' OR event_type='opening' THEN 1 ELSE 0 END) AS opening_n
      FROM inventory_ledger
      WHERE ${LEDGER_LIVE_SQL}${pInSql('product_id')}
      GROUP BY product_id, warehouse_id`;
    for (const r of db.prepare(q).all(...pArgs())) {
      const qty = n(r.qty);
      const val = Math.round(n(r.value_rial));
      ledTotalByProduct.set(r.product_id, n(ledTotalByProduct.get(r.product_id)) + qty);
      if (r.warehouse_id == null) {
        const p = products.get(r.product_id);
        ledNoWh.push({
          product_id: r.product_id, product_code: p && p.code, product_name: p && p.name,
          rows: r.n, qty: r6(qty), value_rial: val,
        });
        continue;
      }
      led.set(key(r.product_id, r.warehouse_id), { qty, value: val, n: r.n, opening_n: n(r.opening_n) });
      if (n(r.opening_n) > 1) {
        const p = products.get(r.product_id);
        dupOpen.push({
          product_id: r.product_id, product_code: p && p.code, product_name: p && p.name,
          warehouse_id: r.warehouse_id, warehouse_name: whNames.get(r.warehouse_id) || null,
          opening_rows: n(r.opening_n),
        });
      }
    }
  }

  // ── movements ────────────────────────────────────────────
  const mov = new Map();
  if (hasMov) {
    const q = `
      SELECT product_id, warehouse_id, SUM(qty_delta) AS qty
      FROM inventory_movements
      WHERE warehouse_id IS NOT NULL${pInSql('product_id')}
      GROUP BY product_id, warehouse_id`;
    for (const r of db.prepare(q).all(...pArgs())) mov.set(key(r.product_id, r.warehouse_id), n(r.qty));
  }

  // ── اختلاف pv و vws (به تفکیک واریانت ماتریسی فعال) ─────
  const variantMismatches = [];
  if (hasPv) {
    const q = `
      SELECT pv.id, pv.product_id, pv.sku, COALESCE(pv.stock,0) AS pv_stock,
             ${hasVws ? '(SELECT COALESCE(SUM(v.qty),0) FROM variant_warehouse_stock v WHERE v.variant_id=pv.id)' : '0'} AS vws_qty,
             ${hasVws ? '(SELECT COUNT(*) FROM variant_warehouse_stock v WHERE v.variant_id=pv.id)' : '0'} AS vws_rows
      FROM product_variants pv
      WHERE ${activeMatrixSql}${pInSql('pv.product_id')}`;
    for (const r of db.prepare(q).all(...pArgs())) {
      if (differs(r.pv_stock, r.vws_qty)) {
        const p = products.get(r.product_id);
        variantMismatches.push({
          variant_id: r.id, product_id: r.product_id, product_code: p && p.code, product_name: p && p.name,
          sku: r.sku || null, pv_stock: r6(r.pv_stock), vws_sum: r6(r.vws_qty),
          diff: r6(n(r.pv_stock) - n(r.vws_qty)), vws_rows: r.vws_rows,
        });
      }
    }
  }

  // ── مجموع‌های سطح کالا ──────────────────────────────────
  const wsTotalByProduct = new Map();
  for (const [k, q] of ws) {
    const pid = Number(k.split(':')[0]);
    wsTotalByProduct.set(pid, n(wsTotalByProduct.get(pid)) + q);
  }
  const vwsMatrixByProduct = new Map();
  for (const [k, v] of vws) {
    const pid = Number(k.split(':')[0]);
    vwsMatrixByProduct.set(pid, n(vwsMatrixByProduct.get(pid)) + v.matrix);
  }

  // ── ردیف‌های کالا×انبار ─────────────────────────────────
  const keys = new Set([...ws.keys(), ...vws.keys(), ...led.keys(), ...mov.keys()]);
  const rows = [];
  const zeroQtyValue = [];
  const wsNegative = [];

  for (const k of keys) {
    const [pidS, widS] = k.split(':');
    const pid = Number(pidS); const wid = Number(widS);
    if (whFilter && wid !== whFilter) continue;
    if (pairSet && !pairSet.has(k)) continue;
    const p = products.get(pid);
    if (!p) continue; // یتیم

    const wsQty = ws.has(k) ? ws.get(k) : null;
    const v = vws.get(k) || null;
    const l = led.get(k) || null;
    const m = mov.has(k) ? mov.get(k) : null;
    const pa = pvAgg.get(pid) || null;
    const isMatrix = !!(pa && pa.matrix_n > 0);

    const wsN = n(wsQty);
    const ledQty = l ? l.qty : 0;
    const ledVal = l ? l.value : 0;
    const avg = Math.round(n(p.average_cost_rial));
    const stockAvg = Math.round(wsN * avg);

    // ردیف کاملاً صفر و بدون ledger: نویز
    if (!l && Math.abs(wsN) < QTY_EPS && !(v && (Math.abs(v.all) > QTY_EPS)) && !(m && Math.abs(m) > QTY_EPS)) continue;

    const flags = {
      // کالای ماتریسی: ws در برابر Σvws واریانت‌های ماتریسی فعال؛ غیرماتریسی: فقط اگر ردیف vws دارد
      ws_vs_vws: (isMatrix || !!v) ? differs(wsN, v ? (isMatrix ? v.matrix : v.all) : 0) : false,
      ws_vs_ledger: differs(wsN, ledQty),
      vws_vs_movements: (hasMov && m != null && v) ? differs(v.all, m) : false,
      ws_negative: wsN < -QTY_EPS,
      value_vs_stock_avg: Math.abs(ledVal - stockAvg) > VALUE_TOL_RIAL,
      zero_qty_nonzero_value: Math.abs(wsN) < QTY_EPS && Math.abs(ledQty) < QTY_EPS && Math.abs(ledVal) > VALUE_TOL_RIAL,
      duplicate_opening: !!(l && l.opening_n > 1),
    };
    // value_vs_stock_avg اطلاعاتی است (میانگین‌های هر انبار می‌تواند متفاوت باشد) و در drift_any نیست
    const drift_any = flags.ws_vs_vws || flags.ws_vs_ledger;
    const exception_any = flags.ws_negative || flags.zero_qty_nonzero_value || flags.duplicate_opening;

    const row = {
      product_id: pid, product_code: p.code || null, product_name: p.name || null,
      warehouse_id: wid, warehouse_name: whNames.get(wid) || null,
      products_stock: r6(p.stock),
      ws_qty: wsQty == null ? null : r6(wsQty),
      vws_sum: v ? r6(v.all) : null,
      vws_matrix_sum: v ? r6(v.matrix) : null,
      pv_stock_sum: pa ? r6(pa.stock_sum) : null, // سطح کالا (همهٔ انبارها)
      ledger_qty: r6(ledQty),
      ledger_rows: l ? l.n : 0,
      movements_qty: m == null ? null : r6(m),
      ledger_value_rial: ledVal,
      average_cost_rial: avg,
      stock_x_avg_rial: stockAvg,
      value_diff_rial: ledVal - stockAvg,
      flags,
      drift_any,
      exception_any,
    };
    if (flags.ws_negative) {
      wsNegative.push({ product_id: pid, product_code: p.code, product_name: p.name, warehouse_id: wid, warehouse_name: row.warehouse_name, ws_qty: row.ws_qty });
    }
    if (flags.zero_qty_nonzero_value) {
      zeroQtyValue.push({ product_id: pid, product_code: p.code, product_name: p.name, warehouse_id: wid, warehouse_name: row.warehouse_name, ledger_value_rial: ledVal, avg_cost_rial: avg });
    }
    rows.push(row);
  }

  rows.sort((a, b) => (a.product_id - b.product_id) || (a.warehouse_id - b.warehouse_id));

  // ── سطح کالا (سرستون / مجموع ws / pv / vws) ─────────────
  const productRows = [];
  for (const p of products.values()) {
    const wsTot = n(wsTotalByProduct.get(p.id));
    const pa = pvAgg.get(p.id) || null;
    const vwsM = n(vwsMatrixByProduct.get(p.id));
    const flags = {
      header_vs_ws: differs(p.stock, wsTot),
      ws_vs_ledger_total: differs(wsTot, n(ledTotalByProduct.get(p.id))),
      pv_vs_vws: !!pa && differs(pa.stock_sum, vwsM),
      ws_vs_vws_total: !!pa && differs(wsTot, vwsM),
    };
    const any = flags.header_vs_ws || flags.ws_vs_ledger_total || flags.pv_vs_vws || flags.ws_vs_vws_total;
    if (!any && opts.onlyDrift) continue;
    // کالای بدون هیچ ردیف انبار/ledger و موجودی صفر: نویز
    if (!any && Math.abs(n(p.stock)) < QTY_EPS && Math.abs(wsTot) < QTY_EPS && !ledTotalByProduct.has(p.id)) continue;
    productRows.push({
      product_id: p.id, product_code: p.code || null, product_name: p.name || null,
      products_stock: r6(p.stock), ws_total: r6(wsTot),
      pv_stock_sum: pa ? r6(pa.stock_sum) : null, vws_matrix_total: pa ? r6(vwsM) : null,
      ledger_total_qty: r6(ledTotalByProduct.get(p.id)),
      flags, drift_any: any,
    });
  }

  // ── واریانت پیش‌فرض با موجودی روی کالای ماتریسی ──────────
  const defaultWithStock = [];
  for (const [pid, d] of defaultVariants) {
    const pa = pvAgg.get(pid);
    if (!pa || !pa.matrix_n) continue;
    if (Math.abs(d.stock) > QTY_EPS || Math.abs(d.vws_qty) > QTY_EPS) {
      const p = products.get(pid);
      defaultWithStock.push({
        product_id: pid, product_code: p && p.code, product_name: p && p.name,
        default_variant_ids: d.variant_ids, pv_stock: r6(d.stock), vws_qty: r6(d.vws_qty),
      });
    }
  }

  // ledger بدون انبار: فقط ردیف‌های با اثر (qty یا value ≠ 0)
  const ledgerWithoutWarehouse = ledNoWh;

  // فیلتر جفت‌ها / انبار روی استثناهای وابسته به انبار
  const inScope = (x) => (!whFilter || x.warehouse_id === whFilter)
    && (!pairSet || pairSet.has(key(x.product_id, x.warehouse_id)));
  const exceptions = {
    ws_negative: wsNegative,
    ledger_without_warehouse: pairSet || whFilter ? [] : ledgerWithoutWarehouse,
    default_variant_with_stock: defaultWithStock,
    duplicate_opening: dupOpen.filter(inScope),
    zero_qty_nonzero_value: zeroQtyValue,
    variant_mismatches: variantMismatches,
  };

  const outRows = opts.onlyDrift ? rows.filter((r) => r.drift_any || r.exception_any) : rows;
  const limit = Number(opts.limit) > 0 ? Math.floor(Number(opts.limit)) : 0;

  const summary = {
    products_checked: products.size,
    rows_total: rows.length,
    rows_with_drift: rows.filter((r) => r.drift_any).length,
    rows_with_exception: rows.filter((r) => r.exception_any).length,
    products_with_header_drift: productRows.filter((p) => p.flags.header_vs_ws).length,
    ws_vs_vws: rows.filter((r) => r.flags.ws_vs_vws).length,
    ws_vs_ledger: rows.filter((r) => r.flags.ws_vs_ledger).length,
    vws_vs_movements: rows.filter((r) => r.flags.vws_vs_movements).length,
    value_vs_stock_avg: rows.filter((r) => r.flags.value_vs_stock_avg).length,
    pv_vs_vws_variants: variantMismatches.length,
    ws_negative: wsNegative.length,
    ledger_without_warehouse: exceptions.ledger_without_warehouse.length,
    default_variant_with_stock: defaultWithStock.length,
    duplicate_opening: exceptions.duplicate_opening.length,
    zero_qty_nonzero_value: zeroQtyValue.length,
  };

  return {
    ok: true,
    read_only: true,
    generated_at: new Date().toISOString(),
    tolerance: { qty: QTY_EPS, value_rial: VALUE_TOL_RIAL },
    sources: { variant_warehouse_stock: hasVws, product_variants: hasPv, inventory_movements: hasMov, inventory_ledger: hasLedger },
    summary,
    rows: limit ? outRows.slice(0, limit) : outRows,
    rows_truncated: limit ? outRows.length > limit : false,
    products: opts.onlyDrift ? productRows.filter((p) => p.drift_any) : productRows,
    exceptions,
  };
}

/**
 * هشدار drift پس از سند انبار — فقط خلاصهٔ متنی؛ هیچ نوشتنی انجام نمی‌دهد.
 * @returns {{drift:boolean, rows:object[], summary:string}}
 */
function detectPairDrift(db, pairs) {
  if (!pairs || !pairs.length) return { drift: false, rows: [], summary: '' };
  const rec = computeLayerReconcile(db, { pairs, onlyDrift: true });
  const drifted = rec.rows.filter((r) => r.drift_any);
  const parts = drifted.slice(0, 10).map((r) => {
    const f = Object.keys(r.flags).filter((x) => r.flags[x] && x !== 'value_vs_stock_avg').join('+');
    return `${r.product_code || r.product_id}@${r.warehouse_id}[ws=${r.ws_qty},vws=${r.vws_sum},led=${r.ledger_qty}; ${f}]`;
  });
  return {
    drift: drifted.length > 0,
    rows: drifted,
    summary: parts.join(' | ') + (drifted.length > 10 ? ` | +${drifted.length - 10} more` : ''),
  };
}

module.exports = { computeLayerReconcile, detectPairDrift, QTY_EPS, VALUE_TOL_RIAL, LEDGER_LIVE_SQL };
