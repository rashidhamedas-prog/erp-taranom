'use strict';
/**
 * PROD-ACC PA-02 — F02 Jalali period end + F03 allocation line builder
 * Run: node server/scripts/test-prod-acc-f02-f03-v278.js
 */
const assert = require('assert');
const path = require('path');

const { periodEndJalali, daysInJalaliMonth, isJalaliLeapYear } = require('../jalali');
const { buildAllocationLines, dr, cr } = require('../lib/production/posting');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  OK', msg); }
  else { failed++; console.error('  FAIL', msg); }
}

// Stub acct() via fake db — buildAllocationLines calls dr/cr which need acct.
// We monkey-patch by injecting a fake that returns codes from keys.
const coaMap = require('../lib/coa-map');
const origAcct = coaMap.acct;
coaMap.acct = (_db, key) => ({ code: key, name: key });

const fakeDb = {};

console.log('F02 — Jalali period ends');
const expectEnds = {
  '1405/01': '1405/01/31',
  '1405/02': '1405/02/31',
  '1405/03': '1405/03/31',
  '1405/04': '1405/04/31',
  '1405/05': '1405/05/31',
  '1405/06': '1405/06/31',
  '1405/07': '1405/07/30',
  '1405/08': '1405/08/30',
  '1405/09': '1405/09/30',
  '1405/10': '1405/10/30',
  '1405/11': '1405/11/30',
};
for (const [p, e] of Object.entries(expectEnds)) {
  ok(periodEndJalali(p) === e, `${p} → ${e} (got ${periodEndJalali(p)})`);
}
// Esfand: assert known leap/common years, not only a self-derived expectation.
ok(isJalaliLeapYear(1403) === true, '1403 is a known Jalali leap year');
ok(daysInJalaliMonth(1403, 12) === 30, '1403/12 has 30 days');
ok(periodEndJalali('1403/12') === '1403/12/30', 'leap Esfand ends on day 30');
ok(isJalaliLeapYear(1404) === false, '1404 is a common Jalali year');
ok(daysInJalaliMonth(1404, 12) === 29, '1404/12 has 29 days');
ok(periodEndJalali('1404/12') === '1404/12/29', 'common Esfand ends on day 29');
ok(daysInJalaliMonth(1405, 12) === (isJalaliLeapYear(1405) ? 30 : 29), '1405/12 leap-aware');
ok(periodEndJalali('1405/12') === `1405/12/${String(daysInJalaliMonth(1405, 12)).padStart(2, '0')}`, '1405/12 end');
ok(periodEndJalali('1405/02') !== '1405/02/29', 'F02 regression: Ordibehesht is not 29');

console.log('F03 — allocation lines balanced');
function sumDC(lines) {
  let d = 0, c = 0;
  for (const l of lines) {
    d += Number(l.debit) || 0;
    c += Number(l.credit) || 0;
  }
  return { d, c, bal: Math.abs(d - c) < 1e-9 };
}

// Case A: labor +100, OH -100, dest 0 → still posts balanced Cr/Dr variance
{
  const lines = buildAllocationLines(fakeDb, {
    total: { total_rial: 0, wip_rial: 0, fg_rial: 0, cogs_rial: 0 },
    labor: { total_rial: 100 },
    overhead: { total_rial: -100 },
  });
  ok(lines.length === 2, 'net-zero components still emit 2 lines');
  const s = sumDC(lines);
  ok(s.bal, `net-zero balanced d=${s.d} c=${s.c}`);
}

// Case B: labor +100, OH -200, cogs -100 → balanced 200/200
{
  const lines = buildAllocationLines(fakeDb, {
    total: { total_rial: -100, wip_rial: 0, fg_rial: 0, cogs_rial: -100 },
    labor: { total_rial: 100 },
    overhead: { total_rial: -200 },
  });
  const s = sumDC(lines);
  ok(s.bal, `mixed-sign balanced d=${s.d} c=${s.c}`);
  ok(Math.round(s.d * 10) === 200 && Math.round(s.c * 10) === 200, 'mixed-sign amounts 200/200 rial-as-toman*10');
}

// Case C: all positive
{
  const lines = buildAllocationLines(fakeDb, {
    total: { total_rial: 100, wip_rial: 30, fg_rial: 40, cogs_rial: 30 },
    labor: { total_rial: 50 },
    overhead: { total_rial: 50 },
  });
  const s = sumDC(lines);
  ok(s.bal && lines.length === 5, 'all-positive 5 lines balanced');
}

// Case D: empty
ok(buildAllocationLines(fakeDb, {}).length === 0, 'empty → no lines');

coaMap.acct = origAcct;

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
