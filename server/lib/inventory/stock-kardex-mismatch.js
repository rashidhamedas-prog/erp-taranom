'use strict';
/**
 * FR-P334-A — read-only report: product × warehouse where warehouse_stock.qty ≠ live kardex qty.
 * Kardex live = posted, not reversed, not a reversal row (same rule as layer-reconcile LEDGER_LIVE_SQL).
 * No writes, no db.js dependency (also used by the CLI on a read-only handle).
 */
const LIVE_SQL = `l.status='posted' AND l.reversed_of IS NULL
  AND COALESCE(l.event_type,'') <> 'reversal' AND COALESCE(l.event_type,'') NOT GLOB '*_reversal'`;
const EPS = 1e-6;

function round3(n) { return Math.round((Number(n) || 0) * 1000) / 1000; }

function stockKardexMismatch(db, { productId = null, warehouseId = null } = {}) {
  const pid = Number(productId) || null;
  const wid = Number(warehouseId) || null;
  const kWhere = [LIVE_SQL, 'l.warehouse_id IS NOT NULL'];
  const kParams = [];
  if (pid) { kWhere.push('l.product_id=?'); kParams.push(pid); }
  if (wid) { kWhere.push('l.warehouse_id=?'); kParams.push(wid); }
  const kRows = db.prepare(`
    SELECT l.product_id, l.warehouse_id,
      COALESCE(SUM(COALESCE(l.qty_in,0)-COALESCE(l.qty_out,0)),0) AS q,
      COALESCE(SUM(CASE WHEN COALESCE(l.qty_in,0)>0 THEN ROUND(COALESCE(l.amount_rial,0))
        WHEN COALESCE(l.qty_out,0)>0 THEN -ROUND(COALESCE(l.amount_rial,0))
        ELSE ROUND(COALESCE(l.amount_rial,0)) END),0) AS v
    FROM inventory_ledger l
    WHERE ${kWhere.join(' AND ')}
    GROUP BY l.product_id, l.warehouse_id
  `).all(...kParams);
  const wWhere = ['1=1'];
  const wParams = [];
  if (pid) { wWhere.push('product_id=?'); wParams.push(pid); }
  if (wid) { wWhere.push('warehouse_id=?'); wParams.push(wid); }
  const wRows = db.prepare(`SELECT product_id, warehouse_id, qty FROM warehouse_stock WHERE ${wWhere.join(' AND ')}`).all(...wParams);

  const key = (p, w) => `${p}:${w}`;
  const map = new Map();
  for (const r of kRows) {
    map.set(key(r.product_id, r.warehouse_id), {
      product_id: Number(r.product_id), warehouse_id: Number(r.warehouse_id),
      kardex_qty: round3(r.q), kardex_value_rial: Math.round(Number(r.v) || 0), ws_qty: 0, ws_row: false,
    });
  }
  for (const r of wRows) {
    const k = key(r.product_id, r.warehouse_id);
    const cur = map.get(k) || {
      product_id: Number(r.product_id), warehouse_id: Number(r.warehouse_id),
      kardex_qty: 0, kardex_value_rial: 0, ws_qty: 0, ws_row: false,
    };
    cur.ws_qty = round3(r.qty);
    cur.ws_row = true;
    map.set(k, cur);
  }
  const prod = new Map();
  const wh = new Map();
  const pStmt = db.prepare('SELECT id, name, code, unit FROM products WHERE id=?');
  const wStmt = db.prepare('SELECT id, name FROM warehouses WHERE id=?');
  const rows = [];
  for (const r of map.values()) {
    const diff = round3(r.ws_qty - r.kardex_qty);
    if (Math.abs(diff) <= EPS) continue;
    if (!prod.has(r.product_id)) prod.set(r.product_id, pStmt.get(r.product_id) || {});
    if (!wh.has(r.warehouse_id)) wh.set(r.warehouse_id, wStmt.get(r.warehouse_id) || {});
    const p = prod.get(r.product_id);
    const w = wh.get(r.warehouse_id);
    rows.push({
      product_id: r.product_id,
      product_code: p.code || '',
      product_name: p.name || '',
      unit: p.unit || '',
      warehouse_id: r.warehouse_id,
      warehouse_name: w.name || '',
      warehouse_stock_qty: r.ws_qty,
      warehouse_stock_row: r.ws_row,
      kardex_qty: r.kardex_qty,
      diff_qty: diff,
      kardex_value_rial: r.kardex_value_rial,
    });
  }
  rows.sort((a, b) => (a.product_id - b.product_id) || (a.warehouse_id - b.warehouse_id));
  let cache_vs_ledger = null;
  try {
    const { stockCacheVsLedger } = require('./stock-cache');
    cache_vs_ledger = stockCacheVsLedger(db, { productId: pid });
  } catch (_) { cache_vs_ledger = null; }
  return {
    filter: { product_id: pid, warehouse_id: wid },
    definition: 'diff_qty = warehouse_stock.qty − Σ kardex زنده (posted، غیرمعکوس، غیر برگشتی)',
    count: rows.length,
    total_abs_diff_qty: round3(rows.reduce((a, r) => a + Math.abs(r.diff_qty), 0)),
    rows,
    ...(cache_vs_ledger ? {
      cache_vs_ledger: {
        ok: cache_vs_ledger.ok,
        mismatch_count: cache_vs_ledger.mismatch_count,
        mismatched_products: cache_vs_ledger.mismatched_products,
        rows: cache_vs_ledger.rows,
        unattributed_count: cache_vs_ledger.unattributed_count,
        unattributed: cache_vs_ledger.unattributed,
      },
    } : {}),
  };
}

module.exports = { stockKardexMismatch };
