#!/usr/bin/env node
/**
 * Regression: master product catalog must not be overwritten by filtered UI rows;
 * customer picker hydrate path must exist (ensureCustomersCache called from fup/inv).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
let failed = 0;
function ok(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failed++; }
  else console.log('OK:', msg);
}

ok(appJs.includes('function setFullProductsCatalog'), 'setFullProductsCatalog helper exists');
ok(appJs.includes('CACHE._allProductsIsFull'), '_allProductsIsFull flag used');
ok(/if\s*\(\s*writeMaster\s*\)\s*setFullProductsCatalog\(rows\)/.test(appJs), 'acc products only writes master when unfiltered');
ok(!/CACHE\.allProducts\s*=\s*rows/.test(appJs), 'no raw CACHE.allProducts=rows assignment');
ok(/async function fupModal/.test(appJs) && /fupModal[\s\S]{0,400}await ensureCustomersCache/.test(appJs), 'fupModal awaits ensureCustomersCache');
ok(/_openInvBuilder[\s\S]{0,300}await ensureCustomersCache/.test(appJs), '_openInvBuilder awaits ensureCustomersCache');
ok(/ensureProductsCache[\s\S]{0,500}_allProductsIsFull/.test(appJs), 'ensureProductsCache trusts only full catalog');
ok(/willAssignAllProducts:writeMaster/.test(appJs), 'post-fix instrumentation marks writeMaster');

if (failed) process.exit(1);
console.log('All cache-scope invariants OK');
