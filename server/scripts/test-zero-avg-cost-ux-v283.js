'use strict';
/**
 * v283 — E_ZERO_AVG_COST UX + R11-safe avg_cost_ok on issue templates
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok( Cond, msg) {
  if (Cond) { pass++; console.log('OK  ', msg); }
  else { fail++; console.error('FAIL', msg); }
}

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const swJs = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const engAdv = fs.readFileSync(path.join(root, 'lib/production/engine-advanced.js'), 'utf8');
const eng = fs.readFileSync(path.join(root, 'lib/production/engine.js'), 'utf8');
const access = require('../lib/production/access');

ok(/E_ZERO_AVG_COST:\s*pname/.test(appJs), 'prodFriendly maps E_ZERO_AVG_COST with product name');
ok(/بهای میانگین «'\+pname\+'» صفر است/.test(appJs) || /بهای میانگین «'\s*\+\s*pname\s*\+\s*'» صفر است/.test(appJs),
  'friendly message includes product name');
ok(/const err=new Error\(friendlyMsg\)/.test(appJs), 'api Error.message uses friendlyMsg');
function sliceFn(src, name) {
  const start = src.indexOf('async function ' + name);
  if (start < 0) return '';
  const next = src.indexOf('\nasync function ', start + 10);
  return next < 0 ? src.slice(start) : src.slice(start, next);
}
const stageSave = sliceFn(appJs, 'prodStageIssueSave');
const orderSave = sliceFn(appJs, 'prodOrderIssueSave');
ok(/catch\(e\)\{\s*\/\*/.test(stageSave) && !/catch\(e\)\{\s*showToast\(e\.message/.test(stageSave),
  'stage issue save does not double-toast');
ok(/catch\(e\)\{\s*\/\*/.test(orderSave) && !/catch\(e\)\{\s*showToast\(e\.message/.test(orderSave),
  'order issue save does not double-toast');
ok(/avg_cost_ok/.test(engAdv) && /avg_cost_ok/.test(eng), 'issue templates expose avg_cost_ok');
ok(/L\.avg_cost_ok\s*!=\s*null/.test(appJs), 'UI prefers avg_cost_ok over stripped average_cost_rial');
ok(/erp-taranom-v283/.test(swJs), 'SW cache bumped to v283');
ok(/بهای میانگین صفر \(v283\)/.test(appJs), 'admin help mentions v283 zero-avg');
ok((appJs.match(/بهای میانگین صفر \(v283\)/g) || []).length === 1, 'help bullet not duplicated');

const sample = {
  lines: [{
    product_id: 1,
    name: 'پارچه',
    average_cost_rial: 0,
    avg_cost_ok: 0,
    std_cost_rial: 1000,
  }],
};
const stripped = access.stripCostFields(sample);
ok(stripped.lines[0].avg_cost_ok === 0, 'stripCostFields keeps avg_cost_ok');
ok(stripped.lines[0].average_cost_rial === undefined, 'stripCostFields removes average_cost_rial');
ok(stripped.lines[0].std_cost_rial === undefined, 'stripCostFields removes std_cost_rial');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
