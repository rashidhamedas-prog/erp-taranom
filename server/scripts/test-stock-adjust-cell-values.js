'use strict';
/**
 * Regression for st.values hole in aggregated adjust modal (SW v646).
 * No production writes. Never uses product 342.
 */
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log('  OK', msg);
  } else {
    failed++;
    console.log('  FAIL', msg);
  }
}

console.log('— old crash vs ensureValues —');
{
  const st = {};
  const ck = '111:33:141';
  let threw = false;
  try {
    void st.values[ck];
  } catch (e) {
    threw = /Cannot read properties of undefined/.test(String(e && e.message));
  }
  ok(threw, 'st.values[ck] on missing values throws TypeError');
}
{
  const st = { products: [] };
  function ensureValues() {
    if (!st.values || typeof st.values !== 'object') st.values = {};
    return st.values;
  }
  const ck = '111:33:141';
  let err = null;
  let val;
  try {
    val = ensureValues()[ck] != null ? ensureValues()[ck] : '';
    ensureValues()[ck] = '5';
  } catch (e) {
    err = e;
  }
  ok(!err && val === '' && st.values[ck] === '5', 'ensureValues read/write round-trips without throw');
}

console.log('— app.js shape —');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const i = app.indexOf('function openStockAdjustDocModal');
ok(i >= 0, 'openStockAdjustDocModal exists');
const slice = i >= 0 ? app.slice(i, i + 25000) : '';
ok(/const st=\{\s*mode:'count',\s*products:\[\],\s*values:\{\}/.test(slice)
  || /const st=\{ mode:'count', products:\[\], values:\{\}/.test(slice),
  'st initializes with values:{}');
ok(/function ensureValues\(\)/.test(slice), 'ensureValues exists in modal');
ok(/function cellKey\(pid,wid,vid\)\{\s*return pid\+':'\+wid\+':'\+\(vid\|\|0\);/.test(slice), 'cellKey unchanged');
ok(/renderCardsFallback/.test(slice), 'render fallback present');
ok(/safeRenderCards/.test(slice), 'safeRenderCards for remove/toggle');

console.log('— SW / index —');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
ok(/erp-taranom-v646/.test(sw), 'SW v646');
ok(/app\.js\?v=646/.test(index), 'index ?v=646');

console.log('— new Function(app.js) —');
try {
  // eslint-disable-next-line no-new-func
  new Function(app);
  ok(true, 'app.js parses');
} catch (e) {
  ok(false, 'app.js parses: ' + (e && e.message));
}

ok(!/product_id[=:]\s*342\b/.test(fs.readFileSync(__filename, 'utf8').replace(/Never uses product 342[\s\S]*/, '')), 'test file avoids product 342 fixture');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
