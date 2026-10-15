'use strict';
/**
 * Wave4 pure tests — loans installment math (no better-sqlite3).
 */
const assert = require('assert');
const { nextPeriodLabel } = require('../lib/payroll/loans');

let n = 0;
function ok(c, m) { assert(c, m); n++; console.log('OK', m); }

ok(nextPeriodLabel('1405/01', 0) === '1405/01', 'start period');
ok(nextPeriodLabel('1405/01', 1) === '1405/02', '+1 month');
ok(nextPeriodLabel('1405/12', 1) === '1406/01', 'year rollover');
ok(nextPeriodLabel('1405/07', 5) === '1405/12', '+5');
ok(nextPeriodLabel('1405/07', 6) === '1406/01', '+6 across year');

// Simulate equal installment split with remainder on last
function splitPrincipal(principal, count) {
  const base = Math.floor(principal / count);
  const rem = principal - base * count;
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push(base + (i === count - 1 ? rem : 0));
  }
  return rows;
}
const parts = splitPrincipal(1_000_007, 3);
ok(parts.reduce((a, b) => a + b, 0) === 1_000_007, 'installments sum to principal');
ok(parts[0] === parts[1], 'equal first installments');
ok(parts[2] === parts[0] + (1_000_007 % 3), 'remainder on last');

const { buildInsuranceListCsv } = require('../lib/payroll/export-legal');
ok(typeof buildInsuranceListCsv === 'function', 'export insurance fn');

console.log(`\nPASS ${n}`);
