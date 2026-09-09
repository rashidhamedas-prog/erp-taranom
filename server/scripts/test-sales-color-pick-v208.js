'use strict';
/**
 * Sales color picker for field/inside sales + marketer cart → invoice SKU.
 * Strict static: app.js, marketer-ui, css, sw, index, product-variants GET style.
 *
 * Run: node server/scripts/test-sales-color-pick-v208.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pub = path.join(root, 'public');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

console.log('\n══ Sales color pick v208 ══\n');

const appJs = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
const mk = fs.readFileSync(path.join(pub, 'marketer-ui.js'), 'utf8');
const sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');
const idx = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(pub, 'app.css'), 'utf8');
const pv = fs.readFileSync(path.join(root, 'routes', 'product-variants.js'), 'utf8');

console.log('— parse —');
try { new Function(appJs); ok(true, 'app.js new Function'); }
catch (e) { ok(false, 'app.js new Function', e && e.message); }
try { new Function(mk); ok(true, 'marketer-ui.js new Function'); }
catch (e) { ok(false, 'marketer-ui.js new Function', e && e.message); }

console.log('\n— shared picker —');
ok(appJs.includes("const dest=opts.dest==='marketer'?'marketer':'invoice'"), 'openInvVariantSplitModal dest');
ok(appJs.includes("if(dest==='marketer')"), 'confirmInvVariantSplit marketer dest');
ok(appJs.includes('MarketerUI.addVariantLines'), 'confirm routes to addVariantLines');
ok(appJs.includes('function filterInvVariantColor'), 'color chip filter');
ok(appJs.includes('function bumpInvVarQty'), 'qty +/-');
ok(appJs.includes('window._mkProds'), 'findInvProduct sees marketer catalog');
ok(appJs.includes('function productNeedsColorPick'), 'productNeedsColorPick helper');
ok(appJs.includes('🎨 انتخاب رنگ'), 'catalog card color-pick button');
ok(appJs.includes("helpSec('🛒','فروش بازاریاب'"), 'admin+sales help sections exist');
ok(appJs.includes('کارشناس میدانی، تلفنی و شعب'), 'sales help names field/phone/branch');
ok(appJs.includes('erp-taranom-v209'), 'help mentions SW v209');

console.log('\n— marketer cart —');
ok(mk.includes("dest: 'marketer'"), 'marketer opens picker dest=marketer');
ok(mk.includes('/product-variants/style/'), 'marketer fetches style before add');
ok(mk.includes('function addVariantLines'), 'addVariantLines exported impl');
ok(mk.includes('variant_id: c.variant_id || null'), 'cartToInvoiceRows keeps variant_id');
ok(mk.includes('color_name: c.color_name || c.color || \'\''), 'cartToInvoiceRows color_name');
ok(mk.includes('function editCartProduct'), 'edit color from cart');
ok(mk.includes('تغییر رنگ'), 'cart has تغییر رنگ');
ok(mk.includes("_ver: 'marketer-ui-v209'"), 'marketer version marker v209');

console.log('\n— assets / API —');
ok(css.includes('.inv-var-qty') && css.includes('min-height:44px'), 'touch qty 44px');
ok(css.includes('.var-chip-btn'), 'clickable color chips');
ok(sw.includes("const CACHE = 'erp-taranom-v209'"), 'SW cache v209');
ok(idx.includes('marketer-ui.js?v=209'), 'index marketer-ui v209');
ok(idx.includes('app.css?v=209'), 'index css v209');
ok(idx.includes('app.js?v=209'), 'index app.js v209');
ok(/router\.get\('\/style\/:productId',\s*auth,/.test(pv), 'GET style is auth (sales can read)');
ok(!/router\.get\('\/style\/:productId',\s*adminOrAccounting/.test(pv), 'GET style not admin-only');

console.log('\n══ ' + pass + ' passed, ' + fail + ' failed ══\n');
process.exit(fail ? 1 : 0);
