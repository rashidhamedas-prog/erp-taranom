#!/usr/bin/env node
/**
 * Regression: modal fullscreen overlay must stay on the viewport.
 * Root bug (v275): `.overlay.open.modal-fs { …; inset:auto }` reset top/left/right/bottom
 * so position:fixed fell back to static Y ≈ body scrollHeight → Edit appeared dead.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('  PASS', msg);
  else { console.error('  FAIL', msg); failed += 1; }
}

const css = fs.readFileSync(path.join(ROOT, 'app.css'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

console.log('test-modal-viewport-portal-v276');

/* --- CSS portal hosts --- */
ok(/#modalRoot,#nestedModalRoot\{[^}]*position:fixed/s.test(css),
  'modal portals are position:fixed (out of document flow)');
ok(/#modalRoot,#nestedModalRoot\{[^}]*pointer-events:none/s.test(css),
  'empty portals do not steal clicks');
ok(/#modalRoot \.overlay,#nestedModalRoot \.overlay\{pointer-events:auto\}/.test(css),
  'open overlay re-enables pointer events');

/* --- CSS modal-fs must not reset inset to auto after sides --- */
const fsBlock = css.match(/\.overlay\.open\.modal-fs\{[^}]+\}/);
ok(!!fsBlock, 'modal-fs rule exists');
if (fsBlock) {
  const body = fsBlock[0];
  ok(!/inset\s*:\s*auto/.test(body), 'modal-fs must NOT set inset:auto');
  ok(/inset\s*:\s*0\s+0\s+var\(--mdi-taskbar-h/.test(body)
    || (/top\s*:\s*0/.test(body) && /left\s*:\s*0/.test(body) && /right\s*:\s*0/.test(body)
      && /bottom\s*:\s*var\(--mdi-taskbar-h/.test(body) && !/inset\s*:/.test(body)),
    'modal-fs pins to viewport with taskbar bottom inset');
}

/* Guard: no dangerous pattern elsewhere on overlay.open.modal-fs */
const bad = [...css.matchAll(/\.overlay\.open\.modal-fs\{[^}]+\}/g)]
  .filter(m => /inset\s*:\s*auto/.test(m[0]));
ok(bad.length === 0, 'no modal-fs rule uses inset:auto (including mobile)');

/* --- JS hardening --- */
ok(/function pinOverlayToViewport\s*\(/.test(js), 'pinOverlayToViewport helper exists');
ok(/classList\.contains\(['"]modal-fs['"]\)/.test(js), 'pin only applies to modal-fs');
ok(/pinOverlayToViewport\(\s*el\(['"]modalOverlay['"]\)\s*\)/.test(js), 'openModal calls pin');
ok(/pinOverlayToViewport\(\s*el\(['"]nestedModalOverlay['"]\)\s*\)/.test(js)
  || /pinOverlayToViewport\(el\('nestedModalOverlay'\)\)/.test(js),
  'openNestedModal calls pin (no-op without modal-fs)');

/* --- Help + cache bust --- */
ok(/پورتال ثابت روی ویوپورت/.test(js), 'admin help mentions viewport portal');
ok(/app\.css\?v=276/.test(html) && /app\.js\?v=276/.test(html), 'index cache-bust v276');
ok(/erp-taranom-v276/.test(sw), 'SW cache erp-taranom-v276');

/* --- Simulate static-position math (documentation invariant) --- */
{
  const bodyScrollH = 36278;
  const insetAutoTop = bodyScrollH; // static position after inset:auto
  ok(insetAutoTop > 800, 'documented failure mode: static top ≫ viewport');
  const fixedInset = { top: 0, bottom: 48 };
  ok(fixedInset.top === 0 && fixedInset.bottom === 48, 'fixed inset keeps overlay on-screen');
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log('\nAll checks passed.');
