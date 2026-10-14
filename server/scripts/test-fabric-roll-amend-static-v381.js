'use strict';
/**
 * Static gates for fabric-roll amend v381 (no better-sqlite3).
 * Run: node server/scripts/test-fabric-roll-amend-static-v381.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0;
function ok(msg) { n += 1; console.log('  ✓', msg); }

const root = path.join(__dirname, '..');
const fr = fs.readFileSync(path.join(root, 'lib/inventory/fabric-rolls.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const idx = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'routes/inventory.js'), 'utf8');
const capture = fs.readFileSync(path.join(root, 'sync/capture.js'), 'utf8');

assert.ok(fr.includes('function rollUnused'));
assert.ok(fr.includes('qty_live'));
assert.ok(fr.includes('E_FABRIC_PURCHASE_AMEND'));
assert.ok(fr.includes('applyLiveRollQty(db, row)'));
assert.ok(fr.includes('syncFabricProductWarehouse'));
assert.ok(fr.includes("source_type || '') === 'purchase'"));
ok('fabric-rolls: live unused + purchase gate + sync heal');

assert.ok(routes.includes("router.patch('/fabric-rolls/:id'"));
assert.ok(routes.includes('updateFabricRoll'));
ok('PATCH route wired');

assert.ok(capture.includes("'/api/inventory/fabric-rolls', 'inventory_batches'"));
ok('sync PATH_TABLE_MAP covers fabric-rolls');

assert.ok(app.includes('function fabricRollEditModal'));
assert.ok(app.includes('finLocked'));
assert.ok(app.includes('ویرایش طاقه (R13)'));
assert.ok(app.includes('fabricRollUpdateSave((b.id), !!finLocked)'));
assert.ok(/Math\.abs\(live-meters\)/.test(app) || app.includes('Math.abs(live-meters)'));
new Function(app);
ok('app.js edit always + financial lock + Help + parse');

assert.ok(sw.includes('erp-taranom-v381'));
assert.ok(idx.includes('app.js?v=381'));
ok('SW/index v381');

console.log(`\nPASS ${n}/5 test-fabric-roll-amend-static-v381`);
