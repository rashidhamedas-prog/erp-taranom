/**
 * Standalone test for Farankenou .lwte parser.
 * Usage: node server/scripts/test-farankenou.js [path-to.lwte]
 */
const fs = require('fs');
const path = require('path');
const {
  parseFarankenouBuffer,
  parseDuration,
  calcPayrollFromAttendance
} = require('../lib/farankenou');

const samplePath = process.argv[2] || path.join(__dirname, '..', '..', 'samples', 'farankenou-sample.lwte');

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failed++; }
  else console.log('OK:', msg);
}

// Unit: duration parsing
assert(Math.abs(parseDuration('9.00:50:00') - (9 * 24 + 50 / 60)) < 0.01, '9.00:50:00 → ~216.83h');
assert(Math.abs(parseDuration('04:21:00') - (4 + 21 / 60)) < 0.01, '04:21:00 → 4.35h');
assert(Math.abs(parseDuration('15:31:00') - (15 + 31 / 60)) < 0.01, '15:31:00 → 15.52h');

if (!fs.existsSync(samplePath)) {
  console.log('SKIP file test — sample not at', samplePath);
  console.log('Pass unit tests only.');
  process.exit(failed ? 1 : 0);
}

const buf = fs.readFileSync(samplePath);
const rows = parseFarankenouBuffer(buf);
assert(rows.length > 0, `parsed ${rows.length} rows from sample`);

const mobarebeh = rows.find(r => r.fullName.includes('محبوبه') && r.fullName.includes('قاسمی'));
if (mobarebeh) {
  assert(mobarebeh.periodLabel === '1405/03', 'period 1405/03');
  assert(Math.abs(mobarebeh.regularHours - 216.83) < 0.1, `محبوبه regular ~216.8h (got ${mobarebeh.regularHours})`);
  assert(Math.abs(mobarebeh.overtimeHours - 4.35) < 0.05, `محبوبه OT ~4.35h (got ${mobarebeh.overtimeHours})`);
  const calc = calcPayrollFromAttendance(mobarebeh, { hourly_rate: 100000, overtime_rate: 140000 });
  assert(calc.gross_pay > 0, `gross pay calculated: ${calc.gross_pay}`);
} else {
  console.log('SKIP محبوبه row — not in sample');
}

console.log(failed ? `\n${failed} FAILED` : '\nAll Farankenou tests passed');
process.exit(failed ? 1 : 0);
