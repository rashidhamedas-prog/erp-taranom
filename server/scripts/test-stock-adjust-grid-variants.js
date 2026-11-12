'use strict';
/**
 * v647 — buildGrid includes retired-at-zero + attach cells onto variants.
 * Temp DB only. Never product 342 / 7217 / live 103.
 * Run: node server/scripts/test-stock-adjust-grid-variants.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}

console.log('\n══ v647 — stock-adjust-grid-variants ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-adjust-gv-'));
process.env.DB_PATH = path.join(dir, 'adj.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'stock-adjust-gv-test-secret-at-least-32-chars!!!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const dbMods = require('../db');
dbMods.initDB();
const db = dbMods.getDB();

const L = require('../lib/inventory/ledger');
const M = require('../lib/inventory/movement');
const AD = require('../lib/inventory/adjust-doc');
const { todayJalali } = require('../jalali');

const colsCache = new Map();
const cols = (t) => {
  if (!colsCache.has(t)) colsCache.set(t, new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)));
  return colsCache.get(t);
};
function insert(table, obj) {
  const c = cols(table);
  const keys = Object.keys(obj).filter((k) => c.has(k));
  return db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => obj[k])).lastInsertRowid;
}
const q1 = (sql, ...p) => db.prepare(sql).get(...p);

const adminId = insert('users', {
  name: 'مدیر', username: 'sagv_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0,
});
const whA = insert('warehouses', {
  name: 'انبار الف', code: 'WHA-GV', active: 1, allow_negative: 0, is_default: 1,
  warehouse_type: 'finished_goods', inventory_system: 'perpetual',
});
const whEmpty = insert('warehouses', {
  name: 'انبار خالی', code: 'WHE-GV', active: 1, allow_negative: 0, is_default: 0,
  warehouse_type: 'finished_goods', inventory_system: 'perpetual',
});

const P = insert('products', {
  user_id: adminId, name: 'ماتریس شش‌رنگ', code: 'SAD-GV-6C', price: 100000, cost: 50000, stock: 0,
  warehouse_id: whA, average_cost_rial: 500000, unit: 'عدد',
});
insert('product_variants', {
  product_id: P, sku: 'SAD-GV-6C', stock: 0, active: 1, is_default: 1,
});

const colorNames = ['c1', 'c2', 'c3', 'c4', 'c5-zero', 'c6-zero'];
const colors = colorNames.map((n, i) => insert('product_colors', {
  name: n, code: 'GV' + i, active: 1, sort_order: i + 1,
}));
const sizeId = insert('product_sizes', { name: 'فری', code: 'F-GV', active: 1, sort_order: 1 });
const V = colors.map((cid, i) => insert('product_variants', {
  product_id: P, color_id: cid, size_id: sizeId,
  sku: `SAD-GV-${i + 1}`, stock: 0, active: 1, is_default: 0,
}));

let srcSeq = 9100;
function receive(pid, wh, qty, variantId) {
  return L.postInventoryMovement(db, {
    eventType: 'purchase', productId: pid, warehouseId: wh, qty, unitCostRial: 400000, variantId,
    sourceType: 'purchase', sourceId: ++srcSeq, date: todayJalali(), createdBy: adminId,
  });
}
// 4 active with stock on WH-A; 2 inactive at qty 0
for (let i = 0; i < 4; i++) {
  receive(P, whA, 2 + i, V[i]);
  M.postVariantLayer(db, {
    productId: P, variantId: V[i], warehouseId: whA, qtyDelta: 2 + i,
    docType: 'seed', docId: srcSeq, userId: adminId, note: 'seed',
  });
}
db.prepare('UPDATE product_variants SET active=0, status=? WHERE id IN (?,?)').run('inactive', V[4], V[5]);

console.log('— buildGrid includes retired-at-zero —');
const grid = AD.buildGrid(db, { product_id: P });
ok(grid.variants.length === 6, 'buildGrid returns 6 non-default rows', { n: grid.variants.length });
ok(!grid.variants.some((v) => Number(v.variant_id) === Number(q1(
  'SELECT id FROM product_variants WHERE product_id=? AND COALESCE(is_default,0)=1', P
).id)), 'default SKU absent from grid');
const retired = grid.variants.filter((v) => v.retired || v.active === 0);
ok(retired.length === 2, 'two retired-at-zero rows', { n: retired.length, ids: retired.map((v) => v.variant_id) });
ok(retired.every((v) => Number(v.active) === 0 && v.retired === true), 'retired flags set');
ok(Array.isArray(grid.cells) && grid.cells.length >= 6, 'cells present for variants');
const zeroCell = grid.cells.find((c) => Number(c.variant_id) === Number(V[4]) && Number(c.warehouse_id) === Number(whA));
ok(zeroCell && Number(zeroCell.system_qty) === 0, 'retired-at-zero has system_qty 0 cell');
const stockCell = grid.cells.find((c) => Number(c.variant_id) === Number(V[0]) && Number(c.warehouse_id) === Number(whA));
ok(stockCell && Number(stockCell.system_qty) === 2, 'in-stock cell system_qty=2', stockCell);

console.log('— attachCellsToVariants —');
const before = (grid.variants[0] && grid.variants[0].cells);
ok(before == null, 'raw grid.variants have no cells before attach');
const attached = AD.attachCellsToVariants(grid.variants, grid.cells);
ok(attached.every((v) => Array.isArray(v.cells)), 'every variant has cells[] after attach');
const a0 = attached.find((v) => Number(v.variant_id) === Number(V[0]));
const cellA = (a0.cells || []).find((c) => Number(c.warehouse_id) === Number(whA));
ok(cellA && cellA.qty === 2, 'attached cell qty===system_qty (2)', cellA);
const flatSample = [{ variant_id: 99, warehouse_id: 7, system_qty: 6 }];
const mapped = AD.attachCellsToVariants([{ variant_id: 99, label: 'x' }], flatSample);
ok(mapped[0].cells[0].qty === 6, 'helper: system_qty 6 → cells[0].qty === 6');

console.log('— defaultSelectedWarehouseIds —');
const sel = AD.defaultSelectedWarehouseIds(grid, whA);
ok(sel.includes(Number(whA)), 'selects WH with stock / product default', sel);
ok(!sel.includes(Number(whEmpty)), 'does not pre-select empty raw WH', sel);

console.log('— postDoc reactivates retired-at-zero (scratch) —');
const user = { id: adminId, role: 'admin' };
const plan = AD.planDoc(db, {
  date: todayJalali(), mode: 'count', reason_code: 'surplus',
  lines: [{
    product_id: P, warehouse_id: whA, variant_id: V[4], qty: 3,
    expected_system_qty: 0,
  }],
}, user);
ok(!(plan.blocking && plan.blocking.length), 'plan not blocked', plan.blocking);
const posted = AD.postDoc(db, {
  date: todayJalali(), mode: 'count', reason_code: 'surplus', note: 'gv-reactivate',
  client_request_id: 'gv-test-' + Date.now(),
  lines: [{
    product_id: P, warehouse_id: whA, variant_id: V[4], qty: 3,
    expected_system_qty: 0,
  }],
}, user);
ok(posted && (posted.id || posted.doc_id || posted.doc_no), 'postDoc ok', posted && { id: posted.id, doc_no: posted.doc_no });
ok(Number(q1('SELECT active FROM product_variants WHERE id=?', V[4]).active) === 1, 'retired variant reactivated');
const led = q1(
  `SELECT id, variant_id, qty_in, qty_out FROM inventory_ledger
   WHERE product_id=? AND variant_id=? ORDER BY id DESC LIMIT 1`,
  P, V[4]
);
ok(led && Number(led.variant_id) === Number(V[4]), 'ledger line has that variant_id', led);

console.log('— app.js / SW shape —');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const i = app.indexOf('function openStockAdjustDocModal');
const slice = i >= 0 ? app.slice(i, i + 35000) : '';
ok(/function attachAdjustGrid\(/.test(slice), 'attachAdjustGrid helper in modal');
ok(/function defaultSelectedWh\(/.test(slice), 'defaultSelectedWh helper');
ok(/بازنشسته/.test(slice), 'retired mark in card');
ok(/بدون رنگ\/سایز/.test(slice), 'unattributed reminder row');
ok(/previewWhLabel|previewVarLabel/.test(slice), 'preview name helpers');
ok(/attachAdjustGrid\(card,\s*grid\)/.test(slice), 'stale refresh uses attachAdjustGrid');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
ok(/erp-taranom-v647/.test(sw), 'SW v647');
ok(/app\.js\?v=647/.test(index), 'index ?v=647');
ok(!/product_id[=:]\s*342\b/.test(fs.readFileSync(__filename, 'utf8')), 'test avoids product 342');
ok(!/code:\s*['"]7217['"]/.test(fs.readFileSync(__filename, 'utf8')), 'test avoids code 7217');

try {
  // eslint-disable-next-line no-new-func
  new Function(app);
  ok(true, 'app.js parses');
} catch (e) {
  ok(false, 'app.js parses: ' + (e && e.message));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
