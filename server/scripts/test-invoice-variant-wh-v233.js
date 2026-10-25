'use strict';
const { swAtLeast } = require('./lib/sw-at-least');
/**
 * v233: invoice edit — variant modal stock scoped to line warehouse; full matrix; SW bump.
 */
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

console.log('\n══ Invoice variant warehouse v233 ══\n');

const pvRoute = fs.readFileSync(path.join(__dirname, '../routes/product-variants.js'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');

ok(swAtLeast(sw, 233), 'SW v233');
ok(!/erp-taranom-v232/.test(sw.replace(/erp-taranom-v233/g, '')), 'SW no stale v232 const');

ok(pvRoute.includes("router.get('/style/:productId'"), 'style route exists');
ok(
  /router\.get\('\/style\/:productId'[\s\S]{0,2500}variant_warehouse_stock/.test(pvRoute)
    && /router\.get\('\/style\/:productId'[\s\S]{0,2500}req\.query\.warehouse_id/.test(pvRoute),
  'style route uses variant_warehouse_stock + warehouse_id query'
);

ok(appJs.includes('function resolveInvLineWarehouseId'), 'resolveInvLineWarehouseId defined');
ok(
  /async function editInvCartPack[\s\S]{0,800}resolveInvLineWarehouseId/.test(appJs)
    && /async function editInvCartPack[\s\S]{0,800}if\(!whId\)/.test(appJs),
  'editInvCartPack requires warehouse via resolveInvLineWarehouseId'
);
ok(
  /function openInvVariantSplitModal[\s\S]{0,600}pack\.matrix/.test(appJs),
  'openInvVariantSplitModal uses pack.matrix (full matrix)'
);
ok(appJs.includes('data-inv-pack-ix'), 'cart warehouse select has data-inv-pack-ix');

ok(
  appJs.includes('انبار مبدأ') || appJs.includes('موجودی نمایش‌داده‌شده فقط'),
  'Help or modal hints warehouse-scoped stock (Persian)'
);
ok(
  /رنگ\/سایز در فاکتور[\s\S]{0,220}فقط انبار همان ردیف/.test(appJs),
  'Help bullet: edit modal stock per line warehouse'
);

console.log(`\n══ Result: ${pass} pass, ${fail} fail ══\n`);
process.exit(fail ? 1 : 0);
