#!/usr/bin/env node
/**
 * v528 — Complete-color live pack + product modal UI contracts.
 * Pack unit = complete_colors × sizes; incomplete color drops entirely;
 * full_packs_count = min floor(qty) across pack cells.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0;
let fail = 0;
function ok(cond, msg, detail) {
  if (cond) {
    pass += 1;
    console.log('  ✓', msg);
  } else {
    fail += 1;
    console.log('  ✗', msg, detail != null ? detail : '');
  }
}

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const appCss = fs.readFileSync(path.join(root, 'public/app.css'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

const swVer = (sw.match(/erp-taranom-v(\d+)/) || [])[1];
const jsVer = (indexHtml.match(/app\.js\?v=(\d+)/) || [])[1];
const cssVer = (indexHtml.match(/app\.css\?v=(\d+)/) || [])[1];
ok(Number(swVer) >= 528, 'SW cache >= v528', swVer);
ok(Number(jsVer) >= 528 && Number(cssVer) >= 528, 'asset ?v >= 528', { jsVer, cssVer });
ok(appJs.includes('computeProdCompletePack') && appJs.includes('renderProdPackLiveCard'), 'modal pack helpers');
ok(appJs.includes('_prodSkuSticky') && appJs.includes('keepSticky'), 'sticky warehouse selection');
ok(appJs.includes('prodColorSimilarityPairs') && appJs.includes('colorsMatch'), 'similarity warn uses colorsMatch');
ok(appJs.includes('p-sku-tab-other') && appJs.includes('includeProdPreserveColor'), 'other-warehouse tab');
ok(appJs.includes('moveProdSizeOrder') && appJs.includes('p-size-order'), 'per-product size reorder');
ok(appCss.includes('.prod-sku-panel') && appCss.includes('.prod-pack-card'), 'prod-sku CSS');

try {
  new Function(appJs);
  ok(true, 'app.js parses with new Function');
} catch (e) {
  ok(false, 'app.js parses with new Function', e && e.message);
}

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.log('SKIP_SQLITE: better-sqlite3 unavailable —', e && e.message);
  console.log(`\n══ ${pass} passed, ${fail} failed (sqlite skipped) ══\n`);
  process.exit(fail ? 1 : 0);
}

const testDb = path.join(os.tmpdir(), `erp-complete-pack-v528-${Date.now()}.db`);
try { fs.unlinkSync(testDb); } catch (_) {}

let db;
try {
  db = new Database(testDb);
  db.pragma('journal_mode = WAL');
} catch (e) {
  console.log('SKIP_SQLITE: cannot open better-sqlite3 —', e && e.message);
  console.log(`\n══ ${pass} passed, ${fail} failed (sqlite skipped) ══\n`);
  process.exit(fail ? 1 : 0);
}

db.exec(`
  CREATE TABLE products (
    id INTEGER PRIMARY KEY, code TEXT, name TEXT, price REAL DEFAULT 0, price_rial INTEGER DEFAULT 0,
    cost REAL DEFAULT 0, stock REAL DEFAULT 0, pack_size INTEGER DEFAULT 1, unit TEXT DEFAULT 'عدد',
    has_variants INTEGER DEFAULT 0, is_style INTEGER DEFAULT 0, barcode TEXT,
    default_variant_id INTEGER, colors INTEGER DEFAULT 1, warehouse_id INTEGER
  );
  CREATE TABLE warehouses (
    id INTEGER PRIMARY KEY, name TEXT, code TEXT, allow_negative INTEGER DEFAULT 0
  );
  CREATE TABLE warehouse_stock (
    product_id INTEGER NOT NULL, warehouse_id INTEGER NOT NULL, qty REAL DEFAULT 0,
    PRIMARY KEY (product_id, warehouse_id)
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
`);

const { initProductVariantsSchema } = require('../lib/product-variants');
const { generateMatrix, applyStockMatrix, packSizeFor } = require('../lib/product-variants/service');
const { ensureInventorySchema, expandLivePack } = require('../lib/inventory/movement');

try {
  initProductVariantsSchema(db);
  ensureInventorySchema(db);

  db.prepare("INSERT INTO warehouses (id,name,code,allow_negative) VALUES (1,'اصلی','WH1',0)").run();
  const productId = db.prepare(
    "INSERT INTO products (code,name,price,stock,pack_size) VALUES ('STY528','کاپشن',100000,0,1)"
  ).run().lastInsertRowid;

  generateMatrix(db, {
    product_id: productId,
    colors: [{ name: 'قرمز' }, { name: 'آبی' }, { name: 'سبز' }],
    sizes: [{ name: '1' }, { name: '2' }],
  });
  const colors = db.prepare('SELECT id,name FROM product_colors ORDER BY id').all();
  const sizes = db.prepare('SELECT id,name FROM product_sizes ORDER BY id').all();
  const red = colors.find((c) => c.name === 'قرمز');
  const blue = colors.find((c) => c.name === 'آبی');
  const green = colors.find((c) => c.name === 'سبز');
  const s1 = sizes.find((s) => s.name === '1');
  const s2 = sizes.find((s) => s.name === '2');

  applyStockMatrix(db, productId, [
    { color_id: red.id, size_id: s1.id, qty: 5 },
    { color_id: red.id, size_id: s2.id, qty: 5 },
    { color_id: blue.id, size_id: s1.id, qty: 4 },
    { color_id: blue.id, size_id: s2.id, qty: 4 },
    { color_id: green.id, size_id: s1.id, qty: 10 },
    { color_id: green.id, size_id: s2.id, qty: 10 },
  ], { warehouse_id: 1 });

  let live = expandLivePack(db, productId, 1, { mode: 'live' });
  ok(live.pack_size_auto === 6 && live.live_colors === 3 && live.live_sizes === 2,
    '3×2 complete → pack 6', live);
  ok(live.full_packs_count === 4, 'full packs = min(5,5,4,4,10,10)=4', live);

  applyStockMatrix(db, productId, [
    { color_id: red.id, size_id: s1.id, qty: 5 },
    { color_id: red.id, size_id: s2.id, qty: 5 },
    { color_id: blue.id, size_id: s1.id, qty: 4 },
    { color_id: blue.id, size_id: s2.id, qty: 4 },
    { color_id: green.id, size_id: s1.id, qty: 10 },
    { color_id: green.id, size_id: s2.id, qty: 0 },
  ], { warehouse_id: 1 });

  live = expandLivePack(db, productId, 1, { mode: 'live' });
  ok(live.pack_size_auto === 4 && live.live_colors === 2,
    'green incomplete → pack 4 (red+blue)', live);
  ok(live.full_packs_count === 4, 'full packs after green drop = min(5,5,4,4)=4', live);
  ok(live.lines.every((l) => Number(l.color_id) !== Number(green.id)),
    'green lines absent from live pack', live.lines.map((l) => l.color_name));

  const packMeta = packSizeFor(db, productId);
  ok(packMeta.pack_size_auto === 4 && packMeta.full_packs_count === 4,
    'packSizeFor matches complete-color rule', packMeta);

  const defined = expandLivePack(db, productId, 1, { mode: 'defined' });
  ok(defined.lines.length === 6 && defined.pack_size_auto === 6,
    'defined mode still lists all active SKUs', defined);
} catch (e) {
  ok(false, 'sqlite scenario', e && e.stack ? e.stack : e);
}

try { db.close(); } catch (_) {}
try { fs.unlinkSync(testDb); } catch (_) {}
try { fs.unlinkSync(testDb + '-wal'); } catch (_) {}
try { fs.unlinkSync(testDb + '-shm'); } catch (_) {}

console.log(`\n══ ${pass} passed, ${fail} failed ══\n`);
process.exit(fail ? 1 : 0);
