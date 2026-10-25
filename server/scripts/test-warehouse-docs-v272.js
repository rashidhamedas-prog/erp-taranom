const { swAtLeast } = require('./lib/sw-at-least');
/**
 * Static + in-memory checks for warehouse_docs aggregation (v272).
 * Run: node server/scripts/test-warehouse-docs-v272.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed += 1;
  console.log('  ✓', msg);
}

const root = path.join(__dirname, '..');
const lib = fs.readFileSync(path.join(root, 'lib/warehouse-docs.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'routes/warehouses.js'), 'utf8');
const voidLib = fs.readFileSync(path.join(root, 'lib/void-warehouse-move.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const tables = fs.readFileSync(path.join(root, 'sync/tables.js'), 'utf8');
const capture = fs.readFileSync(path.join(root, 'sync/capture.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');

console.log('warehouse-docs v272 static checks');

ok(lib.includes('function createWarehouseDoc'), 'createWarehouseDoc exported');
ok(lib.includes('function listWarehouseDocs'), 'listWarehouseDocs');
ok(lib.includes('function getWarehouseDoc'), 'getWarehouseDoc');
ok(lib.includes('function voidWarehouseDoc'), 'voidWarehouseDoc');
ok(lib.includes('function reviseWarehouseDoc'), 'reviseWarehouseDoc = void+recreate');
ok(lib.includes('function backfillWarehouseDocs'), 'backfillWarehouseDocs');
ok(lib.includes("allocateNumber(db, 'warehouse_doc', 'WH')"), 'WH number sequence');

ok(routes.includes("/moves/docs"), 'docs routes mounted');
ok(routes.includes('listWarehouseDocs'), 'list wired');
ok(routes.includes('reviseWarehouseDoc'), 'revise wired');
ok(routes.includes('createWarehouseDoc'), 'create wired');

ok(voidLib.includes('move.doc_id'), 'line void escalates to doc');
ok(voidLib.includes('reverseStockDocument'), 'variant reverse on void');

ok(appJs.includes("api('GET','/warehouses/moves/docs')"), 'UI list uses docs API');
ok(appJs.includes('viewWarehouseDoc'), 'view modal');
ok(appJs.includes('editWarehouseDoc'), 'edit modal');
ok(appJs.includes('saveWarehouseDocRevise'), 'revise save');
ok(appJs.includes('voidWarehouseDoc'), 'void doc UI');
ok(appJs.includes('سند تجمیعی'), 'admin help updated');

ok(tables.includes("name: 'warehouse_docs'"), 'SYNCABLE_TABLES append warehouse_docs');
ok(tables.includes("['warehouse_moves', 'doc_id']"), 'FK warehouse_moves.doc_id');
ok(capture.includes("['/api/warehouses/moves/docs', 'warehouse_docs']"), 'PATH docs before moves');
ok(capture.includes("['/api/warehouses/moves/batch', 'warehouse_docs']"), 'PATH batch → warehouse_docs');

ok(swAtLeast(sw, 272), 'SW bumped to v272');

try {
  // eslint-disable-next-line no-new-func
  new Function(appJs);
  ok(true, 'app.js parses with new Function');
} catch (e) {
  ok(false, 'app.js parse: ' + e.message);
}

console.log(`\n${passed} checks passed`);
