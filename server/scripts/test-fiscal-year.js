// Fiscal year rollover math — lightweight unit tests (v1.0.11)
const assert = require('assert');

function retainedFromLines(lines) {
  let net = 0;
  for (const l of lines) net += (l.credit || 0) - (l.debit || 0);
  return net;
}

function openingLines(retained) {
  if (Math.abs(retained) < 0.01) return [];
  if (retained > 0) {
    return [
      { code: '3101', debit: 0, credit: retained },
      { code: '3201', debit: retained, credit: 0 },
    ];
  }
  return [
    { code: '3101', debit: Math.abs(retained), credit: 0 },
    { code: '3201', debit: 0, credit: Math.abs(retained) },
  ];
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✅', name); }
  catch (e) { console.error('  ❌', name, e.message); process.exitCode = 1; }
}

console.log('test-fiscal-year.js');
test('positive retained earnings', () => {
  const lines = openingLines(5000000);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].credit, 5000000);
  assert.strictEqual(lines[1].debit, 5000000);
});
test('negative retained (loss)', () => {
  const lines = openingLines(-1200000);
  assert.strictEqual(lines[0].debit, 1200000);
});
test('zero retained — no lines', () => {
  assert.strictEqual(openingLines(0).length, 0);
});
test('equity net from P&L lines', () => {
  const pl = [
    { code: '4101', debit: 0, credit: 10000000 },
    { code: '5101', debit: 6000000, credit: 0 },
  ];
  assert.strictEqual(retainedFromLines(pl), 4000000);
});

console.log(`\n${passed}/4 passed`);
if (process.exitCode) process.exit(1);
