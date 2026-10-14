'use strict';
/** Static gates for v384 — no better-sqlite3 required */
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; console.log('  OK', msg); }
  else { failed += 1; console.log('  FAIL', msg); }
}

const root = path.join(__dirname, '..');
const cutting = fs.readFileSync(path.join(root, 'lib/production/cutting.js'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'lib/production/engine.js'), 'utf8');
const seed = fs.readFileSync(path.join(root, 'lib/inventory/seed-avg.js'), 'utf8');
const opening = fs.readFileSync(path.join(root, 'lib/opening-post.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

ok(cutting.includes('order_or_fg'), 'cutting scope key');
ok(cutting.includes('l.production_order_id = ?'), 'SQL scopes by PO');
ok(cutting.includes('l.production_order_id IS NULL AND l.product_id = ?'), 'legacy FG match');
ok(!/Cut meters are global for the fabric SKU/.test(cutting), 'removed global-SKU comment');
ok(engine.includes('stock_short'), 'issueTemplate stock_short');
ok(engine.includes('stock_available'), 'issueTemplate stock_available');
ok(engine.includes('getWhQty'), 'uses getWhQty');
ok(seed.includes('skipLedger'), 'seed-avg skipLedger');
ok(seed.includes('kardexCoversStock'), 'kardex cover check');
ok(opening.includes('skipLedger'), 'opening-post skipLedger');
ok(app.includes('همین سفارش/کالای دوخته'), 'UI scoped lock hint');
ok(app.includes('کسری انبار'), 'UI stock short');
ok(/E_NEGATIVE_STOCK:[\s\S]*موجود:/.test(app), 'E_NEGATIVE_STOCK shows موجود');
ok(sw.includes('erp-taranom-v384'), 'SW v384');
ok(html.includes('app.js?v=384'), 'index app v384');
ok(app.includes('v384 قفل پارچه فقط برای همین سفارش'), 'Help v384');

try {
  // eslint-disable-next-line no-new-func
  new Function(app);
  ok(true, 'app.js parses');
} catch (e) {
  ok(false, 'app.js parse: ' + e.message);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
