'use strict';
/**
 * v421 — مشخصات ضروری کالا + آمادگی BOM (گیت فعال‌سازی / سفارش)
 * Run: node server/scripts/test-product-bom-completeness-v421.js
 */
process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-jwt-secret-bom-completeness-v421-dummy-key-32!!';

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  OK', msg); }
  else { failed++; console.log('  FAIL', msg, detail != null ? detail : ''); }
}

console.log('\n══ Product + BOM completeness v421 ══\n');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const idxSrc = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
ok(appJs.includes('prodCompletenessBannerHtml') && appJs.includes('prodBomRefreshReadiness'), 'UI readiness helpers');
ok(appJs.includes('مشخصات ضروری کالا + آمادگی BOM (v421') || appJs.includes('v421→v422'), 'Help v421+');
ok(swSrc.includes('erp-taranom-v421') || swSrc.includes('erp-taranom-v422'), 'SW v421+');
ok(idxSrc.includes('app.js?v=421') || idxSrc.includes('app.js?v=422'), 'index v421+');
ok(fs.existsSync(path.join(__dirname, '../lib/production/product-completeness.js')), 'helper module');

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

function seedProduct(name, opts = {}) {
  const id = db.prepare('INSERT INTO products (user_id,name,price,stock) VALUES (1,?,?,?)')
    .run(name, 0, opts.stock != null ? opts.stock : 100).lastInsertRowid;
  db.prepare(`
    UPDATE products SET average_cost_rial=?, item_type=?, is_manufactured=?, std_cost_rial=?,
      unit=COALESCE(?, unit), code=COALESCE(?, code)
    WHERE id=?
  `).run(
    opts.avg || 0,
    opts.type || 'finished',
    opts.mfg != null ? opts.mfg : 0,
    opts.avg || 0,
    opts.unit || null,
    opts.code || null,
    id
  );
  return id;
}

const pFg = seedProduct('مانتو تست v421', { type: 'finished', mfg: 1, avg: 0, code: 'K-V421' });
const pTrade = seedProduct('کالای فروش‌محض', { type: 'finished', mfg: 0, code: 'K-TRADE' });
const pRaw = seedProduct('پارچه تست', { type: 'raw', mfg: 0, avg: 100000, unit: 'متر', code: 'FAB-1' });
const pZip = seedProduct('زیپ', { type: 'raw', mfg: 0, avg: 50000, code: 'ZIP-1' });

ok(completeness.classifyKind(db.prepare('SELECT * FROM products WHERE id=?').get(pFg)) === 'fg', 'T01 kind fg');
ok(completeness.classifyKind(db.prepare('SELECT * FROM products WHERE id=?').get(pTrade)) === 'trade', 'T02 kind trade');
ok(completeness.classifyKind(db.prepare('SELECT * FROM products WHERE id=?').get(pRaw)) === 'fabric', 'T03 kind fabric');

const aFg = completeness.assessProduct(db, pFg, 'activate');
ok(aFg.ok === true, 'T04 FG essentials ok', JSON.stringify(aFg.hard));

const aTrade = completeness.assessProduct(db, pTrade, 'activate');
ok(aTrade.ok === false && aTrade.hard.some(h => h.code === 'E_SPEC_TRADE_FG'), 'T05 trade blocked');

db.prepare('UPDATE products SET unit=? WHERE id=?').run('', pFg);
const aNoUnit = completeness.assessProduct(db, pFg, 'activate');
ok(aNoUnit.ok === false && aNoUnit.hard.some(h => h.code === 'E_SPEC_UNIT'), 'T06 unit required');
db.prepare('UPDATE products SET unit=? WHERE id=?').run('عدد', pFg);

const draft = bom.createBom(db, {
  product_id: pFg,
  name: 'BOM-v421',
  base_qty: 1,
  yield_percent: 100,
  lines: [
    { component_product_id: pRaw, qty_per_base: 1.5, scrap_percent: 0, line_type: 'material' },
    { component_product_id: pZip, qty_per_base: 1, scrap_percent: 0, line_type: 'material' },
  ],
}, adminId);
ok(!!draft.id, 'T07 draft bom');

const readyOk = completeness.assessBom(db, draft.id, 'activate');
ok(readyOk.ok === true, 'T08 bom ready', JSON.stringify(readyOk.hard));

const act = bom.activateBom(db, draft.id, DATE, adminId);
ok(act.ok === true, 'T09 activate ok');

// inherit_fg without colors → hard
const draft2 = bom.createBom(db, {
  product_id: pFg,
  name: 'BOM-v421-inherit',
  base_qty: 1,
  yield_percent: 100,
  lines: [{
    component_product_id: pZip,
    qty_per_base: 1,
    scrap_percent: 0,
    line_type: 'material',
    component_color_mode: 'inherit_fg',
  }],
}, adminId);
const readyInherit = completeness.assessBom(db, draft2.id, 'activate');
ok(readyInherit.ok === false && readyInherit.hard.some(h => h.code === 'E_SPEC_FG_COLOR'),
  'T10 inherit needs FG color', JSON.stringify(readyInherit.hard));

let blocked = false;
try {
  bom.activateBom(db, draft2.id, DATE, adminId);
} catch (e) {
  blocked = String(e.code || e.message).includes('E_SPEC_FG_COLOR')
    || String(e.code || e.message).includes('E_BOM_INCOMPLETE');
}
ok(blocked, 'T11 activate blocked on inherit');

// trade as header — createBom may allow draft; activate must fail
const draftTrade = bom.createBom(db, {
  product_id: pTrade,
  name: 'BOM-trade',
  base_qty: 1,
  lines: [{ component_product_id: pZip, qty_per_base: 1, line_type: 'material' }],
}, adminId);
db.prepare('UPDATE products SET is_manufactured=1 WHERE id=?').run(pTrade); // allow createOrder path later
// Force trade classification by clearing manufactured for assess
db.prepare('UPDATE products SET is_manufactured=0 WHERE id=?').run(pTrade);
const tradeBom = completeness.assessBom(db, draftTrade.id, 'activate');
ok(tradeBom.ok === false && tradeBom.hard.some(h => h.code === 'E_SPEC_TRADE_FG' || h.code === 'E_SPEC_MANUFACTURED'),
  'T12 trade header incomplete', JSON.stringify(tradeBom.hard));

// createOrder requires manufactured + essentials
db.prepare('UPDATE products SET is_manufactured=1, item_type=? WHERE id=?').run('finished', pFg);
try {
  const po = engine.createOrder(db, {
    product_id: pFg,
    bom_id: draft.id,
    qty_planned: 2,
    date: DATE,
    analysis_type: 'fixed',
  }, adminId);
  ok(!!po.id, 'T13 createOrder ok when ready');
} catch (e) {
  ok(false, 'T13 createOrder ok when ready', e.code || e.message);
}

db.prepare('UPDATE products SET unit=? WHERE id=?').run('', pFg);
let orderBlocked = false;
try {
  engine.createOrder(db, {
    product_id: pFg,
    bom_id: draft.id,
    qty_planned: 1,
    date: DATE,
    analysis_type: 'fixed',
  }, adminId);
} catch (e) {
  orderBlocked = String(e.code || e.message).includes('E_SPEC_UNIT')
    || String(e.code || e.message).includes('E_PRODUCT_INCOMPLETE');
}
ok(orderBlocked, 'T14 createOrder blocked without unit');
db.prepare('UPDATE products SET unit=? WHERE id=?').run('عدد', pFg);

cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
