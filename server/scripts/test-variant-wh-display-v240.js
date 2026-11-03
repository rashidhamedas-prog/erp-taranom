'use strict';
const { swAtLeast } = require('./lib/sw-at-least');
/**
 * v240: invoice/catalog variant chips + summaries scoped to warehouse.
 * Backend: variantLineSummary(db, productId, warehouseId) + GET /summaries?warehouse_id=
 * Frontend: hydrateInvVarSum / genCartAdd / reloadInvProductsForWarehouse / SW v240
 *
 * Run: node server/scripts/test-variant-wh-display-v240.js
 *   or: .tools/node20/node-v20.18.1-win-x64/node.exe server/scripts/test-variant-wh-display-v240.js
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const testDb = path.join(__dirname, '_variant-wh-display-v240-test.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch (_) {}
}

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : String(extra)); }
}

console.log('\n══ Variant warehouse display v240 ══\n');

// ── 1) Backend static ────────────────────────────────────────────────────
const svcPath = path.join(__dirname, '../lib/product-variants/service.js');
const routePath = path.join(__dirname, '../routes/product-variants.js');
const svc = fs.readFileSync(svcPath, 'utf8');
const pvRoute = fs.readFileSync(routePath, 'utf8');

ok(
  /function variantLineSummary\s*\(\s*db\s*,\s*productId\s*,\s*warehouseId\s*\)/.test(svc),
  'variantLineSummary(db, productId, warehouseId) signature'
);
ok(
  /function variantLineSummary[\s\S]{0,900}variant_warehouse_stock/.test(svc),
  'variantLineSummary reads variant_warehouse_stock when WH given'
);
ok(
  /function variantLineSummary[\s\S]{0,1200}stock_scope:\s*scoped\s*\?\s*'warehouse'\s*:\s*'global'/.test(svc)
    || /stock_scope:\s*scoped\s*\?\s*'warehouse'\s*:\s*'global'/.test(svc),
  'variantLineSummary sets stock_scope warehouse|global'
);
ok(
  /router\.get\('\/summaries'[\s\S]{0,600}req\.query\.warehouse_id/.test(pvRoute),
  'GET /summaries reads warehouse_id query'
);
ok(
  /router\.get\('\/summaries'[\s\S]{0,800}variantLineSummary\s*\(\s*db\s*,\s*id\s*,\s*scopedWh\s*\)/.test(pvRoute)
    || /for\s*\(\s*const\s+id\s+of\s+ids\s*\)\s*out\[id\]\s*=\s*variantLineSummary\s*\(\s*db\s*,\s*id\s*,\s*scopedWh\s*\)/.test(pvRoute),
  'GET /summaries passes scopedWh into variantLineSummary'
);

// ── 2) Frontend MUST (red until other agent lands) ───────────────────────
const appJsPath = path.join(__dirname, '../public/app.js');
const swPath = path.join(__dirname, '../public/sw.js');
const appJs = fs.readFileSync(appJsPath, 'utf8');
const sw = fs.readFileSync(swPath, 'utf8');

const hydrateFn = (appJs.match(/async function hydrateInvVarSum[\s\S]{0,900}/) || [''])[0];
ok(
  /warehouse_id/.test(hydrateFn)
    && /summaries\?/.test(hydrateFn)
    && /warehouse_id/.test(hydrateFn.split('summaries')[1] || hydrateFn),
  'hydrateInvVarSum passes warehouse_id to /summaries'
);

// Current code (post pack refactor): genCartAdd resolves the live pack for the header warehouse via
// resolveServerAutoPack(pid, whId) → fetchProductLivePack(pid, warehouseId) (warehouse-scoped).
const genCartFn = (appJs.match(/async function genCartAdd[\s\S]{0,1200}/) || [''])[0];
const fetchPackFn = (appJs.match(/async function fetchProductLivePack[\s\S]{0,700}/) || [''])[0];
ok(
  /headerPurchaseWarehouseId\s*\(/.test(genCartFn)
    && /resolveServerAutoPack\(\s*pidN\s*,\s*whId/.test(genCartFn)
    && /warehouse_id/.test(fetchPackFn),
  'genCartAdd resolves the pack for the header warehouse (warehouse_id passed to live-pack fetch)'
);

const reloadFn = (appJs.match(/async function reloadInvProductsForWarehouse[\s\S]{0,800}/) || [''])[0];
ok(
  /clearInvVarSumCache\s*\(/.test(reloadFn)
    || /CACHE\._invVarSum\s*=\s*(?:\{\}|null)/.test(reloadFn)
    || /delete\s+CACHE\._invVarSum/.test(reloadFn),
  'reloadInvProductsForWarehouse clears _invVarSum'
);
ok(
  /function clearInvVarSumCache[\s\S]{0,120}CACHE\._invVarSum\s*=\s*\{\}/.test(appJs),
  'clearInvVarSumCache resets _invVarSum'
);

ok(swAtLeast(sw, 240), 'SW erp-taranom-v240');

// ── 3) Optional sqlite: variantLineSummary WH scoping ────────────────────
console.log('\n── sqlite variantLineSummary ──');
const db = new Database(testDb);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, code TEXT, stock REAL DEFAULT 0, pack_size INTEGER DEFAULT 1,
    has_variants INTEGER DEFAULT 0, is_style INTEGER DEFAULT 0, colors INTEGER DEFAULT 1
  );
  CREATE TABLE product_colors (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, code TEXT,
    hex TEXT DEFAULT '', sort_order INTEGER DEFAULT 0, active INTEGER DEFAULT 1
  );
  CREATE TABLE product_sizes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, code TEXT,
    sort_order INTEGER DEFAULT 0, active INTEGER DEFAULT 1
  );
  CREATE TABLE product_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    color_id INTEGER, size_id INTEGER,
    sku TEXT, barcode TEXT, price REAL DEFAULT 0, price_rial INTEGER DEFAULT 0,
    cost REAL DEFAULT 0, stock REAL DEFAULT 0, weight REAL DEFAULT 0,
    status TEXT DEFAULT 'active', is_default INTEGER DEFAULT 0, active INTEGER DEFAULT 1,
    note TEXT DEFAULT ''
  );
  CREATE TABLE variant_warehouse_stock (
    variant_id INTEGER NOT NULL,
    warehouse_id INTEGER NOT NULL,
    qty REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (variant_id, warehouse_id)
  );
`);

const { variantLineSummary } = require('../lib/product-variants/service');

const pid = db.prepare(
  'INSERT INTO products (name, code, pack_size, has_variants, is_style) VALUES (?,?,?,?,?)'
).run('تیارا تست', 'TIARA', 1, 1, 1).lastInsertRowid;
const c1 = db.prepare('INSERT INTO product_colors (name, code) VALUES (?,?)').run('مشکی', 'BLK').lastInsertRowid;
const s1 = db.prepare('INSERT INTO product_sizes (name, code) VALUES (?,?)').run('فری', 'FREE').lastInsertRowid;
const vid = db.prepare(`
  INSERT INTO product_variants (product_id, color_id, size_id, sku, stock, active, is_default)
  VALUES (?,?,?,?,?,1,0)
`).run(pid, c1, s1, 'TIARA-BLK-FREE', 8).lastInsertRowid;

const whA = 10;
const whB = 20;
db.prepare(
  'INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,?)'
).run(vid, whA, 5);
db.prepare(
  'INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,?)'
).run(vid, whB, 0);

const sumA = variantLineSummary(db, pid, whA);
ok(
  sumA
    && sumA.stock_scope === 'warehouse'
    && Number(sumA.warehouse_id) === whA
    && Number(sumA.live_colors) === 1
    && /مشکی/.test(String(sumA.line || '')),
  'summary@A = warehouse scope with مشکی',
  JSON.stringify(sumA)
);

const sumB = variantLineSummary(db, pid, whB);
ok(
  sumB
    && sumB.stock_scope === 'warehouse'
    && Number(sumB.live_colors) === 0
    && !String(sumB.line || '').trim(),
  'summary@B empty (VWS=0, no global fallback)',
  JSON.stringify(sumB)
);

const sumG = variantLineSummary(db, pid, null);
ok(
  sumG
    && sumG.stock_scope === 'global'
    && sumG.warehouse_id == null
    && Number(sumG.live_colors) === 1,
  'summary without WH = global stock',
  JSON.stringify(sumG)
);

db.close();
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch (_) {}
}

console.log(`\n══ ${pass} passed, ${fail} failed ══\n`);
process.exit(fail ? 1 : 0);
