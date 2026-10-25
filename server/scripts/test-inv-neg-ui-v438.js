'use strict';
const { swAtLeast } = require('./lib/sw-at-least');
/**
 * v438 — invoice/catalog UI respects warehouse allow_negative for zero-stock pack add.
 */
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log('  FAIL', label, detail != null ? detail : ''); }
}

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const mk = fs.readFileSync(path.join(root, 'public/marketer-ui.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

console.log('\n══ v438 invoice negative-stock UI gates ══\n');

ok(/function clientAllowsNegativeStock\s*\(/.test(app), 'clientAllowsNegativeStock helper');
ok(/function livePackRowsForSale\s*\(/.test(app), 'livePackRowsForSale helper');
ok(/allow_negative/.test(app) && /inventory_allow_negative/.test(app),
  'helper reads WH flag + global setting');

ok(/livePackRowsForSale\(pack,\s*whId\)/.test(app)
  || /applyAutoLivePack[\s\S]{0,400}livePackRowsForSale/.test(app),
  'applyAutoLivePack uses livePackRowsForSale');
ok(/applyAutoLivePack\(p,\s*pack,\s*'invoice',\s*whId\)/.test(app),
  'addToCart passes warehouseId into applyAutoLivePack');

ok(/clientAllowsNegativeStock\(opts\.warehouseFilter/.test(app),
  'productCardHtml enables Add when WH allow_negative');
ok(/data-allow-neg="\$\{allowNegPick\?1:0\}"/.test(app)
  || /data-allow-neg="\$\{allowNegPick \? 1 : 0\}"/.test(app),
  'variant qty inputs carry data-allow-neg');
ok(/!allowNeg && Number\.isFinite\(stock\)/.test(app)
  || /if\(!allowNeg && Number\.isFinite\(stock\)/.test(app),
  'bumpInvVarQty skips stock cap when allow-neg');

ok(/livePackRowsForSale\(pack,\s*whId\)/.test(app), 'genCartAdd uses livePackRowsForSale');
ok(/livePackRowsForSale\(pack,\s*wh\)/.test(app), 'whPickProduct / csPick use livePackRowsForSale');

ok(/applyAutoLivePack\(p,\s*pack,\s*'marketer',\s*wh\)/.test(mk),
  'MarketerUI passes warehouse to applyAutoLivePack');
ok(/clientAllowsNegativeStock\(wh\)/.test(mk), 'MarketerUI.addToCart respects allow_neg');
ok(/allowNegative|clientAllowsNegativeStock\(salesWarehouseId\(\)\)/.test(mk),
  'MarketerUI variant/qty caps respect allow_neg');

ok(app.includes('اجازه موجودی منفی') && app.includes('موجودی رنگ/سایز صفر باشد'),
  'Help mentions allow_negative pack add');
ok(swAtLeast(sw, 438), 'SW v438');
ok(/app\.js\?v=438/.test(index), 'index app.js bust v438');
ok(/marketer-ui\.js\?v=438/.test(index), 'index marketer-ui bust v438');

console.log(`\n══ Result: ${pass} pass, ${fail} fail ══\n`);
process.exit(fail ? 1 : 0);
