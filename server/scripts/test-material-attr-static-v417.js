const { swAtLeast } = require('./lib/sw-at-least');
/**
 * Static checks for v417 material/attr receipt (no better-sqlite3 needed).
 * Run: node server/scripts/test-material-attr-static-v417.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label); }
}

const root = path.join(__dirname, '..');
const fr = fs.readFileSync(path.join(root, 'lib/inventory/fabric-rolls.js'), 'utf8');
const bs = fs.readFileSync(path.join(root, 'lib/inventory/batch-serial.js'), 'utf8');
const cut = fs.readFileSync(path.join(root, 'routes/production-cutting.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const nav = fs.readFileSync(path.join(root, 'public/acc-nav.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const idx = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

ok(fr.includes("profile === 'fabric' ? 'fabric' : 'attr'"), 'receive sets kind fabric|attr');
ok(fr.includes('resolveReceiptProfile'), 'resolveReceiptProfile present');
ok(fr.includes("raw === 'all'") || fr.includes("raw === 'tracked'"), 'parseTrackedKinds all');
ok(fr.includes("assertTrackedBatch"), 'void/update accept tracked kinds');
ok(fr.includes("IN ('fabric','attr')"), 'warehouse sync includes attr');
ok(bs.includes("NOT IN ('fabric','attr')"), 'listBatches excludes attr');
ok(cut.includes("kind: 'fabric'"), 'cutting rolls forced fabric');
ok(app.includes("kind=all"), 'UI lists kind=all');
ok(app.includes("profile:'attr'") || app.includes('profile:\'attr\'') || app.includes('profile==="attr"') || app.includes("profile==='attr'"), 'UI posts attr profile');
ok(app.includes('مواد با ویژگی'), 'UI segment copy');
ok(nav.includes('دریافت مواد'), 'nav label');
ok(swAtLeast(sw, 417), 'SW v417');
ok(idx.includes('app.js?v=417'), 'index app v417');
ok(app.includes('دریافت مواد (طاقه / ویژگی) v417'), 'help updated');

try {
  // eslint-disable-next-line no-new-func
  new Function(app);
  ok(true, 'app.js parse');
} catch (e) {
  ok(false, 'app.js parse: ' + e.message);
}

console.log('\nv417 static: ' + (fail ? '❌ ' : '✅ ') + pass + ' پاس، ' + fail + ' رد');
process.exit(fail ? 1 : 0);
