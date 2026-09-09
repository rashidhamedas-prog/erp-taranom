'use strict';
/**
 * Pure-logic assert for PR-20 material-usage SQL (no better-sqlite3 needed).
 * Root cause was SUM(mi.qty) — column does not exist; schema has qty_actual.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../lib/production/reports.js'), 'utf8');
const m = src.match(/function materialUsage\([\s\S]*?\n\}/);
if (!m) {
  console.error('FAIL: materialUsage() not found');
  process.exit(1);
}
const body = m[0];
const sqlBlob = (body.match(/db\.prepare\(`([\s\S]*?)`\)/) || [])[1] || '';
const bad = /SUM\s*\(\s*mi\.qty\s*\)/i.test(sqlBlob);
const good = /SUM\s*\(\s*mi\.qty_actual\s*\)/i.test(sqlBlob);
const posted = /status[\s\S]*posted/i.test(body);

let failed = 0;
function check(name, cond) {
  if (cond) console.log('  ✓', name);
  else { console.log('  ✗', name); failed += 1; }
}

console.log('\n══ material-usage SQL (pure) ══\n');
check('no SUM(mi.qty)', !bad);
check('uses SUM(mi.qty_actual)', good);
check('filters posted status', posted);
check('defaults period via resolvePeriod', /resolvePeriod\(period\)/.test(body));
check('invalid period still via resolvePeriod (E_INVALID_PERIOD in module)', /function resolvePeriod[\s\S]*E_INVALID_PERIOD/.test(src));

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll assertions passed.\n');
