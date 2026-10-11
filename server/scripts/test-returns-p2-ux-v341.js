#!/usr/bin/env node
/**
 * RETURNS P2-UX v341 — open return product search uses full catalog.
 * Run: node server/scripts/test-returns-p2-ux-v341.js
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

console.log('-- returns P2-UX v341 (open catalog) --');

ok(/erp-taranom-v34[12]/.test(sw), 'SW cache v341|v342');
ok(/app\.js\?v=34[12]/.test(idx), 'index.html app.js?v=341|v342');

ok(/async function ensureReturnProductsCache\(\)\{\s*return ensureProductsCache\(\);/.test(app),
  'ensureReturnProductsCache delegates to ensureProductsCache');
ok(app.includes("productSelect('sr-open-prod','',prods)"), 'renderSrOpenPanel passes explicit prods');
ok(app.includes("productSelect('pr-open-prod','',prods)"), 'renderPrOpenPanel passes explicit prods');
ok(app.includes('CACHE.allProducts||CACHE.products||[]') && app.includes('openReturnProductPick'),
  'openReturnProductPick uses full catalog cache');

ok(app.includes("dest==='sales_return'") || app.includes("destRaw==='sales_return'"), 'variant modal dest sales_return');
ok(app.includes("dest==='purchase_return'") || app.includes("destRaw==='purchase_return'"), 'variant modal dest purchase_return');
ok(app.includes('function returnUnitCostEstimate'), 'returnUnitCostEstimate helper');
ok(app.includes('function updateReturnPreview'), 'updateReturnPreview helper');
ok(app.includes('id="srPreview"') && app.includes('id="prPreview"'), 'preview bars in modal foot');
ok(app.includes('openReturnProductPick'), 'openReturnProductPick matrix entry');
ok(app.includes('<th>رنگ</th>') && app.includes('loadSrReturnRows'), 'sales linked color column');
ok(app.includes('returnLinkedCostHead'), 'cost column head helper');
ok(app.includes('برآورد بهای تمام‌شده') || app.includes('برآورد بهای تمام'), 'COGS preview label');
ok(app.includes('کاتالوگ کامل'), 'Help mentions full catalog search');

ok(/variant_id:\s*r\.variant_id\s*\?\s*parseInt/.test(purchases), 'purchases buildRows persists variant_id');

try {
  // eslint-disable-next-line no-new-func
  new Function(app);
  ok(true, 'app.js parses with new Function()');
} catch (e) {
  ok(false, 'app.js parses with new Function()', e && e.message);
}

console.log('\n' + passed + ' passed,', failed + ' failed');
process.exit(failed ? 1 : 0);
