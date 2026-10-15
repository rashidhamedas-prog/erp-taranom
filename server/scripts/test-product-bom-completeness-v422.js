'use strict';
/**
 * v422 — موج ۲: گیت release/issue/finalize + کد/بها hard + waive
 * Run: node server/scripts/test-product-bom-completeness-v422.js
 */
process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-jwt-secret-bom-completeness-v422-dummy-key-32!!';

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  OK', msg); }
  else { failed++; console.log('  FAIL', msg, detail != null ? detail : ''); }
}

console.log('\n══ Product + BOM completeness wave2 v422 ══\n');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const idxSrc = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
ok(appJs.includes('v421→v422') || appJs.includes('completeness_waive_reason'), 'Help/UI waive v422');
ok(appJs.includes('po-waive'), 'UI po-waive field');
ok(/erp-taranom-v42[23]/.test(swSrc), 'SW v422+');
ok(/app\.js\?v=42[23]/.test(idxSrc), 'index v422+');
ok(fs.readFileSync(path.join(__dirname, '../lib/production/schema.js'), 'utf8')
  .includes('completeness_waive_reason'), 'schema waive column');

let Database;
try {
  Database = require('better-sqlite3');
  const probe = new Database(':memory:');
  probe.close();
} catch (e) {
  console.log('\nSKIP SQLite ABI — static checks only:', e.message);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const { freshDb } = require('./lib/test-harness');
const bom = require('../lib/production/bom');
const completeness = require('../lib/production/product-completeness');
const engine = require('../lib/production/engine');

const { db, cleanup } = freshDb();
const adminId = 1;
const DATE = '1405/07/23';
const PERIOD = '1405/07';

function seedProduct(name, opts = {}) {
  const id = db.prepare('INSERT INTO products (user_id,name,price,stock) VALUES (1,?,?,?)')
    .run(name, 0, opts.stock != null ? opts.stock : 10000).lastInsertRowid;
  db.prepare(`
    UPDATE products SET average_cost_rial=?, item_type=?, is_manufactured=?, std_cost_rial=?,
      unit=COALESCE(?, unit), code=COALESCE(?, code)
    WHERE id=?
  `).run(
    opts.avg != null ? opts.avg : 0,
    opts.type || 'finished',
    opts.mfg != null ? opts.mfg : 0,
    opts.avg != null ? opts.avg : 0,
    opts.unit || null,
    opts.code || null,
    id
  );
  return id;
}

const pFg = seedProduct('مانتو v422', { type: 'finished', mfg: 1, code: 'K-V422', avg: 0 });
const pRaw = seedProduct('پارچه v422', { type: 'raw', mfg: 0, avg: 100000, unit: 'متر', code: 'FAB-422' });
const pZip = seedProduct('زیپ v422', { type: 'raw', mfg: 0, avg: 50000, code: 'ZIP-422' });
const pZipZero = seedProduct('زیپ صفر', { type: 'raw', mfg: 0, avg: 0, code: 'ZIP-0' });

const whRaw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get()?.id;
const whFg = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get()?.id;
ok(!!whRaw && !!whFg, 'T00 warehouses');
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_raw_id',?)").run(String(whRaw));
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_fg_id',?)").run(String(whFg));
for (const id of [pRaw, pZip, pZipZero]) {
  db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)')
    .run(id, whRaw, 10000);
}

// code hard for FG on activate
db.prepare('UPDATE products SET code=? WHERE id=?').run('', pFg);
const aNoCode = completeness.assessProduct(db, pFg, 'activate');
ok(aNoCode.ok === false && aNoCode.hard.some(h => h.code === 'E_SPEC_CODE'), 'T01 FG code hard');
db.prepare('UPDATE products SET code=? WHERE id=?').run('K-V422', pFg);

// cost hard on issue for zero-cost raw
const aCost = completeness.assessProduct(db, pZipZero, 'issue');
ok(aCost.ok === false && aCost.hard.some(h => h.code === 'E_SPEC_COST'), 'T02 cost hard on issue');
const aCostWaive = completeness.assessProduct(db, pZipZero, 'issue', { waive: 'موقت' });
ok(aCostWaive.ok === true, 'T03 cost waived', JSON.stringify(aCostWaive.hard));

const draft = bom.createBom(db, {
  product_id: pFg,
  name: 'BOM-v422',
  base_qty: 1,
  yield_percent: 100,
  lines: [
    { component_product_id: pRaw, qty_per_base: 1, line_type: 'material' },
    { component_product_id: pZip, qty_per_base: 1, line_type: 'material' },
  ],
}, adminId);
bom.activateBom(db, draft.id, DATE, adminId);

const po = engine.createOrder(db, {
  product_id: pFg,
  bom_id: draft.id,
  qty_planned: 2,
  date: DATE,
  analysis_type: 'fixed',
}, adminId);
ok(!!po.id, 'T04 order created');

// release gate ok
engine.releaseOrder(db, po.id, adminId);
ok(getStatus(po.id) === 'released', 'T05 released');

function getStatus(id) {
  return db.prepare('SELECT status FROM production_orders WHERE id=?').get(id)?.status;
}

// BOM with zero-cost component — issue/release should fail without waive
// (نسخه جدید از فرمول فعال تا UNIQUE clash نشود)
const vu = bom.versionUpBom(db, draft.id, 'v422-zero-cost', adminId);
const draft2Id = vu.id;
bom.replaceLines(db, draft2Id, [
  { component_product_id: pRaw, qty_per_base: 1, line_type: 'material' },
  { component_product_id: pZipZero, qty_per_base: 1, line_type: 'material' },
], adminId);
// activate still ok (cost soft on activate)
bom.activateBom(db, draft2Id, '1405/07/24', adminId);

const po2 = engine.createOrder(db, {
  product_id: pFg,
  bom_id: draft2Id,
  qty_planned: 1,
  date: DATE,
  analysis_type: 'variable',
}, adminId);

let releaseFail = false;
try {
  engine.releaseOrder(db, po2.id, adminId);
} catch (e) {
  releaseFail = String(e.code || e.message).includes('E_SPEC_COST')
    || String(e.code || e.message).includes('E_BOM_INCOMPLETE')
    || String(e.code || e.message).includes('E_PRODUCT_INCOMPLETE');
}
ok(releaseFail, 'T06 release blocked on zero-cost component');

const po3 = engine.createOrder(db, {
  product_id: pFg,
  bom_id: draft2Id,
  qty_planned: 1,
  date: DATE,
  analysis_type: 'variable',
  completeness_waive_reason: 'اصلاح بها پس از خرید — تست v422',
}, adminId);
ok(!!db.prepare('SELECT completeness_waive_reason FROM production_orders WHERE id=?')
  .get(po3.id)?.completeness_waive_reason, 'T07 waive stored');

engine.releaseOrder(db, po3.id, adminId);
ok(getStatus(po3.id) === 'released', 'T08 release with waive');

// assertOrderReady finalize
try {
  completeness.assertOrderReady(db, po3.id, 'finalize');
  ok(true, 'T09 finalize assert with waive');
} catch (e) {
  ok(false, 'T09 finalize assert with waive', e.code || e.message);
}

cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
