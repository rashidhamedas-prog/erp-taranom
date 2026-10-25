#!/usr/bin/env node
/**
 * v543 — Partial pack matrix: expandLivePack matrix fields, unit price A+,
 * full_pack settings, VWS trigger migration, client contracts.
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
const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

ok(sw.includes('erp-taranom-v543'), 'SW v543');
ok(indexHtml.includes('app.js?v=543'), 'app.js ?v=543');
ok(appJs.includes('openPartialPackMatrix') && appJs.includes('stocked_qty'), 'client partial matrix helpers');
ok(appJs.includes('پک کامل:') && appJs.includes('تکی موجود:'), 'picker pack meta label');
ok(appJs.includes('sales.full_pack_mode') || appJs.includes('s-sales_full_pack_mode'), 'settings UI full_pack_mode');
ok(appJs.includes('موجودی کالا با موجودی رنگ/سایز همخوان نیست'), 'drift toast suffix');
try {
  new Function(appJs);
  ok(true, 'app.js parses');
} catch (e) {
  ok(false, 'app.js parses', e && e.message);
}

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.log('SKIP_SQLITE: better-sqlite3 unavailable —', e && e.message);
  console.log(`\n══ ${pass} passed, ${fail} failed (sqlite skipped) ══\n`);
  process.exit(fail ? 1 : 0);
}

const testDb = path.join(os.tmpdir(), `erp-pack-matrix-v543-${Date.now()}.db`);
try { fs.unlinkSync(testDb); } catch (_) {}

let db;
try {
  db = new Database(testDb);
} catch (e) {
  console.log('SKIP_SQLITE: cannot open better-sqlite3 —', e && e.message);
  console.log(`\n══ ${pass} passed, ${fail} failed (sqlite skipped) ══\n`);
  process.exit(fail ? 1 : 0);
}
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 8000');

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
  CREATE TABLE customers (
    id INTEGER PRIMARY KEY, biz TEXT, owner TEXT, city TEXT, phone TEXT
  );
`);

const { initProductVariantsSchema } = require('../lib/product-variants');
const { generateMatrix, applyStockMatrix } = require('../lib/product-variants/service');
const { ensureInventorySchema, expandLivePack, postStockMovement } = require('../lib/inventory/movement');
const { unitPriceRialForVariant } = require('../lib/inventory/pack-unit-price');
const {
  resolveFullPackMode, canSellPartialPack, KEY,
} = require('../lib/inventory/full-pack-settings');
const { up, down, status, countNegativeQty } = require('../lib/inventory/pack-matrix-schema');

try {
  initProductVariantsSchema(db);
  ensureInventorySchema(db);

  const mig = up(db);
  ok(mig.ok, 'migration up', mig);
  const st1 = status(db);
  ok(st1.version === '1' && st1.full_pack_mode === 'required', 'status after up', st1);
  ok(st1.product_override_column === true, 'products.full_pack_mode column');
  ok((st1.vws_triggers || []).length >= 2, 'VWS triggers installed', st1.vws_triggers);

  db.prepare("INSERT INTO warehouses (id,name,code,allow_negative) VALUES (1,'انبار کیمیا','KIM',0)").run();
  db.prepare("INSERT INTO customers (id,biz) VALUES (1,'نقدی فروشگاه')").run();

  // RCA fixture: 2×2, white only S=3, brown only M=2, warehouse_stock=5, style price 13600000
  const productId = db.prepare(
    "INSERT INTO products (code,name,price,price_rial,stock,pack_size,has_variants,is_style) VALUES ('AFSOON','کت و شلوار شنل افسون',13600000,13600000,5,4,1,1)"
  ).run().lastInsertRowid;

  generateMatrix(db, {
    product_id: productId,
    colors: [{ name: 'سفید' }, { name: 'قهوه‌ای' }],
    sizes: [{ name: 'S' }, { name: 'M' }],
  });
  const colors = db.prepare('SELECT id,name FROM product_colors ORDER BY id').all();
  const sizes = db.prepare('SELECT id,name FROM product_sizes ORDER BY id').all();
  const white = colors.find((c) => c.name === 'سفید');
  const brown = colors.find((c) => c.name === 'قهوه‌ای');
  const szS = sizes.find((s) => s.name === 'S');
  const szM = sizes.find((s) => s.name === 'M');

  applyStockMatrix(db, productId, [
    { color_id: white.id, size_id: szS.id, qty: 3 },
    { color_id: white.id, size_id: szM.id, qty: 0 },
    { color_id: brown.id, size_id: szS.id, qty: 0 },
    { color_id: brown.id, size_id: szM.id, qty: 2 },
  ], { warehouse_id: 1 });
  db.prepare(
    'INSERT OR REPLACE INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,5)'
  ).run(productId, 1);

  const live = expandLivePack(db, productId, 1, { mode: 'live' });
  ok(live.lines.length === 0, 'RCA: no complete pack lines', live.lines);
  ok(live.stocked_qty === 5, 'stocked_qty = 3+2', live.stocked_qty);
  ok(live.stocked_sku_count === 2, 'stocked_sku_count = 2', live.stocked_sku_count);
  ok(Array.isArray(live.matrix) && live.matrix.length === 4, 'matrix has 4 SKUs', live.matrix.length);
  ok(live.full_packs_count === 0, 'full_packs_count = 0', live);
  ok(live.leftover_singles_qty === 5, 'leftover_singles = stocked', live.leftover_singles_qty);
  ok(Array.isArray(live.incomplete_colors) && live.incomplete_colors.length === 2,
    'incomplete_colors both colors', live.incomplete_colors);

  // Unit price A+: style price (not / pack_size)
  const whiteS = live.matrix.find(
    (m) => Number(m.color_id) === Number(white.id) && Number(m.size_id) === Number(szS.id)
  );
  ok(whiteS && Number(whiteS.unit_price_rial) === 13600000,
    'unit price = style 13600000 (not /4)', whiteS && whiteS.unit_price_rial);

  const vid = whiteS.variant_id;
  db.prepare('UPDATE product_variants SET price_rial=? WHERE id=?').run(15000000, vid);
  ok(unitPriceRialForVariant(db, productId, vid) === 15000000, 'variant price_rial override');

  ok(resolveFullPackMode(db, productId) === 'required', 'default required');
  db.prepare('UPDATE products SET full_pack_mode=? WHERE id=?').run('optional', productId);
  ok(resolveFullPackMode(db, productId) === 'optional', 'product override optional');
  ok(canSellPartialPack('required', { role: 'field_sales' }) === false, 'required blocks field_sales');
  ok(canSellPartialPack('required', { role: 'admin' }) === true, 'required allows admin');
  ok(canSellPartialPack('optional', { role: 'field_sales' }) === true, 'optional allows sales');

  // Conditional deduct + trigger
  const before = Number(
    db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?')
      .get(vid, 1).qty
  );
  postStockMovement(db, {
    productId, variantId: vid, warehouseId: 1, qtyDelta: -1,
    docType: 'test_partial', docId: 1, userId: 1, allowNegative: false, applyHeaderStock: true,
  });
  const after = Number(
    db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?')
      .get(vid, 1).qty
  );
  ok(after === before - 1, 'VWS deducted by 1', { before, after });

  let trigBlocked = false;
  try {
    db.prepare(
      'UPDATE variant_warehouse_stock SET qty=? WHERE variant_id=? AND warehouse_id=?'
    ).run(-1, vid, 1);
  } catch (e) {
    trigBlocked = /E_NEGATIVE_STOCK|ABORT|negativ/i.test(String(e && e.message));
  }
  ok(trigBlocked, 'VWS trigger blocks direct negative UPDATE');

  // Concurrent last-unit race: two IMMEDIATE txs try to take remaining stock
  const rem = Number(
    db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?')
      .get(vid, 1).qty
  );
  ok(rem >= 1, 'remaining for race >=1', rem);
  // leave exactly 1
  db.prepare(
    'UPDATE variant_warehouse_stock SET qty=? WHERE variant_id=? AND warehouse_id=?'
  ).run(1, vid, 1);

  const takeOne = db.transaction(() => {
    const r = db.prepare(`
      UPDATE variant_warehouse_stock SET qty = qty - 1
      WHERE variant_id=? AND warehouse_id=? AND qty >= 1
    `).run(vid, 1);
    if (!r.changes) throw new Error('LOSE');
  });
  let wins = 0;
  let losses = 0;
  try { takeOne.immediate(); wins += 1; } catch (_) { losses += 1; }
  try { takeOne.immediate(); wins += 1; } catch (_) { losses += 1; }
  ok(wins === 1 && losses === 1, 'exactly one concurrent take wins', { wins, losses });
  const finalQty = Number(
    db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?')
      .get(vid, 1).qty
  );
  ok(finalQty === 0, 'final VWS qty = 0', finalQty);
  ok(countNegativeQty(db).total === 0, 'no negative rows');

  // migration down → up
  const d = down(db);
  ok(d.ok, 'migration down', d);
  const st2 = status(db);
  ok(!st2.version, 'version cleared after down', st2);
  const mig2 = up(db);
  ok(mig2.ok, 'migration up again', mig2);

  // Complete color still packs (regression)
  applyStockMatrix(db, productId, [
    { color_id: white.id, size_id: szS.id, qty: 3 },
    { color_id: white.id, size_id: szM.id, qty: 3 },
    { color_id: brown.id, size_id: szS.id, qty: 0 },
    { color_id: brown.id, size_id: szM.id, qty: 0 },
  ], { warehouse_id: 1 });
  const live2 = expandLivePack(db, productId, 1, { mode: 'live' });
  ok(live2.lines.length === 2 && live2.full_packs_count === 3,
    'one complete color → full pack, no matrix needed', live2);
} catch (e) {
  ok(false, 'sqlite scenario', e && e.stack ? e.stack : e);
}

try { db.close(); } catch (_) {}
try { fs.unlinkSync(testDb); } catch (_) {}
try { fs.unlinkSync(testDb + '-wal'); } catch (_) {}
try { fs.unlinkSync(testDb + '-shm'); } catch (_) {}

console.log(`\n══ ${pass} passed, ${fail} failed ══\n`);
process.exit(fail ? 1 : 0);
