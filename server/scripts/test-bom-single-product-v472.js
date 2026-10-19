'use strict';
/**
 * v472 — BOM تک‌محصولی: UI بدون multi؛ API با E_BOM_SINGLE_PRODUCT.
 * Run: node server/scripts/test-bom-single-product-v472.js
 */
const fs = require('fs');
const path = require('path');
const { ok, eq, summary } = require('./lib/test-harness');

const root = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const bomSrc = fs.readFileSync(path.join(root, 'lib/production/bom.js'), 'utf8');
const advSrc = fs.readFileSync(path.join(root, 'lib/production/bom-advanced.js'), 'utf8');

ok(sw.includes('erp-taranom-v472'), 'SW v472');
ok(!appSrc.includes('id="pb-multi"'), 'create modal has no pb-multi');
ok(!appSrc.includes('id="pb-multi-box"'), 'create modal has no multi box');
ok(!/prodBomCreateAddCo\s*\(/.test(appSrc) || appSrc.includes('async function prodBomAddCoFromHeader'), 'legacy add guarded');
ok(appSrc.includes('هر فرمول فقط'), 'create copy mentions single BOM');
ok(appSrc.includes('E_BOM_SINGLE_PRODUCT') || bomSrc.includes('E_BOM_SINGLE_PRODUCT'), 'error code present');
ok(bomSrc.includes('assertBomSingleMainCreate'), 'create gate');
ok(advSrc.includes('E_BOM_SINGLE_PRODUCT'), 'addOutput/ensureShare gate');
ok(appSrc.includes('v472 / ADR-006'), 'Help mentions v472');

try {
  new Function(appSrc);
  ok('app.js parse', true);
} catch (e) {
  ok('app.js parse', false, e.message);
}

let dbOk = false;
try {
  const { freshDb } = require('./lib/test-harness');
  const { createBom, updateBomHeader } = require('../lib/production/bom');
  const { addOutput, ensureShareOutputs } = require('../lib/production/bom-advanced');
  const ctx = freshDb();
  const { db, cleanup } = ctx;
  try {
    const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();
    const a = db.prepare(`
      INSERT INTO products (user_id, name, code, unit, item_type, is_manufactured)
      VALUES (?, 'A472', 'FG-A472', 'عدد', 'finished', 1)
    `).run(admin.id).lastInsertRowid;
    const b = db.prepare(`
      INSERT INTO products (user_id, name, code, unit, item_type, is_manufactured)
      VALUES (?, 'B472', 'FG-B472', 'عدد', 'finished', 1)
    `).run(admin.id).lastInsertRowid;

    const single = createBom(db, {
      product_id: a, name: 'تک', base_qty: 1, has_coproducts: 0,
      main_outputs: [{ product_id: a, qty_per_base: 1 }],
    }, admin.id);
    ok(!!single.id, 'single create ok');

    let rejected = false;
    try {
      createBom(db, {
        product_id: a, name: 'چند', has_coproducts: 1,
        co_product_ids: [b],
        main_outputs: [
          { product_id: a, qty_per_base: 1 },
          { product_id: b, qty_per_base: 1 },
        ],
      }, admin.id);
    } catch (e) {
      rejected = e.code === 'E_BOM_SINGLE_PRODUCT' || e.message === 'E_BOM_SINGLE_PRODUCT';
    }
    ok(rejected, 'create multi rejected');

    rejected = false;
    try {
      addOutput(db, single.id, { product_id: b, output_type: 'main', qty_per_base: 1 });
    } catch (e) {
      rejected = e.code === 'E_BOM_SINGLE_PRODUCT' || e.message === 'E_BOM_SINGLE_PRODUCT';
    }
    ok(rejected, 'addOutput second main rejected');

    rejected = false;
    try {
      ensureShareOutputs(db, single.id, {
        mainProductId: a, peerProductIds: [b], autoShare: 'sales_value',
      });
    } catch (e) {
      rejected = e.code === 'E_BOM_SINGLE_PRODUCT' || e.message === 'E_BOM_SINGLE_PRODUCT';
    }
    ok(rejected, 'ensureShare new peer rejected');

    rejected = false;
    try {
      updateBomHeader(db, single.id, { has_coproducts: 1, co_product_ids: [b] }, admin.id);
    } catch (e) {
      rejected = e.code === 'E_BOM_SINGLE_PRODUCT' || e.message === 'E_BOM_SINGLE_PRODUCT';
    }
    ok(rejected, 'updateBomHeader add peer rejected');

    // by/scrap هنوز مجاز
    const by = addOutput(db, single.id, {
      product_id: b, output_type: 'by', qty_per_base: 0.1, cost_method: 'nrv', nrv_rial: 1000,
    });
    ok(!!by.id && by.output_type === 'by', 'by-product still allowed');

    dbOk = true;
  } finally {
    cleanup();
  }
} catch (e) {
  if (/bindings|better_sqlite3|NODE_MODULE_VERSION/i.test(String(e.message) + e)) {
    console.log('  SKIP db path: better-sqlite3 not loaded on this Node');
    ok('db path skipped (static still ran)', true);
  } else {
    ok('db path v472', false, e.message + (e.code ? ' ' + e.code : ''));
  }
}
if (dbOk) ok('db single-product path', true);

summary('bom-single-product-v472');
