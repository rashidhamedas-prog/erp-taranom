'use strict';
/**
 * Stock single source of truth.
 *
 * inventory_ledger (live rows only) is the ONLY source of on-hand quantity. The four stock
 * figures below are caches, written exclusively by rebuildStockCache():
 *
 *   warehouse_stock(product, wh)          = Σ live rows of (product, wh)                (all events)
 *   products.stock(product)               = Σ live rows of product, WIP staging excluded
 *   variant_warehouse_stock(variant, wh)  = Σ live rows of (variant, wh)                (all events)
 *   product_variants.stock(variant)       = Σ live rows of variant, WIP staging excluded
 *
 * Live = posted, not a reversal row, not reversed (LEDGER_LIVE_SQL): a reversed pair is
 * excluded as a whole, whatever status the reversal row itself carries.
 * Rows with variant_id NULL count for the product/warehouse figures only; they are reported as
 * `unattributed` and never guessed onto a variant.
 *
 * Negative quantities are mirrored as-is: the gate for going negative lives at the ledger write
 * (postInventoryMovement), not in the cache. The negative-stock triggers on warehouse_stock /
 * variant_warehouse_stock let the cache writer through via stock_cache_writer_flag.
 */
const { LEDGER_LIVE_SQL } = require('./layer-reconcile');

const WAREHOUSE_ONLY_EVENTS = ['cutting_pack'];
const EPS = 1e-9;

function round3(n) {
  const x = Math.round((Number(n) || 0) * 1000) / 1000;
  return Math.abs(x) < EPS ? 0 : x;
}

const headerFilterSql = (alias) => {
  const a = alias ? `${alias}.` : '';
  const list = WAREHOUSE_ONLY_EVENTS.map((e) => `'${e}'`).join(',');
  return `COALESCE(${a}event_type,'') NOT IN (${list})`;
};

function liveSql(alias) {
  if (!alias) return `(${LEDGER_LIVE_SQL})`;
  return `(${alias}.status='posted' AND ${alias}.reversed_of IS NULL
    AND COALESCE(${alias}.event_type,'') <> 'reversal' AND COALESCE(${alias}.event_type,'') NOT GLOB '*_reversal')`;
}

