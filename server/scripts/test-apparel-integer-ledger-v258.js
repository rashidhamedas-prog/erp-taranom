'use strict';
const { swAtLeast } = require('./lib/sw-at-least');
/**
 * Piece/matrix stock stays integer. A float projection (6.462) is restored
 * from the movement ledger (opening 14 minus transfer 2 = 12), not rounded to 6.
 * Run: node server/scripts/test-apparel-integer-ledger-v258.js
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { healApparelIntegerStock, parseStockQty } = require('../lib/inventory/qty-policy');

const testDb = path.join(__dirname, '_apparel-integer-ledger-v258.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch (_) {}
}

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : String(extra)); }
}

const db = new Database(testDb);
db.exec(`
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE products (
    id INTEGER PRIMARY KEY, name TEXT, unit TEXT, stock REAL DEFAULT 0,
    warehouse_id INTEGER, colors INTEGER DEFAULT 1, code TEXT, pack_size INTEGER DEFAULT 1,
    is_style INTEGER DEFAULT 1, has_variants INTEGER DEFAULT 1
  );
  CREATE TABLE product_colors (id INTEGER PRIMARY KEY, name TEXT, code TEXT, active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0);
  CREATE TABLE product_sizes (id INTEGER PRIMARY KEY, name TEXT, code TEXT, active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0);
  CREATE TABLE product_variants (
    id INTEGER PRIMARY KEY, product_id INTEGER, color_id INTEGER, size_id INTEGER,
    sku TEXT, barcode TEXT, stock REAL DEFAULT 0, active INTEGER DEFAULT 1,
    is_default INTEGER DEFAULT 0, status TEXT DEFAULT 'active', price REAL, price_rial REAL, cost REAL
  );
  CREATE TABLE product_style_colors (product_id INTEGER, color_id INTEGER, PRIMARY KEY (product_id, color_id));
  CREATE TABLE product_style_sizes (product_id INTEGER, size_id INTEGER, PRIMARY KEY (product_id, size_id));
  CREATE TABLE warehouses (id INTEGER PRIMARY KEY, name TEXT, code TEXT);
  CREATE TABLE warehouse_stock (
    product_id INTEGER, warehouse_id INTEGER, qty REAL DEFAULT 0,
    PRIMARY KEY (product_id, warehouse_id)
  );
  CREATE TABLE variant_warehouse_stock (
    variant_id INTEGER, warehouse_id INTEGER, qty REAL DEFAULT 0,
    PRIMARY KEY (variant_id, warehouse_id)
  );
  CREATE TABLE inventory_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER, variant_id INTEGER, warehouse_id INTEGER,
    qty_delta REAL, doc_type TEXT, doc_id INTEGER, doc_line INTEGER,
    user_id INTEGER, note TEXT, created_at INTEGER
  );
`);

db.prepare('INSERT INTO products (id,name,unit,stock,warehouse_id,code) VALUES (109,?,?,45.033,34,?)')
  .run('کت کتان درسا', 'عدد', '7157');
db.prepare('INSERT INTO warehouses (id,name,code) VALUES (34,?,?),(35,?,?)')
  .run('انبار محصول', 'WH-MS076DVQ', 'انبار کیمیا', 'WH-KIMIA');
db.prepare('INSERT INTO product_colors (id,name) VALUES (1,?)').run('مشکی');
db.prepare('INSERT INTO product_sizes (id,name) VALUES (2,?)').run('سایز 1');
db.prepare(`INSERT INTO product_variants (id,product_id,color_id,size_id,sku,stock,is_default)
  VALUES (64,109,1,2,'7157-blk',8.462,0)`).run();
db.prepare('INSERT INTO variant_warehouse_stock (variant_id,warehouse_id,qty) VALUES (64,34,6.462),(64,35,2)').run();
db.prepare(`INSERT INTO inventory_movements (product_id,variant_id,warehouse_id,qty_delta,doc_type)
  VALUES (109,64,34,14,'opening_seed'),(109,64,34,-2,'wh_transfer_out'),(109,64,35,2,'wh_transfer_in')`).run();
db.prepare('INSERT INTO variant_warehouse_stock (variant_id,warehouse_id,qty) VALUES (70,35,0.5)').run();
db.prepare(`INSERT INTO product_variants (id,product_id,color_id,size_id,sku,stock,is_default)
  VALUES (70,109,1,2,'phantom',0.5,0)`).run();
db.prepare(`INSERT INTO inventory_movements (product_id,variant_id,warehouse_id,qty_delta,doc_type)
  VALUES (109,70,34,4,'opening_seed')`).run();
db.prepare('INSERT INTO variant_warehouse_stock (variant_id,warehouse_id,qty) VALUES (70,34,1.5)').run();
db.prepare('INSERT INTO products (id,name,unit,stock,warehouse_id,code) VALUES (200,?,?,9,34,?)')
  .run('کالای سالم', 'عدد', '9000');
db.prepare(`INSERT INTO product_variants (id,product_id,color_id,size_id,sku,stock,is_default)
  VALUES (80,200,1,2,'9000-ok',9,0)`).run();
db.prepare('INSERT INTO variant_warehouse_stock (variant_id,warehouse_id,qty) VALUES (80,34,9)').run();
db.prepare('INSERT INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (200,34,9)').run();
db.prepare('INSERT INTO products (id,name,unit,stock,warehouse_id,code) VALUES (300,?,?,1.25,34,?)')
  .run('پارچه', 'متر', 'FAB');

const healed = healApparelIntegerStock(db);
ok(healed.vwsFixed >= 2, 'heal rewrites fractional projections', JSON.stringify(healed));
const wh34 = db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=64 AND warehouse_id=34').get();
const wh35 = db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=64 AND warehouse_id=35').get();
const vstock = db.prepare('SELECT stock FROM product_variants WHERE id=64').get();
ok(wh34.qty === 12, 'product warehouse restored to 14-2', wh34.qty);
ok(wh35.qty === 2, 'transfer destination stays 2', wh35.qty);
ok(vstock.stock === 14, 'variant total is ledger sum', vstock.stock);
const phantom = db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=70 AND warehouse_id=35').get();
const real70 = db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=70 AND warehouse_id=34').get();
ok(phantom.qty === 0, 'phantom split with no movements returns to 0', phantom.qty);
ok(real70.qty === 4, 'sibling warehouse follows its own ledger', real70.qty);
const head = db.prepare('SELECT stock FROM products WHERE id=109').get();
ok(head.stock === 18, 'product header is the integer variant sum', head.stock);
const healthy = db.prepare('SELECT stock FROM products WHERE id=200').get();
const healthyWs = db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=200').get();
ok(healthy.stock === 9 && healthyWs.qty === 9, 'integer product is left untouched', healthy.stock);
const fabric = db.prepare('SELECT stock FROM products WHERE id=300').get();
ok(fabric.stock === 1.25, 'fabric meters stay decimal', fabric.stock);
const again = healApparelIntegerStock(db);
ok(again.already === true, 'heal is idempotent');

let rejected = false;
try {
  parseStockQty(0.75, { integer: true, strict: true });
} catch (e) {
  rejected = e && e.code === 'E_QTY_NOT_INTEGER';
}
ok(rejected, 'piece qty policy rejects 0.75');
const kept = db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=64 AND warehouse_id=34').get();
ok(kept.qty === 12, 'heal left the restored integer in place', kept.qty);
const svc = fs.readFileSync(path.join(__dirname, '../lib/product-variants/service.js'), 'utf8');
ok(/integer:\s*true,\s*strict:\s*true/.test(svc), 'stock matrix enforces integer qty');

const parsed = parseStockQty(12, { integer: true, strict: true });
ok(parsed === 12, 'integer parse keeps 12', parsed);

const css = fs.readFileSync(path.join(__dirname, '../public/app.css'), 'utf8');
ok(/\.tbl-wrap\{overflow:visible/.test(css), 'tables are not an inner scrollport');
ok(!/\.tbl-wrap\.tbl-scroll\{[^}]*max-height:min\(/.test(css), 'tbl-scroll no longer caps height');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(/fmtPieceQty\(v\.stock\)/.test(app), 'SKU grid prints an integer');
ok(/Math\.round\(parseQty\(inp\.value/.test(app), 'SKU save sends an integer');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
ok(swAtLeast(sw, 259), 'SW v259');

db.close();
try { fs.unlinkSync(testDb); } catch (_) {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
