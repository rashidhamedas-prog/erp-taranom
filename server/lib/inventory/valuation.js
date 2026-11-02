'use strict';
/**
 * Inventory valuation engine (v521).
 *
 * - Policy: valuation level (product | warehouse) + costing-method precedence.
 * - Buckets: AVCO state per product×warehouse, derived from inventory_ledger in id order
 *   (pure function of posted rows — rebuildBuckets() reproduces incremental state).
 * - Dirty queue: back-dated rows, negative-stock recovery, zero-cost inbound and value
 *   changes that could not land on remaining stock. Consumed by revaluation.js.
 * - previewReplay(): recompute outbound costs in (date,id) order from a date.
 *
 * Money: INTEGER rial. GL is never posted here — revaluation.js owns JEs.
 *
 * v522: valuation level resolves per (product, warehouse): product → category → warehouse →
 * global. Warehouses resolving 'product' share one pool (rate = Σvalue/Σqty of their
 * buckets); 'warehouse' ones keep their own bucket average. products.average_cost_rial
 * stays the company-wide average.
 */

const BUCKET_EPS = 1e-9;

const ALIGN_SOURCE_TYPES = new Set(['opening_inventory', 'stock_reconcile']);
const REPLAY_SELF_SOURCE = 'inventory_revaluation_replay';
const ADJUSTABLE_OUT_EVENTS = new Set([
  'sale', 'issue', 'production_issue', 'transfer_out', 'adjustment', 'cycle_count',
  'scrap', 'wastage', 'consumption', 'material_issue', 'consignment_out',
]);
const QUEUE_REASONS = ['back_dated', 'negative_recovery', 'zero_cost_inbound', 'value_change_after_sale'];

function isDeviceRole() {
  return process.env.SYNC_ROLE === 'device';
}

function setting(db, key, fallback = '') {
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return r?.value != null && r.value !== '' ? String(r.value) : fallback;
  } catch (_) {
    return fallback;
  }
}

