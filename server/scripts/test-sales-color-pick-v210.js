'use strict';
/**
 * Sales color pick v210 — catalog bar + live has_variants + color-first UX.
 * Run: node server/scripts/test-sales-color-pick-v210.js
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const pub = path.join(root, 'public');
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}
console.log('\n══ Sales color pick v210 ══\n');
const appJs = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
const mk = fs.readFileSync(path.join(pub, 'marketer-ui.js'), 'utf8');
const sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');
const idx = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(pub, 'app.css'), 'utf8');
const products = fs.readFileSync(path.join(root, 'routes', 'products.js'), 'utf8');
const svc = fs.readFileSync(path.join(root, 'lib', 'product-variants', 'service.js'), 'utf8');
try { new Function(appJs); ok(true, 'app.js parse'); } catch (e) { ok(false, 'app.js parse', e.message); }
try { new Function(mk); ok(true, 'marketer-ui parse'); } catch (e) { ok(false, 'marketer-ui parse', e.message); }
ok(svc.includes('function attachVariantFlags'), 'attachVariantFlags in service');
ok(products.includes('attachVariantFlags(db, rows)'), 'list stamps variant flags');
ok(products.includes('attachVariantFlags(db, row)'), 'detail stamps variant flags');
ok(appJs.includes('function catalogAddToCart'), 'catalogAddToCart');
ok(appJs.includes("addToCartFn: salesCatalog ? 'catalogAddToCart'"), 'catalog cards get addToCart');
ok(appJs.includes('id="catalogSalesBar"'), 'catalog sales bar HTML');
ok(appJs.includes('Number(p.variant_sku_count)>0'), 'needsColor uses variant_sku_count');
{
  const m = appJs.match(/function productNeedsColorPick\(p\)\{[\s\S]*?\n\}/);
  const body = m ? m[0] : '';
  ok(body.length > 0, 'productNeedsColorPick extracted');
  ok(!body.includes('is_style'), 'needsColor ignores bare is_style');
}
ok(appJs.includes('۱) رنگ'), 'color-first hint');
ok(appJs.includes('filterInvVariantColor(firstColor)'), 'default first color filter');
ok(appJs.includes('pick-color-btn'), 'invoice pick color button');
ok(mk.includes('window.__mkOpenTab'), 'marketer opens tab from catalog');
ok(mk.includes('notifySalesCartChanged'), 'cart notifies catalog bar');
ok(mk.includes("_ver: 'marketer-ui-v211'"), 'marketer v211');
ok(css.includes('.catalog-sales-bar'), 'css catalog bar');
ok(sw.includes('erp-taranom-v211'), 'SW v211');
ok(idx.includes('app.js?v=211'), 'index app v211');
ok(appJs.includes('erp-taranom-v211'), 'help SW v211');
ok(appJs.includes('کاتالوگ'), 'admin help mentions catalog');
console.log('\n══ ' + pass + ' passed, ' + fail + ' failed ══\n');
process.exit(fail ? 1 : 0);
