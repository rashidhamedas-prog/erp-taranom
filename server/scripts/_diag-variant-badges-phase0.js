'use strict';
/**
 * Phase 0 (variant badges) — READ-ONLY diagnostic. Never commit.
 *
 *   node _diag-variant-badges-phase0.js --db <path> [--lib <dir>] [--limit 14] [--out <file>]
 *
 * --lib: directory containing line-availability.js (default ../lib/inventory relative to this file).
 * Opens the DB with { readonly:true, fileMustExist:true }. Any non-reader statement prepared during
 * the availability call is recorded in `write_attempts` (a readonly DB would throw if it ran;
 * some lib paths swallow errors, so this makes such attempts visible instead of silent).
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const dbPath = arg('db');
if (!dbPath) { console.error('--db <path> required'); process.exit(2); }
const libDir = path.resolve(arg('lib', path.join(__dirname, '..', 'lib', 'inventory')));
const limit = parseInt(arg('limit', '14'), 10) || 14;
const outFile = arg('out', null);
const DRIFT_PRODUCTS = [105, 107, 114, 119, 128, 140, 173, 180, 341];
const EPS = 1e-6;
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

const rawDb = new Database(dbPath, { readonly: true, fileMustExist: true });

const writeAttempts = [];
const db = new Proxy(rawDb, {
  get(target, prop) {
    if (prop === 'prepare') {
      return (sql) => {
        const stmt = target.prepare(sql);
        if (!stmt.reader && !/^\s*(PRAGMA|SELECT|WITH)/i.test(sql)) {
          writeAttempts.push(String(sql).replace(/\s+/g, ' ').slice(0, 160));
        }
        return stmt;
      };
    }
    if (prop === 'exec' || prop === 'transaction') {
      return (...a) => { writeAttempts.push(`${String(prop)}: ${String(a[0]).slice(0, 120)}`); return target[prop](...a); };
    }
    const v = target[prop];
    return typeof v === 'function' ? v.bind(target) : v;
  },
});

const cols = (t) => new Set(rawDb.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
const invCols = cols('invoices');
const numCol = invCols.has('num') ? 'num' : (invCols.has('invoice_number') ? 'invoice_number' : null);
const whereDel = invCols.has('deleted_at') ? 'WHERE (deleted_at IS NULL OR deleted_at = 0)' : '';
const selCols = ['id', numCol, 'type', 'status', 'warehouse_id', 'stock_deducted', 'date', 'rows']
  .filter((c) => c && invCols.has(c));

const libFile = path.join(libDir, 'line-availability.js');
const { lineAvailabilityBatch } = require(libFile);

const invoices = rawDb.prepare(`SELECT ${selCols.join(', ')} FROM invoices ${whereDel} ORDER BY id DESC LIMIT ?`).all(limit);
const prodWh = rawDb.prepare('SELECT warehouse_id FROM products WHERE id=?');

function parseRows(raw) {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw || '[]'); } catch (_) { return []; }
}

const perInvoice = [];
const totals = { invoices: 0, lines: 0, lines_skipped: 0, lines_no_wh: 0, drift: 0, drift_product: 0, drift_variant: 0, variant_layer_mismatch: 0, low: 0, variant_lines: 0, product_lines: 0 };
const errors = [];
const badgedLines = [];

for (const inv of invoices) {
  const rows = parseRows(inv.rows);
  const headerWh = Number(inv.warehouse_id) || 0;
  const items = [];
  let skipped = 0;
  let noWh = 0;
  for (const r of rows) {
    if (!r || r.row_type === 'income' || r.item_kind === 'service' || r.batch_id || r.is_fabric_roll) { skipped++; continue; }
    const pid = Number(r.product_id) || 0;
    if (!pid) { skipped++; continue; }
    let wh = Number(r.warehouse_id) || headerWh;
    if (!wh) { const p = prodWh.get(pid); wh = p && p.warehouse_id ? Number(p.warehouse_id) : 0; }
    if (!wh) { noWh++; continue; }
    items.push({ product_id: pid, variant_id: Number(r.variant_id) || null, wh, qty: Number(r.qty) || 0 });
  }

  const c = { id: inv.id, num: numCol ? inv[numCol] : null, type: inv.type || null, status: inv.status || null,
    stock_deducted: inv.stock_deducted, lines: items.length, skipped, no_wh: noWh,
    drift: 0, drift_product: 0, drift_variant: 0, variant_layer_mismatch: 0, low: 0, variant_lines: 0, error: null };
  let res = [];
  try {
    res = lineAvailabilityBatch(db, items.map((it) => ({ product_id: it.product_id, variant_id: it.variant_id })), { excludeInvoiceId: inv.id });
  } catch (e) {
    c.error = `${e.code || ''} ${e.message}`.trim();
    errors.push({ invoice_id: inv.id, error: c.error });
  }
  res.forEach((out, i) => {
    const it = items[i];
    if (it.variant_id) c.variant_lines++;
    const w = (out.warehouses || []).find((x) => Number(x.warehouse_id) === it.wh);
    if (!w) { c.missing_wh = (c.missing_wh || 0) + 1; return; }
    const dp = !!w.drift_product, dv = !!w.drift_variant, d = !!w.drift, vm = !!w.variant_layer_mismatch;
    const low = Number(w.available) < it.qty - EPS;
    if (d) c.drift++;
    if (dp) c.drift_product++;
    if (dv) c.drift_variant++;
    if (vm) c.variant_layer_mismatch++;
    if (low) c.low++;
    if (d || vm || low) {
      badgedLines.push({ invoice_id: inv.id, product_id: it.product_id, variant_id: it.variant_id, warehouse_id: it.wh,
        qty: it.qty, available: w.available, on_hand: w.on_hand, own_doc_qty: w.own_doc_qty,
        kardex_qty: w.kardex_qty, product_wh_qty: w.product_wh_qty, movements_qty: w.movements_qty,
        drift_product: dp, drift_variant: dv, variant_layer_mismatch: vm, low });
    }
  });
  perInvoice.push(c);
  totals.invoices++;
  totals.lines += c.lines; totals.lines_skipped += skipped; totals.lines_no_wh += noWh;
  totals.drift += c.drift; totals.drift_product += c.drift_product; totals.drift_variant += c.drift_variant;
  totals.variant_layer_mismatch += c.variant_layer_mismatch; totals.low += c.low;
  totals.variant_lines += c.variant_lines; totals.product_lines += c.lines - c.variant_lines;
}

// INV-2: live opening ledger rows with variant_id NULL on matrix products.
let inv2 = null;
try {
  const lc = cols('inventory_ledger');
  const pvc = cols('product_variants');
  const matrixSql = `${pvc.has('active') ? 'pv.active=1' : '1=1'} AND ${pvc.has('is_default') ? 'COALESCE(pv.is_default,0)=0' : '1=1'}`;
  if (lc.has('variant_id')) {
    const live = "l.status='posted' AND l.reversed_of IS NULL AND COALESCE(l.event_type,'') <> 'reversal'";
    const base = `FROM inventory_ledger l WHERE l.event_type='opening' AND ${live} AND l.variant_id IS NULL
      AND EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id=l.product_id AND ${matrixSql})`;
    const row = rawDb.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT l.product_id) AS products, COALESCE(SUM(l.qty_in),0) AS qty_in ${base}`).get();
    const eventTypes = rawDb.prepare("SELECT event_type, COUNT(*) AS n FROM inventory_ledger l WHERE l.status='posted' AND l.reversed_of IS NULL GROUP BY event_type ORDER BY n DESC").all();
    const strictRow = rawDb.prepare(`SELECT COUNT(*) AS n FROM inventory_ledger l WHERE l.event_type='opening'
      AND l.status='posted' AND l.reversed_of IS NULL AND l.variant_id IS NULL
      AND EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id=l.product_id AND ${matrixSql})`).get();
    inv2 = { count: row.n, products: row.products, qty_in_sum: r3(row.qty_in),
      count_strict_live_def: strictRow.n, matrix_def: matrixSql, live_event_types: eventTypes };
  } else inv2 = { error: 'inventory_ledger has no variant_id column' };
} catch (e) { inv2 = { error: e.message }; }

// Drift table for named products: vws qty vs Σ inventory_movements.qty_delta per variant×warehouse.
const driftTable = [];
try {
  const pairs = rawDb.prepare(`
    SELECT pv.product_id, pv.id AS variant_id, w.warehouse_id,
      COALESCE((SELECT qty FROM variant_warehouse_stock x WHERE x.variant_id=pv.id AND x.warehouse_id=w.warehouse_id),0) AS vws_qty,
      COALESCE((SELECT SUM(qty_delta) FROM inventory_movements m WHERE m.variant_id=pv.id AND m.warehouse_id=w.warehouse_id),0) AS mv_qty
    FROM product_variants pv
    JOIN (SELECT variant_id, warehouse_id FROM variant_warehouse_stock
          UNION SELECT variant_id, warehouse_id FROM inventory_movements WHERE variant_id IS NOT NULL) w
      ON w.variant_id = pv.id
    WHERE pv.product_id = ?`);
  for (const pid of DRIFT_PRODUCTS) {
    const rows = pairs.all(pid);
    const drifting = rows.filter((r) => Math.abs(Number(r.vws_qty) - Number(r.mv_qty)) > EPS);
    driftTable.push({ product_id: pid, pairs: rows.length, drifting_pairs: drifting.length,
      vws_total: r3(rows.reduce((s, r) => s + Number(r.vws_qty), 0)),
      mv_total: r3(rows.reduce((s, r) => s + Number(r.mv_qty), 0)),
      drifting: drifting.map((r) => ({ variant_id: r.variant_id, warehouse_id: r.warehouse_id, vws: r3(r.vws_qty), mv: r3(r.mv_qty), diff: r3(r.vws_qty - r.mv_qty) })) });
  }
} catch (e) { driftTable.push({ error: e.message }); }

const report = {
  generated_at: new Date().toISOString(),
  db: dbPath,
  lib: libDir,
  lib_has_variant_layer_mismatch: /variant_layer_mismatch/.test(fs.readFileSync(libFile, 'utf8')),
  invoice_number_col: numCol,
  totals,
  per_invoice: perInvoice,
  badged_lines: badgedLines,
  errors,
  write_attempts: [...new Set(writeAttempts)],
  inv2_opening_variant_null_on_matrix: inv2,
  drift_products: driftTable,
};

const json = JSON.stringify(report, null, 2);
if (outFile) fs.writeFileSync(outFile, json);

console.log('inv_id  num        type      lines  drift  d_prod  d_var  vlm  low  err');
for (const c of perInvoice) {
  console.log([String(c.id).padEnd(7), String(c.num || '').padEnd(10), String(c.type || '').padEnd(9),
    String(c.lines).padStart(5), String(c.drift).padStart(6), String(c.drift_product).padStart(7),
    String(c.drift_variant).padStart(6), String(c.variant_layer_mismatch).padStart(4), String(c.low).padStart(4),
    c.error ? ` ${c.error}` : ''].join(' '));
}
console.log(`TOTAL   lines=${totals.lines} drift=${totals.drift} d_prod=${totals.drift_product} d_var=${totals.drift_variant} vlm=${totals.variant_layer_mismatch} low=${totals.low}`);
console.log('INV-2:', JSON.stringify(inv2 && { count: inv2.count, products: inv2.products, error: inv2.error }));
console.log('drift products:', driftTable.map((d) => `${d.product_id}:${d.drifting_pairs}/${d.pairs}`).join(' '));
console.log('write_attempts:', report.write_attempts.length, 'errors:', errors.length);
if (!outFile) console.log(json);
rawDb.close();
