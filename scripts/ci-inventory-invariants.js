#!/usr/bin/env node
'use strict';
/**
 * Read-only inventory invariant checker (warn-only by default).
 *
 *   INV-1  Σ variant_warehouse_stock.qty (product's variants) == Σ live inventory_ledger
 *          (qty_in − qty_out) per product × warehouse, for products with a colour×size layer.
 *   INV-2  A matrix product (active non-default product_variants — hasActiveMatrixVariants)
 *          has no live opening ledger row without variant_id.
 *
 * Live ledger = LEDGER_LIVE_SQL (server/lib/inventory/layer-reconcile.js), the same filter
 * stock-cache.js uses to derive variant_warehouse_stock. Warehouse-only rows (cutting_pack)
 * are NOT excluded: stock-cache counts them in variant_warehouse_stock ("all events"); they are
 * only dropped from products.stock / product_variants.stock.
 *
 * Usage:
 *   node scripts/ci-inventory-invariants.js [--db <path>] [--json] [--strict]
 *   DB_PATH=... node scripts/ci-inventory-invariants.js
 * Without a DB path a fresh temp DB is built with server/db.js initDB() (CI smoke run).
 *
 * Exit: 0 always (violations are warnings) unless --strict and violations exist → 1.
 *       2 on crash. Missing tables/columns are reported as "skipped", not a crash.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const TOL = 0.001;
const TOP = 20;

const LIVE_SQL = (a) => `(${a}.status='posted' AND ${a}.reversed_of IS NULL
    AND COALESCE(${a}.event_type,'') <> 'reversal' AND COALESCE(${a}.event_type,'') NOT GLOB '*_reversal')`;

const OPENING_SQL = (a) => `(${a}.event_type='opening' OR COALESCE(${a}.source_type,'')='opening_inventory')`;

const MATRIX_PRODUCTS_SQL = `
  SELECT DISTINCT product_id FROM product_variants
  WHERE active=1 AND COALESCE(is_default,0)=0`;

const INV1_SQL = `
WITH scope AS (
  SELECT DISTINCT pv.product_id
    FROM variant_warehouse_stock vws JOIN product_variants pv ON pv.id = vws.variant_id
  UNION
  ${MATRIX_PRODUCTS_SQL}
),
v AS (
  SELECT pv.product_id, vws.warehouse_id, SUM(COALESCE(vws.qty,0)) AS vws_sum
    FROM variant_warehouse_stock vws JOIN product_variants pv ON pv.id = vws.variant_id
   WHERE pv.product_id IN (SELECT product_id FROM scope)
   GROUP BY pv.product_id, vws.warehouse_id
),
l AS (
  SELECT il.product_id, il.warehouse_id,
         SUM(COALESCE(il.qty_in,0) - COALESCE(il.qty_out,0)) AS ledger_sum,
         SUM(CASE WHEN COALESCE(il.variant_id,0) > 0 THEN 0
                  ELSE COALESCE(il.qty_in,0) - COALESCE(il.qty_out,0) END) AS unattributed_sum
    FROM inventory_ledger il
   WHERE ${LIVE_SQL('il')}
     AND il.warehouse_id IS NOT NULL
     AND il.product_id IN (SELECT product_id FROM scope)
   GROUP BY il.product_id, il.warehouse_id
),
pairs AS (
  SELECT product_id, warehouse_id FROM v
  UNION
  SELECT product_id, warehouse_id FROM l
)
SELECT p.product_id, p.warehouse_id,
       ROUND(COALESCE(v.vws_sum,0), 3)                          AS vws_sum,
       ROUND(COALESCE(l.ledger_sum,0), 3)                       AS ledger_sum,
       ROUND(COALESCE(v.vws_sum,0) - COALESCE(l.ledger_sum,0), 3) AS diff,
       ROUND(COALESCE(l.unattributed_sum,0), 3)                 AS unattributed_sum
  FROM pairs p
  LEFT JOIN v ON v.product_id = p.product_id AND v.warehouse_id = p.warehouse_id
  LEFT JOIN l ON l.product_id = p.product_id AND l.warehouse_id = p.warehouse_id
 WHERE ABS(COALESCE(v.vws_sum,0) - COALESCE(l.ledger_sum,0)) > ${TOL}
 ORDER BY ABS(COALESCE(v.vws_sum,0) - COALESCE(l.ledger_sum,0)) DESC, p.product_id, p.warehouse_id`;

const INV2_SQL = `
SELECT il.id AS ledger_id, il.product_id, il.warehouse_id, il.event_type, il.source_type,
       il.qty_in, il.qty_out, il.date
  FROM inventory_ledger il
 WHERE ${LIVE_SQL('il')}
   AND ${OPENING_SQL('il')}
   AND il.variant_id IS NULL
   AND il.product_id IN (${MATRIX_PRODUCTS_SQL})
 ORDER BY il.product_id, il.id`;

function parseArgs(argv) {
  const out = { db: null, json: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--strict') out.strict = true;
    else if (a === '--db') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error('--db requires a path');
      out.db = v; i++;
    }
    else if (a.startsWith('--db=')) out.db = a.slice(5) || null;
    else if (a === '-h' || a === '--help') out.help = true;
  }
  if (!out.db && process.env.DB_PATH) out.db = process.env.DB_PATH;
  return out;
}

function loadSqlite() {
  try {
    return require(path.join(SERVER_DIR, 'node_modules', 'better-sqlite3'));
  } catch (_) {
    return require('module').createRequire(path.join(SERVER_DIR, 'package.json'))('better-sqlite3');
  }
}

/** Builds a throwaway DB with the real schema (server/db.js initDB) and returns its path. */
function buildTempDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-inv-invariants-'));
  const dbPath = path.join(tmp, 'invariants.db');
  Object.assign(process.env, {
    DB_PATH: dbPath,
    SYNC_ROLE: 'central',
    ERP_TEST_ISOLATION: '1',
    SMS_DISABLED: '1',
    NODE_ENV: 'test',
    AUTH_SESSION_DB_PATH: path.join(tmp, 'sessions.db'),
  });
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'ci-inventory-invariants-secret-32chars!!';
  // initDB logs migrations on stdout; keep stdout clean for --json.
  const log = console.log;
  console.log = console.error;
  try {
  const log = console.log;
  console.log = (...a) => console.error(...a); // keep stdout clean for --json
  try {
    const dbMod = require(path.join(SERVER_DIR, 'db'));
    dbMod.initDB();
    try { const d = dbMod.getDB(); if (d && d.open) d.close(); } catch (_) { /* best effort */ }
  } finally {
    console.log = log;
  }
  } finally {
    console.log = log;
  }
  return { dbPath, tmp };
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

