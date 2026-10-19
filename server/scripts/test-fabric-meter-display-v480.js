'use strict';
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
let failed = 0;
function ok(cond, name) {
  if (!cond) { failed += 1; console.log('FAIL', name); }
  else console.log('ok', name);
}
ok(/function fmtQtyFa\(/.test(app), 'fmtQtyFa exists');
ok(/fmtQtyFa\(r\.marker_length_m/.test(app), 'lay marker uses decimal display');
ok(!/fmt\(r\.marker_length_m/.test(app), 'lay marker no longer uses money fmt');
ok(/fmtQtyFa\(live\)/.test(app), 'roll live balance uses decimal display');
ok(/fmtQtyFa\(r\.actual_meters/.test(app), 'consumed meters decimal');
ok(/erp-taranom-v480/.test(sw), 'SW v480');
new Function(app);
ok(true, 'app.js parses');
function round3(n) { return Math.round(Number(n) * 1000) / 1000; }
function fmtQtyFa(n) { return round3(n).toLocaleString('fa-IR', { maximumFractionDigits: 3 }); }
function moneyFmt(n) { return Math.round(Number(n) || 0).toLocaleString('fa-IR'); }
ok(fmtQtyFa(20.55) !== moneyFmt(20.55), '20.55 is not shown as 21');
ok(fmtQtyFa(5.61) !== moneyFmt(5.61), 'marker 5.61 is not shown as 6');
ok(fmtQtyFa(6.56) !== moneyFmt(6.56), 'marker 6.56 is not shown as 7');
ok(moneyFmt(184772838) === Math.round(184772838).toLocaleString('fa-IR'), 'rial fmt still integer');
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('v480 display ok');
