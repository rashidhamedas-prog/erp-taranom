const { swAtLeast } = require('./lib/sw-at-least');
#!/usr/bin/env node
/**
 * RETURNS P2-UX — static gates for professional returns UI (color×size + COGS preview).
 * Run: node server/scripts/test-returns-p2-ux-v340.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  OK', name); }
  else { failed++; console.log(' FAIL', name, extra != null ? String(extra).slice(0, 120) : ''); }
}

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
const idx = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const purchases = fs.readFileSync(path.join(root, 'routes', 'purchases.js'), 'utf8');

console.log('-- returns P2-UX static --');

ok(swAtLeast(sw, 340), 'SW cache v340');
ok(idx.includes('app.js?v=340'), 'index.html app.js?v=340');

ok(app.includes("dest==='sales_return'") || app.includes("destRaw==='sales_return'"), 'variant modal dest sales_return');
ok(app.includes("dest==='purchase_return'") || app.includes("destRaw==='purchase_return'"), 'variant modal dest purchase_return');
ok(app.includes('function returnUnitCostEstimate'), 'returnUnitCostEstimate helper');
ok(app.includes('function updateReturnPreview'), 'updateReturnPreview helper');
ok(app.includes('id="srPreview"') && app.includes('id="prPreview"'), 'preview bars in modal foot');
ok(app.includes('openReturnProductPick'), 'openReturnProductPick matrix entry');
ok(app.includes('<th>رنگ</th>') && app.includes('loadSrReturnRows'), 'sales linked color column');
ok(app.includes('returnLinkedCostHead'), 'cost column head helper');
ok(app.includes('برآورد بهای تمام‌شده') || app.includes('برآورد بهای تمام'), 'COGS preview label');
ok(app.includes('variant_id:r.variant_id') || app.includes('variant_id:r.variant_id||null'), 'open save sends variant_id');

ok(/variant_id:\s*r\.variant_id\s*\?\s*parseInt/.test(purchases), 'purchases buildRows persists variant_id');
ok(purchases.includes('size_name: String(r.size_name') || purchases.includes("size_name: String(r.size_name"), 'purchases buildRows size_name');
ok(purchases.includes('color_name: origLine.color_name') || purchases.includes("color_name: origLine.color_name"), 'linked PR color_name on post');

try {
  // eslint-disable-next-line no-new-func
  new Function(app);
  ok(true, 'app.js parses with new Function()');
} catch (e) {
  ok(false, 'app.js parses with new Function()', e && e.message);
}

ok(app.includes('رنگ×سایز') || app.includes('افزودن / ماتریس'), 'Help/UI mentions matrix add');

console.log('\n' + passed + ' passed,', failed + ' failed');
process.exit(failed ? 1 : 0);
