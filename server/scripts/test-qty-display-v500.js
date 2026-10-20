'use strict';
/**
 * v500 — report quantities keep 3 decimals; rial fmt still rounds.
 * Run: node server/scripts/test-qty-display-v500.js
 */
const fs = require('fs');
const path = require('path');
const appPath = path.join(__dirname, '..', 'public', 'app.js');
const app = fs.readFileSync(appPath, 'utf8');
let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('  ok', msg);
  else { failed++; console.error('  FAIL', msg); }
}

const start = app.indexOf('function toDisplayAmount');
const end = app.indexOf('function fmtPieceQty');
ok(start > 0 && end > start, 'formatter slice exists');
const api = new Function(app.slice(start, end) + '\nreturn {fmt, fmtQtyFa, fmtQtyOrDash};')();

ok(api.fmt(1.6) === api.fmt(2), 'rial fmt rounds 1.6 to 2');
ok(api.fmtQtyFa(1.6) !== api.fmt(1.6), 'qty 1.6 is not the rial rounding');
ok(api.fmtQtyFa(0.4) !== api.fmt(0), '0.4 yards is not shown as zero rial');
ok(api.fmtQtyFa(10) === api.fmt(10), 'whole piece qty still looks like an integer');
ok(api.fmtQtyOrDash(0) === '-', 'true zero in/out is a dash');
ok(api.fmtQtyOrDash(0.0004) === '-', 'below half a thousandth stays empty');
ok(api.fmtQtyOrDash(0.4) === api.fmtQtyFa(0.4), '0.4 in/out cell keeps the fraction');
ok(api.fmt(4030094) === api.fmtQtyFa(4030094), 'whole rial amount is unchanged by qty formatter');

const kxStart = app.indexOf('async function loadItemKardex');
const kxEnd = app.indexOf('let _sharedLedgerPrefill');
const kx = app.slice(kxStart, kxEnd);
ok(kx.includes('fmtQtyOrDash(qIn)') && kx.includes('fmtQtyOrDash(qOut)'), 'kardex in/out uses qty formatter');
ok(kx.includes('fmtQtyFa(l.running_balance'), 'kardex balance keeps decimals');
ok(kx.includes('fmtQtyFa(d.period_qty_in') && kx.includes('fmtQtyFa(d.closing_qty'), 'kardex totals keep decimals');
ok(kx.includes('fmt(l.unit_cost_rial') && kx.includes('fmt(l.amount_rial'), 'kardex money stays integer rial');
ok(!kx.includes('fmt(qIn)') && !kx.includes('fmt(d.period_qty_in'), 'kardex qty no longer uses money fmt');
ok(app.includes('کاردکس کالا (v500)'), 'admin help mentions decimal kardex');

new Function(app);
ok(true, 'app.js parses');

console.log(failed ? '\n' + failed + ' failed' : '\nall passed');
process.exit(failed ? 1 : 0);
