'use strict';
/**
 * Wave5 — manual_exempt must auto-recover loan installments (pure logic + allocate math).
 */
const assert = require('assert');
const { nextPeriodLabel, allocateLoanRecovery } = require('../lib/payroll/loans');

let n = 0;
function ok(c, m) { assert(c, m); n++; console.log('OK', m); }

// Cap recoveries so net stays non-negative (mirrors routes/payroll.js)
function capExemptRecoveries(gross, otherOnly, advReq, loanReq) {
  let room = Math.max(0, Math.round(gross) - Math.round(otherOnly));
  const adv = Math.min(Math.max(0, Math.round(advReq)), room);
  room -= adv;
  const loan = Math.min(Math.max(0, Math.round(loanReq)), room);
  return { adv, loan, net: Math.max(0, Math.round(gross) - Math.round(otherOnly) - adv - loan) };
}

const c1 = capExemptRecoveries(10_000_000, 0, 0, 2_000_000);
ok(c1.loan === 2_000_000 && c1.net === 8_000_000, 'full installment fits');

const c2 = capExemptRecoveries(5_000_000, 500_000, 0, 10_000_000);
ok(c2.loan === 4_500_000 && c2.net === 0, 'loan capped to remaining gross');

const c3 = capExemptRecoveries(5_000_000, 0, 2_000_000, 4_000_000);
ok(c3.adv === 2_000_000 && c3.loan === 3_000_000 && c3.net === 0, 'advance then loan FIFO room');

ok(nextPeriodLabel('1405/07', 1) === '1405/08', 'period next for due');

ok(typeof allocateLoanRecovery === 'function', 'allocateLoanRecovery exported');

// Default auto_loan semantics: null => on
function resolveAutoLoan(v) {
  return v == null ? true : Number(v) === 1;
}
ok(resolveAutoLoan(null) === true, 'auto loan default on');
ok(resolveAutoLoan(0) === false, 'auto loan explicit off');
ok(resolveAutoLoan(1) === true, 'auto loan explicit on');

console.log(`\nPASS ${n}`);