function missingSchema(db, needs) {
  const missing = [];
  for (const [table, cols] of Object.entries(needs)) {
    if (!tableExists(db, table)) { missing.push(`table ${table}`); continue; }
    const have = columns(db, table);
    for (const c of cols) if (!have.has(c)) missing.push(`${table}.${c}`);
  }
  return missing;
}

function checkInv1(db) {
  const missing = missingSchema(db, {
    variant_warehouse_stock: ['variant_id', 'warehouse_id', 'qty'],
    product_variants: ['id', 'product_id', 'active', 'is_default'],
    inventory_ledger: ['product_id', 'warehouse_id', 'variant_id', 'qty_in', 'qty_out', 'status', 'reversed_of', 'event_type'],
  });
  if (missing.length) return { skipped: `missing: ${missing.join(', ')}`, count: 0, rows: [] };
  const rows = db.prepare(INV1_SQL).all();
  return { count: rows.length, rows: rows.slice(0, TOP) };
}

function checkInv2(db) {
  const missing = missingSchema(db, {
    product_variants: ['product_id', 'active', 'is_default'],
    inventory_ledger: ['product_id', 'variant_id', 'event_type', 'source_type', 'status', 'reversed_of'],
  });
  if (missing.length) return { skipped: `missing: ${missing.join(', ')}`, count: 0, products: 0, rows: [] };
  const rows = db.prepare(INV2_SQL).all();
  const products = new Set(rows.map((r) => r.product_id)).size;
  return { count: rows.length, products, rows: rows.slice(0, TOP) };
}

function printHuman(res) {
  const { inv1, inv2 } = res;
  console.log(`Inventory invariants — db: ${res.db}${res.temp ? ' (fresh temp schema)' : ''}`);
  console.log('');
  console.log('INV-1  Σ variant_warehouse_stock == Σ live ledger per product × warehouse');
  if (inv1.skipped) console.log(`  skipped: ${inv1.skipped}`);
  else {
    console.log(`  mismatching product×warehouse pairs: ${inv1.count}`);
    if (inv1.rows.length) console.table(inv1.rows);
  }
  console.log('');
  console.log('INV-2  matrix product without live opening row lacking variant_id');
  if (inv2.skipped) console.log(`  skipped: ${inv2.skipped}`);
  else {
    console.log(`  violating opening rows: ${inv2.count}  (distinct products: ${inv2.products})`);
    if (inv2.rows.length) console.table(inv2.rows);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/ci-inventory-invariants.js [--db <path>] [--json] [--strict]');
    return 0;
  }
  let dbPath = args.db;
  let temp = null;
  if (!dbPath) {
    temp = buildTempDb();
    dbPath = temp.dbPath;
  }
  const Database = loadSqlite();
  const db = new Database(path.resolve(dbPath), { readonly: true, fileMustExist: true });
  let res;
  try {
    res = { db: dbPath, temp: !!temp, tolerance: TOL, inv1: checkInv1(db), inv2: checkInv2(db) };
  } finally {
    db.close();
    if (temp) { try { fs.rmSync(temp.tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
  }

  if (args.json) {
    console.log(JSON.stringify({ inv1: res.inv1, inv2: res.inv2 }, null, 2));
  } else {
    printHuman(res);
  }

  const violations = res.inv1.count + res.inv2.count;
  if (process.env.GITHUB_ACTIONS) {
    // Keep stdout pure JSON under --json; annotations go to stderr then.
    const log = args.json ? console.error : console.log;
    if (res.inv1.count) log(`::warning title=INV-1 vws vs ledger::${res.inv1.count} product×warehouse pairs where Σ variant_warehouse_stock ≠ Σ live inventory_ledger`);
    if (res.inv2.count) log(`::warning title=INV-2 opening without variant::${res.inv2.count} live opening rows without variant_id on ${res.inv2.products} matrix products`);
    for (const k of ['inv1', 'inv2']) if (res[k].skipped) log(`::warning title=${k.toUpperCase()} skipped::${res[k].skipped}`);
  }
  if (!args.json) console.log(`\n${violations ? `${violations} violation(s)` : 'OK — no violations'}${args.strict ? ' [strict]' : ' [warn-only]'}`);
  return args.strict && violations ? 1 : 0;
}

let code;
try {
  code = main();
} catch (e) {
  console.error(`ci-inventory-invariants crashed: ${e && e.stack ? e.stack : e}`);
  code = 2;
}
process.exit(code);
