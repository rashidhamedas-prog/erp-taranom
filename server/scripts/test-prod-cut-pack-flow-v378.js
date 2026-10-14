'use strict';
/**
 * v378 — DB harness for cut → issue template / apparel pack resolve
 * Run on Iran: node server/scripts/test-prod-cut-pack-flow-v378.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed += 1; console.log('  OK', msg); }
  else { failed += 1; console.log('  FAIL', msg, detail != null ? detail : ''); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-v378-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.SYNC_ROLE = 'central';

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

const cutting = require('../lib/production/cutting');
const engine = require('../lib/production/engine');
const apparel = require('../lib/inventory/apparel-lines');
const bomLib = require('../lib/production/bom');
const { stripSizeFitNote } = require('../lib/display-labels');

const admin = db.prepare(`SELECT id FROM users WHERE role='admin' LIMIT 1`).get()
  || (() => {
    db.prepare(`INSERT INTO users (username, password_hash, role, name) VALUES ('v378','x','admin','v378')`).run();
    return db.prepare(`SELECT id FROM users WHERE username='v378'`).get();
  })();
const adminId = admin.id;

let whRaw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get();
let whFg = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get();
if (!whRaw) {
  whRaw = { id: db.prepare(`INSERT INTO warehouses (code,name,warehouse_kind,is_active) VALUES ('WH-RAW','مواد','raw',1)`).run().lastInsertRowid };
}
if (!whFg) {
  whFg = { id: db.prepare(`INSERT INTO warehouses (code,name,warehouse_kind,is_active) VALUES ('WH-FG','محصول','finished',1)`).run().lastInsertRowid };
}

// Non-matrix FG for PO/issue path (createOrder rejects matrix without lines).
const fgId = db.prepare(`
  INSERT INTO products (user_id, name, code, price, stock, unit, is_manufactured, item_type)
  VALUES (?, 'کاپشن ساده v378', 'V378-FG', 0, 0, 'عدد', 1, 'finished')
`).run(adminId).lastInsertRowid;
const fabId = db.prepare(`
  INSERT INTO products (user_id, name, code, price, stock, unit, average_cost_rial, item_type)
  VALUES (?, 'پارچه تست v378', 'V378-FAB', 0, 0, 'متر', 1000000, 'raw')
`).run(adminId).lastInsertRowid;
const zipId = db.prepare(`
  INSERT INTO products (user_id, name, code, price, stock, unit, average_cost_rial, item_type)
  VALUES (?, 'زیپ تست v378', 'V378-ZIP', 0, 0, 'عدد', 50000, 'raw')
`).run(adminId).lastInsertRowid;

const bom = bomLib.createBom(db, {
  product_id: fgId, name: 'BOM v378', base_qty: 1, yield_percent: 100,
}, adminId);
bomLib.addLine(db, bom.id, {
  component_product_id: fabId, qty_per_base: 2, scrap_percent: 0, line_type: 'material',
}, adminId);
bomLib.addLine(db, bom.id, {
  component_product_id: zipId, qty_per_base: 1, scrap_percent: 0, line_type: 'material',
}, adminId);
bomLib.activateBom(db, bom.id, '1405/01/01', adminId);

const DATE = '1405/07/22';
const po = engine.createOrder(db, {
  product_id: fgId, qty_planned: 10, analysis_type: 'variable',
  date: DATE, warehouse_raw_id: whRaw.id, warehouse_fg_id: whFg.id, bom_id: bom.id,
}, adminId);
engine.releaseOrder(db, po.id, adminId);

db.prepare(`
  INSERT INTO cutting_lays
    (lay_no, product_id, bom_id, warehouse_id, fabric_product_id, color, marker_length_m, ply_count,
     planned_meters, actual_meters, matrix_meters, size_breakdown, qty_pieces, unit_cost_rial,
     amount_rial, waste_amount_rial, status, idempotency_key, date, created_by, production_order_id)
  VALUES ('LAY-V378',?,?,?,?,'مشکی',2,10,20,20,20,'{}',10,1000000,20000000,0,
    'posted','v378-lay',?,?,?)
`).run(fgId, bom.id, whRaw.id, fabId, DATE, adminId, po.id);

console.log('\n== A: issueTemplate + allowance ==');
const allow = cutting.fabricIssueAllowance(db, { productId: fabId, orderId: po.id });
ok(allow.cut_meters === 20, 'cut meters tracked', allow);
ok(allow.allowed != null, 'allowed set when cut > 0');
ok(Number(allow.remaining) === 0, 'remaining 0 when cut >= BOM std', allow);

const tpl = engine.issueTemplate(db, { orderId: po.id, qtyStarted: 10 });
const fabLine = tpl.lines.find((L) => Number(L.product_id) === fabId);
const zipLine = tpl.lines.find((L) => Number(L.product_id) === zipId);
ok(!!fabLine && Number(fabLine.fabric_cut_locked) === 1, 'fabric locked in template');
ok(!!fabLine && Number(fabLine.qty_actual) === 0, 'fabric qty_actual 0');
ok(!!zipLine && Number(zipLine.qty_actual) === Number(zipLine.qty_standard), 'zipper still full std');

db.prepare('UPDATE products SET stock=100, average_cost_rial=50000 WHERE id=?').run(zipId);
db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,100)')
  .run(zipId, whRaw.id);

const iss = engine.issueMaterialsVariable(db, {
  orderId: po.id,
  body: {
    date: DATE, qty_started: 10,
    materials: [{ product_id: zipId, qty_actual: zipLine.qty_standard, reason: 'ok' }],
  },
  userId: adminId,
});
ok(iss && iss.lines && iss.lines.some((l) => Number(l.product_id) === zipId), 'non-fabric issue succeeds after cut');

let blocked = null;
try {
  engine.issueMaterialsVariable(db, {
    orderId: po.id,
    body: {
      date: DATE, qty_started: 10,
      materials: [{ product_id: fabId, qty_actual: 1, reason: 'reissue' }],
    },
    userId: adminId,
  });
} catch (e) { blocked = e.code || e.message; }
ok(blocked === 'E_FABRIC_ALREADY_CUT', 're-issue cut fabric still 409', blocked);

console.log('\n== C: apparel color / free-size ==');
const mxFg = db.prepare(`
  INSERT INTO products (user_id, name, code, price, stock, unit, is_manufactured, item_type)
  VALUES (?, 'کاپشن ماتریس v378', 'V378-MX', 0, 0, 'عدد', 1, 'finished')
`).run(adminId).lastInsertRowid;
const colorA = db.prepare(`INSERT INTO product_colors (name, code, active, sort_order) VALUES (?,?,1,1)`)
  .run('مشکی', 'V378B').lastInsertRowid;
const colorB = db.prepare(`INSERT INTO product_colors (name, code, active, sort_order) VALUES (?,?,1,2)`)
  .run('سورمه ای', 'V378N').lastInsertRowid;
const sizeId = db.prepare(`INSERT INTO product_sizes (name, code, active, sort_order) VALUES (?,?,1,1)`)
  .run('فری سایز (مناسب تا 48)', 'V378FS').lastInsertRowid;
const vA = db.prepare(`
  INSERT INTO product_variants (product_id, color_id, size_id, sku, active, is_default)
  VALUES (?,?,?,?,1,0)
`).run(mxFg, colorA, sizeId, 'V378-BLK-FS').lastInsertRowid;
const vB = db.prepare(`
  INSERT INTO product_variants (product_id, color_id, size_id, sku, active, is_default)
  VALUES (?,?,?,?,1,0)
`).run(mxFg, colorB, sizeId, 'V378-NVY-FS').lastInsertRowid;

ok(stripSizeFitNote('فری سایز (مناسب تا 48)') === 'فری سایز', 'strip fit note');
let lines = apparel.resolveApparelLines(db, {
  productId: mxFg, qty: 10,
  sizeBreakdown: { 'فری سایز (مناسب تا 48)': 10 },
  color: 'مشکی',
});
ok(lines.length === 1 && Number(lines[0].variantId) === Number(vA), 'exact color×size → variant A');

lines = apparel.resolveApparelLines(db, {
  productId: mxFg, qty: 10,
  sizeBreakdown: { 'فری سایز': 10 },
  color: 'سورمه ای',
});
ok(lines.length === 1 && Number(lines[0].variantId) === Number(vB), 'fit-note-stripped size + color → variant B');

lines = apparel.resolveApparelLines(db, {
  productId: mxFg, qty: 5,
  sizeBreakdown: [{ size: 'فری سایز (مناسب تا 48)', qty: 5 }],
  color: 'سورمه‌ای',
});
ok(lines.length === 1 && Number(lines[0].variantId) === Number(vB), 'ZWNJ navy matches', lines);

let multiMsg = '';
try {
  apparel.resolveApparelLines(db, {
    productId: mxFg, qty: 10,
    sizeBreakdown: { 'فری سایز (مناسب تا 48)': 10 },
    color: '',
  });
} catch (e) { multiMsg = e.message || ''; }
ok(/چند رنگ/.test(multiMsg), 'ambiguous multi-color message', multiMsg);

console.log('\n== B: kanban stage-only for non-adv ==');
const reports = require('../lib/production/reports');
const kb = reports.kanban(db, {});
ok(Array.isArray(kb.data.columns), 'kanban columns array');
ok((kb.data.all_stages || []).length === 0, 'variable order has no stages');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
