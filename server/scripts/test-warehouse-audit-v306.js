const { swAtLeast } = require('./lib/sw-at-least');
/**
 * Static regression guards for warehouse audit Wave-2 (v306).
 * Run: node server/scripts/test-warehouse-audit-v306.js
 */
'use strict';
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
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const periodic = read('lib/inventory/periodic-close.js');
const whRoutes = read('routes/warehouses.js');
const capture = read('sync/capture.js');
const consign = read('lib/consignments.js');
const cycle = read('lib/inventory/cycle-count.js');
const whDocs = read('lib/warehouse-docs.js');
const ledgers = read('lib/ledgers.js');
const appJs = read('public/app.js');
const sw = read('public/sw.js');
const indexHtml = read('public/index.html');

console.log('warehouse audit v306 Wave-2 static checks');

// Periodic reopen R13
ok(periodic.includes('prior_qty'), 'close stores prior_qty for reopen');
ok(periodic.includes('function reopenPeriodicWarehouse'), 'reopenPeriodicWarehouse exported');
ok(periodic.includes("status='reopened'"), 'reopen marks status reopened');
ok(periodic.includes('E_CLOSE_NO_PRIOR_QTY'), 'rejects reopen without prior_qty');
ok(whRoutes.includes("period-closes/:closeId/reopen"), 'reopen route mounted');
ok(capture.includes('period-close') && capture.includes('warehouse_period_closes'),
  'sync capture maps period-close to warehouse_period_closes');
ok(appJs.includes('warehousePeriodClosesModal'), 'UI lists period closes');
ok(appJs.includes('warehousePeriodReopen'), 'UI reopen action');

// OUT consign ship JE + person payable + COGS from 1114
ok(consign.includes('issue_je_id'), 'consignments store issue_je_id');
ok(consign.includes("sourceType: 'consignment_ship'"), 'OUT ship posts reclass JE');
ok(consign.includes('consignCarryAcct'), 'uses consignment carry account');
ok(consign.includes('outShipped: true'), 'OUT COGS/shortage credits 1114');
ok(consign.includes('resolvePersonPayableAccount') || consign.includes('payableAcct'),
  'purchase/shortage use person payable');
ok(consign.includes('reverseJournalEntry(db, row.issue_je_id')
  || consign.includes('reverseJournalEntry(db, fresh.issue_je_id'),
  'return/void reverses ship JE');

// Stocktaking live resnapshot
ok(cycle.includes('Re-snapshot system_qty') || cycle.includes('liveSystem'),
  'apply resnapshots system_qty from live books');
ok(cycle.includes('variantWarehouseQty') && cycle.includes('warehouseQty'),
  'resnapshot uses warehouse qty helpers');

// Serial hide + FEFO
ok(whDocs.includes('pickBatchesFefo(db, product_id, fromWh, qty)'),
  'issue path FEFO arity (db, product, warehouse, qty)');
ok(whDocs.includes('issueBatchId'), 'FEFO batch flows to ledger/move');
ok(!appJs.includes('invSerialModal()})}">➕ سریال جدید'), 'serial create button hidden');
ok(appJs.includes('بچ (Lot)'), 'batches tab retitled without serial');
ok(appJs.includes('FEFO'), 'help/UI mentions FEFO');

// Kardex sellable vs physical
ok(ledgers.includes('warehouse_running_qty'), 'kardex exposes warehouse running qty');
ok(ledgers.includes('isWarehouseOnlyRow'), 'kardex excludes warehouseOnly from sellable');
ok(ledgers.includes('closing_warehouse_qty'), 'kardex closing physical qty');

// Help + SW
ok(appJs.includes('دوره‌ها / بازگشایی'), 'help/UI period reopen');
ok(appJs.includes('warehouseOnly') || appJs.includes('موجودی امانی'), 'help wave-2 topics');
ok(swAtLeast(sw, 306), 'SW bumped to v306');
ok(indexHtml.includes('app.js?v=306'), 'index cache-bust v306');

try {
  // eslint-disable-next-line no-new-func
  new Function(appJs);
  ok(true, 'app.js parses with new Function');
} catch (e) {
  ok(false, 'app.js parse: ' + e.message);
}

for (const rel of [
  'lib/warehouse-docs.js',
  'lib/consignments.js',
  'lib/inventory/periodic-close.js',
  'lib/inventory/cycle-count.js',
  'lib/ledgers.js',
  'routes/warehouses.js',
  'sync/capture.js',
]) {
  try {
    require('child_process').execFileSync(process.execPath, ['--check', path.join(root, rel)], { stdio: 'pipe' });
    ok(true, `syntax ${rel}`);
  } catch (e) {
    ok(false, `syntax ${rel}: ${e.stderr || e.message}`);
  }
}

console.log(`\n${passed} checks passed`);
