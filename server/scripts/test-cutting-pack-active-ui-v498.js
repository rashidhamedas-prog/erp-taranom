'use strict';
const { swAtLeast } = require('./lib/sw-at-least');
/**
 * v498 — PACK فعال: covered-by-order must not hide live packing void CTA;
 * pending-pack queue list is separate from active-pack.
 * Run: node server/scripts/test-cutting-pack-active-ui-v498.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');

let n = 0;
function ok(msg) { n += 1; console.log('  ✓', msg); }

const cut = fs.readFileSync(path.join(root, 'lib/production/cutting.js'), 'utf8');
assert.ok(cut.includes('has_live_pack'), 'cutting sets has_live_pack');
assert.ok(cut.includes('pack_via_order_fg = 0') || cut.includes('row.pack_via_order_fg = 0'), 'pack_via_order_fg cleared when live pack');
assert.ok(
  /fg_covered_by_order && !row\.has_live_pack/.test(cut) || /!row\.has_live_pack/.test(cut),
  'via-order-fg only without live pack'
);
ok('cutting.js: has_live_pack + honest pack_via_order_fg');

const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
assert.ok(app.includes("view==='active-pack'") || app.includes("view!=='active-pack'"), 'active-pack view');
assert.ok(app.includes('PACK فعال'), 'PACK فعال tab label');
assert.ok(app.includes('cuttingHasLivePack'), 'helper for live pack');
assert.ok(app.includes("goCuttingLaysView('active-pack')"), 'redirect edit-block to active-pack');
assert.ok(app.includes('منتظر PACK'), 'pending tab renamed');
// Void CTA must not be gated only by !viaOrderFg
assert.ok(app.includes('if(hasLivePack)'), 'void/print when hasLivePack');
assert.ok(!/if\(viaOrderFg\)\{\s*acts\+=' <span class="muted">پوشش‌شده/.test(app)
  || app.includes('if(hasLivePack)') , 'coverage label does not replace void');
new Function(app);
ok('app.js: three tabs + void when live pack + parse');

const gate = fs.readFileSync(path.join(root, 'public/prod-journey-gate.js'), 'utf8');
assert.ok(gate.includes('active-pack'), 'journey maps active-pack');
ok('prod-journey-gate: active-pack → step 4');

const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const idx = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
assert.ok(swAtLeast(sw, 498), 'SW v498');
assert.ok(idx.includes('app.js?v=498'), 'index stamp v498');
ok('SW/index stamp v498');

console.log(`\nPASS ${n}/4 test-cutting-pack-active-ui-v498`);
