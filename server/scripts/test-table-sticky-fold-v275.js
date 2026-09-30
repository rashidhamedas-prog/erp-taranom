#!/usr/bin/env node
/**
 * Regression: sticky thead must not use topbar offset inside fold/clip cards.
 * Root cause of follow-ups "empty rows + جمع only" mess: overflow:hidden + sticky top:88px.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'public');
const css = fs.readFileSync(path.join(root, 'app.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const idx = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('PASS', msg); }
  else { fail++; console.error('FAIL', msg); }
}

ok(/ADR UI-table-sticky/.test(css), 'CSS documents sticky ADR');
ok(/\.erp-fold\s*,\s*\.fup-folder\s*\{[^}]*overflow:\s*visible/s.test(css)
  || /\.erp-fold,\s*\.fup-folder\{[^}]*overflow:visible/s.test(css),
  'erp-fold/fup-folder use overflow:visible');
ok(/\.erp-fold table\.tbl > thead > tr > th/.test(css)
  && /\.fup-folder table\.tbl > thead > tr > th/.test(css),
  'CSS disables sticky inside erp-fold / fup-folder');
ok(/position:\s*static;\s*top:\s*auto/.test(css), 'fold sticky override is position:static');

ok(/function tblHasClippingAncestor/.test(app), 'JS detects clipping ancestors');
ok(/function tblDisableSticky/.test(app), 'JS can disable sticky');
ok(/tblHasClippingAncestor\(t\)\)\s*tblDisableSticky\(t\)/.test(app), 'enhanceAccTables auto-disables sticky in clip trees');
ok(/fup-folder erp-fold/.test(app), 'follow-up folders use erp-fold');
ok(/tbl-wrap tbl-no-sticky/.test(app), 'folder bodies mark tbl-no-sticky');
ok(!/fup-folder"[^>]*overflow:hidden/.test(app)
  && !/fup-folder`[^`]*overflow:hidden/.test(app),
  'follow-up folder markup no longer sets overflow:hidden');
ok(/wantFooter\s*=\s*dataRows\.length\s*>=\s*2/.test(app), 'footer only for 2+ data rows');
ok(/class="erp-fold"/.test(app), 'voucher/journal cards use erp-fold');

ok(/app\.css\?v=275/.test(idx), 'index cache-bust app.css v275');
ok(/app\.js\?v=275/.test(idx), 'index cache-bust app.js v275');
ok(/erp-taranom-v275/.test(sw), 'SW cache erp-taranom-v275');

try {
  // Syntax smoke: extract is not needed; app.js is a script body
  new Function(app);
  ok(true, 'app.js parses with new Function');
} catch (e) {
  ok(false, 'app.js parse: ' + e.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
