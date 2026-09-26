'use strict';

const assert = require('assert');
const {
  exceedsWorkArea,
  workAreaBounds,
  clampWindowToWorkArea
} = require('../work-area');

const wa = { x: 0, y: 0, width: 1920, height: 1040 };

assert.strictEqual(exceedsWorkArea({ x: 0, y: 0, width: 1920, height: 1040 }, wa), false);
assert.strictEqual(exceedsWorkArea({ x: 0, y: 0, width: 1920, height: 1080 }, wa), true, 'taller than work area');
assert.strictEqual(exceedsWorkArea({ x: 0, y: -8, width: 1920, height: 1040 }, wa), true, 'above work area');
assert.deepStrictEqual(workAreaBounds(wa), { x: 0, y: 0, width: 1920, height: 1040 });

let unmaximizeCalls = 0;
let setBoundsArg = null;
const fakeWin = {
  isDestroyed: () => false,
  isMaximized: () => true,
  isFullScreen: () => false,
  getBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
  unmaximize: () => { unmaximizeCalls += 1; },
  setFullScreen: () => {},
  setBounds: b => { setBoundsArg = b; }
};
const fakeScreen = {
  getDisplayMatching: () => ({ workArea: wa })
};

const prevPlatform = process.platform;
Object.defineProperty(process, 'platform', { value: 'win32' });
try {
  assert.strictEqual(clampWindowToWorkArea(fakeWin, fakeScreen), true);
  assert.strictEqual(unmaximizeCalls, 1);
  assert.deepStrictEqual(setBoundsArg, workAreaBounds(wa));
} finally {
  Object.defineProperty(process, 'platform', { value: prevPlatform });
}

console.log('desktop work-area: 6/6 pass');
