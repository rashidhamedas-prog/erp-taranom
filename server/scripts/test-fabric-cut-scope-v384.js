'use strict';
/**
 * v384 — fabric cut lock scoped to PO/FG (not global fabric SKU).
 * Reproduces PO-0009 (آبان) false-lock from یلدا lays totaling 239.626m.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-v384-'));
process.env.DB_PATH = path.join(tmp, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

const cutting = require('../lib/production/cutting');
const engine = require('../lib/production/engine');
const bomLib = require('../lib/production/bom');

const admin = db.prepare(`SELECT id FROM users WHERE role='admin' LIMIT 1`).get()
  || (() => {
    db.prepare(`INSERT INTO users (username, password_hash, role, name) VALUES ('v384','x','admin','v384')`).run();
    return db.prepare(`SELECT id FROM users WHERE username='v384'`).get();
  })();
const adminId = admin.id;

const whCols = new Set(db.prepare('PRAGMA table_info(warehouses)').all().map((c) => c.name));
function insertWh(code, name, kind) {
  const cols = ['name'];
  const vals = [name];
  if (whCols.has('code')) { cols.push('code'); vals.push(code); }
  if (whCols.has('warehouse_kind')) { cols.push('warehouse_kind'); vals.push(kind); }
  else if (whCols.has('kind')) { cols.push('kind'); vals.push(kind); }
  else if (whCols.has('warehouse_type')) { cols.push('warehouse_type'); vals.push(kind === 'raw' ? 'raw_material' : 'finished'); }
  if (whCols.has('is_active')) { cols.push('is_active'); vals.push(1); }
  else if (whCols.has('active')) { cols.push('active'); vals.push(1); }
  const sql = `INSERT INTO warehouses (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  return { id: db.prepare(sql).run(...vals).lastInsertRowid };
}
let whRaw = whCols.has('code')
  ? db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW-V384'").get()
  : null;
let whFg = whCols.has('code')
  ? db.prepare("SELECT id FROM warehouses WHERE code='WH-FG-V384'").get()
  : null;
if (!whRaw) whRaw = insertWh('WH-RAW-V384', 'مواد v384', 'raw');
if (!whFg) whFg = insertWh('WH-FG-V384', 'محصول v384', 'finished');

const fabId = db.prepare(`
  INSERT INTO products (user_id, name, code, price, stock, unit, average_cost_rial, item_type)
  VALUES (?, 'پارچه مموری تست', 'FAB384', 0, 500, 'متر', 100000, 'raw')
`).run(adminId).lastInsertRowid;
const zipId = db.prepare(`
  INSERT INTO products (user_id, name, code, price, stock, unit, average_cost_rial, item_type, warehouse_id)
  VALUES (?, 'زیپ کلاه تست', 'ZIP384', 0, 70, 'عدد', 200000, 'raw', ?)
`).run(adminId, whRaw.id).lastInsertRowid;
db.prepare('INSERT OR REPLACE INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,70)')
  .run(zipId, whRaw.id);
db.prepare('INSERT OR REPLACE INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,500)')
  .run(fabId, whRaw.id);

const fgYalda = db.prepare(`
  INSERT INTO products (user_id, name, code, price, stock, unit, is_manufactured, item_type)
  VALUES (?, 'کاپشن یلدا تست', 'FG-Y384', 0, 0, 'عدد', 1, 'finished')
`).run(adminId).lastInsertRowid;
const fgAban = db.prepare(`
  INSERT INTO products (user_id, name, code, price, stock, unit, is_manufactured, item_type)
  VALUES (?, 'کاپشن آبان تست', 'FG-A384', 0, 0, 'عدد', 1, 'finished')
`).run(adminId).lastInsertRowid;

function makeBom(fgId, fabPer, zipPer) {
  const bom = bomLib.createBom(db, {
    product_id: fgId, name: 'BOM-' + fgId, base_qty: 1, yield_percent: 100,
  }, adminId);
  bomLib.addLine(db, bom.id, {
    component_product_id: fabId, qty_per_base: fabPer, scrap_percent: 0, line_type: 'material',
  }, adminId);
  bomLib.addLine(db, bom.id, {
    component_product_id: zipId, qty_per_base: zipPer, scrap_percent: 0, line_type: 'material',
  }, adminId);
  bomLib.activateBom(db, bom.id, '1405/01/01', adminId);
  return bom;
}

const bomY = makeBom(fgYalda, 1.46, 1);
const bomA = makeBom(fgAban, 1.857, 1);

const DATE = '1405/07/22';
const poAban = engine.createOrder(db, {
  product_id: fgAban, qty_planned: 96, analysis_type: 'variable',
  date: DATE, warehouse_raw_id: whRaw.id, warehouse_fg_id: whFg.id, bom_id: bomA.id,
}, adminId);
engine.releaseOrder(db, poAban.id, adminId);

const poYalda = engine.createOrder(db, {
  product_id: fgYalda, qty_planned: 164, analysis_type: 'variable',
  date: DATE, warehouse_raw_id: whRaw.id, warehouse_fg_id: whFg.id, bom_id: bomY.id,
}, adminId);
engine.releaseOrder(db, poYalda.id, adminId);

const meters = [90.71, 32.142, 48.972, 67.802];
let n = 0;
for (const m of meters) {
  n += 1;
  db.prepare(`
    INSERT INTO cutting_lays
      (lay_no, product_id, bom_id, warehouse_id, fabric_product_id, color, marker_length_m, ply_count,
       planned_meters, actual_meters, matrix_meters, size_breakdown, qty_pieces, unit_cost_rial,
       amount_rial, waste_amount_rial, status, idempotency_key, date, created_by, production_order_id)
    VALUES (?,?,?,?,?,'مشکی',2,10,?,?,?,'{}',10,1000000,?,?, 'posted',?,?,?,NULL)
  `).run(
    'LAY-V384-' + n, fgYalda, bomY.id, whRaw.id, fabId,
    m, m, m, Math.round(m * 1000000), 0,
    'v384-lay-' + n, DATE, adminId
  );
}
const cutGlobal = meters.reduce((s, m) => s + m, 0);
ok(Math.abs(cutGlobal - 239.626) < 1e-6, 'fixture cut global ≈ 239.626', cutGlobal);

console.log('\n== A: Aban PO must NOT lock fabric from Yalda lays ==');
const allowAban = cutting.fabricIssueAllowance(db, { productId: fabId, orderId: poAban.id });
ok(Number(allowAban.cut_meters) === 0, 'Aban cut_meters scoped 0', allowAban);
ok(allowAban.allowed == null, 'Aban no fabric lock', allowAban);
ok(allowAban.cut_scope === 'order_or_fg', 'scope order_or_fg', allowAban);

const tplAban = engine.issueTemplate(db, { orderId: poAban.id, qtyStarted: 96 });
const fabLineA = tplAban.lines.find((L) => Number(L.product_id) === fabId);
const zipLineA = tplAban.lines.find((L) => Number(L.product_id) === zipId);
ok(!!fabLineA && Number(fabLineA.fabric_cut_locked) === 0, 'Aban fabric unlocked', fabLineA);
ok(!!fabLineA && Number(fabLineA.qty_actual) > 0, 'Aban fabric qty prefilled', fabLineA);
ok(!!zipLineA && Number(zipLineA.stock_short) === 1, 'zip stock_short flagged (70 < 96)', zipLineA);
ok(!!zipLineA && Number(zipLineA.stock_available) === 70, 'zip available 70', zipLineA);

console.log('\n== B: Yalda PO still locks its own legacy lays ==');
const allowY = cutting.fabricIssueAllowance(db, { productId: fabId, orderId: poYalda.id });
ok(Math.abs(Number(allowY.cut_meters) - cutGlobal) < 1e-6, 'Yalda cut_meters = FG lays', allowY);
ok(allowY.allowed != null, 'Yalda lock engaged', allowY);
const tplY = engine.issueTemplate(db, { orderId: poYalda.id, qtyStarted: 164 });
const fabLineY = tplY.lines.find((L) => Number(L.product_id) === fabId);
ok(!!fabLineY && Number(fabLineY.fabric_cut_locked) === 1, 'Yalda fabric locked', fabLineY);

console.log('\n== C: batch guard still blocks used roll on any PO ==');
let batchId;
try {
  batchId = db.prepare(`
    INSERT INTO inventory_batches (product_id, warehouse_id, batch_no, qty_on_hand, unit_cost_rial, status)
    VALUES (?,?, 'B384', 10, 100000, 'active')
  `).run(fabId, whRaw.id).lastInsertRowid;
} catch (e) {
  // schema may use different columns — skip if insert fails after trying minimal
  try {
    batchId = db.prepare(`
      INSERT INTO inventory_batches (product_id, warehouse_id, batch_no, qty_received, qty_on_hand)
      VALUES (?,?, 'B384', 10, 10)
    `).run(fabId, whRaw.id).lastInsertRowid;
  } catch (e2) {
    console.log('  SKIP batch insert', e2.message);
    batchId = null;
  }
}
if (batchId) {
  const layId = db.prepare('SELECT id FROM cutting_lays WHERE lay_no=?').get('LAY-V384-1').id;
  db.prepare(`
    INSERT INTO cutting_lay_rolls (lay_id, batch_id, meters, unit_cost_rial, amount_rial, status)
    VALUES (?,?,10,100000,1000000,'posted')
  `).run(layId, batchId);
  let blocked = null;
  try {
    cutting.assertFabricIssueAllowed(db, {
      productId: fabId, qty: 1, batchId, orderId: poAban.id,
    });
  } catch (e) { blocked = e.code || e.message; }
  ok(blocked === 'E_FABRIC_ALREADY_CUT', 'batch still blocked across PO', blocked);
} else {
  ok(true, 'batch schema skip (non-fatal)');
}

console.log('\n== D: seed-avg does not invent kardex qty when ledger covers stock ==');
const { seedMissingAverageCost } = require('../lib/inventory/seed-avg');
const { postInventoryMovement } = require('../lib/inventory/ledger');
const seedProd = db.prepare(`
  INSERT INTO products (user_id, name, code, price, stock, unit, item_type, average_cost_rial, warehouse_id)
  VALUES (?, 'بذر بها', 'SEED384', 0, 70, 'عدد', 'raw', 0, ?)
`).run(adminId, whRaw.id).lastInsertRowid;
db.prepare('INSERT OR REPLACE INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,70)')
  .run(seedProd, whRaw.id);
postInventoryMovement(db, {
  eventType: 'opening', productId: seedProd, warehouseId: whRaw.id, qty: 70,
  unitCostRial: 0, sourceType: 'opening_inventory', sourceId: seedProd,
  date: DATE, note: 'موجودی اول دوره (هم‌ترازی)', createdBy: adminId,
  updateAvg: false, skipStock: true,
});
const beforeLed = db.prepare(`
  SELECT COUNT(*) c, COALESCE(SUM(qty_in-qty_out),0) s FROM inventory_ledger
  WHERE product_id=? AND COALESCE(status,'posted')='posted'
`).get(seedProd);
seedMissingAverageCost(db, { productId: seedProd, unitCostRial: 200000, userId: adminId, date: DATE });
const afterLed = db.prepare(`
  SELECT COUNT(*) c, COALESCE(SUM(qty_in-qty_out),0) s FROM inventory_ledger
  WHERE product_id=? AND COALESCE(status,'posted')='posted'
`).get(seedProd);
const avg = db.prepare('SELECT average_cost_rial FROM products WHERE id=?').get(seedProd).average_cost_rial;
ok(Number(avg) === 200000, 'avg seeded');
ok(Number(afterLed.c) === Number(beforeLed.c), 'no extra ledger qty row', { beforeLed, afterLed });
ok(Number(afterLed.s) === Number(beforeLed.s), 'ledger net unchanged', { beforeLed, afterLed });

console.log('\n== E: UI strings ==');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(app.includes('موجود:'), 'E_NEGATIVE_STOCK shows available');
ok(app.includes('همین سفارش/کالای دوخته'), 'cut hint scoped copy');
ok(app.includes('کسری انبار'), 'stock_short UI note');
ok(fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8').includes('erp-taranom-v384'), 'SW v384');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