function hasColumn(db, table, col) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col); } catch (_) { return false; }
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function ensureStockCacheSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_cache_writer_flag (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO stock_cache_writer_flag (id, active) VALUES (1, 0);
  `);
}

/** Run fn with the negative-stock triggers opened for the cache writer only. */
function withCacheWriter(db, fn) {
  ensureStockCacheSchema(db);
  const prev = (db.prepare('SELECT active FROM stock_cache_writer_flag WHERE id=1').get() || {}).active || 0;
  db.prepare('UPDATE stock_cache_writer_flag SET active=1 WHERE id=1').run();
  try {
    return fn();
  } finally {
    db.prepare('UPDATE stock_cache_writer_flag SET active=? WHERE id=1').run(prev ? 1 : 0);
  }
}

/**
 * Ledger-derived figures for one product (read-only).
 * @returns {{ product_id, header, warehouses: Map<wh,qty>, variants: Map<vid,qty>,
 *             variantWarehouses: Map<'vid:wh',qty>, unattributed: Map<wh|0,qty> }}
 */
function deriveProductStock(db, productId) {
  const pid = Number(productId) || 0;
  const hasVariantCol = hasColumn(db, 'inventory_ledger', 'variant_id');
  const vSel = hasVariantCol ? 'variant_id' : 'NULL AS variant_id';
  const rows = db.prepare(`
    SELECT warehouse_id, ${vSel},
      SUM(COALESCE(qty_in,0) - COALESCE(qty_out,0)) AS q,
      SUM(CASE WHEN ${headerFilterSql()} THEN COALESCE(qty_in,0) - COALESCE(qty_out,0) ELSE 0 END) AS hq
    FROM inventory_ledger
    WHERE product_id=? AND ${liveSql()}
    GROUP BY warehouse_id, ${hasVariantCol ? 'variant_id' : '2'}
  `).all(pid);
  const out = {
    product_id: pid,
    header: 0,
    warehouses: new Map(),
    variants: new Map(),
    variantWarehouses: new Map(),
    unattributed: new Map(),
  };
  for (const r of rows) {
    const wh = r.warehouse_id != null ? Number(r.warehouse_id) : null;
    const vid = r.variant_id != null && Number(r.variant_id) > 0 ? Number(r.variant_id) : null;
    const q = Number(r.q) || 0;
    const hq = Number(r.hq) || 0;
    out.header += hq;
    if (wh) out.warehouses.set(wh, (out.warehouses.get(wh) || 0) + q);
    if (vid) {
      out.variants.set(vid, (out.variants.get(vid) || 0) + hq);
      if (wh) {
        const k = `${vid}:${wh}`;
        out.variantWarehouses.set(k, (out.variantWarehouses.get(k) || 0) + q);
      }
    } else {
      const k = wh || 0;
      out.unattributed.set(k, (out.unattributed.get(k) || 0) + q);
    }
  }
  out.header = round3(out.header);
  for (const m of [out.warehouses, out.variants, out.variantWarehouses, out.unattributed]) {
    for (const [k, v] of m) m.set(k, round3(v));
  }
  return out;
}

/**
 * The only writer of products.stock / product_variants.stock / warehouse_stock /
 * variant_warehouse_stock. Idempotent; safe inside or outside a transaction.
 * Existing cache rows with no live ledger rows are set to 0 (never deleted).
 */
function rebuildStockCache(db, productId) {
  const pid = Number(productId) || 0;
  if (!pid) return null;
  const d = deriveProductStock(db, pid);
  const run = () => withCacheWriter(db, () => {
    db.prepare('UPDATE products SET stock=? WHERE id=?').run(d.header, pid);

    if (tableExists(db, 'warehouse_stock')) {
      const cur = db.prepare('SELECT warehouse_id, qty FROM warehouse_stock WHERE product_id=?').all(pid);
      const seen = new Set();
      const upd = db.prepare('UPDATE warehouse_stock SET qty=? WHERE product_id=? AND warehouse_id=?');
      for (const r of cur) {
        const wh = Number(r.warehouse_id);
        seen.add(wh);
        const want = d.warehouses.get(wh) || 0;
        if (round3(r.qty) !== want) upd.run(want, pid, wh);
      }
      const ins = db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)');
      for (const [wh, q] of d.warehouses) if (!seen.has(wh)) ins.run(pid, wh, q);
    }

    const variants = tableExists(db, 'product_variants')
      ? db.prepare('SELECT id, stock FROM product_variants WHERE product_id=?').all(pid)
      : [];
    const vUpd = db.prepare('UPDATE product_variants SET stock=? WHERE id=?');
    for (const v of variants) {
      const want = d.variants.get(Number(v.id)) || 0;
      if (round3(v.stock) !== want) vUpd.run(want, v.id);
    }

    if (variants.length && tableExists(db, 'variant_warehouse_stock')) {
      const ids = variants.map((v) => Number(v.id));
      const cur = db.prepare(
        `SELECT variant_id, warehouse_id, qty FROM variant_warehouse_stock WHERE variant_id IN (${ids.map(() => '?').join(',')})`
      ).all(...ids);
      const seen = new Set();
      const upd = db.prepare('UPDATE variant_warehouse_stock SET qty=? WHERE variant_id=? AND warehouse_id=?');
      for (const r of cur) {
        const k = `${Number(r.variant_id)}:${Number(r.warehouse_id)}`;
        seen.add(k);
        const want = d.variantWarehouses.get(k) || 0;
        if (round3(r.qty) !== want) upd.run(want, r.variant_id, r.warehouse_id);
      }
      const ins = db.prepare('INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,?)');
      const known = new Set(ids);
      for (const [k, q] of d.variantWarehouses) {
        if (seen.has(k)) continue;
        const [vid, wh] = k.split(':').map(Number);
        if (known.has(vid)) ins.run(vid, wh, q);
      }
    }
  });
  if (db.inTransaction) run();
  else db.transaction(run)();
  return summarize(d);
}

function summarize(d) {
  return {
    product_id: d.product_id,
    header: d.header,
    warehouses: [...d.warehouses].map(([warehouse_id, qty]) => ({ warehouse_id, qty })),
    variants: [...d.variants].map(([variant_id, qty]) => ({ variant_id, qty })),
    variant_warehouses: [...d.variantWarehouses].map(([k, qty]) => {
      const [variant_id, warehouse_id] = k.split(':').map(Number);
      return { variant_id, warehouse_id, qty };
    }),
    unattributed: [...d.unattributed].map(([wh, qty]) => ({ warehouse_id: wh || null, qty })).filter((r) => r.qty !== 0),
  };
}

/** Rebuild many products (repair / heal). */
function rebuildAllStockCaches(db, { productIds = null } = {}) {
  const ids = productIds && productIds.length
    ? productIds.map(Number)
    : db.prepare('SELECT id FROM products ORDER BY id').all().map((r) => Number(r.id));
  const out = [];
  const run = () => { for (const id of ids) out.push(rebuildStockCache(db, id)); };
  if (db.inTransaction) run();
  else db.transaction(run)();
  return out;
}

/**
 * Derived on-hand for readers (kardex, matrix, colour report, product list).
 * Same numbers rebuildStockCache writes; reads the ledger directly.
 */
function derivedQty(db, { productId, warehouseId = null, variantId = null } = {}) {
  const pid = Number(productId) || 0;
  if (!pid) return 0;
  const where = ['product_id=?', liveSql()];
  const params = [pid];
  const wh = Number(warehouseId) || 0;
  const vid = Number(variantId) || 0;
  if (wh) { where.push('warehouse_id=?'); params.push(wh); } else where.push(headerFilterSql());
  if (vid) { where.push('variant_id=?'); params.push(vid); }
  const r = db.prepare(
    `SELECT COALESCE(SUM(COALESCE(qty_in,0) - COALESCE(qty_out,0)),0) AS q FROM inventory_ledger WHERE ${where.join(' AND ')}`
  ).get(...params);
  return round3(r && r.q);
}

/**
 * Recon: cache vs ledger at product / warehouse / variant / variant×warehouse level.
 * Read-only. `unattributed` lists matrix products with live ledger qty that has no variant_id.
 */
function stockCacheVsLedger(db, { productId = null, limit = 500 } = {}) {
  const pids = productId
    ? [Number(productId)]
    : db.prepare(`
        SELECT id FROM products
        UNION SELECT DISTINCT product_id FROM inventory_ledger
        ORDER BY 1
      `).all().map((r) => Number(r.id));
  const rows = [];
  const unattributed = [];
  const hasPv = tableExists(db, 'product_variants');
  const hasVws = tableExists(db, 'variant_warehouse_stock');
  for (const pid of pids) {
    const d = deriveProductStock(db, pid);
    const p = db.prepare('SELECT code, name, stock FROM products WHERE id=?').get(pid) || {};
    const push = (level, extra, cache, ledger) => {
      if (round3(cache) === round3(ledger)) return;
      rows.push({ level, product_id: pid, product_code: p.code || '', ...extra,
        cache_qty: round3(cache), ledger_qty: round3(ledger), diff_qty: round3(cache - ledger) });
    };
    push('product', {}, p.stock, d.header);
    const ws = new Map(db.prepare('SELECT warehouse_id, qty FROM warehouse_stock WHERE product_id=?').all(pid)
      .map((r) => [Number(r.warehouse_id), Number(r.qty) || 0]));
    for (const wh of new Set([...ws.keys(), ...d.warehouses.keys()])) {
      push('warehouse', { warehouse_id: wh }, ws.get(wh) || 0, d.warehouses.get(wh) || 0);
    }
    if (hasPv) {
      const vs = db.prepare('SELECT id, stock FROM product_variants WHERE product_id=?').all(pid);
      for (const v of vs) push('variant', { variant_id: Number(v.id) }, v.stock, d.variants.get(Number(v.id)) || 0);
      if (hasVws && vs.length) {
        const ids = vs.map((v) => Number(v.id));
        const cur = new Map(db.prepare(
          `SELECT variant_id, warehouse_id, qty FROM variant_warehouse_stock WHERE variant_id IN (${ids.map(() => '?').join(',')})`
        ).all(...ids).map((r) => [`${Number(r.variant_id)}:${Number(r.warehouse_id)}`, Number(r.qty) || 0]));
        for (const k of new Set([...cur.keys(), ...d.variantWarehouses.keys()])) {
          const [variant_id, warehouse_id] = k.split(':').map(Number);
          push('variant_warehouse', { variant_id, warehouse_id }, cur.get(k) || 0, d.variantWarehouses.get(k) || 0);
        }
      }
      const matrix = vs.length > 1;
      if (matrix) {
        for (const [wh, q] of d.unattributed) {
          if (q !== 0) unattributed.push({ product_id: pid, product_code: p.code || '', warehouse_id: wh || null, qty: q });
        }
      }
    }
  }
  const products = new Set(rows.map((r) => r.product_id));
  return {
    ok: rows.length === 0,
    definition: 'cache (products.stock / warehouse_stock / product_variants.stock / variant_warehouse_stock) = Σ inventory_ledger زنده',
    mismatch_count: rows.length,
    mismatched_products: products.size,
    rows: rows.slice(0, limit),
    unattributed_count: unattributed.length,
    unattributed: unattributed.slice(0, limit),
  };
}

module.exports = {
  WAREHOUSE_ONLY_EVENTS,
  ensureStockCacheSchema,
  withCacheWriter,
  deriveProductStock,
  rebuildStockCache,
  rebuildAllStockCaches,
  derivedQty,
  stockCacheVsLedger,
};
