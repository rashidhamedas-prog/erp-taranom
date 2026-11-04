'use strict';
/**
 * Guard: rebuildStockCache must not wipe colour×size caches when openings lack variant_id.
 * Run: node server/scripts/test-variant-restore-guard.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-restore-guard-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-variant-restore-guard-secret-32ch!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';

delete require.cache[require.resolve('../db')];
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK ', label); }
  else { fail += 1; console.log(' FAIL', label, extra != null ? JSON.stringify(extra) : ''); }
}

const { rebuildStockCache, rebuildAllStockCaches, withCacheWriter, deriveProductStock } = require('../lib/inventory/stock-cache');
const { todayJalali } = require('../jalali');
const today = todayJalali();
const ADMIN = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() || { id: 1 };

console.log('\n=== test-variant-restore-guard ===\n');

let wh = db.prepare('SELECT id FROM warehouses WHERE active=1 ORDER BY id LIMIT 1').get()?.id;
if (!wh) wh = Number(db.prepare("INSERT INTO warehouses (name, code, active) VALUES ('انبار گارد','WH-VRG',1)").run().lastInsertRowid);
const pid = Number(db.prepare(`
  INSERT INTO products (user_id, name, code, price, cost, average_cost_rial, stock, warehouse_id, unit, has_variants, is_style)
  VALUES (?, 'گارد بازیابی واریانت', 'VRG-1', 1000, 500, 500, 0, ?, 'عدد', 1, 1)
`).run(ADMIN.id, wh).lastInsertRowid);
const col = Number(db.prepare("INSERT INTO product_colors (name, code, active) VALUES ('مشکی-گارد','VRG-BLK',1)").run().lastInsertRowid);
const s1 = Number(db.prepare("INSERT INTO product_sizes (name, code, active) VALUES ('38-گ','VRG38',1)").run().lastInsertRowid);
const s2 = Number(db.prepare("INSERT INTO product_sizes (name, code, active) VALUES ('40-گ','VRG40',1)").run().lastInsertRowid);
const v1 = Number(db.prepare(`
  INSERT INTO product_variants (product_id, color_id, size_id, sku, stock, active, is_default)
  VALUES (?, ?, ?, 'VRG-1-38', 0, 1, 0)
`).run(pid, col, s1).lastInsertRowid);
const v2 = Number(db.prepare(`
  INSERT INTO product_variants (product_id, color_id, size_id, sku, stock, active, is_default)
  VALUES (?, ?, ?, 'VRG-1-40', 0, 1, 0)
`).run(pid, col, s2).lastInsertRowid);

db.prepare(`
  INSERT INTO inventory_ledger (tx_no, event_type, product_id, warehouse_id, qty_in, qty_out, unit_cost_rial, amount_rial,
    source_type, source_id, status, date, created_by, variant_id)
  VALUES ('VRG-OPEN', 'opening', ?, ?, 10, 0, 500, 5000, 'opening_inventory', 1, 'posted', ?, ?, NULL)
`).run(pid, wh, today, ADMIN.id);

withCacheWriter(db, () => {
  db.prepare('INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,?)').run(v1, wh, 4);
  db.prepare('INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,?)').run(v2, wh, 6);
  db.prepare('UPDATE product_variants SET stock=? WHERE id=?').run(4, v1);
  db.prepare('UPDATE product_variants SET stock=? WHERE id=?').run(6, v2);
  db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)').run(pid, wh, 10);
  db.prepare('UPDATE products SET stock=? WHERE id=?').run(10, pid);
});

const d0 = deriveProductStock(db, pid);
ok(d0.unattributed.get(wh) === 10 && (d0.variants.get(v1) || 0) === 0,
  'ledger has unattributed opening; attributed variant Σ is 0', { una: [...d0.unattributed], vars: [...d0.variants] });

const sum = rebuildStockCache(db, pid);
ok(sum.variant_cache_preserved === true, 'rebuild flags preserved variant cells');
ok(Number(db.prepare('SELECT stock FROM product_variants WHERE id=?').get(v1).stock) === 4, 'v1 stock preserved');
ok(Number(db.prepare('SELECT stock FROM product_variants WHERE id=?').get(v2).stock) === 6, 'v2 stock preserved');
ok(Number(db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?').get(v1, wh).qty) === 4,
  'vws v1 preserved');
ok(Number(db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?').get(v2, wh).qty) === 6,
  'vws v2 preserved');
ok(Number(db.prepare('SELECT stock FROM products WHERE id=?').get(pid).stock) === 10, 'header still from ledger');

rebuildAllStockCaches(db, { productIds: [pid] });
ok(Number(db.prepare('SELECT stock FROM product_variants WHERE id=?').get(v1).stock) === 4
  && Number(db.prepare('SELECT stock FROM product_variants WHERE id=?').get(v2).stock) === 6,
  'rebuildAllStockCaches also preserves');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
