/**
 * Barcode input helpers — run: node scripts/test-barcode-input.js
 */
const {
  normalizeBarcode,
  shouldAcceptScan,
  feedWedgeKey,
  createWedgeState,
  isWedgeTypingTarget,
  DEFAULT_DEBOUNCE_MS,
} = require('../lib/barcode-input');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('\n— 1) normalizeBarcode —');
check('trims whitespace', normalizeBarcode('  200123  ') === '200123');
check('strips newlines', normalizeBarcode('200123\r\n') === '200123');
check('empty → empty', normalizeBarcode('') === '');

console.log('\n— 2) debounce —');
const t0 = 1000;
check('first scan accepted', shouldAcceptScan(0, t0));
check('rapid rescan rejected', !shouldAcceptScan(t0, t0 + 100, DEFAULT_DEBOUNCE_MS));
check('scan after debounce accepted', shouldAcceptScan(t0, t0 + DEFAULT_DEBOUNCE_MS, DEFAULT_DEBOUNCE_MS));

console.log('\n— 3) wedge buffer —');
let st = createWedgeState();
let r = feedWedgeKey(st, '2', 100);
st = r.state;
r = feedWedgeKey(st, '0', 120);
st = r.state;
r = feedWedgeKey(st, '0', 140);
st = r.state;
r = feedWedgeKey(st, 'Enter', 160);
check('wedge builds code on Enter', r.code === '200');

st = createWedgeState();
feedWedgeKey(st, 'A', 100);
r = feedWedgeKey(st, 'B', 500);
check('gap resets buffer', r.state.chars === 'B');

st = createWedgeState();
r = feedWedgeKey(st, '12', 100);
r = feedWedgeKey(r.state, 'Enter', 110);
check('too short rejected', r.code === null);

console.log('\n— 4) typing target guard —');
check('textarea is typing target', isWedgeTypingTarget({ tagName: 'TEXTAREA' }));
check('text input is typing target', isWedgeTypingTarget({ tagName: 'INPUT', type: 'text' }));
check('button input is not typing target', !isWedgeTypingTarget({ tagName: 'INPUT', type: 'button' }));

console.log(`\n${fail ? '💥' : '🎉'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
