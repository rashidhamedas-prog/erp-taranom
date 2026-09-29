'use strict';
/**
 * Static + pure checks for production variant root (v261).
 * Full DB integration: test-production-variant-bom-v261.js (needs better-sqlite3 native).
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
let n = 0;
function ok(msg) { n++; console.log('  ✓', msg); }

const bomSrc = fs.readFileSync(path.join(root, 'lib/production/bom.js'), 'utf8');
assert.ok(bomSrc.includes('buildComponentVariantHint'));
assert.ok(bomSrc.includes('validateSizeMatrixKeys'));
assert.ok(bomSrc.includes('component_color_mode'));
assert.ok(bomSrc.includes('color_variant'));
assert.ok(/createAlternative[\s\S]*color_variant[\s\S]*color_id/.test(bomSrc));
ok('bom.js has variant helpers + createAlternative color copy');

const schemaSrc = fs.readFileSync(path.join(root, 'lib/production/schema.js'), 'utf8');
assert.ok(schemaSrc.includes("variant_lines_json"));
assert.ok(schemaSrc.includes('component_color_mode'));
assert.ok(schemaSrc.includes("bom_headers', 'color_id"));
ok('schema ensureColumns for variant JSON + BOM color');

const engineSrc = fs.readFileSync(path.join(root, 'lib/production/engine.js'), 'utf8');
assert.ok(engineSrc.includes('E_VARIANT_REQUIRED'));
assert.ok(engineSrc.includes('saveDocVariantLines'));
assert.ok(engineSrc.includes('color: po.color'));
ok('engine.js PO matrix gate + color on explode + persist');

const cuttingSrc = fs.readFileSync(path.join(root, 'lib/production/cutting.js'), 'utf8');
assert.ok(cuttingSrc.includes("docType: 'cutting_pack'"));
assert.ok(cuttingSrc.includes('resolveApparelLines'));
assert.ok(cuttingSrc.includes('variant_id'));
ok('cutting pack posts apparel layer + stores variant_id');

const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
assert.ok(appSrc.includes('prodBomOpenSizeMatrix'));
assert.ok(appSrc.includes('pbe-size-matrix'));
assert.ok(appSrc.includes('po-variant-panel'));
assert.ok(appSrc.includes('prodOrderLoadVariantPanel'));
assert.ok(appSrc.includes('component_color_mode'));
ok('app.js BOM matrix modal + PO color×size panel');

// Parse check — mirror project rule for frontend script
try {
  // eslint-disable-next-line no-new-func
  new Function(appSrc);
  ok('app.js parses with new Function()');
} catch (e) {
  console.error('PARSE FAIL', e.message);
  process.exit(1);
}

console.log(`\nPASS ${n}/6 test-production-variant-static-v261`);
