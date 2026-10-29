#!/usr/bin/env node
/**
 * v439 (+v528 complete-color): live pack = complete colors × sizes;
 * a color with any zero size drops entirely; unchecked SKUs deactivate; modes intact.
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

// Client contract (no sqlite)
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(appJs.includes('fetchProductLivePack') && appJs.includes('resolveServerAutoPack'),
  'app.js uses server live-pack helpers');
ok(appJs.includes('resolveServerModalPack'),
  'app.js has resolveServerModalPack for edit/modal SoT');
ok(appJs.includes('/product-variants/live-pack/'),
  'app.js references /product-variants/live-pack/');
// Edit / store-quick / returns must not load style for matrix pick
function fnBody(src, name) {
  const re = new RegExp('async function ' + name + '\\([\\s\\S]*?\\n(?=async function |function |$)');
  const m = src.match(re);
  return m ? m[0] : '';
}
const editBody = fnBody(appJs, 'editInvCartPack');
const storeBody = fnBody(appJs, 'storeQsPickVariantThenAdd');
const retBody = fnBody(appJs, 'openReturnProductPick');
ok(editBody.includes('resolveServerModalPack') && !editBody.includes('/product-variants/style/'),
  'editInvCartPack uses modal SoT not style');
ok(storeBody.includes('resolveServerModalPack') && !storeBody.includes('/product-variants/style/'),
  'storeQsPickVariantThenAdd uses modal SoT not style');
ok(retBody.includes('resolveServerModalPack') && !retBody.includes('/product-variants/style/'),
  'openReturnProductPick uses modal SoT not style');
const mk = fs.readFileSync(path.join(__dirname, '../public/marketer-ui.js'), 'utf8');
ok(mk.includes('resolveServerAutoPack'), 'marketer-ui uses resolveServerAutoPack');
ok(mk.includes('resolveServerModalPack') && !/editCartProduct[\s\S]*?\/product-variants\/style\//.test(mk),
  'marketer editCartProduct uses modal SoT not style');

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.log('SKIP_SQLITE: better-sqlite3 unavailable —', e && e.message);
  console.log(`\n══ ${pass} passed, ${fail} failed (sqlite skipped) ══\n`);
  process.exit(fail ? 1 : 0);
}

const testDb = path.join(os.tmpdir(), `erp-live-pack-v439-${Date.now()}.db`);
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
const {
  generateMatrix, packSizeFor,
} = require('../lib/product-variants/service');
// P1: applyStockMatrix is structure-only in production; fixtures seed cache layers directly.
const applyStockMatrix = (...a) => require('./test-helpers/matrix-seed').seedMatrixQty(...a);
const {
  ensureInventorySchema, expandLivePack, postStockMovement,
} = require('../lib/inventory/movement');

try {
  initProductVariantsSchema(db);
  ensureInventorySchema(db);
} catch (e) {
  console.log('SKIP_SQLITE: schema init failed —', e && e.message);
  try { db.close(); } catch (_) {}
  console.log(`\n══ ${pass} passed, ${fail} failed (sqlite skipped) ══\n`);
  process.exit(fail ? 1 : 0);
}

db.prepare("INSERT INTO warehouses (id,name,code,allow_negative) VALUES (1,'اصلی','WH1',0)").run();

const productId = db.prepare(
  "INSERT INTO products (code,name,price,stock,pack_size) VALUES ('STY439','مانتو',100000,0,1)"
).run().lastInsertRowid;

generateMatrix(db, {
  product_id: productId,
  colors: [{ name: 'صورتی' }, { name: 'مشکی' }],
  sizes: [{ name: 'S' }, { name: 'M' }],
});

const colors = db.prepare('SELECT id,name FROM product_colors ORDER BY id').all();
const sizes = db.prepare('SELECT id,name FROM product_sizes ORDER BY id').all();
const pink = colors.find((c) => c.name === 'صورتی');
const black = colors.find((c) => c.name === 'مشکی');
const szS = sizes.find((s) => s.name === 'S');
const szM = sizes.find((s) => s.name === 'M');

applyStockMatrix(db, productId, [
  { color_id: pink.id, size_id: szS.id, qty: 5 },
  { color_id: pink.id, size_id: szM.id, qty: 3 },
  { color_id: black.id, size_id: szS.id, qty: 2 },
  { color_id: black.id, size_id: szM.id, qty: 0 },
], { warehouse_id: 1 });

const pack = packSizeFor(db, productId);
ok(pack.pack_size_auto === 2, 'pack_size_auto = 1 complete color × 2 sizes (black incomplete)', pack);
ok(pack.full_packs_count === 3, 'full_packs_count = min(5,3) for pink', pack);

const live = expandLivePack(db, productId, 1, { mode: 'live' });
ok(live.lines.length === 2 && live.pack_size_auto === 2, 'expandLivePack live = pink only (2 lines)', live);
ok(live.full_packs_count === 3, 'live full_packs_count = 3', live);
ok(live.has_matrix === 1 && live.matrix_sku_count === 4, 'has_matrix with 4 active SKUs', live);

const defined = expandLivePack(db, productId, 1, { mode: 'defined' });
ok(defined.lines.length === 4 && defined.pack_size_auto === 4, 'defined mode includes zero-stock active SKU', defined);

// P1: unchecking a color that STILL carries stock must NOT zero it — black×S=2 stays active
applyStockMatrix(db, productId, [
  { color_id: pink.id, size_id: szS.id, qty: 5 },
  { color_id: pink.id, size_id: szM.id, qty: 3 },
], { warehouse_id: 1 });
const blackKeptWithStock = db.prepare(`
  SELECT COUNT(*) c FROM product_variants
  WHERE product_id=? AND color_id=? AND active=1 AND is_default=0 AND stock>0
`).get(productId, black.id).c;
ok(blackKeptWithStock === 1, 'P1: unchecked color with stock keeps its SKU and qty', blackKeptWithStock);

// Uncheck black entirely once it is truly zero — even zero-stock black×M must deactivate
applyStockMatrix(db, productId, [
  { color_id: pink.id, size_id: szS.id, qty: 5 },
  { color_id: pink.id, size_id: szM.id, qty: 3 },
  { color_id: black.id, size_id: szS.id, qty: 0 },
  { color_id: black.id, size_id: szM.id, qty: 0 },
], { warehouse_id: 1 });
applyStockMatrix(db, productId, [
  { color_id: pink.id, size_id: szS.id, qty: 5 },
  { color_id: pink.id, size_id: szM.id, qty: 3 },
], { warehouse_id: 1 });

const blackActive = db.prepare(`
  SELECT COUNT(*) c FROM product_variants
  WHERE product_id=? AND color_id=? AND active=1 AND is_default=0
`).get(productId, black.id).c;
ok(blackActive === 0, 'uncheck deactivates zero-stock black SKUs too', blackActive);

const liveAfter = expandLivePack(db, productId, 1, { mode: 'live' });
ok(liveAfter.lines.length === 2 && liveAfter.pack_size_auto === 2, 'live pack after uncheck = pink only (2×1)', liveAfter);
ok(liveAfter.full_packs_count === 3, 'full packs after uncheck still min(5,3)=3', liveAfter);

const definedAfter = expandLivePack(db, productId, 1, { mode: 'defined' });
ok(definedAfter.lines.length === 2, 'defined pack never re-adds unchecked black', definedAfter.lines.length);

// Inactive variant rejected by postStockMovement
const ghost = db.prepare(`
  SELECT id FROM product_variants
  WHERE product_id=? AND color_id=? AND is_default=0 LIMIT 1
`).get(productId, black.id);
let inactiveBlocked = false;
try {
  db.transaction(() => {
    postStockMovement(db, {
      productId, variantId: ghost.id, warehouseId: 1, qtyDelta: -1,
      docType: 'invoice', docId: 43901, docLine: 0, allowNegative: true,
    });
  })();
} catch (e) {
  inactiveBlocked = !!(e && e.code === 'E_VARIANT_INACTIVE');
}
ok(inactiveBlocked, 'postStockMovement blocks inactive variant', ghost && ghost.id);

db.close();
try { fs.unlinkSync(testDb); } catch (_) {}
try { fs.unlinkSync(testDb + '-wal'); } catch (_) {}
try { fs.unlinkSync(testDb + '-shm'); } catch (_) {}

console.log(`\n══ ${pass} passed, ${fail} failed ══\n`);
process.exit(fail ? 1 : 0);
