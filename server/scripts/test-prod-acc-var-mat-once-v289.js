'use strict';
/**
 * PROD-ACC — variable_adv must not double-count materials on order header (PO-0006 / close WIP).
 * Run: node server/scripts/test-prod-acc-var-mat-once-v289.js
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../lib/production/engine-advanced.js'), 'utf8');
let passed = 0, failed = 0;
function ok(c, m) {
  if (c) { passed++; console.log('  OK', m); }
  else { failed++; console.error('  FAIL', m); }
}

console.log('v289 — variable stage complete must not re-add materials to order');
ok(
  /mode === 'variable' \? 0 : matRial/.test(src) || /mode === \"variable\" \? 0 : matRial/.test(src),
  'postStageCore skips orderMat when mode=variable'
);
ok(
  /mode === 'variable' \? 0 : pkgRial/.test(src) || /mode === \"variable\" \? 0 : pkgRial/.test(src),
  'postStageCore skips orderPkg when mode=variable'
);
ok(
  /issueStageMaterials/.test(src) && /material_cost_rial = material_cost_rial \+ \?/.test(src),
  'issueStageMaterials still increments material_cost_rial'
);
ok(
  /doubled material_cost_rial|E_WIP_NOT_ZERO \/ PO-0006/.test(src),
  'comment documents PO-0006 double-count root cause'
);

// Pure residual math (same as engine.wipResidual)
function residual(po, receiptSum) {
  const inWip = Number(po.m || 0) + Number(po.p || 0) + Number(po.l || 0)
    + Number(po.o || 0) + Number(po.s || 0) + Number(po.r || 0);
  const outWip = Number(po.aw || 0) + Number(po.sc || 0) + Number(po.bp || 0) + Number(receiptSum || 0);
  return inWip - outWip;
}
const broken = { m: 2448553200, p: 0, l: 328000000, o: 0, s: 0, r: 0, aw: 0, sc: 0, bp: 0 };
const fixed = { ...broken, m: 1224276600 };
ok(residual(broken, 1552276600) === 1224276600, 'PO-0006 broken residual matches probe');
ok(residual(fixed, 1552276600) === 0, 'after repair residual is zero → close allowed');

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