function setSetting(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function ensureColumn(db, table, name, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function valErr(code, status, message, extra) {
  const e = new Error(message || code);
  e.code = code;
  e.status = status || 400;
  if (extra) e.extra = extra;
  return e;
}

/* ───────────────────────────── schema ───────────────────────────── */

const _ready = new WeakSet();

function ensureValuationSchema(db, opts = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_valuation_buckets (
      product_id     INTEGER NOT NULL,
      warehouse_id   INTEGER NOT NULL DEFAULT 0,
      qty            REAL NOT NULL DEFAULT 0,
      value_rial     INTEGER NOT NULL DEFAULT 0,
      avg_rial       INTEGER NOT NULL DEFAULT 0,
      last_ledger_id INTEGER,
      updated_at     INTEGER,
      PRIMARY KEY (product_id, warehouse_id)
    );

    CREATE TABLE IF NOT EXISTS inventory_valuation_queue (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id     INTEGER NOT NULL,
      warehouse_id   INTEGER NOT NULL DEFAULT 0,
      from_date      TEXT DEFAULT '',
      from_ledger_id INTEGER,
      reason         TEXT NOT NULL,
      amount_rial    INTEGER NOT NULL DEFAULT 0,
      source_type    TEXT DEFAULT '',
      source_id      INTEGER,
      status         TEXT NOT NULL DEFAULT 'pending',
      run_id         INTEGER,
      created_at     INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS ix_inv_val_queue_status ON inventory_valuation_queue(status, product_id);
    CREATE INDEX IF NOT EXISTS ix_inv_val_queue_run ON inventory_valuation_queue(run_id);

    CREATE TABLE IF NOT EXISTS inventory_valuation_value_applied (
      ledger_id           INTEGER PRIMARY KEY,
      header_applied_rial INTEGER NOT NULL DEFAULT 0,
      unapplied_rial      INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS inventory_revaluations (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_no               TEXT,
      mode                 TEXT NOT NULL DEFAULT 'manual',
      basis                TEXT NOT NULL,
      rule_id              INTEGER,
      date                 TEXT NOT NULL DEFAULT '',
      date_from            TEXT DEFAULT '',
      scope_json           TEXT,
      status               TEXT NOT NULL DEFAULT 'posted',
      je_id                INTEGER,
      reversed_je_id       INTEGER,
      line_count           INTEGER NOT NULL DEFAULT 0,
      delta_inventory_rial INTEGER NOT NULL DEFAULT 0,
      delta_counter_rial   INTEGER NOT NULL DEFAULT 0,
      preview_hash         TEXT,
      note                 TEXT DEFAULT '',
      created_by           INTEGER,
      created_at           INTEGER DEFAULT (strftime('%s','now')),
      reversed_at          INTEGER,
      reversed_by          INTEGER
    );
    CREATE INDEX IF NOT EXISTS ix_inv_reval_hash ON inventory_revaluations(preview_hash, status);

    CREATE TABLE IF NOT EXISTS inventory_revaluation_lines (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      revaluation_id       INTEGER NOT NULL,
      product_id           INTEGER NOT NULL,
      warehouse_id         INTEGER NOT NULL DEFAULT 0,
      qty_on_hand          REAL NOT NULL DEFAULT 0,
      old_unit_rial        INTEGER NOT NULL DEFAULT 0,
      new_unit_rial        INTEGER NOT NULL DEFAULT 0,
      delta_inventory_rial INTEGER NOT NULL DEFAULT 0,
      delta_cogs_rial      INTEGER NOT NULL DEFAULT 0,
      ledger_ids_json      TEXT,
      adjusts_json         TEXT,
      note                 TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS ix_inv_reval_lines ON inventory_revaluation_lines(revaluation_id);

    CREATE TABLE IF NOT EXISTS inventory_revaluation_adjustments (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      revaluation_id INTEGER NOT NULL,
      line_id        INTEGER,
      ledger_id      INTEGER NOT NULL,
      kind           TEXT NOT NULL DEFAULT 'outbound',
      delta_rial     INTEGER NOT NULL DEFAULT 0,
      counter_code   TEXT,
      status         TEXT NOT NULL DEFAULT 'posted',
      created_at     INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS ix_inv_reval_adj_ledger ON inventory_revaluation_adjustments(ledger_id, status);
    CREATE INDEX IF NOT EXISTS ix_inv_reval_adj_reval ON inventory_revaluation_adjustments(revaluation_id);

    CREATE TABLE IF NOT EXISTS inventory_revaluation_rules (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      name               TEXT NOT NULL,
      enabled            INTEGER NOT NULL DEFAULT 1,
      triggers_json      TEXT NOT NULL DEFAULT '[]',
      basis              TEXT NOT NULL DEFAULT 'replay',
      warehouse_ids_json TEXT DEFAULT '[]',
      category_ids_json  TEXT DEFAULT '[]',
      product_ids_json   TEXT DEFAULT '[]',
      threshold_rial     INTEGER NOT NULL DEFAULT 0,
      threshold_pct      REAL NOT NULL DEFAULT 0,
      percent            REAL,
      action             TEXT NOT NULL DEFAULT 'review',
      schedule           TEXT NOT NULL DEFAULT 'none',
      last_run_at        INTEGER,
      created_by         INTEGER,
      created_at         INTEGER DEFAULT (strftime('%s','now')),
      updated_at         INTEGER
    );
  `);
  ensureColumn(db, 'inventory_revaluations', 'preview_hash', 'TEXT');
  ensureColumn(db, 'inventory_revaluation_rules', 'percent', 'REAL');
  // v522: per-layer valuation level (NULL = inherit) + customizable rule schedule
  for (const t of ['products', 'product_categories', 'warehouses']) {
    if (tableExists(db, t)) ensureColumn(db, t, 'valuation_level', 'TEXT');
  }
  ensureColumn(db, 'inventory_revaluation_rules', 'schedule_json', 'TEXT');
  ensureColumn(db, 'inventory_revaluation_rules', 'last_run_slot', 'TEXT');
  require('./period-lock').ensurePeriodLockSchema(db);
  require('./value-approval').ensureValueApprovalSchema(db);
  if (!isDeviceRole() && opts.migrate !== false) {
    try { require('./revaluation').migrateRuleSchedulesV522(db); } catch (_) { /* first boot */ }
  }

  if (!isDeviceRole() && opts.migrate !== false) migratePolicyV521(db);

  const hasLedger = tableExists(db, 'inventory_ledger');
  if (hasLedger && opts.rebuild !== false) {
    const anyBucket = db.prepare('SELECT 1 FROM inventory_valuation_buckets LIMIT 1').get();
    if (!anyBucket) {
      const anyLedger = db.prepare('SELECT 1 FROM inventory_ledger LIMIT 1').get();
      if (anyLedger) rebuildBuckets(db);
    }
  }
  _ready.add(db);
  return { ok: true };
}

/** Lazy guard for callers that run before db.js wires ensureValuationSchema. */
function ready(db) {
  if (_ready.has(db)) return true;
  try {
    if (tableExists(db, 'inventory_valuation_buckets') && tableExists(db, 'inventory_revaluation_rules')) {
      _ready.add(db);
      return true;
    }
    if (!tableExists(db, 'settings') || !tableExists(db, 'products')) return false;
    ensureValuationSchema(db);
    return true;
  } catch (_) {
    return false;
  }
}

function migratePolicyV521(db) {
  if (!tableExists(db, 'settings') || !tableExists(db, 'products')) return;
  if (setting(db, 'valuation_policy_v521_migrated', '') === '1') return;
  const run = () => {
    const scope = setting(db, 'costing_scope', '');
    if (!setting(db, 'costing_method_precedence', '')) {
      setSetting(db, 'costing_method_precedence', scope === 'per-warehouse' ? 'warehouse_first' : 'product_first');
    }
    if (!setting(db, 'inventory_valuation_level', '')) setSetting(db, 'inventory_valuation_level', 'product');
    const cols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
    if (cols.includes('costing_method')) {
      db.prepare("UPDATE products SET costing_method=NULL WHERE costing_method='moving_average'").run();
    }
    setSetting(db, 'valuation_policy_v521_migrated', '1');
  };
  if (db.inTransaction) run(); else db.transaction(run)();
}

/* ───────────────────────────── policy ───────────────────────────── */

const METHODS = new Set(['moving_average', 'fifo', 'specific']);

function normMethod(m) {
  const s = String(m || '').trim().toLowerCase();
  return METHODS.has(s) ? s : '';
}

function getLevel(db) {
  return setting(db, 'inventory_valuation_level', 'product') === 'warehouse' ? 'warehouse' : 'product';
}

function normLevel(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === 'product' || s === 'warehouse' ? s : '';
}

function colValue(db, sql, id) {
  try { return db.prepare(sql).get(id) || null; } catch (_) { return null; }
}

/**
 * v522: effective valuation level for one (product, warehouse) pair.
 * product → category (walks up to 5 parents) → warehouse → global setting. NULL = inherit.
 * 'product' = shared company pool; 'warehouse' = separate pool for that warehouse.
 */
function levelFor(db, productId, warehouseId) {
  if (productId) {
    const p = colValue(db, 'SELECT valuation_level, category_id FROM products WHERE id=?', productId);
    const pl = normLevel(p && p.valuation_level);
    if (pl) return { level: pl, source: 'product' };
    let catId = p && p.category_id;
    for (let i = 0; catId && i < 6; i++) {
      const c = colValue(db, 'SELECT valuation_level, parent_id FROM product_categories WHERE id=?', catId);
      if (!c) break;
      const cl = normLevel(c.valuation_level);
      if (cl) return { level: cl, source: 'category', category_id: catId };
      catId = c.parent_id;
    }
  }
  if (warehouseId) {
    const w = colValue(db, 'SELECT valuation_level FROM warehouses WHERE id=?', warehouseId);
    const wl = normLevel(w && w.valuation_level);
    if (wl) return { level: wl, source: 'warehouse' };
  }
  return { level: getLevel(db), source: 'global' };
}

/**
 * Pool layout of one product over all warehouses (+ bucket keys incl. 0 = no warehouse).
 * mode: 'product' (all shared → header avg), 'warehouse' (all separate), 'mixed'.
 */
function productPools(db, productId) {
  const keys = new Set([0]);
  try { for (const w of db.prepare('SELECT id FROM warehouses').all()) keys.add(Number(w.id)); } catch (_) { /* old schema */ }
  try {
    for (const b of db.prepare('SELECT warehouse_id FROM inventory_valuation_buckets WHERE product_id=?').all(productId)) {
      keys.add(Number(b.warehouse_id) || 0);
    }
  } catch (_) { /* not ready */ }
  const shared = new Set();
  const separate = new Set();
  for (const k of keys) {
    if (!k) continue;
    if (levelFor(db, productId, k).level === 'warehouse') separate.add(k);
    else shared.add(k);
  }
  let mode = 'mixed';
  if (!separate.size && !shared.size) mode = levelFor(db, productId, null).level;
  else if (!separate.size) mode = 'product';
  else if (!shared.size) mode = 'warehouse';
  // Rows without a warehouse belong to the shared pool (or to themselves in pure warehouse mode).
  if (mode === 'warehouse') separate.add(0); else shared.add(0);
  return { mode, shared, separate };
}

/** Shared-pool totals over non-WIP buckets that resolve to 'product'. */
function sharedPoolState(db, productId, pools) {
  const pp = pools || productPools(db, productId);
  const wip = wipWarehouseIds(db);
  let q = 0;
  let v = 0;
  for (const b of db.prepare('SELECT warehouse_id, qty, value_rial FROM inventory_valuation_buckets WHERE product_id=?').all(productId)) {
    const k = Number(b.warehouse_id) || 0;
    if (!pp.shared.has(k) || wip.has(k)) continue;
    q += Number(b.qty) || 0;
    v += Math.round(Number(b.value_rial) || 0);
  }
  return { qty: q, value_rial: v, avg_rial: q > BUCKET_EPS ? Math.max(0, Math.round(v / q)) : 0 };
}

/**
 * Outbound rate for a (product, warehouse) under AVCO.
 * Returns { unit|null, source: 'header'|'bucket'|'shared_pool', level, mode }.
 * unit=null means "use the header average" (pure product mode or empty pool).
 */
function poolRate(db, productId, warehouseId) {
  const lv = levelFor(db, productId, warehouseId || null);
  if (lv.level === 'warehouse' && warehouseId) {
    const b = getBucket(db, productId, warehouseId);
    if (b && Number(b.qty) > BUCKET_EPS && Number(b.avg_rial) > 0) {
      return { unit: Math.round(Number(b.avg_rial)), source: 'bucket', level: 'warehouse', level_source: lv.source };
    }
    return { unit: null, source: 'header', level: 'warehouse', level_source: lv.source };
  }
  const pools = productPools(db, productId);
  if (pools.mode === 'product') return { unit: null, source: 'header', level: 'product', level_source: lv.source, mode: pools.mode };
  const st = sharedPoolState(db, productId, pools);
  if (st.qty > BUCKET_EPS && st.avg_rial > 0) {
    return { unit: st.avg_rial, source: 'shared_pool', level: 'product', level_source: lv.source, mode: pools.mode, pool: st };
  }
  return { unit: null, source: 'header', level: 'product', level_source: lv.source, mode: pools.mode };
}

/** Keep products.average_cost_rial = company-wide average when pool rates diverge from it. */
function syncHeaderAvgFromBuckets(db, productId) {
  try {
    const p = db.prepare('SELECT stock, average_cost_rial FROM products WHERE id=?').get(productId);
    const stock = Number(p && p.stock) || 0;
    if (stock <= BUCKET_EPS) return null;
    const wip = wipWarehouseIds(db);
    let q = 0;
    let v = 0;
    for (const b of db.prepare('SELECT warehouse_id, qty, value_rial FROM inventory_valuation_buckets WHERE product_id=?').all(productId)) {
      if (wip.has(Number(b.warehouse_id))) continue;
      q += Number(b.qty) || 0;
      v += Math.round(Number(b.value_rial) || 0);
    }
    if (Math.abs(q - stock) > 1e-6 || q <= BUCKET_EPS) return null;
    const avg = Math.max(0, Math.round(v / q));
    if (avg === Math.round(Number(p.average_cost_rial) || 0)) return avg;
    const { catalogCostFromAvgRial } = require('./product-unit-cost');
    db.prepare('UPDATE products SET average_cost_rial=?, cost=? WHERE id=?').run(avg, catalogCostFromAvgRial(avg), productId);
    return avg;
  } catch (_) { return null; }
}

/** Last purchase unit of the same pool (warehouse pool → that warehouse; shared → shared warehouses). */
function lastPurchaseUnitForPool(db, productId, warehouseId) {
  const lv = levelFor(db, productId, warehouseId || null);
  let where = '';
  const params = [productId];
  if (lv.level === 'warehouse' && warehouseId) {
    where = ' AND warehouse_id=?';
    params.push(warehouseId);
  } else {
    const pools = productPools(db, productId);
    if (pools.mode === 'mixed') {
      const ids = [...pools.separate].filter((k) => k > 0);
      if (ids.length) {
        where = ` AND COALESCE(warehouse_id,0) NOT IN (${ids.map(() => '?').join(',')})`;
        params.push(...ids);
      }
    }
  }
  const r = db.prepare(`
    SELECT unit_cost_rial FROM inventory_ledger
    WHERE product_id=? AND status='posted' AND event_type IN ('purchase','receipt')
      AND qty_in>0 AND unit_cost_rial>0 AND reversed_of IS NULL${where}
    ORDER BY COALESCE(date,'') DESC, id DESC LIMIT 1
  `).get(...params);
  return r ? Math.round(Number(r.unit_cost_rial) || 0) : 0;
}

/** Forward-only edit of a layer's valuation_level; enqueues a review row when buckets exist. */
function setLayerLevel(db, table, id, value, { userId } = {}) {
  if (!['products', 'product_categories', 'warehouses'].includes(table)) return null;
  const next = normLevel(value) || null;
  const cur = colValue(db, `SELECT valuation_level FROM ${table} WHERE id=?`, id);
  if (!cur) return null;
  const prev = normLevel(cur.valuation_level) || null;
  if (prev === next) return { changed: false, level: next };
  db.prepare(`UPDATE ${table} SET valuation_level=? WHERE id=?`).run(next, id);
  try {
    require('../../db').audit(userId || null, 'update', 'valuation_level', id, `${table}#${id}: ${prev || 'inherit'} → ${next || 'inherit'} (فقط رو به جلو)`);
  } catch (_) { /* optional */ }
  return { changed: true, level: next, previous: prev };
}

function getPrecedence(db) {
  const p = setting(db, 'costing_method_precedence', '');
  if (p === 'warehouse_first' || p === 'product_first') return p;
  return setting(db, 'costing_scope', '') === 'per-warehouse' ? 'warehouse_first' : 'product_first';
}

/**
 * products.costing_method='moving_average' is the column DEFAULT, so it is treated as
 * "inherit" (same as NULL). Only fifo/specific on a product are explicit overrides.
 */
function resolvePolicy(db, { productId, warehouseId } = {}) {
  const globalLevel = getLevel(db);
  const lv = (productId || warehouseId) ? levelFor(db, productId, warehouseId) : { level: globalLevel, source: 'global' };
  const level = lv.level;
  const precedence = getPrecedence(db);
  const globalMethod = normMethod(setting(db, 'inventory_costing_method', 'moving_average')) || 'moving_average';
  let pm = '';
  let wm = '';
  if (productId) {
    try {
      const p = db.prepare('SELECT costing_method FROM products WHERE id=?').get(productId);
      pm = normMethod(p?.costing_method);
      if (pm === 'moving_average') pm = '';
    } catch (_) { pm = ''; }
  }
  if (warehouseId) {
    try {
      const w = db.prepare('SELECT costing_method FROM warehouses WHERE id=?').get(warehouseId);
      wm = normMethod(w?.costing_method);
    } catch (_) { wm = ''; }
  }
  let method = globalMethod;
  let source = 'global';
  const order = precedence === 'warehouse_first'
    ? [['warehouse', wm], ['product', pm]]
    : [['product', pm], ['warehouse', wm]];
  for (const [src, m] of order) {
    if (m) { method = m; source = src; break; }
  }
  return {
    level, level_source: lv.source, global_level: globalLevel,
    method, method_source: source, precedence, global_method: globalMethod,
  };
}

function getPolicy(db) {
  return {
    level: getLevel(db),
    method_global: normMethod(setting(db, 'inventory_costing_method', 'moving_average')) || 'moving_average',
    precedence: getPrecedence(db),
    migrated_v521: setting(db, 'valuation_policy_v521_migrated', '') === '1',
    legacy_costing_scope: setting(db, 'costing_scope', '') || null,
  };
}

function setPolicy(db, body = {}) {
  const out = {};
  if (body.level != null) {
    if (!['product', 'warehouse'].includes(body.level)) {
      throw valErr('E_POLICY_LEVEL', 400, 'سطح ارزش‌گذاری باید product یا warehouse باشد');
    }
    out.inventory_valuation_level = body.level;
  }
  if (body.method_global != null) {
    const m = normMethod(body.method_global);
    if (!m) throw valErr('E_POLICY_METHOD', 400, 'روش بهای تمام‌شده نامعتبر است');
    out.inventory_costing_method = m;
  }
  if (body.precedence != null) {
    if (!['product_first', 'warehouse_first'].includes(body.precedence)) {
      throw valErr('E_POLICY_PRECEDENCE', 400, 'اولویت روش باید product_first یا warehouse_first باشد');
    }
    out.costing_method_precedence = body.precedence;
  }
  db.transaction(() => {
    for (const [k, v] of Object.entries(out)) setSetting(db, k, v);
  })();
  return getPolicy(db);
}

/* ───────────────────────── pure AVCO state ops ───────────────────────── */

function newState(q = 0, v = 0, avg = 0) {
  return { q: Number(q) || 0, v: Math.round(Number(v) || 0), avg: Math.round(Number(avg) || 0) };
}

function headerState(qty, avg) {
  const q = Number(qty) || 0;
  const a = Math.round(Number(avg) || 0);
  return newState(q, Math.round(q * a), a);
}

/**
 * Inbound. When on-hand ≤ 0 the new average is the inbound unit cost (never the
 * blended garbage of a negative balance); the value that the negative balance was
 * under/over-costed by is returned as trueup (owed to COGS via revaluation).
 */
function stIn(st, qtyIn, amountRial) {
  const q = Number(qtyIn) || 0;
  const amt = Math.round(Number(amountRial) || 0);
  if (q <= 0) return { trueup: 0 };
  if (st.q <= BUCKET_EPS) {
    const unit = amt > 0 ? amt / q : st.avg;
    const qAfter = st.q + q;
    const newV = Math.round(qAfter * unit);
    const trueup = st.v + amt - newV;
    st.q = qAfter;
    st.v = newV;
    st.avg = Math.round(unit);
    return { trueup };
  }
  st.v += amt;
  st.q += q;
  if (st.q > BUCKET_EPS) {
    st.avg = Math.round(st.v / st.q);
    if (st.avg < 0) st.avg = 0;
  }
  return { trueup: 0 };
}

/** Outbound at amountRial. Plain outbound at avg keeps avg; value-based (reversal) re-averages. */
function stOut(st, qtyOut, amountRial) {
  const q = Number(qtyOut) || 0;
  const amt = Math.round(Number(amountRial) || 0);
  st.v -= amt;
  st.q -= q;
  if (st.q > BUCKET_EPS) {
    const a = Math.round(st.v / st.q);
    st.avg = a < 0 ? 0 : a;
  }
  return {};
}

/** Value-only change. Lands only on positive on-hand; returns applied part. */
function stValue(st, deltaRial) {
  const d = Math.round(Number(deltaRial) || 0);
  if (!d) return 0;
  if (st.q <= BUCKET_EPS) return 0;
  let applied = d;
  if (st.v + d < 0) applied = -st.v;
  st.v += applied;
  st.avg = Math.round(st.v / st.q);
  if (st.avg < 0) st.avg = 0;
  return applied;
}

/* ───────────────────────────── buckets ───────────────────────────── */

function wipWarehouseIds(db) {
  try {
    return new Set(db.prepare(
      "SELECT id FROM warehouses WHERE kind='wip' OR warehouse_type='wip'"
    ).all().map((w) => Number(w.id)));
  } catch (_) {
    try {
      return new Set(db.prepare("SELECT id FROM warehouses WHERE warehouse_type='wip'").all().map((w) => Number(w.id)));
    } catch (__) { return new Set(); }
  }
}

function whKey(warehouseId) {
  const n = parseInt(warehouseId, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Spread a null-warehouse value change over non-WIP buckets with positive qty. */
function spreadValue(buckets, deltaRial, wipIds) {
  const d = Math.round(Number(deltaRial) || 0);
  const targets = [...buckets.entries()]
    .filter(([k, st]) => st.q > BUCKET_EPS && !wipIds.has(Number(k)))
    .sort((a, b) => a[0] - b[0]);
  if (!targets.length) {
    if (!buckets.has(0)) buckets.set(0, newState());
    return [{ key: 0, delta: d }];
  }
  const totalQ = targets.reduce((s, [, st]) => s + st.q, 0);
  let left = d;
  return targets.map(([k, st], i) => {
    const part = i === targets.length - 1 ? left : Math.round(d * (st.q / totalQ));
    left -= part;
    return { key: k, delta: part };
  });
}

/**
 * Apply one ledger row to an in-memory bucket map (shared by incremental posting
 * and rebuildBuckets so both produce the same state).
 */
function applyRowToBucketMap(buckets, row, wipIds) {
  const qIn = Number(row.qty_in) || 0;
  const qOut = Number(row.qty_out) || 0;
  const amt = Math.round(Number(row.amount_rial) || 0);
  const key = whKey(row.warehouse_id);
  const touched = new Set();
  let trueup = 0;
  let applied = 0;
  if (!qIn && !qOut) {
    if (!amt) return { touched, trueup, applied };
    const parts = row.warehouse_id ? [{ key, delta: amt }] : spreadValue(buckets, amt, wipIds);
    for (const p of parts) {
      if (!buckets.has(p.key)) buckets.set(p.key, newState());
      applied += stValue(buckets.get(p.key), p.delta);
      touched.add(p.key);
    }
    return { touched, trueup, applied };
  }
  if (!buckets.has(key)) buckets.set(key, newState());
  const st = buckets.get(key);
  if (qIn > 0) trueup = stIn(st, qIn, amt).trueup;
  if (qOut > 0) stOut(st, qOut, amt);
  touched.add(key);
  return { touched, trueup, applied };
}

function loadBucketMap(db, productId) {
  const m = new Map();
  for (const r of db.prepare(
    'SELECT warehouse_id, qty, value_rial, avg_rial FROM inventory_valuation_buckets WHERE product_id=?'
  ).all(productId)) {
    m.set(Number(r.warehouse_id) || 0, newState(r.qty, r.value_rial, r.avg_rial));
  }
  return m;
}

function saveBucket(db, productId, key, st, ledgerId) {
  db.prepare(`
    INSERT INTO inventory_valuation_buckets (product_id, warehouse_id, qty, value_rial, avg_rial, last_ledger_id, updated_at)
    VALUES (?,?,?,?,?,?,strftime('%s','now'))
    ON CONFLICT(product_id, warehouse_id) DO UPDATE SET
      qty=excluded.qty, value_rial=excluded.value_rial, avg_rial=excluded.avg_rial,
      last_ledger_id=excluded.last_ledger_id, updated_at=excluded.updated_at
  `).run(productId, key, st.q, Math.round(st.v), Math.round(st.avg), ledgerId || null);
}

/** Incremental hook called by postInventoryMovement for every inserted row. */
function applyLedgerRowToBuckets(db, row) {
  if (!ready(db)) return { trueup: 0, applied: 0, bucket: null };
  // A lazy first-time rebuild (ready → ensureValuationSchema) already folded this row in.
  if (row.id != null) {
    const seen = db.prepare(
      'SELECT warehouse_id, qty, value_rial, avg_rial FROM inventory_valuation_buckets WHERE product_id=? AND last_ledger_id>=? AND warehouse_id=?'
    ).get(row.product_id, row.id, whKey(row.warehouse_id));
    const anySeen = seen || db.prepare(
      'SELECT 1 FROM inventory_valuation_buckets WHERE product_id=? AND last_ledger_id>=? LIMIT 1'
    ).get(row.product_id, row.id);
    if (anySeen) {
      return { trueup: 0, applied: 0, bucket: seen ? { warehouse_id: Number(seen.warehouse_id) || 0, qty: seen.qty, value_rial: seen.value_rial, avg_rial: seen.avg_rial } : null };
    }
  }
  const buckets = loadBucketMap(db, row.product_id);
  const res = applyRowToBucketMap(buckets, row, wipWarehouseIds(db));
  for (const k of res.touched) saveBucket(db, row.product_id, k, buckets.get(k), row.id);
  const key = whKey(row.warehouse_id);
  const b = buckets.get(key) || null;
  return { trueup: res.trueup, applied: res.applied, bucket: b ? { warehouse_id: key, qty: b.q, value_rial: b.v, avg_rial: b.avg } : null };
}

function getBucket(db, productId, warehouseId) {
  if (!ready(db)) return null;
  const r = db.prepare(
    'SELECT * FROM inventory_valuation_buckets WHERE product_id=? AND warehouse_id=?'
  ).get(productId, whKey(warehouseId));
  return r || null;
}

function listBuckets(db, { productId } = {}) {
  ready(db);
  const where = productId ? 'WHERE b.product_id=?' : '';
  const params = productId ? [productId] : [];
  return db.prepare(`
    SELECT b.*, p.name AS product_name, p.code AS product_code, w.name AS warehouse_name
    FROM inventory_valuation_buckets b
    LEFT JOIN products p ON p.id=b.product_id
    LEFT JOIN warehouses w ON w.id=b.warehouse_id
    ${where}
    ORDER BY b.product_id, b.warehouse_id
    LIMIT 2000
  `).all(...params);
}

/** Replay inventory_ledger in id order (all statuses — mirrors stock tables) into buckets. */
function rebuildBuckets(db, { productId } = {}) {
  const wipIds = wipWarehouseIds(db);
  const run = () => {
    if (productId) db.prepare('DELETE FROM inventory_valuation_buckets WHERE product_id=?').run(productId);
    else db.prepare('DELETE FROM inventory_valuation_buckets').run();
    const stmt = productId
      ? db.prepare('SELECT id, product_id, warehouse_id, qty_in, qty_out, amount_rial FROM inventory_ledger WHERE product_id=? ORDER BY id')
      : db.prepare('SELECT id, product_id, warehouse_id, qty_in, qty_out, amount_rial FROM inventory_ledger ORDER BY product_id, id');
    let cur = null;
    let buckets = new Map();
    let lastId = null;
    let products = 0;
    let rows = 0;
    const flush = () => {
      if (cur == null) return;
      for (const [k, st] of buckets) saveBucket(db, cur, k, st, lastId);
      products += 1;
    };
    for (const r of (productId ? stmt.all(productId) : stmt.all())) {
      if (r.product_id !== cur) {
        flush();
        cur = r.product_id;
        buckets = new Map();
      }
      applyRowToBucketMap(buckets, r, wipIds);
      lastId = r.id;
      rows += 1;
    }
    flush();
    return { products, rows };
  };
  return db.inTransaction ? run() : db.transaction(run)();
}

/* ───────────────────────────── queue ───────────────────────────── */

function enqueue(db, {
  productId, warehouseId = 0, fromDate = '', fromLedgerId = null, reason,
  amountRial = 0, sourceType = '', sourceId = null,
}) {
  if (isDeviceRole() || !ready(db)) return null;
  if (!productId || !reason) return null;
  const key = whKey(warehouseId);
  const amt = Math.round(Number(amountRial) || 0);
  const existing = db.prepare(`
    SELECT id, from_date, from_ledger_id, amount_rial FROM inventory_valuation_queue
    WHERE product_id=? AND warehouse_id=? AND reason=? AND status='pending'
    ORDER BY id DESC LIMIT 1
  `).get(productId, key, reason);
  const fd = String(fromDate || '');
  if (existing) {
    const prevFd = String(existing.from_date || '');
    const minFd = !prevFd ? fd : (!fd ? prevFd : (fd < prevFd ? fd : prevFd));
    const prevLid = existing.from_ledger_id;
    const minLid = prevLid == null ? fromLedgerId : (fromLedgerId == null ? prevLid : Math.min(prevLid, fromLedgerId));
    db.prepare(`
      UPDATE inventory_valuation_queue
      SET from_date=?, from_ledger_id=?, amount_rial=amount_rial+?, source_type=?, source_id=?
      WHERE id=?
    `).run(minFd, minLid, amt, sourceType || '', sourceId, existing.id);
    return existing.id;
  }
  return db.prepare(`
    INSERT INTO inventory_valuation_queue
      (product_id, warehouse_id, from_date, from_ledger_id, reason, amount_rial, source_type, source_id, status)
    VALUES (?,?,?,?,?,?,?,?,'pending')
  `).run(productId, key, fd, fromLedgerId, reason, amt, sourceType || '', sourceId).lastInsertRowid;
}

function listQueue(db, { status = 'pending', productId, limit = 500 } = {}) {
  ready(db);
  const where = [];
  const params = [];
  if (status && status !== 'all') { where.push('q.status=?'); params.push(status); }
  if (productId) { where.push('q.product_id=?'); params.push(productId); }
  const lim = Math.min(2000, Math.max(1, Number(limit) || 500));
  return db.prepare(`
    SELECT q.*, p.name AS product_name, p.code AS product_code, w.name AS warehouse_name
    FROM inventory_valuation_queue q
    LEFT JOIN products p ON p.id=q.product_id
    LEFT JOIN warehouses w ON w.id=q.warehouse_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY q.id DESC LIMIT ?
  `).all(...params, lim);
}

function ignoreQueueItem(db, id) {
  ready(db);
  const row = db.prepare('SELECT * FROM inventory_valuation_queue WHERE id=?').get(Number(id));
  if (!row) throw valErr('E_QUEUE_NOT_FOUND', 404, 'ردیف صف ارزش‌گذاری یافت نشد');
  if (row.status !== 'pending') throw valErr('E_QUEUE_NOT_PENDING', 409, 'فقط ردیف در انتظار قابل نادیده‌گرفتن است');
  db.prepare("UPDATE inventory_valuation_queue SET status='ignored' WHERE id=?").run(row.id);
  return db.prepare('SELECT * FROM inventory_valuation_queue WHERE id=?').get(row.id);
}

/**
 * Called by postInventoryMovement after the row is inserted. Never posts GL.
 */
function afterMovementPosted(db, ctx) {
  if (isDeviceRole() || !ready(db)) return;
  const {
    ledgerId, productId, warehouseId, eventType, sourceType, sourceId, date,
    qtyIn, amount, method, level, headerTrueup, bucketTrueup, unappliedRial,
    warehouseOnly, isReversal, isAlign, valueOnly,
  } = ctx;
  if (warehouseOnly) return;
  if (method !== 'moving_average') return;
  if (String(sourceType || '') === REPLAY_SELF_SOURCE) return;
  const wk = level === 'warehouse' ? whKey(warehouseId) : 0;
  const base = { productId, warehouseId: wk, fromDate: date || '', fromLedgerId: ledgerId, sourceType, sourceId };

  const trueup = level === 'warehouse' ? Math.round(bucketTrueup || 0) : Math.round(headerTrueup || 0);
  if (trueup && (ctx.qtyBefore < -BUCKET_EPS || Math.abs(trueup) > Math.max(10, Math.abs(amount || 0) * 0.001))) {
    enqueue(db, { ...base, reason: 'negative_recovery', amountRial: trueup });
  }
  if (qtyIn > 0 && !Math.round(amount || 0) && !isReversal && !isAlign) {
    enqueue(db, { ...base, reason: 'zero_cost_inbound', amountRial: 0 });
  }
  if (valueOnly && unappliedRial) {
    enqueue(db, { ...base, reason: 'value_change_after_sale', amountRial: unappliedRial });
  }
  if (date && !isAlign) {
    const mx = db.prepare(`
      SELECT MAX(date) m FROM inventory_ledger
      WHERE product_id=? AND id<>? AND status='posted' AND date<>''
    `).get(productId, ledgerId)?.m;
    if (mx && String(mx) > String(date)) {
      enqueue(db, { ...base, reason: 'back_dated', amountRial: 0 });
    }
  }
  void eventType;
}

function recordValueApplied(db, ledgerId, applied, unapplied) {
  if (!ready(db)) return;
  db.prepare(`
    INSERT OR REPLACE INTO inventory_valuation_value_applied (ledger_id, header_applied_rial, unapplied_rial)
    VALUES (?,?,?)
  `).run(ledgerId, Math.round(applied || 0), Math.round(unapplied || 0));
}

function valueAppliedFor(db, ledgerId) {
  if (!ready(db)) return null;
  const r = db.prepare('SELECT header_applied_rial FROM inventory_valuation_value_applied WHERE ledger_id=?').get(ledgerId);
  return r ? Math.round(Number(r.header_applied_rial) || 0) : null;
}

/* ─────────────────────── postValueAdjustment ─────────────────────── */

/**
 * Post a value-only inventory_ledger row and move header avg + bucket by value.
 * refQty (optional): qty the adjustment originally related to (e.g. receipt qty). When
 * part of it was already sold, splitSold=true returns cogs_rial for the caller to book;
 * otherwise the sold share is queued as value_change_after_sale.
 * Never divides by qty ≤ 0: unapplied_rial is returned (and queued).
 */
function postValueAdjustment(db, {
  productId, warehouseId = null, deltaRial, date = '', sourceType = 'cost_adjustment',
  sourceId = null, note = '', createdBy = null, eventType = 'cost_adjustment',
  refQty = null, splitSold = false, jeId = null, emptyUnitRial = null,
}) {
  const { postInventoryMovement } = require('./ledger');
  const delta = Math.round(Number(deltaRial) || 0);
  const out = { ledger_id: null, tx_no: null, applied_rial: 0, unapplied_rial: 0, cogs_rial: 0, avg_after_rial: null };
  if (!delta) return out;
  const prod = db.prepare('SELECT stock, average_cost_rial FROM products WHERE id=?').get(productId);
  if (!prod) throw valErr('E_PRODUCT_NOT_FOUND', 404, 'کالا یافت نشد');
  let invPart = delta;
  const rq = Number(refQty) || 0;
  if (rq > 0) {
    const onHand = Math.max(0, Number(prod.stock) || 0);
    const soldQty = Math.min(rq, Math.max(0, rq - onHand));
    if (soldQty > 0) {
      const soldPart = Math.round(delta * (soldQty / rq));
      if (splitSold) {
        out.cogs_rial = soldPart;
        invPart = delta - soldPart;
      } else if (soldPart) {
        enqueue(db, {
          productId, warehouseId: getLevel(db) === 'warehouse' ? whKey(warehouseId) : 0,
          fromDate: date, reason: 'value_change_after_sale', amountRial: soldPart, sourceType, sourceId,
        });
      }
    }
  }
  if (!invPart) return out;
  let targetWh = warehouseId || null;
  if (!targetWh) {
    // Mixed pools: a warehouse-less value change belongs to the shared pool only.
    const pools = productPools(db, productId);
    if (pools.mode === 'mixed') {
      const wip = wipWarehouseIds(db);
      const best = db.prepare(`
        SELECT warehouse_id FROM inventory_valuation_buckets WHERE product_id=? AND qty>0 ORDER BY qty DESC, warehouse_id
      `).all(productId).map((b) => Number(b.warehouse_id) || 0).find((k) => k && pools.shared.has(k) && !wip.has(k));
      if (best) targetWh = best;
    }
  }
  const led = postInventoryMovement(db, {
    eventType,
    productId,
    warehouseId: targetWh,
    qtyIn: 0,
    qtyOut: 0,
    unitCostRial: Math.abs(invPart),
    amountRial: invPart,
    sourceType,
    sourceId,
    jeId,
    date,
    note,
    createdBy,
    updateAvg: false,
    skipStock: true,
    valueOnly: true,
  });
  out.ledger_id = led.id;
  out.tx_no = led.tx_no;
  out.applied_rial = led.value_applied_rial != null ? led.value_applied_rial : invPart;
  out.unapplied_rial = led.value_unapplied_rial || 0;
  out.avg_after_rial = led.avg_cost_after_rial;
  // Header qty exactly 0: the average carries no value, so seeding it with the target unit is value-neutral.
  const seed = Math.round(Number(emptyUnitRial) || 0);
  if (seed > 0 && Math.abs(Number(prod.stock) || 0) < BUCKET_EPS) {
    const { catalogCostFromAvgRial } = require('./product-unit-cost');
    db.prepare('UPDATE products SET average_cost_rial=?, cost=? WHERE id=?')
      .run(seed, catalogCostFromAvgRial(seed), productId);
    out.avg_after_rial = seed;
  }
  return out;
}

/* ───────────────────────────── replay ───────────────────────────── */

function counterKeyForEvent(eventType) {
  const e = String(eventType || '');
  if (e === 'sale' || e.startsWith('invoice') || e === 'consignment_out') return 'coa_cogs';
  if (e === 'production_issue' || e === 'material_issue' || e === 'consumption') return 'coa_wip';
  if (e === 'issue' || e === 'scrap' || e === 'wastage') return 'coa_inventory_loss';
  return 'coa_adjustment';
}

function isAlignRow(r) {
  const st = String(r.source_type || '');
  if (ALIGN_SOURCE_TYPES.has(st) || String(r.event_type || '') === 'opening') return true;
  const noteFa = String(r.note || '').replace(/\u200c/g, '').replace(/ي/g, 'ی');
  return /هم[\u200c\s]*ترازی\s*کاردکس/.test(noteFa) || /^موجودی اول دوره/.test(noteFa);
}

function postedAdjustmentsByLedger(db, ledgerIds) {
  const out = new Map();
  if (!ledgerIds.length || !ready(db)) return out;
  const chunk = 400;
  for (let i = 0; i < ledgerIds.length; i += chunk) {
    const ids = ledgerIds.slice(i, i + chunk);
    const rows = db.prepare(`
      SELECT ledger_id, kind, COALESCE(SUM(delta_rial),0) s
      FROM inventory_revaluation_adjustments
      WHERE status='posted' AND ledger_id IN (${ids.map(() => '?').join(',')})
      GROUP BY ledger_id, kind
    `).all(...ids);
    for (const r of rows) {
      const cur = out.get(r.ledger_id) || { outbound: 0, trueup: 0 };
      if (r.kind === 'trueup') cur.trueup += Number(r.s) || 0;
      else cur.outbound += Number(r.s) || 0;
      out.set(r.ledger_id, cur);
    }
  }
  return out;
}

/**
 * Replay posted, non-reversed rows of one product in (date,id) order.
 * Rows before fromDate keep their effective amounts (opening state); from fromDate on,
 * adjustable outbound rows are re-costed at the running average and inbound-into-
 * negative true-ups are recomputed. Returns per-row deltas + on-hand correction.
 */
function previewReplay(db, { productId, warehouseId = null, fromDate = '' } = {}) {
  ready(db);
  const { inventoryAccountForWarehouse, isWarehouseOnlyRow } = require('./ledger');
  const { acct } = require('../coa-map');
  const pid = Number(productId);
  const product = db.prepare('SELECT id, name, code, stock, average_cost_rial, warehouse_id FROM products WHERE id=?').get(pid);
  if (!product) throw valErr('E_PRODUCT_NOT_FOUND', 404, 'کالا یافت نشد');
  const level = getLevel(db);
  const policy = resolvePolicy(db, { productId: pid, warehouseId: warehouseId || product.warehouse_id || null });
  const from = String(fromDate || '');
  const base = {
    product_id: pid, product_code: product.code, product_name: product.name,
    level, method: policy.method, from_date: from, warehouse_id: warehouseId ? whKey(warehouseId) : null,
    lines: [], keys: [], adjust_total_rial: 0, onhand_delta_rial: 0,
  };
  if (policy.method !== 'moving_average') return { ...base, skipped: 'method_not_moving_average' };

  const all = db.prepare(`
    SELECT * FROM inventory_ledger WHERE product_id=? ORDER BY COALESCE(date,''), id
  `).all(pid);
  const statusById = new Map(all.map((r) => [r.id, r.status]));
  // v522: pool key per row — shared pool = 0, separate warehouse pool = its id.
  const pools = productPools(db, pid);
  const mode = pools.mode;
  const poolKey = (wid) => {
    const k = whKey(wid);
    if (mode === 'product') return 0;
    if (mode === 'warehouse') return k;
    return pools.separate.has(k) ? k : 0;
  };
  const pk0 = (r) => `${r.source_type || ''}|${r.source_id == null ? '' : r.source_id}`;
  const pairOf = new Map();
  {
    const ins = all.filter((r) => r.event_type === 'transfer_in');
    const used = new Set();
    for (const o of all) {
      if (o.event_type !== 'transfer_out') continue;
      const m = ins.find((x) => !used.has(x.id) && pk0(x) === pk0(o) && x.id > o.id
        && Math.abs((Number(x.qty_in) || 0) - (Number(o.qty_out) || 0)) < 1e-6);
      if (m) { used.add(m.id); pairOf.set(o.id, m); pairOf.set(m.id, o); }
    }
  }
  // audit-kardex K1: transfer_in already replays at its paired out amount, so a transfer_in_revalue
  // row is dropped here and only added back when its in-row has no pair (else it would double count).
  const TI_REVALUE = require('./transfer-in-revalue').EVENT_TYPE;
  const tiCorrByKey = new Map();
  const tiKey = (r) => `${r.source_type || ''}|${r.source_id == null ? '' : r.source_id}|${whKey(r.warehouse_id)}`;
  for (const r of all) {
    if (r.event_type !== TI_REVALUE || String(r.status || '') !== 'posted' || r.reversed_of != null) continue;
    tiCorrByKey.set(tiKey(r), (tiCorrByKey.get(tiKey(r)) || 0) + Math.round(Number(r.amount_rial) || 0));
  }
  const rows = all.filter((r) => {
    if (String(r.status || '') !== 'posted') return false;
    if (r.reversed_of && statusById.get(r.reversed_of) === 'reversed') return false;
    if (String(r.source_type || '') === REPLAY_SELF_SOURCE) return false;
    if (r.event_type === TI_REVALUE) return false;
    if (mode === 'warehouse') return true;
    if (isWarehouseOnlyRow(r) && poolKey(r.warehouse_id) === 0) return false;
    const et = String(r.event_type || '');
    if (et === 'transfer_out' || et === 'transfer_in') {
      if (mode === 'product') return false;
      const other = pairOf.get(r.id);
      // Transfer inside the shared pool does not move pool value.
      if (poolKey(r.warehouse_id) === 0 && (!other || poolKey(other.warehouse_id) === 0)) return false;
    }
    return true;
  });
  const adj = postedAdjustmentsByLedger(db, rows.map((r) => r.id));
  const wipIds = wipWarehouseIds(db);

  // Pair transfer_in with its transfer_out (same source + product).
  const outByPair = new Map();
  const pairKey = (r) => `${r.source_type || ''}|${r.source_id == null ? '' : r.source_id}`;
  for (const r of rows) if (r.event_type === 'transfer_out') {
    const k = pairKey(r);
    if (!outByPair.has(k)) outByPair.set(k, []);
    outByPair.get(k).push(r);
  }
  const newAmountByOutId = new Map();
  const consumedOut = new Set();

  const states = new Map();
  const stFor = (r) => {
    const k = poolKey(r.warehouse_id);
    if (!states.has(k)) states.set(k, newState());
    return { k, st: states.get(k) };
  };

  for (const r of rows) {
    const qIn = Number(r.qty_in) || 0;
    const qOut = Number(r.qty_out) || 0;
    const a = adj.get(r.id) || { outbound: 0, trueup: 0 };
    const effAmt = Math.round(Number(r.amount_rial) || 0) + a.outbound;
    const inWindow = !from || String(r.date || '') >= from;
    const et = String(r.event_type || '');

    if (!qIn && !qOut) {
      if (!effAmt) continue;
      if (mode !== 'warehouse' || r.warehouse_id) {
        stValue(stFor(r).st, effAmt);
      } else {
        for (const p of spreadValue(states, effAmt, wipIds)) {
          if (!states.has(p.key)) states.set(p.key, newState());
          stValue(states.get(p.key), p.delta);
        }
      }
      continue;
    }

    const { k, st } = stFor(r);
    if (qIn > 0) {
      let inAmt = effAmt;
      if (et === 'transfer_in') {
        const list = outByPair.get(pairKey(r)) || [];
        const pref = pairOf.get(r.id);
        const pair = (pref && !consumedOut.has(pref.id) && list.includes(pref)) ? pref
          : list.find((o) => !consumedOut.has(o.id) && Math.abs((Number(o.qty_out) || 0) - qIn) < 1e-6);
        if (pair) {
          consumedOut.add(pair.id);
          if (newAmountByOutId.has(pair.id)) inAmt = newAmountByOutId.get(pair.id);
          else {
            const pa = adj.get(pair.id) || { outbound: 0 };
            inAmt = Math.round(Number(pair.amount_rial) || 0) + pa.outbound;
          }
        } else {
          inAmt += tiCorrByKey.get(tiKey(r)) || 0;
        }
      }
      const qBefore = st.q;
      const { trueup } = stIn(st, qIn, inAmt);
      if (inWindow && !isAlignRow(r)) {
        const d = Math.round(trueup) - Math.round(a.trueup);
        if (d && (qBefore < -BUCKET_EPS || Math.abs(d) >= 1)) {
          const counter = acct(db, 'coa_cogs');
          const inv = inventoryAccountForWarehouse(db, r.warehouse_id || null);
          base.lines.push({
            ledger_id: r.id, tx_no: r.tx_no, date: r.date, event_type: et, kind: 'trueup',
            warehouse_id: whKey(r.warehouse_id), qty_out: 0,
            old_amount_rial: Math.round(a.trueup), new_amount_rial: Math.round(trueup), delta_rial: d,
            counter_code: counter.code, counter_name: counter.name,
            inventory_code: inv.code, inventory_name: inv.name, bucket_key: k,
          });
        }
      }
      continue;
    }

    // outbound
    const reversalish = et === 'reversal' || et.endsWith('_reversal') || et === 'purchase'
      || et === 'purchase_return' || r.reversed_of != null;
    const adjustable = inWindow && !reversalish && ADJUSTABLE_OUT_EVENTS.has(et) && !isAlignRow(r);
    let outAmt = effAmt;
    if (adjustable) {
      const unit = st.avg;
      const recomputed = Math.round(unit * qOut);
      const d = recomputed - effAmt;
      outAmt = recomputed;
      if (d) {
        let counter;
        let counterWh = null;
        let counterPool = null;
        if (et === 'transfer_out') {
          const dest = pairOf.get(r.id) || rows.find((x) => x.event_type === 'transfer_in' && pairKey(x) === pairKey(r)
            && Math.abs((Number(x.qty_in) || 0) - qOut) < 1e-6);
          counterWh = dest ? dest.warehouse_id : null;
          counterPool = dest ? poolKey(dest.warehouse_id) : null;
          counter = inventoryAccountForWarehouse(db, counterWh);
        } else {
          counter = acct(db, counterKeyForEvent(et));
        }
        const inv = inventoryAccountForWarehouse(db, r.warehouse_id || null);
        base.lines.push({
          ledger_id: r.id, tx_no: r.tx_no, date: r.date, event_type: et, kind: 'outbound',
          warehouse_id: whKey(r.warehouse_id), qty_out: qOut,
          old_amount_rial: effAmt, new_amount_rial: recomputed, delta_rial: d,
          counter_code: counter.code, counter_name: counter.name,
          counter_warehouse_id: counterWh ? whKey(counterWh) : null,
          counter_pool_key: counterPool,
          inventory_code: inv.code, inventory_name: inv.name, bucket_key: k,
        });
      }
    }
    if (et === 'transfer_out') newAmountByOutId.set(r.id, outAmt);
    stOut(st, qOut, outAmt);
  }

  // On-hand correction per key: replayed state vs actual header/bucket.
  const keys = [];
  if (mode === 'mixed') {
    const buckets = loadBucketMap(db, pid);
    const sh = sharedPoolState(db, pid, pools);
    const shared = newState(sh.qty, sh.value_rial, sh.avg_rial);
    const sepKeys = new Set([...pools.separate].filter((k) => buckets.has(k) || states.has(k)));
    const list = [[0, shared], ...[...sepKeys].sort((a, b) => a - b).map((k) => [k, buckets.get(k) || newState()])];
    for (const [k, b] of list) {
      if (warehouseId && k !== poolKey(warehouseId)) continue;
      const st = states.get(k) || newState();
      const targetV = b.q > BUCKET_EPS ? Math.round(b.q * (st.q > BUCKET_EPS ? st.avg : b.avg)) : b.v;
      keys.push({
        warehouse_id: k, pool: k ? 'warehouse' : 'shared', qty_on_hand: b.q, replay_qty: st.q, replay_value_rial: st.v,
        old_unit_rial: b.avg, new_unit_rial: st.q > BUCKET_EPS ? st.avg : b.avg,
        actual_value_rial: b.v, target_value_rial: targetV, onhand_delta_rial: targetV - b.v,
      });
    }
  } else if (mode === 'product') {
    const st = states.get(0) || newState();
    const Q = Number(product.stock) || 0;
    const actualAvg = Math.round(Number(product.average_cost_rial) || 0);
    const actualV = Math.round(Q * actualAvg);
    const targetAvg = st.q > BUCKET_EPS ? st.avg : actualAvg;
    const targetV = Q > BUCKET_EPS ? Math.round(Q * targetAvg) : actualV;
    keys.push({
      warehouse_id: 0, qty_on_hand: Q, replay_qty: st.q, replay_value_rial: st.v,
      old_unit_rial: actualAvg, new_unit_rial: targetAvg,
      actual_value_rial: actualV, target_value_rial: targetV, onhand_delta_rial: targetV - actualV,
    });
  } else {
    const buckets = loadBucketMap(db, pid);
    const allKeys = new Set([...states.keys(), ...buckets.keys()]);
    for (const k of [...allKeys].sort((a, b) => a - b)) {
      if (warehouseId && k !== whKey(warehouseId)) continue;
      const st = states.get(k) || newState();
      const b = buckets.get(k) || newState();
      const targetV = b.q > BUCKET_EPS ? Math.round(b.q * (st.q > BUCKET_EPS ? st.avg : b.avg)) : b.v;
      keys.push({
        warehouse_id: k, qty_on_hand: b.q, replay_qty: st.q, replay_value_rial: st.v,
        old_unit_rial: b.avg, new_unit_rial: st.q > BUCKET_EPS ? st.avg : b.avg,
        actual_value_rial: b.v, target_value_rial: targetV, onhand_delta_rial: targetV - b.v,
      });
    }
  }
  if (warehouseId && mode !== 'product') {
    const wk = poolKey(warehouseId);
    base.lines = base.lines.filter((l) => l.bucket_key === wk || l.counter_pool_key === wk);
  }
  base.mode = mode;
  base.level = mode;
  base.keys = keys;
  base.adjust_total_rial = base.lines.reduce((s, l) => s + l.delta_rial, 0);
  base.onhand_delta_rial = keys.reduce((s, k) => s + k.onhand_delta_rial, 0);
  return base;
}

/* ───────────────────────────── explain ───────────────────────────── */

function explainEffective(db, { productId, warehouseId = null } = {}) {
  ready(db);
  const pid = Number(productId);
  const p = db.prepare('SELECT id, name, code, stock, average_cost_rial, costing_method, warehouse_id FROM products WHERE id=?').get(pid);
  if (!p) throw valErr('E_PRODUCT_NOT_FOUND', 404, 'کالا یافت نشد');
  const wid = warehouseId ? Number(warehouseId) : null;
  let wh = null;
  if (wid) {
    try { wh = db.prepare('SELECT id, name, costing_method FROM warehouses WHERE id=?').get(wid) || null; } catch (_) { wh = null; }
  }
  const policy = resolvePolicy(db, { productId: pid, warehouseId: wid });
  const buckets = listBuckets(db, { productId: pid });
  const bucket = wid ? (buckets.find((b) => Number(b.warehouse_id) === wid) || null) : null;
  const headerAvg = Math.round(Number(p.average_cost_rial) || 0);
  let outboundUnit = headerAvg;
  let outboundSource = 'header';
  const pools = productPools(db, pid);
  if (policy.method !== 'moving_average') {
    outboundSource = 'cost_layers';
  } else if (wid) {
    const pr = poolRate(db, pid, wid);
    if (pr.unit != null) { outboundUnit = pr.unit; outboundSource = pr.source; }
  }
  const levelChain = {
    product: (() => { try { return normLevel(db.prepare('SELECT valuation_level FROM products WHERE id=?').get(pid)?.valuation_level) || null; } catch (_) { return null; } })(),
    warehouse: wid ? ((() => { try { return normLevel(db.prepare('SELECT valuation_level FROM warehouses WHERE id=?').get(wid)?.valuation_level) || null; } catch (_) { return null; } })()) : null,
    global: getLevel(db),
  };
  const sharedState = pools.mode === 'mixed' ? sharedPoolState(db, pid, pools) : null;
  const pending = db.prepare(
    "SELECT COUNT(*) c FROM inventory_valuation_queue WHERE product_id=? AND status='pending'"
  ).get(pid).c;
  return {
    policy,
    product: {
      id: p.id, name: p.name, code: p.code, stock: Number(p.stock) || 0,
      average_cost_rial: headerAvg, costing_method: p.costing_method || null,
      header_value_rial: Math.round((Number(p.stock) || 0) * headerAvg),
    },
    warehouse: wh,
    bucket,
    buckets,
    bucket_totals: {
      qty: buckets.reduce((s, b) => s + (Number(b.qty) || 0), 0),
      value_rial: buckets.reduce((s, b) => s + (Number(b.value_rial) || 0), 0),
    },
    effective_outbound_unit_rial: outboundUnit,
    effective_outbound_source: outboundSource,
    pending_queue: Number(pending) || 0,
    pool_mode: pools.mode,
    shared_warehouse_ids: [...pools.shared].filter((k) => k),
    separate_warehouse_ids: [...pools.separate].filter((k) => k),
    shared_pool: sharedState,
    level_chain: levelChain,
  };
}

/* ─────────────────── v577: report valuation = Σ ledger (read-only) ─────────────────── */

const REPORT_QTY_EPS = 1e-6;

function reportNum(v) { return Number(v) || 0; }
function reportR6(v) { return Math.round(reportNum(v) * 1e6) / 1e6; }

/**
 * Weighted-average unit cost (rial) over a set of rows: Σvalue / Σqty on rows with qty>0.
 * NOT the simple mean of per-row unit costs.
 */
function weightedAvgRial(rows, qtyKey = 'ledger_qty', valueKey = 'ledger_value_rial') {
  let q = 0;
  let v = 0;
  for (const r of rows || []) {
    const rq = reportNum(r[qtyKey]);
    if (rq > REPORT_QTY_EPS) { q += rq; v += reportNum(r[valueKey]); }
  }
  return q > REPORT_QTY_EPS ? Math.round(v / q) : 0;
}

/** Row-level exception flags shared by every report built on Σledger. */
function ledgerValueFlags({ qty, value, wsQty, wsKnown, vwsDrift, bucketQty, bucketValue, bucketKnown }) {
  const v = Math.round(reportNum(value));
  const q = reportNum(qty);
  const zeroQty = Math.abs(q) < REPORT_QTY_EPS;
  const flags = {
    zero_qty_nonzero_value: zeroQty && v !== 0,
    negative_qty: q < -REPORT_QTY_EPS,
    negative_value: v < 0,
    drift_ws_ledger: !!wsKnown && Math.abs(reportNum(wsQty) - q) > REPORT_QTY_EPS,
    drift_ws_vws: !!vwsDrift,
    bucket_drift: !!bucketKnown && (Math.abs(reportNum(bucketQty) - q) > REPORT_QTY_EPS
      || Math.abs(Math.round(reportNum(bucketValue)) - v) > 1000),
  };
  flags.drift_any = flags.drift_ws_ledger || flags.drift_ws_vws;
  flags.exception_any = flags.zero_qty_nonzero_value || flags.negative_qty || flags.negative_value;
  return flags;
}

/**
 * Declared source for stock/valuation reports: kardex = Σ inventory_ledger (live rows) per
 * product × warehouse. value = Σ rial (in: +amount, out: −amount, value-only rows: signed amount).
 * warehouse_stock / vws / products header / valuation buckets are comparison layers only.
 * Strictly SELECT — never seeds, heals or rebuilds anything.
 *
 * @param {object} [opts] { productId, warehouseId } optional filters.
 * @returns {{rows:object[], by_product:Map<number,object>, drift_available:boolean}}
 */
function buildLedgerValuationRows(db, opts = {}) {
  const { LEDGER_LIVE_SQL } = require('./layer-reconcile');
  const pid = opts.productId ? Number(opts.productId) : null;
  const wid = opts.warehouseId != null && opts.warehouseId !== '' ? Number(opts.warehouseId) : null;
  const where = [LEDGER_LIVE_SQL];
  const params = [];
  if (pid) { where.push('product_id=?'); params.push(pid); }
  if (wid != null && Number.isFinite(wid)) { where.push('COALESCE(warehouse_id,0)=?'); params.push(wid); }

  const ledRows = tableExists(db, 'inventory_ledger') ? db.prepare(`
    SELECT product_id, COALESCE(warehouse_id,0) AS warehouse_id,
      SUM(COALESCE(qty_in,0) - COALESCE(qty_out,0)) AS qty,
      SUM(CASE WHEN COALESCE(qty_in,0)>0 THEN COALESCE(amount_rial,0)
               WHEN COALESCE(qty_out,0)>0 THEN -COALESCE(amount_rial,0)
               ELSE COALESCE(amount_rial,0) END) AS value_rial,
      COUNT(*) AS n
    FROM inventory_ledger
    WHERE ${where.join(' AND ')}
    GROUP BY product_id, COALESCE(warehouse_id,0)
  `).all(...params) : [];

  // comparison layers
  const ws = new Map();
  if (tableExists(db, 'warehouse_stock')) {
    const wsSql = 'SELECT product_id, warehouse_id, qty FROM warehouse_stock' + (pid ? ' WHERE product_id=?' : '');
    for (const r of db.prepare(wsSql).all(...(pid ? [pid] : []))) {
      if (wid != null && Number.isFinite(wid) && Number(r.warehouse_id) !== wid) continue;
      ws.set(`${r.product_id}:${r.warehouse_id}`, reportNum(r.qty));
    }
  }
  const buckets = new Map();
  const bucketsAvailable = tableExists(db, 'inventory_valuation_buckets');
  if (bucketsAvailable) {
    const bSql = 'SELECT product_id, warehouse_id, qty, value_rial FROM inventory_valuation_buckets' + (pid ? ' WHERE product_id=?' : '');
    for (const b of db.prepare(bSql).all(...(pid ? [pid] : []))) {
      buckets.set(`${b.product_id}:${Number(b.warehouse_id) || 0}`, { qty: reportNum(b.qty), value: reportNum(b.value_rial) });
    }
  }
  let driftAvailable = !opts.skipDrift;
  const recon = new Map();
  if (!opts.skipDrift) {
    try {
      const { computeLayerReconcile } = require('./layer-reconcile');
      const rec = computeLayerReconcile(db, {
        productId: pid || undefined,
        warehouseId: wid || undefined,
      });
      for (const r of rec.rows) recon.set(`${r.product_id}:${r.warehouse_id}`, r);
    } catch (_) { driftAvailable = false; }
  }

  const prodRows = db.prepare(
    'SELECT id, code, name, unit, price, cost, category, stock, average_cost_rial FROM products'
    + (pid ? ' WHERE id=?' : '')
  ).all(...(pid ? [pid] : []));
  const prods = new Map(prodRows.map((p) => [p.id, p]));
  const whNames = new Map();
  const whActive = new Map();
  if (tableExists(db, 'warehouses')) {
    for (const w of db.prepare('SELECT id, name, active FROM warehouses').all()) {
      whNames.set(Number(w.id), w.name);
      whActive.set(Number(w.id), w.active == null ? 1 : Number(w.active));
    }
  }

  // keys: ledger rows ∪ ws rows that carry qty (so a ws-only layer shows up as drift)
  const keys = new Map();
  for (const r of ledRows) keys.set(`${r.product_id}:${r.warehouse_id}`, r);
  for (const [k, q] of ws) {
    if (!keys.has(k) && Math.abs(q) > REPORT_QTY_EPS) {
      const [p, w] = k.split(':').map(Number);
      keys.set(k, { product_id: p, warehouse_id: w, qty: 0, value_rial: 0, n: 0 });
    }
  }

  const rows = [];
  for (const [k, r] of keys) {
    const p = prods.get(r.product_id);
    if (!p) continue;
    const qty = reportR6(r.qty);
    const value = Math.round(reportNum(r.value_rial));
    const wsKnown = ws.has(k);
    const wsQty = wsKnown ? ws.get(k) : null;
    const rc = recon.get(k) || null;
    const b = buckets.get(k) || null;
    const headerAvg = Math.round(reportNum(p.average_cost_rial));
    const headerValue = Math.round(reportNum(wsQty) * headerAvg);
    const flags = ledgerValueFlags({
      qty, value, wsQty, wsKnown,
      vwsDrift: !!(rc && rc.flags && rc.flags.ws_vs_vws),
      bucketQty: b && b.qty, bucketValue: b && b.value, bucketKnown: !!b,
    });
    // ws "unknown" and ledger has qty → treat ws as 0 so a missing projection is visible drift
    if (!wsKnown && Math.abs(qty) > REPORT_QTY_EPS) {
      flags.drift_ws_ledger = true;
      flags.drift_any = true;
    }
    rows.push({
      product_id: r.product_id,
      product_code: p.code || null,
      product_name: p.name || null,
      warehouse_id: Number(r.warehouse_id) || 0,
      warehouse_name: Number(r.warehouse_id) ? (whNames.get(Number(r.warehouse_id)) || null) : null,
      warehouse_active: Number(r.warehouse_id) ? (whActive.has(Number(r.warehouse_id)) ? whActive.get(Number(r.warehouse_id)) : 1) : 1,
      source: 'kardex',
      ledger_qty: qty,
      ledger_value_rial: value,
      ledger_rows: Number(r.n) || 0,
      // weighted (value/qty) — only meaningful when qty>0
      weighted_avg_unit_rial: qty > REPORT_QTY_EPS ? Math.round(value / qty) : 0,
      // comparison layers
      ws_qty: wsQty == null ? null : reportR6(wsQty),
      vws_sum: rc ? rc.vws_sum : null,
      drift_qty: wsKnown ? reportR6(wsQty - qty) : (Math.abs(qty) > REPORT_QTY_EPS ? reportR6(-qty) : 0),
      header_avg_rial: headerAvg,
      header_value_rial: headerValue,
      header_value_diff_rial: value - headerValue,
      bucket_qty: b ? reportR6(b.qty) : null,
      bucket_value_rial: b ? Math.round(b.value) : null,
      flags,
      flagged: flags.exception_any || flags.drift_any,
    });
  }
  rows.sort((a, b) => (a.product_id - b.product_id) || (a.warehouse_id - b.warehouse_id));

  const byProduct = new Map();
  for (const r of rows) {
    let a = byProduct.get(r.product_id);
    if (!a) {
      a = { product_id: r.product_id, ledger_qty: 0, ledger_value_rial: 0, rows: [], any_flagged: false };
      byProduct.set(r.product_id, a);
    }
    a.ledger_qty = reportR6(a.ledger_qty + r.ledger_qty);
    a.ledger_value_rial += r.ledger_value_rial;
    a.rows.push(r);
    if (r.flagged) a.any_flagged = true;
  }
  for (const a of byProduct.values()) {
    a.zero_qty_nonzero_value = Math.abs(a.ledger_qty) < REPORT_QTY_EPS && a.ledger_value_rial !== 0;
    a.negative_value = a.ledger_value_rial < 0;
    a.weighted_avg_unit_rial = weightedAvgRial(a.rows);
    if (a.zero_qty_nonzero_value || a.negative_value) a.any_flagged = true;
  }
  return { rows, by_product: byProduct, drift_available: driftAvailable, buckets_available: bucketsAvailable };
}

/**
 * Per-product valuation report (adv-reports/inventory-valuation).
 * qty/value = Σ ledger; header (products.stock × average_cost_rial) only for comparison.
 */
function buildProductValuationReport(db, opts = {}) {
  const { by_product: byProduct, drift_available: driftAvailable } = buildLedgerValuationRows(db, opts);
  const prods = db.prepare(`
    SELECT id, code, name, stock,
      COALESCE(NULLIF(average_cost_rial,0), ROUND(cost), 0) AS cost,
      COALESCE(NULLIF(price_rial,0), ROUND(price), 0) AS price,
      COALESCE(average_cost_rial,0) AS header_avg
    FROM products ORDER BY name
  `).all();
  const only = opts.productId ? Number(opts.productId) : null;
  const rows = [];
  for (const p of prods) {
    if (only && p.id !== only) continue;
    const a = byProduct.get(p.id) || null;
    const qty = a ? a.ledger_qty : 0;
    const value = a ? a.ledger_value_rial : 0;
    const headerStock = reportNum(p.stock);
    const headerValue = Math.round(headerStock * reportNum(p.header_avg));
    const unit = a && a.weighted_avg_unit_rial > 0 ? a.weighted_avg_unit_rial : Math.round(reportNum(p.cost));
    const ghost = !!(a && a.zero_qty_nonzero_value);
    rows.push({
      id: p.id, code: p.code, name: p.name,
      source: 'kardex',
      stock: qty,
      kardex_qty: qty,
      ledger_value_rial: value,
      avg_rate_rial: a ? a.weighted_avg_unit_rial : 0,
      cost: unit,
      price: Math.round(reportNum(p.price)),
      cost_value: value,
      retail_value: Math.round(qty * reportNum(p.price)),
      weighted_avg_unit_rial: a ? a.weighted_avg_unit_rial : 0,
      header_stock: reportR6(headerStock),
      header_value_rial: headerValue,
      header_diff_rial: value - headerValue,
      stock_drift_qty: reportR6(headerStock - qty),
      ledger_rows: a ? a.rows.reduce((s, r) => s + r.ledger_rows, 0) : 0,
      flags: {
        zero_qty_nonzero_value: ghost,
        negative_value: !!(a && a.negative_value),
        negative_qty: qty < -REPORT_QTY_EPS,
        header_drift: Math.abs(headerStock - qty) > REPORT_QTY_EPS,
        warehouse_drift: !!(a && a.rows.some((r) => r.flags.drift_any)),
      },
      flagged: !!(a && a.any_flagged) || Math.abs(headerStock - qty) > REPORT_QTY_EPS,
    });
  }
  const totals = rows.reduce((t, r) => ({
    stock: reportR6(t.stock + r.stock),
    kardex_qty: reportR6(t.kardex_qty + r.stock),
    ledger_value_rial: t.ledger_value_rial + r.cost_value,
    cost_value: t.cost_value + r.cost_value,
    retail_value: t.retail_value + r.retail_value,
    header_value_rial: t.header_value_rial + r.header_value_rial,
    ghost_value_rial: t.ghost_value_rial + (r.flags.zero_qty_nonzero_value ? r.cost_value : 0),
    flagged_count: t.flagged_count + (r.flagged ? 1 : 0),
  }), { stock: 0, kardex_qty: 0, ledger_value_rial: 0, cost_value: 0, retail_value: 0, header_value_rial: 0, ghost_value_rial: 0, flagged_count: 0 });
  return {
    rows, totals,
    source: 'kardex', value_basis: 'sum_ledger_rial', drift_available: driftAvailable,
  };
}

module.exports = {
  buildLedgerValuationRows,
  buildProductValuationReport,
  weightedAvgRial,
  ledgerValueFlags,
  ensureValuationSchema,
  ready,
  migratePolicyV521,
  resolvePolicy,
  getPolicy,
  setPolicy,
  explainEffective,
  headerState,
  newState,
  stIn,
  stOut,
  stValue,
  applyLedgerRowToBuckets,
  getBucket,
  listBuckets,
  rebuildBuckets,
  enqueue,
  listQueue,
  ignoreQueueItem,
  afterMovementPosted,
  recordValueApplied,
  valueAppliedFor,
  postValueAdjustment,
  previewReplay,
  counterKeyForEvent,
  isAlignRow,
  whKey,
  getLevel,
  normLevel,
  levelFor,
  productPools,
  sharedPoolState,
  poolRate,
  syncHeaderAvgFromBuckets,
  lastPurchaseUnitForPool,
  setLayerLevel,
  QUEUE_REASONS,
  REPLAY_SELF_SOURCE,
  ADJUSTABLE_OUT_EVENTS,
  valErr,
};
